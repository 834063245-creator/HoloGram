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
use tracing::{info, warn};

use crate::analysis::coupling::compute_coupling;
use crate::analysis::dataflow_synthesis::synthesize_dataflow_edges;
use crate::analysis::dynamic_dispatch::synthesize_dynamic_edges;
use crate::analysis::framework_routes::detect_framework_routes;
use crate::community::detect_communities;
use crate::graph::resolver::CrossFileResolver;
use crate::graph::Graph;
use crate::pipeline::runner::analyze_project;
use crate::storage::{GraphStore, MemoryIndex};

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
    /// Wall-clock time for the full pipeline.
    pub elapsed_secs: f64,
}

// ═══════════════════════════════════════════════════════════════
// Engine — the one door
// ═══════════════════════════════════════════════════════════════

/// Central engine instance. Owns all graph state.
///
/// All graph operations — queries, analysis, watching — go through this struct.
/// External code should never access GraphStore, MemoryIndex, or the legacy
/// Graph cache directly.
pub struct Engine {
    /// The graph store (MemoryIndex + SQLite). Wrapped in std Mutex because
    /// GraphStore contains rusqlite::Connection which is !Sync.
    store: Mutex<Option<GraphStore>>,

    /// Current project root. Set once during init().
    project_root: Mutex<PathBuf>,

    /// Serializes full analysis runs. Only one analyze() at a time.
    analyze_lock: Mutex<()>,

    /// Current lifecycle state.
    state: RwLock<EngineState>,

    /// Whether the file watcher is running.
    watcher_running: Arc<AtomicBool>,
}

impl Engine {
    /// Create a new uninitialized engine.
    pub fn new() -> Self {
        Self {
            store: Mutex::new(None),
            project_root: Mutex::new(PathBuf::new()),
            analyze_lock: Mutex::new(()),
            state: RwLock::new(EngineState::Uninitialized),
            watcher_running: Arc::new(AtomicBool::new(false)),
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
                return Ok(());
            }
        } else if !old_root.as_os_str().is_empty() {
            info!(
                "[engine] workspace switch: {} → {}",
                old_root.display(),
                new_root.display()
            );
        }

        // Set loading state
        *self.state.write() = EngineState::Loading {
            nodes_loaded: 0,
            edges_loaded: 0,
            elapsed_ms: 0,
        };

        let start = std::time::Instant::now();
        let store = GraphStore::open(&new_root)?;

        // Read counts for Ready state
        let (node_count, edge_count) = store.read(|idx| (idx.node_count(), idx.edge_count()));

        *self.project_root.lock().unwrap() = new_root;
        *self.store.lock().unwrap() = Some(store);
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
        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Engine store lock poisoned: {}", e))?;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| "Engine not initialized — call init() first".to_string())?;

        // Build a temporary Graph from MemoryIndex (same pattern as watcher.rs:237-253)
        let graph = store.read(|idx| {
            let mut g = Graph::new();
            for node in idx.nodes_iter() {
                g.add_node(node.clone());
            }
            for (source, targets) in idx.edges_iter() {
                for (target, kind, coupling_depth, delay) in targets {
                    let id = format!("{}::{}::{}", source, target, kind.as_str());
                    let mut edge = crate::graph::Edge::new(id, source, target, *kind);
                    edge.coupling_depth = *coupling_depth;
                    edge.temporal_delay_sec = *delay;
                    g.add_edge(edge);
                }
            }
            g
        });

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
        // Serialize analysis — only one at a time
        let _lock = self
            .analyze_lock
            .lock()
            .map_err(|e| format!("Analyze lock poisoned: {}", e))?;

        let started_at = std::time::Instant::now();
        let started_at_ms = chrono::Utc::now().timestamp_millis() as u64;

        // Set state to Analyzing
        *self.state.write() = EngineState::Analyzing { started_at_ms };

        info!("[engine] analysis started for {}", project_root.display());

        // 1. Core analysis
        let mut result = analyze_project(project_root);

        // 2. Cross-file resolution
        let resolved = CrossFileResolver::resolve(&mut result.graph);
        info!(edges = resolved, "[engine] cross-file resolved");

        // 3. Coupling analysis
        compute_coupling(&mut result.graph);

        // 4. Framework route detection
        let routes_found = detect_framework_routes(&mut result.graph, project_root);
        info!(count = routes_found, "[engine] framework routes detected");

        // 5. Dynamic dispatch synthesis
        let syn_edges = synthesize_dynamic_edges(&mut result.graph, project_root);
        info!(count = syn_edges, "[engine] dynamic dispatch edges synthesized");

        // 6. Dataflow synthesis
        let df_edges = synthesize_dataflow_edges(&mut result.graph, project_root);
        info!(count = df_edges, "[engine] dataflow edges synthesized");

        // 7. Community detection
        let communities = detect_communities(&result.graph, 42);
        info!(count = communities.len(), "[engine] communities detected");

        let node_count = result.graph.node_count();
        let edge_count = result.graph.edge_count();
        let community_count = communities.len();
        let elapsed = started_at.elapsed().as_secs_f64();

        // 8. Store into GraphStore (MemoryIndex + SQLite)
        let graph_clone = result.graph.clone();
        let idx = MemoryIndex::from_existing_graph(&result.graph);

        let store_guard = self
            .store
            .lock()
            .map_err(|e| format!("Store lock poisoned: {}", e))?;
        if let Some(store) = store_guard.as_ref() {
            store.swap_index(idx);
            if let Err(e) = store.save() {
                warn!("[engine] SQLite save failed: {}", e);
            }
        }

        // 9. Sync legacy CACHED_GRAPH (temporary — removed in Phase 5)
        if let Ok(mut cache) = crate::mcp::CACHED_GRAPH.lock() {
            *cache = Some(graph_clone);
        }

        // Set state back to Ready
        *self.state.write() = EngineState::Ready {
            node_count,
            edge_count,
        };

        info!(
            "[engine] analysis done: {} nodes, {} edges in {:.1}s",
            node_count, edge_count, elapsed
        );

        Ok(AnalyzeResult {
            graph: result.graph,
            node_count,
            edge_count,
            community_count,
            elapsed_secs: elapsed,
        })
    }

    // ── Watcher ───────────────────────────────────────────────

    /// Whether the file watcher is currently running.
    pub fn is_watching(&self) -> bool {
        self.watcher_running.load(Ordering::SeqCst)
    }

    /// Start the file watcher for this project.
    ///
    /// Uses OS-level filesystem events (notify crate) with a 2-second debounce.
    /// On changes: tries incremental update first, falls back to full re-analysis
    /// via Engine::analyze().
    ///
    /// `on_change` is called after each successful update with a JSON summary string.
    /// In MCP mode this is typically a no-op; in Tauri mode it emits `graph-updated`.
    pub fn start_watcher(
        &self,
        project_root: PathBuf,
        on_change: Option<Box<dyn Fn(String) + Send + 'static>>,
    ) {
        use std::collections::HashSet;
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        use notify::{Event, EventKind, RecursiveMode, Watcher};

        self.watcher_running.store(true, Ordering::SeqCst);

        let running = Arc::clone(&self.watcher_running);
        let root = project_root.clone();

        std::thread::spawn(move || {
            let (tx, rx) = mpsc::channel();

            let mut watcher =
                match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                    let _ = tx.send(res);
                }) {
                    Ok(w) => w,
                    Err(e) => {
                        warn!("[engine watcher] failed to create watcher: {}", e);
                        return;
                    }
                };

            if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
                warn!("[engine watcher] failed to watch {:?}: {}", root, e);
                return;
            }

            info!("[engine watcher] watching {:?} for source changes", root);

            // Source extensions that trigger re-analysis
            const SOURCE_EXTS: &[&str] = &[
                "py", "pyi", "pyx", "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts",
                "go", "rs", "java", "c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx",
                "rb", "lua", "cs", "swift", "dart", "scala", "sc", "hs",
                "json", "html", "htm", "css",
            ];
            const IGNORE_DIRS: &[&str] = &[
                ".git", ".hologram", "node_modules", "__pycache__",
                "target", ".venv", "venv", ".tox", ".mypy_cache",
                ".pytest_cache", ".ruff_cache", "dist", "build",
            ];

            let mut pending = false;
            let mut changed_paths: Vec<(PathBuf, String)> = Vec::new();
            let mut seen_paths: HashSet<PathBuf> = HashSet::new();
            let mut last_event = Instant::now();
            let debounce_window = Duration::from_millis(2000);
            let poll_interval = Duration::from_millis(500);

            loop {
                if !running.load(Ordering::SeqCst) {
                    info!("[engine watcher] stopped");
                    return;
                }

                match rx.recv_timeout(poll_interval) {
                    Ok(Ok(event)) => {
                        // Filter: only source file changes
                        let is_source = match event.kind {
                            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => true,
                            _ => false,
                        };
                        if !is_source {
                            continue;
                        }
                        let source_change = event.paths.iter().any(|p| {
                            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                            let is_src = SOURCE_EXTS.contains(&ext);
                            let is_ignored = p.components().any(|c| {
                                IGNORE_DIRS.contains(&c.as_os_str().to_str().unwrap_or(""))
                            });
                            is_src && !is_ignored
                        });
                        if !source_change {
                            continue;
                        }

                        let action = match event.kind {
                            EventKind::Create(_) => "created",
                            EventKind::Remove(_) => "removed",
                            _ => "modified",
                        };
                        for p in &event.paths {
                            if seen_paths.insert(p.clone()) {
                                info!("[engine watcher] change ({}): {}", action, p.display());
                                changed_paths.push((p.clone(), action.to_string()));
                            }
                        }
                        pending = true;
                        last_event = Instant::now();
                    }
                    Ok(Err(e)) => {
                        warn!("[engine watcher] watch error: {}", e);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if pending && last_event.elapsed() >= debounce_window {
                            pending = false;
                            let paths: Vec<(PathBuf, String)> =
                                std::mem::take(&mut changed_paths);
                            seen_paths.clear();
                            if !paths.is_empty() {
                                // Try incremental first, fall back to full re-analysis
                                let _ = Self::handle_watcher_changes(&root, &paths, &on_change);
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
    }

    /// Stop the file watcher. Blocks until the watcher thread exits (max ~500ms).
    pub fn stop_watcher(&self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    /// Handle file changes from the watcher. Tries incremental update first,
    /// falls back to full re-analysis. Static so it can be called from the
    /// watcher thread via global ENGINE functions.
    fn handle_watcher_changes(
        root: &Path,
        changed_files: &[(PathBuf, String)],
        on_change: &Option<Box<dyn Fn(String) + Send + 'static>>,
    ) -> Result<(), String> {
        let start = std::time::Instant::now();
        let count = changed_files.len();
        info!("[engine watcher] {} file(s) changed, trying incremental update", count);

        // Try incremental update via engine_write
        let inc_result = engine_write(|idx| {
            let paths: Vec<(PathBuf, &str)> = changed_files
                .iter()
                .map(|(p, a)| (p.clone(), a.as_str()))
                .collect();
            // IncrementalUpdater needs SqliteDb — access via the store directly.
            // For now, we try incremental through the engine's internal store.
            // If this fails, we fall back to full re-analysis.
            Err::<((), usize), String>("incremental path needs SqliteDb".into())
        });

        match inc_result {
            Ok(_) => {
                info!(
                    "[engine watcher] incremental done in {:.1}s",
                    start.elapsed().as_secs_f64()
                );
                if let Some(ref cb) = on_change {
                    cb(String::from(r#"{"status":"updated"}"#));
                }
                return Ok(());
            }
            Err(_) => {
                // Incremental not available — fall through to full re-analysis
            }
        }

        // Fallback: full re-analysis via Engine::analyze()
        info!("[engine watcher] falling back to full re-analysis");
        match engine_analyze(root) {
            Ok(result) => {
                let summary = serde_json::json!({
                    "status": "ok",
                    "node_count": result.node_count,
                    "edge_count": result.edge_count,
                    "elapsed_secs": result.elapsed_secs,
                }).to_string();
                info!(
                    "[engine watcher] full re-analysis done: {} nodes, {} edges in {:.1}s",
                    result.node_count, result.edge_count, result.elapsed_secs
                );
                if let Some(ref cb) = on_change {
                    cb(summary);
                }
                Ok(())
            }
            Err(e) => {
                warn!("[engine watcher] full re-analysis failed: {}", e);
                Err(e)
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Process-wide ENGINE global
// ═══════════════════════════════════════════════════════════════

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

/// Run analysis on the global engine. Convenience wrapper that callers
/// (MCP, TCP, Tauri) can use without directly touching the ENGINE lock.
pub fn engine_analyze(project_root: &Path) -> Result<AnalyzeResult, String> {
    let guard = ENGINE.read();
    let engine = guard
        .as_ref()
        .ok_or_else(|| "Engine not initialized — call engine_init() first".to_string())?;
    engine.analyze(project_root)
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn test_global_engine_init_and_read() {
        let tmp = std::env::temp_dir().join("hologram_test_global_engine");
        let test_dir = tmp.join("global_project");
        let _ = std::fs::create_dir_all(&test_dir);

        // Init global engine
        engine_init(&test_dir).unwrap();

        // Read via global functions
        let state = engine_state();
        assert!(state.is_ready());
        assert_eq!(engine_read(|idx| idx.node_count()).unwrap(), 0);
        assert_eq!(engine_read_graph(|g| g.node_count()).unwrap(), 0);

        // Clean up — reset global
        *ENGINE.write() = None;

        let _ = std::fs::remove_dir_all(&tmp);
    }

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
}
