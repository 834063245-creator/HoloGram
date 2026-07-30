// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::sync::OnceLock;

use super::{Edge, Graph};
use crate::engine::GRAMMAR_LOADER;

/// 源码文件扩展名，从 GRAMMAR_LOADER 动态派生。
/// 自动包含新安装的语法 DLL，无需修改代码。
/// 通过 OnceLock 缓存 — `supported_extensions()` 只调用一次。
fn code_extensions() -> &'static [String] {
    static EXT: OnceLock<Vec<String>> = OnceLock::new();
    EXT.get_or_init(|| GRAMMAR_LOADER.supported_extensions())
}

fn is_common_extension(s: &str) -> bool {
    code_extensions().iter().any(|ext| ext == s)
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

impl CrossFileResolver {
    /// 解析图中所有跨文件边。
    /// 返回已解析边的数量（包括孤儿边清理）。
    pub fn resolve(graph: &mut Graph) -> usize {
        // ── 索引 1：短名称 → node ID ──
        // "User" → ["app.models.User", "auth.models.User"]
        let mut name_index: HashMap<String, Vec<String>> = HashMap::new();
        // ── 索引 2：文件主干 → node ID（用于 import 解析）──
        // "a" → ["a.rs"], "models" → ["app/models.py"]
        let mut stem_index: HashMap<String, Vec<String>> = HashMap::new();

        for (id, node) in &graph.nodes {
            let short = short_name(&node.name);
            name_index.entry(short.clone()).or_default().push(id.clone());

            // File / Module 节点：也按主干索引以支持 import 边
            if node.kind == super::node::NodeKind::File
                || node.kind == super::node::NodeKind::Module
            {
                let stem = file_stem(&node.name);
                if stem != short {
                    stem_index.entry(stem).or_default().push(id.clone());
                }
            }
        }

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
        let mut diag_by_kind: HashMap<String, usize> = HashMap::new();

        for (eid, edge) in &graph.edges {
            // ponytail: 仅解析跨文件边。文件内边（Usage、Writes、
            // 同文件 Calls）的 target 是裸名而非 node ID — 它们
            // 原样有效，不能被作为孤儿边清理。
            if !edge.cross_file {
                continue;
            }
            // 尝试解析 source（如果不在图中）。
            // 使用 edge.source 本身推断 source 语言用于过滤。
            let src_lang = infer_language(&edge.source);
            let src_id = if graph.nodes.contains_key(&edge.source) {
                Some(edge.source.clone())
            } else {
                resolve_name(&edge.source, &name_index, &stem_index, graph, src_lang)
            };

            // 尝试解析 target（如果不在图中）。
            // 使用 source 的语言来优先选择同语言的 target。
            let tgt_lang = src_id.as_ref()
                .map(|id| infer_language(id))
                .flatten()
                .or(src_lang);
            let tgt_id = if graph.nodes.contains_key(&edge.target) {
                Some(edge.target.clone())
            } else {
                resolve_name(&edge.target, &name_index, &stem_index, graph, tgt_lang)
            };

            let src_ok = src_id.is_some();
            let tgt_ok = tgt_id.is_some();

            if let (Some(s), Some(t)) = (src_id, tgt_id) {
                if s != edge.source || t != edge.target {
                    // 边目标已改变 — 创建解析后的版本
                    let mut new_edge = edge.clone();
                    new_edge.id = format!("{}_resolved", edge.id);
                    new_edge.source = s;
                    new_edge.target = t;
                    new_edge.cross_file = true;
                    new_edges.push(new_edge);
                    to_remove.push(eid.clone());
                    resolved += 1;
                }
            } else {
                unresolved_count += 1;
                // ── 分类失败原因 ──
                *diag_by_kind.entry(format!("{:?}", edge.kind)).or_default() += 1;
                if !src_ok && !graph.nodes.contains_key(&edge.source) {
                    diag_source_missing += 1;
                }
                if !tgt_ok {
                    let tshort = short_name(&edge.target);
                    let has_dot = edge.target.contains('.');
                    let in_index = name_index.contains_key(&tshort);
                    let in_stem = stem_index.contains_key(&file_stem(&edge.target));
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
                        ambiguous_edges.push(eid.clone());
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
            let mut kind_counts: Vec<(String, usize)> = diag_by_kind.into_iter().collect();
            kind_counts.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
            let top_kinds: Vec<String> = kind_counts.iter().take(5)
                .map(|(k, c)| format!("{}={}", k, c))
                .collect();
            eprintln!("[cross-file diag] by kind: {}", top_kinds.join(", "));
        }

        // 移除旧的未解析边，添加已解析的边
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
            if let Some(edge) = graph.edges.get_mut(eid) {
                edge.metadata = Some(serde_json::json!({
                    "ambiguous": true,
                    "original_target": edge.target.clone(),
                }));
            }
        }

        // 清理：移除端点不存在的跨文件边。
        // 文件内边（Usage、Writes、同文件 Calls）的 target 是裸名
        // 而非 node ID — 它们原样有效。
        // 歧义边（上面标记的）保留供用户/LSP 解析。
        let orphan_edges: Vec<String> = graph
            .edges
            .iter()
            .filter(|(_, e)| {
                if !e.cross_file {
                    return false;
                }
                if graph.nodes.contains_key(&e.source) && graph.nodes.contains_key(&e.target) {
                    return false;
                }
                // 保留歧义边
                !e.metadata.as_ref()
                    .and_then(|m| m.get("ambiguous"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for eid in &orphan_edges {
            graph.remove_edge(eid);
        }

        if unresolved_count > 0 || !orphan_edges.is_empty() || !ambiguous_edges.is_empty() {
            if unresolved_count > 0 {
                tracing::warn!(
                    resolved,
                    unresolved = unresolved_count,
                    orphans = orphan_edges.len(),
                    ambiguous = ambiguous_edges.len(),
                    "cross-file resolver: {} edges unresolved, {} orphans cleaned, {} ambiguous (preserved)",
                    unresolved_count,
                    orphan_edges.len(),
                    ambiguous_edges.len()
                );
            } else {
                tracing::debug!(
                    resolved,
                    orphans = orphan_edges.len(),
                    ambiguous = ambiguous_edges.len(),
                    "cross-file resolver: {} orphans cleaned (stale edges), {} ambiguous (preserved)",
                    orphan_edges.len(),
                    ambiguous_edges.len()
                );
            }
        }

        resolved // 注意：孤儿边不计入已解析 — 它们只是过时清理
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

/// 将候选项过滤为匹配给定语言的候选项（如果已知）。
/// 返回匹配候选项的引用 Vec。
/// 如果 `lang` 为 None 或没有同语言候选项，则返回所有候选项。
fn filter_by_language<'a>(
    candidates: &'a [String],
    lang: Option<&str>,
) -> Vec<&'a String> {
    let all: Vec<&String> = candidates.iter().collect();
    let same_lang: Vec<&String> = candidates
        .iter()
        .filter(|c| lang == infer_language(c))
        .collect();
    if same_lang.is_empty() { all } else { same_lang }
}

/// 尝试将名称引用解析为实际的 node ID。
fn resolve_name(
    name: &str,
    name_index: &HashMap<String, Vec<String>>,
    stem_index: &HashMap<String, Vec<String>>,
    graph: &Graph,
    source_lang: Option<&str>,
) -> Option<String> {
    // ── 策略 1：精确匹配 ──
    if graph.nodes.contains_key(name) {
        return Some(name.to_string());
    }

    // ── 策略 2：短名称匹配 ──
    // 适用于裸 fn/class 名："fn_a" → "a.rs.fn_a"
    let short = short_name(name);
    if let Some(candidates) = name_index.get(&short) {
        let filtered = filter_by_language(candidates, source_lang);
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
            if let Some(c) = best_bare_match(&filtered, graph, source_lang) {
                return Some(c);
            }
        }
    }

    // ── 策略 3：文件主干匹配 ──
    // 适用于裸模块导入："b" → "b.rs"、"os" → "os.py"
    let stem = file_stem(name);
    if stem != short {
        if let Some(candidates) = stem_index.get(&stem) {
            let filtered = filter_by_language(candidates, source_lang);
            if filtered.len() == 1 {
                return Some(filtered[0].clone());
            }
            if let Some(c) = best_qualified_match(name, &filtered) {
                return Some(c);
            }
            // 文件主干匹配的裸名回退
            if !name.contains('.') {
                if let Some(c) = best_bare_match(&filtered, graph, source_lang) {
                    return Some(c);
                }
            }
        }
    }

    // ── 策略 4：规范化路径分隔符 ──
    // 处理 Rust 路径中的 "::" 和 import 目标中混合的 "./\"
    let normalized = name.replace("::", ".").replace(['\\', '/'], ".");
    if normalized != *name {
        let short_norm = short_name(&normalized);
        if let Some(candidates) = name_index.get(&short_norm) {
            let filtered = filter_by_language(candidates, source_lang);
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
            if graph.nodes.contains_key(&with_ext) {
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
                let filtered = filter_by_language(candidates, source_lang);
                if filtered.len() == 1 {
                    return Some(filtered[0].clone());
                }
                if let Some(c) = best_qualified_match(&stripped, &filtered) {
                    return Some(c);
                }
                if !stripped.contains('.') {
                    if let Some(c) = best_bare_match(&filtered, graph, source_lang) {
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
fn best_qualified_match(name: &str, candidates: &[&String]) -> Option<String> {
    let name_parts: Vec<&str> = name.rsplit('.').collect();
    let mut best: Option<&&String> = None;
    let mut best_score = 0usize;

    for candidate in candidates {
        let cand_parts: Vec<&str> = candidate.rsplit('.').collect();
        let match_len = name_parts.len().min(cand_parts.len());
        if match_len >= 2 && name_parts[..match_len] == cand_parts[..match_len] {
            let score = cand_parts.len(); // 完整路径越长 = 限定程度越高
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
fn best_bare_match(candidates: &[&String], graph: &Graph, source_lang: Option<&str>) -> Option<String> {
    use super::node::NodeKind;

    // 评分：lang_match * 100000 + kind_prio * 1000 + 路径深度
    // 同语言候选项始终优先于跨语言候选项。
    let scored: Vec<(&&String, usize)> = candidates
        .iter()
        .filter_map(|c| {
            let kind_prio = match graph.nodes.get(*c).map(|n| &n.kind) {
                Some(NodeKind::Function) => 0,
                Some(NodeKind::Class) => 1,
                Some(NodeKind::Symbol) => 2,
                Some(NodeKind::Variable) => 3,
                _ => 4,
            };
            let depth = c.split('.').count();
            let lang_bonus = if source_lang.is_some() && infer_language(c) == source_lang {
                100000
            } else {
                0
            };
            Some((c, lang_bonus + kind_prio * 1000 + depth))
        })
        .collect();

    if scored.is_empty() {
        return None;
    }

    let min_score = scored.iter().map(|(_, s)| *s).min().unwrap();
    let tied: Vec<String> = scored.iter()
        .filter(|(_, s)| *s == min_score)
        .map(|(c, _)| (**c).clone())
        .collect();

    if tied.len() > 1 {
        tracing::debug!(
            candidates = ?tied.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            "best_bare_match: {} candidates with same score — ambiguous, returning None",
            tied.len()
        );
        return None;
    }

    tied.first().cloned()
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
        // 孤儿边应被清理，但不计入已解析
        assert!(g.get_edge("e1").is_none(), "orphan edge should be removed");
        assert_eq!(resolved, 0, "orphan cleanup does not count as resolved");
    }

    #[test]
    fn test_resolve_no_name_match() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // 指向不匹配任何内容的名称的边
        g.add_edge_unchecked(cross_edge("e1", "a", "totally_unknown_name", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // 应作为孤儿边清理
        assert!(g.get_edge("e1").is_none());
        assert_eq!(resolved, 0, "unresolved edge → orphan, not resolved");
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
        // 边应作为孤儿边清理（无法解析标准库）
        assert!(g.get_edge("e1").is_none());
        assert!(g.get_edge("e1_resolved").is_none());
        assert_eq!(resolved, 0, "stdlib import not resolved → orphan, not counted");
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
}
