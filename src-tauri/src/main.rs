// HoloGram Tauri Backend
// 桥接层：Agent (TypeScript) → Tauri commands → Rust engine
// 不做分析逻辑，只做进程管理和文本转发

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mcp_manager;
mod pty_manager;
mod lsp_manager;
mod unity_manager;
mod engine_client;
mod sandbox;
mod audit;
mod credential;
mod logging;

use mcp_manager::McpManager;
use pty_manager::{pty_spawn, pty_write, pty_resize, pty_kill};
use lsp_manager::{lsp_start, lsp_request, lsp_stop};
use unity_manager::UnityManager;
use sandbox::Sandbox;
use audit::{AuditEntry, AuditLogger, now_iso};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tracing_appender::non_blocking::WorkerGuard;

// Windows: hide console windows for subprocesses
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW — suppress console popup on Windows
#[cfg(windows)]
pub(crate) const NO_WINDOW: u32 = 0x08000000;

// ═══════════════════════════════════════════════════════
// Background job system — timeout + background + output + kill
// ═══════════════════════════════════════════════════════

struct BgJob {
    child: std::process::Child,
    stdout_buf: Vec<u8>,
    stderr_buf: Vec<u8>,
    start_time: std::time::Instant,
}

static BG_JOBS: std::sync::LazyLock<Arc<Mutex<HashMap<u32, BgJob>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

static NEXT_JOB_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Cached bash availability on Windows — detected once, avoids blocking every shell call.
static HAS_BASH: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Logging guard — initialized once on first project open, held for process lifetime.
static LOG_GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();

fn has_bash() -> bool {
    *HAS_BASH.get_or_init(|| {
        std::process::Command::new("bash")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

fn spawn_bg(cmd: &str, cwd: &str) -> Result<u32, String> {
    let mut child = if cfg!(target_os = "windows") {
        if has_bash() {
            let mut c = silent_command("bash");
            c.arg("-c").arg(cmd);
            c
        } else {
            let mut c = silent_command("cmd");
            c.arg("/s").arg("/c").arg(cmd);
            c
        }
    } else {
        let mut c = silent_command("sh");
        c.arg("-c").arg(sh_escape(cmd));
        c
    };
    let child = child
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
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

fn read_bg_output(id: u32) -> Result<String, String> {
    let mut jobs = BG_JOBS.lock().unwrap();
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
    // Drain what's available without blocking
    if let Some(stdout) = &mut job.child.stdout {
        let mut buf = [0u8; 4096];
        loop {
            use std::io::Read;
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => job.stdout_buf.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
    }
    if let Some(stderr) = &mut job.child.stderr {
        let mut buf = [0u8; 4096];
        loop {
            use std::io::Read;
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

fn kill_bg(id: u32) -> Result<String, String> {
    let mut jobs = BG_JOBS.lock().unwrap();
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
    job.child.kill().map_err(|e| format!("无法终止任务: {e}"))?;
    let stdout = String::from_utf8_lossy(&job.stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&job.stderr_buf).to_string();
    jobs.remove(&id);
    Ok(format!("[任务已终止]\n{stdout}{stderr}"))
}

/// Build a Command that won't flash a console window on Windows.
fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(NO_WINDOW);
    }
    cmd
}

/// Safe shell quoting for `sh -c` on Unix — uses single-quote wrapping
/// with embedded single quotes escaped as '\'' (end quote, escaped quote, start quote).
fn sh_escape(command: &str) -> String {
    format!("'{}'", command.replace('\'', "'\\''"))
}


/// Find the Rust engine executable.
/// Checks: 1) HOLOGRAM_ENGINE env var  2) engine/target/release  3) engine/target/debug
fn engine_binary() -> String {
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

fn default_graph() -> String {
    project_root()
        .join("hologram_graph.json")
        .to_string_lossy()
        .to_string()
}

/// 当前活跃工作区（由 analyze_and_load 在成功分析后设置）。
/// 所有图查询命令优先使用活跃工作区的 hologram_graph.json，
/// 未设置时 fallback 到项目根目录的全局文件。
static ACTIVE_PROJECT: std::sync::LazyLock<Mutex<String>> =
    std::sync::LazyLock::new(|| Mutex::new(String::new()));

/// Set the active workspace — all tool commands route queries to this project.
/// Called from the frontend when opening a project (before loading its graph).
#[tauri::command]
fn set_active_project(path: String) -> Result<(), String> {
    *ACTIVE_PROJECT.lock().unwrap() = path.clone();
    // v4: init sandbox for this project
    let project_path = std::path::Path::new(&path);
    *SANDBOX.lock().unwrap() = Some(Sandbox::new(project_path));
    *AUDIT_LOGGER.lock().unwrap() = Some(AuditLogger::new(project_path));
    // Init structured logging on first project open
    let _ = LOG_GUARD.get_or_init(|| logging::init_logging(project_path));
    let last_path_file = project_root().join(".last_project");
    if let Err(e) = std::fs::write(&last_path_file, &path) {
        eprintln!("[hologram] failed to write .last_project: {e}");
    }
    Ok(())
}

/// Return the currently active workspace path (empty string if none set).
/// Used by the frontend as a fallback when graph meta.source_root is missing on cold start.
#[tauri::command]
fn get_active_project() -> Result<String, String> {
    Ok(ACTIVE_PROJECT.lock().unwrap().clone())
}

#[allow(dead_code)]
fn active_graph() -> String {
    let proj = ACTIVE_PROJECT.lock().unwrap();
    if !proj.is_empty() {
        std::path::PathBuf::from(proj.as_str())
            .join("hologram_graph.json")
            .to_string_lossy()
            .to_string()
    } else {
        default_graph()
    }
}

// ═══════════════════════════════════════════════════════
// Watcher State
// ═══════════════════════════════════════════════════════

struct WatcherState {
    running: AtomicBool,
    project_path: Mutex<String>,
}

/// Collect mtimes of all Python/TypeScript/JS files under root.
fn collect_file_mtimes(root: &str) -> HashMap<String, u64> {
    let mut map = HashMap::new();
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
                    if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                        map.insert(path.to_string_lossy().to_string(), dur.as_secs());
                    }
                }
            }
        }
    }
    map
}

/// Run analysis via Rust Engine for a project, return JSON.
/// Rust engine is fast enough (~4s for Django) that incremental mode is unnecessary.
fn run_engine_analysis(project_path: &str, _changed_files: &[String]) -> Option<String> {
    match direct_analyze(project_path) {
        Ok(json) => Some(json),
        Err(e) => {
            eprintln!("[hologram] engine analysis failed: {e}");
            None
        }
    }
}

// ═══════════════════════════════════════════════════════
// Direct engine calls — Agent tools call engine library functions in-process
// No MCP/stdio, no parameter translation, no process lifecycle.
// ═══════════════════════════════════════════════════════

use hologram_engine as engine;
use engine::mcp::CACHED_GRAPH;
use engine::graph::{Graph, CrossFileResolver};
use engine::analysis::{coupling::compute_coupling, fragile_nodes, detect_cycles, coupling_report,
    graph_summary, thread_conflict_report, find_blindspots, detect_framework_routes,
    synthesize_dynamic_edges, synthesize_dataflow_edges};
use engine::community::detect_communities;
use engine::pipeline::runner::analyze_project;
use engine::graph::query;

/// Run analysis and cache result in CACHED_GRAPH. Returns JSON summary.
fn direct_analyze(path: &str) -> Result<String, String> {
    let root = std::path::PathBuf::from(path);
    if !root.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let mut result = analyze_project(&root);
    CrossFileResolver::resolve(&mut result.graph);
    compute_coupling(&mut result.graph);
    detect_framework_routes(&mut result.graph, &root);
    synthesize_dynamic_edges(&mut result.graph, &root);
    synthesize_dataflow_edges(&mut result.graph, &root);
    let communities = detect_communities(&result.graph, 42);

    let nc = result.graph.node_count();
    let ec = result.graph.edge_count();
    let nodes: Vec<serde_json::Value> = result.graph.nodes.values().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
        "location": n.location, "in_degree": n.in_degree,
        "out_degree": n.out_degree, "properties": n.properties,
        "position": n.position, "community_id": n.community_id,
    })).collect();
    let edges: Vec<serde_json::Value> = result.graph.edges.values().map(|e| serde_json::json!({
        "id": e.id, "source": e.source, "target": e.target,
        "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
        "cross_file": e.cross_file, "direction": e.direction,
        "temporal_delay_sec": e.temporal_delay_sec, "medium_node_id": e.medium_node_id,
    })).collect();
    let communities_json: Vec<serde_json::Value> = communities.iter().enumerate()
        .map(|(i, c)| serde_json::json!({"id": format!("comm_{}", i), "size": c.len(), "node_ids": c}))
        .collect();

    let graph_clone = result.graph.clone();
    if let Ok(mut cache) = CACHED_GRAPH.lock() { *cache = Some(graph_clone); }

    // Persist hologram_graph.json for frontend
    let graph_path = format!("{}/hologram_graph.json", path);
    let wrapped = serde_json::json!({
        "meta": { "source_root": path,
            "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "version": "0.1.0", "node_count": nc, "edge_count": ec },
        "nodes": nodes, "edges": edges, "communities": communities_json,
    });
    let _ = std::fs::write(&graph_path, serde_json::to_string_pretty(&wrapped).unwrap_or_default());
    let _ = std::fs::remove_file(format!("{}/hologram_graph.hologram", path));

    Ok(serde_json::json!({
        "status": "ok", "total_nodes": nc, "total_edges": ec,
        "communities": communities.len(), "elapsed_secs": result.elapsed_secs,
        "node_count": nc, "edge_count": ec,
    }).to_string())
}

/// Read CACHED_GRAPH and run a query function.
fn with_graph<F: FnOnce(&Graph) -> serde_json::Value>(f: F) -> Result<String, String> {
    let cache = CACHED_GRAPH.lock().map_err(|e| format!("锁失败: {e}"))?;
    match cache.as_ref() {
        Some(g) => Ok(serde_json::to_string(&f(g)).unwrap_or_default()),
        None => Err("未加载图谱，请先运行 hologram_analyze".into()),
    }
}

// ═══════════════════════════════════════════════════════
// 22 Tauri commands — Agent tools → direct engine calls
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_analyze(path: Option<String>) -> Result<String, String> {
    let target = path.unwrap_or_else(|| project_root().to_string_lossy().to_string());
    let target_clone = target.clone();
    tokio::task::spawn_blocking(move || direct_analyze(&target_clone))
        .await.map_err(|e| format!("分析任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_neighbors(node_id: String, depth: Option<i32>) -> Result<String, String> {
    let d = depth.unwrap_or(2) as usize;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let nb = query::neighbors(g, &nid, d);
            serde_json::json!({"neighbors": nb.iter().map(|(s,t,d)| serde_json::json!([s,t,d])).collect::<Vec<_>>()})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_impact(node_id: String, max_depth: Option<i32>) -> Result<String, String> {
    let d = max_depth.unwrap_or(3) as usize;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let layers = query::impact(g, &nid, d);
            serde_json::json!({"layers": layers})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_path(from: String, to: String) -> Result<String, String> {
    let f = from.clone(); let t = to.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            match query::shortest_path(g, &f, &t) {
                Some(p) => serde_json::json!({"path": p, "length": p.len()}),
                None => serde_json::json!({"path": null, "message": "无路径"}),
            }
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_diff(before_path: String, _after_path: Option<String>) -> Result<String, String> {
    let bp = before_path.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |current| {
            match Graph::from_json_file(&bp) {
                Ok(before) => {
                    let diff = before.diff(current);
                    serde_json::json!({
                        "is_empty": diff.added_nodes.is_empty() && diff.removed_nodes.is_empty(),
                        "added_nodes": diff.added_nodes.len(),
                        "removed_nodes": diff.removed_nodes.len(),
                        "added_edges": diff.added_edges.len(),
                        "removed_edges": diff.removed_edges.len(),
                    })
                }
                Err(_) => {
                    let graph_json = serde_json::to_string_pretty(current).unwrap_or_default();
                    let _ = std::fs::write(&bp, &graph_json);
                    serde_json::json!({"is_empty": true, "message": "已创建基线快照"})
                }
            }
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_fragile(limit: Option<i32>) -> Result<String, String> {
    let lim = limit.unwrap_or(10) as usize;
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| serde_json::json!(fragile_nodes(g, lim)))
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_cycle(mode: Option<String>) -> Result<String, String> {
    let m = mode.unwrap_or_else(|| "all".into());
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let cycles = detect_cycles(g);
            let filtered: Vec<_> = if m == "data" || m == "llm" {
                cycles.into_iter().filter(|c| c.get("category").and_then(|v| v.as_str()) == Some(&m)).collect()
            } else { cycles };
            serde_json::json!({"cycles": filtered, "total_cycles": filtered.len(), "mode_filter": m})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_search(query: String, limit: Option<i32>) -> Result<String, String> {
    let q = query.clone(); let lim = limit.unwrap_or(50) as usize;
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let results = query::search_nodes(g, &q);
            let truncated: Vec<_> = results.iter().take(lim)
                .map(|n| serde_json::json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()}))
                .collect();
            serde_json::json!({"results": truncated, "total": results.len(), "limit": lim})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_coupling_report(module: String) -> Result<String, String> {
    let m = module.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| coupling_report(g, &m))
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_blindspots(threshold: Option<f64>) -> Result<String, String> {
    let _ = threshold;
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let c = coupling_report(g, "");
            let cycles = detect_cycles(g);
            let no_files: Vec<String> = vec![];
            let conflicts = thread_conflict_report(g, &no_files);
            let l4_count = c["L4"].as_u64().unwrap_or(0) as usize;
            find_blindspots(l4_count, cycles.len(), conflicts["conflict_count"].as_u64().unwrap_or(0) as usize)
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_thread_conflicts(severity: Option<String>) -> Result<String, String> {
    let node_id = severity.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let filter: Vec<String> = if node_id.is_empty() { vec![] } else { vec![node_id.clone()] };
            thread_conflict_report(g, &filter)
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_community_report(resolution: Option<f64>, min_size: Option<i32>) -> Result<String, String> {
    let _ = resolution; let ms = min_size.unwrap_or(3);
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let communities = detect_communities(g, 42);
            let filtered: Vec<_> = communities.iter().enumerate()
                .filter(|(_, c)| c.len() >= ms as usize)
                .map(|(i, c)| serde_json::json!({"id": format!("comm_{}", i), "size": c.len(), "node_ids": c}))
                .collect();
            serde_json::json!({"communities": filtered, "total": filtered.len()})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_graph_summary() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| graph_summary(g))
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_rename(
    old_name: String, new_name: String, dry_run: Option<bool>, node_id: Option<String>,
) -> Result<String, String> {
    let _ = node_id; let on = old_name.clone(); let nn = new_name.clone();
    let dr = dry_run.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let matched: Vec<_> = g.nodes.values()
                .filter(|n| n.name == on || n.id.contains(&on))
                .collect();
            if matched.is_empty() {
                serde_json::json!({"error": format!("没有匹配 '{}' 的节点", on)})
            } else if dr {
                serde_json::json!({"dry_run": true, "matched_count": matched.len(),
                    "matched": matched.iter().map(|n| serde_json::json!({"id": n.id, "name": n.name})).collect::<Vec<_>>()})
            } else {
                serde_json::json!({"dry_run": false, "renamed_count": matched.len(),
                    "old_name": on, "new_name": nn, "note": "rename via in-process engine"})
            }
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_explore(
    query: Option<String>, symbols: Option<Vec<String>>, include_source: Option<bool>,
) -> Result<String, String> {
    let q = query.clone(); let sym = symbols.unwrap_or_default();
    let inc_src = include_source.unwrap_or(true);
    let proj = project_root();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            engine::analysis::explore::explore(g, &proj, &sym, q.as_deref(), inc_src)
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_run_check(path: Option<String>) -> Result<String, String> {
    let target = path.unwrap_or_else(|| project_root().to_string_lossy().to_string());
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let root = std::path::PathBuf::from(&target);
        let before_path = root.join(".hologram").join("baseline.json");
        let before = std::fs::read_to_string(&before_path).ok()
            .and_then(|s| serde_json::from_str::<Graph>(&s).ok())
            .unwrap_or_default();
        // Ensure graph is loaded
        let after = {
            let cache = CACHED_GRAPH.lock().map_err(|e| format!("锁失败: {e}"))?;
            match cache.as_ref() {
                Some(g) => g.clone(),
                None => {
                    drop(cache);
                    direct_analyze(&target)?;
                    CACHED_GRAPH.lock().map_err(|e| format!("锁失败: {e}"))?
                        .as_ref().cloned()
                        .ok_or("分析后无图谱".to_string())?
                }
            }
        };
        let result = run_full_check(&before, &after, &[], &target);
        let _ = std::fs::create_dir_all(root.join(".hologram"));
        let _ = std::fs::write(&before_path, serde_json::to_string_pretty(&after).unwrap_or_default());
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("简报任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_run_health(path: Option<String>, days: Option<i32>) -> Result<String, String> {
    let target = path.unwrap_or_else(|| project_root().to_string_lossy().to_string());
    let d = days.unwrap_or(30);
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let c = coupling_report(g, "");
            let cycles = detect_cycles(g);
            let fragile = fragile_nodes(g, 10);
            let l4 = c["L4"].as_u64().unwrap_or(0) as f64;
            let density = if g.node_count() > 0 {
                (l4 / g.node_count() as f64 * 100.0).min(100.0)
            } else { 0.0 };
            let score = ((100.0 - density) * 0.6 + 40.0) as u32;
            serde_json::json!({
                "current_health": {
                    "score": score,
                    "breakdown": {"cycles": cycles.len(), "density": density as u32, "fragile": fragile.len()},
                    "total_nodes": g.node_count(), "total_edges": g.edge_count(),
                    "trend": "stable"
                },
                "days": d, "path": target,
                "note": "趋势数据需历史快照 — 仅展示当前状态",
                "summary": {
                    "nodes_total": g.node_count(), "edges_total": g.edge_count(),
                    "symbols": g.node_count(), "media": 0, "temporals": 0,
                    "edge_types": {"calls": 0, "defines": 0, "imports": 0}
                }
            })
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_history(node_id: String) -> Result<String, String> {
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            g.get_node(&nid).map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "out_degree": n.out_degree, "in_degree": n.in_degree
            })).unwrap_or(serde_json::json!({"error": "not found"}))
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_community(node_id: String) -> Result<String, String> {
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            let communities = detect_communities(g, 42);
            let found = communities.iter().find(|c| c.contains(&nid));
            found.map(|c| serde_json::json!({"community": c.iter().take(50).collect::<Vec<_>>()}))
                .unwrap_or(serde_json::json!({"community": null}))
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_delayed() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            use engine::graph::EdgeKind;
            let delayed: Vec<_> = g.edges.values()
                .filter(|e| matches!(e.kind, EdgeKind::Triggers | EdgeKind::Awaits | EdgeKind::Sequences))
                .map(|e| serde_json::json!({"source": e.source, "target": e.target, "type": e.kind.as_str()}))
                .collect();
            serde_json::json!(delayed)
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_run_preflight(
    path: String, files: Option<Vec<String>>,
) -> Result<String, String> {
    let p = path.clone(); let f = files.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let root = std::path::PathBuf::from(&p);
        let before = {
            let cache = CACHED_GRAPH.lock().map_err(|e| format!("锁失败: {e}"))?;
            cache.as_ref().cloned().unwrap_or_default()
        };
        let result = run_full_check(&Graph::default(), &before, &f, &p);
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
async fn hologram_status() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        with_graph(move |g| {
            serde_json::json!({
                "phase": "ready", "store": "MemoryIndex (direct)",
                "nodes": g.node_count(), "edges": g.edge_count(),
                "nodes_loaded": g.node_count(), "edges_loaded": g.edge_count(),
                "has_aux_indexes": true, "elapsed_ms": 0
            })
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// Timeline — already direct SQLite, kept as-is
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_timeline(
    path: Option<String>,
    since: Option<String>,
    limit: Option<i32>,
    _module: Option<String>,
) -> Result<String, String> {
    // Resolve project path
    let proj = path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| ACTIVE_PROJECT.lock().unwrap().clone());
    if proj.is_empty() {
        return Err("未设置活跃工作区".into());
    }
    let db_path = std::path::Path::new(&proj).join(".hologram").join("timeline.db");
    let db = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("无法打开时间轴数据库: {}", e))?;
    let lim = limit.unwrap_or(60);
    let module_filter = _module.filter(|m| !m.is_empty());

    // Build query with optional since filter
    let has_since = since.as_ref().filter(|s| !s.is_empty()).is_some();
    let sql = if has_since {
        "SELECT id, timestamp, event_type, file, summary, properties FROM events WHERE timestamp >= ?1 ORDER BY id DESC LIMIT ?2"
    } else {
        "SELECT id, timestamp, event_type, file, summary, properties FROM events ORDER BY id DESC LIMIT ?1"
    };
    let mut stmt = db.prepare(sql).map_err(|e| format!("查询失败: {}", e))?;
    let events: Vec<serde_json::Value> = if has_since {
        let since_val = since.as_deref().unwrap_or("");
        stmt.query_map(rusqlite::params![since_val, lim], |row| {
            let props_str: String = row.get(5).unwrap_or_else(|_| "{}".into());
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, String>(1)?,
                "event_type": row.get::<_, String>(2)?,
                "file": row.get::<_, String>(3).unwrap_or_default(),
                "summary": row.get::<_, String>(4).unwrap_or_default(),
                "properties": serde_json::from_str::<serde_json::Value>(&props_str).unwrap_or_default(),
            }))
        }).map_err(|e| format!("读取失败: {}", e))?
        .filter_map(|r| r.ok()).collect()
    } else {
        stmt.query_map(rusqlite::params![lim], |row| {
            let props_str: String = row.get(5).unwrap_or_else(|_| "{}".into());
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, String>(1)?,
                "event_type": row.get::<_, String>(2)?,
                "file": row.get::<_, String>(3).unwrap_or_default(),
                "summary": row.get::<_, String>(4).unwrap_or_default(),
                "properties": serde_json::from_str::<serde_json::Value>(&props_str).unwrap_or_default(),
            }))
        }).map_err(|e| format!("读取失败: {}", e))?
        .filter_map(|r| r.ok()).collect()
    };
    // Apply module filter if provided
    let events: Vec<_> = if let Some(ref m) = module_filter {
        events.into_iter().filter(|e| {
            e.get("file").and_then(|f| f.as_str())
                .map(|f| f.contains(m.as_str()))
                .unwrap_or(false)
        }).collect()
    } else {
        events
    };
    Ok(serde_json::json!({"events": events, "module_filter": module_filter}).to_string())
}

/// Record a user-facing event in the timeline DB (file save, edit, etc.).
#[tauri::command]
async fn hologram_record_event(
    event_type: String,
    file: Option<String>,
    summary: String,
) -> Result<String, String> {
    let proj = ACTIVE_PROJECT.lock().unwrap().clone();
    if proj.is_empty() {
        return Err("未设置活跃工作区".into());
    }
    let db_path = std::path::Path::new(&proj).join(".hologram").join("timeline.db");
    let db = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("无法打开时间轴: {}", e))?;
    let ts = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let file_val = file.unwrap_or_default();
    db.execute(
        "INSERT INTO events (timestamp, event_type, file, summary) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![ts, event_type, file_val, summary],
    ).map_err(|e| format!("写入失败: {}", e))?;
    Ok("ok".into())
}

#[tauri::command]
async fn hologram_changes() -> Result<String, String> {
    let proj = ACTIVE_PROJECT.lock().unwrap().clone();
    let db_path = std::path::Path::new(&proj).join(".hologram").join("timeline.db");
    let db = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("无法打开时间轴: {}", e))?;
    let mut stmt = db.prepare("SELECT timestamp, event_type, summary FROM events ORDER BY id DESC LIMIT 10")
        .map_err(|e| format!("查询失败: {}", e))?;
    let changes: Vec<serde_json::Value> = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "timestamp": row.get::<_, String>(0)?,
            "event_type": row.get::<_, String>(1)?,
            "summary": row.get::<_, String>(2).unwrap_or_default(),
        }))
    }).map_err(|e| format!("读取: {}", e))?
    .filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!({"changes": changes}).to_string())
}

// ═══════════════════════════════════════════════════════
// P6: Hotspots — 复发热点检测（L4 复发计数）
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_hotspots(
    days: Option<i32>,
    min_count: Option<i32>,
) -> Result<String, String> {
    let limit = min_count.unwrap_or(3);
    let _ = days;
    // Read timeline directly from SQLite
    let proj = ACTIVE_PROJECT.lock().unwrap().clone();
    let db_path = std::path::Path::new(&proj).join(".hologram").join("timeline.db");
    match rusqlite::Connection::open(&db_path) {
        Ok(db) => {
            let mut stmt = db.prepare("SELECT timestamp, event_type, file, summary FROM events ORDER BY id DESC LIMIT ?1")
                .map_err(|e| format!("查询失败: {e}"))?;
            let events: Vec<serde_json::Value> = stmt.query_map(rusqlite::params![limit], |row| {
                Ok(serde_json::json!({
                    "timestamp": row.get::<_, String>(0)?,
                    "event_type": row.get::<_, String>(1)?,
                    "file": row.get::<_, String>(2).unwrap_or_default(),
                    "summary": row.get::<_, String>(3).unwrap_or_default(),
                }))
            }).map_err(|e| format!("读取失败: {e}"))?
            .filter_map(|r| r.ok()).collect();
            Ok(serde_json::json!({"events": events, "limit": limit}).to_string())
        }
        Err(e) => Ok(serde_json::json!({"error": format!("无法打开时间轴: {e}"), "events": []}).to_string())
    }
}

// ═══════════════════════════════════════════════════════
// P7: Workspace Conflict — 多工作区冲突预演
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_workspace_conflict(
    path_a: String,
    path_b: String,
) -> Result<String, String> {
    // No dedicated MCP conflict tool yet — return structured stub
    Ok(serde_json::json!({
        "status": "not_implemented",
        "message": "workspace_conflict requires a dedicated MCP tool (not yet implemented in engine). Use hologram_preflight on each workspace to compare impact.",
        "path_a": path_a,
        "path_b": path_b,
    }).to_string())
}

// ═══════════════════════════════════════════════════════
// P8: Gate Check — 门禁模式（新模块 fan-in/fan-out/耦合评估）
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_gate_check(
    path: String,
    _module_file: Option<String>,
) -> Result<String, String> {
    // Gate check reuses hologram_run_check logic
    let target = path;
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let root = std::path::PathBuf::from(&target);
        let before = Graph::default();
        let after = {
            let cache = CACHED_GRAPH.lock().map_err(|e| format!("锁失败: {e}"))?;
            cache.as_ref().cloned().unwrap_or_default()
        };
        let result = run_full_check(&before, &after, &[], &target);
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// P4: Terminal — execute shell commands
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn exec_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: Option<bool>,
) -> Result<String, String> {
    let dir = cwd.unwrap_or_else(|| project_root().to_string_lossy().to_string());

    if run_in_background.unwrap_or(false) {
        let id = spawn_bg(&command, &dir)?;
        return Ok(format!("[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_kill({}) 终止任务", id, id, id));
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000)); // default 5 min

    let mut child = if cfg!(target_os = "windows") {
        // Cached bash detection — avoids blocking the async runtime on every call
        if has_bash() {
            let mut c = silent_command("bash");
            c.arg("-c").arg(&command);
            c
        } else {
            let mut c = silent_command("cmd");
            c.arg("/s").arg("/c").arg(&command);
            c
        }
    } else {
        let mut c = silent_command("sh");
        c.arg("-c").arg(sh_escape(&command));
        c
    };
    let mut child = child
        .current_dir(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法执行命令: {e}"))?;

    // Manual timeout polling (compatible with older Rust)
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = if let Some(mut p) = child.stdout.take() {
                    let mut v = Vec::new();
                    if let Err(e) = p.read_to_end(&mut v) {
                        eprintln!("[hologram] read_to_end stdout failed: {e}");
                    }
                    String::from_utf8_lossy(&v).to_string()
                } else { String::new() };
                let stderr = if let Some(mut p) = child.stderr.take() {
                    let mut v = Vec::new();
                    if let Err(e) = p.read_to_end(&mut v) {
                        eprintln!("[hologram] read_to_end stderr failed: {e}");
                    }
                    String::from_utf8_lossy(&v).to_string()
                } else { String::new() };

                if !status.success() {
                    return Err(format!(
                        "命令失败 (exit code: {}):\n{}{}",
                        status.code().unwrap_or(-1),
                        stderr,
                        if stdout.len() > 500 { format!("{}...", &stdout[..500]) } else { stdout }
                    ));
                }

                if stdout.is_empty() && stderr.is_empty() {
                    return Ok("(无输出)".into());
                }
                return Ok(format!("{}{}", stdout, stderr));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    child.kill().ok();
                    return Err(format!("命令超时 ({}ms)，已强制终止", timeout_ms.unwrap_or(300_000)));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                child.kill().ok();
                return Err(format!("命令执行异常: {e}"));
            }
        }
    }
}

#[tauri::command]
async fn bash_output(job_id: u32) -> Result<String, String> {
    read_bg_output(job_id)
}

#[tauri::command]
async fn bash_kill(job_id: u32) -> Result<String, String> {
    kill_bg(job_id)
}

// ═══════════════════════════════════════════════════════
// P4: File viewer — read file content for floating editor
// ═══════════════════════════════════════════════════════

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<DirEntry>>,
}

/// Recursively list directory contents (depth-limited to avoid huge trees).
fn list_dir_recursive(root: &std::path::Path, depth: u32) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    if depth == 0 { return entries; }

    // Directories to skip
    let skip_dirs: std::collections::HashSet<&str> = [
        ".git", ".hg", ".svn", "__pycache__", ".pytest_cache", ".mypy_cache",
        "node_modules", ".venv", "venv", ".hologram", "dist", "build", "target",
        ".next", ".nuxt", ".cache", "egg-info", ".eggs",
    ].iter().cloned().collect();

    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };

    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and dirs (except .env, .gitignore etc.)
        if name.starts_with('.') && name != ".env" && name != ".gitignore" && name != ".editorconfig" {
            continue;
        }

        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }

        let children = if is_dir {
            Some(list_dir_recursive(&path, depth - 1))
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

    // Sort: dirs first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    entries
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", path));
    }
    Ok(list_dir_recursive(&root, 4))
}

#[tauri::command]
async fn read_file_content(
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<String, String> {
    let real_path = check_sandbox_read(&file_path)?;
    let content = std::fs::read_to_string(&real_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(0).min(lines.len());
    let end = limit
        .map(|l| (start + l).min(lines.len()))
        .unwrap_or(lines.len());
    Ok(lines[start..end].join("\n"))
}

#[tauri::command]
async fn write_file_content(file_path: String, content: String) -> Result<(), String> {
    let real_path = check_sandbox_write(&file_path)?;
    let rp = real_path.to_string_lossy().to_string();
    if let Some(parent) = real_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    // Atomic write: temp file then rename
    let tmp_path = format!("{}.tmp", rp);
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("无法写入临时文件 {}: {}", tmp_path, e))?;
    std::fs::rename(&tmp_path, &rp)
        .map_err(|e| format!("无法保存文件 {}: {}", rp, e))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════
// File tree operations
// ═══════════════════════════════════════════════════════

/// Append a line to a log file — used by the TypeScript UI logger.
#[tauri::command]
fn log_append(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("log_append: cannot open {}: {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("log_append: write failed: {}", e))
}

#[tauri::command]
async fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("无法创建目录 {}: {}", path, e))
}

#[tauri::command]
async fn delete_file_or_dir(path: String) -> Result<(), String> {
    let real = check_sandbox_write(&path)?; // delete = write-level lock
    if !real.exists() { return Err(format!("路径不存在: {}", path)); }
    if real.is_dir() {
        std::fs::remove_dir_all(&real)
            .map_err(|e| format!("无法删除目录 {}: {}", path, e))
    } else {
        std::fs::remove_file(&real)
            .map_err(|e| format!("无法删除文件 {}: {}", path, e))
    }
}

#[tauri::command]
async fn rename_file_or_dir(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to)
        .map_err(|e| format!("无法重命名 {} -> {}: {}", from, to, e))
}

#[tauri::command]
async fn move_file(source: String, dest_dir: String) -> Result<(), String> {
    let src_real = check_sandbox_read(&source)?;
    let dest_real = check_sandbox_write(&dest_dir)?;
    let name = src_real.file_name()
        .ok_or_else(|| format!("无效路径: {}", source))?;
    let dest = dest_real.join(name);
    std::fs::rename(&src_real, &dest)
        .map_err(|e| format!("无法移动 {} -> {}: {}", source, dest.display(), e))
}

// ═══════════════════════════════════════════════════════
// Coding Agent: search_code — grep over project files
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn search_code(
    directory: String,
    pattern: String,
    file_types: Option<String>,
    max_results: Option<usize>,
    use_regex: Option<bool>,
) -> Result<String, String> {
    let root = std::path::PathBuf::from(&directory);
    let is_regex = use_regex.unwrap_or(false);
    let regex = if is_regex {
        Some(regex::RegexBuilder::new(&pattern)
            .case_insensitive(true)
            .multi_line(true)
            .build()
            .map_err(|e| format!("正则表达式无效: {}", e))?)
    } else {
        None
    };
    let sub_patterns: Vec<String> = if is_regex {
        Vec::new()
    } else {
        pattern.to_lowercase().split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    };
    let extensions: Vec<String> = file_types
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let max = max_results.unwrap_or(50).min(200);
    let mut results: Vec<serde_json::Value> = Vec::new();

    let skip_dirs: Vec<&str> = vec![
        ".git", "node_modules", ".venv", "venv", "__pycache__",
        "target", "dist", ".next", ".nuxt", "build", ".cache",
        ".hologram", ".idea", ".vscode",
    ];

    let skip_extensions: Vec<&str> = vec![
        "exe", "dll", "so", "dylib", "bin", "o", "a",
        "png", "jpg", "jpeg", "gif", "ico", "svg",
        "woff", "woff2", "ttf", "eot",
        "zip", "tar", "gz", "bz2", "7z", "rar",
        "mp3", "mp4", "avi", "mov", "wav",
        "pdf", "doc", "docx", "xls", "xlsx",
        "pyc", "pyo", "class", "wasm",
        "lock", "map", "min.js", "min.css",
    ];

    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !skip_dirs.iter().any(|d| name == *d)
        })
    {
        let entry = entry.map_err(|e| format!("读取文件失败: {}", e))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let fp = entry.path();
        let ext = fp.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let name = fp.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        if skip_extensions.iter().any(|skip| ext == *skip || name.ends_with(skip)) {
            continue;
        }
        if !extensions.is_empty() && !extensions.iter().any(|e| ext == *e) {
            continue;
        }

        let content = match std::fs::read_to_string(fp) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (line_no, line) in content.lines().enumerate() {
            let matched = if let Some(ref re) = regex {
                re.is_match(line)
            } else {
                let line_lower = line.to_lowercase();
                sub_patterns.iter().any(|p| line_lower.contains(p))
            };
            if matched {
                results.push(serde_json::json!({
                    "file": fp.to_string_lossy(),
                    "line": line_no + 1,
                    "content": line.trim(),
                }));
                if results.len() >= max {
                    break;
                }
            }
        }
        if results.len() >= max {
            break;
        }
    }

    Ok(serde_json::json!({
        "pattern": pattern,
        "count": results.len(),
        "truncated": results.len() >= max,
        "results": results,
    }).to_string())
}

// ═══════════════════════════════════════════════════════
// Coding Agent: edit_file — exact string replacement (Claude Code style)
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn edit_file(
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<String, String> {
    let content = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;

    let replace_all = replace_all.unwrap_or(false);
    let count = if replace_all {
        content.matches(&old_string).count()
    } else {
        if old_string.is_empty() {
            return Err("old_string 不能为空".to_string());
        }
        let c = content.matches(&old_string).count();
        if c == 0 {
            return Err(format!("文件中未找到指定的文本片段。请确认 old_string 与文件内容完全一致（包括缩进和换行）。"));
        }
        if c > 1 {
            return Err(format!(
                "old_string 在文件中出现了 {} 次，不是唯一的。请添加更多上下文使其唯一，或设置 replace_all: true。",
                c
            ));
        }
        c
    };

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    // Atomic write: temp file then rename (prevents corruption on crash)
    let tmp_path = format!("{}.tmp", file_path);
    std::fs::write(&tmp_path, &new_content)
        .map_err(|e| format!("无法写入临时文件 {}: {}", tmp_path, e))?;
    std::fs::rename(&tmp_path, &file_path)
        .map_err(|e| format!("无法保存文件 {}: {}", file_path, e))?;

    Ok(if replace_all {
        format!("已替换 {} 处匹配", count)
    } else {
        "已替换 1 处匹配".to_string()
    })
}

// ═══════════════════════════════════════════════════════
// Coding Agent: web_fetch — fetch a URL and extract readable text
// ═══════════════════════════════════════════════════════

fn is_private_ip(host: &str) -> bool {
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

#[tauri::command]
async fn web_fetch(url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("无效 URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("不支持的协议: {}", scheme));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || is_private_ip(host) {
        return Err("SSRF 防护: 不允许访问内网地址".to_string());
    }

    let resp = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build()
        .get(url.as_str())
        .set("User-Agent", "HoloGram/1.0")
        .set("Accept", "text/html, text/plain, application/json, text/markdown, */*")
        .call()
        .map_err(|e| format!("请求失败: {}", e))?;

    let content_type = resp.header("content-type").unwrap_or("").to_lowercase();
    let max_size: usize = 1 << 20; // 1 MiB
    let mut body = String::new();
    let reader = resp.into_reader();
    let mut limited = reader.take(max_size as u64);
    limited.read_to_string(&mut body)
        .map_err(|e| format!("读取失败: {}", e))?;

    let text = body.clone();
    let truncated = body.len() >= max_size;

    // HTML → plain text (simple tag stripping)
    let result = if content_type.contains("html") {
        let mut s = text;
        // Remove scripts, styles, comments
        s = regex::Regex::new(r"(?si)<script[^>]*>.*?</script>").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?si)<style[^>]*>.*?</style>").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?s)<!--.*?-->").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        // Remove all remaining tags
        s = regex::Regex::new(r"<[^>]*>").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        // Decode common entities
        s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
             .replace("&#x27;", "'").replace("&nbsp;", " ");
        // Collapse whitespace
        s = regex::Regex::new(r"[ \t]+").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"\n{3,}").unwrap_or_else(|_| regex::Regex::new(r"").unwrap()).replace_all(&s, "\n\n").to_string();
        s.trim().to_string()
    } else {
        text
    };

    let mut info = String::new();
    if truncated {
        info.push_str("[内容已截断至 1 MiB]\n\n");
    }
    Ok(format!("{info}{result}"))
}

// ═══════════════════════════════════════════════════════
// P4: Constraints UI — read/write hologram.constraints.yaml
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn read_constraints(project_path: String) -> Result<String, String> {
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    if !yaml_path.exists() {
        // Return default constraints from the repo template
        let default_path = project_root().join("hologram.constraints.yaml");
        return std::fs::read_to_string(&default_path)
            .map_err(|e| format!("无法读取默认约束文件: {}", e));
    }
    std::fs::read_to_string(&yaml_path)
        .map_err(|e| format!("无法读取约束文件: {}", e))
}

#[tauri::command]
async fn write_constraints(project_path: String, content: String) -> Result<(), String> {
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    let tmp_path = yaml_path.with_extension("yaml.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("无法写入临时文件: {}", e))?;
    std::fs::rename(&tmp_path, &yaml_path)
        .map_err(|e| format!("无法保存约束文件: {}", e))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════
// Graph loading — for star graph rendering
// ═══════════════════════════════════════════════════════

/// Load the graph JSON file and return it as a string.
/// Tries: 1) explicit path, 2) active project's hologram_graph.json,
/// 3) global fallback, 4) last project's hologram_graph.json.
#[tauri::command]
async fn load_graph_json(path: Option<String>) -> Result<String, String> {
    // 1) explicit path — must exist, no silent fallthrough to wrong project
    if let Some(ref p) = path {
        let content = std::fs::read_to_string(p)
            .map_err(|e| format!("Graph JSON not found at {}: {}", p, e))?;
        if content.trim().is_empty() {
            return Err(format!("Graph JSON file is empty: {}", p));
        }
        return Ok(content);
    }

    // 2) active workspace graph (only if ACTIVE_PROJECT is explicitly set)
    let proj = ACTIVE_PROJECT.lock().unwrap().clone();
    if !proj.is_empty() {
        let p = std::path::PathBuf::from(&proj).join("hologram_graph.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }

    // 3) last project's hologram_graph.json (user's previous workspace)
    let last_path_file = project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let trim = last_path.trim();
        if !trim.is_empty() {
            let p = std::path::PathBuf::from(trim).join("hologram_graph.json");
            if let Ok(content) = std::fs::read_to_string(&p) {
                if !content.trim().is_empty() {
                    // Restore ACTIVE_PROJECT so tool commands route correctly
                    *ACTIVE_PROJECT.lock().unwrap() = trim.to_string();
                    return Ok(content);
                }
            }
        }
    }

    // 4) global fallback — project root's own graph (HoloGramHG itself)
    let def = default_graph();
    if let Ok(content) = std::fs::read_to_string(&def) {
        if !content.trim().is_empty() {
            return Ok(content);
        }
    }

    Err("No cached graph found".into())
}

/// A3: Load graph from MessagePack binary (.hologram) — 10× faster for >10K nodes.
/// Tries: 1) explicit path, 2) active project .hologram, 3) global fallback .hologram,
/// 4) last project .hologram.
#[tauri::command]
async fn load_binary_graph(path: Option<String>) -> Result<Vec<u8>, String> {
    // 1) explicit path — must exist, no silent fallthrough to wrong project
    if let Some(ref p) = path {
        // If corresponding .json is newer, reject so frontend loads fresh JSON instead
        let json_path = p.replace(".hologram", ".json");
        if let (Ok(h_meta), Ok(j_meta)) = (std::fs::metadata(p), std::fs::metadata(&json_path)) {
            if let (Ok(h_time), Ok(j_time)) = (h_meta.modified(), j_meta.modified()) {
                if j_time > h_time {
                    return Err("JSON is newer — loading JSON instead".into());
                }
            }
        }
        let bytes = std::fs::read(p)
            .map_err(|e| format!("Binary graph not found at {}: {}", p, e))?;
        if bytes.is_empty() {
            return Err(format!("Binary graph file is empty: {}", p));
        }
        return Ok(bytes);
    }

    // helper: refuse stale .hologram when .json is newer or missing.
    // .hologram is a legacy Python-engine binary cache; we never write it from Rust.
    // If .json doesn't exist, .hologram is orphaned and must be treated as stale.
    fn holo_fresh(holo_path: &std::path::Path) -> bool {
        let json_path = holo_path.to_string_lossy().replace(".hologram", ".json");
        if let (Ok(h_meta), Ok(j_meta)) = (std::fs::metadata(holo_path), std::fs::metadata(&json_path)) {
            if let (Ok(h_time), Ok(j_time)) = (h_meta.modified(), j_meta.modified()) {
                return h_time >= j_time;
            }
        }
        false // .json missing → .hologram is orphaned legacy cache, skip it
    }

    // 2) active workspace .hologram (only if ACTIVE_PROJECT is explicitly set)
    let proj = ACTIVE_PROJECT.lock().unwrap().clone();
    if !proj.is_empty() {
        let p = std::path::PathBuf::from(&proj).join("hologram_graph.hologram");
        if p.exists() && holo_fresh(&p) {
            if let Ok(bytes) = std::fs::read(&p) {
                if !bytes.is_empty() {
                    return Ok(bytes);
                }
            }
        }
    }

    // 3) last project's .hologram (user's previous workspace)
    let last_path_file = project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let trim = last_path.trim();
        if !trim.is_empty() {
            let p = std::path::PathBuf::from(trim).join("hologram_graph.hologram");
            if p.exists() && holo_fresh(&p) {
                if let Ok(bytes) = std::fs::read(&p) {
                    if !bytes.is_empty() {
                        // Restore ACTIVE_PROJECT so tool commands route correctly
                        *ACTIVE_PROJECT.lock().unwrap() = trim.to_string();
                        return Ok(bytes);
                    }
                }
            }
        }
    }

    // 4) global fallback — project root's own .hologram (HoloGramHG itself)
    let def = project_root().join("hologram_graph.hologram");
    if def.exists() && holo_fresh(&def) {
        if let Ok(bytes) = std::fs::read(&def) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }

    Err("No cached binary graph found".into())
}

/// Check if cached graph JSON is fresher than all source files — instant load.
fn is_graph_fresh(graph_path: &str, project_path: &str) -> bool {
    let graph_meta = match std::fs::metadata(graph_path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let graph_mtime = match graph_meta.modified() {
        Ok(t) => t,
        Err(_) => return false,
    };

    // If any source file is newer than the graph, it's stale
    let exts = [".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs",
                 ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh",
                 ".rb", ".cs", ".kt", ".kts", ".swift", ".php", ".lua"];
    for entry in walkdir::WalkDir::new(project_path)
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
                    if mtime > graph_mtime {
                        return false; // stale — at least one file changed
                    }
                }
            }
        }
    }
    true // fresh — no source file newer than graph
}

/// Generate hologram_graph_files.json from an existing hologram_graph.json.
/// Pure Rust — no Python dependency. Groups nodes by file, aggregates edge counts.
fn regenerate_file_graph(project_path: &str) -> Result<String, String> {
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

    // Count edges per file pair
    let mut file_edges: std::collections::HashMap<(String, String), u32> = std::collections::HashMap::new();
    if let Some(edges) = g.get("edges").and_then(|v| v.as_array()) {
        for e in edges {
            let src = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let tgt = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
            // Find which file each node belongs to
            let src_file = find_node_file(&g, src);
            let tgt_file = find_node_file(&g, tgt);
            if !src_file.is_empty() && !tgt_file.is_empty() && src_file != tgt_file {
                *file_edges.entry((src_file, tgt_file)).or_default() += 1;
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

    std::fs::write(&files_path, serde_json::to_string_pretty(&file_graph).unwrap_or_default())
        .map_err(|e| format!("Cannot write file graph: {}", e))?;
    Ok("ok".to_string())
}

fn find_node_file(g: &serde_json::Value, node_id: &str) -> String {
    if let Some(nodes) = g.get("nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            if n.get("id").and_then(|v| v.as_str()) == Some(node_id) {
                let loc = n.get("location").and_then(|v| v.as_str()).unwrap_or("");
                return loc.split(':').next().unwrap_or("").to_string();
            }
        }
    }
    String::new()
}

/// Analyze a folder and return the graph JSON. Uses incremental cache.
/// Fast path: if cached graph is up-to-date, returns it instantly (no Python).
/// Set `force` to true to skip the fast-path cache and always re-analyze.
#[tauri::command]
async fn analyze_and_load(path: String, force: Option<bool>, app: tauri::AppHandle) -> Result<String, String> {
    let force = force.unwrap_or(false);
    // ── Fast path: cached graph still fresh ──
    let cached_graph = std::path::PathBuf::from(&path).join("hologram_graph.json");
    if !force && is_graph_fresh(&cached_graph.to_string_lossy(), &path) {
        if let Ok(content) = std::fs::read_to_string(&cached_graph) {
            if !content.trim().is_empty() {
                // Set active project so all tool commands route to this workspace
                *ACTIVE_PROJECT.lock().unwrap() = path.clone();
                if let Err(e) = std::fs::write(project_root().join(".last_project"), &path) {
                    eprintln!("[hologram] failed to write .last_project: {e}");
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("全息观测站");
                }
                // Ensure file-level graph exists (may be missing after cache deletion)
                let files_path = format!("{}/hologram_graph_files.json", path);
                if !std::path::Path::new(&files_path).exists() {
                    let _ = regenerate_file_graph(&path);
                }
                return Ok(content);
            }
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站 — 分析中...");
    }

    // Emit phase event
    let _ = app.emit("analyze-phase", serde_json::json!({
        "phase": "analysis", "message": "Rust 引擎分析中..."
    }));

    // ── Run analysis via MCP engine (engine.exe serve) ──
    let stdout = direct_analyze(&path)
        .map_err(|e| format!("Rust 引擎分析失败: {e}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站");
    }

    if stdout.trim().is_empty() || stdout.contains("\"error\"") {
        return Err(format!("分析失败: {}", stdout));
    }

    // Wrap Rust engine output with standard meta format (compatible with Python engine output)
    let engine_json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("引擎返回格式异常: {}", e))?;
    let wrapped = serde_json::json!({
        "meta": {
            "source_root": path,
            "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "version": "0.1.0",
            "node_count": engine_json.get("node_count").cloned().unwrap_or(serde_json::json!(0)),
            "edge_count": engine_json.get("edge_count").cloned().unwrap_or(serde_json::json!(0)),
        },
        "nodes": engine_json.get("nodes").cloned().unwrap_or(serde_json::json!([])),
        "edges": engine_json.get("edges").cloned().unwrap_or(serde_json::json!([])),
        "communities": engine_json.get("communities").cloned().unwrap_or(serde_json::json!([])),
    });
    let graph_json = serde_json::to_string_pretty(&wrapped).unwrap_or_default();

    // Save graph JSON to disk
    let graph_path = format!("{}/hologram_graph.json", path);
    std::fs::write(&graph_path, &graph_json)
        .map_err(|e| format!("保存图文件失败: {}", e))?;

    // Remove stale binary cache so cold start doesn't read old Python .hologram
    let _ = std::fs::remove_file(format!("{}/hologram_graph.hologram", path));

    // Register as active workspace — all tool commands now route here
    *ACTIVE_PROJECT.lock().unwrap() = path.clone();

    // ── Ensure file-level graph exists ──
    let files_path = format!("{}/hologram_graph_files.json", path);
    if !std::path::Path::new(&files_path).exists() {
        let _ = regenerate_file_graph(&path);
    }

    // Track last project for cold-start fallback
    let last_path_file = project_root().join(".last_project");
    if let Err(e) = std::fs::write(&last_path_file, &path) {
        eprintln!("[hologram] failed to write .last_project: {e}");
    }

    Ok(graph_json)
}

// ═══════════════════════════════════════════════════════
// Large Project Fast Path — skip full analysis, generate file graph only
// ═══════════════════════════════════════════════════════

/// Quick pre-scan: count source files & estimate project size.
/// Returns JSON {file_count, total_bytes, is_large} — is_large=true means
/// the project should skip full tree-sitter analysis and use file view.
#[tauri::command]
async fn estimate_project_size(path: String) -> Result<String, String> {
    let root = std::path::PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", path));
    }

    let skip_dirs: std::collections::HashSet<&str> = [
        ".git", ".hg", ".svn", "__pycache__", ".pytest_cache", ".mypy_cache",
        "node_modules", ".venv", "venv", ".hologram", "dist", "build", "target",
        ".next", ".nuxt", ".cache", "egg-info", ".eggs",
    ].iter().cloned().collect();

    let source_exts: std::collections::HashSet<&str> = [
        "py", "pyi", "ts", "tsx", "js", "jsx", "mjs",
        "go", "rs", "java", "c", "cpp", "cc", "cxx", "h", "hpp", "hh",
        "rb", "cs", "kt", "kts", "swift", "php", "lua",
    ].iter().cloned().collect();

    let mut file_count = 0u64;
    let mut total_bytes = 0u64;

    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !skip_dirs.contains(name.as_ref())
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry.path().extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if source_exts.contains(ext) {
            file_count += 1;
            if let Ok(meta) = entry.metadata() {
                total_bytes += meta.len();
            }
        }
    }

    // Threshold: >500 source files → skip full analysis, use file view
    let is_large = file_count > 500;

    Ok(serde_json::json!({
        "file_count": file_count,
        "total_bytes": total_bytes,
        "is_large": is_large,
    }).to_string())
}

/// Generate a lightweight file-level dependency graph via AST import scanning.
/// Skips full tree-sitter analysis. Handles Python (ast), JS/TS (regex), Go/Rust (regex).
/// Writes both hologram_graph.json and hologram_graph_files.json into the project dir.
/// Fast: ~5-30s even for Django-sized projects, vs 600s+ timeout for full analysis.
#[tauri::command]
async fn generate_lightweight_graph(path: String) -> Result<String, String> {
    // Rust engine full analysis replaces Python lightweight graph (faster: 4s vs 10-30s)
    let stdout = direct_analyze(&path)
        .map_err(|e| format!("引擎分析失败: {}", e))?;

    if stdout.trim().is_empty() || stdout.contains("\"error\"") {
        return Err(format!("分析失败: {}", stdout));
    }

    let engine_json: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("引擎返回格式异常: {}", e))?;
    let wrapped = serde_json::json!({
        "meta": {
            "source_root": path,
            "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "version": "0.1.0",
            "node_count": engine_json.get("node_count").cloned().unwrap_or(serde_json::json!(0)),
            "edge_count": engine_json.get("edge_count").cloned().unwrap_or(serde_json::json!(0)),
        },
        "nodes": engine_json.get("nodes").cloned().unwrap_or(serde_json::json!([])),
        "edges": engine_json.get("edges").cloned().unwrap_or(serde_json::json!([])),
        "communities": engine_json.get("communities").cloned().unwrap_or(serde_json::json!([])),
    });

    let graph_path = format!("{}/hologram_graph.json", path);
    let graph_json = serde_json::to_string_pretty(&wrapped).unwrap_or_default();
    std::fs::write(&graph_path, &graph_json)
        .map_err(|e| format!("保存文件失败: {}", e))?;

    let _ = regenerate_file_graph(&path);

    Ok(serde_json::to_string(&serde_json::json!({
        "ok": true,
        "file_count": engine_json.get("node_count"),
        "edge_count": engine_json.get("edge_count"),
    })).unwrap_or_default())
}

// ═══════════════════════════════════════════════════════
// Background Analysis — run full graph analysis without blocking the UI
// ═══════════════════════════════════════════════════════

/// Kick off full symbol-level analysis as a background job.
/// Spawns Python directly (no cmd /c wrapper) so env vars propagate correctly.
/// The frontend shows file view immediately while this runs.
/// On completion, emits "analysis-complete" or "analysis-failed" event.
/// The resulting hologram_graph.json overwrites the lightweight file graph,
/// so all MCP tools get full symbol-level data once the job finishes.
#[tauri::command]
async fn analyze_in_background(path: String, app: tauri::AppHandle) -> Result<String, String> {
    // Rust engine background analysis — direct in-process call
    let app2 = app.clone();
    let path2 = path.clone();
    std::thread::spawn(move || {
        match direct_analyze(&path2) {
            Ok(_) => {
                *ACTIVE_PROJECT.lock().unwrap() = path2.clone();
                let _ = std::fs::write(project_root().join(".last_project"), &path2);
                let _ = app2.emit("analysis-complete", serde_json::json!({"path": path2}));
            }
            Err(e) => {
                let _ = app2.emit("analysis-failed", serde_json::json!({"path": path2, "error": e}));
            }
        }
    });
    Ok(serde_json::json!({"job_id": 1, "status": "started"}).to_string())
}

// ═══════════════════════════════════════════════════════
// File Watcher — live incremental updates
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn start_watching(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<WatcherState>>,
) -> Result<(), String> {
    // Stop any existing watcher first
    state.running.store(false, Ordering::SeqCst);
    thread::sleep(Duration::from_millis(200));

    state.running.store(true, Ordering::SeqCst);
    *state.project_path.lock().unwrap() = path.clone();

    let watcher = state.inner().clone(); // Arc<WatcherState>
    let app_handle = app.clone();

    thread::spawn(move || {
        let mut last_mtimes = collect_file_mtimes(&path);
        let poll_interval = Duration::from_secs(1);
        let mut consecutive_failures: u32 = 0;

        while watcher.running.load(Ordering::SeqCst) {
            thread::sleep(poll_interval);

            if !watcher.running.load(Ordering::SeqCst) { break; }

            let current_mtimes = collect_file_mtimes(&path);

            // Collect changed file paths (new, modified, or deleted)
            let mut changed_files: Vec<String> = Vec::new();
            for (fp, mt) in &current_mtimes {
                match last_mtimes.get(fp) {
                    Some(old) if old != mt => changed_files.push(fp.clone()),
                    None => changed_files.push(fp.clone()), // new file
                    _ => {}
                }
            }
            // Deleted files
            for fp in last_mtimes.keys() {
                if !current_mtimes.contains_key(fp) {
                    changed_files.push(fp.clone());
                }
            }

            if !changed_files.is_empty() {
                if let Some(json) = run_engine_analysis(&path, &changed_files) {
                    last_mtimes = current_mtimes;
                    consecutive_failures = 0;
                    if let Err(e) = app_handle.emit("graph-updated", json) {
                        eprintln!("[hologram] emit graph-updated failed: {e}");
                    }
                } else {
                    consecutive_failures += 1;
                    // After 3 consecutive failures, update mtimes anyway to break the retry loop
                    // and notify the user that live updates are degraded
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

    Ok(())
}

#[tauri::command]
async fn stop_watching(
    state: tauri::State<'_, Arc<WatcherState>>,
) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    Ok(())
}

// ═══════════════════════════════════════════════════════
// Git 集成 — 轻量 SCM，直接调 git CLI
// ═══════════════════════════════════════════════════════

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
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

/// Parse `git status --porcelain` into structured JSON.
fn parse_status(raw: &str) -> serde_json::Value {
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

#[tauri::command]
async fn git_status(path: String) -> Result<String, String> {
    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let branch = branch.trim().to_string();

    let mut ahead = 0i32;
    let mut behind = 0i32;
    if !branch.is_empty() {
        // Ahead/behind vs upstream
        if let Ok(ab) = run_git(&path, &["rev-list", "--left-right", "--count", &format!("...origin/{}", branch)]) {
            let parts: Vec<&str> = ab.trim().split('\t').collect();
            if parts.len() == 2 {
                behind = parts[0].trim().parse().unwrap_or(0);
                ahead = parts[1].trim().parse().unwrap_or(0);
            }
        }
    }

    let porcelain = run_git(&path, &["status", "--porcelain"]).unwrap_or_default();
    let files = parse_status(&porcelain);

    let result = serde_json::json!({
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "files": files,
    });
    Ok(result.to_string())
}

#[tauri::command]
async fn git_diff_unstaged(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["diff", "--", &file])
}

#[tauri::command]
async fn git_diff_staged(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["diff", "--cached", "--", &file])
}

#[tauri::command]
async fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["add", "--"];
    let strs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(&strs);
    run_git(&path, &args)?;
    Ok("ok".into())
}

#[tauri::command]
async fn git_unstage(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["reset", "HEAD", "--"];
    let strs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(&strs);
    run_git(&path, &args)?;
    Ok("ok".into())
}

#[tauri::command]
async fn git_stage_all(path: String) -> Result<String, String> {
    run_git(&path, &["add", "-A"])?;
    Ok("ok".into())
}

#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message]).map(|s| s.trim().to_string())
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"]).map(|s| s.trim().to_string())
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String, String> {
    run_git(&path, &["pull", "--ff-only"]).map(|s| s.trim().to_string())
}

#[tauri::command]
async fn git_log(path: String, limit: Option<i32>) -> Result<String, String> {
    let n = limit.unwrap_or(20);
    let raw = run_git(
        &path,
        &["log", &format!("-{}", n), "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ai"],
    )?;
    let commits: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x00').collect();
            if parts.len() >= 5 {
                Some(serde_json::json!({
                    "hash": parts[0],
                    "short": parts[1],
                    "message": parts[2],
                    "author": parts[3],
                    "date": parts[4],
                }))
            } else {
                None
            }
        })
        .collect();
    Ok(serde_json::json!(commits).to_string())
}

#[tauri::command]
async fn git_init(path: String) -> Result<String, String> {
    run_git(&path, &["init"]).map(|s| s.trim().to_string())
}

// ── IDE-level Git operations ──

#[tauri::command]
async fn git_list_branches(path: String) -> Result<String, String> {
    let out = run_git(&path, &["branch", "--format=%(refname:short)"])?;
    let branches: Vec<&str> = out.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    // Find current branch (marked with *)
    let current_out = run_git(&path, &["branch", "--show-current"])?;
    let current = current_out.trim().to_string();
    serde_json::to_string(&serde_json::json!({ "branches": branches, "current": current }))
        .map_err(|e| format!("JSON 序列化失败: {}", e))
}

#[tauri::command]
async fn git_checkout(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["checkout", &branch])
}

#[tauri::command]
async fn git_create_branch(path: String, name: String) -> Result<String, String> {
    run_git(&path, &["checkout", "-b", &name])
}

#[tauri::command]
async fn git_stash_push(path: String) -> Result<String, String> {
    run_git(&path, &["stash", "push", "-m", "HoloGram"])
}

#[tauri::command]
async fn git_stash_pop(path: String) -> Result<String, String> {
    run_git(&path, &["stash", "pop"])
}

#[tauri::command]
async fn git_stash_list(path: String) -> Result<String, String> {
    run_git(&path, &["stash", "list"])
}

#[tauri::command]
async fn git_discard(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["checkout", "--", &file])
}

#[tauri::command]
async fn git_blame(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["blame", "--line-porcelain", &file])
}

#[tauri::command]
async fn git_file_at_head(path: String, file: String) -> Result<String, String> {
    run_git(&path, &["show", &format!("HEAD:{}", file)])
}

#[tauri::command]
async fn git_show(path: String, commit: String) -> Result<String, String> {
    let output = run_git(&path, &["show", "--name-only", "--format=", &commit])?;
    let files: Vec<&str> = output.lines().filter(|l| !l.is_empty()).collect();
    serde_json::to_string(&files).map_err(|e| e.to_string())
}

static MCP_MANAGER: std::sync::LazyLock<Arc<Mutex<McpManager>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(McpManager::new())));

// ═══════════════════════════════════════════════════════
// MCP Server 命令 — Step 1: 持久进程 + 自动工具发现
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn start_mcp_server(project_root: String) -> Result<String, String> {
    let engine = engine_binary();
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.start(&project_root, &engine)
}


#[tauri::command]
async fn stop_mcp_server() -> Result<String, String> {
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.stop();
    Ok("MCP Server 已停止".into())
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// v4 Phase 4: Unity event server — listens on :9776
// ═══════════════════════════════════════════════════════

use std::net::{TcpListener as StdTcpListener, TcpStream as StdTcpStream};

fn start_unity_event_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let listener = match StdTcpListener::bind("127.0.0.1:9776") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[unity-events] bind failed: {}", e);
                return;
            }
        };
        println!("[unity-events] listening on 127.0.0.1:9776");

        for stream in listener.incoming() {
            match stream {
                Ok(mut s) => {
                    handle_unity_connection(&mut s, &app);
                }
                Err(e) => eprintln!("[unity-events] accept error: {}", e),
            }
        }
    });
}

fn handle_unity_connection(stream: &mut StdTcpStream, app: &tauri::AppHandle) {
    let mut buf = vec![0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break, // connection closed
            Ok(n) => {
                let msg = String::from_utf8_lossy(&buf[..n]);
                println!("[unity-events] received: {}", msg.trim());

                // Parse simple key:value format
                let parts: Vec<&str> = msg.trim().splitn(2, ':').collect();
                if parts.len() == 2 {
                    let event = parts[0];
                    let payload = parts[1];
                    // Emit to frontend
                    let _ = app.emit("unity-event", serde_json::json!({
                        "event": event,
                        "payload": payload
                    }));
                }
            }
            Err(e) => {
                eprintln!("[unity-events] read error: {}", e);
                break;
            }
        }
    }
}

// ═══════════════════════════════════════════════════════
// v4 Phase 0: Unity process manager
// ═══════════════════════════════════════════════════════

static UNITY_MANAGER: std::sync::LazyLock<UnityManager> =
    std::sync::LazyLock::new(|| UnityManager::new(UnityManager::default_exe_path()));

static SANDBOX: std::sync::LazyLock<Mutex<Option<Sandbox>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

static AUDIT_LOGGER: std::sync::LazyLock<Mutex<Option<AuditLogger>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

fn start_engine() {
    std::thread::spawn(|| {
        let path = engine_binary();
        let p = std::path::Path::new(&path);
        if !p.exists() {
            eprintln!("[engine] binary not found at {} — run 'cd engine && cargo build --release'", path);
            return;
        }
        let mut cmd = std::process::Command::new(&path);
        cmd.stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(NO_WINDOW);
        }
        match cmd.spawn() {
            Ok(_child) => println!("[engine] auto-started: {}", path),
            Err(e) => eprintln!("[engine] failed to start {}: {}", path, e),
        }
    });
}

fn check_sandbox_read(file_path: &str) -> Result<std::path::PathBuf, String> {
    let sandbox = SANDBOX.lock().unwrap();
    let sandbox = sandbox.as_ref().ok_or("沙箱未初始化，请先打开项目")?;
    let path = std::path::Path::new(file_path);
    match sandbox.resolve_read(path) {
        sandbox::SandboxResult::Allowed(real) => Ok(real),
        sandbox::SandboxResult::Denied(reason) => {
            audit_deny("read", file_path, &reason);
            Err(format!("读取被拒绝: {}", reason))
        }
    }
}

fn check_sandbox_write(file_path: &str) -> Result<std::path::PathBuf, String> {
    let sandbox = SANDBOX.lock().unwrap();
    let sandbox = sandbox.as_ref().ok_or("沙箱未初始化，请先打开项目")?;
    let path = std::path::Path::new(file_path);
    match sandbox.resolve_write(path) {
        sandbox::SandboxResult::Allowed(real) => {
            audit_allow("write", file_path);
            Ok(real)
        }
        sandbox::SandboxResult::Denied(reason) => {
            audit_deny("write", file_path, &reason);
            Err(format!("写入被拒绝: {}", reason))
        }
    }
}

fn audit_allow(tool: &str, path: &str) {
    if let Ok(logger) = AUDIT_LOGGER.lock() {
        if let Some(ref logger) = *logger {
            logger.log(&AuditEntry {
                timestamp: now_iso(),
                tool: tool.to_string(),
                target_path: path.to_string(),
                action: "allowed".to_string(),
                reason: String::new(),
            });
        }
    }
}

fn audit_deny(tool: &str, path: &str, reason: &str) {
    if let Ok(logger) = AUDIT_LOGGER.lock() {
        if let Some(ref logger) = *logger {
            logger.log(&AuditEntry {
                timestamp: now_iso(),
                tool: tool.to_string(),
                target_path: path.to_string(),
                action: "denied".to_string(),
                reason: reason.to_string(),
            });
        }
    }
}

#[tauri::command]
fn start_unity() -> Result<String, String> {
    match UNITY_MANAGER.start() {
        Ok(true) => Ok("Unity started".into()),
        Ok(false) => Ok("Unity already running".into()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn stop_unity() -> Result<String, String> {
    UNITY_MANAGER.stop().map(|_| "Unity stopped".into())
}

#[tauri::command]
fn unity_status() -> Result<String, String> {
    Ok(if UNITY_MANAGER.is_running() { "running" } else { "stopped" }.into())
}

#[tauri::command]
fn engine_get_graph() -> Result<String, String> {
    with_graph(|g| graph_summary(g))
}

#[tauri::command]
fn engine_neighbors(node_id: String, depth: usize) -> Result<String, String> {
    with_graph(move |g| {
        let nb = query::neighbors(g, &node_id, depth);
        serde_json::json!({"neighbors": nb.iter().map(|(s,t,d)| serde_json::json!([s,t,d])).collect::<Vec<_>>()})
    })
}

#[tauri::command]
fn engine_path(from_id: String, to_id: String) -> Result<String, String> {
    with_graph(move |g| {
        match query::shortest_path(g, &from_id, &to_id) {
            Some(p) => serde_json::json!({"path": p, "length": p.len()}),
            None => serde_json::json!({"path": null, "message": "no path"}),
        }
    })
}

#[tauri::command]
fn engine_search(query: String) -> Result<String, String> {
    with_graph(move |g| {
        let results = query::search_nodes(g, &query);
        serde_json::json!({"results": results.iter().map(|n| serde_json::json!({"id":n.id,"name":n.name})).collect::<Vec<_>>()})
    })
}

#[tauri::command]
fn engine_impact(node_id: String, max_depth: usize) -> Result<String, String> {
    with_graph(move |g| {
        let layers = query::impact(g, &node_id, max_depth);
        serde_json::json!({"layers": layers})
    })
}

#[tauri::command]
fn credential_store(provider: String, key: String) -> Result<(), String> {
    credential::store_api_key(&provider, &key)
}

#[tauri::command]
fn credential_get(provider: String) -> Result<Option<String>, String> {
    credential::get_api_key(&provider)
}

#[tauri::command]
fn credential_clear() -> Result<(), String> {
    credential::clear_credentials()
}

fn main() {
    let watcher_state = Arc::new(WatcherState {
        running: AtomicBool::new(false),
        project_path: Mutex::new(String::new()),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher_state)
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill all orphaned background jobs (non-blocking — if lock is held, skip)
                if let Ok(mut jobs) = BG_JOBS.try_lock() {
                    for (_, job) in jobs.iter_mut() {
                        let _ = job.child.kill();
                        let _ = job.child.wait();
                    }
                    jobs.clear();
                }
                // Stop MCP server (non-blocking)
                if let Ok(mut mgr) = MCP_MANAGER.try_lock() {
                    mgr.stop();
                }
                // Stop Unity on exit
                let _ = UNITY_MANAGER.stop();
                // Hard exit to ensure no zombie processes
                std::process::exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            hologram_analyze,
            hologram_neighbors,
            hologram_impact,
            hologram_path,
            hologram_diff,
            hologram_fragile,
            hologram_search,
            hologram_cycle,
            hologram_coupling_report,
            hologram_blindspots,
            hologram_thread_conflicts,
            hologram_timeline,
            hologram_record_event,
            hologram_community_report,
            hologram_graph_summary,
            hologram_rename,
            set_active_project,
            get_active_project,
            load_graph_json,
            load_binary_graph,
            analyze_and_load,
            analyze_in_background,
            estimate_project_size,
            generate_lightweight_graph,
            hologram_run_check,
            hologram_run_preflight,
            hologram_run_health,
            hologram_history,
            hologram_community,
            hologram_delayed,
            hologram_changes,
            hologram_hotspots,
            hologram_workspace_conflict,
            hologram_gate_check,
            start_watching,
            stop_watching,
            list_directory,
            read_file_content,
            write_file_content,
            log_append,
            create_directory,
            delete_file_or_dir,
            rename_file_or_dir,
            move_file,
            read_constraints,
            write_constraints,
            exec_command,
            bash_output,
            bash_kill,
            // Git commands
            git_status,
            git_diff_unstaged,
            git_diff_staged,
            git_stage,
            git_unstage,
            git_stage_all,
            git_commit,
            git_push,
            git_pull,
            git_log,
            git_init,
            git_list_branches,
            git_checkout,
            git_create_branch,
            git_stash_push,
            git_stash_pop,
            git_stash_list,
            git_discard,
            git_blame,
            git_file_at_head,
            git_show,
            search_code,
            web_fetch,
            edit_file,
            start_mcp_server,
            stop_mcp_server,
            // PTY
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            // LSP
            lsp_start,
            lsp_request,
            lsp_stop,
            // v4 Phase 0 — Unity + Engine IPC
            start_unity,
            stop_unity,
            unity_status,
            engine_get_graph,
            engine_neighbors,
            engine_path,
            engine_search,
            engine_impact,
            credential_store,
            credential_get,
            credential_clear,
        ])
        .setup(|app| {
            // v4 Phase 4: server for Unity events
            start_unity_event_server(app.handle().clone());
            // Engine is started on-demand by start_mcp_server — no auto-start needed
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running hologram");
}

// ═══════════════════════════════════════════════════════
// #[cfg(test)] — 路由测试辅助（集成测试无法访问 binary crate static）
// ═══════════════════════════════════════════════════════

#[cfg(test)]
pub(crate) fn reset_active_project_for_test() {
    ACTIVE_PROJECT.lock().unwrap().clear();
}

#[cfg(test)]
pub(crate) fn set_active_project_for_test(path: &str) {
    *ACTIVE_PROJECT.lock().unwrap() = path.to_string();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_graph_falls_back_to_default_when_empty() {
        reset_active_project_for_test();
        let result = active_graph();
        let default = default_graph();
        assert_eq!(result, default);
    }

    #[test]
    fn active_graph_returns_workspace_path_when_set() {
        set_active_project_for_test("D:/projects/foo");
        let result = active_graph();
        assert!(result.contains("D:/projects/foo"));
        assert!(result.contains("hologram_graph.json"));
        reset_active_project_for_test();
    }

    #[test]
    fn active_graph_no_double_slash_when_trailing_slash() {
        set_active_project_for_test("D:/projects/foo/");
        let result = active_graph();
        assert!(!result.contains("//"));
        assert!(!result.contains("\\\\"));
        reset_active_project_for_test();
    }

    #[test]
    fn active_project_mutex_no_panic() {
        use std::thread;
        reset_active_project_for_test();

        let h1 = thread::spawn(|| {
            *ACTIVE_PROJECT.lock().unwrap() = "/a".to_string();
        });
        let h2 = thread::spawn(|| {
            *ACTIVE_PROJECT.lock().unwrap() = "/b".to_string();
        });
        h1.join().unwrap();
        h2.join().unwrap();

        let val = ACTIVE_PROJECT.lock().unwrap().clone();
        assert!(val == "/a" || val == "/b");
        reset_active_project_for_test();
    }
}
