// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use super::{Edge, EdgeKind, Graph, Node, NodeKind};
use crate::engine::GRAMMAR_LOADER;

/// 源码文件扩展名，从 GRAMMAR_LOADER 动态派生。
/// 自动包含新安装的语法 DLL，无需修改代码。
/// 通过 OnceLock 缓存 — `supported_extensions()` 只调用一次。
fn code_extensions() -> &'static [String] {
    static EXT: OnceLock<Vec<String>> = OnceLock::new();
    EXT.get_or_init(|| GRAMMAR_LOADER.supported_extensions())
}

/// 扩展名查找集合，从 code_extensions() 派生。
/// O(1) 查找，替代对 Vec 的线性扫描（short_name/file_stem 每名字调用）。
fn code_extension_set() -> &'static HashSet<String> {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| code_extensions().iter().cloned().collect())
}

fn is_common_extension(s: &str) -> bool {
    code_extension_set().contains(s)
}

/// 提取文件名主干：不含扩展名的文件名。
///
/// 示例：
///   "a.rs"        → "a"
///   "app/models.py" → "models"
///   "foo.bar.baz.ts" → "baz"
///   "django.http.HttpResponse" → "HttpResponse"  （最后一段不是扩展名）
fn file_stem(name: &str) -> String {
    let parts: Vec<&str> = name.rsplit(&['/', '\\', '.']).collect();
    if parts.len() >= 2 && is_common_extension(parts[0]) {
        parts[1].rsplit(&['/', '\\']).next().unwrap_or(parts[1]).to_string()
    } else {
        parts[0].rsplit(&['/', '\\']).next().unwrap_or(parts[0]).to_string()
    }
}

/// 跨文件边解析器。
///
/// 在所有文件解析和合并完成后，通过将短名称/文件主干
/// 与完整 node ID 匹配来解析边目标。
///
/// 解析策略（按顺序尝试）：
///   1. 精确 ID 匹配（source/target 已是有效的 node 键）
///   2. 短名称匹配 — "fn_a" → "a.rs.fn_a"
///   3. 文件主干匹配 — "b"    → "b.rs"
///   4. 多候选项限定匹配（如 "models.User" 对比 N 个 "User"）
///
/// 无法解析的边将被记录日志，然后作为孤儿边移除。
pub struct CrossFileResolver;

/// resolve() 主循环期间保持不变的索引集合。
/// 在主循环前构建一次 —— 循环内只做边收集，graph.nodes 不变
///（边增删发生在循环之后），因此索引与 resolve_name 结果均可安全复用。
struct ResolverIndexes {
    /// 短名称 → node ID："User" → ["app.models.User", "auth.models.User"]
    name: HashMap<String, Vec<String>>,
    /// 文件主干 → node ID（用于 import 解析）："a" → ["a.rs"]
    stem: HashMap<String, Vec<String>>,
    /// node ID → 预计算语言。消除候选扫描中每候选一次 infer_language
    /// 的 to_lowercase 分配与字面量比较。
    lang: HashMap<String, Option<&'static str>>,
}

fn build_indexes(graph: &Graph) -> ResolverIndexes {
    let mut idx = ResolverIndexes {
        name: HashMap::new(),
        stem: HashMap::new(),
        lang: HashMap::new(),
    };
    for (id, node) in graph.nodes_iter() {
        idx.lang.insert(id.to_string(), infer_language(id));

        let short = short_name(&node.name);
        idx.name.entry(short.clone()).or_default().push(id.to_string());

        // File / Module 节点：也按主干索引以支持 import 边
        if node.kind == super::node::NodeKind::File
            || node.kind == super::node::NodeKind::Module
        {
            let stem = file_stem(&node.name);
            if stem != short {
                idx.stem.entry(stem).or_default().push(id.to_string());
            }
        }
    }
    idx
}

/// resolve_name 的记忆化包装。
/// 键必须包含语言 —— 同名不同语言的引用解析结果不同。
/// M4: resolver 结构计数 — 定位内核规模的隐性超线性用。
#[derive(Default)]
struct ResolveStats {
    /// resolve_cache 未命中次数（= 唯一 (名, 语言) 数）
    cache_misses: usize,
    /// Σ 进入语言过滤的候选列表长度（唯一名 × 候选长度乘积项）
    candidate_scans: usize,
}

/// 外层按语言分桶，使命中路径无需为查询分配 String。
fn cached_resolve_name(
    name: &str,
    lang: Option<&'static str>,
    cache: &mut HashMap<Option<&'static str>, HashMap<String, Option<String>>>,
    idx: &ResolverIndexes,
    graph: &Graph,
    stats: &mut ResolveStats,
) -> Option<String> {
    let inner = cache.entry(lang).or_default();
    if let Some(hit) = inner.get(name) {
        return hit.clone();
    }
    stats.cache_misses += 1;
    let result = resolve_name(name, &idx.name, &idx.stem, &idx.lang, graph, lang, stats);
    inner.insert(name.to_string(), result.clone());
    result
}

impl CrossFileResolver {
    /// 解析图中所有跨文件边。
    /// 返回已解析边的数量（包括孤儿边清理）。
    pub fn resolve(graph: &mut Graph) -> usize {
        // 索引（短名/主干/语言）在主循环前构建一次；
        // 循环内 graph.nodes 不变，因此 resolve_name 是纯函数，
        // 其结果可按 (名称, 语言) 记忆化 —— 同一热名被 E 条边引用
        // 时只做一次候选扫描，而非 E 次。
        let idx = build_indexes(graph);
        let mut resolve_cache: HashMap<
            Option<&'static str>,
            HashMap<String, Option<String>>,
        > = HashMap::new();
        // M4: 分段计时 + 结构计数,用于定位内核规模的隐性超线性
        let mut stats = ResolveStats::default();
        let t_loop = std::time::Instant::now();

        let mut resolved = 0usize;
        let mut unresolved_count = 0usize;
        let mut new_edges: Vec<Edge> = Vec::new();
        let mut to_remove: Vec<String> = Vec::new();
        let mut ambiguous_edges: Vec<String> = Vec::new();

        // ── 诊断：分类未解析的边 ──
        let mut diag_no_short: usize = 0;        // short_name 不在任何索引中
        let mut diag_bare_external: usize = 0;   // 裸名，完全没有候选项
        let mut diag_dotted_method: usize = 0;   // 包含点号（obj.method 风格）
        let mut diag_source_missing: usize = 0;  // source 未找到
        let mut diag_bare_multi: usize = 0;      // 裸名，候选项存在但 best_qualified_match 拒绝（match_len<2）
        let mut diag_dotted_no_suffix: usize = 0;// 点分名，短名存在但后缀不匹配
        let mut diag_by_kind: HashMap<&'static str, usize> = HashMap::new();
        // M4: infer_language 按 source 记忆化 —— 原实现对每条边
        // 做全串 to_lowercase 分配(内核 17M 边 × 100+ 字符)。
        let mut lang_memo: HashMap<&str, Option<&'static str>> = HashMap::new();

        for (eid, edge) in graph.edges_iter() {
            let is_usage = edge.kind == EdgeKind::Usage;
            // ponytail: 仅解析跨文件边。文件内边（Usage、Writes、
            // 同文件 Calls）的 target 是裸名而非 node ID — 它们
            // 原样有效，不能被作为孤儿边清理。
            // 例外：Usage 边也尝试解析 — 裸名可能引用其他文件导出的
            // 符号（如 panel-def.ts 的 `component: AgentsPanel`）。
            // 解析成功则建立真实引用（消除 find_unused 误报）；
            // 失败则保留裸名原样（局部变量等文件内引用不受影响，
            // 且不会进孤儿清理——清理只针对 cross_file=true 的边）。
            if !edge.cross_file && !is_usage {
                continue;
            }
            // 尝试解析 source（如果不在图中）。
            // 使用 edge.source 本身推断 source 语言用于过滤。
            let src_lang = *lang_memo
                .entry(edge.source.as_str())
                .or_insert_with(|| infer_language(&edge.source));
            // M4: Cow 借用 —— 仅命中图外的边才需要 owned 结果,
            // 原实现对每条边无条件 clone 两个端点 id(内核 ~34M 次)。
            let src_id: Option<Cow<'_, str>> = if graph.get_node(&edge.source).is_some() {
                Some(Cow::Borrowed(edge.source.as_str()))
            } else {
                cached_resolve_name(&edge.source, src_lang, &mut resolve_cache, &idx, graph, &mut stats)
                    .map(Cow::Owned)
            };

            // 尝试解析 target（如果不在图中）。
            // 使用 source 的语言来优先选择同语言的 target。
            // source 已在图中时 src_lang 即 infer_language(src_id)，直接复用；
            // 仅当 source 被解析到不同 ID 时才需要重新推断。
            let tgt_lang = match src_id.as_deref() {
                Some(id) if id != edge.source => infer_language(id).or(src_lang),
                _ => src_lang,
            };
            let tgt_id: Option<Cow<'_, str>> = if graph.get_node(&edge.target).is_some() {
                Some(Cow::Borrowed(edge.target.as_str()))
            } else {
                cached_resolve_name(&edge.target, tgt_lang, &mut resolve_cache, &idx, graph, &mut stats)
                    .map(Cow::Owned)
            };

            let src_ok = src_id.is_some();
            let tgt_ok = tgt_id.is_some();

            if let (Some(s), Some(t)) = (src_id.as_deref(), tgt_id.as_deref()) {
                if s != edge.source || t != edge.target {
                    // 边目标已改变 — 创建解析后的版本
                    let mut new_edge = edge.clone();
                    new_edge.id = format!("{}_resolved", edge.id).into();
                    new_edge.source = s.to_string().into();
                    new_edge.target = t.to_string().into();
                    new_edge.cross_file = true;
                    new_edges.push(new_edge);
                    to_remove.push(eid.to_string());
                    resolved += 1;
                }
            } else {
                unresolved_count += 1;
                // ── 分类失败原因 ──
                *diag_by_kind.entry(edge.kind.as_str()).or_default() += 1;
                if !src_ok && graph.get_node(&edge.source).is_none() {
                    diag_source_missing += 1;
                }
                if !tgt_ok {
                    let tshort = short_name(&edge.target);
                    let has_dot = edge.target.contains('.');
                    let in_index = idx.name.contains_key(&tshort);
                    let in_stem = idx.stem.contains_key(&file_stem(&edge.target));
                    if !in_index && !in_stem {
                        diag_no_short += 1;
                        if has_dot { diag_dotted_method += 1; }
                        if !has_dot { diag_bare_external += 1; }
                    } else if !has_dot {
                        diag_bare_multi += 1; // 短名存在，但裸名 → best_qualified_match 拒绝
                    } else {
                        diag_dotted_no_suffix += 1; // 短名存在，点分名，但后缀不匹配
                    }
                    // 候选项存在但无法唯一解析 — 标记为歧义
                    if in_index || in_stem {
                        ambiguous_edges.push(eid.to_string());
                    }
                }
                tracing::debug!(
                    edge_id = %eid,
                    source = %edge.source,
                    target = %edge.target,
                    kind = ?edge.kind,
                    "cross-file edge could not be resolved"
                );
            }
        }

        // 打印诊断摘要
        if unresolved_count > 0 {
            eprintln!(
                "[cross-file diag] unresolved={} | no_short={} (dotted={}, bare_ext={}) | bare_multi={} | dotted_no_suffix={} | src_miss={}",
                unresolved_count, diag_no_short, diag_dotted_method, diag_bare_external,
                diag_bare_multi, diag_dotted_no_suffix, diag_source_missing
            );
            // 未解析边中前 5 种 edge kind
            let mut kind_counts: Vec<(&str, usize)> = diag_by_kind.into_iter().collect();
            kind_counts.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
            let top_kinds: Vec<String> = kind_counts.iter().take(5)
                .map(|(k, c)| format!("{}={}", k, c))
                .collect();
            eprintln!("[cross-file diag] by kind: {}", top_kinds.join(", "));
        }

        // 移除旧的未解析边，添加已解析的边
        let loop_secs = t_loop.elapsed().as_secs_f64();
        let t_wb = std::time::Instant::now();
        for eid in &to_remove {
            graph.remove_edge(eid);
        }
        for edge in new_edges {
            if let Err(e) = graph.add_edge(edge) {
                tracing::debug!("resolved edge not added: {}", e);
            }
        }

        // 将歧义边标记为待用户/LSP 解析，而非删除。
        for eid in &ambiguous_edges {
            if let Some(edge) = graph.get_edge_mut(eid) {
                edge.metadata = Some(serde_json::json!({
                    "ambiguous": true,
                    "original_target": edge.target.clone(),
                }));
            }
        }
        let wb_secs = t_wb.elapsed().as_secs_f64();

        // P0-3：不再静默丢弃未解析的跨文件边。
        // 端点缺失的边改写为 `unresolved:<裸名>` 占位节点并保留，
        // 查询层诚实呈现；解析率由 graph_summary 报告。
        // 文件内边（Usage、Writes、同文件 Calls）的 target 本就是裸名，原样有效。
        let t_orphan = std::time::Instant::now();
        let unresolved_list: Vec<(String, String)> = graph
            .edges_iter()
            .filter(|(_, e)| {
                e.cross_file
                    && !(graph.get_node(&e.source).is_some() && graph.get_node(&e.target).is_some())
            })
            .map(|(id, e)| (id.to_string(), e.target.as_str().to_string()))
            .collect();
        let mut kept_unresolved = 0usize;
        for (eid, bare_target) in unresolved_list {
            let uid = format!("unresolved:{}", bare_target);
            if graph.get_node(&uid).is_none() {
                let mut n = Node::new(&uid, &bare_target, NodeKind::Symbol);
                n.properties = serde_json::json!({ "unresolved": true });
                graph.add_node(n);
            }
            if let Some(e) = graph.get_edge_mut(&eid) {
                e.target = uid.into();
            }
            kept_unresolved += 1;
        }
        let orphan_secs = t_orphan.elapsed().as_secs_f64();
        eprintln!(
            "[cross-file] loop {:.1}s (misses={}, cand_scans={}) | writeback {:.1}s (+{} -{} edges) | keep-unresolved {:.1}s ({} edges kept)",
            loop_secs, stats.cache_misses, stats.candidate_scans,
            wb_secs, resolved, to_remove.len(),
            orphan_secs, kept_unresolved
        );

        if unresolved_count > 0 || kept_unresolved > 0 || !ambiguous_edges.is_empty() {
            if unresolved_count > 0 {
                tracing::warn!(
                    resolved,
                    unresolved = unresolved_count,
                    kept_unresolved,
                    ambiguous = ambiguous_edges.len(),
                    "cross-file resolver: {} edges unresolved (kept), {} unresolved cross-file (kept), {} ambiguous (preserved)",
                    unresolved_count,
                    kept_unresolved,
                    ambiguous_edges.len()
                );
            } else {
                tracing::debug!(
                    resolved,
                    kept_unresolved,
                    ambiguous = ambiguous_edges.len(),
                    "cross-file resolver: {} unresolved cross-file kept, {} ambiguous (preserved)",
                    kept_unresolved,
                    ambiguous_edges.len()
                );
            }
        }

        resolved // 未解析边不计入 resolved — 它们被保留而非清理
    }
}

/// 从完整限定名中获取短名称。
///
/// 先剥离已知的文件扩展名，使文件节点可以
/// 按逻辑模块名索引（而非按扩展名）。
///
/// "django.http.response.HttpResponse" → "HttpResponse"
/// "a.rs"                               → "a"
/// "app/models.py"                      → "models"
/// "app.views.index"                    → "index"
fn short_name(full: &str) -> String {
    // 如果最后一段点分路径看起来像文件扩展名，先剥离它
    let last = full.rsplit('.').next().unwrap_or(full);
    if is_common_extension(last) {
        // 剥离 ".ext" 并重新计算 — 同时按路径分隔符分割
        if let Some(stripped) = full.strip_suffix(&format!(".{}", last)) {
            return stripped
                .rsplit(&['.', '/', '\\'])
                .next()
                .unwrap_or(stripped)
                .to_string();
        }
    }
    full.rsplit('.').next().unwrap_or(full).to_string()
}

/// 从 node ID 或文件路径推断语言族。
///
/// 扫描点分隔的段落以查找已知文件扩展名，返回
/// 语言族静态字符串。用于过滤跨文件解析候选项，
/// 使得例如 TypeScript 函数对 `clear` 的调用
/// 解析到另一个 TS 的 `clear`，而非 Rust 的 `clear`。
///
/// Node ID 将文件扩展名编码为一段：
///   "D:...events.ts.EventBus.clear" → Some("typescript")
///   "D:...graph.rs.Graph.clear"     → Some("rust")
///
/// 路径同理：
///   "src-ui/src/ui/events.ts"       → Some("typescript")
///   "engine/src/graph/graph.rs"     → Some("rust")
pub fn infer_language(id_or_path: &str) -> Option<&'static str> {
    let lower = id_or_path.to_lowercase();
    for segment in lower.split('.') {
        match segment {
            "rs" => return Some("rust"),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "mts" | "cts" => return Some("typescript"),
            "py" | "pyi" => return Some("python"),
            "go" => return Some("go"),
            "java" => return Some("java"),
            "cs" => return Some("csharp"),
            "rb" => return Some("ruby"),
            "kt" | "kts" => return Some("kotlin"),
            "php" => return Some("php"),
            "swift" => return Some("swift"),
            "dart" => return Some("dart"),
            "lua" => return Some("lua"),
            "zig" => return Some("zig"),
            "r" => return Some("r"),
            "scala" => return Some("scala"),
            "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" | "c" | "h" => return Some("c_cpp"),
            "ex" | "exs" | "erl" | "hrl" => return Some("elixir_erlang"),
            "hs" => return Some("haskell"),
            "ml" | "mli" => return Some("ocaml"),
            "svelte" => return Some("svelte"),
            "vue" => return Some("vue"),
            _ => continue,
        }
    }
    None
}

/// 查询候选节点的预计算语言。候选项均来自索引（即 graph.nodes 的键），
/// 必命中预算表；防御性回退到即时推断以保持独立调用时的语义。
fn candidate_lang(
    id: &str,
    lang_map: &HashMap<String, Option<&'static str>>,
) -> Option<&'static str> {
    lang_map
        .get(id)
        .copied()
        .flatten()
        .or_else(|| infer_language(id))
}

/// 将候选项过滤为匹配给定语言的候选项（如果已知）。
/// 返回匹配候选项的引用 Vec。
/// 如果 `lang` 为 None 或没有同语言候选项，则返回所有候选项。
/// M4: `all` Vec 改为惰性回退 —— 命中同语言时不再做无谓的全量收集。
fn filter_by_language<'a>(
    candidates: &'a [String],
    lang: Option<&str>,
    lang_map: &HashMap<String, Option<&'static str>>,
) -> Vec<&'a String> {
    let same_lang: Vec<&String> = candidates
        .iter()
        .filter(|c| lang == candidate_lang(c, lang_map))
        .collect();
    if same_lang.is_empty() { candidates.iter().collect() } else { same_lang }
}

/// 尝试将名称引用解析为实际的 node ID。
fn resolve_name(
    name: &str,
    name_index: &HashMap<String, Vec<String>>,
    stem_index: &HashMap<String, Vec<String>>,
    lang_map: &HashMap<String, Option<&'static str>>,
    graph: &Graph,
    source_lang: Option<&str>,
    stats: &mut ResolveStats,
) -> Option<String> {
    // ── 策略 1：精确匹配 ──
    if graph.get_node(name).is_some() {
        return Some(name.to_string());
    }

    // ── 策略 2：短名称匹配 ──
    // 适用于裸 fn/class 名："fn_a" → "a.rs.fn_a"
    let short = short_name(name);
    if let Some(candidates) = name_index.get(&short) {
        stats.candidate_scans += candidates.len();
        let filtered = filter_by_language(candidates, source_lang, lang_map);
        if filtered.len() == 1 && !name.contains('.') {
            return Some(filtered[0].clone());
        }
        // 多候选项 — 选择限定程度最高（最长）的匹配
        if let Some(c) = best_qualified_match(name, &filtered) {
            return Some(c);
        }
        // ponytail: 裸名无法后缀匹配（match_len < 2）。
        // 回退到启发式：优先 Function/Class，然后最短路径。
        if !name.contains('.') {
            if let Some(c) = best_bare_match(&filtered, graph, source_lang, lang_map) {
                return Some(c);
            }
        }
    }

    // ── 策略 3：文件主干匹配 ──
    // 适用于裸模块导入："b" → "b.rs"、"os" → "os.py"
    let stem = file_stem(name);
    if stem != short {
        if let Some(candidates) = stem_index.get(&stem) {
            stats.candidate_scans += candidates.len();
            let filtered = filter_by_language(candidates, source_lang, lang_map);
            if filtered.len() == 1 {
                return Some(filtered[0].clone());
            }
            if let Some(c) = best_qualified_match(name, &filtered) {
                return Some(c);
            }
            // 文件主干匹配的裸名回退
            if !name.contains('.') {
                if let Some(c) = best_bare_match(&filtered, graph, source_lang, lang_map) {
                    return Some(c);
                }
            }
        }
    }

    // ── 策略 4：规范化路径分隔符 ──
    // 处理 Rust 路径中的 "::" 和 import 目标中混合的 "./\"
    // contains 守卫：无分隔符时不产生 String 分配（热路径）。
    let normalized: Cow<'_, str> =
        if name.contains("::") || name.contains(['\\', '/']) {
            Cow::Owned(name.replace("::", ".").replace(['\\', '/'], "."))
        } else {
            Cow::Borrowed(name)
        };
    if normalized.as_ref() != name {
        let short_norm = short_name(&normalized);
        if let Some(candidates) = name_index.get(&short_norm) {
            stats.candidate_scans += candidates.len();
            let filtered = filter_by_language(candidates, source_lang, lang_map);
            if filtered.len() == 1 {
                return Some(filtered[0].clone());
            }
            if let Some(c) = best_qualified_match(&normalized, &filtered) {
                return Some(c);
            }
        }
    }

    // ── 策略 5：点分 import → 尝试追加文件扩展名 ──
    // "app.models" → 检查 "app.models.py"、"utils.helpers" → "utils.helpers.py"
    if name.contains('.') {
        for ext in code_extensions() {
            let with_ext = format!("{}.{}", name, ext);
            if graph.get_node(&with_ext).is_some() {
                return Some(with_ext);
            }
        }
    }

    // ── 策略 6：对 obj.method() 风格调用的渐进剥离 ──
    // "self.client.get" → 尝试 "client.get" → 尝试裸名 "get"
    // ponytail: 剥离常见的接收者前缀（self、this、cls）；
    // 剩余裸名回退到 best_bare_match。
    if name.contains('.') {
        let mut stripped = name.to_string();
        while let Some(dot_pos) = stripped.find('.') {
            stripped = stripped[dot_pos + 1..].to_string();
            let short = short_name(&stripped);
            if let Some(candidates) = name_index.get(&short) {
                stats.candidate_scans += candidates.len();
                let filtered = filter_by_language(candidates, source_lang, lang_map);
                if filtered.len() == 1 {
                    return Some(filtered[0].clone());
                }
                if let Some(c) = best_qualified_match(&stripped, &filtered) {
                    return Some(c);
                }
                if !stripped.contains('.') {
                    if let Some(c) = best_bare_match(&filtered, graph, source_lang, lang_map) {
                        return Some(c);
                    }
                }
            }
        }
    }

    None
}

/// 当多个节点共享同一短名称时选择最佳候选项。
/// "models.User" 对比候选项 ["auth.models.User", "shop.models.User"]
/// → 按后缀匹配 "auth.models.User"（两者都以 "models.User" 结尾）。
/// M4: 迭代器后缀比较,替代逐候选 rsplit().collect::<Vec>() 分配风暴。
fn best_qualified_match(name: &str, candidates: &[&String]) -> Option<String> {
    let name_len = name.split('.').count();
    let mut best: Option<&&String> = None;
    let mut best_score = 0usize;

    for candidate in candidates {
        let cand_len = candidate.split('.').count();
        let match_len = name_len.min(cand_len);
        // 语义等价原实现:rsplit 后前 match_len 段(自尾端)全部相等
        if match_len >= 2
            && name.rsplit('.')
                .zip(candidate.rsplit('.'))
                .take(match_len)
                .all(|(a, b)| a == b)
        {
            let score = cand_len; // 完整路径越长 = 限定程度越高
            if score > best_score {
                best_score = score;
                best = Some(candidate);
            }
        }
    }

    best.map(|c| (*c).clone())
}

/// 裸名多候选项的回退策略。
///
/// 当查询是单个裸名（如 "render"）且多个节点
/// 共享该短名称时，后缀匹配不可行。此启发式
/// 按以下规则选择最佳候选项：
///   1. 优先同语言候选项（+10000 加分）
///   2. 优先 Function，然后 Class，再其他 NodeKind
///   3. 优先较短路径（嵌套越少 = 越可能是目标）
///
/// ponytail: 这是启发式而非保证。精确的 call 解析
/// 请对单条边使用 hologram_resolve_call（基于 LSP）。
fn best_bare_match(
    candidates: &[&String],
    graph: &Graph,
    source_lang: Option<&str>,
    lang_map: &HashMap<String, Option<&'static str>>,
) -> Option<String> {
    use super::node::NodeKind;

    // 评分：lang_match * 100000 + kind_prio * 1000 + 路径深度
    // 同语言候选项始终优先于跨语言候选项。
    // M4: 单遍扫描,不分配 scored/tied Vec —— 语义等价:
    // 取最小分候选(并列保持首个),最小分有并列 → None(歧义)。
    let mut best: Option<&&String> = None;
    let mut best_score = usize::MAX;
    let mut tied = false;

    for c in candidates {
        let kind_prio = match graph.get_node(*c).map(|n| &n.kind) {
            Some(NodeKind::Function) => 0,
            Some(NodeKind::Class) => 1,
            Some(NodeKind::Symbol) => 2,
            Some(NodeKind::Variable) => 3,
            _ => 4,
        };
        let depth = c.split('.').count();
        let lang_bonus = if source_lang.is_some() && candidate_lang(c, lang_map) == source_lang {
            100000
        } else {
            0
        };
        let score = lang_bonus + kind_prio * 1000 + depth;
        if score < best_score {
            best_score = score;
            best = Some(c);
            tied = false;
        } else if score == best_score {
            tied = true;
        }
    }

    if tied {
        tracing::debug!("best_bare_match: candidates with same score — ambiguous, returning None");
        return None;
    }

    best.map(|c| (*c).clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{EdgeKind, Node, NodeKind};

    // ── short_name / file_stem 单元测试 ──

    #[test]
    fn test_short_name() {
        assert_eq!(short_name("django.http.HttpResponse"), "HttpResponse");
        assert_eq!(short_name("simple"), "simple");
        assert_eq!(short_name("a.b.c.d"), "d");
    }

    #[test]
    fn test_short_name_strips_file_extensions() {
        // File 节点应按模块名索引，而非扩展名
        assert_eq!(short_name("a.rs"), "a");
        assert_eq!(short_name("app.models.py"), "models");
        assert_eq!(short_name("src/lib.go"), "lib");
        assert_eq!(short_name("components/Button.tsx"), "Button");
    }

    #[test]
    fn test_short_name_non_extension_unchanged() {
        // 非扩展名的最后一段应仍然有效
        assert_eq!(short_name("fn_a"), "fn_a");
        assert_eq!(short_name("User"), "User");
        assert_eq!(short_name("index"), "index");
    }

    #[test]
    fn test_file_stem() {
        assert_eq!(file_stem("a.rs"), "a");
        assert_eq!(file_stem("app/models.py"), "models");
        assert_eq!(file_stem("foo.bar.baz.ts"), "baz");
        assert_eq!(file_stem("django.http.HttpResponse"), "HttpResponse");
        assert_eq!(file_stem("src/components/Button.tsx"), "Button");
        assert_eq!(file_stem("simple"), "simple");
    }

    // ── 解析器测试 ──

    // ponytail: 用于创建跨文件边的测试辅助函数。
    // CrossFileResolver 仅处理 cross_file=true 的边。
    fn cross_edge(id: &str, src: &str, tgt: &str, kind: EdgeKind) -> Edge {
        let mut e = Edge::new(id, src, tgt, kind);
        e.cross_file = true;
        e
    }

    #[test]
    fn test_resolve_cross_file_calls() {
        let mut g = Graph::new();

        // 文件 A：定义 User
        let mut user = Node::new("models.User", "User", NodeKind::Symbol);
        user.location = Some("app/models.py".into());
        g.add_node(user);

        // 文件 B：import User，定义 index
        let mut index = Node::new("views.index", "index", NodeKind::Symbol);
        index.location = Some("app/views.py".into());
        g.add_node(index);

        // 边：index → "User"（短名称，需要解析）
        let mut e = Edge::new("e1", "views.index", "User", EdgeKind::Calls);
        e.cross_file = true;
        g.add_edge_unchecked(e);

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1, "should resolve 1 edge");
        let e = g.get_edge("e1_resolved").unwrap();
        assert_eq!(e.target, "models.User");
    }

    #[test]
    fn test_resolve_source_and_target() {
        let mut g = Graph::new();
        g.add_node(Node::new("lib.fn_a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("lib.fn_b", "fn_b", NodeKind::Symbol));
        // source 和 target 都需要解析
        g.add_edge_unchecked(cross_edge("e1", "fn_a", "fn_b", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        let e = g.get_edge("e1_resolved").unwrap();
        assert_eq!(e.source, "lib.fn_a");
        assert_eq!(e.target, "lib.fn_b");
    }

    #[test]
    fn test_resolve_usage_bare_name_cross_file() {
        // ponytail: React 组件通过裸名引用（panel-def.ts 的
        // `component: AgentsPanel`）→ Usage 边 target 是裸名。
        // 以前 Usage 边不参与解析（!cross_file 直接跳过），
        // 导致跨文件裸名引用永远连不到函数节点、find_unused 误报。
        // 现在 Usage 边也尝试解析 target，命中唯一同语言候选。
        let mut g = Graph::new();
        let mut comp = Node::new(
            "D:.HoloGramHG.src-ui.src.ui.react.AgentsPanel.tsx.AgentsPanel",
            "AgentsPanel",
            NodeKind::Function,
        );
        comp.location = Some("D:/HoloGramHG/src-ui/src/ui/react/AgentsPanel.tsx:153".into());
        g.add_node(comp);
        let mut def = Node::new(
            "D:.HoloGramHG.src-ui.src.app.panels.panel-def.ts",
            "D:/HoloGramHG/src-ui/src/app/panels/panel-def.ts",
            NodeKind::File,
        );
        def.location = Some("D:/HoloGramHG/src-ui/src/app/panels/panel-def.ts".into());
        g.add_node(def);

        // 文件内 Usage 边：panel-def.ts → 裸名 "AgentsPanel"（cross_file=false）
        let mut e = Edge::new(
            "use_1_1",
            "D:.HoloGramHG.src-ui.src.app.panels.panel-def.ts",
            "AgentsPanel",
            EdgeKind::Usage,
        );
        e.cross_file = false;
        g.add_edge_unchecked(e);

        let _resolved = CrossFileResolver::resolve(&mut g);
        // 裸名应被解析到完整节点 ID
        let e = g.get_edge("use_1_1_resolved");
        assert!(
            e.is_some(),
            "usage edge with bare target should be resolved to full node ID"
        );
        if let Some(e) = e {
            assert_eq!(e.target, "D:.HoloGramHG.src-ui.src.ui.react.AgentsPanel.tsx.AgentsPanel");
        }
    }

    #[test]
    fn test_resolve_usage_bare_name_local_var_kept() {
        // ponytail: 解析失败的 Usage 边（局部变量、无匹配节点）
        // 必须原样保留，不能被孤儿清理删掉。
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        let mut e = Edge::new("use_1_1", "a", "someLocalVar", EdgeKind::Usage);
        e.cross_file = false;
        g.add_edge_unchecked(e);

        let _resolved = CrossFileResolver::resolve(&mut g);
        assert!(
            g.get_edge("use_1_1").is_some(),
            "unresolved usage edge must be kept as-is"
        );
    }

    #[test]
    fn test_resolve_multiple_candidates_best_match() {
        let mut g = Graph::new();
        // 两个模块都定义了 "User" 类
        g.add_node(Node::new("auth.models.User", "User", NodeKind::Symbol));
        g.add_node(Node::new("shop.models.User", "User", NodeKind::Symbol));
        // 引用使用限定名 "models.User"
        g.add_node(Node::new("views.index", "index", NodeKind::Symbol));
        g.add_edge_unchecked(cross_edge("e1", "views.index", "models.User", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        // 应解析为 auth.models.User（先注册的，或最佳匹配）
        let e = g.get_edge("e1_resolved");
        assert!(e.is_some(), "should resolve even with ambiguity");
    }

    #[test]
    fn test_resolve_already_resolved_edge_unchanged() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        // 边已有正确的 ID
        g.add_edge_unchecked(cross_edge("e1", "a", "b", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 0, "already-resolved edge should not count");
        assert!(g.get_edge("e1").is_some());
    }

    #[test]
    fn test_orphan_edge_cleanup() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // 指向不存在节点的边
        g.add_edge_unchecked(cross_edge("e1", "a", "nonexistent", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // P0-3：孤儿边不再删除——改写为 unresolved:<裸名> 占位节点保留
        let e = g.get_edge("e1").expect("P0-3: unresolved edge must be kept");
        assert_eq!(e.target.as_str(), "unresolved:nonexistent");
        assert!(g.get_node("unresolved:nonexistent").is_some());
        assert_eq!(resolved, 0, "unresolved edges do not count as resolved");
    }

    #[test]
    fn test_resolve_no_name_match() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // 指向不匹配任何内容的名称的边
        g.add_edge_unchecked(cross_edge("e1", "a", "totally_unknown_name", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // P0-3：保留为 unresolved 占位节点
        let e = g.get_edge("e1").expect("P0-3: unresolved edge must be kept");
        assert_eq!(e.target.as_str(), "unresolved:totally_unknown_name");
        assert_eq!(resolved, 0, "unresolved edge → kept, not resolved");
    }

    // ── 新增：import 边的文件主干解析 ──

    #[test]
    fn test_resolve_import_edge_by_file_stem() {
        let mut g = Graph::new();

        // tree_sitter generic_walk 创建的 File 节点
        let mut file_a = Node::new("a.rs", "a.rs", NodeKind::File);
        file_a.location = Some("a.rs".into());
        g.add_node(file_a);

        let mut file_b = Node::new("b.rs", "b.rs", NodeKind::File);
        file_b.location = Some("b.rs".into());
        g.add_node(file_b);

        // import 边：a.rs → "b"（来自 tree_sitter 的裸模块名）
        g.add_edge_unchecked(cross_edge("imp_1", "a.rs", "b", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1, "import edge should be resolved");
        let e = g.get_edge("imp_1_resolved").unwrap();
        assert_eq!(e.source, "a.rs");
        assert_eq!(e.target, "b.rs");
        assert!(e.cross_file);
    }

    #[test]
    fn test_resolve_three_file_import_cycle() {
        let mut g = Graph::new();

        g.add_node(Node::new("a.rs", "a.rs", NodeKind::File));
        g.add_node(Node::new("b.rs", "b.rs", NodeKind::File));
        g.add_node(Node::new("c.rs", "c.rs", NodeKind::File));

        // 循环 import：a → b → c → a
        g.add_edge_unchecked(cross_edge("e1", "a.rs", "b", EdgeKind::Imports));
        g.add_edge_unchecked(cross_edge("e2", "b.rs", "c", EdgeKind::Imports));
        g.add_edge_unchecked(cross_edge("e3", "c.rs", "a", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 3, "all 3 import edges should resolve");

        // 验证所有边现在都指向真实节点
        let e1 = g.get_edge("e1_resolved").unwrap();
        assert_eq!(e1.target, "b.rs");
        let e2 = g.get_edge("e2_resolved").unwrap();
        assert_eq!(e2.target, "c.rs");
        let e3 = g.get_edge("e3_resolved").unwrap();
        assert_eq!(e3.target, "a.rs");

        // 验证在解析后的 Graph 上循环检测正常工作
        let cycles = crate::analysis::cycles::detect_cycles(&g);
        assert_eq!(cycles.len(), 1, "should detect the import cycle");
        assert_eq!(cycles[0]["size"], 3);
    }

    #[test]
    fn test_resolve_three_file_call_cycle() {
        let mut g = Graph::new();

        // 文件级节点
        g.add_node(Node::new("a.rs", "a.rs", NodeKind::File));
        g.add_node(Node::new("b.rs", "b.rs", NodeKind::File));
        g.add_node(Node::new("c.rs", "c.rs", NodeKind::File));

        // 文件内的 Function 节点
        g.add_node(Node::new("a.rs.fn_a", "fn_a", NodeKind::Function));
        g.add_node(Node::new("b.rs.fn_b", "fn_b", NodeKind::Function));
        g.add_node(Node::new("c.rs.fn_c", "fn_c", NodeKind::Function));

        // 跨文件调用：fn_a → fn_b → fn_c → fn_a（裸名）
        g.add_edge_unchecked(cross_edge("e1", "a.rs.fn_a", "fn_b", EdgeKind::Calls));
        g.add_edge_unchecked(cross_edge("e2", "b.rs.fn_b", "fn_c", EdgeKind::Calls));
        g.add_edge_unchecked(cross_edge("e3", "c.rs.fn_c", "fn_a", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 3);

        // 验证解析结果
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "b.rs.fn_b");
        assert_eq!(g.get_edge("e2_resolved").unwrap().target, "c.rs.fn_c");
        assert_eq!(g.get_edge("e3_resolved").unwrap().target, "a.rs.fn_a");

        // 验证循环检测
        let cycles = crate::analysis::cycles::detect_cycles(&g);
        assert_eq!(cycles.len(), 1, "should detect cross-file call cycle");
        assert_eq!(cycles[0]["size"], 3);
    }

    #[test]
    fn test_resolve_rust_import_with_colons() {
        let mut g = Graph::new();

        g.add_node(Node::new("a.rs", "a.rs", NodeKind::File));
        g.add_node(Node::new("b.rs", "b.rs", NodeKind::File));

        // Rust 风格 import："crate::b"（带 :: 分隔符）
        g.add_edge_unchecked(cross_edge("e1", "a.rs", "crate::b", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "b.rs");
    }

    #[test]
    fn test_resolve_python_dotted_import() {
        let mut g = Graph::new();

        g.add_node(Node::new("app.models.py", "app/models.py", NodeKind::File));
        g.add_node(Node::new("app.views.py", "app/views.py", NodeKind::File));

        // Python："from app.models import User" → 边目标 "app.models"
        g.add_edge_unchecked(cross_edge("e1", "app.views.py", "app.models", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "app.models.py");
    }

    #[test]
    fn test_resolve_python_subpackage_import() {
        let mut g = Graph::new();

        g.add_node(Node::new("utils.helpers.py", "utils/helpers.py", NodeKind::File));
        g.add_node(Node::new("main.py", "main.py", NodeKind::File));

        // "from utils.helpers import foo" → 目标 "utils.helpers"
        g.add_edge_unchecked(cross_edge("e1", "main.py", "utils.helpers", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "utils.helpers.py");
    }

    #[test]
    fn test_external_import_not_resolved() {
        let mut g = Graph::new();
        g.add_node(Node::new("main.py", "main.py", NodeKind::File));

        // "import os" — os.py 不在项目 Graph 中
        g.add_edge_unchecked(cross_edge("e1", "main.py", "os", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        // P0-3：无法解析的标准库 import 保留为 unresolved 占位节点（不再静默丢弃）
        let e = g.get_edge("e1").expect("P0-3: unresolved import must be kept");
        assert_eq!(e.target.as_str(), "unresolved:os");
        assert!(g.get_node("unresolved:os").is_some());
        assert!(g.get_edge("e1_resolved").is_none());
        assert_eq!(resolved, 0, "stdlib import not resolved → kept unresolved, not counted");
    }

    #[test]
    fn test_bare_multi_fallback_prefers_function() {
        let mut g = Graph::new();
        // 两个节点共享短名 "render"：
        // 一个是 Function，一个是 Variable — Function 应胜出。
        g.add_node(Node::new("django.shortcuts.render", "render", NodeKind::Function));
        g.add_node(Node::new("django.views.View.render", "render", NodeKind::Function));
        g.add_node(Node::new("some.module.render_var", "render", NodeKind::Variable));
        g.add_node(Node::new("views.index", "index", NodeKind::Function));

        g.add_edge_unchecked(cross_edge("e1", "views.index", "render", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1, "bare name with multiple candidates should resolve");
        let e = g.get_edge("e1_resolved").unwrap();
        // 应选择 Function 节点（kind 优先级 0）且路径最短
        // 两个 Function 节点深度均为 3，因此 HashMap 顺序中第一个胜出
        let target_kind = g.nodes.get(&e.target).map(|n| &n.kind);
        assert_eq!(target_kind, Some(&NodeKind::Function), "should prefer Function over Variable");
    }

    #[test]
    fn test_cross_language_isolation_ts_caller_to_rs_target_blocked() {
        let mut g = Graph::new();
        // 两个 "clear" 函数：一个 Rust，一个 TypeScript
        g.add_node(Node::new(
            "D:.HoloGramHG.engine.src.graph.graph.rs.Graph.clear",
            "clear", NodeKind::Function));
        g.add_node(Node::new(
            "D:.HoloGramHG.src-ui.src.ui.events.ts.EventBus.clear",
            "clear", NodeKind::Function));
        // 一个 TS 文件调用 clear()
        g.add_node(Node::new(
            "D:.HoloGramHG.src-ui.src.ui.chat-store.ts.ChatStore.save",
            "save", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "D:.HoloGramHG.src-ui.src.ui.chat-store.ts.ChatStore.save",
            "clear", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        let edge = g.get_edge("e1_resolved").expect("edge should be resolved");
        assert!(
            edge.target.contains(".ts."),
            "TS caller must resolve to same-language target, got {}",
            edge.target
        );
    }

    #[test]
    fn test_cross_language_isolation_rust_caller_to_rust_target() {
        let mut g = Graph::new();
        g.add_node(Node::new(
            "D:.HoloGramHG.engine.src.engine.pipeline.rs.Pipeline.start",
            "start", NodeKind::Function));
        g.add_node(Node::new(
            "D:.HoloGramHG.src-ui.src.agent.execution-state.ts.createExecState.start",
            "start", NodeKind::Function));
        g.add_node(Node::new(
            "D:.HoloGramHG.engine.src.main.rs.main",
            "main", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "D:.HoloGramHG.engine.src.main.rs.main",
            "start", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        let edge = g.get_edge("e1_resolved").expect("edge should be resolved");
        assert!(
            edge.target.contains(".rs."),
            "Rust caller must resolve to same-language target, got {}",
            edge.target
        );
    }

    #[test]
    fn test_cross_language_filter_does_not_break_same_language() {
        let mut g = Graph::new();
        // 两个 Python "render" 候选项，路径深度不同 — 无平局。
        // 一个 TS "render" 候选项应被语言过滤排除。
        g.add_node(Node::new(
            "django.shortcuts.py.render",
            "render", NodeKind::Function));  // 深度 4
        g.add_node(Node::new(
            "flask.render",                    // 深度 2 — 路径更短者胜出
            "render", NodeKind::Function));
        // 应被语言过滤排除的跨语言候选项
        g.add_node(Node::new(
            "app.tsx.render",
            "render", NodeKind::Function));
        g.add_node(Node::new(
            "app.views.py.index",
            "index", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "app.views.py.index",
            "render", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        assert!(g.get_edge("e1_resolved").is_some(),
            "same-language resolution must still work");
    }

    #[test]
    fn test_best_bare_match_returns_none_on_tie() {
        // 两个深度相同的候选项 → 平局 → 歧义（保留，不解析）
        let mut g = Graph::new();
        // 两个 "render" 函数深度相同 — 无优劣之分
        g.add_node(Node::new("mod_a.render", "render", NodeKind::Function));
        g.add_node(Node::new("mod_b.render", "render", NodeKind::Function));
        g.add_node(Node::new("caller.py.index", "index", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "caller.py.index",
            "render", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // 不应解析（平局）— 边应作为歧义保留
        assert_eq!(resolved, 0, "tie should not produce a resolved edge");
        let edge = g.get_edge("e1").expect("ambiguous edge should be preserved");
        let meta = edge.metadata.as_ref().expect("ambiguous edge must have metadata");
        assert_eq!(meta["ambiguous"], true, "ambiguous flag must be set");
    }

    /// 性能回归：resolve_name 记忆化。
    ///
    /// 合成 ~2000 节点 / ~20000 边的图：热名 "read" 在 41 个文件中
    /// 各有一个定义（多候选，触发 filter_by_language + best_bare_match
    /// 的 O(K) 扫描）。修复前每条边重复全部候选扫描（O(E×K)，秒级）；
    /// 修复后每个 (名称, 语言) 只扫描一次，其余命中缓存。
    #[test]
    fn test_resolve_memoized_hot_name_performance() {
        use std::time::Instant;

        let mut g = Graph::new();
        // 热名 "read" 的多候选定义：唯一深度最浅者（w.rs.read，深度 3）
        // 在 best_bare_match 中胜出；其余 40 个候选深度 4，均为 Rust Function。
        g.add_node(Node::new("w.rs.read", "read", NodeKind::Function));
        for i in 0..40 {
            g.add_node(Node::new(
                format!("pkg{i}.deep.rs.read"),
                "read",
                NodeKind::Function,
            ));
        }
        // 500 个调用方节点
        for i in 0..500 {
            g.add_node(Node::new(
                format!("caller{i}.rs.handler"),
                "handler",
                NodeKind::Function,
            ));
        }
        // 填充到 ~2000 节点
        for i in 0..(2000 - 41 - 500) {
            g.add_node(Node::new(
                format!("filler{i}.rs.f{i}"),
                format!("f{i}"),
                NodeKind::Function,
            ));
        }
        // 20000 条跨文件边引用同一热名
        for i in 0..20000 {
            g.add_edge_unchecked(cross_edge(
                &format!("hot_e{i}"),
                &format!("caller{}.rs.handler", i % 500),
                "read",
                EdgeKind::Calls,
            ));
        }

        // 一致性基准：绕过缓存，用同一索引直接调 resolve_name
        let idx = build_indexes(&g);
        let expected = resolve_name("read", &idx.name, &idx.stem, &idx.lang, &g, Some("rust"), &mut ResolveStats::default());
        assert_eq!(expected.as_deref(), Some("w.rs.read"));

        let start = Instant::now();
        let resolved = CrossFileResolver::resolve(&mut g);
        let elapsed = start.elapsed();

        assert_eq!(resolved, 20000, "all hot-name edges should resolve");
        assert!(
            elapsed.as_secs() < 2,
            "resolve() took {:?} — memoization regressed?",
            elapsed
        );
        // 带缓存的解析结果必须与直接调 resolve_name 一致
        let first = g.get_edge("hot_e0_resolved").expect("first edge resolved");
        assert_eq!(first.target, expected.unwrap());
        let last = g.get_edge("hot_e19999_resolved").expect("last edge resolved");
        assert_eq!(last.target, "w.rs.read");
    }
}
