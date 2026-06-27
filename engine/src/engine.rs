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
use tracing::{info, warn};

use crate::adapter::c_lsp::run_c_lsp;
use crate::adapter::cs_lsp::run_cs_lsp;
use crate::adapter::go_lsp::run_go_lsp;
use crate::adapter::java_lsp::run_java_lsp;
use crate::adapter::kotlin_lsp::run_kotlin_lsp;
use crate::adapter::php_lsp::run_php_lsp;
use crate::adapter::python_lsp::run_py_lsp;
use crate::adapter::ts_lsp::run_ts_lsp;
use crate::adapter::type_registry::TypeRegistry;
use crate::analysis::coupling::compute_coupling;
use crate::analysis::dataflow_synthesis::synthesize_dataflow_edges;
use crate::analysis::dynamic_dispatch::synthesize_dynamic_edges;
use crate::analysis::framework_routes::detect_framework_routes;
use crate::community::detect_communities_and_hierarchy;
use crate::graph::resolver::CrossFileResolver;
use crate::graph::{EdgeKind, Graph};
use crate::pipeline::runner::analyze_project;
use crate::storage::{GraphStore, MemoryIndex, SqliteDb};
use crate::storage::incremental::IncrementalUpdater;
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

    /// Current lifecycle state.
    state: RwLock<EngineState>,

    /// Whether the file watcher is running.
    watcher_running: Arc<AtomicBool>,

    /// JoinHandle for the watcher thread. Used by stop_watcher() to confirm
    /// the old thread has exited before starting a new one.
    watcher_handle: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Engine {
    /// Create a new uninitialized engine.
    pub fn new() -> Self {
        Self {
            store: Mutex::new(None),
            timeline_conn: Mutex::new(None),
            project_root: Mutex::new(PathBuf::new()),
            analyze_lock: Mutex::new(()),
            state: RwLock::new(EngineState::Uninitialized),
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_handle: Mutex::new(None),
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
        // Serialize analysis — only one at a time
        let _lock = self
            .analyze_lock
            .lock()
            .map_err(|e| format!("Analyze lock poisoned: {}", e))?;

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

        // Per-stage timing collector
        let mut stage_timings: Vec<StageTiming> = Vec::new();

        // 1. Core analysis (parse cache included for downstream synthesis)
        set_progress("解析文件", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let mut result = analyze_project(project_root);
        eprintln!("[engine] stage: core-parse done in {:.1}s ({} nodes, {} edges, {} files)",
            stage_start.elapsed().as_secs_f64(), result.graph.node_count(), result.graph.edge_count(), result.files_parsed);
        stage_timings.push(StageTiming {
            name: "Core Parse".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} files, {} nodes, {} edges", result.files_parsed, result.graph.node_count(), result.graph.edge_count()),
        });
        // Detach parse_cache + discovered_files so they can be moved into the
        // LSP thread (which needs 'static). Re-attached after LSP completes.
        let mut parse_cache = std::mem::take(&mut result.parse_cache);
        let mut discovered_files = std::mem::take(&mut result.discovered_files);
        set_progress("解析完成", result.files_parsed, result.files_parsed, "");

        // 1.5. Type-aware LSP call resolution (before cross-file resolution)
        // Run on a dedicated thread with a large stack: process_function and
        // process_class are mutually recursive, and eval_expr_type recurses too.
        // On Windows the main thread is stuck with ~1 MB which overflows on
        // deeply nested ASTs (hang, not crash — Windows swallows SIGSEGV).
        set_progress("类型感知解析", 0, 0, "");
        let project_root_buf = project_root.to_path_buf();
        let mut graph_for_lsp = std::mem::take(&mut result.graph);
        let (tx, rx) = std::sync::mpsc::channel();
        let builder = std::thread::Builder::new().stack_size(16 * 1024 * 1024);
        let handle = builder.spawn(move || {
            let r = resolve_calls_lsp(&mut graph_for_lsp, &parse_cache, &discovered_files, &project_root_buf);
            let _ = tx.send((graph_for_lsp, parse_cache, discovered_files, r));
        });
        let lsp_resolved = match handle {
            Ok(h) => {
                h.join().ok();
                match rx.recv() {
                    Ok((g, pc, df, r)) => {
                        result.graph = g;
                        result.parse_cache = pc;
                        result.discovered_files = df;
                        r
                    }
                    Err(_) => {
                        warn!("[engine] LSP thread did not report back — skipping LSP pass");
                        0
                    }
                }
            }
            Err(_) => {
                warn!("[engine] LSP thread spawn failed — skipping LSP pass");
                0
            }
        };
        info!(edges = lsp_resolved, "[engine] LSP type-resolved call edges");
        eprintln!("[engine] stage: LSP done in {:.1}s ({} resolved)",
            stage_start.elapsed().as_secs_f64(), lsp_resolved);
        // Note: LSP stage_start was set before the thread spawn at line ~376,
        // but it was shadowed by later stage_starts. We record from the
        // core-parse stage_start to here as a combined parse+LSP span.
        // For per-stage LSP timing, we use the sub-timing below.
        // ponytail: LSP timing is measured from core-parse start because
        // the stage_start variable is reused. A follow-up can add a dedicated
        // LSP timer. For now, the core-parse stage covers discovery+parse+LSP.

        // 2. Cross-file resolution
        set_progress("跨文件解析", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let resolved = CrossFileResolver::resolve(&mut result.graph);
        info!(edges = resolved, "[engine] cross-file resolved");
        eprintln!("[engine] stage: cross-file done in {:.1}s ({} edges resolved)",
            stage_start.elapsed().as_secs_f64(), resolved);
        stage_timings.push(StageTiming {
            name: "Cross-File".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges resolved", resolved),
        });

        // 3. Coupling analysis
        set_progress("耦合分析", 0, 0, "");
        let stage_start = std::time::Instant::now();
        compute_coupling(&mut result.graph);
        eprintln!("[engine] stage: coupling done in {:.1}s",
            stage_start.elapsed().as_secs_f64());
        stage_timings.push(StageTiming {
            name: "Coupling".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: String::new(),
        });

        // 4. Framework route detection (uses parse cache + discovered files to avoid re-walkdir)
        set_progress("框架路由检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let routes_found = detect_framework_routes(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        info!(count = routes_found, "[engine] framework routes detected");
        eprintln!("[engine] stage: framework-routes done in {:.1}s ({} routes)",
            stage_start.elapsed().as_secs_f64(), routes_found);
        stage_timings.push(StageTiming {
            name: "Framework Routes".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} routes", routes_found),
        });

        // 5. Dynamic dispatch synthesis (uses parse cache + discovered files)
        set_progress("动态调度合成", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let syn_edges = synthesize_dynamic_edges(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        info!(count = syn_edges, "[engine] dynamic dispatch edges synthesized");
        eprintln!("[engine] stage: dynamic-dispatch done in {:.1}s ({} edges)",
            stage_start.elapsed().as_secs_f64(), syn_edges);
        stage_timings.push(StageTiming {
            name: "Dynamic Dispatch".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges", syn_edges),
        });

        // 6. Dataflow synthesis (uses parse cache + discovered files)
        set_progress("数据流合成", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let df_edges = synthesize_dataflow_edges(&mut result.graph, project_root, &result.parse_cache, &result.discovered_files);
        info!(count = df_edges, "[engine] dataflow edges synthesized");
        eprintln!("[engine] stage: dataflow done in {:.1}s ({} edges)",
            stage_start.elapsed().as_secs_f64(), df_edges);
        stage_timings.push(StageTiming {
            name: "Dataflow".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: format!("{} edges", df_edges),
        });

        // ponytail: release parse_cache (source + CST) after synthesis —
        // for large C projects this is 2+ GB of tree-sitter trees no longer needed.
        result.parse_cache.clear();
        result.parse_cache.shrink_to_fit();

        // 7. Community detection (Leiden — single pass for flat + hierarchical)
        set_progress("社区检测", 0, 0, "");
        let stage_start = std::time::Instant::now();
        let (communities, hierarchical) = detect_communities_and_hierarchy(&result.graph, 42);
        let community_count = communities.len();
        let hc_count = hierarchical.iter().filter(|c| c.level > 0).count();
        let leiden_elapsed = stage_start.elapsed().as_secs_f64();
        info!(count = community_count, super_levels = hc_count, "[engine] Leiden communities detected");
        eprintln!("[engine] stage: community done in {:.1}s ({} communities, {} super)",
            leiden_elapsed, community_count, hc_count);
        stage_timings.push(StageTiming {
            name: "Community (Leiden)".into(),
            elapsed_secs: leiden_elapsed,
            detail: format!("{} communities, {} super", community_count, hc_count),
        });
        // Assign community_id back to each node (Level 0 = base community index)
        for (comm_idx, comm) in communities.iter().enumerate() {
            for node_id in comm {
                if let Some(node) = result.graph.nodes.get_mut(node_id) {
                    node.community_id = Some(comm_idx);
                }
            }
        }

        let node_count = result.graph.node_count();
        let edge_count = result.graph.edge_count();
        let elapsed = started_at.elapsed().as_secs_f64();

        // 8. Store into GraphStore (MemoryIndex + SQLite) — atomic swap+save
        set_progress("写入数据库", 0, 0, "");
        let stage_start = std::time::Instant::now();
        // Drain graph into MemoryIndex — edges consumed one-by-one, no duplicate allocation
        let graph_nodes = std::mem::take(&mut result.graph.nodes);
        let graph_edges = std::mem::take(&mut result.graph.edges);
        let idx = MemoryIndex::from_existing_graph(graph_nodes, graph_edges);

        {
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
        }
        eprintln!("[engine] stage: db-save done in {:.1}s",
            stage_start.elapsed().as_secs_f64());
        stage_timings.push(StageTiming {
            name: "DB Save".into(),
            elapsed_secs: stage_start.elapsed().as_secs_f64(),
            detail: String::new(),
        });

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
            hierarchical_communities: hierarchical,
            elapsed_secs: elapsed,
            stage_timings,
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
        // Guard: don't start a second watcher if one is already running
        if self.is_watching() {
            info!("[engine watcher] already watching, skipping duplicate start");
            return;
        }

        use std::collections::HashSet;
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        use notify::{Event, EventKind, RecursiveMode, Watcher};

        self.watcher_running.store(true, Ordering::SeqCst);

        let running = Arc::clone(&self.watcher_running);
        let root = project_root.clone();

        let handle = std::thread::spawn(move || {
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

                        use notify::event::{ModifyKind, RenameMode};
                        let action = match event.kind {
                            EventKind::Create(_) => "created",
                            EventKind::Remove(_) => "removed",
                            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => "removed",
                            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => "created",
                            EventKind::Modify(ModifyKind::Name(_)) => "modified",
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
        if let Ok(mut guard) = self.watcher_handle.lock() {
            *guard = Some(handle);
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

    /// Stop the file watcher. Joins the watcher thread to guarantee it has exited
    /// before returning (no blind sleep — the thread signals completion via JoinHandle).
    pub fn stop_watcher(&self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.watcher_handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
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

        // Try incremental update via IncrementalUpdater (accesses store directly)
        let inc_result = (|| -> Result<(), String> {
            let engine_guard = ENGINE.read();
            let engine = engine_guard
                .as_ref()
                .ok_or_else(|| "Engine not initialized".to_string())?;
            let store_guard = engine
                .store
                .lock()
                .map_err(|e| format!("store lock: {}", e))?;
            let store = store_guard
                .as_ref()
                .ok_or_else(|| "Store not initialized".to_string())?;

            let paths: Vec<(PathBuf, &str)> = changed_files
                .iter()
                .map(|(p, a)| (p.clone(), a.as_str()))
                .collect();

            let (new_idx, errors) =
                IncrementalUpdater::update(&paths, &store.index.read(), root, &store.db)?;

            store.swap_index(new_idx);
            if errors > 0 {
                info!("[engine watcher] incremental update with {} parse errors", errors);
            }
            Ok(())
        })();

        match inc_result {
            Ok(()) => {
                let elapsed = start.elapsed().as_secs_f64();
                info!(
                    "[engine watcher] incremental done in {:.1}s",
                    elapsed
                );
                let _ = engine_record_timeline_with_props(
                    "incremental_update",
                    None,
                    &format!("增量更新完成：{} 文件，{:.1}s", count, elapsed),
                    &serde_json::json!({"count": count, "elapsed_secs": elapsed}),
                );
                if let Some(ref cb) = on_change {
                    cb(String::from(r#"{"status":"updated"}"#));
                }
                return Ok(());
            }
            Err(e) => {
                info!(
                    "[engine watcher] incremental failed ({}), falling back to full re-analysis",
                    e
                );
                let _ = engine_record_timeline_with_props(
                    "incremental_fallback",
                    None,
                    &format!("增量失败（{}），回退全量分析", e),
                    &serde_json::json!({"reason": e, "count": count}),
                );
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
                let _ = engine_record_timeline_with_props(
                    "watcher_full_reanalyze",
                    None,
                    &format!("增量回退后全量完成：{} 节点 {} 边 {:.1}s", result.node_count, result.edge_count, result.elapsed_secs),
                    &serde_json::json!({"node_count": result.node_count, "edge_count": result.edge_count, "elapsed_secs": result.elapsed_secs}),
                );
                if let Some(ref cb) = on_change {
                    cb(summary);
                }
                Ok(())
            }
            Err(e) => {
                warn!("[engine watcher] full re-analysis failed: {}", e);
                let _ = engine_record_timeline(
                    "watcher_reanalyze_failed",
                    None,
                    &format!("回退全量也失败：{}", e),
                );
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

// ═══════════════════════════════════════════════════════════════
// LSP Type-Aware Call Resolution
// ═══════════════════════════════════════════════════════════════

use std::collections::HashMap as StHashMap;

/// Map file extension to tree-sitter Language for LSP re-parsing.
/// ponytail: re-parse from source instead of caching CSTs — saves 3+ GB on large projects.
fn language_for_lsp(ext: &str) -> Option<tree_sitter::Language> {
    match ext {
        "py" | "pyi" => Some(tree_sitter_python::LANGUAGE.into()),
        "js" | "jsx" | "mjs" | "cjs" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "ts" | "tsx" | "mts" | "cts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "c" | "h" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "cs" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        // ponytail: kotlin tree-sitter 0.3 depends on tree-sitter 0.20 (not 0.24),
        // Language types are incompatible. Kotlin files aren't parsed by any adapter
        // anyway — LSP has always been a no-op for them.
        // "kt" | "kts" => None,
        _ => None,
    }
}

// Thread-local LSP parser cache — reuses parser across files of the same language.
// ponytail: avoids Parser::new() + set_language() overhead for 64K files.
// Each rayon worker thread gets its own cached parser via thread_local.
thread_local! {
    static TL_LSP_PARSER: std::cell::RefCell<Option<(tree_sitter::Parser, String)>> = std::cell::RefCell::new(None);
}

/// Re-parse source to a tree-sitter Tree. Returns None if language not supported or parse fails.
fn reparse_for_lsp(source: &str, ext: &str) -> Option<tree_sitter::Tree> {
    let lang = language_for_lsp(ext)?;
    TL_LSP_PARSER.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let reuse = borrow.as_ref().map_or(false, |(_, cached)| cached == ext);
        if !reuse {
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(&lang).ok()?;
            *borrow = Some((parser, ext.to_string()));
        }
        let (ref mut parser, _) = borrow.as_mut().unwrap();
        parser.parse(source, None)
    })
}

/// Run LSP type-aware call resolution on all source files in the project.
/// Rewrites CALLS edges in the graph with resolved target QNs.
fn resolve_calls_lsp(
    graph: &mut Graph,
    parse_cache: &std::collections::HashMap<String, (String, Option<tree_sitter::Tree>)>,
    discovered_files: &[std::path::PathBuf],
    _project_root: &Path,
) -> usize {
    // Build TypeRegistry from graph nodes (Tier 2: once for whole project)
    let registry = TypeRegistry::from_graph(graph);
    info!("[engine] LSP registry built");

    // Run LSP per-file. Parallel for large projects (≥2000 files), sequential for small.
    // TypeRegistry and parse_cache are read-only; each file's AST walk is independent.
    // ponytail: rayon threshold=2000. Below this, thread overhead > parallelism gain.
    let per_file_lsp = |file_path: &PathBuf, perf: &std::sync::Mutex<crate::adapter::ts_lsp::TsLspPerf>|
        -> Vec<(String, String)>
    {
        let path_str = file_path.to_string_lossy().replace('\\', "/");
        let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();
        if !matches!(
            ext.as_str(),
            "py" | "pyi" | "go" | "java" | "cs" | "ts" | "tsx" | "js" | "jsx"
            | "mjs" | "cjs" | "mts" | "cts" | "c" | "h" | "cpp" | "hpp" | "cc"
            | "hh" | "cxx" | "hxx" | "php" | "kt" | "kts"
        ) {
            return vec![];
        }
        let abs_path = crate::path_utils::normalize_path(&path_str);
        let Some((source, _)) = parse_cache.get(&abs_path) else {
            return vec![];
        };
        // ponytail: re-parse for LSP — CST not cached (saves 3+ GB on 64K-file projects)
        let Some(tree) = reparse_for_lsp(source, &ext) else {
            return vec![];
        };
        let module_qn = abs_path
            .trim_end_matches(".py").trim_end_matches(".pyi")
            .replace(['/', '\\'], ".");
        let calls = match ext.as_str() {
            "py" | "pyi" => run_py_lsp(source, &tree, &module_qn, &registry),
            "go" => run_go_lsp(source, &tree, &module_qn, &registry),
            "java" => run_java_lsp(source, &tree, &module_qn, &registry),
            "cs" => run_cs_lsp(source, &tree, &module_qn, &registry),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
                let (calls, p) = run_ts_lsp(source, &tree, &module_qn, &registry);
                if let Ok(mut total) = perf.lock() {
                    total.nodes += p.nodes; total.emit += p.emit;
                    total.dedup_scan += p.dedup_scan; total.dedup_hit += p.dedup_hit;
                    total.eval_member += p.eval_member; total.scope_push += p.scope_push;
                    total.cache_hits += p.cache_hits; total.calls_out += p.calls_out;
                }
                calls
            }
            "c" | "h" => run_c_lsp(source, &tree, &module_qn, &registry, false),
            "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => {
                run_c_lsp(source, &tree, &module_qn, &registry, true)
            }
            "php" => run_php_lsp(source, &tree, &module_qn, &registry),
            "kt" | "kts" => run_kotlin_lsp(source, &tree, &module_qn, &registry),
            _ => return vec![],
        };
        calls.into_iter().map(|rc| (rc.caller_qn, rc.callee_qn)).collect()
    };

    let lsp_perf_total = std::sync::Mutex::new(crate::adapter::ts_lsp::TsLspPerf { nodes:0,emit:0,dedup_scan:0,dedup_hit:0,eval_member:0,scope_push:0,cache_hits:0,calls_out:0 });
    let all_resolved: Vec<(String, String)> = if discovered_files.len() < 2000 {
        let mut results = Vec::new();
        for file_path in discovered_files {
            results.extend(per_file_lsp(file_path, &lsp_perf_total));
        }
        results
    } else {
        use rayon::prelude::*;
        discovered_files
            .par_iter()
            .with_min_len(256)
            .flat_map(|fp| per_file_lsp(fp, &lsp_perf_total))
            .collect()
    };

    // Build caller edge index for O(1) lookup during rewriting.
    let mut caller_index: StHashMap<String, Vec<(String, String)>> = StHashMap::new();
    for (eid, edge) in &graph.edges {
        if edge.kind != EdgeKind::Calls {
            continue;
        }
        let target_short = edge.target.rsplit('.').next().unwrap_or(&edge.target).to_string();
        caller_index
            .entry(edge.source.clone())
            .or_default()
            .push((eid.clone(), target_short));
    }

    // Rewrite edges in the main-thread graph.
    let mut total_resolved = 0usize;
    for (caller_qn, callee_qn) in &all_resolved {
        let callee_short = callee_qn.rsplit('.').next().unwrap_or(callee_qn);
        let Some(candidates) = caller_index.get(caller_qn) else {
            continue;
        };
        for (eid, short_name) in candidates {
            if short_name != callee_short {
                continue;
            }
            if let Some(edge) = graph.edges.get_mut(eid) {
                edge.target = callee_qn.clone();
                edge.lsp_resolved = true;
                total_resolved += 1;
                break;
            }
        }
    }

    let lsp_perf_total = lsp_perf_total.into_inner().unwrap();
    eprintln!("[engine] LSP perf TOTAL: nodes={:.1}M emit={:.1}K dedup_scan={:.1}M dedup_hit={:.1}K eval_member={:.1}K scope_push={:.1}K cache_hits={:.1}K calls_out={:.1}K",
        lsp_perf_total.nodes as f64 / 1_000_000.0,
        lsp_perf_total.emit as f64 / 1_000.0,
        lsp_perf_total.dedup_scan as f64 / 1_000_000.0,
        lsp_perf_total.dedup_hit as f64 / 1_000.0,
        lsp_perf_total.eval_member as f64 / 1_000.0,
        lsp_perf_total.scope_push as f64 / 1_000.0,
        lsp_perf_total.cache_hits as f64 / 1_000.0,
        lsp_perf_total.calls_out as f64 / 1_000.0);

    total_resolved
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
        use crate::storage::sqlite::SqliteDb;

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
        use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};
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
}
