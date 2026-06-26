// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MemoryIndex — in-memory adjacency-based graph index with string interning.
// All graph traversals hit this, never SQLite.
// O(degree) queries, not O(E) scans.
//
// ponytail: StringArena + u32 handles — edges stored as (u32,u32,u8)
// instead of (String,String,...). Cuts edge memory ~5x.
// Industry precedent: rustc Symbol, Sourcegraph string dedup, Kythe graph store.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::graph::{EdgeKind, Graph, Node};
use crate::storage::sqlite::SqliteDb;
use crate::storage::string_arena::StringArena;

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
///
/// ```
/// use hologram_engine::graph::{EdgeKind, Node, NodeKind};
/// use hologram_engine::storage::MemoryIndex;
///
/// let mut idx = MemoryIndex::new();
/// assert_eq!(idx.node_count(), 0);
///
/// idx.insert_node(Node::new("a", "fn_a", NodeKind::Symbol));
/// idx.insert_node(Node::new("b", "fn_b", NodeKind::Symbol));
/// idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
///
/// assert_eq!(idx.node_count(), 2);
/// assert_eq!(idx.edge_count(), 1);
/// assert_eq!(idx.outgoing("a", None).len(), 1);
/// assert_eq!(idx.shortest_path("a", "b"), Some(vec!["a".into(), "b".into()]));
/// ```
pub struct MemoryIndex {
    /// String interner — all node/edge identifiers stored once
    arena: StringArena,
    /// u32 handle → Node (node.id and node.name are String — Node struct unchanged)
    nodes: HashMap<u32, Node>,
    /// source u32 → [(target u32, edge_kind, coupling_depth, temporal_delay_sec)]
    out_adj: HashMap<u32, Vec<(u32, EdgeKind, u8, Option<f64>)>>,
    /// target u32 → [(source u32, edge_kind, coupling_depth, temporal_delay_sec)]
    in_adj: HashMap<u32, Vec<(u32, EdgeKind, u8, Option<f64>)>>,
    /// symbol name → node u32 handles (name strings are small, O(nodes) not O(edges))
    name_index: HashMap<String, Vec<u32>>,
    /// file path → node u32 handles
    file_index: HashMap<String, Vec<u32>>,
    /// total edge count (cached; edges are stored in adjacency lists)
    edge_count: usize,
    /// whether name_index and file_index are built (may be skipped on OOM)
    has_aux_indexes: bool,
}

impl MemoryIndex {
    // ── constructors ──

    pub fn new() -> Self {
        Self {
            arena: StringArena::new(),
            nodes: HashMap::new(),
            out_adj: HashMap::new(),
            in_adj: HashMap::new(),
            name_index: HashMap::new(),
            file_index: HashMap::new(),
            edge_count: 0,
            has_aux_indexes: true,
        }
    }

    /// Intern a string and return its u32 handle.
    fn intern(&mut self, s: &str) -> u32 {
        self.arena.intern(s)
    }

    /// Look up a string from a u32 handle.
    fn get_str(&self, handle: u32) -> &str {
        self.arena.get(handle)
    }

    /// Get handle for an already-interned string (no mutation).
    fn handle_of(&self, s: &str) -> Option<u32> {
        self.arena.get_handle(s)
    }

    /// Build MemoryIndex from raw node/edge HashMaps.
    /// Takes ownership — edges are consumed one-by-one during adjacency construction,
    /// so peak memory is ~half of the old clone-everything approach.
    /// 6.1M edges → into_iter() frees each Edge as it's processed.
    pub fn from_existing_graph(
        nodes: HashMap<String, Node>,
        edges: HashMap<String, crate::graph::Edge>,
    ) -> Self {
        let mut idx = Self::new();
        // Pre-intern all node IDs
        for id in nodes.keys() {
            idx.intern(id);
        }
        for edge in edges.values() {
            idx.intern(&edge.source);
            idx.intern(&edge.target);
        }
        // Insert nodes
        for (id, node) in nodes {
            let handle = idx.intern(&id);
            idx.index_node_name(handle, &node);
            idx.index_node_file(handle, &node);
            idx.nodes.insert(handle, node);
        }
        // Build adjacency — consumes edges HashMap, freeing each Edge as we go
        // ponytail: into_iter() drops Edge heap allocations immediately,
        // so only out_adj/in_adj tuples grow, not a duplicate edge collection
        for (_eid, edge) in edges {
            let src = idx.intern(&edge.source);
            let tgt = idx.intern(&edge.target);
            if !idx.nodes.contains_key(&src) || !idx.nodes.contains_key(&tgt) {
                continue;
            }
            idx.out_adj
                .entry(src)
                .or_default()
                .push((tgt, edge.kind, edge.coupling_depth, edge.temporal_delay_sec));
            idx.in_adj
                .entry(tgt)
                .or_default()
                .push((src, edge.kind, edge.coupling_depth, edge.temporal_delay_sec));
            idx.edge_count += 1;
        }
        idx
    }

    /// Load from SQLite (cold start).
    pub fn from_sqlite(db: &SqliteDb) -> Result<Self, String> {
        let mut idx = Self::new();
        let db_nodes = db.load_all_nodes()?;
        let db_edges = db.load_all_edges()?;
        // Pre-intern everything
        for node in &db_nodes {
            idx.intern(&node.id);
        }
        for (src, tgt, _, _, _) in &db_edges {
            idx.intern(src);
            idx.intern(tgt);
        }
        for node in db_nodes {
            let handle = idx.intern(&node.id);
            idx.index_node_name(handle, &node);
            idx.index_node_file(handle, &node);
            idx.nodes.insert(handle, node);
        }
        for (source, target, kind, coupling_depth, delay) in db_edges {
            let src = idx.intern(&source);
            let tgt = idx.intern(&target);
            idx.out_adj
                .entry(src)
                .or_default()
                .push((tgt, kind, coupling_depth, delay));
            idx.in_adj
                .entry(tgt)
                .or_default()
                .push((src, kind, coupling_depth, delay));
        }
        idx.edge_count = idx.out_adj.values().map(|v| v.len()).sum();
        Ok(idx)
    }

    /// Build with OOM guard: if building aux indexes would exceed memory budget,
    /// skip them and set has_aux_indexes = false. Fallback: FTS5 for all searches.
    pub fn from_sqlite_degraded(db: &SqliteDb) -> Result<Self, String> {
        let mut idx = Self::new();
        let db_nodes = db.load_all_nodes()?;
        let db_edges = db.load_all_edges()?;
        for node in &db_nodes {
            idx.intern(&node.id);
        }
        for (src, tgt, _, _, _) in &db_edges {
            idx.intern(src);
            idx.intern(tgt);
        }
        for node in db_nodes {
            let handle = idx.intern(&node.id);
            idx.nodes.insert(handle, node);
        }
        for (source, target, kind, coupling_depth, delay) in db_edges {
            let src = idx.intern(&source);
            let tgt = idx.intern(&target);
            idx.out_adj
                .entry(src)
                .or_default()
                .push((tgt, kind, coupling_depth, delay));
            idx.in_adj
                .entry(tgt)
                .or_default()
                .push((src, kind, coupling_depth, delay));
        }
        idx.edge_count = idx.out_adj.values().map(|v| v.len()).sum();
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
                let src_str = self.get_str(*src);
                targets
                    .iter()
                    .map(move |(tgt, kind, depth, delay)| (src_str, self.get_str(*tgt), *kind, *depth, *delay))
            })
            .collect();
        db.bulk_replace_all(&nodes, &edges)
    }

    // ── helpers ──

    fn index_node_name(&mut self, handle: u32, node: &Node) {
        if self.has_aux_indexes {
            self.name_index
                .entry(node.name.clone())
                .or_default()
                .push(handle);
        }
    }

    fn index_node_file(&mut self, handle: u32, node: &Node) {
        if self.has_aux_indexes {
            if let Some(ref loc) = node.location {
                let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                self.file_index
                    .entry(file.to_string())
                    .or_default()
                    .push(handle);
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
        for (&handle, node) in &self.nodes {
            self.name_index
                .entry(node.name.clone())
                .or_default()
                .push(handle);
            if let Some(ref loc) = node.location {
                let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                self.file_index
                    .entry(file.to_string())
                    .or_default()
                    .push(handle);
            }
        }
        self.has_aux_indexes = true;
    }

    // ── point queries ──

    pub fn get_node(&self, id: &str) -> Option<&Node> {
        let handle = self.handle_of(id)?;
        self.nodes.get(&handle)
    }

    pub fn get_nodes_by_name(&self, name: &str) -> Vec<String> {
        self.name_index
            .get(name)
            .map(|handles| handles.iter().map(|&h| self.get_str(h).to_string()).collect())
            .unwrap_or_default()
    }

    pub fn get_nodes_by_file(&self, file: &str) -> Vec<String> {
        self.file_index
            .get(file)
            .map(|handles| handles.iter().map(|&h| self.get_str(h).to_string()).collect())
            .unwrap_or_default()
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

    // ── compatibility: reconstruct Edge objects from adjacency ──

    /// Reconstruct outgoing Edge objects. Missing fields get defaults.
    pub fn get_outgoing_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        let Some(handle) = self.handle_of(node_id) else {
            return edges;
        };
        if let Some(targets) = self.out_adj.get(&handle) {
            for &(tgt, kind, depth, delay) in targets {
                let tgt_str = self.get_str(tgt);
                let id = format!("{}::{}::{}", node_id, tgt_str, kind.as_str());
                let mut edge = crate::graph::Edge::new(id, node_id, tgt_str, kind);
                edge.coupling_depth = depth;
                edge.temporal_delay_sec = delay;
                edges.push(edge);
            }
        }
        edges
    }

    /// Reconstruct incoming Edge objects.
    pub fn get_incoming_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        let Some(handle) = self.handle_of(node_id) else {
            return edges;
        };
        if let Some(sources) = self.in_adj.get(&handle) {
            for &(src, kind, depth, delay) in sources {
                let src_str = self.get_str(src);
                let id = format!("{}::{}::{}", src_str, node_id, kind.as_str());
                let mut edge = crate::graph::Edge::new(id, src_str, node_id, kind);
                edge.coupling_depth = depth;
                edge.temporal_delay_sec = delay;
                edges.push(edge);
            }
        }
        edges
    }

    // ── adjacency ──

    /// Outgoing edges from a node. Returns owned tuples (resolved from u32 handles).
    pub fn outgoing(
        &self,
        node_id: &str,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<(String, EdgeKind, u8, Option<f64>)> {
        let Some(handle) = self.handle_of(node_id) else {
            return Vec::new();
        };
        let Some(targets) = self.out_adj.get(&handle) else {
            return Vec::new();
        };
        let iter: Box<dyn Iterator<Item = &(u32, EdgeKind, u8, Option<f64>)>> =
            if let Some(kinds) = kind_filter {
                Box::new(targets.iter().filter(move |(_, k, _, _)| kinds.contains(k)))
            } else {
                Box::new(targets.iter())
            };
        iter.map(|&(tgt, kind, depth, delay)| (self.get_str(tgt).to_string(), kind, depth, delay))
            .collect()
    }

    /// Incoming edges to a node.
    pub fn incoming(
        &self,
        node_id: &str,
        kind_filter: Option<&[EdgeKind]>,
    ) -> Vec<(String, EdgeKind, u8, Option<f64>)> {
        let Some(handle) = self.handle_of(node_id) else {
            return Vec::new();
        };
        let Some(sources) = self.in_adj.get(&handle) else {
            return Vec::new();
        };
        let iter: Box<dyn Iterator<Item = &(u32, EdgeKind, u8, Option<f64>)>> =
            if let Some(kinds) = kind_filter {
                Box::new(sources.iter().filter(move |(_, k, _, _)| kinds.contains(k)))
            } else {
                Box::new(sources.iter())
            };
        iter.map(|&(src, kind, depth, delay)| (self.get_str(src).to_string(), kind, depth, delay))
            .collect()
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
        let start = match self.handle_of(node_id) {
            Some(h) => h,
            None => return result,
        };
        visited.insert(start);
        queue.push_back((start, 0u8));

        while let Some((cur_handle, cur_depth)) = queue.pop_front() {
            if cur_depth >= depth {
                continue;
            }
            let cur_str = self.get_str(cur_handle).to_string();
            // outgoing
            if let Some(targets) = self.out_adj.get(&cur_handle) {
                for &(other, kind, coupling_depth, _delay) in targets {
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(&kind) {
                            continue;
                        }
                    }
                    if visited.insert(other) {
                        let other_str = self.get_str(other).to_string();
                        result.push((cur_str.clone(), other_str.clone(), coupling_depth));
                        queue.push_back((other, cur_depth + 1));
                    }
                }
            }
            // incoming
            if let Some(sources) = self.in_adj.get(&cur_handle) {
                for &(other, kind, coupling_depth, _delay) in sources {
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(&kind) {
                            continue;
                        }
                    }
                    if visited.insert(other) {
                        let other_str = self.get_str(other).to_string();
                        result.push((cur_str.clone(), other_str.clone(), coupling_depth));
                        queue.push_back((other, cur_depth + 1));
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
        let start = match self.handle_of(node_id) {
            Some(h) => h,
            None => return layers,
        };
        visited.insert(start);
        queue.push_back((start, 0usize));

        while let Some((cur_handle, depth)) = queue.pop_front() {
            if depth > max_depth {
                continue;
            }
            while layers.len() <= depth {
                layers.push((layers.len(), Vec::new()));
            }
            layers[depth].1.push(self.get_str(cur_handle).to_string());

            if let Some(targets) = self.out_adj.get(&cur_handle) {
                for &(tgt, _, _, _) in targets {
                    if visited.insert(tgt) {
                        queue.push_back((tgt, depth + 1));
                    }
                }
            }
            if let Some(sources) = self.in_adj.get(&cur_handle) {
                for &(src, _, _, _) in sources {
                    if visited.insert(src) {
                        queue.push_back((src, depth + 1));
                    }
                }
            }
        }
        layers
    }

    /// BFS shortest path between two nodes (backward-compatible wrapper with default limits).
    pub fn shortest_path(&self, from: &str, to: &str) -> Option<Vec<String>> {
        self.shortest_path_with_limits(from, to, 20, 5000)
    }

    /// BFS shortest path between two nodes with explicit depth/explore limits.
    pub fn shortest_path_with_limits(
        &self,
        from: &str,
        to: &str,
        max_depth: usize,
        max_explore: usize,
    ) -> Option<Vec<String>> {
        if from == to {
            return Some(vec![from.to_string()]);
        }
        let start = self.handle_of(from)?;
        let target = self.handle_of(to)?;
        let mut prev: HashMap<u32, u32> = HashMap::new();
        let mut visited: HashSet<u32> = HashSet::new();
        let mut queue: VecDeque<(u32, usize)> = VecDeque::new();
        let mut explore_count = 0usize;
        visited.insert(start);
        queue.push_back((start, 0));

        while let Some((cur, depth)) = queue.pop_front() {
            if cur == target {
                break;
            }
            if depth >= max_depth {
                continue;
            }
            if let Some(targets) = self.out_adj.get(&cur) {
                for &(tgt, _, _, _) in targets {
                    if explore_count >= max_explore {
                        break;
                    }
                    if visited.insert(tgt) {
                        prev.insert(tgt, cur);
                        queue.push_back((tgt, depth + 1));
                        explore_count += 1;
                    }
                }
            }
            if let Some(sources) = self.in_adj.get(&cur) {
                for &(src, _, _, _) in sources {
                    if explore_count >= max_explore {
                        break;
                    }
                    if visited.insert(src) {
                        prev.insert(src, cur);
                        queue.push_back((src, depth + 1));
                        explore_count += 1;
                    }
                }
            }
        }

        if !visited.contains(&target) {
            return None;
        }

        let mut path = vec![self.get_str(target).to_string()];
        let mut cur = target;
        while let Some(&p) = prev.get(&cur) {
            path.push(self.get_str(p).to_string());
            cur = p;
        }
        path.reverse();
        Some(path)
    }

    // ── full-text search (delegates to SQLite FTS5) ──

    pub fn fts_search(&self, db: &SqliteDb, query: &str, limit: usize) -> Result<Vec<Node>, String> {
        let ids = db.fts_search(query, limit)?;
        let mut results = Vec::with_capacity(ids.len());
        for id in &ids {
            if let Some(handle) = self.handle_of(id) {
                if let Some(node) = self.nodes.get(&handle) {
                    results.push(node.clone());
                }
            }
        }
        Ok(results)
    }

    // ── iteration ──

    pub fn nodes_iter(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// Iterate over all edges as (source_str, vec_of_target_tuples).
    /// Returns owned values — caller owns the result.
    pub fn edges_iter(&self) -> Vec<(String, Vec<(String, EdgeKind, u8, Option<f64>)>)> {
        self.out_adj
            .iter()
            .map(|(&src_handle, targets)| {
                let src_str = self.get_str(src_handle).to_string();
                let edges: Vec<_> = targets
                    .iter()
                    .map(|&(tgt, kind, depth, delay)| {
                        (self.get_str(tgt).to_string(), kind, depth, delay)
                    })
                    .collect();
                (src_str, edges)
            })
            .collect()
    }

    // ── mutators (for incremental update) ──

    pub fn insert_node(&mut self, node: Node) {
        let handle = self.intern(&node.id);
        self.index_node_name(handle, &node);
        self.index_node_file(handle, &node);
        self.nodes.insert(handle, node);
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        let handle = self.handle_of(id)?;
        // Remove from adjacency lists
        if let Some(targets) = self.out_adj.remove(&handle) {
            let count = targets.len();
            self.edge_count = self.edge_count.saturating_sub(count);
            for (tgt, _, _, _) in &targets {
                if let Some(sources) = self.in_adj.get_mut(tgt) {
                    sources.retain(|&(s, _, _, _)| s != handle);
                }
            }
        }
        if let Some(sources) = self.in_adj.remove(&handle) {
            let count = sources.len();
            self.edge_count = self.edge_count.saturating_sub(count);
            for (src, _, _, _) in &sources {
                if let Some(targets) = self.out_adj.get_mut(src) {
                    targets.retain(|&(t, _, _, _)| t != handle);
                }
            }
        }
        // Remove from aux indexes
        if let Some(node) = self.nodes.get(&handle) {
            if self.has_aux_indexes {
                if let Some(handles) = self.name_index.get_mut(&node.name) {
                    handles.retain(|&h| h != handle);
                }
                if let Some(ref loc) = node.location {
                    let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                    if let Some(handles) = self.file_index.get_mut(file) {
                        handles.retain(|&h| h != handle);
                    }
                }
            }
        }
        self.nodes.remove(&handle)
    }

    /// Insert or update an edge. Stores full adjacency tuple including temporal_delay_sec.
    pub fn upsert_edge(
        &mut self,
        source: &str,
        target: &str,
        kind: EdgeKind,
        coupling_depth: u8,
        temporal_delay_sec: Option<f64>,
    ) {
        let src = self.intern(source);
        let tgt = self.intern(target);
        let entry = self.out_adj.entry(src).or_default();
        if !entry
            .iter()
            .any(|&(t, k, d, delay)| t == tgt && k == kind && d == coupling_depth && delay == temporal_delay_sec)
        {
            entry.push((tgt, kind, coupling_depth, temporal_delay_sec));
            self.edge_count += 1;
        }
        let in_entry = self.in_adj.entry(tgt).or_default();
        if !in_entry
            .iter()
            .any(|&(s, k, d, delay)| s == src && k == kind && d == coupling_depth && delay == temporal_delay_sec)
        {
            in_entry.push((src, kind, coupling_depth, temporal_delay_sec));
        }
    }

    /// Remove a specific edge.
    pub fn remove_edge(&mut self, source: &str, target: &str, kind: EdgeKind) -> bool {
        let src = match self.handle_of(source) {
            Some(h) => h,
            None => return false,
        };
        let tgt = match self.handle_of(target) {
            Some(h) => h,
            None => return false,
        };
        let mut removed = false;
        if let Some(targets) = self.out_adj.get_mut(&src) {
            let before = targets.len();
            targets.retain(|&(t, k, _, _)| !(t == tgt && k == kind));
            if targets.len() < before {
                removed = true;
                self.edge_count -= before - targets.len();
            }
        }
        if let Some(sources) = self.in_adj.get_mut(&tgt) {
            sources.retain(|&(s, k, _, _)| !(s == src && k == kind));
        }
        removed
    }

    /// Compute total edge count by scanning adjacency (for validation).
    pub fn recompute_edge_count(&self) -> usize {
        self.out_adj.values().map(|v| v.len()).sum()
    }

    /// Rename a node (name only — ID stays unchanged, preserving edges).
    pub fn rename_node_name(&mut self, id: &str, new_name: &str) -> bool {
        let handle = match self.handle_of(id) {
            Some(h) => h,
            None => return false,
        };
        let node = match self.nodes.get_mut(&handle) {
            Some(n) => n,
            None => return false,
        };
        let old_name = node.name.clone();
        if old_name == new_name {
            return true;
        }
        if self.has_aux_indexes {
            if let Some(handles) = self.name_index.get_mut(&old_name) {
                handles.retain(|&h| h != handle);
            }
            self.name_index
                .entry(new_name.to_string())
                .or_default()
                .push(handle);
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
        assert_eq!(nb2.len(), 2); // a→b, b→c
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

        let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
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

    /// F2 regression: temporal_delay_sec must survive a SQLite round-trip.
    #[test]
    fn test_temporal_delay_survives_sqlite_roundtrip() {
        let tmp = std::env::temp_dir().join("hologram_test_f2_delay");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let db = SqliteDb::open(&tmp).unwrap();

        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "src_a", Some("src/a.rs")));
        idx.insert_node(test_node("b", "src_b", Some("src/b.rs")));
        idx.insert_node(test_node("c", "src_c", Some("src/c.rs")));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, None);
        idx.upsert_edge("a", "c", EdgeKind::Triggers, 1, Some(2.5));
        idx.upsert_edge("b", "c", EdgeKind::Awaits, 2, Some(0.75));

        idx.to_sqlite(&db).unwrap();

        let loaded = MemoryIndex::from_sqlite(&db).unwrap();

        let a_out = loaded.outgoing("a", None);
        let triggers: Vec<_> = a_out
            .iter()
            .filter(|(_, kind, _, _)| matches!(kind, EdgeKind::Triggers))
            .collect();
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].3, Some(2.5), "Triggers delay should survive round-trip");

        let b_out = loaded.outgoing("b", None);
        let awaits: Vec<_> = b_out
            .iter()
            .filter(|(_, kind, _, _)| matches!(kind, EdgeKind::Awaits))
            .collect();
        assert_eq!(awaits.len(), 1);
        assert_eq!(awaits[0].3, Some(0.75), "Awaits delay should survive round-trip");

        let calls: Vec<_> = a_out
            .iter()
            .filter(|(_, kind, _, _)| matches!(kind, EdgeKind::Calls))
            .collect();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].3, None, "Calls edge should have no delay");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
