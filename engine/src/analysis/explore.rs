// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Explore — 统一查询聚合器。
//!
//! 输入：自然语言查询或预解析的符号名称。
//! 输出：Flow + Blast Radius + Relationships + Source Code + Architecture Alerts。
//! 消除 "search → neighbors → path → Read" 链。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::OnceLock;

use serde_json::json;

use crate::analysis::{coupling_report, detect_cycles, fragile_nodes};
use crate::graph::{EdgeKind, Graph, Node, NodeKind};
use crate::graph::query;

// ═══════════════════════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════════════════════

/// 执行 explore 查询。返回可直接用于 MCP 响应的 `serde_json::Value`。
/// 接受自然语言 `query` 字符串或预解析的 `symbol_names` 数组。
/// 如果提供了 `query`，会自动通过 NL 解析提取符号名称。
pub fn explore(
    graph: &Graph,
    project_root: &Path,
    symbol_names: &[String],
    query: Option<&str>,
    include_source: bool,
) -> serde_json::Value {
    // NL 解析：从自然语言查询中提取符号名称
    let effective_symbols: Vec<String> = if !symbol_names.is_empty() {
        symbol_names.to_vec()
    } else if let Some(q) = query {
        parse_nl_query(graph, q)
    } else {
        Vec::new()
    };
    let mut ctx = ExploreCtx {
        graph,
        project_root,
        include_source,
        named_nodes: Vec::new(),
        named_ids: HashSet::new(),
        named_files: HashSet::new(),
    };

    // 步骤 1：解析符号 → 节点
    for sym in &effective_symbols {
        let results = query::search_nodes(graph, sym);
        // 优先精确名称匹配，然后取第一个
        // 结果：Vec<&Node>
        let best: Option<&Node> = results.iter()
            .find(|n| n.name == *sym)
            .copied()
            .or_else(|| results.first().copied());
        if let Some(node) = best {
            ctx.named_nodes.push(node.clone());
            ctx.named_ids.insert(node.id.clone());
            if let Some(ref loc) = node.location {
                ctx.named_files.insert(file_key(loc));
            }
        }
    }

    if ctx.named_nodes.is_empty() {
        return json!({
            "flow": null,
            "blastRadius": { "dependents": [], "tests": [] },
            "relationships": {},
            "sourceCode": [],
            "architectureAlerts": {},
            "nodeIds": [],
            "meta": { "hint": "未找到匹配符号，试试更具体的名字", "totalSymbolsFound": 0 }
        });
    }

    // 步骤 2：Flow
    let flow = compute_flow(&ctx);

    // 步骤 3：Blast radius
    let blast_radius = compute_blast_radius(&ctx);

    // 步骤 4：Relationships
    let relationships = compute_relationships(&ctx);

    // 步骤 5：Source code
    let mut output_truncated = false;
    let mut truncation_hint = String::new();
    let source_code = if ctx.include_source {
        read_source_sections(&ctx, &mut output_truncated, &mut truncation_hint)
    } else {
        Vec::new()
    };

    // 步骤 6：Architecture alerts
    let architecture_alerts = compute_alerts(&ctx);

    // 步骤 7：收集节点 ID 用于 3D 联动
    let node_ids: Vec<String> = ctx.named_ids.iter().cloned().collect();

    let total_found = ctx.named_nodes.len();

    json!({
        "flow": flow,
        "blastRadius": blast_radius,
        "relationships": relationships,
        "sourceCode": source_code,
        "architectureAlerts": architecture_alerts,
        "nodeIds": node_ids,
        "meta": {
            "totalSymbolsFound": total_found,
            "totalFilesScanned": ctx.named_files.len(),
            "budgetRecommended": explore_budget(ctx.graph.node_count()),
            "budgetUsed": 1,
            "budgetTotal": explore_output_budget(ctx.graph.node_count()).max_output_chars,
            "outputTruncated": output_truncated,
            "totalFilesMatched": ctx.named_files.len(),
            "filesShown": if output_truncated { ctx.named_files.len().min(explore_output_budget(ctx.graph.node_count()).default_max_files) } else { ctx.named_files.len() },
            "hint": if output_truncated { truncation_hint } else { String::new() },
            "_generator": "HoloGram v4.0 — Copyright (c) 2026 Wenbing Jing — MIT License"
        }
    })
}

// ═══════════════════════════════════════════════════════════════
// 内部上下文
// ═══════════════════════════════════════════════════════════════

struct ExploreCtx<'a> {
    graph: &'a Graph,
    project_root: &'a Path,
    include_source: bool,
    named_nodes: Vec<Node>,
    named_ids: HashSet<String>,
    named_files: HashSet<String>,
}

// ═══════════════════════════════════════════════════════════════
// NL → 符号解析（规范 85-167 行）
// ═══════════════════════════════════════════════════════════════

/// 将自然语言查询解析为符号名称。
/// 步骤 0：归一化 — Erlang fn/N → fn，Lua mod:fn → mod.fn
/// 步骤 1：分词 — 按空白/标点分割，过滤为类代码 token。
/// 步骤 2：分类 — PascalCase = 上下文，限定名（:: 或 .）= 精确，其余 = 简单。
/// 步骤 3：消歧 — 使用 PascalCase 上下文来限定简单 token 的范围。
fn parse_nl_query(graph: &Graph, query: &str) -> Vec<String> {
    let normalized = normalize_query_spelling(query);
    let tokens = tokenize(&normalized);
    if tokens.is_empty() {
        return Vec::new();
    }

    // 分类 token
    let mut pascal_tokens: Vec<String> = Vec::new();
    let mut qualified_tokens: Vec<String> = Vec::new();
    let mut simple_tokens: Vec<String> = Vec::new();

    for tok in &tokens {
        if tok.contains("::") || tok.contains('.') {
            qualified_tokens.push(tok.clone());
        } else if is_pascal_case(tok) {
            pascal_tokens.push(tok.clone());
        } else {
            simple_tokens.push(tok.clone());
        }
    }

    let mut result: Vec<String> = Vec::new();

    // 限定 token → 直接查找（按限定名精确匹配）
    for qt in &qualified_tokens {
        // 按完整限定名搜索
        let matches = query::search_nodes(graph, qt);
        if let Some(best) = matches.iter().find(|n| n.name == *qt).or_else(|| matches.first()) {
            result.push(best.name.clone());
        }
    }

    // 简单 token → 用 PascalCase 上下文消歧
    for st in &simple_tokens {
        let matches = query::search_nodes(graph, st);
        let filtered = disambiguate(&matches, &pascal_tokens);
        for node in filtered {
            result.push(node.name.clone());
        }
    }

    // PascalCase token：如果能解析则添加（且不匹配项目/包名）
    for pt in &pascal_tokens {
        let matches = query::search_nodes(graph, pt);
        if matches.len() == 1 {
            result.push(matches[0].name.clone());
        } else if let Some(best) = matches.iter().find(|n| n.name == *pt) {
            result.push(best.name.clone());
        }
    }

    // 去重，上限 16
    let mut seen = HashSet::new();
    result.retain(|s| seen.insert(s.clone()));
    result.truncate(16);
    result
}

/// 归一化 Erlang/Lua 拼写：fn/3 → fn，mod:fn → mod.fn
fn normalize_query_spelling(query: &str) -> String {
    // Erlang 元数：fn/N → fn
    static RE_ARITY: OnceLock<regex::Regex> = OnceLock::new();
    let re_arity = RE_ARITY.get_or_init(||
        regex::Regex::new(r"\b([A-Za-z_][\w@]*)/\d{1,3}\b").unwrap()
    );
    // Lua mod:fn → mod.fn（但跳过协议前缀如 "kind:"、"lang:" 等）
    static RE_COLON: OnceLock<regex::Regex> = OnceLock::new();
    let re_colon = RE_COLON.get_or_init(||
        regex::Regex::new(r"\b([a-z_][\w@]*):([A-Za-z_][\w@]*)\b").unwrap()
    );
    let s = re_arity.replace_all(query, "$1").to_string();
    re_colon.replace_all(&s, "$1.$2").to_string()
}

/// 分词：按空白/标点分割，仅保留类代码 token。
fn tokenize(query: &str) -> Vec<String> {
    static SPLIT_RE: OnceLock<regex::Regex> = OnceLock::new();
    static ID_RE: OnceLock<regex::Regex> = OnceLock::new();
    static EXT_RE: OnceLock<regex::Regex> = OnceLock::new();

    let re = SPLIT_RE.get_or_init(|| regex::Regex::new(r"[\s,()\[\]]+").unwrap());
    let id_re = ID_RE.get_or_init(|| regex::Regex::new(r"^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$").unwrap());
    let ext_re = EXT_RE.get_or_init(|| regex::Regex::new(r"\.(py|rs|ts|tsx|js|jsx|go|java|swift|c|h|cpp|rb|lua|cs|php|kt|dart|scala|hs|json|html|css|yaml|yml|toml|md|sh)$").unwrap());

    let mut tokens: Vec<String> = re.split(query)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // 过滤：必须匹配标识符模式，非文件扩展名，长度 >= 2
    tokens.retain(|t| {
        id_re.is_match(t) && !ext_re.is_match(t) && t.len() >= 2
    });

    // 去重
    let mut seen = HashSet::new();
    tokens.retain(|t| seen.insert(t.clone()));
    tokens.truncate(16);
    tokens
}

/// PascalCase：首字符为大写 ASCII，至少 4 个字符。
fn is_pascal_case(s: &str) -> bool {
    s.len() >= 4
        && s.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 使用 PascalCase 上下文 token 对简单 token 进行消歧。
/// 如果候选 ≤ 3，全部保留。否则按容器名匹配过滤。
fn disambiguate<'a>(candidates: &[&'a Node], pascal_tokens: &[String]) -> Vec<&'a Node> {
    if candidates.len() <= 3 {
        return candidates.to_vec();
    }

    // 保留容器（限定名前缀）匹配某个 PascalCase token 的候选
    let in_context: Vec<&Node> = candidates.iter().filter(|n| {
        // 获取容器：限定名中最后一个 :: 之前的所有内容。
        // id 通常形如 "src.module.ClassName.method"
        let container = n.id.rsplit_once('.').map(|x| x.0).unwrap_or("");
        pascal_tokens.iter().any(|pt| {
            container.eq_ignore_ascii_case(pt)
                || container.contains(pt.as_str())
        })
    }).copied().collect();

    if !in_context.is_empty() {
        in_context.into_iter().take(4).collect()
    } else {
        // 回退：优先高度数节点（连接越多 = 越重要）
        let mut sorted: Vec<&&Node> = candidates.iter().collect();
        sorted.sort_by_key(|n| n.in_degree.saturating_add(n.out_degree));
        sorted.reverse();
        sorted.into_iter().take(1).copied().collect()
    }
}

// ═══════════════════════════════════════════════════════════════
// 步骤 2：Flow — 命名符号间的 BFS 路径
// ═══════════════════════════════════════════════════════════════

fn compute_flow(ctx: &ExploreCtx) -> serde_json::Value {
    if ctx.named_nodes.len() < 2 {
        return json!(null);
    }

    // 尝试在每对命名符号之间查找路径
    // 优先 Calls 边，回退到所有边
    let mut best_path: Option<Vec<String>> = None;

    for edge_kind_filter in &[Some(EdgeKind::Calls), None] {
        for i in 0..ctx.named_nodes.len() {
            for j in (i + 1)..ctx.named_nodes.len() {
                let from = &ctx.named_nodes[i];
                let to = &ctx.named_nodes[j];
                if let Some(path) = bfs_path(ctx, &from.id, &to.id, edge_kind_filter.as_ref(), false)
                {
                    if best_path.as_ref().is_none_or(|p| path.len() > p.len()) {
                        best_path = Some(path);
                    }
                }
                if let Some(path) = bfs_path(ctx, &to.id, &from.id, edge_kind_filter.as_ref(), true)
                {
                    if best_path.as_ref().is_none_or(|p| path.len() > p.len()) {
                        best_path = Some(path);
                    }
                }
            }
        }
        if best_path.is_some() {
            break;
        }
    }

    match best_path {
        Some(path_ids) => {
            let mut steps = Vec::new();
            for (k, nid) in path_ids.iter().enumerate() {
                if let Some(node) = ctx.graph.get_node(nid) {
                    let (file, line) = parse_location(&node.location);
                    steps.push(json!({
                        "name": node.name,
                        "file": file,
                        "line": line,
                        "kind": node.kind.as_str(),
                    }));
                }
                if k < path_ids.len() - 1 {
                    // 查找当前与下一个之间的边
                    let edge_kind = find_edge_kind(ctx.graph, &path_ids[k], &path_ids[k + 1]);
                    steps.push(json!({ "edge": edge_kind, "hop": k + 1 }));
                }
            }
            json!({
                "path": steps,
                "synthesizedHops": [],
            })
        }
        None => {
            // 未找到静态路径 — 扫描动态边界
            let boundaries = scan_boundaries_at_breakpoints(ctx);
            json!({
                "path": [],
                "synthesizedHops": [],
                "boundaries": boundaries,
            })
        },
    }
}

/// 当命名符号之间不存在静态 BFS 路径时，扫描其源
/// 文件中的动态分发模式（计算式调用、反射、事件分发）。
fn scan_boundaries_at_breakpoints(ctx: &ExploreCtx) -> Vec<serde_json::Value> {
    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut seen_files = HashSet::new();

    for node in &ctx.named_nodes {
        let location = match &node.location {
            Some(loc) => loc.clone(),
            None => continue,
        };
        let (file_path, _) = parse_location(&Some(location));
        if !seen_files.insert(file_path.clone()) {
            continue;
        }

        let full_path = ctx.project_root.join(&file_path);
        let content = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let language = guess_language(&file_path);
        let boundaries = crate::analysis::dynamic_boundaries::scan_dynamic_boundaries(
            &content, language, 1,
        );

        for bm in boundaries {
            let candidates = if let Some(ref key) = bm.key {
                crate::analysis::dynamic_boundaries::boundary_candidates(
                    ctx.graph, key, bm.key_is_type,
                )
            } else {
                Vec::new()
            };

            results.push(json!({
                "form": bm.form,
                "label": bm.label,
                "snippet": bm.snippet,
                "line": bm.line,
                "file": file_path,
                "key": bm.key,
                "keyIsType": bm.key_is_type,
                "moreSites": bm.more_sites,
                "candidates": candidates,
            }));
        }
    }

    results
}

fn bfs_path(
    ctx: &ExploreCtx,
    from: &str,
    to: &str,
    edge_filter: Option<&EdgeKind>,
    _reversed: bool,
) -> Option<Vec<String>> {
    let mut prev: HashMap<String, String> = HashMap::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut explore_count = 0usize;
    const MAX_EXPLORE: usize = 1500;
    const MAX_DEPTH: usize = 7;

    visited.insert(from.to_string());
    queue.push_back(from.to_string());
    prev.insert(from.to_string(), String::new()); // 哨兵值

    while let Some(cur) = queue.pop_front() {
        if cur == to {
            // 重建路径
            let mut path = Vec::new();
            let mut c = to.to_string();
            while c != from {
                path.push(c.clone());
                c = prev.get(&c)?.clone();
            }
            path.push(from.to_string());
            path.reverse();
            // 检查深度
            if path.len() - 1 <= MAX_DEPTH {
                return Some(path);
            }
        }

        // 计算当前深度以强制 MAX_DEPTH
        let cur_depth = path_depth(&prev, from, &cur);
        if cur_depth >= MAX_DEPTH {
            continue;
        }

        // 检查出边
        let out_edges = ctx.graph.outgoing_edges(&cur);
        for edge in &out_edges {
            if explore_count >= MAX_EXPLORE {
                break;
            }
            if let Some(ef) = edge_filter {
                if edge.kind != *ef {
                    continue;
                }
            }
            if !visited.contains(&edge.target) {
                visited.insert(edge.target.clone());
                prev.insert(edge.target.clone(), cur.clone());
                queue.push_back(edge.target.clone());
                explore_count += 1;
            }
        }
        // 检查入边（数据逆向流动）
        let in_edges = ctx.graph.incoming_edges(&cur);
        for edge in &in_edges {
            if explore_count >= MAX_EXPLORE {
                break;
            }
            if let Some(ef) = edge_filter {
                if edge.kind != *ef {
                    continue;
                }
            }
            if !visited.contains(&edge.source) {
                visited.insert(edge.source.clone());
                prev.insert(edge.source.clone(), cur.clone());
                queue.push_back(edge.source.clone());
                explore_count += 1;
            }
        }
    }
    None
}

fn path_depth(prev: &HashMap<String, String>, from: &str, cur: &str) -> usize {
    let mut depth = 0usize;
    let mut c = cur.to_string();
    while c != from {
        match prev.get(&c) {
            Some(p) if !p.is_empty() => {
                c = p.clone();
                depth += 1;
            }
            _ => break,
        }
    }
    depth
}

fn find_edge_kind(graph: &Graph, from: &str, to: &str) -> String {
    for edge in graph.outgoing_edges(from) {
        if edge.target == to {
            return edge.kind.as_str().to_string();
        }
    }
    "unknown".to_string()
}

// ═══════════════════════════════════════════════════════════════
// 步骤 3：Blast Radius
// ═══════════════════════════════════════════════════════════════

fn compute_blast_radius(ctx: &ExploreCtx) -> serde_json::Value {
    let mut dependents: Vec<serde_json::Value> = Vec::new();
    let mut tests: Vec<serde_json::Value> = Vec::new();
    let mut seen = HashSet::new();

    for node in &ctx.named_nodes {
        let incoming = ctx.graph.incoming_edges(&node.id);
        for edge in &incoming {
            if let Some(src) = ctx.graph.get_node(&edge.source) {
                let (file, line) = parse_location(&src.location);
                if seen.insert(src.id.clone()) {
                    let entry = json!({
                        "name": src.name,
                        "file": file,
                        "line": line,
                    });
                    if is_test_node(src, &file) {
                        tests.push(entry);
                    } else {
                        dependents.push(entry);
                    }
                }
            }
        }
    }

    json!({
        "dependents": dependents,
        "tests": tests,
    })
}

fn is_test_node(node: &Node, file: &str) -> bool {
    let lower_file = file.to_lowercase();
    let lower_name = node.name.to_lowercase();
    lower_file.contains("test")
        || lower_file.contains("spec")
        || lower_name.starts_with("test")
        || lower_name.contains("_test")
        || lower_name.starts_with("it_")
        || lower_name.starts_with("should_")
}

// ═══════════════════════════════════════════════════════════════
// 步骤 4：Relationships — 命名符号间按类型分组的边
// ═══════════════════════════════════════════════════════════════

fn compute_relationships(ctx: &ExploreCtx) -> serde_json::Value {
    let mut by_kind: HashMap<String, Vec<serde_json::Value>> = HashMap::new();

    for node in &ctx.named_nodes {
        for edge in ctx.graph.outgoing_edges(&node.id) {
            if ctx.named_ids.contains(&edge.target) {
                let kind = edge.kind.as_str().to_string();
                by_kind.entry(kind).or_default().push(json!({
                    "source": node.name,
                    "target": ctx.graph.get_node(&edge.target)
                        .map(|n| n.name.as_str())
                        .unwrap_or(&edge.target),
                }));
            }
        }
        for edge in ctx.graph.incoming_edges(&node.id) {
            if ctx.named_ids.contains(&edge.source) {
                let kind = edge.kind.as_str().to_string();
                by_kind.entry(kind).or_default().push(json!({
                    "source": ctx.graph.get_node(&edge.source)
                        .map(|n| n.name.as_str())
                        .unwrap_or(&edge.source),
                    "target": node.name,
                }));
            }
        }
    }

    // 在每种类型内去重
    let mut result = serde_json::Map::new();
    for (kind, mut edges) in by_kind {
        edges.sort_by_key(|e| format!("{}-{}", e["source"], e["target"]));
        edges.dedup_by_key(|e| format!("{}-{}", e["source"], e["target"]));
        result.insert(kind, serde_json::Value::Array(edges));
    }
    serde_json::Value::Object(result)
}

// ═══════════════════════════════════════════════════════════════
// 自适应 Explore 预算（按项目规模分层）
// ═══════════════════════════════════════════════════════════════

/// 项目文件数 → 推荐的 explore_deps 调用次数。
pub fn explore_budget(file_count: usize) -> usize {
    match file_count {
        n if n < 500 => 1,
        n if n < 5_000 => 2,
        n if n < 15_000 => 3,
        n if n < 25_000 => 4,
        _ => 5,
    }
}

pub struct ExploreOutputBudget {
    pub max_output_chars: usize,
    pub default_max_files: usize,
    pub max_chars_per_file: usize,
    pub gap_threshold: usize,
}

pub fn explore_output_budget(file_count: usize) -> ExploreOutputBudget {
    match file_count {
        n if n < 150 => ExploreOutputBudget {
            max_output_chars: 13_000, default_max_files: 4,
            max_chars_per_file: 3_800, gap_threshold: 7,
        },
        n if n < 500 => ExploreOutputBudget {
            max_output_chars: 18_000, default_max_files: 5,
            max_chars_per_file: 3_800, gap_threshold: 8,
        },
        n if n < 5_000 => ExploreOutputBudget {
            max_output_chars: 24_000, default_max_files: 8,
            max_chars_per_file: 6_500, gap_threshold: 12,
        },
        _ => ExploreOutputBudget {
            max_output_chars: 24_000, default_max_files: 8,
            max_chars_per_file: 7_000, gap_threshold: 15,
        },
    }
}

// ═══════════════════════════════════════════════════════════════
// 步骤 5：Source Code
// ═══════════════════════════════════════════════════════════════

fn read_source_sections(ctx: &ExploreCtx, truncated: &mut bool, hint: &mut String) -> Vec<serde_json::Value> {
    let budget = explore_output_budget(ctx.graph.node_count());
    let max_per_file = budget.max_chars_per_file;
    let max_output = budget.max_output_chars;
    let max_files = budget.default_max_files;

    let mut file_sections: Vec<SourceFileInfo> = Vec::new();
    let mut seen_files = HashSet::new();
    let mut total_chars = 0usize;
    let mut total_files_matched = 0usize;

    // 从命名节点收集文件，按相关性排序（首个 = 最相关）
    for node in &ctx.named_nodes {
        if let Some(ref loc) = node.location {
            let fk = file_key(loc);
            if !seen_files.insert(fk.clone()) {
                continue;
            }
            total_files_matched += 1;
            let (file_path, line_num) = parse_location(&Some(loc.clone()));
            if total_chars >= max_output || file_sections.len() >= max_files {
                *truncated = true;
                break;
            }
            if let Some(section) = read_file_section(ctx.project_root, &file_path, line_num, max_per_file, &mut total_chars) {
                file_sections.push(SourceFileInfo {
                    file: file_path,
                    sections: vec![section],
                });
            }
        }
    }

    // 也尝试从 blast radius 节点（邻居）读取文件
    for node in &ctx.named_nodes {
        for edge in ctx.graph.outgoing_edges(&node.id) {
            if total_chars >= max_output || file_sections.len() >= max_files {
                *truncated = true;
                break;
            }
            if let Some(target) = ctx.graph.get_node(&edge.target) {
                if let Some(ref loc) = target.location {
                    let fk = file_key(loc);
                    if !seen_files.insert(fk) {
                        continue;
                    }
                    total_files_matched += 1;
                    let (file_path, line_num) = parse_location(&Some(loc.clone()));
                    if let Some(section) = read_file_section(ctx.project_root, &file_path, line_num, max_per_file, &mut total_chars) {
                        file_sections.push(SourceFileInfo {
                            file: file_path,
                            sections: vec![section],
                        });
                    }
                }
            }
        }
    }

    if *truncated {
        *hint = format!("{} of {} matching files shown. Call explore_deps again with more specific symbols.",
            file_sections.len(), total_files_matched);
    }

    file_sections.into_iter().map(|s| {
        json!({
            "file": s.file,
            "language": guess_language(&s.file),
            "sections": s.sections.into_iter().map(|sec| json!({
                "startLine": sec.start_line,
                "endLine": sec.end_line,
                "lines": sec.lines,
            })).collect::<Vec<_>>(),
        })
    }).collect()
}

struct SourceFileInfo {
    file: String,
    sections: Vec<SourceSection>,
}

struct SourceSection {
    start_line: usize,
    end_line: usize,
    lines: String,
}

fn read_file_section(
    project_root: &Path,
    file: &str,
    line_hint: usize,
    max_chars: usize,
    total_chars: &mut usize,
) -> Option<SourceSection> {
    let full_path = project_root.join(file);
    let content = match std::fs::read_to_string(&full_path) {
        Ok(c) => c,
        Err(_) => return None,
    };

    let all_lines: Vec<&str> = content.lines().collect();
    if all_lines.is_empty() {
        return None;
    }

    let total_lines = all_lines.len();
    let center = if line_hint > 0 && line_hint <= total_lines {
        line_hint
    } else {
        1
    };

    // 在中心行周围取一个窗口，受 max_chars 限制
    let mut start = center.saturating_sub(20);
    let mut end = (center + 40).min(total_lines);

    // 在字符预算内扩展窗口
    let mut char_count = 0usize;
    for i in start..end {
        char_count += all_lines[i].len() + 1; // +1 为换行符
    }

    // 超预算时收缩
    while char_count > max_chars && end > start + 1 {
        if end - center > center - start {
            end -= 1;
            char_count -= all_lines[end].len() + 1;
        } else {
            start += 1;
            char_count -= all_lines[start - 1].len() + 1;
        }
    }

    // 在预算内时扩展
    while char_count < max_chars && (start > 0 || end < total_lines) {
        if start > 0 {
            start -= 1;
            char_count += all_lines[start].len() + 1;
        }
        if char_count < max_chars && end < total_lines {
            end += 1;
            char_count += all_lines[end - 1].len() + 1;
        }
    }

    let chars_to_add = char_count.min(max_chars);
    *total_chars += chars_to_add;

    let mut lines_str = String::with_capacity(char_count);
    for i in start..end {
        lines_str.push_str(&format!("{}\t{}\n", i + 1, all_lines[i]));
    }

    Some(SourceSection {
        start_line: start + 1,
        end_line: end,
        lines: lines_str,
    })
}

fn guess_language(file: &str) -> &'static str {
    let lower = file.to_lowercase();
    if lower.ends_with(".rs") { "rust" }
    else if lower.ends_with(".py") { "python" }
    else if lower.ends_with(".ts") || lower.ends_with(".tsx") { "typescript" }
    else if lower.ends_with(".js") || lower.ends_with(".jsx") { "javascript" }
    else if lower.ends_with(".go") { "go" }
    else if lower.ends_with(".java") { "java" }
    else if lower.ends_with(".swift") { "swift" }
    else if lower.ends_with(".c") || lower.ends_with(".h") { "c" }
    else if lower.ends_with(".cpp") || lower.ends_with(".hpp") || lower.ends_with(".cc") { "cpp" }
    else if lower.ends_with(".rb") { "ruby" }
    else if lower.ends_with(".lua") { "lua" }
    else { "text" }
}

// ═══════════════════════════════════════════════════════════════
// 步骤 6：Architecture Alerts
// ═══════════════════════════════════════════════════════════════

fn compute_alerts(ctx: &ExploreCtx) -> serde_json::Value {
    let mut alerts = serde_json::Map::new();

    // 环 — 检查是否有命名节点在环中
    let all_cycles = detect_cycles(ctx.graph);
    if !all_cycles.is_empty() {
        let relevant: Vec<_> = all_cycles.iter().filter(|c| {
            c.get("nodes").and_then(|n| n.as_array())
                .map(|nodes| {
                    nodes.iter().any(|n| {
                        n.as_str().map(|id| ctx.named_ids.contains(id)).unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        }).cloned().collect();
        if !relevant.is_empty() {
            alerts.insert("cycles".into(), json!(relevant));
        }
    }

    // 脆弱模块 — 检查命名节点的文件是否在 top fragile 中
    let fragile = fragile_nodes(ctx.graph, 10);
    if !fragile.is_empty() {
        let relevant: Vec<_> = fragile.iter().filter(|f| {
            f.get("file").and_then(|n| n.as_str())
                .map(|file| ctx.named_files.contains(&file_key(file)))
                .unwrap_or(false)
        }).cloned().collect();
        if !relevant.is_empty() {
            alerts.insert("fragileModules".into(), json!(relevant));
        }
    }

    // 高耦合 — 检查每个命名节点文件的耦合度
    let mut high_coupling = Vec::new();
    for file in &ctx.named_files {
        let report = coupling_report(ctx.graph, file);
        if let Some(l4) = report.get("L4").and_then(|v| v.as_u64()) {
            if l4 > 0 {
                high_coupling.push(json!({
                    "module": file,
                    "level": "L4",
                    "l4Count": l4,
                }));
            }
        }
    }
    if !high_coupling.is_empty() {
        alerts.insert("highCoupling".into(), json!(high_coupling));
    }

    // 线程冲突 — 检查连接到命名节点的 Medium 节点
    let mut thread_conflicts = Vec::new();
    for node in &ctx.named_nodes {
        for edge in ctx.graph.outgoing_edges(&node.id) {
            if let Some(target) = ctx.graph.get_node(&edge.target) {
                if matches!(target.kind, NodeKind::Medium) {
                    let accessors: Vec<_> = ctx.graph.incoming_edges(&target.id)
                        .iter()
                        .filter_map(|e| ctx.graph.get_node(&e.source).map(|n| n.name.clone()))
                        .collect();
                    if accessors.len() >= 2 {
                        let has_write = ctx.graph.incoming_edges(&target.id)
                            .iter()
                            .any(|e| matches!(e.kind, EdgeKind::Writes));
                        thread_conflicts.push(json!({
                            "resource": target.name,
                            "accessors": accessors,
                            "hasConcurrentWrite": has_write,
                        }));
                    }
                }
            }
        }
    }
    if !thread_conflicts.is_empty() {
        alerts.insert("threadConflicts".into(), json!(thread_conflicts));
    }

    serde_json::Value::Object(alerts)
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/// 从位置字符串（如 "src/main.rs:42"）提取文件路径和行号。
fn parse_location(loc: &Option<String>) -> (String, usize) {
    let raw = match loc {
        Some(l) => l.as_str(),
        None => return (String::new(), 0),
    };
    if let Some((path, line_str)) = raw.rsplit_once(':') {
        if let Ok(line) = line_str.parse::<usize>() {
            return (path.to_string(), line);
        }
        // 也许冒号是 Windows 路径的一部分如 C:\... — 检查
        if raw.len() > 2 && raw.as_bytes()[1] == b':' {
            return (raw.to_string(), 0);
        }
        return (raw.to_string(), 0);
    }
    (raw.to_string(), 0)
}

/// 归一化文件路径用于去重比较。
fn file_key(loc: &str) -> String {
    // 去除行号后缀（如存在）
    let path = if let Some((p, _)) = loc.rsplit_once(':') {
        // 防止 Windows 驱动器号被误判
        if p.len() > 1 && p.as_bytes()[p.len() - 1] == b':' {
            loc
        } else {
            p
        }
    } else {
        loc
    };
    path.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};

    fn test_graph() -> Graph {
        let mut g = Graph::new();
        // 两个通过调用连接的命名符号
        let mut a = Node::new("a", "DataRequest.task", NodeKind::Symbol);
        a.location = Some("Source/Core/DataRequest.swift:142".into());
        a.out_degree = 1;
        g.add_node(a);

        let mut b = Node::new("b", "DataRequest.validate", NodeKind::Symbol);
        b.location = Some("Source/Core/DataRequest.swift:203".into());
        b.in_degree = 1;
        b.out_degree = 1;
        g.add_node(b);

        // 一个依赖方
        let mut c = Node::new("c", "UploadService", NodeKind::Symbol);
        c.location = Some("Source/Services/UploadService.swift:45".into());
        c.out_degree = 1;
        g.add_node(c);

        // 一个测试
        let mut t = Node::new("t1", "testValidateResponse", NodeKind::Symbol);
        t.location = Some("Tests/DataRequestTests.swift:87".into());
        g.add_node(t);

        // 边
        let mut e1 = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e1.coupling_depth = 1;
        g.add_edge_unchecked(e1);

        let mut e2 = Edge::new("e2", "c", "a", EdgeKind::Calls);
        e2.coupling_depth = 2;
        g.add_edge_unchecked(e2);

        let mut e3 = Edge::new("e3", "t1", "a", EdgeKind::Calls);
        e3.coupling_depth = 1;
        g.add_edge_unchecked(e3);

        // 协议实现
        let mut proto = Node::new("proto", "RequestProtocol", NodeKind::Symbol);
        proto.location = Some("Source/Protocols/RequestProtocol.swift:10".into());
        g.add_node(proto);

        let mut e4 = Edge::new("e4", "a", "proto", EdgeKind::Inherits);
        e4.coupling_depth = 1;
        g.add_edge_unchecked(e4);

        g
    }

    #[test]
    fn test_explore_two_symbols() {
        let g = test_graph();
        let tmp = std::env::temp_dir();
        let result = explore(&g, &tmp, &["DataRequest.task".into(), "DataRequest.validate".into()], None, true);

        // Flow 应存在
        assert!(result["flow"]["path"].is_array());
        let path = result["flow"]["path"].as_array().unwrap();
        assert!(!path.is_empty(), "Flow path should not be empty");

        // Blast radius 应包含依赖方
        let deps = &result["blastRadius"]["dependents"];
        assert!(deps.is_array());
        let tests = &result["blastRadius"]["tests"];
        assert!(tests.is_array());

        // Relationships 应包含 calls
        let calls = &result["relationships"]["calls"];
        assert!(calls.is_array());

        // 节点 ID
        let ids = result["nodeIds"].as_array().unwrap();
        assert!(!ids.is_empty());
    }

    #[test]
    fn test_explore_empty_graph() {
        let g = Graph::new();
        let tmp = std::env::temp_dir();
        let result = explore(&g, &tmp, &["nothing".into()], None, false);
        assert_eq!(result["flow"], json!(null));
        assert_eq!(result["nodeIds"].as_array().unwrap().len(), 0);
        assert!(result["meta"]["hint"].as_str().unwrap().contains("未找到"));
    }

    #[test]
    fn test_parse_location_with_line() {
        let (file, line) = parse_location(&Some("src/main.rs:42".into()));
        assert_eq!(file, "src/main.rs");
        assert_eq!(line, 42);
    }

    #[test]
    fn test_parse_location_without_line() {
        let (file, line) = parse_location(&Some("src/main.rs".into()));
        assert_eq!(file, "src/main.rs");
        assert_eq!(line, 0);
    }

    #[test]
    fn test_parse_location_windows_drive() {
        let loc = Some("D:\\project\\src\\main.rs:55".into());
        let (file, line) = parse_location(&loc);
        // rsplit_once(':') 应在最后一个冒号处分割（55 之前）
        assert_eq!(line, 55);
        assert!(file.contains("main.rs"));
    }

    #[test]
    fn test_file_key_strips_line() {
        assert_eq!(file_key("src/main.rs:42"), "src/main.rs");
        assert_eq!(file_key("src/main.rs"), "src/main.rs");
    }

    #[test]
    fn test_guess_language() {
        assert_eq!(guess_language("foo.rs"), "rust");
        assert_eq!(guess_language("foo.ts"), "typescript");
        assert_eq!(guess_language("foo.swift"), "swift");
        assert_eq!(guess_language("foo.unknown"), "text");
    }

    #[test]
    fn test_is_test_node() {
        let n = Node::new("t1", "test_foo", NodeKind::Symbol);
        assert!(is_test_node(&n, "tests/test_foo.rs"));
        let n2 = Node::new("n2", "business", NodeKind::Symbol);
        assert!(!is_test_node(&n2, "src/business.rs"));
    }

    // ── NL 解析器测试 ──

    #[test]
    fn test_tokenize_simple() {
        let tokens = tokenize("DataRequest validate task");
        assert!(tokens.contains(&"DataRequest".to_string()));
        assert!(tokens.contains(&"validate".to_string()));
        assert!(tokens.contains(&"task".to_string()));
    }

    #[test]
    fn test_tokenize_filters_chinese() {
        let tokens = tokenize("DataRequest 怎么 validate 一个 task");
        // 中文字符应被过滤掉
        assert!(tokens.contains(&"DataRequest".to_string()));
        assert!(tokens.contains(&"validate".to_string()));
        assert!(tokens.contains(&"task".to_string()));
    }

    #[test]
    fn test_tokenize_filters_short() {
        let tokens = tokenize("a b c ab");
        // 单字符被过滤（<2）
        assert!(!tokens.contains(&"a".to_string()));
        assert!(!tokens.contains(&"b".to_string()));
        assert!(!tokens.contains(&"c".to_string()));
        assert!(tokens.contains(&"ab".to_string()));
    }

    #[test]
    fn test_tokenize_filters_extensions() {
        let tokens = tokenize("main.py handler.ts");
        assert!(!tokens.contains(&"main.py".to_string()));
        assert!(!tokens.contains(&"handler.ts".to_string()));
    }

    #[test]
    fn test_is_pascal_case() {
        assert!(is_pascal_case("DataRequest"));
        assert!(is_pascal_case("UserService"));
        assert!(!is_pascal_case("dataRequest")); // 小写开头
        assert!(!is_pascal_case("URL"));           // 太短（<4）
        assert!(!is_pascal_case("abc"));           // 太短 + 小写
    }

    #[test]
    fn test_disambiguate_few_candidates() {
        let g = test_graph();
        let candidates: Vec<&Node> = g.nodes.values().collect();
        let pascal: Vec<String> = vec![];
        // 候选 ≤ 3 时全部保留
        let few: Vec<&Node> = candidates.iter().take(3).copied().collect();
        let result = disambiguate(&few, &pascal);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_parse_nl_query_basic() {
        let g = test_graph();
        let symbols = parse_nl_query(&g, "DataRequest.task DataRequest.validate UploadService");
        assert!(!symbols.is_empty(), "Should extract at least some symbols");
    }
}
