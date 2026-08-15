// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::graph::{EdgeKind, Graph, NodeKind};
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
    let mut calls_total: u32 = 0;
    let mut calls_lsp: u32 = 0;
    for (_, e) in graph.edges_iter() {
        *edge_types.entry(e.kind.as_str().to_string()).or_default() += 1;
        if e.kind == EdgeKind::Calls {
            calls_total += 1;
            if e.lsp_resolved {
                calls_lsp += 1;
            }
        }
    }
    serde_json::json!({
        "nodes_total": graph.node_count(), "edges_total": graph.edge_count(),
        "symbols": sym, "media": med, "temporals": tmp,
        "edge_types": edge_types,
        "lsp_resolution": lsp_resolution_json(calls_total as usize, calls_lsp as usize)
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
    // P1-2：LSP 解析率 —— calls 边中被真实 LSP 解析的占比。
    let (calls_total, calls_lsp) = idx.lsp_resolution_stats();
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
        },
        "lsp_resolution": lsp_resolution_json(calls_total, calls_lsp)
    })
}

/// P1-2：LSP 解析率统计对象。
fn lsp_resolution_json(calls_total: usize, calls_lsp: usize) -> serde_json::Value {
    let ratio = if calls_total > 0 {
        calls_lsp as f64 / calls_total as f64
    } else {
        0.0
    };
    serde_json::json!({
        "calls_edges": calls_total,
        "lsp_resolved_edges": calls_lsp,
        "lsp_resolved_ratio": (ratio * 1000.0).round() / 1000.0,
        "_note": "lsp_resolved = 经真实 LSP 服务器解析的 calls 边（resolve_call 回写）；其余为同名启发式。"
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

    #[test]
    fn test_summary_reports_lsp_resolution() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(Node::new("a", "fn_a", NodeKind::Symbol));
        idx.insert_node(Node::new("b", "fn_b", NodeKind::Symbol));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        assert!(idx.mark_lsp_resolved("a", "b", EdgeKind::Calls));

        let s = graph_summary_from_index(&idx);
        assert_eq!(s["lsp_resolution"]["calls_edges"], 1);
        assert_eq!(s["lsp_resolution"]["lsp_resolved_edges"], 1);
        assert_eq!(s["lsp_resolution"]["lsp_resolved_ratio"], 1.0);

        // 无 LSP 标记时占比为 0
        let mut idx2 = MemoryIndex::new();
        idx2.insert_node(Node::new("a", "fn_a", NodeKind::Symbol));
        idx2.insert_node(Node::new("b", "fn_b", NodeKind::Symbol));
        idx2.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        let s2 = graph_summary_from_index(&idx2);
        assert_eq!(s2["lsp_resolution"]["calls_edges"], 1);
        assert_eq!(s2["lsp_resolution"]["lsp_resolved_edges"], 0);
        assert_eq!(s2["lsp_resolution"]["lsp_resolved_ratio"], 0.0);
    }
}
