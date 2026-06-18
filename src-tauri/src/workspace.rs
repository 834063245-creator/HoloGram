// WorkspaceHandle — owns all backend state for one open project.
// Replaces the scattered globals: ACTIVE_PROJECT, SANDBOX, AUDIT_LOGGER,
// LAST_CHANGED_FILES, WatcherState.
//
// Lifecycle:
//   let mut handle = WorkspaceHandle::new(path);
//   handle.activate(project_root);           // register as active
//   handle.start_watcher(app_handle);       // begin file monitoring
//   // ... user works ...
//   handle.deactivate();                     // stop watcher, clear state
//
// Managed as Tauri state: State<Arc<Mutex<Option<WorkspaceHandle>>>>

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::sandbox::{Sandbox, SandboxResult};
use crate::audit::{AuditEntry, AuditLogger, now_iso};

// ── Workspace-scoped state ──────────────────────────────────────────

pub struct WorkspaceHandle {
    /// Canonical workspace directory.
    pub path: String,

    /// File access sandbox — all file I/O goes through this.
    pub sandbox: Sandbox,

    /// Append-only operation audit log.
    pub audit_logger: AuditLogger,

    /// Changed files since last check (was LAST_CHANGED_FILES global).
    pub changed_files: Arc<Mutex<Vec<String>>>,

    // Watcher internals
    watcher_running: Arc<AtomicBool>,
    watcher_thread: Option<JoinHandle<()>>,
}

impl WorkspaceHandle {
    /// Create a new workspace handle. Does NOT activate it or start the watcher.
    pub fn new(path: &str) -> Self {
        let project_path = Path::new(path);
        Self {
            path: path.to_string(),
            sandbox: Sandbox::new(project_path),
            audit_logger: AuditLogger::new(project_path),
            changed_files: Arc::new(Mutex::new(Vec::new())),
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_thread: None,
        }
    }

    /// Activate this workspace: register as the active project and persist to disk.
    /// Called once when the workspace is first opened.
    pub fn activate(&self, active_project: &Mutex<String>, project_root: &Path) {
        // Set the active project path (was ACTIVE_PROJECT global)
        *active_project.lock().unwrap() = self.path.clone();

        // Persist to .last_project for cold-start recovery
        let last_path = project_root.join(".last_project");
        let _ = fs::write(&last_path, &self.path);
    }

    /// Deactivate this workspace: stop the file watcher and clear transient state.
    /// Called before switching to a new workspace or closing the app.
    pub fn deactivate(&mut self) {
        // Signal the watcher thread to stop
        self.watcher_running.store(false, Ordering::SeqCst);

        // Join the watcher thread — guaranteed exit within 1 poll interval (1s)
        if let Some(handle) = self.watcher_thread.take() {
            let _ = handle.join();
        }

        // Clear changed files
        if let Ok(mut files) = self.changed_files.lock() {
            files.clear();
        }
    }

    /// Start the background file watcher for this workspace.
    /// Must be called after activate(). Safe to call if a watcher is already
    /// running — the old one will be stopped and joined first.
    pub fn start_watcher(&mut self, app_handle: AppHandle) {
        // Ensure any previous watcher is fully stopped
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.watcher_thread.take() {
            let _ = handle.join();
        }

        let path = self.path.clone();
        let running = self.watcher_running.clone();
        let changed_files = self.changed_files.clone();

        self.watcher_running.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            let mut last_mtimes = collect_file_mtimes(&path);
            let poll_interval = Duration::from_secs(1);
            let mut consecutive_failures: u32 = 0;

            while running.load(Ordering::SeqCst) {
                thread::sleep(poll_interval);

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                let current_mtimes = collect_file_mtimes(&path);

                // Collect changed file paths (new, modified, or deleted)
                let mut changed: Vec<String> = Vec::new();
                for (fp, mt) in &current_mtimes {
                    match last_mtimes.get(fp) {
                        Some(old) if old != mt => changed.push(fp.clone()),
                        None => changed.push(fp.clone()), // new file
                        _ => {}
                    }
                }
                // Deleted files
                for fp in last_mtimes.keys() {
                    if !current_mtimes.contains_key(fp) {
                        changed.push(fp.clone());
                    }
                }

                if !changed.is_empty() {
                    if let Some(_json) = run_engine_analysis(&path, &changed) {
                        last_mtimes = current_mtimes;
                        consecutive_failures = 0;

                        // Update changed_files for check/gate commands
                        if let Ok(mut last) = changed_files.lock() {
                            *last = changed.clone();
                        }

                        // Emit graph-updated event to frontend
                        // The frontend will call get_full_graph to retrieve the updated data
                        let summary = serde_json::json!({
                            "total_nodes": 0,  // frontend ignores this, re-fetches via get_full_graph
                            "node_count": 0,
                            "meta": { "source_root": &path }
                        });
                        if let Err(e) = app_handle.emit("graph-updated", summary.to_string()) {
                            eprintln!("[hologram] emit graph-updated failed: {e}");
                        }
                    } else {
                        consecutive_failures += 1;
                        // After 3 consecutive failures, update mtimes anyway to break retry loop
                        if consecutive_failures >= 3 {
                            last_mtimes = current_mtimes;
                            let msg = format!(
                                r#"{{"error":"分析失败 (已重试{}次)，实时更新已暂停。保存文件后将重新尝试。"}}"#,
                                consecutive_failures
                            );
                            if let Err(e) = app_handle.emit("graph-updated", msg) {
                                eprintln!("[hologram] emit graph-updated error failed: {e}");
                            }
                        }
                    }
                }
            }
        });

        self.watcher_thread = Some(handle);
    }

    // ── Sandbox delegation ──────────────────────────────────────────

    /// Check if a read operation on the given path is allowed by the sandbox.
    pub fn check_read(&self, file_path: &str) -> Result<PathBuf, String> {
        let path = Path::new(file_path);
        match self.sandbox.resolve_read(path) {
            SandboxResult::Allowed(real) => Ok(real),
            SandboxResult::Denied(reason) => {
                self.audit_deny("read", file_path, &reason);
                Err(format!("读取被拒绝: {}", reason))
            }
        }
    }

    /// Check if a write operation on the given path is allowed by the sandbox.
    pub fn check_write(&self, file_path: &str) -> Result<PathBuf, String> {
        let path = Path::new(file_path);
        match self.sandbox.resolve_write(path) {
            SandboxResult::Allowed(real) => {
                self.audit_allow("write", file_path);
                Ok(real)
            }
            SandboxResult::Denied(reason) => {
                self.audit_deny("write", file_path, &reason);
                Err(format!("写入被拒绝: {}", reason))
            }
        }
    }

    // ── Audit delegation ────────────────────────────────────────────

    pub fn audit_allow(&self, tool: &str, path: &str) {
        self.audit_logger.log(&AuditEntry {
            timestamp: now_iso(),
            tool: tool.to_string(),
            target_path: path.to_string(),
            action: "allowed".to_string(),
            reason: String::new(),
        });
    }

    pub fn audit_deny(&self, tool: &str, path: &str, reason: &str) {
        self.audit_logger.log(&AuditEntry {
            timestamp: now_iso(),
            tool: tool.to_string(),
            target_path: path.to_string(),
            action: "denied".to_string(),
            reason: reason.to_string(),
        });
    }
}

// ── Helpers (moved from main.rs) ────────────────────────────────────

/// Collect mtimes of all source files under root, keyed by path.
fn collect_file_mtimes(root: &str) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    let exts = [".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs",
                 ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
                 ".rb", ".cs", ".kt", ".kts", ".swift", ".php", ".lua"];
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ext_with_dot = format!(".{}", ext);
        if exts.contains(&ext_with_dot.as_str()) {
            if let Ok(meta) = path.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if let Ok(secs) = mtime.duration_since(std::time::UNIX_EPOCH) {
                        map.insert(path.to_string_lossy().to_string(), secs.as_secs());
                    }
                }
            }
        }
    }
    map
}

/// Run a full engine analysis for the changed files and return the JSON result.
/// The Rust engine is fast enough (~4s for Django) that incremental mode is unnecessary.
fn run_engine_analysis(project_path: &str, _changed_files: &[String]) -> Option<String> {
    match crate::direct_analyze(project_path) {
        Ok(json) => Some(json),
        Err(e) => {
            eprintln!("[hologram] engine analysis failed: {e}");
            None
        }
    }
}
