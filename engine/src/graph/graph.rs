use std::collections::HashMap;

use serde::Serialize;

use super::{Edge, Node};

/// The dependency graph — the central data structure.
/// Mirrors the Python `Graph` class, with the O(V×E) bug fixed.
#[derive(Debug, Clone, Serialize)]
pub struct Graph {
    #[serde(default)]
    pub nodes: HashMap<String, Node>,
    #[serde(default)]
    pub edges: HashMap<String, Edge>,
    #[serde(default)]
    pub meta: serde_json::Value,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            meta: serde_json::Value::Object(Default::default()),
        }
    }

    /// Load a Graph from a Python-format JSON file (nodes/edges as arrays).
    pub fn from_json_file(path: &str) -> Result<Self, String> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Cannot read {}: {}", path, e))?;
        let val: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;

        let mut g = Graph::new();
        if let Some(meta) = val.get("meta") {
            g.meta = meta.clone();
        }
        if let Some(nodes) = val.get("nodes").and_then(|v| v.as_array()) {
            for n in nodes {
                if let Ok(node) = serde_json::from_value::<Node>(n.clone()) {
                    g.nodes.insert(node.id.clone(), node);
                }
            }
        }
        if let Some(edges) = val.get("edges").and_then(|v| v.as_array()) {
            for e in edges {
                if let Ok(edge) = serde_json::from_value::<Edge>(e.clone()) {
                    g.edges.insert(edge.id.clone(), edge);
                }
            }
        }
        Ok(g)
    }

    // ── Node operations ──

    pub fn add_node(&mut self, node: Node) {
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn get_node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        let edge_ids: Vec<String> = self
            .edges
            .iter()
            .filter(|(_, e)| e.source == id || e.target == id)
            .map(|(k, _)| k.clone())
            .collect();
        for eid in edge_ids {
            self.edges.remove(&eid);
        }
        self.nodes.remove(id)
    }

    // ── Edge operations ──

    pub fn add_edge(&mut self, edge: Edge) {
        if let Some(src) = self.nodes.get_mut(&edge.source) {
            src.out_degree += 1;
        }
        if let Some(tgt) = self.nodes.get_mut(&edge.target) {
            tgt.in_degree += 1;
        }
        self.edges.insert(edge.id.clone(), edge);
    }

    pub fn get_edge(&self, id: &str) -> Option<&Edge> {
        self.edges.get(id)
    }

    pub fn outgoing_edges(&self, node_id: &str) -> Vec<&Edge> {
        self.edges
            .values()
            .filter(|e| e.source == node_id)
            .collect()
    }

    pub fn incoming_edges(&self, node_id: &str) -> Vec<&Edge> {
        self.edges
            .values()
            .filter(|e| e.target == node_id)
            .collect()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct GraphDiff {
    pub added_nodes: Vec<Node>,
    pub removed_nodes: Vec<Node>,
    pub added_edges: Vec<Edge>,
    pub removed_edges: Vec<Edge>,
    pub modified_nodes: Vec<(Node, Node)>,
}

impl Graph {
    pub fn diff(&self, other: &Graph) -> GraphDiff {
        let mut diff = GraphDiff {
            added_nodes: Vec::new(),
            removed_nodes: Vec::new(),
            added_edges: Vec::new(),
            removed_edges: Vec::new(),
            modified_nodes: Vec::new(),
        };
        for (id, node) in &other.nodes {
            if let Some(before) = self.nodes.get(id) {
                if before.name != node.name || before.kind != node.kind {
                    diff.modified_nodes.push((before.clone(), node.clone()));
                }
            } else {
                diff.added_nodes.push(node.clone());
            }
        }
        for (id, node) in &self.nodes {
            if !other.nodes.contains_key(id) {
                diff.removed_nodes.push(node.clone());
            }
        }
        for (id, edge) in &other.edges {
            if !self.edges.contains_key(id) {
                diff.added_edges.push(edge.clone());
            }
        }
        for (id, edge) in &self.edges {
            if !other.edges.contains_key(id) {
                diff.removed_edges.push(edge.clone());
            }
        }
        diff
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_add_node() {
        let mut g = Graph::new();
        g.add_node(Node::new("n1", "main", NodeKind::Symbol));
        assert_eq!(g.node_count(), 1);
        assert!(g.get_node("n1").is_some());
    }

    #[test]
    fn test_add_edge_updates_degree() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));

        assert_eq!(g.get_node("a").unwrap().out_degree, 1);
        assert_eq!(g.get_node("b").unwrap().in_degree, 1);
    }

    #[test]
    fn test_remove_node_cascades_edges() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));

        g.remove_node("a");
        assert_eq!(g.node_count(), 1);
        assert_eq!(g.edge_count(), 0); // edge removed
    }

    #[test]
    fn test_merge_incremental_index() {
        use super::super::merge::GraphMerger;

        let mut merger = GraphMerger::new();

        let mut g1 = Graph::new();
        let mut n1 = Node::new("n1", "handle_request", NodeKind::Symbol);
        n1.location = Some("src/main.py".into());
        g1.add_node(n1);

        let mut g2 = Graph::new();
        let mut n1_dup = Node::new("n1_dup", "handle_request", NodeKind::Symbol);
        n1_dup.location = Some("src/main.py".into());
        g2.add_node(n1_dup);

        merger.merge(g1);
        assert_eq!(merger.node_count(), 1);
        merger.merge(g2);
        assert_eq!(merger.node_count(), 1, "duplicate should be skipped");
    }

    #[test]
    fn test_diff_detects_additions() {
        let mut before = Graph::new();
        before.add_node(Node::new("a", "old_fn", NodeKind::Symbol));

        let mut after = before.clone();
        after.add_node(Node::new("b", "new_fn", NodeKind::Symbol));

        let diff = before.diff(&after);
        assert_eq!(diff.added_nodes.len(), 1);
        assert_eq!(diff.added_nodes[0].id, "b");
    }
}
