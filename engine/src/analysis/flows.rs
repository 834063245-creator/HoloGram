// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 执行流检测与关键性评分。
//!
//! 从框架路由（pipeline 阶段 4）、命名约定和零入度非测试函数中检测入口点。
//! 通过沿 CALLS 边的前向 BFS 追踪执行路径，对每个 Flow 进行关键性评分，
//! 并将 Flow 元数据持久化为节点属性。

use std::collections::{HashMap, HashSet, VecDeque};

use crate::graph::{EdgeKind, NodeKind};
use crate::pipeline::runner::PipelineResult;

/// 用于关键性评分的安全敏感关键词。
const SECURITY_KEYWORDS: &[&str] = &[
    "auth", "login", "token", "password", "secret", "credential",
    "permission", "role", "access", "validate", "sanitize", "encrypt",
    "decrypt", "hash", "sign", "verify", "session", "csrf", "cors",
    "oauth", "jwt", "api_key", "rate_limit", "throttle",
];

/// 去除位置字符串末尾的 `:line_number` 后缀。
/// 处理 Windows 驱动器号路径（如 `C:\foo\bar.rs:42` → `C:\foo\bar.rs`）。
fn strip_line_suffix(loc: &str) -> &str {
    if let Some(pos) = loc.rfind(':') {
        let maybe_line = &loc[pos + 1..];
        if maybe_line.chars().all(|c| c.is_ascii_digit()) {
            return &loc[..pos];
        }
    }
    loc
}

/// 构建 CALLS 边的邻接索引：source_node_id → (target_node_id, edge_id) 列表。
/// 仅构建一次，供入口点检测和 Flow 追踪共用，避免 O(V×E) 扫描。
fn build_calls_adjacency(graph: &crate::graph::Graph) -> HashMap<String, Vec<(String, String)>> {
    let mut adj: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for edge in graph.edges.values() {
        if edge.kind == EdgeKind::Calls {
            adj.entry(edge.source.clone())
                .or_default()
                .push((edge.target.clone(), edge.id.clone()));
        }
    }
    adj
}

// ═══════════════════════════════════════════════════════════════
// 入口点检测
// ═══════════════════════════════════════════════════════════════

fn is_entry_point_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "main"
        || lower.starts_with("handle")
        || lower.starts_with("process")
        || matches!(
            lower.as_str(),
            "run" | "start" | "stop" | "serve" | "migrate"
            | "setup" | "bootstrap" | "execute" | "configure"
            | "initialize" | "load"
        )
}

/// 从三个层次检测入口点（按优先级排序）：
/// 1. 框架路由（pipeline 阶段 4）— 最精确
/// 2. 命名约定 — 覆盖非框架项目
/// 3. 零 CALLS 入度非测试函数 — 回退方案
fn detect_entry_points(
    graph: &crate::graph::Graph,
    calls_adj: &HashMap<String, Vec<(String, String)>>,
) -> Vec<(String, String, Option<String>)> {
    // 返回 (node_id, entry_kind, framework_or_none) 元组
    let mut entries: Vec<(String, String, Option<String>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // ── 第 1 层：框架路由 ──
    for (nid, node) in &graph.nodes {
        let props = match node.properties.as_object() {
            Some(p) => p,
            None => continue,
        };
        if props.get("kind").and_then(|v| v.as_str()) != Some("route") {
            continue;
        }
        let framework = props
            .get("framework")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // 沿出边 CALLS 边查找实际的 handler 节点
        if let Some(outgoing) = calls_adj.get(nid) {
            for (target, _) in outgoing {
                if !seen.contains(target) {
                    seen.insert(target.clone());
                    entries.push((target.clone(), "framework_route".into(), framework.clone()));
                }
            }
        }
    }

    // ── 第 2+3 层：命名约定 + 零入度 ──
    for (nid, node) in &graph.nodes {
        if seen.contains(nid) {
            continue;
        }
        if node.kind != NodeKind::Function && node.kind != NodeKind::Class {
            continue;
        }
        // 跳过测试函数
        let name = &node.name;
        if name.starts_with("test_") || name.ends_with("_test") || name.ends_with("Test") {
            continue;
        }
        // 使用反向查找计算入边 CALLS 边数量
        let call_incoming = graph
            .edges
            .values()
            .filter(|e| e.target == *nid && e.kind == EdgeKind::Calls)
            .count();
        let is_entry_name = is_entry_point_name(name);
        if call_incoming == 0 || is_entry_name {
            let kind = if is_entry_name {
                "naming_convention"
            } else {
                "orphan_entry"
            };
            seen.insert(nid.clone());
            entries.push((nid.clone(), kind.into(), None));
        }
    }

    entries
}

// ═══════════════════════════════════════════════════════════════
// Flow 追踪
// ═══════════════════════════════════════════════════════════════

/// 从入口点沿 CALLS 边前向 BFS，收集完整的
/// 调用链（最多 `max_depth` 跳）。返回 (node_ids, edge_ids, depth)。
fn trace_flow(
    calls_adj: &HashMap<String, Vec<(String, String)>>,
    entry_node_id: &str,
    max_depth: u32,
) -> (Vec<String>, Vec<String>, u32) {
    let mut visited_nodes: Vec<String> = Vec::new();
    let mut visited_edges: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    let mut max_reached = 0u32;

    seen.insert(entry_node_id.to_string());
    visited_nodes.push(entry_node_id.to_string());
    queue.push_back((entry_node_id.to_string(), 0));

    while let Some((current, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        if let Some(outgoing) = calls_adj.get(&current) {
            // 仅在确实找到被调用者时更新 max_reached
            max_reached = max_reached.max(depth + 1);

            for (target, edge_id) in outgoing {
                if !seen.contains(target) {
                    seen.insert(target.clone());
                    visited_nodes.push(target.clone());
                    visited_edges.push(edge_id.clone());
                    queue.push_back((target.clone(), depth + 1));
                }
            }
        }
    }

    (visited_nodes, visited_edges, max_reached)
}

// ═══════════════════════════════════════════════════════════════
// 关键性评分
// ═══════════════════════════════════════════════════════════════

fn compute_criticality(
    graph: &crate::graph::Graph,
    node_ids: &[String],
    edge_ids: &[String],
    depth: u32,
) -> (f64, u32, u32) {
    // 统计 L4（时序）边数量
    let l4_count = edge_ids
        .iter()
        .filter_map(|eid| graph.edges.get(eid))
        .filter(|e| e.coupling_depth >= 4)
        .count() as u32;

    // 统计跨社区边数量
    let cross_comm = edge_ids
        .iter()
        .filter_map(|eid| graph.edges.get(eid))
        .filter(|e| {
            let src_comm = graph.nodes.get(&e.source).and_then(|n| n.community_id);
            let tgt_comm = graph.nodes.get(&e.target).and_then(|n| n.community_id);
            src_comm.is_some() && tgt_comm.is_some() && src_comm != tgt_comm
        })
        .count() as u32;

    // 安全关键词命中
    let security_score = node_ids
        .iter()
        .filter_map(|nid| graph.nodes.get(nid))
        .map(|n| {
            let lower = n.name.to_lowercase();
            SECURITY_KEYWORDS
                .iter()
                .filter(|kw| lower.contains(*kw))
                .count() as f64
                * 0.05
        })
        .sum::<f64>()
        .min(0.3);

    // 加权评分
    let n = node_ids.len() as f64;
    let depth_norm = (depth as f64 / 10.0).min(1.0);
    let size_norm = (n / 100.0).min(1.0);
    let l4_norm = (l4_count as f64 / (edge_ids.len().max(1) as f64)).min(1.0);
    let cross_norm = (cross_comm as f64 / (edge_ids.len().max(1) as f64)).min(1.0);

    let score = depth_norm * 0.25 + size_norm * 0.15 + l4_norm * 0.25
        + cross_norm * 0.15 + security_score;

    (score.clamp(0.0, 1.0), l4_count, cross_comm)
}

// ═══════════════════════════════════════════════════════════════
// 主入口点
// ═══════════════════════════════════════════════════════════════

/// 检测 Graph 中所有执行流，追踪其调用链，
/// 进行关键性评分，并将元数据持久化到入口点节点上。
///
/// 返回有意义的 Flow 数量（含 ≥1 个被调用者的入口点）。
/// 完整的 Flow 元数据持久化在每个入口点节点的 `properties["flow"]` 中。
pub fn detect_all_flows(result: &mut PipelineResult) -> usize {
    let calls_adj = build_calls_adjacency(&result.graph);
    let entries = detect_entry_points(&result.graph, &calls_adj);

    // 上限 5000 条 Flow — 超过即为噪声，非信号。
    let entry_limit = entries.len().min(5000);
    let mut flow_count = 0usize;

    for (idx, (entry_id, kind, framework)) in entries.into_iter().take(entry_limit).enumerate() {
        let (node_ids, edge_ids, depth) = trace_flow(&calls_adj, &entry_id, 20);

        if node_ids.len() <= 1 {
            continue; // 入口点无被调用者 — 不是有意义的 Flow
        }

        let file_count = node_ids
            .iter()
            .filter_map(|nid| result.graph.nodes.get(nid))
            .filter_map(|n| n.location.as_deref())
            .map(|loc| strip_line_suffix(loc))
            .collect::<HashSet<_>>()
            .len() as u32;

        let (criticality, l4_count, cross_comm) =
            compute_criticality(&result.graph, &node_ids, &edge_ids, depth);

        // 将 Flow 元数据持久化到入口点节点。
        // node_ids 存储在此处，因为 handler（get_flow, get_affected_flows）
        // 需要完整路径 — MemoryIndex 中没有独立的 Flow 存储区。
        if let Some(node) = result.graph.nodes.get_mut(&entry_id) {
            node.properties["flow"] = serde_json::json!({
                "id": idx,
                "entry_kind": kind,
                "framework": framework,
                "criticality": criticality,
                "depth": depth,
                "node_count": node_ids.len(),
                "file_count": file_count,
                "l4_count": l4_count,
                "cross_community": cross_comm,
                "node_ids": node_ids,
            });
        }
        flow_count += 1;
    }

    flow_count
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, Graph, Node, NodeKind};
    use crate::pipeline::runner::PipelineResult;
    use std::collections::HashMap;

    fn make_result(graph: Graph) -> PipelineResult {
        PipelineResult {
            graph,
            files_discovered: 0,
            files_parsed: 0,
            files_failed: 0,
            nodes_total: 0,
            edges_total: 0,
            elapsed_secs: 0.0,
            parse_cache: HashMap::new(),
            discovered_files: Vec::new(),
        }
    }

    fn make_node(id: &str, name: &str, kind: NodeKind) -> Node {
        Node::new(id, name, kind)
    }

    fn make_calls_edge(graph: &mut Graph, src: &str, tgt: &str) {
        let id = format!("{}::{}::calls", src, tgt);
        graph.add_edge(Edge::new(id, src, tgt, EdgeKind::Calls));
    }

    #[test]
    fn test_strip_line_suffix() {
        assert_eq!(strip_line_suffix("src/main.rs:42"), "src/main.rs");
        assert_eq!(strip_line_suffix("src/main.rs"), "src/main.rs");
        // Windows 驱动器号路径 — 不应去除驱动器冒号
        assert_eq!(strip_line_suffix("C:\\Users\\foo\\bar.rs:10"), "C:\\Users\\foo\\bar.rs");
        assert_eq!(strip_line_suffix("C:\\Users\\foo\\bar.rs"), "C:\\Users\\foo\\bar.rs");
        // 冒号后无行号 → 保持原样
        assert_eq!(strip_line_suffix("http://example.com"), "http://example.com");
    }

    #[test]
    fn test_is_entry_point_name() {
        assert!(is_entry_point_name("main"));
        assert!(is_entry_point_name("handleRequest"));
        assert!(is_entry_point_name("processData"));
        assert!(is_entry_point_name("run"));
        assert!(is_entry_point_name("start"));
        assert!(is_entry_point_name("bootstrap"));
        assert!(is_entry_point_name("initialize"));
        assert!(!is_entry_point_name("getData"));
        assert!(!is_entry_point_name("helper"));
        assert!(!is_entry_point_name("format"));
    }

    #[test]
    fn test_detect_flows_basic() {
        let mut graph = Graph::new();

        // main → helper → validate 调用链
        graph.add_node(make_node("main", "main", NodeKind::Function));
        graph.add_node(make_node("helper", "helper", NodeKind::Function));
        graph.add_node(make_node("validate", "validate", NodeKind::Function));
        make_calls_edge(&mut graph, "main", "helper");
        make_calls_edge(&mut graph, "helper", "validate");

        let mut result = make_result(graph);
        let count = detect_all_flows(&mut result);

        assert_eq!(count, 1, "should detect 1 flow from main");
        let main_node = result.graph.nodes.get("main").unwrap();
        let flow = main_node.properties.get("flow").unwrap();
        assert_eq!(flow.get("entry_kind").unwrap().as_str().unwrap(), "naming_convention");
        assert_eq!(flow.get("node_count").unwrap().as_u64().unwrap(), 3);
        assert_eq!(flow.get("depth").unwrap().as_u64().unwrap(), 2);
    }

    #[test]
    fn test_detect_flows_entry_kind_persisted() {
        let mut graph = Graph::new();

        // 框架路由 → handler → service
        let mut route = make_node("route1", "/api/users", NodeKind::Function);
        route.properties = serde_json::json!({"kind": "route", "framework": "fastapi"});
        graph.add_node(route);
        graph.add_node(make_node("handler", "get_users", NodeKind::Function));
        graph.add_node(make_node("svc", "fetch_users", NodeKind::Function));
        make_calls_edge(&mut graph, "route1", "handler");
        make_calls_edge(&mut graph, "handler", "svc");

        let mut result = make_result(graph);
        detect_all_flows(&mut result);

        let handler_node = result.graph.nodes.get("handler").unwrap();
        let flow = handler_node.properties.get("flow").unwrap();
        assert_eq!(
            flow.get("entry_kind").unwrap().as_str().unwrap(),
            "framework_route",
            "entry_kind should be framework_route for route-discovered entries"
        );
        assert_eq!(
            flow.get("framework").unwrap().as_str().unwrap(),
            "fastapi"
        );
    }

    #[test]
    fn test_detect_flows_orphan_entry() {
        let mut graph = Graph::new();

        // orphan_fn 有 0 条入边 CALLS，但不匹配命名模式
        graph.add_node(make_node("orphan_fn", "computeHash", NodeKind::Function));
        graph.add_node(make_node("callee", "hashAlg", NodeKind::Function));
        make_calls_edge(&mut graph, "orphan_fn", "callee");

        let mut result = make_result(graph);
        detect_all_flows(&mut result);

        let orphan = result.graph.nodes.get("orphan_fn").unwrap();
        let flow = orphan.properties.get("flow").unwrap();
        assert_eq!(
            flow.get("entry_kind").unwrap().as_str().unwrap(),
            "orphan_entry",
            "zero-indegree non-naming-pattern should be orphan_entry"
        );
    }

    #[test]
    fn test_detect_flows_skip_tests() {
        let mut graph = Graph::new();

        graph.add_node(make_node("test_fn", "test_foo", NodeKind::Function));
        graph.add_node(make_node("callee", "bar", NodeKind::Function));
        make_calls_edge(&mut graph, "test_fn", "callee");

        let mut result = make_result(graph);
        let count = detect_all_flows(&mut result);

        assert_eq!(count, 0, "test functions should not be entry points");
    }

    #[test]
    fn test_detect_flows_skip_single_node() {
        let mut graph = Graph::new();
        graph.add_node(make_node("main", "main", NodeKind::Function));

        let mut result = make_result(graph);
        let count = detect_all_flows(&mut result);

        assert_eq!(count, 0, "entry point with no callees is not a meaningful flow");
    }

    #[test]
    fn test_compute_criticality_security_keywords() {
        let mut graph = Graph::new();

        graph.add_node(make_node("n1", "authenticate_user", NodeKind::Function));
        graph.add_node(make_node("n2", "validate_token", NodeKind::Function));
        graph.add_node(make_node("n3", "helper", NodeKind::Function));
        make_calls_edge(&mut graph, "n1", "n2");
        make_calls_edge(&mut graph, "n2", "n3");

        let node_ids = vec!["n1".to_string(), "n2".to_string(), "n3".to_string()];
        let edge_ids = vec!["n1::n2::calls".to_string(), "n2::n3::calls".to_string()];
        let (score, _, _) = compute_criticality(&graph, &node_ids, &edge_ids, 2);

        assert!(score > 0.0, "security keywords should contribute to score");
    }

    #[test]
    fn test_build_calls_adjacency() {
        let mut graph = Graph::new();
        graph.add_node(make_node("a", "a", NodeKind::Function));
        graph.add_node(make_node("b", "b", NodeKind::Function));
        graph.add_node(make_node("c", "c", NodeKind::Function));
        make_calls_edge(&mut graph, "a", "b");
        make_calls_edge(&mut graph, "a", "c");
        // 非 CALLS 边应被排除
        graph.add_edge(Edge::new("a::b::imports", "a", "b", EdgeKind::Imports));

        let adj = build_calls_adjacency(&graph);
        let a_out = adj.get("a").unwrap();
        assert_eq!(a_out.len(), 2, "should have 2 CALLS edges from a");
        assert!(adj.get("b").is_none(), "b has no outgoing CALLS");
    }
}
