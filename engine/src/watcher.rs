// File watcher for MCP serve mode.
// Watches the project directory for source file changes,
// debounces them, then re-analyzes and hot-reloads CACHED_GRAPH.
//
// Only watches known source extensions (same as discovery phase).
//
// Supports watcher lifecycle: start_watcher() spawns a thread;
// stop_watcher() signals it to exit (used when switching projects).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use tracing::{info, warn};

use crate::analysis::coupling::compute_coupling;
use crate::community::detect_communities;
use crate::graph::CrossFileResolver;
use crate::mcp::{CACHED_GRAPH, ANALYZE_LOCK};
use crate::pipeline::runner::analyze_project;

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

/// Shared stop signal. Set to true to stop the currently running watcher thread.
static STOP_FLAG: AtomicBool = AtomicBool::new(false);

/// Signal the current watcher to stop. Returns after a brief pause so the
/// thread has time to notice the flag and exit.
pub fn stop_watcher() {
    STOP_FLAG.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(200));
}

/// Start a background file watcher on the given project root.
///
/// On any source file change, debounces for 2 seconds then re-runs
/// the full analysis pipeline and swaps the cached graph atomically.
///
/// The thread checks STOP_FLAG each loop iteration and exits cleanly
/// when signaled via stop_watcher().
pub fn start_watcher(project_root: PathBuf) {
    // Reset stop flag before starting
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

        // Watch recursively, ignoring non-source dirs
        if let Err(e) = watcher.watch(&project_root, RecursiveMode::Recursive) {
            warn!("[watcher] failed to watch {:?}: {}", project_root, e);
            return;
        }

        info!("[watcher] watching {:?} for source changes", project_root);

        let mut pending = false;
        let mut last_event = Instant::now();
        let debounce_window = Duration::from_millis(2000);
        let poll_interval = Duration::from_millis(500);

        loop {
            // Check stop signal
            if STOP_FLAG.load(Ordering::SeqCst) {
                info!("[watcher] stopped (requested by engine)");
                return;
            }

            match rx.recv_timeout(poll_interval) {
                Ok(Ok(event)) => {
                    if !is_source_change(&event) {
                        continue;
                    }
                    if !pending {
                        for p in &event.paths {
                            info!("[watcher] change: {}", p.display());
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
                        do_reanalyze(&project_root);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

/// Returns true if the event is a source file modification we care about.
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

/// Re-run the full analysis pipeline and swap the cached graph.
fn do_reanalyze(root: &std::path::Path) {
    // Try to acquire analyze lock to avoid racing with MCP tool_analyze.
    // If another analysis is in progress, skip this watcher-triggered run.
    let lock = match ANALYZE_LOCK.try_lock() {
        Ok(l) => l,
        Err(_) => {
            info!("[watcher] analysis already in progress, skipping re-analyze");
            return;
        }
    };

    info!("[watcher] re-analyzing project...");
    let start = Instant::now();

    let mut result = analyze_project(root);
    CrossFileResolver::resolve(&mut result.graph);
    compute_coupling(&mut result.graph);
    detect_communities(&result.graph, 42);

    let nodes = result.graph.node_count();
    let edges = result.graph.edge_count();

    if let Ok(mut cache) = CACHED_GRAPH.lock() {
        *cache = Some(result.graph);
    }

    drop(lock);

    info!(
        "[watcher] re-analysis done: {} nodes, {} edges in {:.1}s",
        nodes,
        edges,
        start.elapsed().as_secs_f64()
    );
}
