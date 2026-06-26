// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::graph::{Graph, NodeKind};
use crate::storage::MemoryIndex;
use std::collections::HashMap;

pub fn graph_summary(graph: &Graph) -> serde_json::Value {
    let mut sym=0; let mut med=0; let mut tmp=0;
    for n in graph.nodes.values() {
        match n.kind { NodeKind::Symbol|NodeKind::Function|NodeKind::Class|NodeKind::Module|NodeKind::File|NodeKind::Interface=>{sym+=1}
            NodeKind::Medium=>{med+=1}
            NodeKind::Temporal=>{tmp+=1} }
    }
    let mut edge_types: HashMap<String, u32> = HashMap::new();
    for e in graph.edges.values() {
        *edge_types.entry(e.kind.as_str().to_string()).or_default() += 1;
    }
    serde_json::json!({
        "nodes_total": graph.nodes.len(), "edges_total": graph.edges.len(),
        "symbols": sym, "media": med, "temporals": tmp,
        "edge_types": edge_types
    })
}

pub fn graph_summary_from_index(idx: &MemoryIndex) -> serde_json::Value {
    let mut sym=0; let mut med=0; let mut tmp=0;
    for n in idx.nodes_iter() {
        match n.kind { NodeKind::Symbol|NodeKind::Function|NodeKind::Class|NodeKind::Module|NodeKind::File|NodeKind::Interface=>{sym+=1}
            NodeKind::Medium=>{med+=1}
            NodeKind::Temporal=>{tmp+=1} }
    }
    let mut edge_types: HashMap<String, u32> = HashMap::new();
    for (_, targets) in idx.edges_iter() {
        for (_, kind, _, _) in targets {
            *edge_types.entry(kind.as_str().to_string()).or_default() += 1;
        }
    }
    serde_json::json!({
        "nodes_total": idx.node_count(), "edges_total": idx.edge_count(),
        "symbols": sym, "media": med, "temporals": tmp,
        "edge_types": edge_types
    })
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_summary_empty_graph() {
        let g = Graph::new();
        let s = graph_summary(&g);
        assert_eq!(s["nodes_total"], 0);
        assert_eq!(s["edges_total"], 0);
        assert_eq!(s["symbols"], 0);
        assert_eq!(s["media"], 0);
        assert_eq!(s["temporals"], 0);
    }

    #[test]
    fn test_summary_counts_node_kinds() {
        let mut g = Graph::new();
        g.add_node(Node::new("s1", "sym", NodeKind::Symbol));
        g.add_node(Node::new("s2", "sym2", NodeKind::Symbol));
        g.add_node(Node::new("m1", "db", NodeKind::Medium));
        g.add_node(Node::new("t1", "timer", NodeKind::Temporal));

        let s = graph_summary(&g);
        assert_eq!(s["symbols"], 2);
        assert_eq!(s["media"], 1);
        assert_eq!(s["temporals"], 1);
        assert_eq!(s["nodes_total"], 4);
    }

    #[test]
    fn test_summary_counts_edge_types() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "a", "b", EdgeKind::Reads));
        g.add_edge(Edge::new("e3", "a", "b", EdgeKind::Reads));

        let s = graph_summary(&g);
        assert_eq!(s["edges_total"], 3);
        let et = &s["edge_types"];
        assert_eq!(et["calls"], 1);
        assert_eq!(et["reads"], 2);
    }
}
