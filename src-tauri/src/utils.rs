// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Utility functions shared across Tauri commands.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use base64::Engine;
use tauri::{Emitter, Manager};
use tracing_appender::non_blocking::WorkerGuard;
use hologram_engine as engine;
use engine::engine as engine_api;
use engine::graph::Graph;
use engine::storage::SqliteDb;
use engine::storage::MemoryIndex;
use serde_json;
use crate::os_sandbox;
use crate::workspace;
use crate::permissions;
use crate::agent_isolation::{AgentIsolation, IsolationKind};
use crate::permissions::{PermissionContext, PermissionDecision, has_permission_to_use_tool, register_ask};
use crate::tools;
use engine::community::detect_hierarchical_communities_with_base;
use engine::routing::preflight::save_baseline;
#[cfg(windows)] use std::os::windows::process::CommandExt;
#[cfg(windows)] pub(crate) const NO_WINDOW: u32 = 0x08000000;

// ═══════════════════════════════════════════════════════
// Background job system — timeout + background + output + kill
// ═══════════════════════════════════════════════════════

pub(crate) struct BgJob {
    pub(crate) child: os_sandbox::SandboxedChild,
    stdout_buf: Vec<u8>,
    stderr_buf: Vec<u8>,
    start_time: std::time::Instant,
}

pub(crate) static BG_JOBS: std::sync::LazyLock<Arc<Mutex<HashMap<u32, BgJob>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

static NEXT_JOB_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Logging guard — initialized once on first project open, held for process lifetime.
pub(crate) static LOG_GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();

pub(crate) fn spawn_bg(cmd: &str, cwd: &str) -> Result<u32, String> {
    let child = os_sandbox::spawn_shell(cmd, cwd)
        .map_err(|e| format!("无法启动后台命令: {e}"))?;
    let id = NEXT_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let job = BgJob {
        child,
        stdout_buf: Vec::new(),
        stderr_buf: Vec::new(),
        start_time: std::time::Instant::now(),
    };
    BG_JOBS.lock().unwrap().insert(id, job);
    Ok(id)
}

pub(crate) fn read_bg_output(id: u32) -> Result<String, String> {
    let mut jobs = BG_JOBS.lock().unwrap();
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
    // Drain what's available without blocking
    if let Some(stdout) = job.child.stdout_reader() {
        let mut buf = [0u8; 4096];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => job.stdout_buf.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
    }
    if let Some(stderr) = job.child.stderr_reader() {
        let mut buf = [0u8; 4096];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => job.stderr_buf.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
    }
    let elapsed = job.start_time.elapsed().as_secs();
    let stdout = String::from_utf8_lossy(&job.stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&job.stderr_buf).to_string();
    // Check if process has exited
    let status = job.child.try_wait().map_err(|e| format!("检查进程状态失败: {e}"))?;
    let info = if let Some(ec) = status {
        let msg = format!("[任务已完成, exit code: {}, 耗时: {}s]\n", ec, elapsed);
        jobs.remove(&id); // Clean up
        msg
    } else {
        format!("[任务运行中, 已运行: {}s]\n", elapsed)
    };
    Ok(format!("{info}{stdout}{stderr}"))
}

pub(crate) fn kill_bg(id: u32) -> Result<String, String> {
    let mut jobs = BG_JOBS.lock().unwrap();
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
    job.child.kill().map_err(|e| format!("无法终止任务: {e}"))?;
    let stdout = String::from_utf8_lossy(&job.stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&job.stderr_buf).to_string();
    jobs.remove(&id);
    Ok(format!("[任务已终止]\n{stdout}{stderr}"))
}

/// Find the Rust engine executable.
/// Checks: 1) HOLOGRAM_ENGINE env var  2) engine/target/release  3) engine/target/debug
pub(crate) fn engine_binary() -> String {
    if let Ok(p) = std::env::var("HOLOGRAM_ENGINE") {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    let root = project_root();
    let paths = [
        // Bundled resource: engine.exe placed next to the app binary
        root.join("hologram-engine.exe"),
        // Dev layout: engine built in engine/target/
        root.join("engine/target/release/hologram-engine.exe"),
        root.join("engine/target/debug/hologram-engine.exe"),
    ];
    for p in &paths {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    // Fallback: default debug path
    project_root().join("engine/target/debug/hologram-engine.exe")
        .to_string_lossy().to_string()
}

pub(crate) fn project_root() -> PathBuf {
    // Production (installed app): use exe directory — python/ and src_python/ are bundled next to it
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir_str = dir.to_string_lossy();
            // "target" in path = cargo build dir → dev mode; otherwise = installed app
            if !dir_str.contains("target") {
                return dir.to_path_buf();
            }
        }
    }
    // Dev mode: CARGO_MANIFEST_DIR is src-tauri/, project root is one level up
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(PathBuf::from(".").as_path())
        .to_path_buf()
}

/// Set the active workspace — now a no-op stub. Use workspace_activate instead.
/// Kept for API compatibility; frontend never calls this directly.

type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

/// Helper: get the active workspace path from WorkspaceHandle state.
/// Returns an error if no workspace is open (instead of silently falling back to globals).
pub(crate) fn workspace_path(state: &WorkspaceState) -> Result<String, String> {
    state.lock()
        .map_err(|e| format!("工作区状态错误: {e}"))?
        .as_ref()
        .map(|h| h.path.clone())
        .ok_or_else(|| "未打开工作区，请先打开项目".into())
}

/// Helper: get a reference to the active WorkspaceHandle.
#[allow(dead_code)] // ponytail: kept for non-permission workspace access
pub(crate) fn with_workspace<F, R>(state: &WorkspaceState, f: F) -> Result<R, String>
where
    F: FnOnce(&workspace::WorkspaceHandle) -> Result<R, String>,
{
    let guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
    let handle = guard.as_ref().ok_or("未打开工作区，请先打开项目")?;
    f(handle)
}

// ═══════════════════════════════════════════════════════
// Phase 2: Permission helpers — replace old with_workspace sandbox calls

/// Get the PermissionContext from workspace state, releasing the lock immediately.
pub(crate) fn get_ctx(state: &WorkspaceState) -> Result<Arc<PermissionContext>, String> {
    let guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
    let handle = guard.as_ref().ok_or("未打开工作区，请先打开项目")?;
    Ok(handle.permission_ctx.clone())
}

/// Check MCP/graph tool permission — deny-only, skips ask/allow/safety.
/// MCP tools are read-only; only explicit deny rules should block them.
/// No workspace = no rules = passthrough (allows diagnostic tools like hologram_status).
pub(crate) fn check_mcp_permission(
    tool_name: &str,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    // ponytail: 无工作区 = 无 .hologram/permissions.json = 无自定义规则，放行。
    // 防止 hologram_status 等诊断工具因前置条件失败而无法诊断引擎状态（循环依赖）。
    let ctx = match get_ctx(state) {
        Ok(ctx) => ctx,
        Err(_) => return Ok(()),
    };
    // ponytail: use public accessor ctx.read_rules(), not private ctx.rules
    let rules = ctx.read_rules();
    if let Some(rule) = rules.find_deny(tool_name, None) {
        let reason = format!("{} 工具被规则禁止使用", rule.explain());
        drop(rules);
        ctx.audit_deny(tool_name, "", &reason);
        return Err(reason);
    }
    Ok(())
}

/// Check permission for a tool. If Ask, emit event and wait for user response.
pub(crate) async fn check_permission(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { request_id, reason, suggestions } => {
            let _ = app.emit("permission-ask", serde_json::json!({
                "requestId": request_id,
                "tool": tool.name(),
                "path": tool.get_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                "reason": reason,
                "suggestions": suggestions.iter().map(|s| serde_json::json!({
                    "rule": s.rule,
                    "behavior": s.behavior,
                })).collect::<Vec<_>>(),
            }));
            let rx = register_ask(request_id);
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(true)) => Ok(()),
                Ok(Ok(false)) | Ok(Err(_)) => Err("用户拒绝了此操作".into()),
                Err(_) => Err("权限请求超时".into()),
            }
        }
    }
}

/// Check permission synchronously (no Await — for background tasks: Ask → Deny, spec §4.11).
pub(crate) fn check_permission_sync(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { reason, .. } => {
            Err(format!("后台任务需要用户确认但无法交互: {}", reason))
        }
    }
}

pub(crate) async fn require_read(file_path: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3: forward-map to worktree physical path when isolation is Worktree (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path));
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone() };
    check_permission(&tool, &ctx, app).await?;
    ctx.resolve_read(&physical_str)
}

pub(crate) async fn require_write(file_path: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3: forward-map to worktree physical path when isolation is Worktree (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path));
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::EditTool { path: physical_str.clone() };
    check_permission(&tool, &ctx, app).await?;
    ctx.resolve_write(&physical_str)
}

/// ponytail: 用户 UI 操作的路径解析 — 只做 forward-map + sandbox resolve,
/// 不检查权限规则. 权限系统是给 Agent 的, 用户在 UI 上的操作不受权限限制.
/// safety check 仍然保留在写路径 (防误操作系统文件).
pub(crate) fn resolve_path_user_read(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path));
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_read(&physical_str)
}

pub(crate) fn resolve_path_user_write(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path));
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_write(&physical_str)
}

/// ponytail: 根据 _agent 标志选择路径解析方式 — Agent 走权限检查, UI 只解析
pub(crate) async fn resolve_read_dispatch(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_read(file_path, state, app).await
    } else {
        resolve_path_user_read(file_path, state)
    }
}

pub(crate) async fn resolve_write_dispatch(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_write(file_path, state, app).await
    } else {
        resolve_path_user_write(file_path, state)
    }
}

/// ponytail: 根据 _agent 标志选择 git 权限检查方式
pub(crate) async fn require_git_dispatch(
    repo_path: &str,
    subcommand: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    if is_agent {
        require_git(repo_path, subcommand, state, app).await
    } else {
        Ok(())  // user UI git operations are unrestricted
    }
}

pub(crate) async fn require_command(command: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission(&tool, &ctx, app).await
}

pub(crate) fn require_command_sync(command: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission_sync(&tool, &ctx)
}

pub(crate) fn require_read_sync(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3: forward-map to worktree physical path when isolation is Worktree (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path));
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone() };
    check_permission_sync(&tool, &ctx)?;
    ctx.resolve_read(&physical_str)
}

pub(crate) async fn require_git(repo_path: &str, subcommand: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    // Phase 3: forward-map repo path to worktree when isolated (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(repo_path));
    let tool = tools::GitTool { repo_path: physical.to_string_lossy().to_string(), subcommand: subcommand.to_string() };
    check_permission(&tool, &ctx, app).await
}

fn cache_is_stale(root: &std::path::Path) -> bool {
    let graph_json = root.join("hologram_graph.json");
    let cache_mtime = match std::fs::metadata(&graph_json) {
        Ok(m) => match m.modified() {
            Ok(t) => t,
            Err(_) => return true, // can't read mtime → assume stale
        },
        Err(_) => return true, // no baseline → stale
    };

    const EXTS: &[&str] = &[
        ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java", ".c",
        ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".rb", ".cs", ".kt", ".kts", ".swift",
        ".php", ".lua",
    ];
    const SKIP: &[&str] = &[
        ".git", "node_modules", "target", "build", "dist", "out", ".venv", "venv",
        ".hologram", "release-bin", "__pycache__", ".pytest_cache", ".ruff_cache",
        ".mypy_cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cursor",
        ".idea", ".vscode", ".coverage",
    ];

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !SKIP.iter().any(|d| name.as_ref() == *d)
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ext_dot = format!(".{}", ext);
        if !EXTS.contains(&ext_dot.as_str()) { continue; }
        if let Ok(meta) = path.metadata() {
            if let Ok(mtime) = meta.modified() {
                if mtime > cache_mtime {
                    eprintln!(
                        "[direct_analyze] Cache stale: {} modified after last analysis",
                        path.display()
                    );
                    return true;
                }
            }
        }
    }
    false
}

pub(crate) fn direct_analyze(path: &str, force: bool) -> Result<String, String> {
    let root = std::path::PathBuf::from(path);
    if !root.exists() {
        return Err(format!("路径不存在: {path}"));
    }

    // Initialize engine (idempotent — loads SQLite cache into memory)
    engine_api::engine_init(&root)
        .map_err(|e| format!("Engine init failed: {e}"))?;

    // ponytail: if SQLite cache already has graph data AND reanalysis not
    // forced, skip the full pipeline. Cold-start wins ~420s; warm reload <1s.
    // But verify cache freshness first — if any source file was modified after
    // the last analysis, the cache is stale and must be rebuilt. Otherwise
    // code changes made outside HoloGram (e.g. in VS Code between sessions)
    // are silently invisible until the user manually hits "re-analyze".
    if !force {
        let cached_node_count = engine_api::engine_read(|idx| idx.node_count())
            .unwrap_or(0);
        if cached_node_count > 0 && !cache_is_stale(&root) {
            eprintln!("[direct_analyze] Using cached graph ({cached_node_count} nodes), skipping full analysis");
        // Serialize from cache inside callback — avoids cloning the entire Graph
        return engine_api::engine_read_graph(|graph| {
            let nc = graph.node_count();
            let ec = graph.edge_count();
            let nodes: Vec<serde_json::Value> = graph.nodes.values().map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "location": n.location, "in_degree": n.in_degree,
                "out_degree": n.out_degree, "properties": n.properties,
                "position": n.position, "community_id": n.community_id,
            })).collect();
            let edges: Vec<serde_json::Value> = graph.edges.values().map(|e| serde_json::json!({
                "id": e.id, "source": e.source, "target": e.target,
                "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                "cross_file": e.cross_file,
                "temporal_delay_sec": e.temporal_delay_sec,
            })).collect();
            let mut comm_map: std::collections::HashMap<usize, Vec<&str>> = std::collections::HashMap::new();
            for n in graph.nodes.values() {
                if let Some(cid) = n.community_id {
                    comm_map.entry(cid).or_default().push(&n.id);
                }
            }
            let comms: Vec<serde_json::Value> = comm_map.iter()
                .map(|(cid, node_ids)| {
                    let nids: Vec<String> = node_ids.iter().map(|s| s.to_string()).collect();
                    let label = derive_community_label(&nids);
                    serde_json::json!({"id": format!("comm_{}", cid), "size": nids.len(), "node_ids": nids, "label": label})
                })
                .collect();
            serde_json::json!({
                "ok": true, "node_count": nc, "edge_count": ec,
                "nodes": nodes, "edges": edges, "communities": comms,
                "hierarchical_communities": [],
                "cached": true,
            }).to_string()
        }).map_err(|e| format!("Read cached graph failed: {e}"));
    }
    } // if !force

    let result = engine_api::engine_analyze(&root)
        .map_err(|e| format!("Analyze failed: {e}"))?;

    // result.graph is drained by engine (nodes/edges moved to MemoryIndex/store).
    // Use result.node_count / result.edge_count for scalars, and read graph
    // data from the store for serialization.
    let nc = result.node_count;
    let ec = result.edge_count;

    // Serialize from the graph store (data was swapped in by engine_analyze)
    let serialized = serialize_cached_graph(path)?;
    let wrapped: serde_json::Value = serde_json::from_str(&serialized)
        .unwrap_or(serde_json::json!({"nodes":[],"edges":[],"communities":[]}));
    let nodes = wrapped.get("nodes").cloned().unwrap_or(serde_json::json!([]));
    let edges = wrapped.get("edges").cloned().unwrap_or(serde_json::json!([]));
    let comms = wrapped.get("communities").cloned().unwrap_or(serde_json::json!([]));
    // Hierarchical communities come from result (not drained)
    let hcomms: Vec<serde_json::Value> = result.hierarchical_communities.iter()
        .map(|hc| serde_json::json!({
            "id": hc.id,
            "label": hc.label,
            "node_ids": hc.node_ids,
            "level": hc.level,
            "parent_id": hc.parent_id,
        }))
        .collect();

    // Persist hologram_graph.json for cold-start
    let graph_path = format!("{}/hologram_graph.json", path);
    let wrapped = serde_json::json!({
        "meta": { "source_root": path,
            "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "version": "0.1.0", "node_count": nc, "edge_count": ec },
        "nodes": nodes, "edges": edges, "communities": comms,
        "hierarchical_communities": hcomms,
    });
    let _ = std::fs::write(&graph_path, serde_json::to_string(&wrapped).unwrap_or_default());
    // Always update baseline after full analysis so subsequent checks
    // diff against a fresh snapshot — prevents stale-baseline false positives
    // (e.g. "53 new cycles" when graph structure evolves between analyses).
    let _ = engine_api::engine_read_graph(|g| save_baseline(&root, g));
    // .hologram MsgPack retired — CACHED_GRAPH is the sole runtime truth, JSON is cold-start archive only
    let _ = std::fs::remove_file(format!("{}/hologram_graph.hologram", path));
    let _ = regenerate_file_graph(&path);

    // Record timeline event (mirrors engine binary's handle_analyze)
    let _ = engine_api::engine_record_timeline(
        "analyze",
        None::<&str>,
        &format!("全量分析完成：{} 节点, {} 边, {:.1}s", nc, ec, result.elapsed_secs),
    );

    Ok(serde_json::json!({
        "status": "ok", "total_nodes": nc, "total_edges": ec,
        "communities": result.community_count, "elapsed_secs": result.elapsed_secs,
        "node_count": nc, "edge_count": ec,
    }).to_string())
}

/// Run a query on the graph. Reads from Engine.
pub(crate) fn with_graph<F: Fn(&Graph) -> serde_json::Value>(f: F) -> Result<String, String> {
    engine_api::engine_read_graph(|g| {
        serde_json::to_string(&f(g)).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

pub(crate) fn with_store<F: Fn(&engine::storage::MemoryIndex) -> serde_json::Value>(f: F) -> Result<String, String> {
    engine_api::engine_read(|idx| {
        serde_json::to_string(&f(idx)).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// Serialize full graph JSON — shared by frontend and analyze_and_load.
/// Reads from Engine exclusively.
pub(crate) fn serialize_cached_graph(source_root: &str) -> Result<String, String> {
    engine_api::engine_read_graph(|g| {
        let nodes: Vec<serde_json::Value> = g.nodes.values().map(|n| serde_json::json!({
            "id": n.id, "name": n.name, "type": n.kind.as_str(),
            "location": n.location, "in_degree": n.in_degree,
            "out_degree": n.out_degree,
            "properties": n.properties, "position": n.position,
            "community_id": n.community_id,
        })).collect();
        let edges: Vec<serde_json::Value> = g.edges.values().map(|e| serde_json::json!({
            "id": e.id, "source": e.source, "target": e.target,
            "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
            "cross_file": e.cross_file,
            "temporal_delay_sec": e.temporal_delay_sec,
        })).collect();
        // Rebuild communities from pre-computed community_id on each node
        // (avoids re-running Louvain, which is O(V·avg_degree·iterations))
        // community_id is Option<usize> → JSON number, not string
        let mut comm_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for n in &nodes {
            if let Some(cid) = n.get("community_id").and_then(|v| v.as_u64()) {
                if let Some(node_id) = n.get("id").and_then(|v| v.as_str()) {
                    comm_map.entry(cid.to_string()).or_default().push(node_id.to_string());
                }
            }
        }
        let communities_json: Vec<serde_json::Value> = comm_map.iter()
            .map(|(cid, node_ids)| {
                // Derive a readable label from the most common file prefix
                let label = derive_community_label(node_ids);
                serde_json::json!({"id": cid, "size": node_ids.len(), "node_ids": node_ids, "label": label})
            })
            .collect();
        // Hierarchical communities — rebuild base from node.community_id
        // (already set during analyze), then run only Phase 2 condensation.
        // Avoids re-running Phase 1 detect_communities on every serialize.
        let mut base_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
        for n in g.nodes.values() {
            if let Some(cid) = n.community_id {
                base_map.entry(cid).or_default().push(n.id.clone());
            }
        }
        let base: Vec<Vec<String>> = base_map.values().cloned().collect();
        let hcommunities = detect_hierarchical_communities_with_base(g, base, 42);
        let hcommunities_json: Vec<serde_json::Value> = hcommunities.iter()
            .map(|hc| serde_json::json!({
                "id": hc.id,
                "label": hc.label,
                "node_ids": hc.node_ids,
                "level": hc.level,
                "parent_id": hc.parent_id,
            }))
            .collect();
        let meta = serde_json::json!({
            "source_root": source_root,
            "node_count": g.node_count(),
            "edge_count": g.edge_count(),
        });
        serde_json::to_string(&serde_json::json!({"meta": meta, "nodes": nodes, "edges": edges, "communities": communities_json, "hierarchical_communities": hcommunities_json})).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// Derive a readable label for a community from its member node IDs.
/// Uses the most common file path segment from the node IDs.
pub(crate) fn derive_community_label(node_ids: &[String]) -> String {
    use std::collections::HashMap;
    let mut prefix_counts: HashMap<String, usize> = HashMap::new();
    for nid in node_ids {
        // Node IDs are typically "file_path:line" or "file_path::symbol"
        // Extract top-level directory or file stem
        let file = nid.split(':').next().unwrap_or(nid);
        let parts: Vec<&str> = file.split(['/', '\\']).collect();
        // Try to get a meaningful prefix: first 1-2 segments of the path
        let prefix = if parts.len() >= 2 {
            format!("{}/{}", parts[parts.len().saturating_sub(2)], parts[parts.len() - 1])
        } else {
            file.to_string()
        };
        *prefix_counts.entry(prefix).or_default() += 1;
    }
    // Pick the most common prefix, or fall back to first node
    prefix_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(prefix, _)| prefix)
        .unwrap_or_else(|| "社区".to_string())
}

pub(crate) fn diff_to_json(before: &Graph, after: &Graph) -> serde_json::Value {
    let d = before.diff(after);
    let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
        "location": n.location,
    })).collect();
    let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
    })).collect();
    let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| serde_json::json!({
        "node_id": new.id, "name": new.name,
        "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
    })).collect();
    let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
    serde_json::json!({
        "is_empty": is_empty,
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "modified_nodes": modified_nodes,
        "added_edges": d.added_edges.len(),
        "removed_edges": d.removed_edges.len(),
    })
}

pub(crate) async fn run_analyze_with_progress(target: String, app: tauri::AppHandle, force: bool) -> Result<String, String> {
    let target_clone = target.clone();
    let app_clone = app.clone();
    let scheduled = std::time::Instant::now();

    // Spawn analysis in a blocking thread
    let mut analyze_handle = tokio::task::spawn_blocking(move || {
        direct_analyze(&target_clone, force)
    });

    // Poll progress until the blocking task finishes (don't exit early on Ready —
    // queued analyzes wait on analyze_lock while state stays Ready).
    loop {
        tokio::select! {
            res = &mut analyze_handle => {
                match res {
                    Ok(result) => return result,
                    Err(e) => return Err(format!("分析任务失败: {}", e)),
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                let state = engine_api::engine_state();
                match state {
                    engine_api::EngineState::Analyzing { phase, current, total, file, started_at_ms, .. } => {
                        let _ = app_clone.emit("analyze-phase", serde_json::json!({
                            "phase": phase.clone(),
                            "message": phase,
                        }));
                        if total > 0 {
                            let _ = app_clone.emit("analyze-progress", serde_json::json!({
                                "current": current,
                                "total": total,
                                "file": file,
                            }));
                        }
                        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
                        let elapsed = now_ms.saturating_sub(started_at_ms);
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": phase,
                            "elapsed": format!("{:.1}s", elapsed as f64 / 1000.0),
                        }));
                    }
                    _ => {
                        let elapsed_s = scheduled.elapsed().as_secs_f64();
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": "等待分析引擎",
                            "elapsed": format!("{:.1}s", elapsed_s),
                        }));
                    }
                }
            }
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) children: Option<Vec<DirEntry>>,
}

/// Recursively list directory contents (depth-limited to avoid huge trees).
pub(crate) fn list_dir_recursive(root: &std::path::Path) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();

    // ponytail: 只隐藏 VCS 内部目录 — 其他全显示, git ignored 着色在前端处理
    let skip_dirs: std::collections::HashSet<&str> = [
        ".git", ".hg", ".svn",
    ].iter().cloned().collect();

    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };

    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }

        let children = if is_dir {
            Some(list_dir_recursive(&path))
        } else {
            None
        };

        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }

    entries
}

pub(crate) fn list_dir_flat(root: &std::path::Path) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    // ponytail: 只隐藏 VCS 内部目录 — 其他全显示, git ignored 着色在前端处理
    let skip_dirs: std::collections::HashSet<&str> = [
        ".git", ".hg", ".svn",
    ].iter().cloned().collect();

    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };

    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    entries
}

#[derive(serde::Serialize)]
pub(crate) struct GlobEntry {
    pub(crate) path: String,
    pub(crate) name: String,
}

pub(crate) fn is_private_ip(host: &str) -> bool {
    // Hostname checks (DNS names that resolve to local/private)
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".local") || host_lower.ends_with(".internal") {
        return true;
    }
    use std::net::IpAddr;
    let ip: IpAddr = match host.parse() {
        Ok(ip) => ip,
        Err(_) => return false,
    };
    if ip.is_loopback() || ip.is_unspecified() { return true; }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local()
        }
        IpAddr::V6(v6) => {
            let segs = v6.segments();
                        segs[0] & 0xffc0 == 0xfe80
        }
    }
}

pub(crate) fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => { out.push('%'); out.push_str(&format!("{:02X}", b)); }
        }
    }
    out
}

pub(crate) fn regenerate_file_graph(project_path: &str) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", project_path);
    let files_path = format!("{}/hologram_graph_files.json", project_path);

    let content = std::fs::read_to_string(&graph_path)
        .map_err(|e| format!("Cannot read graph: {}", e))?;
    let g: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid graph JSON: {}", e))?;

    // Group nodes by file
    let mut file_nodes: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    if let Some(nodes) = g.get("nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            let loc = n.get("location").and_then(|v| v.as_str()).unwrap_or("");
            // Extract file path from "file.py:123" or "file.py"
            let file = loc.split(':').next().unwrap_or("").to_string();
            if !file.is_empty() {
                if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                    file_nodes.entry(file).or_default().push(id.to_string());
                }
            }
        }
    }

    // Build node_id → file lookup in O(N) — avoids O(N*E) find_node_file scan
    let node_file: std::collections::HashMap<&str, &str> = g.get("nodes")
        .and_then(|v| v.as_array())
        .map(|nodes| {
            nodes.iter().filter_map(|n| {
                let id = n.get("id").and_then(|v| v.as_str())?;
                let file = n.get("location").and_then(|v| v.as_str()).unwrap_or("")
                    .split(':').next().unwrap_or("");
                if file.is_empty() { None } else { Some((id, file)) }
            }).collect()
        }).unwrap_or_default();

    // Count edges per file pair
    let mut file_edges: std::collections::HashMap<(String, String), u32> = std::collections::HashMap::new();
    if let Some(edges) = g.get("edges").and_then(|v| v.as_array()) {
        for e in edges {
            let src = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let tgt = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
            let src_file = node_file.get(src).copied().unwrap_or("");
            let tgt_file = node_file.get(tgt).copied().unwrap_or("");
            if !src_file.is_empty() && !tgt_file.is_empty() && src_file != tgt_file {
                *file_edges.entry((src_file.to_string(), tgt_file.to_string())).or_default() += 1;
            }
        }
    }

    let file_graph: serde_json::Value = serde_json::json!({
        "nodes": file_nodes.iter().map(|(f, ids)| serde_json::json!({
            "id": f,
            "name": f.split('/').last().unwrap_or(f),
            "type": "file",
            "location": f,
            "symbol_count": ids.len(),
        })).collect::<Vec<_>>(),
        "edges": file_edges.iter().map(|((s, t), count)| serde_json::json!({
            "source": s,
            "target": t,
            "type": "structural",
            "weight": count,
        })).collect::<Vec<_>>(),
        "meta": g.get("meta").cloned().unwrap_or(serde_json::json!({})),
    });

    std::fs::write(&files_path, serde_json::to_string(&file_graph).unwrap_or_default())
        .map_err(|e| format!("Cannot write file graph: {}", e))?;
    Ok("ok".to_string())
}

pub(crate) fn run_git_sync(dir: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        cmd.creation_flags(NO_WINDOW);
    }
    let output = cmd
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git 命令失败: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Run a git command on the blocking thread pool.
/// ponytail: .output() blocks the thread waiting for the git process;
/// running it on the async worker starves concurrent Tauri commands.
pub(crate) async fn run_git(dir: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_sync(&dir, &args))
        .await
        .map_err(|e| format!("git 任务失败: {e}"))?
}

/// Parse `git status --porcelain` into structured JSON.
pub(crate) fn parse_status(raw: &str) -> serde_json::Value {
    let files: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let (st, path) = if line.len() >= 4 {
                (&line[..2], line[3..].trim())
            } else {
                ("  ", line)
            };
            let status = match st.trim() {
                "M" => "modified",
                "A" => "added",
                "D" => "deleted",
                "R" => "renamed",
                "C" => "copied",
                "?" => "untracked",
                _ if st.starts_with(' ') && st.ends_with('M') => "modified",
                _ if st.starts_with(' ') && st.ends_with('D') => "deleted",
                _ => "modified",
            };
            let staged = !st.starts_with(' ') && st != "??";
            let is_rename = st.contains('R');
            // For renames, the path looks like "old -> new"
            let (display_path, old_path) = if is_rename && path.contains(" -> ") {
                let parts: Vec<&str> = path.split(" -> ").collect();
                (parts[1].to_string(), Some(parts[0].to_string()))
            } else {
                (path.to_string(), None)
            };
            let mut obj = serde_json::json!({
                "path": display_path,
                "status": status,
                "staged": staged,
            });
            if let Some(old) = old_path {
                obj["old_path"] = serde_json::json!(old);
            }
            obj
        })
        .collect();
    serde_json::json!(files)
}

/// Atomic write: temp file then rename.
pub(crate) fn write_atomic(file_path: &str, content: &str) -> Result<(), String> {
    let tmp_path = format!("{}.tmp", file_path);
    std::fs::write(&tmp_path, content)
        .map_err(|e| format!("write_atomic(tmp): {}", e))?;
    std::fs::rename(&tmp_path, file_path)
        .map_err(|e| format!("write_atomic(rename): {}", e))?;
    Ok(())
}

/// Find line in content containing query (fuzzy substring match).
pub(crate) fn fuzzy_find(content: &str, query: &str) -> Option<(usize, String)> {
    let q = query.trim();
    if q.is_empty() { return None; }
    for (i, line) in content.lines().enumerate() {
        if line.contains(q) {
            return Some((i + 1, line.trim().chars().take(80).collect()));
        }
    }
    None
}
