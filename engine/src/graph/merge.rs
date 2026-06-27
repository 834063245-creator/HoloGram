// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use super::{Edge, EdgeKind, Graph, Node};

/// Persistent graph merger with incremental index.
///
/// v3 Python bug: `Graph.merge()` rebuilt the full loc_key index
/// from the ENTIRE growing graph on every per-file merge call.
/// 2500 files × O(V) index rebuild = O(V²) cumulative.
///
/// Fix: keep the index alive across merges, update it incrementally.
/// Each merge is O(|incoming|) instead of O(|existing| + |incoming|).
///
/// v4 edge dedup: `edge_index` mirrors `loc_index` — a persistent
/// (source, target, kind) dedup set that prevents redundant call-site
/// edges from flooding the edge HashMap. Without this, every
/// call_expression in a TS/JS file generates an edge (14K+/file),
/// causing repeated HashMap rehash storms at millions of entries.
pub struct GraphMerger {
    graph: Graph,
    /// "location::name::kind" → node ID
    loc_index: HashMap<String, String>,
    /// "(source, target, edge_kind_discriminant)" — global edge dedup.
    /// ponytail: persists across merge calls, mirrors loc_index pattern.
    /// One edge per unique (source, target, kind) across the entire project.
    edge_index: HashSet<(String, String, u8)>,
}

// ponytail: encode EdgeKind as u8 discriminant for cheap Hash+Eq in the index.
fn edge_kind_id(k: &EdgeKind) -> u8 {
    match k {
        EdgeKind::Imports => 0,
        EdgeKind::Calls => 1,
        EdgeKind::Inherits => 2,
        EdgeKind::Defines => 3,
        EdgeKind::Reads => 4,
        EdgeKind::Writes => 5,
        EdgeKind::Shares => 6,
        EdgeKind::Triggers => 7,
        EdgeKind::Awaits => 8,
        EdgeKind::Sequences => 9,
    }
}

impl GraphMerger {
    pub fn new() -> Self {
        Self {
            graph: Graph::new(),
            loc_index: HashMap::new(),
            edge_index: HashSet::new(),
        }
    }

    pub fn with_capacity(estimated_nodes: usize, estimated_edges: usize) -> Self {
        let mut graph = Graph::new();
        graph.nodes.reserve(estimated_nodes);
        graph.edges.reserve(estimated_edges);
        Self {
            graph,
            loc_index: HashMap::with_capacity(estimated_nodes),
            edge_index: HashSet::with_capacity(estimated_edges),
        }
    }

    /// Insert an edge only if (source, target, kind) hasn't been seen before.
    /// Returns true if the edge was actually added.
    fn add_edge_deduped(&mut self, edge: Edge) -> bool {
        let key = (
            edge.source.clone(),
            edge.target.clone(),
            edge_kind_id(&edge.kind),
        );
        if self.edge_index.insert(key) {
            self.graph.add_edge(edge);
            true
        } else {
            false
        }
    }

    /// Merge another graph into the accumulator. O(|other.nodes| + |other.edges|).
    pub fn merge(&mut self, other: Graph) -> usize {
        let mut added = 0usize;
        let mut seen: HashMap<String, ()> = HashMap::new();

        for (_, node) in other.nodes {
            let key = node_key(&node);
            if seen.contains_key(&key) {
                continue;
            }
            match self.loc_index.entry(key) {
                Entry::Occupied(_) => continue,
                Entry::Vacant(e) => {
                    seen.insert(e.key().clone(), ());
                    e.insert(node.id.clone());
                    self.graph.add_node(node);
                    added += 1;
                }
            }
        }
        for (_, edge) in other.edges {
            self.add_edge_deduped(edge);
        }
        added
    }

    /// Merge directly from slices — avoids intermediate Graph allocation.
    /// ponytail: skips build_file_graph() → saves per-file HashMap alloc/drop.
    pub fn merge_slices(&mut self, nodes: &[Node], edges: &[Edge]) -> usize {
        let mut added = 0usize;
        let mut seen: HashMap<String, ()> = HashMap::with_capacity(nodes.len());

        for node in nodes {
            let key = node_key(node);
            if seen.contains_key(&key) {
                continue;
            }
            match self.loc_index.entry(key) {
                Entry::Occupied(_) => continue,
                Entry::Vacant(e) => {
                    seen.insert(e.key().clone(), ());
                    e.insert(node.id.clone());
                    self.graph.add_node(node.clone());
                    added += 1;
                }
            }
        }
        // ponytail: two-level edge dedup.
        // Level 1 (fast): intra-file dedup with borrowed &str, zero clones.
        //    A React component calling console.log 100× → 99 hits skip here.
        // Level 2 (slow): global persistent index, clones source+target.
        //    Only the 1 unique (src,tgt,kind) per file reaches this level.
        let cap = edges.len().min(5000);
        let mut local_dedup: HashSet<(&str, &str, u8)> = HashSet::with_capacity(cap);
        for edge in edges {
            let ek = edge_kind_id(&edge.kind);
            if !local_dedup.insert((&edge.source, &edge.target, ek)) {
                continue; // intra-file duplicate — skip without cloning
            }
            self.add_edge_deduped(edge.clone());
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

/// Build dedup key: "location::name::kind"
fn node_key(node: &Node) -> String {
    if let Some(loc) = &node.location {
        // ponytail: String::with_capacity avoids format!() realloc churn.
        // Format overhead per-node adds up at 300K+ nodes.
        let cap = loc.len() + node.name.len() + node.kind.as_str().len() + 6;
        let mut key = String::with_capacity(cap);
        key.push_str(loc);
        key.push_str("::");
        key.push_str(&node.name);
        key.push_str("::");
        key.push_str(node.kind.as_str());
        key
    } else {
        // No location — use node id (unique per file)
        let cap = node.id.len() + node.name.len() + node.kind.as_str().len() + 6;
        let mut key = String::with_capacity(cap);
        key.push_str(&node.id);
        key.push_str("::");
        key.push_str(&node.name);
        key.push_str("::");
        key.push_str(node.kind.as_str());
        key
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

    #[test]
    fn test_merge_slices_edge_dedup() {
        // ponytail: verify intra-file (source, target, kind) dedup.
        // Same function calling the same target 3 times → 1 edge, not 3.
        let mut merger = GraphMerger::new();

        // Add source and target nodes so add_edge can update degrees
        let src = Node::new("a.foo", "foo", NodeKind::Function);
        let tgt = Node::new("b.helper", "helper", NodeKind::Function);
        merger.graph.add_node(src);
        merger.graph.add_node(tgt);

        let nodes: Vec<Node> = vec![];
        let edges: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
            Edge::new("call_2", "a.foo", "b.helper", EdgeKind::Calls),  // dup: same (src, tgt, kind)
            Edge::new("call_3", "a.foo", "b.helper", EdgeKind::Calls),  // dup
            Edge::new("call_4", "a.foo", "c.other", EdgeKind::Calls),   // different target
        ];

        merger.merge_slices(&nodes, &edges);
        assert_eq!(merger.graph().edge_count(), 2, "should dedup 3 foo→helper calls into 1, keep foo→other");
    }

    #[test]
    fn test_merge_slices_edge_dedup_different_source() {
        // Different source → different edge, no dedup
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("a.foo", "foo", NodeKind::Function));
        merger.graph.add_node(Node::new("a.bar", "bar", NodeKind::Function));
        merger.graph.add_node(Node::new("b.helper", "helper", NodeKind::Function));

        let nodes: Vec<Node> = vec![];
        let edges: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
            Edge::new("call_2", "a.bar", "b.helper", EdgeKind::Calls),
        ];

        merger.merge_slices(&nodes, &edges);
        assert_eq!(merger.graph().edge_count(), 2, "different sources should NOT be deduped");
    }

    #[test]
    fn test_merge_slices_edge_dedup_different_kind() {
        // Same (source, target) but different kind → no dedup
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("mod", "mod", NodeKind::File));
        merger.graph.add_node(Node::new("fn", "fn", NodeKind::Function));

        let nodes: Vec<Node> = vec![];
        let edges: Vec<Edge> = vec![
            Edge::new("e1", "mod", "fn", EdgeKind::Defines),
            Edge::new("e2", "mod", "fn", EdgeKind::Calls),
        ];

        merger.merge_slices(&nodes, &edges);
        assert_eq!(merger.graph().edge_count(), 2, "different kinds should NOT be deduped");
    }

    #[test]
    fn test_merge_slices_edge_dedup_cross_call() {
        // Global dedup: same (source, target, kind) across TWO merge_slices calls → 1 edge
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("a.foo", "foo", NodeKind::Function));
        merger.graph.add_node(Node::new("b.helper", "helper", NodeKind::Function));

        let nodes1: Vec<Node> = vec![];
        let edges1: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes1, &edges1);
        assert_eq!(merger.graph().edge_count(), 1);

        // Second file (different edge IDs, same semantic edge)
        let nodes2: Vec<Node> = vec![];
        let edges2: Vec<Edge> = vec![
            Edge::new("call_file2_1", "a.foo", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes2, &edges2);
        assert_eq!(merger.graph().edge_count(), 1, "cross-call global dedup: same (src,tgt,kind) should be skipped");
    }

    #[test]
    fn test_merge_slices_edge_dedup_cross_call_different_scope() {
        // Different scope (source) → NOT deduped across calls
        let mut merger = GraphMerger::new();

        merger.graph.add_node(Node::new("a.foo", "foo", NodeKind::Function));
        merger.graph.add_node(Node::new("a.bar", "bar", NodeKind::Function));
        merger.graph.add_node(Node::new("b.helper", "helper", NodeKind::Function));

        let nodes1: Vec<Node> = vec![];
        let edges1: Vec<Edge> = vec![
            Edge::new("call_1", "a.foo", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes1, &edges1);

        let nodes2: Vec<Node> = vec![];
        let edges2: Vec<Edge> = vec![
            Edge::new("call_2", "a.bar", "b.helper", EdgeKind::Calls),
        ];
        merger.merge_slices(&nodes2, &edges2);
        assert_eq!(merger.graph().edge_count(), 2, "different sources across calls should NOT be deduped");
    }
}
