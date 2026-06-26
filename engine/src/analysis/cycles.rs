// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::graph::Graph;
use crate::storage::MemoryIndex;
use std::collections::HashMap;

pub fn detect_cycles(graph: &Graph) -> Vec<serde_json::Value> {
    let n = graph.nodes.len();
    if n == 0 { return vec![]; }
    let node_ids: Vec<&String> = graph.nodes.keys().collect();
    let id_to_idx: HashMap<&String, usize> = node_ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut adj = vec![vec![]; n];
    for e in graph.edges.values() {
        if let (Some(&s), Some(&t)) = (id_to_idx.get(&e.source), id_to_idx.get(&e.target)) {
            adj[s].push(t);
        }
    }
    run_tarjan(&node_ids, &adj)
}

pub fn detect_cycles_from_index(idx: &MemoryIndex) -> Vec<serde_json::Value> {
    let node_ids: Vec<String> = idx.nodes_iter().map(|n| n.id.clone()).collect();
    let n = node_ids.len();
    if n == 0 { return vec![]; }
    let id_to_idx: HashMap<&str, usize> = node_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let mut adj = vec![vec![]; n];
    for (source, targets) in idx.edges_iter() {
        if let Some(&s) = id_to_idx.get(source.as_str()) {
            for (target, _, _, _) in targets {
                if let Some(&t) = id_to_idx.get(target.as_str()) {
                    adj[s].push(t);
                }
            }
        }
    }
    let node_refs: Vec<&String> = node_ids.iter().collect();
    run_tarjan(&node_refs, &adj)
}

fn run_tarjan(node_ids: &[&String], adj: &[Vec<usize>]) -> Vec<serde_json::Value> {
    let n = node_ids.len();
    let mut index = 0u32;
    let mut idx = vec![u32::MAX; n];
    let mut lowlink = vec![0u32; n];
    let mut on_stack = vec![false; n];
    let mut stack = Vec::new();
    let mut sccs = Vec::new();
    fn strongconnect(v: usize, adj: &[Vec<usize>], idx: &mut [u32], lowlink: &mut [u32],
        on_stack: &mut [bool], stack: &mut Vec<usize>, index: &mut u32, sccs: &mut Vec<Vec<usize>>) {
        idx[v] = *index; lowlink[v] = *index; *index += 1;
        stack.push(v); on_stack[v] = true;
        for &w in &adj[v] {
            if idx[w] == u32::MAX { strongconnect(w, adj, idx, lowlink, on_stack, stack, index, sccs);
                lowlink[v] = lowlink[v].min(lowlink[w]);
            } else if on_stack[w] { lowlink[v] = lowlink[v].min(idx[w]); }
        }
        if lowlink[v] == idx[v] {
            let mut comp = Vec::new();
            loop { let w = stack.pop().unwrap(); on_stack[w] = false; comp.push(w); if w == v { break; } }
            sccs.push(comp);
        }
    }
    for v in 0..n { if idx[v] == u32::MAX { strongconnect(v, adj, &mut idx, &mut lowlink, &mut on_stack, &mut stack, &mut index, &mut sccs); } }

    sccs.into_iter().filter(|c| c.len() > 1).map(|c| {
        let node_names: Vec<_> = c.iter().map(|&i| node_ids[i].clone()).collect();
        serde_json::json!({ "nodes": node_names, "size": c.len() })
    }).collect()
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_cycles_empty_graph() {
        let g = Graph::new();
        assert!(detect_cycles(&g).is_empty());
    }

    #[test]
    fn test_cycles_no_cycle() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));
        assert!(detect_cycles(&g).is_empty());
    }

    #[test]
    fn test_cycles_simple_cycle() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "a", EdgeKind::Calls));
        let cycles = detect_cycles(&g);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0]["size"], 2);
    }

    #[test]
    fn test_cycles_three_node_cycle() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));
        g.add_edge(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let cycles = detect_cycles(&g);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0]["size"], 3);
    }

    #[test]
    fn test_cycles_self_loop() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "a", EdgeKind::Calls));
        let cycles = detect_cycles(&g);
        assert_eq!(cycles.len(), 0, "self-loop SCC size=1 is filtered");
    }

    #[test]
    fn test_cycles_isolated_nodes() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        assert!(detect_cycles(&g).is_empty());
    }

    #[test]
    fn test_cycles_multiple_scc() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "a", EdgeKind::Calls));
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_node(Node::new("d", "d", NodeKind::Symbol));
        g.add_edge(Edge::new("e3", "c", "d", EdgeKind::Calls));
        g.add_edge(Edge::new("e4", "d", "c", EdgeKind::Calls));
        let cycles = detect_cycles(&g);
        assert_eq!(cycles.len(), 2);
    }

    #[test]
    fn test_cycles_from_index() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "a", EdgeKind::Calls));
        let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
        let cycles = detect_cycles_from_index(&idx);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0]["size"], 2);
    }
}
