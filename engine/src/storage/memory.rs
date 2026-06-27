// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MemoryIndex — in-memory adjacency-based graph index with string interning.
// All graph traversals hit this, never SQLite.
// O(degree) queries, not O(E) scans.
//
// ponytail: CSR flat arrays (offsets + targets + kinds + coupling + delays)
// instead of HashMap<u32, Vec<(u32,EdgeKind,u8,Option<f64>)>>.
// ~1.54M per-node Vec allocations → 6 total (3 in + 3 out).
// Industry precedent: rustc Symbol, Sourcegraph string dedup, Kythe graph store.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::graph::{EdgeKind, Node};
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

// ── delay pack/unpack (f64::NAN = None) ──

fn pack_delay(d: Option<f64>) -> f64 { d.unwrap_or(f64::NAN) }
fn unpack_delay(d: f64) -> Option<f64> { if d.is_nan() { None } else { Some(d) } }

/// In-memory graph index. All queries hit this structure — SQLite is for persistence + FTS only.
///
/// CSR layout (Compressed Sparse Row):
///   out_offsets[N+1]  — start position in out_* arrays for each dense node index
///   out_targets[E]    — target node handles (u32)
///   out_kinds[E]      — EdgeKind as u8 (0–9)
///   out_coupling[E]   — coupling_depth (u8)
///   out_delays[E]     — temporal_delay_sec (f64::NAN = None)
///
/// Mutations (upsert_edge/remove_edge/remove_node) buffer into pending_adds/
/// pending_removes. On next read, rebuild_csr() flushes and rebuilds the arrays.
/// ponytail: O(N+E) rebuild on mutation, mutations are rare (incremental diff only).
pub struct MemoryIndex {
    /// String interner — all node/edge identifiers stored once
    arena: StringArena,
    /// u32 handle → Node (node.id and node.name are String — Node struct unchanged)
    nodes: HashMap<u32, Node>,

    // ── dense node index ──
    /// Sorted node handles; index = dense idx (0..N-1)
    node_by_idx: Vec<u32>,
    /// Reverse: node handle → dense idx
    handle_to_idx: HashMap<u32, u32>,

    // ── CSR outgoing edges ──
    out_offsets: Vec<u32>,
    out_targets: Vec<u32>,
    out_kinds: Vec<u8>,
    out_coupling: Vec<u8>,
    out_delays: Vec<f64>,

    // ── CSR incoming edges ──
    in_offsets: Vec<u32>,
    in_targets: Vec<u32>,
    in_kinds: Vec<u8>,
    in_coupling: Vec<u8>,
    in_delays: Vec<f64>,

    // ── mutation buffer ──
    pending_adds: Vec<(u32, u32, EdgeKind, u8, Option<f64>)>,
    pending_removes: HashSet<(u32, u32, EdgeKind)>,

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
    // ── helpers: dense index ──

    fn rebuild_dense_index(&mut self) {
        self.handle_to_idx.clear();
        self.node_by_idx.clear();
        self.node_by_idx.reserve(self.nodes.len());
        let mut handles: Vec<u32> = self.nodes.keys().copied().collect();
        handles.sort_unstable();
        for (i, &h) in handles.iter().enumerate() {
            self.handle_to_idx.insert(h, i as u32);
        }
        self.node_by_idx = handles;
    }

    fn node_idx(&self, handle: u32) -> Option<u32> {
        self.handle_to_idx.get(&handle).copied()
    }

    // ── helpers: edge iteration ──

    /// Iterate outgoing edges for a dense node index. Returns slice indices.
    #[inline]
    fn out_range(&self, idx: u32) -> (usize, usize) {
        let start = self.out_offsets[idx as usize] as usize;
        let end = self.out_offsets[idx as usize + 1] as usize;
        (start, end)
    }

    /// Iterate incoming edges for a dense node index.
    #[inline]
    fn in_range(&self, idx: u32) -> (usize, usize) {
        let start = self.in_offsets[idx as usize] as usize;
        let end = self.in_offsets[idx as usize + 1] as usize;
        (start, end)
    }

    // ── helpers: rebuild CSR from per-node buckets ──

    /// Collect outgoing edges for a node from CSR + pending buffers.
    /// Returns deduplicated (target_handle, kind_u8, coupling, delay_f64).
    fn collect_outgoing(&self, src_handle: u32) -> Vec<(u32, u8, u8, f64)> {
        let mut edges: Vec<(u32, u8, u8, f64)> = Vec::new();
        let mut seen: HashSet<(u32, u8, u8)> = HashSet::new();
        if let Some(idx) = self.node_idx(src_handle) {
            if idx < self.node_by_idx.len() as u32 {
                let (start, end) = self.out_range(idx);
                for i in start..end {
                    let tgt = self.out_targets[i];
                    let kind_u8 = self.out_kinds[i];
                    let ek = EdgeKind::from_u8(kind_u8);
                    if self.pending_removes.contains(&(src_handle, tgt, ek)) {
                        continue;
                    }
                    let key = (tgt, kind_u8, self.out_coupling[i]);
                    if seen.insert(key) {
                        edges.push((tgt, kind_u8, self.out_coupling[i], self.out_delays[i]));
                    }
                }
            }
        }
        for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
            if src != src_handle { continue; }
            if self.pending_removes.contains(&(src, tgt, kind)) { continue; }
            let kind_u8 = kind.to_u8();
            let key = (tgt, kind_u8, coupling);
            if seen.insert(key) {
                edges.push((tgt, kind_u8, coupling, pack_delay(delay)));
            }
        }
        edges
    }

    /// Collect incoming edges for a node from CSR + pending buffers.
    fn collect_incoming(&self, tgt_handle: u32) -> Vec<(u32, u8, u8, f64)> {
        let mut edges: Vec<(u32, u8, u8, f64)> = Vec::new();
        let mut seen: HashSet<(u32, u8, u8)> = HashSet::new();
        if let Some(idx) = self.node_idx(tgt_handle) {
            if idx < self.node_by_idx.len() as u32 {
                let (start, end) = self.in_range(idx);
                for i in start..end {
                    let src = self.in_targets[i];
                    let kind_u8 = self.in_kinds[i];
                    let ek = EdgeKind::from_u8(kind_u8);
                    if self.pending_removes.contains(&(src, tgt_handle, ek)) {
                        continue;
                    }
                    let key = (src, kind_u8, self.in_coupling[i]);
                    if seen.insert(key) {
                        edges.push((src, kind_u8, self.in_coupling[i], self.in_delays[i]));
                    }
                }
            }
        }
        for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
            if tgt != tgt_handle { continue; }
            if self.pending_removes.contains(&(src, tgt, kind)) { continue; }
            let kind_u8 = kind.to_u8();
            let key = (src, kind_u8, coupling);
            if seen.insert(key) {
                edges.push((src, kind_u8, coupling, pack_delay(delay)));
            }
        }
        edges
    }

    /// Check whether a pending-remove edge exists in CSR. Used by remove_edge.
    fn edge_exists_in_csr(&self, src_handle: u32, tgt_handle: u32, kind_u8: u8) -> bool {
        let Some(idx) = self.node_idx(src_handle) else { return false; };
        let (start, end) = self.out_range(idx);
        for i in start..end {
            if self.out_targets[i] == tgt_handle && self.out_kinds[i] == kind_u8 {
                return true;
            }
        }
        false
    }

    /// Flush pending mutations by rebuilding CSR arrays.
    /// Called at the end of incremental update batches.
    pub fn flush_pending(&mut self) {
        if self.pending_adds.is_empty() && self.pending_removes.is_empty() {
            return;
        }
        self.rebuild_csr();
    }

    /// Flatten per-node edge buckets into CSR arrays. Consumes the buckets.
    /// This is called during fresh build (from_existing_graph, from_sqlite)
    /// and on mutation flush.
    fn flatten_buckets(
        &mut self,
        out_buckets: &[Vec<(u32, u8, u8, f64)>],
        in_buckets: &[Vec<(u32, u8, u8, f64)>],
    ) {
        let n = self.node_by_idx.len();

        // Prefix-sum out-degrees → out_offsets
        self.out_offsets = Vec::with_capacity(n + 1);
        self.out_offsets.push(0);
        for bucket in out_buckets {
            let prev = *self.out_offsets.last().unwrap_or(&0);
            self.out_offsets.push(prev + bucket.len() as u32);
        }

        // Flatten out arrays
        let total_out = self.out_offsets[n] as usize;
        self.out_targets = Vec::with_capacity(total_out);
        self.out_kinds = Vec::with_capacity(total_out);
        self.out_coupling = Vec::with_capacity(total_out);
        self.out_delays = Vec::with_capacity(total_out);
        for bucket in out_buckets {
            for &(tgt, kind, coupling, delay) in bucket {
                self.out_targets.push(tgt);
                self.out_kinds.push(kind);
                self.out_coupling.push(coupling);
                self.out_delays.push(delay);
            }
        }

        // Prefix-sum in-degrees → in_offsets
        self.in_offsets = Vec::with_capacity(n + 1);
        self.in_offsets.push(0);
        for bucket in in_buckets {
            let prev = *self.in_offsets.last().unwrap_or(&0);
            self.in_offsets.push(prev + bucket.len() as u32);
        }

        // Flatten in arrays
        let total_in = self.in_offsets[n] as usize;
        self.in_targets = Vec::with_capacity(total_in);
        self.in_kinds = Vec::with_capacity(total_in);
        self.in_coupling = Vec::with_capacity(total_in);
        self.in_delays = Vec::with_capacity(total_in);
        for bucket in in_buckets {
            for &(tgt, kind, coupling, delay) in bucket {
                self.in_targets.push(tgt);
                self.in_kinds.push(kind);
                self.in_coupling.push(coupling);
                self.in_delays.push(delay);
            }
        }

        self.edge_count = total_out;
    }

    /// Rebuild CSR from pending mutations + existing CSR edges.
    /// Uses temporary per-node Vecs for sort+dedup (freed after flatten).
    fn rebuild_csr(&mut self) {
        self.rebuild_dense_index();
        let n = self.node_by_idx.len();

        // temp per-node buckets: Vec<(other_handle, kind_u8, coupling, delay_f64)>
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        // Copy edges from current CSR (skip removed)
        let old_has_data = !self.out_offsets.is_empty() && self.out_offsets.len() > n;
        if old_has_data {
            for src_idx in 0..n {
                let src_handle = self.node_by_idx[src_idx];
                let (start, end) = self.out_range(src_idx as u32);
                for i in start..end {
                    let tgt = self.out_targets[i];
                    let kind_u8 = self.out_kinds[i];
                    let ek = EdgeKind::from_u8(kind_u8);
                    if self.pending_removes.contains(&(src_handle, tgt, ek)) {
                        continue;
                    }
                    out_buckets[src_idx].push((tgt, kind_u8, self.out_coupling[i], self.out_delays[i]));
                    if let Some(&tgt_idx) = self.handle_to_idx.get(&tgt) {
                        in_buckets[tgt_idx as usize].push((src_handle, kind_u8, self.out_coupling[i], self.out_delays[i]));
                    }
                }
            }
        }

        // Add pending edges
        for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
            if self.pending_removes.contains(&(src, tgt, kind)) {
                continue;
            }
            let kind_u8 = kind.to_u8();
            let delay_f64 = pack_delay(delay);
            if let Some(&src_idx) = self.handle_to_idx.get(&src) {
                if let Some(&tgt_idx) = self.handle_to_idx.get(&tgt) {
                    out_buckets[src_idx as usize].push((tgt, kind_u8, coupling, delay_f64));
                    in_buckets[tgt_idx as usize].push((src, kind_u8, coupling, delay_f64));
                }
            }
        }

        // Sort + dedup each bucket
        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        self.flatten_buckets(&out_buckets, &in_buckets);
        self.pending_adds.clear();
        self.pending_removes.clear();
        self.edge_count = self.out_offsets.last().copied().unwrap_or(0) as usize;
    }

    // ── constructors ──

    pub fn new() -> Self {
        Self {
            arena: StringArena::new(),
            nodes: HashMap::new(),
            node_by_idx: Vec::new(),
            handle_to_idx: HashMap::new(),
            out_offsets: Vec::new(),
            out_targets: Vec::new(),
            out_kinds: Vec::new(),
            out_coupling: Vec::new(),
            out_delays: Vec::new(),
            in_offsets: Vec::new(),
            in_targets: Vec::new(),
            in_kinds: Vec::new(),
            in_coupling: Vec::new(),
            in_delays: Vec::new(),
            pending_adds: Vec::new(),
            pending_removes: HashSet::new(),
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

        // Build per-node buckets (temp — consumed by flatten_buckets)
        idx.rebuild_dense_index();
        let n = idx.node_by_idx.len();
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        for (_eid, edge) in edges {
            let src = idx.intern(&edge.source);
            let tgt = idx.intern(&edge.target);
            if !idx.nodes.contains_key(&src) || !idx.nodes.contains_key(&tgt) {
                continue;
            }
            let kind_u8 = edge.kind.to_u8();
            let delay_f64 = pack_delay(edge.temporal_delay_sec);
            if let (Some(&src_idx), Some(&tgt_idx)) = (idx.handle_to_idx.get(&src), idx.handle_to_idx.get(&tgt)) {
                out_buckets[src_idx as usize].push((tgt, kind_u8, edge.coupling_depth, delay_f64));
                in_buckets[tgt_idx as usize].push((src, kind_u8, edge.coupling_depth, delay_f64));
            }
        }

        // Sort + dedup each bucket
        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        idx.flatten_buckets(&out_buckets, &in_buckets);
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

        // Build CSR via temp buckets
        idx.rebuild_dense_index();
        let n = idx.node_by_idx.len();
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        for (source, target, kind, coupling_depth, delay) in db_edges {
            let src = idx.intern(&source);
            let tgt = idx.intern(&target);
            let kind_u8 = kind.to_u8();
            let delay_f64 = pack_delay(delay);
            if let (Some(&src_idx), Some(&tgt_idx)) = (idx.handle_to_idx.get(&src), idx.handle_to_idx.get(&tgt)) {
                out_buckets[src_idx as usize].push((tgt, kind_u8, coupling_depth, delay_f64));
                in_buckets[tgt_idx as usize].push((src, kind_u8, coupling_depth, delay_f64));
            }
        }

        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        idx.flatten_buckets(&out_buckets, &in_buckets);
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

        // Build CSR via temp buckets (no aux indexes yet)
        idx.rebuild_dense_index();
        let n = idx.node_by_idx.len();
        let mut out_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();
        let mut in_buckets: Vec<Vec<(u32, u8, u8, f64)>> = (0..n).map(|_| Vec::new()).collect();

        for (source, target, kind, coupling_depth, delay) in db_edges {
            let src = idx.intern(&source);
            let tgt = idx.intern(&target);
            let kind_u8 = kind.to_u8();
            let delay_f64 = pack_delay(delay);
            if let (Some(&src_idx), Some(&tgt_idx)) = (idx.handle_to_idx.get(&src), idx.handle_to_idx.get(&tgt)) {
                out_buckets[src_idx as usize].push((tgt, kind_u8, coupling_depth, delay_f64));
                in_buckets[tgt_idx as usize].push((src, kind_u8, coupling_depth, delay_f64));
            }
        }

        for bucket in out_buckets.iter_mut().chain(in_buckets.iter_mut()) {
            bucket.sort_unstable_by_key(|e| (e.0, e.1, e.2));
            bucket.dedup_by_key(|e| (e.0, e.1, e.2));
        }

        idx.flatten_buckets(&out_buckets, &in_buckets);
        idx.ensure_aux_indexes();
        Ok(idx)
    }

    /// Persist to SQLite (full dump, used after full analysis).
    pub fn to_sqlite(&self, db: &SqliteDb) -> Result<(), String> {
        let nodes: Vec<&Node> = self.nodes.values().collect();
        // Collect all edges via helpers (CSR + pending - removed)
        let mut edges: Vec<(&str, &str, EdgeKind, u8, Option<f64>)> = Vec::new();
        let mut seen: HashSet<(String, String, EdgeKind)> = HashSet::new();
        for &src_handle in &self.node_by_idx {
            let src_str = self.get_str(src_handle);
            let raw = self.collect_outgoing(src_handle);
            for &(tgt, kind_u8, coupling, delay) in &raw {
                let tgt_str = self.get_str(tgt);
                let kind = EdgeKind::from_u8(kind_u8);
                let key = (src_str.to_string(), tgt_str.to_string(), kind);
                if seen.insert(key) {
                    edges.push((src_str, tgt_str, kind, coupling, unpack_delay(delay)));
                }
            }
        }
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
        let raw = self.collect_outgoing(handle);
        for &(tgt, kind_u8, coupling, delay) in &raw {
            let tgt_str = self.get_str(tgt);
            let kind = EdgeKind::from_u8(kind_u8);
            let id = format!("{}::{}::{}", node_id, tgt_str, kind.as_str());
            let mut edge = crate::graph::Edge::new(id, node_id, tgt_str, kind);
            edge.coupling_depth = coupling;
            edge.temporal_delay_sec = unpack_delay(delay);
            edges.push(edge);
        }
        edges
    }

    /// Reconstruct incoming Edge objects.
    pub fn get_incoming_edges(&self, node_id: &str) -> Vec<crate::graph::Edge> {
        let mut edges = Vec::new();
        let Some(handle) = self.handle_of(node_id) else {
            return edges;
        };
        let raw = self.collect_incoming(handle);
        for &(src, kind_u8, coupling, delay) in &raw {
            let src_str = self.get_str(src);
            let kind = EdgeKind::from_u8(kind_u8);
            let id = format!("{}::{}::{}", src_str, node_id, kind.as_str());
            let mut edge = crate::graph::Edge::new(id, src_str, node_id, kind);
            edge.coupling_depth = coupling;
            edge.temporal_delay_sec = unpack_delay(delay);
            edges.push(edge);
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
        let edges = self.collect_outgoing(handle);
        let mut results = Vec::with_capacity(edges.len());
        for &(tgt, kind_u8, coupling, delay) in &edges {
            let kind = EdgeKind::from_u8(kind_u8);
            if let Some(kinds) = kind_filter {
                if !kinds.contains(&kind) {
                    continue;
                }
            }
            results.push((self.get_str(tgt).to_string(), kind, coupling, unpack_delay(delay)));
        }
        results
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
        let edges = self.collect_incoming(handle);
        let mut results = Vec::with_capacity(edges.len());
        for &(src, kind_u8, coupling, delay) in &edges {
            let kind = EdgeKind::from_u8(kind_u8);
            if let Some(kinds) = kind_filter {
                if !kinds.contains(&kind) {
                    continue;
                }
            }
            results.push((self.get_str(src).to_string(), kind, coupling, unpack_delay(delay)));
        }
        results
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

        let has_pending = !self.pending_adds.is_empty() || !self.pending_removes.is_empty();

        while let Some((cur_handle, cur_depth)) = queue.pop_front() {
            if cur_depth >= depth {
                continue;
            }
            let cur_str = self.get_str(cur_handle).to_string();
            // outgoing (CSR — only if node is in dense index)
            if let Some(cur_idx) = self.node_idx(cur_handle) {
                let (s, e) = self.out_range(cur_idx);
                for i in s..e {
                    let kind = EdgeKind::from_u8(self.out_kinds[i]);
                    let other = self.out_targets[i];
                    if has_pending && self.pending_removes.contains(&(cur_handle, other, kind)) {
                        continue;
                    }
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(&kind) { continue; }
                    }
                    if visited.insert(other) {
                        let other_str = self.get_str(other).to_string();
                        result.push((cur_str.clone(), other_str, self.out_coupling[i]));
                        queue.push_back((other, cur_depth + 1));
                    }
                }
                // incoming (CSR)
                let (s, e) = self.in_range(cur_idx);
                for i in s..e {
                    let kind = EdgeKind::from_u8(self.in_kinds[i]);
                    let other = self.in_targets[i];
                    if has_pending && self.pending_removes.contains(&(other, cur_handle, kind)) {
                        continue;
                    }
                    if let Some(kinds) = kind_filter {
                        if !kinds.contains(&kind) { continue; }
                    }
                    if visited.insert(other) {
                        let other_str = self.get_str(other).to_string();
                        result.push((cur_str.clone(), other_str, self.in_coupling[i]));
                        queue.push_back((other, cur_depth + 1));
                    }
                }
            }
            // pending edges (always check, even for nodes not yet in CSR)
            if has_pending {
                for &(src, tgt, kind, coupling, delay) in &self.pending_adds {
                    if src == cur_handle && !self.pending_removes.contains(&(src, tgt, kind)) {
                        if let Some(kinds) = kind_filter {
                            if !kinds.contains(&kind) { continue; }
                        }
                        if visited.insert(tgt) {
                            let other_str = self.get_str(tgt).to_string();
                            result.push((cur_str.clone(), other_str, coupling));
                            queue.push_back((tgt, cur_depth + 1));
                            let _ = delay;
                        }
                    }
                    if tgt == cur_handle && !self.pending_removes.contains(&(src, tgt, kind)) {
                        if let Some(kinds) = kind_filter {
                            if !kinds.contains(&kind) { continue; }
                        }
                        if visited.insert(src) {
                            let other_str = self.get_str(src).to_string();
                            result.push((cur_str.clone(), other_str, coupling));
                            queue.push_back((src, cur_depth + 1));
                            let _ = delay;
                        }
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

        let has_pending = !self.pending_adds.is_empty() || !self.pending_removes.is_empty();

        while let Some((cur_handle, depth)) = queue.pop_front() {
            if depth > max_depth {
                continue;
            }
            while layers.len() <= depth {
                layers.push((layers.len(), Vec::new()));
            }
            layers[depth].1.push(self.get_str(cur_handle).to_string());

            // CSR edges
            if let Some(cur_idx) = self.node_idx(cur_handle) {
                let (s, e) = self.out_range(cur_idx);
                for i in s..e {
                    let tgt = self.out_targets[i];
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.out_kinds[i]);
                        if self.pending_removes.contains(&(cur_handle, tgt, kind)) { continue; }
                    }
                    if visited.insert(tgt) {
                        queue.push_back((tgt, depth + 1));
                    }
                }
                let (s, e) = self.in_range(cur_idx);
                for i in s..e {
                    let src = self.in_targets[i];
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.in_kinds[i]);
                        if self.pending_removes.contains(&(src, cur_handle, kind)) { continue; }
                    }
                    if visited.insert(src) {
                        queue.push_back((src, depth + 1));
                    }
                }
            }
            // Pending edges (always check)
            if has_pending {
                for &(src, tgt, kind, _, _) in &self.pending_adds {
                    if src == cur_handle && !self.pending_removes.contains(&(src, tgt, kind)) {
                        if visited.insert(tgt) { queue.push_back((tgt, depth + 1)); }
                    }
                    if tgt == cur_handle && !self.pending_removes.contains(&(src, tgt, kind)) {
                        if visited.insert(src) { queue.push_back((src, depth + 1)); }
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

        let has_pending = !self.pending_adds.is_empty() || !self.pending_removes.is_empty();

        while let Some((cur, depth)) = queue.pop_front() {
            if cur == target {
                break;
            }
            if depth >= max_depth {
                continue;
            }
            // CSR edges
            if let Some(cur_idx) = self.node_idx(cur) {
                let (s, e) = self.out_range(cur_idx);
                for i in s..e {
                    if explore_count >= max_explore { break; }
                    let tgt = self.out_targets[i];
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.out_kinds[i]);
                        if self.pending_removes.contains(&(cur, tgt, kind)) { continue; }
                    }
                    if visited.insert(tgt) {
                        prev.insert(tgt, cur);
                        queue.push_back((tgt, depth + 1));
                        explore_count += 1;
                    }
                }
                let (s, e) = self.in_range(cur_idx);
                for i in s..e {
                    if explore_count >= max_explore { break; }
                    let src = self.in_targets[i];
                    if has_pending {
                        let kind = EdgeKind::from_u8(self.in_kinds[i]);
                        if self.pending_removes.contains(&(src, cur, kind)) { continue; }
                    }
                    if visited.insert(src) {
                        prev.insert(src, cur);
                        queue.push_back((src, depth + 1));
                        explore_count += 1;
                    }
                }
            }
            // Pending edges
            if has_pending {
                for &(src, tgt, kind, _, _) in &self.pending_adds {
                    if explore_count >= max_explore { break; }
                    if self.pending_removes.contains(&(src, tgt, kind)) { continue; }
                    if src == cur && visited.insert(tgt) {
                        prev.insert(tgt, cur); queue.push_back((tgt, depth + 1)); explore_count += 1;
                    }
                    if tgt == cur && visited.insert(src) {
                        prev.insert(src, cur); queue.push_back((src, depth + 1)); explore_count += 1;
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
        let mut results = Vec::with_capacity(self.node_by_idx.len());
        for &src_handle in &self.node_by_idx {
            let raw = self.collect_outgoing(src_handle);
            if raw.is_empty() { continue; }
            let src_str = self.get_str(src_handle).to_string();
            let mut targets = Vec::with_capacity(raw.len());
            for &(tgt, kind_u8, coupling, delay) in &raw {
                targets.push((
                    self.get_str(tgt).to_string(),
                    EdgeKind::from_u8(kind_u8),
                    coupling,
                    unpack_delay(delay),
                ));
            }
            results.push((src_str, targets));
        }
        results
    }

    // ── mutators (for incremental update) ──

    pub fn insert_node(&mut self, node: Node) {
        let handle = self.intern(&node.id);
        self.index_node_name(handle, &node);
        self.index_node_file(handle, &node);
        self.nodes.insert(handle, node);
        // ponytail: dense index rebuilt on next flush_pending, not here
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        let handle = self.handle_of(id)?;
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
        // Mark all edges involving this node as removed
        let mut removed = 0usize;
        if let Some(idx) = self.node_idx(handle) {
            let (s, e) = self.out_range(idx);
            for i in s..e {
                let tgt = self.out_targets[i];
                let kind = EdgeKind::from_u8(self.out_kinds[i]);
                self.pending_removes.insert((handle, tgt, kind));
                removed += 1;
            }
            let (s, e) = self.in_range(idx);
            for i in s..e {
                let src = self.in_targets[i];
                let kind = EdgeKind::from_u8(self.in_kinds[i]);
                self.pending_removes.insert((src, handle, kind));
                // ponytail: incoming edges were already counted in edge_count
            }
        }
        // Also remove any pending edges for this node
        let pending_before = self.pending_adds.len();
        self.pending_adds.retain(|&(s, t, _, _, _)| s != handle && t != handle);
        removed += pending_before - self.pending_adds.len();
        self.edge_count = self.edge_count.saturating_sub(removed);
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
        let kind_u8 = kind.to_u8();
        // Check if edge already exists in CSR
        if self.edge_exists_in_csr(src, tgt, kind_u8) {
            // Check coupling + delay match
            if let Some(idx) = self.node_idx(src) {
                let (s, e) = self.out_range(idx);
                for i in s..e {
                    if self.out_targets[i] == tgt
                        && self.out_kinds[i] == kind_u8
                        && self.out_coupling[i] == coupling_depth
                        && unpack_delay(self.out_delays[i]) == temporal_delay_sec
                    {
                        return; // exact duplicate in CSR
                    }
                }
            }
        }
        // Check pending adds for duplicate
        if self.pending_adds.iter().any(|&(s, t, k, d, del)| {
            s == src && t == tgt && k == kind && d == coupling_depth && del == temporal_delay_sec
        }) {
            return;
        }
        self.pending_adds.push((src, tgt, kind, coupling_depth, temporal_delay_sec));
        self.pending_removes.remove(&(src, tgt, kind));
        self.edge_count += 1;
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
        // Check if edge exists in CSR or pending
        let in_csr = self.edge_exists_in_csr(src, tgt, kind.to_u8());
        let in_pending = self.pending_adds.iter().any(|&(s, t, k, _, _)| s == src && t == tgt && k == kind);
        if !in_csr && !in_pending {
            return false;
        }
        // Remove from pending adds (if was just added)
        self.pending_adds.retain(|&(s, t, k, _, _)| !(s == src && t == tgt && k == kind));
        if in_csr {
            self.pending_removes.insert((src, tgt, kind));
        }
        self.edge_count = self.edge_count.saturating_sub(1);
        true
    }

    /// Compute total edge count by scanning adjacency (for validation).
    pub fn recompute_edge_count(&self) -> usize {
        let mut count = 0usize;
        for &src_handle in &self.node_by_idx {
            count += self.collect_outgoing(src_handle).len();
        }
        count
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

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

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

    /// ponytail: clone_index_for_update() never called rebuild_dense_index(),
    /// so node_by_idx stayed empty → to_sqlite() collected 0 edges → all edges
    /// lost on SQLite write-back. This test ensures flush_pending() fixes it.
    #[test]
    fn test_clone_and_flush_preserves_edges() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", Some("src/a.rs")));
        idx.insert_node(test_node("b", "B", Some("src/b.rs")));
        idx.insert_node(test_node("c", "C", Some("src/c.rs")));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 1, Some(0.1));
        idx.upsert_edge("b", "c", EdgeKind::Calls, 2, None);
        idx.flush_pending(); // upsert → pending, flush → CSR so edges_iter() sees them

        // Simulate clone_index_for_update: rebuild from existing data
        // (we can't call clone_index_for_update directly since it's in incremental.rs,
        // but we can test the pattern by rebuilding from the graph)
        let mut g = Graph::new();
        for node in idx.nodes_iter() {
            g.add_node(node.clone());
        }
        for (source, targets) in idx.edges_iter() {
            for (target, kind, coupling_depth, delay) in targets {
                let id = format!("{}::{}::{}", source, target, kind.as_str());
                let mut edge = Edge::new(id, source.clone(), target, kind);
                edge.coupling_depth = coupling_depth;
                g.add_edge(edge);
            }
        }
        let mut cloned = MemoryIndex::from_existing_graph(g.nodes, g.edges);

        // Before flush: pending_adds has edges, node_by_idx is populated by
        // from_existing_graph, so this should pass. But we call flush to ensure
        // it doesn't break anything.
        cloned.flush_pending();

        // Verify edges survived
        assert_eq!(cloned.edge_count(), 2, "both edges should survive clone+flush");
        let out = cloned.outgoing("a", None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, EdgeKind::Calls);
        assert_eq!(out[0].2, 1); // coupling_depth

        let out2 = cloned.outgoing("b", None);
        assert_eq!(out2.len(), 1);
        assert_eq!(out2[0].2, 2); // coupling_depth
    }

    /// ponytail: ensure flush_pending correctly rebuilds internal data structures
    /// so that to_sqlite() can iterate node_by_idx to collect edges for persistence.
    #[test]
    fn test_edges_queryable_after_flush_pending() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);

        // upsert_edge puts edges in pending_adds; flush_pending rebuilds CSR from them.
        // Before flush, outgoing() reads from pending_adds (works).
        // After flush, outgoing() reads from rebuilt CSR arrays (must also work).
        idx.flush_pending();

        // Verify edges are queryable via outgoing after flush
        let out = idx.outgoing("a", None);
        assert_eq!(out.len(), 1, "edge should survive flush_pending");
        assert_eq!(out[0].0, "b");

        // Verify edge count is correct (reads from CSR after flush)
        assert_eq!(idx.edge_count(), 1, "edge_count should be correct after flush");
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

    #[test]
    fn test_remove_edge() {
        let mut idx = MemoryIndex::new();
        idx.insert_node(test_node("a", "A", None));
        idx.insert_node(test_node("b", "B", None));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        assert_eq!(idx.edge_count(), 1);

        assert!(idx.remove_edge("a", "b", EdgeKind::Calls));
        assert_eq!(idx.edge_count(), 0);
        assert!(idx.outgoing("a", None).is_empty());
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
        idx.flush_pending(); // upsert → pending, flush → CSR so to_sqlite() sees edges

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
