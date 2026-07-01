// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WorkspaceHandle — owns all backend state for one open project.
// Replaces the scattered globals: ACTIVE_PROJECT, SANDBOX, AUDIT_LOGGER,
// LAST_CHANGED_FILES, WatcherState.
//
// v4 Phase 2: Sandbox 降级，权限系统升级为 PermissionContext（两层自治架构）。
// check_read/check_write/check_command 已删除 — 替换为 has_permission_to_use_tool()。
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
use std::path::Path;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use hologram_engine::engine as engine_api;
use hologram_engine::graph::Graph;

use crate::permissions::PermissionContext;

// ── Workspace-scoped state ──────────────────────────────────────────

pub struct WorkspaceHandle {
    /// Canonical workspace directory.
    pub path: String,

    /// Permission system (replaces old Sandbox).
    /// Arc for sharing across async Tauri commands without holding the state Mutex.
    pub permission_ctx: Arc<PermissionContext>,

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
            permission_ctx: Arc::new(PermissionContext::new(project_path)),
            changed_files: Arc::new(Mutex::new(Vec::new())),
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_thread: None,
        }
    }

    /// Activate this workspace: persist to .last_project for cold-start recovery.
    pub fn activate(&self, project_root: &Path) {
        let last_path = project_root.join(".last_project");
        let _ = fs::write(&last_path, &self.path);
    }

    /// Deactivate this workspace: stop the file watcher and clear transient state.
    pub fn deactivate(&mut self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        self.watcher_thread.take();
        if let Ok(mut files) = self.changed_files.lock() {
            files.clear();
        }
    }

    /// Start the background file watcher for this workspace.
    pub fn start_watcher(&mut self, app_handle: AppHandle) {
        self.watcher_running.store(false, Ordering::SeqCst);
        self.watcher_thread.take();

        let path = self.path.clone();
        let running = self.watcher_running.clone();
        let changed_files = self.changed_files.clone();

        self.watcher_running.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            let mut last_mtimes = collect_file_mtimes(&path);
            let poll_interval = Duration::from_secs(1);
            let debounce = Duration::from_secs(2);
            let mut consecutive_failures: u32 = 0;
            let mut pending_changed: Vec<String> = Vec::new();
            let mut last_change_at: Option<std::time::Instant> = None;

            while running.load(Ordering::SeqCst) {
                thread::sleep(poll_interval);

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                let current_mtimes = collect_file_mtimes(&path);

                let mut changed: Vec<String> = Vec::new();
                for (fp, mt) in &current_mtimes {
                    match last_mtimes.get(fp) {
                        Some(old) if old != mt => changed.push(fp.clone()),
                        None => changed.push(fp.clone()),
                        _ => {}
                    }
                }
                for fp in last_mtimes.keys() {
                    if !current_mtimes.contains_key(fp) {
                        changed.push(fp.clone());
                    }
                }

                if !changed.is_empty() {
                    for fp in &changed {
                        if !pending_changed.contains(fp) {
                            pending_changed.push(fp.clone());
                        }
                    }
                    last_change_at = Some(std::time::Instant::now());
                }

                let settled = last_change_at
                    .map(|t| t.elapsed() >= debounce)
                    .unwrap_or(false);
                if !settled || pending_changed.is_empty() {
                    continue;
                }

                if engine_api::engine_state().is_analyzing() {
                    continue;
                }

                let changed = std::mem::take(&mut pending_changed);
                last_change_at = None;

                // ponytail: snapshot old graph before re-analysis so we can diff
                let before_graph = engine_api::engine_read_graph(|g| g.clone()).ok();

                if let Some(_json) = run_engine_analysis(&path, &changed) {
                    last_mtimes = current_mtimes;
                    consecutive_failures = 0;

                    if let Ok(mut last) = changed_files.lock() {
                        *last = changed.clone();
                    }

                    // ponytail: compute diff between old and new graph for incremental update
                    let diff_json = compute_watcher_diff(before_graph.as_ref());

                    let mut summary = serde_json::json!({
                        "total_nodes": 0,
                        "node_count": 0,
                        "meta": { "source_root": &path }
                    });
                    if let Some(d) = &diff_json {
                        summary["diff"] = d.clone();
                    }
                    if let Err(e) = app_handle.emit("graph-updated", summary.to_string()) {
                        eprintln!("[hologram] emit graph-updated failed: {e}");
                    }
                } else {
                    consecutive_failures += 1;
                    if consecutive_failures >= 3 {
                        last_mtimes = current_mtimes;
                        let msg = format!(
                            r#"{{"error":"分析失败 (已重试{}次)，实时更新已暂停。保存文件后将重新尝试。"}}"#,
                            consecutive_failures
                        );
                        if let Err(e) = app_handle.emit("graph-updated", msg) {
                            eprintln!("[hologram] emit graph-updated error failed: {e}");
                        }
                    } else {
                        pending_changed = changed;
                        last_change_at = Some(std::time::Instant::now());
                    }
                }
            }
        });

        self.watcher_thread = Some(handle);
    }
}

// ── Helpers ────────────────────────────────────────────────────────

/// Collect mtimes of all source files under root, keyed by path.
fn collect_file_mtimes(root: &str) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    let exts = [
        ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java", ".c",
        ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".rb", ".cs", ".kt", ".kts", ".swift",
        ".php", ".lua",
    ];
    const IGNORE_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "build",
        "dist",
        "out",
        ".venv",
        "venv",
        ".hologram",
        "release-bin",
        "__pycache__",
        ".pytest_cache",
        ".ruff_cache",
        ".mypy_cache",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".cursor",
        ".idea",
        ".vscode",
        ".coverage",
    ];
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !IGNORE_DIRS.iter().any(|d| name.as_ref() == *d)
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
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
fn run_engine_analysis(project_path: &str, _changed_files: &[String]) -> Option<String> {
    match crate::utils::direct_analyze(project_path, true) {
        Ok(json) => Some(json),
        Err(e) => {
            eprintln!("[hologram] engine analysis failed: {e}");
            None
        }
    }
}

/// Compute diff between previous graph and current engine graph for incremental update.
/// Returns None if no previous graph or engine read fails.
fn compute_watcher_diff(before: Option<&Graph>) -> Option<serde_json::Value> {
    let before = before?;
    let after = engine_api::engine_read_graph(|g| g.clone()).ok()?;
    let d = before.diff(&after);
    let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
        "location": n.location, "in_degree": n.in_degree, "out_degree": n.out_degree,
        "community_id": n.community_id,
    })).collect();
    let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
    })).collect();
    let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| serde_json::json!({
        "node_id": new.id, "name": new.name,
        "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
    })).collect();
    let added_edges: Vec<_> = d.added_edges.iter().map(|e| serde_json::json!({
        "id": e.id, "source": e.source, "target": e.target,
        "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
        "cross_file": e.cross_file,
    })).collect();
    let removed_edges: Vec<_> = d.removed_edges.iter().map(|e| serde_json::json!({
        "id": e.id, "source": e.source, "target": e.target,
    })).collect();
    Some(serde_json::json!({
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "modified_nodes": modified_nodes,
        "added_edges": added_edges,
        "removed_edges": removed_edges,
    }))
}
