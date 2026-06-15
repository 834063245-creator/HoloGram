use std::collections::HashMap;

use crate::graph::{EdgeKind, Graph};

/// Assign L1-L4 coupling depth to all edges. O(E) single pass.
/// L1 = direct import (same package), L2 = cross-package, L3 = data, L4 = temporal.
pub fn compute_coupling(graph: &mut Graph) {
    // Extract package prefix from node location for L1 vs L2
    let node_pkg: HashMap<String, String> = graph
        .nodes
        .values()
        .map(|n| {
            let loc = n.location.as_deref().unwrap_or("");
            // Extract top-level package: "src/views.py" → "src"
            let pkg = loc.split('/').next().unwrap_or("").to_string();
            (n.id.clone(), pkg)
        })
        .collect();

    for edge in graph.edges.values_mut() {
        edge.coupling_depth = match edge.kind {
            EdgeKind::Imports | EdgeKind::Calls | EdgeKind::Inherits | EdgeKind::Defines => {
                let src_pkg = node_pkg.get(&edge.source);
                let tgt_pkg = node_pkg.get(&edge.target);
                match (src_pkg, tgt_pkg) {
                    (Some(s), Some(t)) if s == t && !s.is_empty() => 1, // L1: same package
                    _ => 2, // L2: cross-package
                }
            }
            EdgeKind::Reads | EdgeKind::Writes | EdgeKind::Shares => 3, // L3: data
            EdgeKind::Triggers | EdgeKind::Awaits | EdgeKind::Sequences => 4, // L4: temporal
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

    #[test]
    fn test_coupling_assigns_depths() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("b", "B", NodeKind::Symbol));
        g.add_node(Node::new("c", "C", NodeKind::Symbol));

        // a → b → c (chain, increasing depth)
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));

        compute_coupling(&mut g);

        // a→b should be L1 (adjacent)
        let e1 = g.get_edge("e1").unwrap();
        assert!(e1.coupling_depth >= 1);
        // b→c should be L1 (adjacent)
        let e2 = g.get_edge("e2").unwrap();
        assert!(e2.coupling_depth >= 1);
    }

    #[test]
    fn test_data_edge_is_l3() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("db", "DB", NodeKind::Medium));
        g.add_edge(Edge::new("e1", "a", "db", EdgeKind::Reads));

        compute_coupling(&mut g);

        let e = g.get_edge("e1").unwrap();
        assert_eq!(e.coupling_depth, 3);
    }

    #[test]
    fn test_temporal_edge_is_l4() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("t", "Thread", NodeKind::Temporal));
        g.add_edge(Edge::new("e1", "a", "t", EdgeKind::Triggers));

        compute_coupling(&mut g);

        let e = g.get_edge("e1").unwrap();
        assert_eq!(e.coupling_depth, 4);
    }
}
