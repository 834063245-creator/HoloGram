// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::graph::Graph;
use crate::storage::MemoryIndex;

pub fn coupling_report(graph: &Graph, module: &str) -> serde_json::Value {
    let mut l1=0u32; let mut l2=0u32; let mut l3=0u32; let mut l4=0u32;

    // Normalize module path for matching against node locations
    let normalized = module.replace('\\', "/").to_lowercase();

    /// Check whether a node ID matches the given module.
    /// Fast path: direct ID match (for tests & simple cases).
    /// Slow path: check node.location against the module file path.
    fn node_matches(graph: &Graph, node_id: &str, module: &str, normalized_module: &str) -> bool {
        if node_id == module {
            return true;
        }
        if let Some(node) = graph.get_node(node_id) {
            if let Some(ref loc) = node.location {
                let key = loc.replace('\\', "/").to_lowercase();
                if key.starts_with(normalized_module) || key == normalized_module {
                    return true;
                }
            }
        }
        false
    }

    for e in graph.edges.values() {
        if node_matches(graph, &e.source, module, &normalized)
            || node_matches(graph, &e.target, module, &normalized)
        {
            match e.coupling_depth { 1=>{l1+=1} 2=>{l2+=1} 3=>{l3+=1} 4=>{l4+=1} _=>{} }
        }
    }
    let total = (l1+l2+l3+l4).max(1) as f64;
    serde_json::json!({
        "module": module, "total_edges": l1+l2+l3+l4,
        "L1": l1, "L2": l2, "L3": l3, "L4": l4,
        "fragility": format!("{:.1}", (l4 as f64*4.0 + l3 as f64*3.0) / total)
    })
}

pub fn coupling_report_from_index(idx: &MemoryIndex, module: &str) -> serde_json::Value {
    let mut l1=0u32; let mut l2=0u32; let mut l3=0u32; let mut l4=0u32;

    // Normalize module path for matching
    let normalized = module.replace('\\', "/");

    // Find nodes belonging to this module
    let mut module_node_ids: Vec<String> = Vec::new();
    // Direct ID match
    if idx.get_node(module).is_some() {
        module_node_ids.push(module.to_string());
    }
    // File path match via file_index
    module_node_ids.extend(idx.get_nodes_by_file(&normalized));

    // ponytail: only traverse edges incident to module nodes — O(degree), not O(E)
    let mut seen = std::collections::HashSet::new();
    for nid in &module_node_ids {
        for (tgt, _, depth, _) in idx.outgoing(nid, None) {
            let key = format!("{}:{}:{}", nid, tgt, depth);
            if seen.insert(key) {
                match depth { 1=>{l1+=1} 2=>{l2+=1} 3=>{l3+=1} 4=>{l4+=1} _=>{} }
            }
        }
        for (src, _, depth, _) in idx.incoming(nid, None) {
            let key = format!("{}:{}:{}", src, nid, depth);
            if seen.insert(key) {
                match depth { 1=>{l1+=1} 2=>{l2+=1} 3=>{l3+=1} 4=>{l4+=1} _=>{} }
            }
        }
    }

    let total = (l1+l2+l3+l4).max(1) as f64;
    serde_json::json!({
        "module": module, "total_edges": l1+l2+l3+l4,
        "L1": l1, "L2": l2, "L3": l3, "L4": l4,
        "fragility": format!("{:.1}", (l4 as f64*4.0 + l3 as f64*3.0) / total)
    })
}

/// Count edges with coupling_depth >= 4 — single O(E) pass, no allocations.
/// Used by hologram_blindspots as a cheap alternative to full coupling_report.
pub fn count_l4_from_index(idx: &MemoryIndex) -> usize {
    idx.edges_iter()
        .into_iter()
        .flat_map(|(_, targets)| targets)
        .filter(|(_, _, depth, _)| *depth >= 4)
        .count()
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_coupling_empty_graph() {
        let g = Graph::new();
        let r = coupling_report(&g, "any");
        assert_eq!(r["total_edges"], 0);
        assert_eq!(r["L1"], 0);
        assert_eq!(r["L4"], 0);
    }

    #[test]
    fn test_coupling_all_levels() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "mod_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e1 = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e1.coupling_depth = 1;
        g.add_edge(e1);
        let mut e2 = Edge::new("e2", "a", "b", EdgeKind::Reads);
        e2.coupling_depth = 4;
        g.add_edge(e2);
        let r = coupling_report(&g, "a");
        assert_eq!(r["L1"], 1);
        assert_eq!(r["L4"], 1);
        assert_eq!(r["total_edges"], 2);
    }

    #[test]
    fn test_coupling_filters_by_module() {
        let mut g = Graph::new();
        g.add_node(Node::new("x", "mod_x", NodeKind::Symbol));
        g.add_node(Node::new("y", "mod_y", NodeKind::Symbol));
        let mut e = Edge::new("e1", "x", "y", EdgeKind::Calls);
        e.coupling_depth = 3;
        g.add_edge(e);
        let r = coupling_report(&g, "x");
        assert_eq!(r["L3"], 1);
        let r2 = coupling_report(&g, "z");
        assert_eq!(r2["total_edges"], 0);
    }

    #[test]
    fn test_coupling_target_match() {
        let mut g = Graph::new();
        g.add_node(Node::new("x", "mod_x", NodeKind::Symbol));
        g.add_node(Node::new("y", "mod_y", NodeKind::Symbol));
        let mut e = Edge::new("e1", "x", "y", EdgeKind::Calls);
        e.coupling_depth = 2;
        g.add_edge(e);
        let r = coupling_report(&g, "y");
        assert_eq!(r["L2"], 1);
    }

    #[test]
    fn test_coupling_from_index() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "mod_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e1 = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e1.coupling_depth = 1;
        g.add_edge(e1);
        let mut e2 = Edge::new("e2", "a", "b", EdgeKind::Reads);
        e2.coupling_depth = 4;
        g.add_edge(e2);
        let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
        let r = coupling_report_from_index(&idx, "a");
        assert_eq!(r["L1"], 1);
        assert_eq!(r["L4"], 1);
        assert_eq!(r["total_edges"], 2);
    }
}
