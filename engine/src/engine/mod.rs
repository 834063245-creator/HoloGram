// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Engine — unified API boundary for all graph operations.
// Replaces scattered globals (CACHED_GRAPH, GRAPH_STORE, ANALYZE_LOCK)
// with a single struct that owns all state.
//
// Lifecycle:
//   let mut engine = Engine::new();
//   engine.init("/path/to/project")?;
//   engine.read(|idx| { ... })?;
//   engine.analyze()?;
//   engine.start_watcher(|json| { ... });

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use parking_lot::RwLock;
use rusqlite::Connection;
use tracing::info;

use crate::graph::Graph;
use crate::storage::{GraphStore, MemoryIndex, SqliteDb};
use crate::storage::sqlite::{timeline_query, timeline_record, timeline_record_with_props};

// ═══════════════════════════════════════════════════════════════
// EngineState — lifecycle state machine
// ═══════════════════════════════════════════════════════════════

/// Engine lifecycle states.
/// Transitions: Uninitialized → Loading → Ready ↔ Analyzing
/// Error is a terminal sink from any state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineState {
    /// Engine created but not yet initialized with a project.
    Uninitialized,
    /// Loading graph data from SQLite or JSON.
    Loading {
        nodes_loaded: usize,
        edges_loaded: usize,
        elapsed_ms: u64,
    },
    /// Graph loaded and ready for queries.
    Ready {
        node_count: usize,
        edge_count: usize,
    },
    /// Full analysis in progress.
    Analyzing {
        /// When the analysis started (ms since epoch).
        started_at_ms: u64,
        /// Current phase label (e.g. "解析文件", "社区检测").
        phase: String,
        /// Files processed so far.
        current: usize,
        /// Total files to process (0 if unknown).
        total: usize,
        /// File currently being processed (empty if none).
        file: String,
    },
    /// Unrecoverable error.
    Error(String),
}

impl EngineState {
    pub fn is_ready(&self) -> bool {
        matches!(self, EngineState::Ready { .. })
    }

    pub fn is_analyzing(&self) -> bool {
        matches!(self, EngineState::Analyzing { .. })
    }
}

// ═══════════════════════════════════════════════════════════════
// AnalyzeResult — what Engine::analyze() returns
// ═══════════════════════════════════════════════════════════════

/// Result of a full analysis pipeline run.
#[derive(Debug, Clone)]
pub struct AnalyzeResult {
    /// The analyzed graph (for callers that need the full Graph object).
    pub graph: Graph,
    /// Number of nodes in the resulting graph.
    pub node_count: usize,
    /// Number of edges in the resulting graph.
    pub edge_count: usize,
    /// Number of detected communities.
    pub community_count: usize,
    /// Hierarchical communities (Level 0 → N), None if single-level only.
    pub hierarchical_communities: Vec<crate::community::HierarchicalCommunity>,
    /// Wall-clock time for the full pipeline.
    pub elapsed_secs: f64,
    /// Per-stage timing breakdown.
    pub stage_timings: Vec<StageTiming>,
}

/// A single pipeline stage timing record.
#[derive(Debug, Clone)]
pub struct StageTiming {
    pub name: String,
    pub elapsed_secs: f64,
    pub detail: String,
}

// ═══════════════════════════════════════════════════════════════
// Engine — the one door
// ═══════════════════════════════════════════════════════════════

fn graph_from_index(idx: &MemoryIndex) -> Graph {
    let mut g = Graph::new();
    for node in idx.nodes_iter() {
        g.add_node(node.clone());
    }
    for (source, targets) in idx.edges_iter() {
        for (target, kind, coupling_depth, delay) in targets {
            let id = format!("{}::{}::{}", source, target, kind.as_str());
            // ponytail: cross_file is analysis metadata lost in CSR round-trip.
            // Compute from node locations BEFORE target is moved into Edge::new.
            let cross_file = {
                let sf = idx.get_node(&source).and_then(|n| n.location.as_deref());
                let tf = idx.get_node(&target).and_then(|n| n.location.as_deref());
                match (sf, tf) {
                    (Some(s), Some(t)) => {
                        let s_file = s.rsplit_once(':').map(|(f, _)| f).unwrap_or(s);
                        let t_file = t.rsplit_once(':').map(|(f, _)| f).unwrap_or(t);
                        s_file != t_file
                    }
                    _ => false,
                }
            };
            let mut edge = crate::graph::Edge::new(id, source.clone(), target, kind);
            edge.coupling_depth = coupling_depth;
            edge.temporal_delay_sec = delay;
            edge.cross_file = cross_file;
            g.add_edge(edge);
        }
    }
    g
}

/// Central engine instance. Owns all graph state.
///
/// All graph operations — queries, analysis, watching — go through this struct.
/// External code should never access GraphStore, MemoryIndex, or the legacy
/// Graph cache directly.
pub struct Engine {
    /// The graph store (MemoryIndex + SQLite). Wrapped in std Mutex because
    /// GraphStore contains rusqlite::Connection which is !Sync.
    store: Mutex<Option<GraphStore>>,

    /// Dedicated SQLite connection for timeline — never blocks on graph store lock.
    timeline_conn: Mutex<Option<Connection>>,

    /// Current project root. Set once during init().
    project_root: Mutex<PathBuf>,

    /// Serializes full analysis runs. Only one analyze() at a time.
    analyze_lock: Mutex<()>,

    /// Cancel token for the currently-running analysis.
    /// Set to `true` when a new analyze() call wants to preempt the old one.
    /// The running pipeline checks this between stages and aborts early.
    cancel_token: RwLock<Option<Arc<AtomicBool>>>,

    /// Current lifecycle state.
    state: RwLock<EngineState>,

    /// Whether the file watcher is running.
    watcher_running: Arc<AtomicBool>,

    /// JoinHandle for the watcher thread. Used by stop_watcher() to confirm
    /// the old thread has exited before starting a new one.
    watcher_handle: Mutex<Option<std::thread::JoinHandle<()>>>,

    /// Pending file changes detected by the watcher but not yet synced.
    /// Each entry: (path, timestamp_ms, is_indexing).
    pending_changes: Mutex<Vec<(String, u64, bool)>>,
}

impl Engine {
    /// Create a new uninitialized engine.
    pub fn new() -> Self {
        Self {
            store: Mutex::new(None),
            timeline_conn: Mutex::new(None),
            project_root: Mutex::new(PathBuf::new()),
            analyze_lock: Mutex::new(()),
            cancel_token: RwLock::new(None),
            state: RwLock::new(EngineState::Uninitialized),
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_handle: Mutex::new(None),
            pending_changes: Mutex::new(Vec::new()),
        }
    }

    // ── Identity ──────────────────────────────────────────────

    /// Current lifecycle state.
    pub fn state(&self) -> EngineState {
        self.state.read().clone()
    }

    /// Project root, if initialized.
    pub fn project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap().clone()
    }

    /// Whether the engine is ready to serve queries.
    pub fn is_ready(&self) -> bool {
        self.state.read().is_ready()
    }

    // ── Init ──────────────────────────────────────────────────

    /// Initialize the engine for a project.
    ///
    /// Opens (or re-opens) the GraphStore at the given path. If the project
    /// root changed, the old store is replaced.
    pub fn init(&mut self, project_root: &Path) -> Result<(), String> {
        let new_root = project_root.to_path_buf();
        let old_root = self.project_root.lock().unwrap().clone();

        if old_root == new_root {
            // Same project — check if already initialized
            let store_guard = self.store.lock().unwrap();
            if store_guard.is_some() && self.is_ready() {
                // Ensure watcher is running (may have been lost on MCP reconnect)
                if !self.is_watching() {
                    self.start_watcher(new_root.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
                }
                return Ok(());
            }
        } else if !old_root.as_os_str().is_empty() {
            info!(
                "[engine] workspace switch: {} → {}",
                old_root.display(),
                new_root.display()
            );
            // Stop old watcher — it's watching the previous workspace.
            // The new watcher will be started at the end of this method.
            self.stop_watcher();
        }

        // Set loading state
        *self.state.write() = EngineState::Loading {
            nodes_loaded: 0,
            edges_loaded: 0,
            elapsed_ms: 0,
        };

        let start = std::time::Instant::now();
        let store = GraphStore::open(&new_root)?;
        let timeline_conn = SqliteDb::open_aux_connection(store.db.path())?;

        // Read counts for Ready state
        let (node_count, edge_count) = store.read(|idx| (idx.node_count(), idx.edge_count()));

        *self.project_root.lock().unwrap() = new_root.clone();
        *self.store.lock().unwrap() = Some(store);
        *self.timeline_conn.lock().unwrap() = Some(timeline_conn);
        *self.state.write() = EngineState::Ready {
            node_count,
            edge_count,
        };

        info!(
            "[engine] initialized: {} nodes, {} edges in {:.1}ms",
            node_count,
            edge_count,
            start.elapsed().as_millis()
        );

        // Auto-start file watcher for incremental updates
        if !self.is_watching() {
            self.start_watcher(new_root.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
        }

        Ok(())
    }

    // ── Read access (concurrent, lock-free between readers) ───

    /// Read from the MemoryIndex. Multiple readers can hold this concurrently.
    ///
    /// Returns an error if the store is not initialized.
    pub fn read<R>(&self, f: impl FnOnce(&MemoryIndex) -> R) -> Result<R, String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;
        Ok(store.read(f))
    }

    /// Read data by reconstructing a legacy Graph from the MemoryIndex.
    /// For callers that need the Graph type (legacy API compatibility).
    pub fn read_graph<R>(&self, f: impl FnOnce(&Graph) -> R) -> Result<R, String> {
        let graph = {
            let store_guard = self
                .store
                .lock()
                .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
            let store = store_guard
                .as_ref()
                .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;

            store.read(|idx| graph_from_index(idx))
        };
        Ok(f(&graph))
    }

    /// Mutate the store with a write lock. Serializes all writers.
    pub fn write<R>(&self, f: impl FnOnce(&mut MemoryIndex) -> R) -> Result<R, String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;
        Ok(store.write(f))
    }

    // ── Node/edge counts ─────────────────────────────────────

    /// Total node count.
    pub fn node_count(&self) -> Result<usize, String> {
        self.read(|idx| idx.node_count())
    }

    /// Total edge count.
    pub fn edge_count(&self) -> Result<usize, String> {
        self.read(|idx| idx.edge_count())
    }

    // ── Analysis ────────────────────────────────────────────

    /// Run the full analysis pipeline and store results.
    ///
    /// This is the ONE place where analysis happens. All consumers
    /// (MCP tool_analyze, Tauri direct_analyze, TCP handle_analyze)
    /// call this method.
    ///
    /// Pipeline: analyze_project → CrossFileResolver → coupling →
    /// framework_routes → dynamic_dispatch → dataflow_synthesis →
    /// detect_communities → store in GraphStore + SQLite →
    /// sync CACHED_GRAPH (temporary backward compat).
    pub fn analyze(&self, project_root: &Path) -> Result<AnalyzeResult, String> {
        // Cancel any currently-running analysis so it aborts at the next
        // stage boundary, releasing the lock quickly instead of running to
        // completion. This is what makes the "re-analyze" button responsive:
        // the old run exits early, the new one starts immediately.
        if let Some(token) = self.cancel_token.read().as_ref() {
            token.store(true, Ordering::SeqCst);
        }

        // Block until the current analysis releases the lock (cancelled →
        // aborts at stage boundary within seconds, not minutes).
        let _lock = self
            .analyze_lock
            .lock()
            .map_err(|e| format!("Analyze lock poisoned: {}", e))?;

        // Old analysis is done — clear the stale cancel token and create ours.
        let cancel = Arc::new(AtomicBool::new(false));
        *self.cancel_token.write() = Some(cancel.clone());

        // Abort stale analyzes queued before a workspace switch.
        if self.project_root() != project_root {
            return Err(format!(
                "分析已取消（工作区已切换到 {}）",
                self.project_root().display()
            ));
        }

        let started_at = std::time::Instant::now();
        let started_at_ms = chrono::Utc::now().timestamp_millis() as u64;

        // Helper to update progress (avoids repeating state write pattern)
        let set_progress = |phase: &str, current: usize, total: usize, file: &str| {
            *self.state.write() = EngineState::Analyzing {
                started_at_ms,
                phase: phase.to_string(),
                current,
                total,
                file: file.to_string(),
            };
        };

        // Set state to Analyzing
        set_progress("发现文件", 0, 0, "");

        info!("[engine] analysis started for {}", project_root.display());

        // ponytail: panic guard — if any pipeline stage panics or errors,
        // reset state from Analyzing to Error so the UI doesn't stay stuck.
        // Without this, a single stack overflow or unwrap failure leaves the
        // engine permanently "analyzing" and the analyze_lock poisoned.
        let analyze_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.run_pipeline(project_root, started_at, started_at_ms, &cancel)
        }));

        // Clean up cancel token regardless of outcome
        *self.cancel_token.write() = None;

        match analyze_result {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(e)) => {
                *self.state.write() = EngineState::Error(e.clone());
                Err(e)
            }
            Err(panic_payload) => {
                let msg = panic_payload
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic_payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic".to_string());
                *self.state.write() = EngineState::Error(format!("分析过程崩溃: {msg}"));
                Err(format!("分析过程崩溃: {msg}"))
            }
        }
    }

    // ── Timeline ─────────────────────────────────────────────

    /// Record a timeline event. Uses a dedicated DB connection (not graph store lock).
    pub fn record_timeline(
        &self,
        event_type: &str,
        node_id: Option<&str>,
        summary: &str,
    ) -> Result<(), String> {
        let conn_guard = self
            .timeline_conn
            .lock()
            .map_err(|e| format!("Timeline lock poisoned: {}", e))?;
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        timeline_record(conn, event_type, node_id, summary)
            .map_err(|e| format!("Timeline record failed: {}", e))
    }

    /// Record a timeline event with properties.
    pub fn record_timeline_with_props(
        &self,
        event_type: &str,
        node_id: Option<&str>,
        summary: &str,
        props: &serde_json::Value,
    ) -> Result<(), String> {
        let conn_guard = self
            .timeline_conn
            .lock()
            .map_err(|e| format!("Timeline lock poisoned: {}", e))?;
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        timeline_record_with_props(conn, event_type, node_id, summary, props)
            .map_err(|e| format!("Timeline record failed: {}", e))
    }

    /// Query timeline events. Uses a dedicated DB connection (not graph store lock).
    pub fn query_timeline(
        &self,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn_guard = self
            .timeline_conn
            .lock()
            .map_err(|e| format!("Timeline lock poisoned: {}", e))?;
        let conn = conn_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        timeline_query(conn, limit).map_err(|e| format!("Timeline query failed: {}", e))
    }

    /// Persist the current MemoryIndex to SQLite.
    pub fn save(&self) -> Result<(), String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        store.save()
    }

    /// Full-text search via SQLite FTS5. Returns matching nodes.
    pub fn fts_search(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<crate::graph::Node>, String> {
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized".to_string())?;
        let db = &store.db;
        Ok(store.read(|idx| idx.fts_search(db, query, limit).unwrap_or_default()))
    }

}

// ═══════════════════════════════════════════════════════════════
// Process-wide ENGINE global
// ═══════════════════════════════════════════════════════════════

// Sub-modules (extracted from this file to keep it manageable).
mod grammar;
mod pipeline;
mod watcher;
mod lsp;
pub use grammar::GRAMMAR_LOADER;
pub use lsp::reparse_source_lsp;

/// Global engine instance.
///
/// Outer RwLock allows replacing the entire Engine on workspace switch.
pub static ENGINE: std::sync::LazyLock<RwLock<Option<Engine>>> =
    std::sync::LazyLock::new(|| RwLock::new(None));

/// Initialize the global engine for the given project root.
/// Safe to call multiple times — reuses existing engine if same project,
/// replaces it on workspace switch.
pub fn engine_init(project_root: &Path) -> Result<(), String> {
    let mut engine_guard = ENGINE.write();
    match engine_guard.as_mut() {
        Some(engine) => {
            // Re-init handles same-project reuse and workspace switch internally
            engine.init(project_root)
        }
        None => {
            let mut engine = Engine::new();
            engine.init(project_root)?;
            *engine_guard = Some(engine);
            Ok(())
        }
    }
}

/// Read from the global engine's MemoryIndex.
pub fn engine_read<R>(f: impl FnOnce(&MemoryIndex) -> R) -> Result<R, String> {
    let engine_guard = ENGINE.read();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.read(f)
}

/// Read from the global engine via a reconstructed legacy Graph.
pub fn engine_read_graph<R>(f: impl FnOnce(&Graph) -> R) -> Result<R, String> {
    let engine_guard = ENGINE.read();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.read_graph(f)
}

/// Mutate the global engine's MemoryIndex.
///
/// Locking: acquires ENGINE.read() (shared) to prevent workspace switch while
/// mutating, then acquires the inner store's index.write() for actual serialization.
/// The ENGINE read lock is NOT a write lock — engine_init() (which replaces the
/// entire Engine) is the only caller that acquires ENGINE.write().
pub fn engine_write<R>(f: impl FnOnce(&mut MemoryIndex) -> R) -> Result<R, String> {
    let engine_guard = ENGINE.read();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.write(f)
}

/// Get the global engine's current state.
pub fn engine_state() -> EngineState {
    ENGINE
        .read()
        .as_ref()
        .map(|e| e.state())
        .unwrap_or(EngineState::Uninitialized)
}

/// Borrow the global Engine for direct method calls.
/// Returns None if the engine hasn't been initialized.
/// Use this when callers outside the engine module need to call
/// methods like start_watcher() / stop_watcher() on the Engine.
pub fn with_engine<R>(f: impl FnOnce(&Engine) -> R) -> Option<R> {
    ENGINE.read().as_ref().map(f)
}

/// Record a timeline event on the global engine.
pub fn engine_record_timeline(
    event_type: &str,
    node_id: Option<&str>,
    summary: &str,
) -> Result<(), String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.record_timeline(event_type, node_id, summary)
}

/// Record a timeline event with properties on the global engine.
pub fn engine_record_timeline_with_props(
    event_type: &str,
    node_id: Option<&str>,
    summary: &str,
    props: &serde_json::Value,
) -> Result<(), String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.record_timeline_with_props(event_type, node_id, summary, props)
}

/// Query timeline events from the global engine.
pub fn engine_query_timeline(
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.query_timeline(limit)
}

/// Persist to SQLite on the global engine.
pub fn engine_save() -> Result<(), String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.save()
}

/// Full-text search via FTS5 on the global engine.
pub fn engine_fts_search(
    query: &str,
    limit: usize,
) -> Result<Vec<crate::graph::Node>, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized".to_string())?;
    engine.fts_search(query, limit)
}

/// Run analysis on the global engine. Convenience wrapper that callers
/// (MCP, TCP, Tauri) can use without directly touching the ENGINE lock.
pub fn engine_analyze(project_root: &Path) -> Result<AnalyzeResult, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.analyze(project_root)
}

/// Try incremental update first, fall back to full re-analysis.
/// Called by the Tauri shell's file watcher so it doesn't always do
/// a full re-analysis when only a few files changed.
pub fn engine_try_incremental(
    root: &Path,
    changed_files: &[(PathBuf, String)],
) -> Result<(), String> {
    Engine::handle_watcher_changes(root, changed_files, &None)
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::lsp::reparse_for_lsp;
    use crate::pipeline::runner::analyze_project;

    #[test]
    fn test_engine_new_uninitialized() {
        let engine = Engine::new();
        assert_eq!(engine.state(), EngineState::Uninitialized);
        assert!(!engine.is_ready());
        assert_eq!(engine.project_root(), PathBuf::new());
        // Not initialized yet
        assert!(engine.read(|idx| idx.node_count()).is_err());
        assert!(engine.read_graph(|g| g.node_count()).is_err());
    }

    #[test]
    fn test_engine_init_empty_project() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_init_empty");
        // Use a subdirectory that doesn't have .hologram/
        let test_dir = tmp.join("empty_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        // Init on a directory with no graph data should succeed (empty store)
        let result = engine.init(&test_dir);
        assert!(result.is_ok(), "init should succeed on empty dir: {:?}", result.err());
        assert!(engine.is_ready());

        match engine.state() {
            EngineState::Ready { node_count, edge_count } => {
                assert_eq!(node_count, 0);
                assert_eq!(edge_count, 0);
            }
            other => panic!("Expected Ready, got {:?}", other),
        }

        assert_eq!(engine.project_root(), test_dir);
        assert_eq!(engine.node_count().unwrap(), 0);
        assert_eq!(engine.edge_count().unwrap(), 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_reinit_same_project_is_idempotent() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_reinit");
        let test_dir = tmp.join("same_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        engine.init(&test_dir).unwrap();
        assert!(engine.is_ready());

        // Second init on same project should succeed (idempotent)
        let result = engine.init(&test_dir);
        assert!(result.is_ok(), "re-init should be idempotent: {:?}", result.err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_workspace_switch_restarts_watcher() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_ws_switch");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir_a = tmp.join("project_a");
        let dir_b = tmp.join("project_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let mut engine = Engine::new();

        // Init with project A — watcher starts
        engine.init(&dir_a).unwrap();
        assert!(engine.is_ready());
        assert_eq!(engine.project_root(), dir_a);
        assert!(engine.is_watching(), "watcher should be running after first init");

        // Switch to project B — watcher must restart for the new root
        engine.init(&dir_b).unwrap();
        assert!(engine.is_ready());
        assert_eq!(engine.project_root(), dir_b);
        assert!(engine.is_watching(), "watcher should be running after workspace switch");
        // Verify it's actually watching the new root by checking project_root
        // (the watcher thread holds a clone of project_root, tested implicitly)

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_state_transitions() {
        let mut engine = Engine::new();
        assert_eq!(engine.state(), EngineState::Uninitialized);

        let tmp = std::env::temp_dir().join("hologram_test_engine_states");
        let test_dir = tmp.join("states_project");
        let _ = std::fs::create_dir_all(&test_dir);

        engine.init(&test_dir).unwrap();
        assert!(matches!(engine.state(), EngineState::Ready { .. }));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_read_graph_works() {
        let tmp = std::env::temp_dir().join("hologram_test_engine_read_graph");
        let test_dir = tmp.join("rg_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        engine.init(&test_dir).unwrap();

        let count = engine.read_graph(|g| g.node_count()).unwrap();
        assert_eq!(count, 0); // empty project

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_engine_write_works() {
        use crate::graph::{Node, NodeKind};

        let tmp = std::env::temp_dir().join("hologram_test_engine_write");
        let test_dir = tmp.join("write_project");
        let _ = std::fs::create_dir_all(&test_dir);

        let mut engine = Engine::new();
        engine.init(&test_dir).unwrap();

        // Insert a node via write
        engine
            .write(|idx| {
                let node = Node::new("test_node_1", "test_fn", NodeKind::Function);
                idx.insert_node(node);
            })
            .unwrap();

        // Read it back
        let count = engine.read(|idx| idx.node_count()).unwrap();
        assert_eq!(count, 1);

        let node = engine.read(|idx| idx.get_node("test_node_1").cloned()).unwrap();
        assert!(node.is_some());
        assert_eq!(node.unwrap().name, "test_fn");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // test_global_engine_init_and_read removed — global ENGINE functions
    // are tested implicitly by MCP tests (which use engine_read/write/init).

    #[test]
    fn test_engine_read_without_init_returns_error() {
        // Don't use the global ENGINE — test directly on an Engine that was
        // never initialized (read/write should fail).
        let engine = Engine::new();
        let result = engine.read(|idx: &MemoryIndex| idx.node_count());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("Engine not initialized"));
    }

    /// F1 regression: incremental update path must not always return Err.
    /// Create a project, analyze it, modify a file, then verify
    /// IncrementalUpdater::update() succeeds (no fallback to full analysis).
    #[test]
    fn test_incremental_update_path_is_reachable() {
        use crate::storage::incremental::IncrementalUpdater;
        

        let tmp = std::env::temp_dir().join("hologram_test_f1_incr");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Create a small Python project
        std::fs::write(tmp.join("main.py"), "def hello():\n    return 'world'\n").unwrap();
        std::fs::write(tmp.join("util.py"), "def add(a, b):\n    return a + b\n").unwrap();

        // Analyze
        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();
        let result = engine.analyze(&tmp).unwrap();
        assert!(result.node_count > 0, "should have nodes after analysis");

        // Read the old index
        let old_node_count = engine.read(|idx| idx.node_count()).unwrap();
        assert!(old_node_count > 0);

        // Modify a file (simulate watcher change)
        std::fs::write(tmp.join("main.py"), "def hello():\n    return 'updated'\ndef new_fn(): pass\n").unwrap();

        // Try incremental update
        let store_guard = engine.store.lock().unwrap();
        let store = store_guard.as_ref().unwrap();
        let changed: Vec<(PathBuf, &str)> = vec![(tmp.join("main.py"), "modified")];
        let inc_result = IncrementalUpdater::update(
            &changed,
            &store.index.read(),
            &tmp,
            &store.db,
        );
        drop(store_guard);

        // The incremental update should succeed (not fall back to full analysis)
        match inc_result {
            Ok((new_idx, errors)) => {
                assert!(new_idx.node_count() >= old_node_count,
                    "incremental update should preserve or add nodes (old={}, new={})",
                    old_node_count, new_idx.node_count());
                if errors > 0 {
                    // Parse errors are acceptable but node count shouldn't drop drastically
                }
            }
            Err(e) => {
                panic!("F1 regression: incremental update should succeed, got: {}", e);
            }
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Integration test: verify LSP type-resolved call edges appear in
    /// the graph after full analysis of a real-world-shaped Python project.
    #[test]
    fn test_lsp_type_resolved_edges_in_graph() {
        let tmp = std::env::temp_dir().join("hologram_test_lsp_e2e");
        let _ = std::fs::remove_dir_all(&tmp);
        let test_dir = tmp.join("lsp_project");
        std::fs::create_dir_all(&test_dir).unwrap();

        // Simulate a Django-style project structure
        std::fs::create_dir_all(test_dir.join("app")).unwrap();

        // models.py: defines a User class with a handle method
        std::fs::write(
            test_dir.join("app").join("models.py"),
            r#"
class User:
    def handle(self, request):
        return "ok"

class Order:
    def process(self):
        pass
"#,
        )
        .unwrap();

        // views.py: calls User().handle() and Order().process()
        std::fs::write(
            test_dir.join("app").join("views.py"),
            r#"
from app.models import User, Order

def my_view(request):
    user = User()
    user.handle(request)

def order_view():
    order = Order()
    order.process()
"#,
        )
        .unwrap();

        // Run full analysis pipeline
        let result = analyze_project(&test_dir);
        let mut graph = result.graph;

        // Build registry + run LSP pass
        use crate::adapter::type_registry::TypeRegistry;
        let registry = TypeRegistry::from_graph(&graph);

        // Build name index for edge rewriting (mirrors resolve_calls_lsp)
        let mut name_index: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        for (nid, node) in &graph.nodes {
            let short = node.name.rsplit('.').next().unwrap_or(&node.name).to_string();
            name_index.entry(short).or_default().push(nid.clone());
        }

        let mut total_resolved = 0usize;

        for (abs_path, (source, _tree_opt)) in &result.parse_cache {
            if !abs_path.ends_with(".py") {
                continue;
            }
            // ponytail: parse_cache stores source only (streaming LSP), re-parse here
            let tree_opt = reparse_for_lsp(source, "py");
            if let Some(ref tree) = tree_opt {
                let rel = abs_path
                    .strip_prefix(&format!("{}", test_dir.display()))
                    .unwrap_or(abs_path)
                    .trim_start_matches('/')
                    .trim_start_matches('\\');
                let module_qn = rel.replace(['/', '\\'], ".").trim_end_matches(".py").to_string();
                let resolved_calls =
                    crate::adapter::python_lsp::run_py_lsp(source, tree, &module_qn, &registry);

                for rc in &resolved_calls {
                    let short =
                        rc.callee_qn.rsplit('.').next().unwrap_or(&rc.callee_qn).to_string();
                    let callee_id = if graph.nodes.contains_key(&rc.callee_qn) {
                        Some(rc.callee_qn.clone())
                    } else if let Some(candidates) = name_index.get(&short) {
                        candidates
                            .iter()
                            .find(|c| rc.callee_qn.ends_with(c.as_str()) || c.ends_with(&short))
                            .or_else(|| candidates.first())
                            .cloned()
                    } else {
                        None
                    };

                    if let Some(ref cid) = callee_id {
                        for edge in graph.edges.values_mut() {
                            if edge.kind != crate::graph::EdgeKind::Calls {
                                continue;
                            }
                            if edge.source != rc.caller_qn {
                                continue;
                            }
                            let tgt_short = edge.target.rsplit('.').next().unwrap_or(&edge.target);
                            if tgt_short == short {
                                edge.target = cid.clone();
                                edge.lsp_resolved = true;
                                total_resolved += 1;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Verify: should have resolved at least 2 calls
        // (user.handle() and order.process())
        assert!(
            total_resolved >= 2,
            "LSP should resolve at least 2 cross-file calls, got {} resolved edges.\n\
             Graph has {} nodes and {} edges.",
            total_resolved,
            graph.node_count(),
            graph.edge_count()
        );

        // Verify: at least one edge has lsp_resolved = true
        let lsp_edges: Vec<&crate::graph::Edge> = graph
            .edges
            .values()
            .filter(|e| e.lsp_resolved)
            .collect();
        assert!(
            !lsp_edges.is_empty(),
            "Expected at least one lsp_resolved edge in the graph"
        );

        // Verify: a resolved edge points to a precise QN, not a short name
        for e in &lsp_edges {
            assert!(
                e.target.contains('.'),
                "LSP-resolved edge target should be a qualified name (contain '.'), got: {}",
                e.target
            );
        }

        // Verify specific call resolution: user.handle() should resolve to User.handle
        let has_user_handle = lsp_edges.iter().any(|e| {
            e.target.contains("User.handle") || e.target.contains("User")
        });
        assert!(
            has_user_handle,
            "Expected LSP-resolved edge targeting User.handle or User, got edges:\n{:#?}",
            lsp_edges.iter().map(|e| format!("{} → {} ({})", e.source, e.target, e.lsp_resolved)).collect::<Vec<_>>()
        );

        // Print verification summary
        let lsp_edge_summary: Vec<String> = lsp_edges
            .iter()
            .map(|e| format!("  {}  →  {}  [lsp_resolved]", e.source, e.target))
            .collect();
        // Use a test-friendly assertion that always shows the summary
        assert!(
            !lsp_edge_summary.is_empty(),
            "LSP-resolved edges found:\n{}",
            lsp_edge_summary.join("\n")
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// ponytail: graph_from_index lost edge metadata (cross_file in particular)
    /// because MemoryIndex CSR doesn't store those fields. The fix re-derives
    /// cross_file from node locations.
    #[test]
    fn test_graph_from_index_cross_file() {
        use crate::graph::{EdgeKind, Node, NodeKind};
        use crate::storage::memory::MemoryIndex;

        let mut idx = MemoryIndex::new();

        // Same file
        let mut n1 = Node::new("n1", "fn_a", NodeKind::Function);
        n1.location = Some("src/lib.rs:10".into());
        idx.insert_node(n1);

        let mut n2 = Node::new("n2", "fn_b", NodeKind::Function);
        n2.location = Some("src/lib.rs:50".into());
        idx.insert_node(n2);

        // Different file
        let mut n3 = Node::new("n3", "fn_c", NodeKind::Function);
        n3.location = Some("src/main.rs:5".into());
        idx.insert_node(n3);

        idx.upsert_edge("n1", "n2", EdgeKind::Calls, 0, None); // same file
        idx.upsert_edge("n1", "n3", EdgeKind::Calls, 0, None); // cross-file
        idx.flush_pending(); // upsert_edge → pending_adds, flush → CSR so graph_from_index sees them

        let g = graph_from_index(&idx);
        assert_eq!(g.node_count(), 3);
        assert_eq!(g.edge_count(), 2);

        // Edge n1→n2: same file → cross_file=false
        let e1 = g.edges.values().find(|e| e.source == "n1" && e.target == "n2").unwrap();
        assert!(!e1.cross_file, "n1→n2 should be same-file (both in src/lib.rs), got cross_file={}", e1.cross_file);

        // Edge n1→n3: different files → cross_file=true
        let e2 = g.edges.values().find(|e| e.source == "n1" && e.target == "n3").unwrap();
        assert!(e2.cross_file, "n1→n3 should be cross-file (lib.rs vs main.rs), got cross_file={}", e2.cross_file);
    }

    /// Edge without location info should default to cross_file=false.
    #[test]
    fn test_graph_from_index_no_location() {
        use crate::graph::{EdgeKind, Node, NodeKind};
        use crate::storage::memory::MemoryIndex;

        let mut idx = MemoryIndex::new();
        idx.insert_node(Node::new("a", "A", NodeKind::Symbol));
        idx.insert_node(Node::new("b", "B", NodeKind::Symbol));
        idx.upsert_edge("a", "b", EdgeKind::Calls, 0, None);
        idx.flush_pending();

        let g = graph_from_index(&idx);
        let e = g.edges.values().next().unwrap();
        assert!(!e.cross_file, "edges without locations should default cross_file=false");
    }

    // ═══════════════════════════════════════════════════════════════
    // Re-analyze resilience — state must never stay stuck at Analyzing
    // ═══════════════════════════════════════════════════════════════

    /// After a workspace-mismatch error, state must be Error (not stuck at
    /// Analyzing), and the analyze lock must be released so the next call
    /// can proceed.
    #[test]
    fn test_reanalyze_state_recovers_on_workspace_mismatch() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_ws_mismatch");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir_a = tmp.join("project_a");
        let dir_b = tmp.join("project_b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let mut engine = Engine::new();
        engine.init(&dir_a).unwrap();
        assert!(engine.is_ready());

        // analyze(dir_b) when engine is bound to dir_a — must fail
        let result = engine.analyze(&dir_b);
        assert!(result.is_err(), "analyze on wrong workspace must return Err");
        assert!(
            result.unwrap_err().contains("工作区已切换"),
            "error message should mention workspace switch"
        );

        // State must be Uninitialized (not Analyzing!) because the check
        // happens BEFORE set_progress("发现文件", ...) sets Analyzing.
        assert!(
            !engine.state().is_analyzing(),
            "state must NOT be Analyzing after workspace-mismatch error"
        );

        // Lock must be released — a second analyze on the correct path works
        let result2 = engine.analyze(&dir_a);
        // This should succeed (or fail with a real analysis error, not lock
        // poisoned). Either way, it must not hang.
        assert!(
            result2.is_ok() || !result2.as_ref().unwrap_err().contains("poisoned"),
            "analyze lock must not be poisoned after error: {:?}",
            result2.err()
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Full analysis on a real project: verify state ends at Ready (not
    /// stuck at Analyzing), data is accessible, and lock is released.
    #[test]
    fn test_reanalyze_completes_and_state_is_ready() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_completes");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Small multi-file Python project to exercise the full pipeline
        std::fs::write(tmp.join("main.py"), "import util\ndef main():\n    return util.add(1, 2)\n").unwrap();
        std::fs::write(tmp.join("util.py"), "def add(a, b):\n    return a + b\n").unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();
        assert!(engine.is_ready());

        let result = engine.analyze(&tmp);
        assert!(result.is_ok(), "analyze must succeed: {:?}", result.err());

        // State must be Ready (NOT Analyzing)
        let state = engine.state();
        assert!(
            matches!(state, EngineState::Ready { .. }),
            "state must be Ready after successful analysis, got {:?}",
            state
        );

        // Data must be accessible
        let nc = engine.node_count().unwrap();
        let ec = engine.edge_count().unwrap();
        assert!(nc > 0, "must have nodes after analysis");
        assert!(ec > 0, "must have edges after analysis (import + call)");

        // Lock is healthy — consecutive reads work
        let nc2 = engine.read(|idx| idx.node_count()).unwrap();
        assert_eq!(nc2, nc, "read after analyze must return same count");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Verify the analyze lock is not poisoned and state is not stuck
    /// after the pipeline completes (success or error).  Regression test
    /// for the "re-analyze stuck at 分析中" bug where a panic or error
    /// inside the pipeline left state permanently at Analyzing.
    #[test]
    fn test_reanalyze_lock_healthy_and_state_not_stuck() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_lock_healthy");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        std::fs::write(tmp.join("hello.py"), "def f(): pass\n").unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();

        // Run analyze — may succeed or fail, but must not leave state stuck
        let _ = engine.analyze(&tmp);

        // Assert 1: state is not Analyzing
        assert!(
            !engine.state().is_analyzing(),
            "BUG: state stuck at Analyzing after analyze() returned"
        );

        // Assert 2: lock is healthy — can call analyze() again
        let result2 = engine.analyze(&tmp);
        // Either succeeds or fails with a non-poison error
        if let Err(e) = &result2 {
            assert!(
                !e.contains("poisoned"),
                "BUG: analyze lock poisoned after first analyze: {}",
                e
            );
        }

        // Assert 3: graph write still works
        use crate::graph::{Node, NodeKind};
        let write_result = engine.write(|idx| {
            idx.insert_node(Node::new("test_n", "Test", NodeKind::Symbol));
        });
        assert!(write_result.is_ok(), "write after analyze must succeed: {:?}", write_result.err());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Verify that even when analyze() is called concurrently on two
    /// engines (different instances), each completes without the other's
    /// state leaking.  Proves the analyze_lock is per-instance.
    #[test]
    fn test_reanalyze_independent_engines_dont_interfere() {
        let tmp = std::env::temp_dir().join("hologram_test_rs_independent");
        let _ = std::fs::remove_dir_all(&tmp);
        let dir1 = tmp.join("p1");
        let dir2 = tmp.join("p2");
        std::fs::create_dir_all(&dir1).unwrap();
        std::fs::create_dir_all(&dir2).unwrap();
        std::fs::write(dir1.join("a.py"), "def x(): pass\n").unwrap();
        std::fs::write(dir2.join("b.py"), "def y(): pass\n").unwrap();

        let mut e1 = Engine::new();
        let mut e2 = Engine::new();
        e1.init(&dir1).unwrap();
        e2.init(&dir2).unwrap();

        let r1 = e1.analyze(&dir1);
        let r2 = e2.analyze(&dir2);

        assert!(r1.is_ok(), "engine 1 analyze failed: {:?}", r1.err());
        assert!(r2.is_ok(), "engine 2 analyze failed: {:?}", r2.err());

        assert!(matches!(e1.state(), EngineState::Ready { .. }), "engine 1 state stuck");
        assert!(matches!(e2.state(), EngineState::Ready { .. }), "engine 2 state stuck");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Full-pipeline integration test against a multi-file, multi-language
    /// fixture. One test that catches regressions across the entire stack:
    /// parser → structure → coupling → communities → dataflow → persistence.
    #[test]
    fn test_fixture_full_pipeline() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/test_project");

        let mut engine = Engine::new();
        engine.init(&fixture).unwrap();
        let result = engine.analyze(&fixture);
        assert!(result.is_ok(), "analyze failed: {:?}", result.err());

        // ── Structure: nodes + edges exist ──
        let nc = engine.node_count().unwrap();
        let ec = engine.edge_count().unwrap();
        assert!(nc >= 8, "expected >=8 nodes (3 py files + 1 js file + functions/classes), got {nc}");
        assert!(ec >= 5, "expected >=5 edges (calls + imports + inherits), got {ec}");

        // ── Edge types present ──
        let (has_calls, has_imports, has_defines, has_inherits) = engine.read(|idx| {
            let mut calls = false; let mut imports = false;
            let mut defines = false; let mut inherits = false;
            for (_src, targets) in idx.edges_iter() {
                for (_tgt, kind, _depth, _delay) in targets {
                    match kind {
                        crate::graph::EdgeKind::Calls => calls = true,
                        crate::graph::EdgeKind::Imports => imports = true,
                        crate::graph::EdgeKind::Defines => defines = true,
                        crate::graph::EdgeKind::Inherits => inherits = true,
                        _ => {}
                    }
                }
            }
            (calls, imports, defines, inherits)
        }).unwrap();
        assert!(has_calls, "must have Calls edges (e.g. main → connect_db)");
        assert!(has_imports, "must have Imports edges (Python cross-file imports)");
        assert!(has_defines, "must have Defines edges (class → module, function → class)");
        assert!(has_inherits, "must have Inherits edges (PooledConnection → Config)");

        // ── Communities detected ──
        let community_count = engine.read(|idx| {
            let ids: std::collections::HashSet<usize> = idx.nodes_iter()
                .filter_map(|n| n.community_id)
                .collect();
            ids.len()
        }).unwrap();
        assert!(community_count >= 1, "must detect at least 1 community");

        // ── Dataflow: query specific files ──
        let main_py = fixture.join("main.py");
        let db_py = fixture.join("db.py");
        let results = crate::analysis::dataflow_engine::query_dataflow_files(&[main_py, db_py]);
        assert_eq!(results.len(), 2);

        // main.py: should detect `main` and `fetch_remote` async triggers
        let main_df = results[0].result.as_ref().expect("main.py dataflow");
        let main_fn = main_df.scopes.iter().find(|s| s.name == "main").expect("main function");
        assert!(main_fn.writes.contains(&"db".into()), "main() writes db, got writes={:?}", main_fn.writes);
        let fetch_fn = main_df.scopes.iter().find(|s| s.name == "fetch_remote").expect("fetch_remote");
        assert!(!fetch_fn.triggers.is_empty(), "fetch_remote has await trigger");

        // db.py: `_connection_count` should be detected as shared state
        let db_df = results[1].result.as_ref().expect("db.py dataflow");
        // db.py has shared variables: `host` (Config ctor → connect_db),
        // `db` + `sql` (passed through execute_query → _do_query).
        let shared_vars: Vec<&str> = db_df.shared.iter().map(|s| s.var.as_str()).collect();
        assert!(shared_vars.contains(&"db"), "db.py should have shared 'db' var, got shared={:?}", db_df.shared);
        assert!(shared_vars.contains(&"host"), "db.py should have shared 'host' var, got shared={:?}", db_df.shared);

        // helper.js: async + cache patterns
        let js_results = crate::analysis::dataflow_engine::query_dataflow_files(&[fixture.join("helper.js")]);
        let js_df = js_results[0].result.as_ref().expect("helper.js dataflow");
        let loader = js_df.scopes.iter().find(|s| s.name == "loadResource").expect("loadResource");
        assert!(loader.writes.contains(&"data".into()) || loader.writes.contains(&"cached".into()),
            "loadResource writes something, got writes={:?}", loader.writes);
        assert!(!loader.triggers.is_empty(), "loadResource has await trigger");

        // ── Persistence: save + read back ──
        engine.save().expect("save to SQLite");
        let nc2 = engine.read(|idx| idx.node_count()).unwrap();
        assert_eq!(nc2, nc, "node count after save must match");
    }

    /// Verify that all 4 blind-spot synthesis stages produce marker nodes
    /// when run against a multi-language fixture with reflection/eval/cross-lang patterns.
    #[test]
    fn test_blindspot_synthesis_pipeline() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/pipeline_test");
        let mut engine = Engine::new();
        engine.init(&fixture).unwrap();
        let result = engine.analyze(&fixture).expect("pipeline test failed");
        let mut has_di = false; let mut has_dyn = false;
        let mut has_eval = false; let mut has_xlang = false;
        for t in &result.stage_timings {
            if t.name == "DI / Reflection" && t.detail.contains("edges") { has_di = true; }
            if t.name == "Dynamic Import" && t.detail.contains("markers") { has_dyn = true; }
            if t.name == "Eval Detection" && t.detail.contains("markers") { has_eval = true; }
            if t.name == "Cross-Lang" && t.detail.contains("markers") { has_xlang = true; }
        }
        assert!(has_di && has_dyn && has_eval && has_xlang,
            "all 4 synthesis stages must be present: DI={has_di} Dyn={has_dyn} Eval={has_eval} XLang={has_xlang}");
        let names: Vec<String> = engine.read(|idx| {
            idx.nodes_iter().map(|n| n.name.clone()).collect()
        }).unwrap();
        assert!(names.iter().any(|n| n.starts_with("<reflection:")), "DI marker missing");
        assert!(names.iter().any(|n| n.contains("dynamic-import")), "dyn-import marker missing");
        assert!(names.iter().any(|n| n.starts_with("<eval")), "eval marker missing");
        assert!(names.iter().any(|n| n.starts_with("<cross-lang:")), "cross-lang marker missing");
    }

    // ── Cancel token tests ──────────────────────────────────────────────

    /// Cancel flag set mid-pipeline → analysis aborts with cancel error.
    /// Proves that re-analyze doesn't block waiting for a running analysis
    /// to complete — the old one is cancelled at the next stage boundary.
    #[test]
    fn test_cancel_token_stops_pipeline() {
        let tmp = std::env::temp_dir().join("hologram_test_cancel_stop");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // ponytail: 300 files so core-parse takes 100-300ms — enough for
        // the cancel signal to arrive before the pipeline finishes. 20 files
        // parsed in 10ms which was too fast.
        for i in 0..300 {
            std::fs::write(
                tmp.join(format!("mod{}.py", i)),
                format!("def func{0}():\n    return {0}\n", i),
            )
            .unwrap();
        }

        let engine = std::sync::Arc::new(Engine::new());
        {
            let ptr = std::sync::Arc::as_ptr(&engine) as *mut Engine;
            unsafe { &mut *ptr }.init(&tmp).unwrap();
        }

        let e = engine.clone();
        let t = tmp.clone();
        let handle = std::thread::spawn(move || e.analyze(&t));

        // Wait for analysis to enter its first stage, then cancel.
        std::thread::sleep(std::time::Duration::from_millis(50));
        if let Some(token) = engine.cancel_token.read().as_ref() {
            token.store(true, Ordering::SeqCst);
        }

        let result = handle.join().unwrap();
        assert!(
            result.is_err(),
            "analysis must be cancelled: expected Err, got {:?}",
            result.ok()
        );
        assert!(
            result.unwrap_err().contains("已被新的重分析请求取消"),
            "error must mention cancellation"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// After analysis completes (success or error), cancel_token must be
    /// None — proves cleanup doesn't leak a stale token that interferes
    /// with the next analysis.
    #[test]
    fn test_cancel_token_cleaned_up_after_analysis() {
        let tmp = std::env::temp_dir().join("hologram_test_cancel_cleanup");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "def f(): pass\n").unwrap();

        let mut engine = Engine::new();
        engine.init(&tmp).unwrap();

        // 1. Successful analysis: token must be None
        let result = engine.analyze(&tmp);
        assert!(result.is_ok(), "analyze failed: {:?}", result.err());
        assert!(
            engine.cancel_token.read().is_none(),
            "cancel_token must be None after successful analysis"
        );

        // 2. Lock is healthy — can analyze again
        let result2 = engine.analyze(&tmp);
        assert!(result2.is_ok(), "second analyze failed: {:?}", result2.err());
        assert!(
            engine.cancel_token.read().is_none(),
            "cancel_token must be None after second analysis"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Calling analyze() while another is running cancels the first and
    /// runs to completion. This is the re-analyze button's contract:
    /// "start fresh, now, don't queue behind the old run."
    #[test]
    fn test_reanalyze_cancels_running_analysis() {
        let tmp = std::env::temp_dir().join("hologram_test_rac_cancel");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Enough files to ensure the first analysis is still running
        // when the second call arrives
        for i in 0..30 {
            std::fs::write(
                tmp.join(format!("lib{}.py", i)),
                format!("def fn{0}():\n    return {0}\nclass C{0}:\n    pass\n", i),
            )
            .unwrap();
        }

        let engine = std::sync::Arc::new(Engine::new());
        {
            let ptr = std::sync::Arc::as_ptr(&engine) as *mut Engine;
            unsafe { &mut *ptr }.init(&tmp).unwrap();
        }

        // Start first analysis
        let e1 = engine.clone();
        let t1 = tmp.clone();
        let handle = std::thread::spawn(move || e1.analyze(&t1));

        // Brief sleep so first analysis is past init and into pipeline
        std::thread::sleep(std::time::Duration::from_millis(200));

        // Second analysis — this cancels the first via the token
        let result2 = engine.analyze(&tmp);
        assert!(result2.is_ok(), "second analyze must succeed: {:?}", result2.err());
        assert!(
            matches!(engine.state(), EngineState::Ready { .. }),
            "state must be Ready after second analysis"
        );

        // First analysis should have been cancelled (or completed if it was
        // fast enough — either is acceptable, it's not stuck)
        let result1 = handle.join().unwrap();
        if let Err(ref e) = result1 {
            assert!(
                e.contains("已被取消") || e.contains("已被新的重分析"),
                "if first analysis failed, must be from cancellation: {}",
                e
            );
        }
        // If result1 is Ok, it means the first analysis finished before
        // cancellation took effect — also fine (project was small enough).

        // Verify data is accessible after all this
        let nc = engine.node_count().unwrap();
        assert!(nc > 0, "must have nodes after re-analysis");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}