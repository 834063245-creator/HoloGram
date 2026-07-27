// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Execution flow detection and criticality scoring.
//!
//! Detects entry points from framework routes (pipeline stage 4), naming
//! conventions, and zero-indegree non-test functions. Traces execution paths
//! via forward BFS through CALLS edges, scores each flow for criticality,
//! and persists flow metadata as node properties.

use std::collections::{HashSet, VecDeque};

use crate::graph::{EdgeKind, NodeKind};
use crate::pipeline::runner::PipelineResult;

/// Security-sensitive keywords for criticality scoring.
const SECURITY_KEYWORDS: &[&str] = &[
    "auth", "login", "token", "password", "secret", "credential",
    "permission", "role", "access", "validate", "sanitize", "encrypt",
    "decrypt", "hash", "sign", "verify", "session", "csrf", "cors",
    "oauth", "jwt", "api_key", "rate_limit", "throttle",
];

/// A single execution flow — one entry point + its full call chain.
#[derive(Debug, Clone)]
pub struct Flow {
    pub id: u32,
    pub name: String,
    pub entry_point_id: String,
    pub entry_kind: String,
    pub framework: Option<String>,
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
    pub depth: u32,
    pub node_count: u32,
    pub file_count: u32,
    pub criticality: f64,
    pub l4_edge_count: u32,
    pub cross_community_count: u32,
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
fn detect_entry_points(graph: &crate::graph::Graph) -> Vec<(String, String, Option<String>)> {
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
        for edge in graph.edges.values() {
            if edge.source == *nid && edge.kind == EdgeKind::Calls {
                if !seen.contains(&edge.target) {
                    seen.insert(edge.target.clone());
                    entries.push((edge.target.clone(), "framework_route".into(), framework.clone()));
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
        // Count incoming CALLS edges
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
    graph: &crate::graph::Graph,
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
        max_reached = max_reached.max(depth + 1);

        for edge in graph.edges.values() {
            if edge.source == current && edge.kind == EdgeKind::Calls {
                if !seen.contains(&edge.target) {
                    seen.insert(edge.target.clone());
                    visited_nodes.push(edge.target.clone());
                    visited_edges.push(edge.id.clone());
                    queue.push_back((edge.target.clone(), depth + 1));
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

    // Count unique files (used only for file_count; cross-comm uses edges)
    let _files: HashSet<&str> = node_ids
        .iter()
        .filter_map(|nid| graph.nodes.get(nid))
        .filter_map(|n| n.location.as_deref())
        .map(|loc| {
            // Strip line number suffix
            if let Some(pos) = loc.rfind(':') {
                let maybe = &loc[pos + 1..];
                if maybe.chars().all(|c| c.is_ascii_digit()) {
                    &loc[..pos]
                } else {
                    loc
                }
            } else {
                loc
            }
        })
        .collect();

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
pub fn detect_all_flows(result: &mut PipelineResult) -> Vec<Flow> {
    // Build adjacency for CALLS edges (used by trace_flow)
    let entries = detect_entry_points(&result.graph);

    let mut flows: Vec<Flow> = Vec::with_capacity(entries.len());
    // ponytail: cap at 5000 flows — beyond that it's noise, not signal.
    let entry_limit = entries.len().min(5000);

    for (idx, (entry_id, kind, framework)) in entries.into_iter().take(entry_limit).enumerate() {
        let (node_ids, edge_ids, depth) = trace_flow(&result.graph, &entry_id, 20);

        if node_ids.len() <= 1 {
            continue; // Entry point with no callees — not a meaningful flow
        }

        let file_count = node_ids
            .iter()
            .filter_map(|nid| result.graph.nodes.get(nid))
            .filter_map(|n| n.location.as_deref())
            .map(|loc| {
                if let Some(pos) = loc.rfind(':') {
                    &loc[..pos]
                } else {
                    loc
                }
            })
            .collect::<HashSet<_>>()
            .len() as u32;

        let (criticality, l4_count, cross_comm) =
            compute_criticality(&result.graph, &node_ids, &edge_ids, depth);

        // Build display name
        let entry_name = result
            .graph
            .nodes
            .get(&entry_id)
            .map(|n| n.name.clone())
            .unwrap_or_else(|| entry_id.clone());
        let name = match (&kind as &str, &framework) {
            ("framework_route", Some(fw)) => format!("[{}] {}", fw, entry_name),
            _ => entry_name.clone(),
        };

        flows.push(Flow {
            id: idx as u32,
            name,
            entry_point_id: entry_id.clone(),
            entry_kind: kind,
            framework,
            node_ids: node_ids.clone(),
            edge_ids: edge_ids.clone(),
            depth,
            node_count: node_ids.len() as u32,
            file_count,
            criticality,
            l4_edge_count: l4_count,
            cross_community_count: cross_comm,
        });

        // Persist flow metadata on the entry point node
        if let Some(node) = result.graph.nodes.get_mut(&entry_id) {
            node.properties["flow"] = serde_json::json!({
                "id": idx,
                "criticality": criticality,
                "depth": depth,
                "node_count": node_ids.len(),
                "file_count": file_count,
                "l4_count": l4_count,
                "cross_community": cross_comm,
                "node_ids": node_ids,
            });
        }
    }

    flows.sort_by(|a, b| b.criticality.partial_cmp(&a.criticality).unwrap_or(std::cmp::Ordering::Equal));
    flows
}
