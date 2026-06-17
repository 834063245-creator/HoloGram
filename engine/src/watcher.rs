// File watcher for MCP serve mode.
// Watches the project directory for source file changes,
// debounces them, then incrementally updates the graph (with full fallback).
//
// Only watches known source extensions (same as discovery phase).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use tracing::{info, warn};

use crate::analysis::coupling::compute_coupling;
use crate::community::detect_communities;
use crate::graph::CrossFileResolver;
use crate::mcp::{CACHED_GRAPH, ANALYZE_LOCK, GRAPH_STORE};
use crate::pipeline::runner::analyze_project;
use crate::storage::{IncrementalUpdater, MemoryIndex};

/// Known source file extensions that trigger re-analysis.
const SOURCE_EXTS: &[&str] = &[
    "py", "pyi", "pyx",
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts",
    "go", "rs", "java",
    "c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx",
    "rb", "lua",
];

/// Directories to ignore during watching.
const IGNORE_DIRS: &[&str] = &[
    ".git", ".hologram", "node_modules", "__pycache__",
    "target", ".venv", "venv", ".tox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "dist", "build",
];

/// Shared stop signal.
static STOP_FLAG: AtomicBool = AtomicBool::new(false);

pub fn stop_watcher() {
    STOP_FLAG.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(200));
}

/// Start a background file watcher. On change, tries incremental update first;
/// falls back to full re-analysis if incremental fails or no existing index.
pub fn start_watcher(project_root: PathBuf) {
    STOP_FLAG.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();

        let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                warn!("[watcher] failed to create watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&project_root, RecursiveMode::Recursive) {
            warn!("[watcher] failed to watch {:?}: {}", project_root, e);
            return;
        }

        info!("[watcher] watching {:?} for source changes", project_root);

        let mut pending = false;
        let mut changed_paths: Vec<(PathBuf, String)> = Vec::new(); // (path, action)
        let mut seen_paths: HashSet<PathBuf> = HashSet::new();
        let mut last_event = Instant::now();
        let debounce_window = Duration::from_millis(2000);
        let poll_interval = Duration::from_millis(500);

        loop {
            if STOP_FLAG.load(Ordering::SeqCst) {
                info!("[watcher] stopped");
                return;
            }

            match rx.recv_timeout(poll_interval) {
                Ok(Ok(event)) => {
                    if !is_source_change(&event) {
                        continue;
                    }
                    let action = event_action(&event);
                    for p in &event.paths {
                        if seen_paths.insert(p.clone()) {
                            info!("[watcher] change ({}): {}", action, p.display());
                            changed_paths.push((p.clone(), action.to_string()));
                        }
                    }
                    pending = true;
                    last_event = Instant::now();
                }
                Ok(Err(e)) => {
                    warn!("[watcher] watch error: {}", e);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if pending && last_event.elapsed() >= debounce_window {
                        pending = false;
                        let paths = std::mem::take(&mut changed_paths);
                        seen_paths.clear();
                        if !paths.is_empty() {
                            do_update(&project_root, &paths);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

fn event_action(event: &Event) -> &str {
    match event.kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "removed",
        _ => "modified",
    }
}

fn is_source_change(event: &Event) -> bool {
    match event.kind {
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {}
        _ => return false,
    }
    event.paths.iter().any(|p| {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let is_source = SOURCE_EXTS.contains(&ext);
        let is_ignored = p
            .components()
            .any(|c| IGNORE_DIRS.contains(&c.as_os_str().to_str().unwrap_or("")));
        is_source && !is_ignored
    })
}

/// Try incremental update first. Fall back to full re-analysis on failure.
fn do_update(root: &std::path::Path, changed_files: &[(PathBuf, String)]) {
    let lock = match ANALYZE_LOCK.try_lock() {
        Ok(l) => l,
        Err(_) => {
            info!("[watcher] analysis already in progress, skipping");
            return;
        }
    };

    let start = Instant::now();
    info!("[watcher] {} file(s) changed, trying incremental update", changed_files.len());

    // Try incremental path if GraphStore is initialized
    if let Some(store_mtx) = GRAPH_STORE.get() {
        if let Ok(store) = store_mtx.lock() {
            let old_edge_count = store.read(|idx| idx.edge_count());
            let update_result = store.write(|idx| {
                let paths: Vec<(PathBuf, &str)> = changed_files
                    .iter()
                    .map(|(p, a)| (p.clone(), a.as_str()))
                    .collect();
                IncrementalUpdater::update(&paths, idx, root, &store.db)
            });

            match update_result {
                Ok((new_idx, errors)) => {
                    let new_nodes = new_idx.node_count();
                    let new_edges = new_idx.edge_count();
                    store.swap_index(new_idx);
                    drop(lock);
                    info!(
                        "[watcher] incremental done: {} nodes, {} edges ({} parse errs) in {:.1}s",
                        new_nodes,
                        new_edges,
                        errors,
                        start.elapsed().as_secs_f64()
                    );
                    // Sync CACHED_GRAPH from new index (backward compat)
                    sync_cached_graph_from_store(&store);
                    return;
                }
                Err(e) => {
                    warn!(
                        "[watcher] incremental failed ({}), falling back to full re-analysis",
                        e
                    );
                }
            }
        }
    }

    // Fallback: full re-analysis
    full_reanalyze(root);
    drop(lock);
}

/// Full re-analysis (original behavior, now a fallback).
fn full_reanalyze(root: &std::path::Path) {
    info!("[watcher] full re-analysis...");
    let start = Instant::now();

    let mut result = analyze_project(root);
    CrossFileResolver::resolve(&mut result.graph);
    compute_coupling(&mut result.graph);
    detect_communities(&result.graph, 42);

    let nodes = result.graph.node_count();
    let edges = result.graph.edge_count();

    if let Some(store_mtx) = GRAPH_STORE.get() {
        if let Ok(store) = store_mtx.lock() {
            let idx = MemoryIndex::from_existing_graph(&result.graph);
            store.swap_index(idx);
            let _ = store.save();
        }
    }
    if let Ok(mut cache) = CACHED_GRAPH.lock() {
        *cache = Some(result.graph);
    }

    info!(
        "[watcher] full re-analysis done: {} nodes, {} edges in {:.1}s",
        nodes,
        edges,
        start.elapsed().as_secs_f64()
    );
}

/// Sync CACHED_GRAPH from GraphStore's MemoryIndex (backward compat).
fn sync_cached_graph_from_store(store: &crate::storage::GraphStore) {
    // Build a legacy Graph from MemoryIndex for CACHED_GRAPH compatibility
    let mut g = crate::graph::Graph::new();
    store.read(|idx| {
        for node in idx.nodes_iter() {
            g.add_node(node.clone());
        }
        for (source, targets) in idx.edges_iter() {
            for (target, kind, coupling_depth) in targets {
                let id = format!("{}::{}::{}", source, target, kind.as_str());
                let mut edge = crate::graph::Edge::new(id, source, target, *kind);
                edge.coupling_depth = *coupling_depth;
                g.add_edge(edge);
            }
        }
    });
    if let Ok(mut cache) = CACHED_GRAPH.lock() {
        *cache = Some(g);
    }
}
