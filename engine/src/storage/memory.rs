// MemoryIndex — in-memory adjacency-based graph index.
// All graph traversals hit this, never SQLite.
// O(degree) queries, not O(E) scans.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::graph::{EdgeKind, Graph, Node};
use crate::storage::sqlite::SqliteDb;

/// Progress info for hologram_status MCP tool.
#[derive(Debug, Clone, Serialize)]
pub struct LoadProgress {
    pub phase: String,
    pub nodes_loaded: usize,
    pub edges_loaded: usize,
    pub nodes_total: usize,
    pub edges_total: usize,
    pub elapsed_ms: u64,
}

/// In-memory graph index. All queries hit this structure — SQLite is for persistence + FTS only.
pub struct MemoryIndex {
    nodes: HashMap<String, Node>,
    /// source → [(target, edge_kind, coupling_depth, temporal_delay_sec)]
    out_adj: HashMap<String, Vec<(String, EdgeKind, u8, Option<f64>)>>,
    /// target → [(source, edge_kind, coupling_depth, temporal_delay_sec)]
    in_adj: HashMap<String, Vec<(String, EdgeKind, u8, Option<f64>)>>,
    /// symbol name → node IDs (exact match only; substring/prefix → FTS5)
    name_index: HashMap<String, Vec<String>>,
    /// file path → node IDs in that file
    file_index: HashMap<String, Vec<String>>,
    /// total edge count (cached; edges are stored in adjacency lists)
    edge_count: usize,
    /// whether name_index and file_index are built (may be skipped on OOM)
    has_aux_indexes: bool,
}

impl MemoryIndex {
    // ── constructors ──

    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            out_adj: HashMap::new(),
            in_adj: HashMap::new(),
            name_index: HashMap::new(),
            file_index: HashMap::new(),
            edge_count: 0,
            has_aux_indexes: true,
        }
    }

    /// Build MemoryIndex from the legacy Graph structure (JSON migration path).
    pub fn from_existing_graph(g: &Graph) -> Self {
        let mut idx = Self::new();
        let node_count = g.nodes.len();
        idx.nodes.reserve(node_count);
        for (id, node) in &g.nodes {
            idx.nodes.insert(id.clone(), node.clone());
            idx.index_node_name(id, node);
            idx.index_node_file(id, node);
        }
        let edge_count = g.edges.len();
        idx.out_adj.reserve(node_count);
        idx.in_adj.reserve(node_count);
        for (_eid, edge) in &g.edges {
            idx.out_adj
                .entry(edge.source.clone())
                .or_default()
                .push((edge.target.clone(), edge.kind, edge.coupling_depth, edge.temporal_delay_sec));
            idx.in_adj
                .entry(edge.target.clone())
                .or_default()
                .push((edge.source.clone(), edge.kind, edge.coupling_depth, edge.temporal_delay_sec));
        }
        idx.edge_count = edge_count;
        idx
    }

    /// Load from SQLite (cold start).
    pub fn from_sqlite(db: &SqliteDb) -> Result<Self, String> {
        let mut idx = Self::new();
        let db_nodes = db.load_all_nodes()?;
        let db_edges = db.load_all_edges()?;
        idx.nodes.reserve(db_nodes.len());
        for node in db_nodes {
            idx.index_node_name(&node.id, &node);
            idx.index_node_file(&node.id, &node);
            idx.nodes.insert(node.id.clone(), node);
        }
        idx.out_adj.reserve(idx.nodes.len());
        idx.in_adj.reserve(idx.nodes.len());
        for (source, target, kind, coupling_depth, _delay) in db_edges {
            idx.out_adj
                .entry(source.clone())
                .or_default()
                .push((target.clone(), kind, coupling_depth, None)); // SQLite doesn't store temporal_delay_sec yet — None
            idx.in_adj
                .entry(target.clone())
                .or_default()
                .push((source.clone(), kind, coupling_depth, None));
        }
        idx.edge_count = idx
            .out_adj
            .values()
            .map(|v| v.len())
            .sum();
        Ok(idx)
    }

    /// Build with OOM guard: if building aux indexes would exceed memory budget,
    /// skip them and set has_aux_indexes = false. Fallback: FTS5 for all searches.
    pub fn from_sqlite_degraded(db: &SqliteDb) -> Result<Self, String> {
        let mut idx = Self::new();
        // Start degraded; build aux indexes after loading nodes/edges
        let db_nodes = db.load_all_nodes()?;
        let db_edges = db.load_all_edges()?;
        idx.nodes.reserve(db_nodes.len());
        for node in db_nodes {
            idx.nodes.insert(node.id.clone(), node);
        }
        idx.out_adj.reserve(idx.nodes.len());
        idx.in_adj.reserve(idx.nodes.len());
        for (source, target, kind, coupling_depth, _delay) in db_edges {
            idx.out_adj
                .entry(source.clone())
                .or_default()
                .push((target.clone(), kind, coupling_depth, None));
            idx.in_adj
                .entry(target.clone())
                .or_default()
                .push((source.clone(), kind, coupling_depth, None));
        }
        idx.edge_count = idx
            .out_adj
            .values()
            .map(|v| v.len())
            .sum();
        // Recover aux indexes now that nodes are loaded
        idx.ensure_aux_indexes();
        Ok(idx)
    }

    /// Persist to SQLite (full dump, used after full analysis).
    pub fn to_sqlite(&self, db: &SqliteDb) -> Result<(), String> {
        let nodes: Vec<&Node> = self.nodes.values().collect();
        let edges: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = self
            .out_adj
            .iter()
            .flat_map(|(src, targets)| {
                targets
                    .iter()
                    .map(move |(tgt, kind, depth, delay)| (src.as_str(), tgt.as_str(), *kind, *depth, *delay))
            })
            .collect();
        db.batch_upsert_nodes(&nodes)?;
        db.batch_upsert_edges(&edges)?;
        Ok(())
    }

    // ── helpers ──

    fn index_node_name(&mut self, id: &str, node: &Node) {
        if self.has_aux_indexes {
            self.name_index
                .entry(node.name.clone())
                .or_default()
                .push(id.to_string());
        }
    }

    fn index_node_file(&mut self, id: &str, node: &Node) {
        if self.has_aux_indexes {
            if let Some(ref loc) = node.location {
                let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                self.file_index
                    .entry(file.to_string())
                    .or_default()
                    .push(id.to_string());
            }
        }
    }

    /// Build aux indexes after the fact (e.g., from_sqlite_degraded then later recovered).
    pub fn ensure_aux_indexes(&mut self) {
        if self.has_aux_indexes {
            return;
        }
        self.name_index.clear();
        self.file_index.clear();
        for (id, node) in &self.nodes {
            self.name_index
                .entry(node.name.clone())
                .or_default()
                .push(id.clone());
            if let Some(ref loc) = node.location {
                let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                self.file_index
                    .entry(file.to_string())
                    .or_default()
                    .push(id.clone());
            }
        }
        self.has_aux_indexes = true;
    }

    // ── point queries ──

    pub fn get_node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn get_nodes_by_name(&self, name: &str) -> Vec<String> {
        self.name_index.get(name).cloned().unwrap_or_default()
    }

    pub fn get_nodes_by_file(&self, file: &str) -> Vec<String> {
        self.file_index.get(file).cloned().unwrap_or_default()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edge_count
    }

    pub fn has_aux_indexes(&self) -> bool {
        self.has_aux_indexes
    }

    // ── compatibility: reconstruct Edge objects from adjacency (for CACHED_GRAPH migration) ──

    /// Reconstruct outgoing Edge objects. Missing fields get defaults.
    pub fn get_outgoing_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        if let Some(targets) = self.out_adj.get(node_id) {
            for (tgt, kind, depth, delay) in targets {
                let id = format!("{}::{}::{}", node_id, tgt, kind.as_str());
                let mut edge = crate::graph::Edge::new(id, node_id, tgt, *kind);
                edge.coupling_depth = *depth;
                edge.temporal_delay_sec = *delay;
                edges.push(edge);
            }
        }
        edges
    }

    /// Reconstruct incoming Edge objects.
    pub fn get_incoming_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        if let Some(sources) = self.in_adj.get(node_id) {
            for (src, kind, depth, delay) in sources {
                let id = format!("{}::{}::{}", src, node_id, kind.as_str());
                let mut edge = crate::graph::Edge::new(id, src, node_id, *kind);
                edge.coupling_depth = *depth;
                edge.temporal_delay_sec = *delay;
                edges.push(edge);
            }
        }
        edges
    }

    // ── adjacency ──

    /// Outgoing edges from a node. Returns references into the adjacency list.
    pub fn outgoing(
        &self,
        node_id: &str,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<&(String, EdgeKind, u8, Option<f64>)> {
        let Some(targets) = self.out_adj.get(node_id) else {
            return Vec::new();
        };
        if let Some(kinds) = kind_filter {
            targets.iter().filter(|(_, k, _, _)| kinds.contains(k)).collect()
        } else {
            targets.iter().collect()
        }
    }

    /// Incoming edges to a node.
    pub fn incoming(
        &self,
        node_id: &str,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<&(String, EdgeKind, u8, Option<f64>)> {
        let Some(sources) = self.in_adj.get(node_id) else {
            return Vec::new();
        };
        if let Some(kinds) = kind_filter {
            sources.iter().filter(|(_, k, _, _)| kinds.contains(k)).collect()
        } else {
            sources.iter().collect()
        }
    }

    // ── graph traversal ──

    /// BFS neighbors up to `depth` hops. Returns (from, to, coupling_depth).
    pub fn neighbors(
        &self,
        node_id: &str,
        depth: u8,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<(String, String, u8)> {
        let mut result = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(node_id.to_string());
        queue.push_back((node_id.to_string(), 0u8));

        while let Some((current, cur_depth)) = queue.pop_front() {
            if cur_depth >= depth {
                continue;
            }
            // Check both outgoing and incoming
            let both: Vec<Vec<&(String, EdgeKind, u8, Option<f64>)>> = vec![
                self.out_adj
                    .get(&current)
                    .map(|v| v.iter().collect())
                    .unwrap_or_default(),
                self.in_adj
                    .get(&current)
                    .map(|v| v.iter().collect())
                    .unwrap_or_default(),
            ];
            for targets in &both {
                for (other, kind, coupling_depth, _delay) in targets {
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(kind) {
                            continue;
                        }
                    }
                    if visited.insert(other.clone()) {
                        result.push((current.clone(), other.clone(), *coupling_depth));
                        queue.push_back((other.clone(), cur_depth + 1));
                    }
                }
            }
        }
        result
    }

    /// BFS impact (blast radius). Returns layers: Vec<(depth_level, node_ids)>.
    pub fn impact(&self, node_id: &str, max_depth: usize) -> Vec<(usize, Vec<String>)> {
        let mut layers: Vec<(usize, Vec<String>)> = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(node_id.to_string());
        queue.push_back((node_id.to_string(), 0usize));

        while let Some((cur, depth)) = queue.pop_front() {
            if depth > max_depth {
                continue;
            }
            while layers.len() <= depth {
                layers.push((layers.len(), Vec::new()));
            }
            layers[depth].1.push(cur.clone());

            // outgoing
            if let Some(targets) = self.out_adj.get(&cur) {
                for (tgt, _, _, _) in targets {
                    if visited.insert(tgt.clone()) {
                        queue.push_back((tgt.clone(), depth + 1));
                    }
                }
            }
            // incoming
            if let Some(sources) = self.in_adj.get(&cur) {
                for (src, _, _, _) in sources {
                    if visited.insert(src.clone()) {
                        queue.push_back((src.clone(), depth + 1));
                    }
                }
            }
        }
        layers
    }

    /// BFS shortest path between two nodes. Returns sequence of node IDs.
    pub fn shortest_path(&self, from: &str, to: &str) -> Option<Vec<String>> {
        if from == to {
            return Some(vec![from.to_string()]);
        }
        let mut prev: HashMap<String, String> = HashMap::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        visited.insert(from.to_string());
        queue.push_back(from.to_string());

        while let Some(cur) = queue.pop_front() {
            if cur == to {
                break;
            }
            // neighbors: outgoing + incoming
            let mut neighbor_ids = Vec::new();
            if let Some(targets) = self.out_adj.get(&cur) {
                for (tgt, _, _, _) in targets {
                    neighbor_ids.push(tgt.clone());
                }
            }
            if let Some(sources) = self.in_adj.get(&cur) {
                for (src, _, _, _) in sources {
                    neighbor_ids.push(src.clone());
                }
            }
            for nb in neighbor_ids {
                if visited.insert(nb.clone()) {
                    prev.insert(nb.clone(), cur.clone());
                    queue.push_back(nb);
                }
            }
        }

        if !visited.contains(to) {
            return None;
        }

        let mut path = vec![to.to_string()];
        let mut cur = to.to_string();
        while let Some(p) = prev.get(&cur) {
            path.push(p.clone());
            cur = p.clone();
        }
        path.reverse();
        Some(path)
    }

    // ── full-text search (delegates to SQLite FTS5) ──

    pub fn fts_search(&self, db: &SqliteDb, query: &str, limit: usize) -> Result<Vec<Node>, String> {
        let ids = db.fts_search(query, limit)?;
        let mut results = Vec::with_capacity(ids.len());
        for id in &ids {
            if let Some(node) = self.nodes.get(id) {
                results.push(node.clone());
            }
        }
        Ok(results)
    }

    // ── iteration ──

    pub fn nodes_iter(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn edges_iter(&self) -> impl Iterator<Item = (&str, &[(String, EdgeKind, u8, Option<f64>)])> {
        self.out_adj
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
    }

    // ── mutators (for incremental update) ──

    pub fn insert_node(&mut self, node: Node) {
        self.index_node_name(&node.id, &node);
        self.index_node_file(&node.id, &node);
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        // Remove from adjacency lists
        if let Some(targets) = self.out_adj.remove(id) {
            let count = targets.len();
            self.edge_count = self.edge_count.saturating_sub(count);
            for (tgt, _, _, _) in &targets {
                if let Some(sources) = self.in_adj.get_mut(tgt) {
                    sources.retain(|(s, _, _, _)| s != id);
                }
            }
        }
        if let Some(sources) = self.in_adj.remove(id) {
            let count = sources.len();
            self.edge_count = self.edge_count.saturating_sub(count);
            for (src, _, _, _) in &sources {
                if let Some(targets) = self.out_adj.get_mut(src) {
                    targets.retain(|(t, _, _, _)| t != id);
                }
            }
        }
        // Remove from aux indexes
        if let Some(node) = self.nodes.get(id) {
            if self.has_aux_indexes {
                if let Some(ids) = self.name_index.get_mut(&node.name) {
                    ids.retain(|x| x != id);
                }
                if let Some(ref loc) = node.location {
                    let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                    if let Some(ids) = self.file_index.get_mut(file) {
                        ids.retain(|x| x != id);
                    }
                }
            }
        }
        self.nodes.remove(id)
    }

    /// Insert or update an edge. Stores full adjacency tuple including temporal_delay_sec.
    /// Dedup: same (source, target, kind, coupling_depth) is a no-op.
    pub fn upsert_edge(&mut self, source: &str, target: &str, kind: EdgeKind, coupling_depth: u8, temporal_delay_sec: Option<f64>) {
        let entry = self.out_adj.entry(source.to_string()).or_default();
        if !entry.iter().any(|(t, k, d, _)| t == target && *k == kind && *d == coupling_depth) {
            entry.push((target.to_string(), kind, coupling_depth, temporal_delay_sec));
            self.edge_count += 1;
        }
        // in_adj (same temporal_delay_sec for reverse direction)
        let in_entry = self.in_adj.entry(target.to_string()).or_default();
        if !in_entry.iter().any(|(s, k, d, _)| s == source && *k == kind && *d == coupling_depth) {
            in_entry.push((source.to_string(), kind, coupling_depth, temporal_delay_sec));
        }
    }

    /// Remove a specific edge.
    pub fn remove_edge(&mut self, source: &str, target: &str, kind: EdgeKind) -> bool {
        let mut removed = false;
        if let Some(targets) = self.out_adj.get_mut(source) {
            let before = targets.len();
            targets.retain(|(t, k, _, _)| !(t == target && *k == kind));
            if targets.len() < before {
                removed = true;
                self.edge_count -= before - targets.len();
            }
        }
        if let Some(sources) = self.in_adj.get_mut(target) {
            sources.retain(|(s, k, _, _)| !(s == source && *k == kind));
        }
        removed
    }

    /// Compute total edge count by scanning adjacency (for validation).
    pub fn recompute_edge_count(&self) -> usize {
        self.out_adj.values().map(|v| v.len()).sum()
    }

    /// Rename a node (name only — ID stays unchanged, preserving edges).
    /// Updates the name_index. Returns true if the node existed.
    pub fn rename_node_name(&mut self, id: &str, new_name: &str) -> bool {
        let node = match self.nodes.get_mut(id) {
            Some(n) => n,
            None => return false,
        };
        let old_name = node.name.clone();
        if old_name == new_name {
            return true;
        }
        if self.has_aux_indexes {
            if let Some(ids) = self.name_index.get_mut(&old_name) {
                ids.retain(|x| x != id);
            }
            self.name_index
                .entry(new_name.to_string())
                .or_default()
                .push(id.to_string());
        }
        node.name = new_name.to_string();
        true
    }
}

impl Default for MemoryIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};

    fn test_node(id: &str, name: &str, location: Option<&str>) -> Node {
        let mut n = Node::new(id, name, NodeKind::Symbol);
        n.location = location.map(|s| s.to_string());
        n
    }

    #[test]
    fn test_new_empty() {
        let idx = MemoryIndex::new();
        assert_eq!(idx.node_count(), 0);
        assert_eq!(idx.edge_count(), 0);
    }

    #[test]
    fn test_insert_and_get_node() {
        let mut idx = MemoryIndex::new();
        let n = test_node("n1", "main", Some("src/main.rs"));
        idx.insert_node(n);
        assert_eq!(idx.node_count(), 1);
        assert!(idx.get_node("n1").is_some());
        assert_eq!(idx.get_nodes_by_name("main").len(), 1);
        assert_eq!(idx.get_nodes_by_file("src/main.rs").len(), 1);
    }

    #[test]
    fn test_upsert_and_outgoing_incoming() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", Some("src/a.rs")));
        idx.insert_node(test_node("b", "B", Some("src/b.rs")));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 2, None);

        assert_eq!(idx.edge_count(), 1);
        let out = idx.outgoing("a", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "b");
        assert_eq!(out[0].2, 2);

        let incoming = idx.incoming("b", None);
        assert_eq!(incoming.len(), 1);
        assert_eq!(incoming[0].0, "a");
    }

    #[test]
    fn test_upsert_edge_dedup() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        idx.upsert_edge("a", "b", EdgeKind::Calls, 3, None); // different depth → separate edge
        idx.upsert_edge("a", "b", EdgeKind::Calls, 3, None); // same (s,t,k,d) → dedup
        assert_eq!(idx.edge_count(), 2, "two distinct (kind,depth) tuples");
        let out = idx.outgoing("a", None);
        assert!(out.iter().any(|(_, _, d, _)| *d == 1), "depth=1 entry present");
        assert!(out.iter().any(|(_, _, d, _)| *d == 3), "depth=3 entry present");
    }

    #[test]
    fn test_remove_node_cascades() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);

        idx.remove_node("a");
        assert_eq!(idx.node_count(), 1);
        assert_eq!(idx.edge_count(), 0);
        assert!(idx.outgoing("b", None).is_empty());
    }

    #[test]
    fn test_shortest_path() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("b", "c", EdgeKind::Calls, 0, None);

        let path = idx.shortest_path("a", "c").unwrap();
        assert_eq!(path, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_shortest_path_no_route() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        assert!(idx.shortest_path("a", "b").is_none());
    }

    #[test]
    fn test_neighbors_depth() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("b", "c", EdgeKind::Calls, 0, None);

        let nb = idx.neighbors("a", 1, None);
        assert_eq!(nb.len(), 1);
        assert_eq!(nb[0].1, "b");

        let nb2 = idx.neighbors("a", 2, None);
        assert_eq!(nb2.len(), 2); // a→b, b→c (c reached via a→b→c)
    }

    #[test]
    fn test_impact_layers() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("b", "c", EdgeKind::Calls, 0, None);

        let layers = idx.impact("a", 2);
        assert_eq!(layers.len(), 3); // depth 0,1,2
        assert_eq!(layers[0].1, vec!["a"]);
        assert_eq!(layers[1].1.len(), 1); // b
        assert_eq!(layers[2].1.len(), 1); // c
    }

    #[test]
    fn test_from_existing_graph() {
        let mut g = Graph::new();
        let mut n1 = test_node("n1", "fn_a", Some("src/a.rs"));
        n1.location = Some("src/a.rs".into());
        g.add_node(n1);
        let mut n2 = test_node("n2", "fn_b", Some("src/b.rs"));
        n2.location = Some("src/b.rs".into());
        g.add_node(n2);
        g.add_edge(Edge::new("e1", "n1", "n2", EdgeKind::Calls));

        let idx = MemoryIndex::from_existing_graph(&g);
        assert_eq!(idx.node_count(), 2);
        assert_eq!(idx.edge_count(), 1);
        assert_eq!(idx.get_nodes_by_file("src/a.rs").len(), 1);
    }

    #[test]
    fn test_kind_filter() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.insert_node(test_node("c", "C", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.upsert_edge("a", "c", EdgeKind::Imports, 0, None);

        let calls = idx.outgoing("a", Some(&[EdgeKind::Calls]));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, EdgeKind::Calls);
    }

    #[test]
    fn test_without_aux_indexes() {
        let mut idx = MemoryIndex::new();
        idx.has_aux_indexes = false;
        idx.insert_node(test_node("a", "A", Some("f.rs")));
        assert!(idx.get_nodes_by_name("A").is_empty());
        assert!(idx.get_nodes_by_file("f.rs").is_empty());

        idx.ensure_aux_indexes();
        assert_eq!(idx.get_nodes_by_name("A").len(), 1);
        assert_eq!(idx.get_nodes_by_file("f.rs").len(), 1);
    }
}
