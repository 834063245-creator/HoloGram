// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;

use super::Graph;

/// Persistent graph merger with incremental index.
///
/// v3 Python bug: `Graph.merge()` rebuilt the full loc_key index
/// from the ENTIRE growing graph on every per-file merge call.
/// 2500 files × O(V) index rebuild = O(V²) cumulative.
///
/// Fix: keep the index alive across merges, update it incrementally.
/// Each merge is O(|incoming|) instead of O(|existing| + |incoming|).
pub struct GraphMerger {
    graph: Graph,
    /// "location::name::kind" → node ID
    loc_index: HashMap<String, String>,
}

impl GraphMerger {
    pub fn new() -> Self {
        Self {
            graph: Graph::new(),
            loc_index: HashMap::new(),
        }
    }

    /// Merge another graph into the accumulator. O(|other.nodes| + |other.edges|).
    pub fn merge(&mut self, other: Graph) -> usize {
        let mut added = 0;

        // Build internal dedup map for `other` first (sub-graph may have duplicates)
        let mut other_seen: HashMap<String, String> = HashMap::new();

        for (id, node) in other.nodes {
            // When location is None, use node id to avoid merging unrelated nodes
            let key = node.location.as_ref()
                .map(|loc| format!("{}::{}::{}", loc, node.name, node.kind.as_str()))
                .unwrap_or_else(|| format!("{}::{}::{}", node.id, node.name, node.kind.as_str()));

            // Check global index AND intra-graph dedup
            if self.loc_index.contains_key(&key) || other_seen.contains_key(&key) {
                continue;
            }

            self.loc_index.insert(key.clone(), id.clone());
            other_seen.insert(key, id.clone());
            self.graph.add_node(node);
            added += 1;
        }

        // Edges — accept all, resolver will fix cross-file targets later
        for (_, edge) in other.edges {
            self.graph.add_edge(edge);
        }

        added
    }

    /// Consume the merger and return the accumulated graph.
    pub fn into_graph(self) -> Graph {
        self.graph
    }

    /// Get a reference to the accumulated graph.
    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }
}

impl Default for GraphMerger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    fn make_node(id: &str, name: &str, loc: &str, kind: NodeKind) -> Node {
        let mut n = Node::new(id, name, kind);
        n.location = Some(loc.into());
        n
    }

    #[test]
    fn test_new_merger_empty() {
        let m = GraphMerger::new();
        assert_eq!(m.node_count(), 0);
        assert_eq!(m.graph().node_count(), 0);
    }

    #[test]
    fn test_merge_single_graph() {
        let mut merger = GraphMerger::new();
        let mut g = Graph::new();
        g.add_node(make_node("n1", "fn_a", "src/a.rs", NodeKind::Symbol));
        g.add_node(make_node("n2", "fn_b", "src/b.rs", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "n1", "n2", EdgeKind::Calls));

        let added = merger.merge(g);
        assert_eq!(added, 2);
        assert_eq!(merger.node_count(), 2);
        assert_eq!(merger.graph().edge_count(), 1);
    }

    #[test]
    fn test_merge_dedup_by_loc_key() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("n1", "handle", "src/main.rs", NodeKind::Symbol));

        let mut g2 = Graph::new();
        g2.add_node(make_node("n2", "handle", "src/main.rs", NodeKind::Symbol));

        assert_eq!(merger.merge(g1), 1);
        assert_eq!(merger.merge(g2), 0, "duplicate loc+name+kind should be skipped");
        assert_eq!(merger.node_count(), 1);
    }

    #[test]
    fn test_merge_dedup_different_name_same_loc() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("n1", "fn_a", "src/lib.rs", NodeKind::Symbol));

        let mut g2 = Graph::new();
        g2.add_node(make_node("n2", "fn_b", "src/lib.rs", NodeKind::Symbol));

        assert_eq!(merger.merge(g1), 1);
        assert_eq!(merger.merge(g2), 1, "different name => different key");
        assert_eq!(merger.node_count(), 2);
    }

    #[test]
    fn test_merge_dedup_different_kind_same_loc_name() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("n1", "db", "store.rs", NodeKind::Medium));

        let mut g2 = Graph::new();
        g2.add_node(make_node("n2", "db", "store.rs", NodeKind::Symbol));

        assert_eq!(merger.merge(g1), 1);
        assert_eq!(merger.merge(g2), 1, "different kind => different key");
        assert_eq!(merger.node_count(), 2);
    }

    #[test]
    fn test_merge_preserves_edges() {
        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        g1.add_node(make_node("a", "src_a", "src/a.rs", NodeKind::Symbol));
        g1.add_node(make_node("b", "src_b", "src/b.rs", NodeKind::Symbol));
        g1.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));

        let mut g2 = Graph::new();
        g2.add_node(make_node("c", "src_c", "src/c.rs", NodeKind::Symbol));
        g2.add_edge(Edge::new("e2", "c", "a", EdgeKind::Calls));

        merger.merge(g1);
        merger.merge(g2);
        assert_eq!(merger.node_count(), 3);
        assert_eq!(merger.graph().edge_count(), 2);
    }

    #[test]
    fn test_merge_intra_graph_dedup() {
        let mut merger = GraphMerger::new();
        let mut g = Graph::new();
        // Same loc_key twice within one graph
        g.add_node(make_node("n1", "fn", "src/x.rs", NodeKind::Symbol));
        g.add_node(make_node("n2", "fn", "src/x.rs", NodeKind::Symbol));

        let added = merger.merge(g);
        assert_eq!(added, 1, "intra-graph duplicates should be deduplicated");
    }

    #[test]
    fn test_into_graph_consumes() {
        let mut merger = GraphMerger::new();
        let mut g = Graph::new();
        g.add_node(make_node("n1", "fn", "src/x.rs", NodeKind::Symbol));
        merger.merge(g);

        let graph = merger.into_graph();
        assert_eq!(graph.node_count(), 1);
    }

    #[test]
    fn test_merge_empty_graph() {
        let mut merger = GraphMerger::new();
        let added = merger.merge(Graph::new());
        assert_eq!(added, 0);
        assert_eq!(merger.node_count(), 0);
    }
}
