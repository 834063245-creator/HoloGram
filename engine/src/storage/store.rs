// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// GraphStore — the central graph data access layer.
// Replaces CACHED_GRAPH: Mutex<Option<Graph>> with RwLock<MemoryIndex> + SqliteDb.
// Allows N concurrent reads, 1 write for swap operations.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::RwLock;
use tracing::{info, warn};

use crate::graph::Graph;
use crate::storage::memory::{LoadProgress, MemoryIndex};
use crate::storage::sqlite::SqliteDb;

/// Central graph store. All MCP tools read through this.
pub struct GraphStore {
    /// The in-memory index (RwLock for concurrent reads).
    pub index: RwLock<MemoryIndex>,
    /// Persistent database.
    pub db: SqliteDb,
    /// Project root this store was opened for. Used to detect workspace switches
    /// so we can reopen the SQLite at the correct path instead of cross-contaminating.
    project_root: PathBuf,
    /// Loading progress (for hologram_status). Updated during startup load.
    loading: RwLock<LoadProgress>,
    /// Timestamp when loading started (ms since epoch, for elapsed_ms calc).
    load_start_ms: AtomicU64,
}

impl GraphStore {
    /// Open the store for a project. Handles:
    /// 1. SQLite cache check
    /// 2. Load from SQLite (fast path)
    /// 3. JSON migration (fallback)
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let start = std::time::Instant::now();
        let db = SqliteDb::open(project_root)?;

        let load_start = chrono::Utc::now().timestamp_millis() as u64;
        let store = Self {
            index: RwLock::new(MemoryIndex::new()),
            db,
            project_root: project_root.to_path_buf(),
            loading: RwLock::new(LoadProgress {
                phase: "loading".into(),
                nodes_loaded: 0,
                edges_loaded: 0,
                nodes_total: 0,
                edges_total: 0,
                elapsed_ms: 0,
            }),
            load_start_ms: AtomicU64::new(load_start),
        };

        // Try SQLite first
        match MemoryIndex::from_sqlite(&store.db) {
            Ok(idx) => {
                let nodes = idx.node_count();
                let edges = idx.edge_count();
                *store.index.write() = idx;
                let elapsed = start.elapsed().as_millis() as u64;
                *store.loading.write() = LoadProgress {
                    phase: "ready".into(),
                    nodes_loaded: nodes,
                    edges_loaded: edges,
                    nodes_total: nodes,
                    edges_total: edges,
                    elapsed_ms: elapsed,
                };
                info!(
                    "[store] loaded from SQLite: {} nodes, {} edges in {}ms",
                    nodes, edges, elapsed
                );
                return Ok(store);
            }
            Err(e) => {
                info!("[store] SQLite load failed ({}), trying JSON fallback", e);
            }
        }

        // JSON migration fallback
        let json_path = project_root.join(".hologram").join("hologram_graph.json");
        if json_path.exists() {
            info!("[store] migrating from JSON: {}", json_path.display());
            match Graph::from_json_file(&json_path.to_string_lossy()) {
                Ok(g) => {
                    let idx = MemoryIndex::from_existing_graph(g.nodes, g.edges);
                    let nodes = idx.node_count();
                    let edges = idx.edge_count();
                    // Try to persist to SQLite (non-fatal if it fails)
                    if let Err(e) = idx.to_sqlite(&store.db) {
                        warn!("[store] JSON→SQLite write failed (non-fatal): {}", e);
                    }
                    *store.index.write() = idx;
                    let elapsed = start.elapsed().as_millis() as u64;
                    *store.loading.write() = LoadProgress {
                        phase: "ready".into(),
                        nodes_loaded: nodes,
                        edges_loaded: edges,
                        nodes_total: nodes,
                        edges_total: edges,
                        elapsed_ms: elapsed,
                    };
                    info!(
                        "[store] loaded from JSON migration: {} nodes, {} edges in {}ms",
                        nodes, edges, elapsed
                    );
                    return Ok(store);
                }
                Err(e) => {
                    info!("[store] JSON migration failed: {}", e);
                }
            }
        }

        // Neither SQLite nor JSON — empty store, user must run analyze
        *store.loading.write() = LoadProgress {
            phase: "ready".into(),
            nodes_loaded: 0,
            edges_loaded: 0,
            nodes_total: 0,
            edges_total: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
        };
        info!("[store] empty store ready (no SQLite cache, no JSON)");
        Ok(store)
    }

    /// Persist current MemoryIndex to SQLite.
    pub fn save(&self) -> Result<(), String> {
        let idx = self.index.read();
        idx.to_sqlite(&self.db)
    }

    /// Return the project root this store was opened for.
    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    /// Swap the in-memory index with a new one. Holds write lock briefly.
    pub fn swap_index(&self, new_idx: MemoryIndex) {
        let mut old = self.index.write();
        *old = new_idx;
    }

    /// Get current loading progress (for hologram_status).
    pub fn load_progress(&self) -> LoadProgress {
        let p = self.loading.read().clone();
        let start = self.load_start_ms.load(Ordering::Relaxed);
        let now = chrono::Utc::now().timestamp_millis() as u64;
        LoadProgress {
            elapsed_ms: now.saturating_sub(start),
            ..p
        }
    }

    /// Query the index with a read lock. The closure receives &MemoryIndex.
    pub fn read<R>(&self, f: impl FnOnce(&MemoryIndex) -> R) -> R {
        let idx = self.index.read();
        f(&idx)
    }

    /// Mutate the index with a write lock. The closure receives &mut MemoryIndex.
    pub fn write<R>(&self, f: impl FnOnce(&mut MemoryIndex) -> R) -> R {
        let mut idx = self.index.write();
        f(&mut idx)
    }
}
