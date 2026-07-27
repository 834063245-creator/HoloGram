// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Execution flow detection and criticality scoring.
//!
//! Detects entry points from framework routes (pipeline stage 4), naming
//! conventions, and zero-indegree non-test functions. Traces execution paths
//! via forward BFS through CALLS edges, scores each flow for criticality,
//! and persists flow metadata as node properties.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::graph::{EdgeKind, NodeKind};
use crate::pipeline::runner::PipelineResult;

/// Security-sensitive keywords for criticality scoring.
const SECURITY_KEYWORDS: &[&str] = &[
    "auth", "login", "token", "password", "secret", "credential",
    "permission", "role", "access", "validate", "sanitize", "encrypt",
    "decrypt", "hash", "sign", "verify", "session", "csrf", "cors",
    "oauth", "jwt", "api_key", "rate_limit", "throttle",
];

/// Strip the trailing `:line_number` suffix from a location string.
/// Handles Windows drive-letter paths (e.g. `C:\foo\bar.rs:42` → `C:\foo\bar.rs`).
fn strip_line_suffix(loc: &str) -> &str {
    if let Some(pos) = loc.rfind(':') {
        let maybe_line = &loc[pos + 1..];
        if maybe_line.chars().all(|c| c.is_ascii_digit()) {
            return &loc[..pos];
        }
    }
    loc
}

/// Build an adjacency index: source_node_id → list of (target_node_id, edge_id)
/// for CALLS edges only. Built once, used by both entry-point detection and
/// flow tracing to avoid O(V×E) scans.
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
// Entry point detection
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

/// Detect entry points from three layers (priority order):
/// 1. Framework routes (pipeline stage 4) — most precise
/// 2. Naming conventions — covers non-framework projects
/// 3. Zero CALLS-indegree non-test functions — fallback
fn detect_entry_points(
    graph: &crate::graph::Graph,
    calls_adj: &HashMap<String, Vec<(String, String)>>,
) -> Vec<(String, String, Option<String>)> {
    // (node_id, entry_kind, framework_or_none)
    let mut entries: Vec<(String, String, Option<String>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // ── Layer 1: Framework routes ──
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
        // Follow outgoing CALLS edge to find the actual handler node
        if let Some(outgoing) = calls_adj.get(nid) {
            for (target, _) in outgoing {
                if !seen.contains(target) {
                    seen.insert(target.clone());
                    entries.push((target.clone(), "framework_route".into(), framework.clone()));
                }
            }
        }
    }

    // ── Layer 2+3: Naming + zero-indegree ──
    for (nid, node) in &graph.nodes {
        if seen.contains(nid) {
            continue;
        }
        if node.kind != NodeKind::Function && node.kind != NodeKind::Class {
            continue;
        }
        // Skip test functions
        let name = &node.name;
        if name.starts_with("test_") || name.ends_with("_test") || name.ends_with("Test") {
            continue;
        }
        // Count incoming CALLS edges using the reverse lookup
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
// Flow tracing
// ═══════════════════════════════════════════════════════════════

/// BFS forward through CALLS edges from an entry point, collecting the full
/// call chain up to `max_depth` hops. Returns (node_ids, edge_ids, depth).
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
            // Only update max_reached when we actually find callees
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
// Criticality scoring
// ═══════════════════════════════════════════════════════════════

fn compute_criticality(
    graph: &crate::graph::Graph,
    node_ids: &[String],
    edge_ids: &[String],
    depth: u32,
) -> (f64, u32, u32) {
    // Count L4 (temporal) edges
    let l4_count = edge_ids
        .iter()
        .filter_map(|eid| graph.edges.get(eid))
        .filter(|e| e.coupling_depth >= 4)
        .count() as u32;

    // Count cross-community edges
    let cross_comm = edge_ids
        .iter()
        .filter_map(|eid| graph.edges.get(eid))
        .filter(|e| {
            let src_comm = graph.nodes.get(&e.source).and_then(|n| n.community_id);
            let tgt_comm = graph.nodes.get(&e.target).and_then(|n| n.community_id);
            src_comm.is_some() && tgt_comm.is_some() && src_comm != tgt_comm
        })
        .count() as u32;

    // Security keyword hits
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

    // Weighted score
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
// Main entry point
// ═══════════════════════════════════════════════════════════════

/// Detect all execution flows in the graph, trace their call chains,
/// score criticality, and persist metadata on entry point nodes.
///
/// Returns the count of meaningful flows (entry points with ≥1 callee).
/// Full flow metadata is persisted on each entry-point node's `properties["flow"]`.
pub fn detect_all_flows(result: &mut PipelineResult) -> usize {
    let calls_adj = build_calls_adjacency(&result.graph);
    let entries = detect_entry_points(&result.graph, &calls_adj);

    // ponytail: cap at 5000 flows — beyond that it's noise, not signal.
    let entry_limit = entries.len().min(5000);
    let mut flow_count = 0usize;

    for (idx, (entry_id, kind, framework)) in entries.into_iter().take(entry_limit).enumerate() {
        let (node_ids, edge_ids, depth) = trace_flow(&calls_adj, &entry_id, 20);

        if node_ids.len() <= 1 {
            continue; // Entry point with no callees — not a meaningful flow
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

        // Persist flow metadata on the entry point node.
        // node_ids is stored here because handlers (get_flow, get_affected_flows)
        // need the full path — there's no separate flow store in MemoryIndex.
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
// Tests
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
        // Windows drive-letter path — must NOT strip the drive colon
        assert_eq!(strip_line_suffix("C:\\Users\\foo\\bar.rs:10"), "C:\\Users\\foo\\bar.rs");
        assert_eq!(strip_line_suffix("C:\\Users\\foo\\bar.rs"), "C:\\Users\\foo\\bar.rs");
        // No line number after colon → keep as-is
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

        // main → helper → validate
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

        // Framework route → handler → service
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

        // orphan_fn has 0 incoming CALLS, but doesn't match naming patterns
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
        // Non-CALLS edge should be excluded
        graph.add_edge(Edge::new("a::b::imports", "a", "b", EdgeKind::Imports));

        let adj = build_calls_adjacency(&graph);
        let a_out = adj.get("a").unwrap();
        assert_eq!(a_out.len(), 2, "should have 2 CALLS edges from a");
        assert!(adj.get("b").is_none(), "b has no outgoing CALLS");
    }
}
