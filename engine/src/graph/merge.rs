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
            let key = node.loc_key();

            // Check global index AND intra-graph dedup
            if self.loc_index.contains_key(&key) || other_seen.contains_key(&key) {
                continue;
            }

            self.loc_index.insert(key, id.clone());
            other_seen.insert(node.loc_key(), id.clone());
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
