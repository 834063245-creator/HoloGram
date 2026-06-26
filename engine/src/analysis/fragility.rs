// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::graph::Graph;
use crate::storage::MemoryIndex;

pub fn fragile_nodes(graph: &Graph, limit: usize) -> Vec<serde_json::Value> {
    // Build per-node edge index: one O(E) pass instead of O(V×E) edge-scans per node.
    // 20,655 nodes × 270,690 edges = 5.6B filter ops → ~300K ops.
    let mut node_edges: std::collections::HashMap<&str, Vec<&crate::graph::Edge>> =
        std::collections::HashMap::with_capacity(graph.nodes.len());
    for e in graph.edges.values() {
        node_edges.entry(&e.source).or_default().push(e);
        node_edges.entry(&e.target).or_default().push(e);
    }

    let mut scored: Vec<(f64, &str)> = graph.nodes.values().map(|n| {
        let fan = (n.out_degree + n.in_degree) as f64;
        let coupling_penalty = if let Some(edges) = node_edges.get(n.id.as_str()) {
            edges.iter().map(|e| (e.coupling_depth as f64).powi(2)).sum::<f64>() / fan.max(1.0)
        } else {
            0.0
        };
        let score = fan * (1.0 + coupling_penalty);
        (score, n.id.as_str())
    }).collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored.iter().map(|(s, id)| serde_json::json!({
        "node_id": id, "fragility_score": format!("{:.1}", s)
    })).collect()
}

pub fn fragile_nodes_from_index(idx: &MemoryIndex, limit: usize) -> Vec<serde_json::Value> {
    let mut scored: Vec<(f64, String)> = Vec::new();
    for node in idx.nodes_iter() {
        let out = idx.outgoing(&node.id, None);
        let incoming = idx.incoming(&node.id, None);
        let fan = (out.len() + incoming.len()) as f64;
        let coupling_penalty: f64 = out.iter()
            .map(|(_, _, depth, _)| (*depth as f64).powi(2))
            .chain(incoming.iter().map(|(_, _, depth, _)| (*depth as f64).powi(2)))
            .sum::<f64>() / fan.max(1.0);
        let score = fan * (1.0 + coupling_penalty);
        scored.push((score, node.id.clone()));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored.iter().map(|(s, id)| serde_json::json!({
        "node_id": id, "fragility_score": format!("{:.1}", s)
    })).collect()
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_fragile_empty_graph() {
        let g = Graph::new();
        let result = fragile_nodes(&g, 5);
        assert!(result.is_empty());
    }

    #[test]
    fn test_fragile_single_node() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        let result = fragile_nodes(&g, 5);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["node_id"], "a");
    }

    #[test]
    fn test_fragile_truncates_to_limit() {
        let mut g = Graph::new();
        for i in 0..10 {
            let mut n = Node::new(format!("n{}", i), format!("fn_{}", i), NodeKind::Symbol);
            n.out_degree = (10 - i) as u32;
            g.add_node(n);
        }
        let result = fragile_nodes(&g, 3);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_fragile_higher_coupling_scores_higher() {
        let mut g = Graph::new();
        let mut a = Node::new("a", "high_coupling", NodeKind::Symbol);
        a.out_degree = 10; a.in_degree = 0;
        g.add_node(a);
        let mut b = Node::new("b", "low_coupling", NodeKind::Symbol);
        b.out_degree = 0; b.in_degree = 0;
        g.add_node(b);
        for i in 0..10 {
            let tid = format!("t{}", i);
            g.add_node(Node::new(&tid, &tid, NodeKind::Symbol));
            let mut e = Edge::new(format!("ea{}", i), "a", &tid, EdgeKind::Calls);
            e.coupling_depth = 4;
            g.add_edge(e);
        }
        g.add_edge(Edge::new("eb", "b", "a", EdgeKind::Calls));
        let result = fragile_nodes(&g, 2);
        assert_eq!(result[0]["node_id"], "a", "high coupling should rank first");
    }

    #[test]
    fn test_fragile_limit_zero() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        let result = fragile_nodes(&g, 0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_fragile_limit_larger_than_graph() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        let result = fragile_nodes(&g, 100);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_fragile_from_index() {
        let mut g = Graph::new();
        let mut a = Node::new("a", "high_coupling", NodeKind::Symbol);
        a.out_degree = 10; a.in_degree = 0;
        g.add_node(a);
        let mut b = Node::new("b", "low_coupling", NodeKind::Symbol);
        b.out_degree = 0; b.in_degree = 0;
        g.add_node(b);
        // Node a has many high-coupling outgoing edges
        for i in 0..10 {
            let tid = format!("t{}", i);
            g.add_node(Node::new(&tid, &tid, NodeKind::Symbol));
            let mut e = Edge::new(format!("ea{}", i), "a", &tid, EdgeKind::Calls);
            e.coupling_depth = 4;
            g.add_edge(e);
        }
        // Node b has one low-coupling edge
        g.add_edge(Edge::new("eb", "b", "a", EdgeKind::Calls));
        let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
        let result = fragile_nodes_from_index(&idx, 2);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["node_id"], "a", "high coupling should rank first from index too");
    }
}
