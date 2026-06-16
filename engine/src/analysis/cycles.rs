use crate::graph::Graph;
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
    // Tarjan SCC
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
    for v in 0..n { if idx[v] == u32::MAX { strongconnect(v, &adj, &mut idx, &mut lowlink, &mut on_stack, &mut stack, &mut index, &mut sccs); } }

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
        g.add_edge(Edge::new("e2", "b", "a", EdgeKind::Calls)); // back edge
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
        // Self-loops produce SCC of size 1, which is filtered (must be >1 for cycles).
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "a", EdgeKind::Calls)); // self-loop
        let cycles = detect_cycles(&g);
        assert_eq!(cycles.len(), 0, "self-loop SCC size=1 is filtered");
    }

    #[test]
    fn test_cycles_isolated_nodes() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        // No edges
        assert!(detect_cycles(&g).is_empty());
    }

    #[test]
    fn test_cycles_multiple_scc() {
        let mut g = Graph::new();
        // Component 1: a↔b
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "a", EdgeKind::Calls));
        // Component 2: c↔d
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_node(Node::new("d", "d", NodeKind::Symbol));
        g.add_edge(Edge::new("e3", "c", "d", EdgeKind::Calls));
        g.add_edge(Edge::new("e4", "d", "c", EdgeKind::Calls));
        let cycles = detect_cycles(&g);
        assert_eq!(cycles.len(), 2);
    }
}
