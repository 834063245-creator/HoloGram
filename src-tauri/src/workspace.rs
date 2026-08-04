// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WorkspaceHandle — 持有一个打开项目的所有后端状态。
// 替代分散的全局变量: ACTIVE_PROJECT, SANDBOX, AUDIT_LOGGER,
// LAST_CHANGED_FILES, WatcherState。
//
// v4 Phase 2: Sandbox 降级，权限系统升级为 PermissionContext（两层自治架构）。
// check_read/check_write/check_command 已删除 — 替换为 has_permission_to_use_tool()。
//
// 生命周期:
//   let mut handle = WorkspaceHandle::new(path);
//   handle.activate(project_root);           // 注册为活跃工作区
//   handle.start_watcher(app_handle);       // 开始文件监控
//   // ... 用户操作 ...
//   handle.deactivate();                     // 停止监控，清理状态
//
// 作为 Tauri state 管理: State<Arc<Mutex<Option<WorkspaceHandle>>>>

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use hologram_engine::engine as engine_api;
use hologram_engine::graph::Graph;

use crate::permissions::PermissionContext;

// ── 工作区范围的状态 ──────────────────────────────────────────

pub struct WorkspaceHandle {
    /// 规范化的工作区目录。
    pub path: String,

    /// 权限系统（替代旧 Sandbox）。
    /// 用 Arc 以便在不持有 state Mutex 的情况下跨异步 Tauri command 共享。
    pub permission_ctx: Arc<PermissionContext>,

    /// 自上次检查以来的变更文件（原 LAST_CHANGED_FILES 全局变量）。
    pub changed_files: Arc<Mutex<Vec<String>>>,

    // 监控器内部状态
    watcher_running: Arc<AtomicBool>,
    watcher_thread: Option<JoinHandle<()>>,
}

/// 句柄被丢弃时兜底停用（防 activate 直接覆盖旧句柄导致 watcher 线程泄漏）。
/// deactivate() 幂等：未启动 watcher 时快速返回。
impl Drop for WorkspaceHandle {
    fn drop(&mut self) {
        self.deactivate();
    }
}

impl WorkspaceHandle {
    /// 创建新的工作区句柄。不会激活它或启动监控器。
    pub fn new(path: &str) -> Self {        let project_path = Path::new(path);
        Self {
            path: path.to_string(),
            permission_ctx: Arc::new(PermissionContext::new(project_path)),
            changed_files: Arc::new(Mutex::new(Vec::new())),
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_thread: None,
        }
    }

    /// 激活此工作区: 持久化到 .last_project 以便冷启动恢复。
    pub fn activate(&self, project_root: &Path) {
        let last_path = project_root.join(".last_project");
        let _ = fs::write(&last_path, &self.path);
    }

    /// 停用此工作区: 停止文件监控器并清理临时状态。
    /// 监控线程有 2s 的优雅退出时间；超时后将被分离。
    pub fn deactivate(&mut self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.watcher_thread.take() {
            // 轮询最多 2s 等待线程自行退出。
            // 监控器每 1s 检查一次 `running`，所以 2s 足够一个轮询周期。
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // 如果 2s 后仍未结束，句柄被丢弃（分离）。
            // 线程将在下次检查 `running` 时退出。
        }
        if let Ok(mut files) = self.changed_files.lock() {
            files.clear();
        }
    }

    /// 启动此工作区的后台文件监控器。
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
            // (path, action) — action 为 "modified" / "created" / "removed"
            let mut pending_changed: Vec<(String, String)> = Vec::new();
            let mut last_change_at: Option<std::time::Instant> = None;

            while running.load(Ordering::SeqCst) {
                thread::sleep(poll_interval);

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                let current_mtimes = collect_file_mtimes(&path);

                // 检测变更并为增量更新器添加动作标签
                let mut changed: Vec<(String, String)> = Vec::new();
                for (fp, mt) in &current_mtimes {
                    match last_mtimes.get(fp) {
                        Some(old) if old != mt => changed.push((fp.clone(), "modified".into())),
                        None => changed.push((fp.clone(), "created".into())),
                        _ => {}
                    }
                }
                for fp in last_mtimes.keys() {
                    if !current_mtimes.contains_key(fp) {
                        changed.push((fp.clone(), "removed".into()));
                    }
                }

                if !changed.is_empty() {
                    for (fp, action) in &changed {
                        if !pending_changed.iter().any(|(p, _)| p == fp) {
                            pending_changed.push((fp.clone(), action.clone()));
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

                // 提取路径列表供不需要动作信息的消费者使用
                let changed_paths: Vec<String> = changed.iter().map(|(p, _)| p.clone()).collect();

                // ponytail: 在重新分析前快照旧图以便做 diff
                let before_graph = engine_api::engine_read_graph(|g| g.clone()).ok();

                // 首先尝试增量更新 (Phase 1-3: 重新解析变更文件,
                // 文件内 diff, 跨文件边修复)。如果增量失败或验证
                // 阈值 (0.85 边保留率) 未达标，则自动回退到全量重新分析。
                let changed_for_engine: Vec<(PathBuf, String)> = changed.iter()
                    .map(|(p, a)| (PathBuf::from(p), a.clone()))
                    .collect();
                let root = Path::new(&path);
                let analysis_ok = engine_api::engine_try_incremental(root, &changed_for_engine).is_ok();

                if analysis_ok {
                    last_mtimes = current_mtimes;
                    consecutive_failures = 0;

                    if let Ok(mut last) = changed_files.lock() {
                        *last = changed_paths.clone();
                    }

                    // ponytail: 计算旧图与新图之间的 diff 以供增量更新
                    let diff_json = compute_watcher_diff(before_graph.as_ref());

                    // 从引擎存储中读取实际节点/边数量，使前端的
                    // `nc > 0` 守卫通过并获取最新图。
                    // 之前这里硬编码为 0，导致每个 graph-updated
                    // 事件被静默忽略 — 后端存储已更新但
                    // 前端一直显示旧数据，直到用户手动点击"重新分析"。
                    let (nc, ec) = engine_api::engine_read(|idx| (idx.node_count(), idx.edge_count()))
                        .unwrap_or((0, 0));

                    let mut summary = serde_json::json!({
                        "total_nodes": nc,
                        "node_count": nc,
                        "edge_count": ec,
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

// ── 辅助函数 ────────────────────────────────────────────────────

/// 收集 root 下所有源文件的 mtime，按路径索引。
fn collect_file_mtimes(root: &str) -> std::collections::HashMap<String, u64> {
    let mut map = std::collections::HashMap::new();
    // ponytail: 从引擎的 grammar loader 动态加载支持的扩展名，
    // 而非硬编码列表 — 新的 grammar DLL 会被自动识别，无需修改代码。
    let exts: std::collections::HashSet<String> =
        engine_api::engine_supported_extensions().into_iter().collect();
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
        if exts.contains(ext) {
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

/// 计算前一次图与当前引擎图之间的 diff 以供增量更新。
/// 如果没有前一次图或引擎读取失败则返回 None。
pub(crate) fn compute_watcher_diff(before: Option<&Graph>) -> Option<serde_json::Value> {
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

