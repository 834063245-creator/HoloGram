// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::graph::{Graph, NodeKind};
use crate::storage::MemoryIndex;
use std::collections::HashMap;

pub fn graph_summary(graph: &Graph) -> serde_json::Value {
    let mut sym=0; let mut med=0; let mut tmp=0;
    for (_, n) in graph.nodes_iter() {
        match n.kind { NodeKind::Symbol|NodeKind::Function|NodeKind::Class|NodeKind::Module|NodeKind::File|NodeKind::Interface|NodeKind::Variable=>{sym+=1}
            NodeKind::Medium=>{med+=1}
            NodeKind::Temporal=>{tmp+=1} }
    }
    let mut edge_types: HashMap<String, u32> = HashMap::new();
    for (_, e) in graph.edges_iter() {
        *edge_types.entry(e.kind.as_str().to_string()).or_default() += 1;
    }
    serde_json::json!({
        "nodes_total": graph.node_count(), "edges_total": graph.edge_count(),
        "symbols": sym, "media": med, "temporals": tmp,
        "edge_types": edge_types
    })
}

pub fn graph_summary_from_index(idx: &MemoryIndex) -> serde_json::Value {
    let mut sym=0; let mut med=0; let mut tmp=0; let mut external=0;
    for n in idx.nodes_iter() {
        match n.kind { NodeKind::Symbol|NodeKind::Function|NodeKind::Class|NodeKind::Module|NodeKind::File|NodeKind::Interface|NodeKind::Variable=>{sym+=1}
            NodeKind::Medium=>{med+=1}
            NodeKind::Temporal=>{tmp+=1} }
        if n.id.as_str().starts_with("ext:") {
            external += 1;
        }
    }
    let mut edge_types: HashMap<String, u32> = HashMap::new();
    // P0-3：解析率 —— 目标存在节点的边为「已解析」，其余为「未解析引用」。
    // 未解析引用被保留（不静默丢弃），在此诚实报告。
    let mut resolved_edges: u64 = 0;
    let mut unresolved_edges: u64 = 0;
    for (_, targets) in idx.edges_iter() {
        for (tgt, kind, _, _) in targets {
            *edge_types.entry(kind.as_str().to_string()).or_default() += 1;
            if idx.get_node(tgt.as_str()).is_some() && !tgt.as_str().starts_with("unresolved:") {
                resolved_edges += 1;
            } else {
                unresolved_edges += 1;
            }
        }
    }
    let total = resolved_edges + unresolved_edges;
    let rate = if total > 0 {
        resolved_edges as f64 / total as f64
    } else {
        1.0
    };
    serde_json::json!({
        "nodes_total": idx.node_count(), "edges_total": idx.edge_count(),
        "symbols": sym, "media": med, "temporals": tmp,
        "external_nodes": external,
        "edge_types": edge_types,
        "resolution": {
            "resolved_edges": resolved_edges,
            "unresolved_edges": unresolved_edges,
            "resolution_rate": (rate * 1000.0).round() / 1000.0,
            "_note": "未解析边保留为裸名引用（不再静默丢弃）；解析率 = 目标存在节点的边 / 总边数。用 resolve_call/trace_dataflow 按需深化。"
        }
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
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "a", "b", EdgeKind::Reads));
        g.add_edge_unchecked(Edge::new("e3", "a", "b", EdgeKind::Reads));

        let s = graph_summary(&g);
        assert_eq!(s["edges_total"], 3);
        let et = &s["edge_types"];
        assert_eq!(et["calls"], 1);
        assert_eq!(et["reads"], 2);
    }
}
