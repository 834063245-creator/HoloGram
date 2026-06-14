// HoloGram Tauri Backend
// 桥接层：Agent (TypeScript) → Tauri commands → Python engine
// 不做分析逻辑，只做进程管理和文本转发

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mcp_manager;
mod pty_manager;
mod lsp_manager;

use mcp_manager::McpManager;
use pty_manager::{pty_spawn, pty_write, pty_resize, pty_kill};
use lsp_manager::{lsp_start, lsp_request, lsp_stop};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

// Windows: hide console windows for Python subprocesses
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

fn spawn_bg(cmd: &str, cwd: &str) -> Result<u32, String> {
    let mut child = if cfg!(target_os = "windows") {
        let mut c = silent_command("cmd");
        c.arg("/c").arg(cmd_escape(cmd));
        c
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

/// Build a Command that won't flash a console window on Windows
/// and forces UTF-8 output from Python subprocesses.
fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(NO_WINDOW);
    }
    let root = project_root();
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONPATH", root.to_string_lossy().to_string());
    cmd
}

/// Escape a command string for `cmd /c` on Windows.
/// `cmd /c` strips the outermost double quotes, so we wrap the command
/// and escape any inner `"` as `\"`. This prevents commands like
/// `node -e "console.log('hello')"` from losing their nested quotes.
fn cmd_escape(command: &str) -> String {
    format!("\"{}\"", command.replace('"', "\\\""))
}

/// Safe shell quoting for `sh -c` on Unix — uses single-quote wrapping
/// with embedded single quotes escaped as '\'' (end quote, escaped quote, start quote).
fn sh_escape(command: &str) -> String {
    format!("'{}'", command.replace('\'', "'\\''"))
}

/// JSON-encode a string for safe embedding in Python `json.loads(...)`.
/// Avoids Python injection via raw-string termination — r-strings cannot
/// contain literal `"`, and `json.loads` handles all escaping robustly.
fn py_json(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

// ═══════════════════════════════════════════════════════
// Python helpers
// ═══════════════════════════════════════════════════════

/// Find the Python executable with required dependencies.
/// Checks: 1) HOLOGRAM_PYTHON env var  2) bundled python next to exe  3) sibling venv  4) system PATH
fn python() -> String {
    // 1) Explicit override via environment variable
    if let Ok(p) = std::env::var("HOLOGRAM_PYTHON") {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    // 2) Bundled Python next to exe (production install)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("python").join("python.exe");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
    }
    // 3) Project-local venv (check both Windows and Unix layout)
    let venv_dir = project_root().join(".venv");
    for sub in &["Scripts", "bin"] {
        let py = venv_dir.join(sub).join("python.exe");
        if py.exists() { return py.to_string_lossy().to_string(); }
        let py3 = venv_dir.join(sub).join("python3");
        if py3.exists() { return py3.to_string_lossy().to_string(); }
        let py_n = venv_dir.join(sub).join("python");
        if py_n.exists() { return py_n.to_string_lossy().to_string(); }
    }
    // 3) System PATH fallbacks
    for name in &["python3", "python"] {
        if silent_command(name)
            .arg("--version")
            .output()
            .is_ok()
        {
            return name.to_string();
        }
    }
    "python".to_string()
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

/// Run a Python hologram CLI command with timeout (600s) and capture stdout+stderr.
fn run_hologram(args: &[&str]) -> Result<String, String> {
    let root = project_root();
    let timeout = std::time::Duration::from_secs(600);
    let mut child = silent_command(&python())
        .current_dir(&root)
        .args(["-m", "src_python"])
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_pipe(child.stdout.take());
                let stderr = read_pipe(child.stderr.take());
                let mut result = String::new();
                if !stderr.is_empty() { result.push_str(&stderr); result.push('\n'); }
                if !stdout.is_empty() { result.push_str(&stdout); }
                if !status.success() {
                    return Err(if result.is_empty() {
                        format!("Command failed with exit code {}", status)
                    } else { result });
                }
                return Ok(if result.is_empty() { "(no output)".into() } else { result });
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    child.kill().ok();
                    let _ = child.wait();
                    return Err("Python 命令超时 (600s)，已强制终止".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Failed to wait on Python process: {e}")),
        }
    }
}

/// Run inline Python code with timeout (300s) and return output.
fn run_python_code(code: &str) -> Result<String, String> {
    let root = project_root();
    let timeout = std::time::Duration::from_secs(300);
    let mut child = silent_command(&python())
        .current_dir(&root)
        .args(["-c", code])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_pipe(child.stdout.take());
                let stderr = read_pipe(child.stderr.take());
                if !status.success() {
                    return Err(format!("{}{}", stderr, stdout));
                }
                return Ok(format!("{}{}", stdout, stderr));
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    child.kill().ok();
                    let _ = child.wait();
                    return Err("Python 代码执行超时 (300s)，已强制终止".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Failed to wait on Python process: {e}")),
        }
    }
}

/// Read all bytes from a pipe into a lossy UTF-8 String.
fn read_pipe(pipe: Option<impl std::io::Read>) -> String {
    if let Some(mut p) = pipe {
        let mut v = Vec::new();
        let _ = p.read_to_end(&mut v);
        String::from_utf8_lossy(&v).to_string()
    } else {
        String::new()
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

/// Run incremental analysis for a project, return JSON.
/// If changed_files is non-empty, only those files are re-analyzed (incremental patch).
fn run_incremental_analysis(project_path: &str, changed_files: &[String]) -> Option<String> {
    let root = project_root();
    let mut args: Vec<String> = vec![
        "-m".into(), "src_python".into(),
        project_path.into(),
        "--format".into(), "json".into(),
    ];
    if !changed_files.is_empty() {
        args.push("--files".into());
        for f in changed_files {
            args.push(f.clone());
        }
    }

    let output = match silent_command(&python())
        .current_dir(&root)
        .args(&args)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[hologram] incremental analysis spawn failed: {e}");
            return None;
        }
    };

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !stdout.trim().is_empty() {
            return Some(stdout);
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[hologram] incremental analysis failed: {}", stderr);
    }
    None
}

// ═══════════════════════════════════════════════════════
// 13 Tauri commands — one per hologram tool
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_analyze(path: Option<String>) -> Result<String, String> {
    let target = path.unwrap_or_else(|| project_root().to_string_lossy().to_string());
    let graph_path = format!("{}/hologram_graph.json", target);
    run_hologram(&["analyze", &target, "-o", &graph_path])
}

#[tauri::command]
async fn hologram_neighbors(node_id: String, _depth: Option<i32>) -> Result<String, String> {
    let graph = active_graph();
    run_hologram(&["neighbors", &node_id, "-g", &graph])
}

#[tauri::command]
async fn hologram_impact(node_id: String, max_depth: Option<i32>) -> Result<String, String> {
    let graph = active_graph();
    let d = max_depth.unwrap_or(0);
    if d > 0 {
        run_hologram(&["impact", &node_id, "-d", &d.to_string(), "-g", &graph])
    } else {
        run_hologram(&["impact", &node_id, "-g", &graph])
    }
}

#[tauri::command]
async fn hologram_path(from: String, to: String) -> Result<String, String> {
    run_hologram(&["path", &from, &to, "-g", &active_graph()])
}

#[tauri::command]
async fn hologram_diff(before_path: String, after_path: Option<String>) -> Result<String, String> {
    let after = after_path.unwrap_or_else(|| active_graph());
    // Auto-create baseline snapshot if missing
    if !std::path::Path::new(&before_path).exists() {
        if let Err(e) = std::fs::copy(&after, &before_path) {
            return Err(format!("无法创建变更基线: {}", e));
        }
        return Ok(r#"{"is_empty":true,"added_nodes":[],"removed_nodes":[],"modified_nodes":[]}"#.to_string());
    }
    run_hologram(&["diff", &before_path, &after, "--json"])
}

#[tauri::command]
async fn hologram_fragile(limit: Option<i32>) -> Result<String, String> {
    let l = limit.unwrap_or(10);
    run_hologram(&["fragile", "-l", &l.to_string(), "-g", &active_graph()])
}

#[tauri::command]
async fn hologram_cycle(mode: Option<String>) -> Result<String, String> {
    let m = mode.unwrap_or_else(|| "all".into());
    run_hologram(&["cycle", "-m", &m, "-g", &active_graph()])
}

#[tauri::command]
async fn hologram_search(query: String, limit: Option<i32>) -> Result<String, String> {
    let l = limit.unwrap_or(20);
    run_hologram(&["search", &query, "-g", &active_graph(), "-l", &l.to_string()])
}

#[tauri::command]
async fn hologram_coupling_report(module: String) -> Result<String, String> {
    run_hologram(&["coupling-report", &module, "-g", &active_graph()])
}

#[tauri::command]
async fn hologram_blindspots(threshold: Option<f64>) -> Result<String, String> {
    let t = threshold.unwrap_or(0.5);
    let root = project_root();
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{}")
from src_python.analysis.blindspots import find_blindspots
from src_python.core.graph import Graph
graph = Graph.from_json(r"{}")
results = find_blindspots(graph, min_confidence={})
print(json.dumps(results, indent=2, ensure_ascii=False))
"#,
        root.to_string_lossy(),
        active_graph(),
        t,
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_thread_conflicts(_severity: Option<String>) -> Result<String, String> {
    let root = project_root();
    let code = format!(
        r#"
import sys, json, os
sys.path.insert(0, r"{}")
from src_python.analysis.threading import thread_conflict_report
sources = {{}}
sp = r"{}"
for dirpath, _, filenames in os.walk(sp):
    for fn in filenames:
        if fn.endswith('.py'):
            fp = os.path.join(dirpath, fn)
            try:
                with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                    sources[fp] = f.read()
            except: pass
result = thread_conflict_report(sources, language="python")
print(json.dumps(result, indent=2, ensure_ascii=False))
"#,
        root.to_string_lossy(),
        root.join("src_python").to_string_lossy(),
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_timeline(
    since: Option<String>,
    limit: Option<i32>,
    module: Option<String>,
) -> Result<String, String> {
    let root = project_root();
    let lim = limit.unwrap_or(50);
    let since_clause = since
        .map(|s| format!(" AND timestamp >= '{}'", s))
        .unwrap_or_default();
    let module_clause = module
        .map(|m| format!(" AND file LIKE '%{}%'", m))
        .unwrap_or_default();
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{}")
from timeline import TimelineStore
store = TimelineStore(r"{}")
rows = store.query(
    f"SELECT * FROM timeline WHERE 1=1 {{}} {{}} ORDER BY timestamp DESC LIMIT {{}}",
    '{}',
    '{}',
    {}
)
print(json.dumps(rows, indent=2, ensure_ascii=False, default=str))
store.close()
"#,
        root.join("src_python").to_string_lossy(),
        root.to_string_lossy(),
        since_clause,
        module_clause,
        lim,
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_community_report(
    resolution: Option<f64>,
    min_size: Option<i32>,
) -> Result<String, String> {
    let _ = resolution;
    let min = min_size.unwrap_or(3);
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{}")
from src_python.core.graph import Graph
from src_python.core.community import CommunityDetector
graph = Graph.from_json(r"{}")
detector = CommunityDetector()
communities = detector.detect(graph)
filtered = [c.to_dict() for c in communities if len(c.node_ids) >= {}]
print(json.dumps(filtered, indent=2, ensure_ascii=False))
"#,
        project_root().to_string_lossy(),
        active_graph(),
        min,
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_graph_summary() -> Result<String, String> {
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{}")
from core.graph import Graph
graph = Graph.from_json(r"{}")
nodes = list(graph.nodes.values())
edges = list(graph.edges.values())
node_types = {{}}
edge_types = {{}}
for n in nodes:
    nt = n.type.value if hasattr(n.type, 'value') else str(n.type)
    node_types[nt] = node_types.get(nt, 0) + 1
for e in edges:
    et = e.type.value if hasattr(e.type, 'value') else str(e.type)
    edge_types[et] = edge_types.get(et, 0) + 1
n = len(nodes)
density = round((2 * len(edges)) / (n * (n - 1)), 6) if n > 1 else 0
summary = {{
    "total_nodes": n,
    "total_edges": len(edges),
    "node_types": node_types,
    "edge_types": edge_types,
    "density": density,
    "communities": getattr(graph, 'community_count', 0),
    "top_node_kinds": sorted(node_types.items(), key=lambda x: x[1], reverse=True)[:10],
}}
print(json.dumps(summary, indent=2, ensure_ascii=False))
"#,
        project_root().join("src_python").to_string_lossy(),
        active_graph(),
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_rename(
    old_name: String,
    new_name: String,
    dry_run: Option<bool>,
    node_id: Option<String>,
) -> Result<String, String> {
    let root = project_root();
    let graph = active_graph();
    let is_dry = dry_run.unwrap_or(true);
    let nid = node_id.as_deref().unwrap_or("");
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, json.loads({py_src}))
from core.rename import preview_rename, execute_rename
from core.graph import Graph
graph = Graph.from_json(json.loads({graph}))
dry = {is_dry}
old = json.loads({old_name})
new = json.loads({new_name})
nid = json.loads({nid}) or None
proj = json.loads({proj})
if dry:
    result = preview_rename(graph, old, new, node_id=nid)
else:
    result = execute_rename(graph, old, new, project_root=proj, node_id=nid)
print(json.dumps(result, indent=2, ensure_ascii=False))
"#,
        py_src = py_json(&root.join("src_python").to_string_lossy()),
        graph = py_json(&graph),
        is_dry = if is_dry { "True" } else { "False" },
        old_name = py_json(&old_name),
        new_name = py_json(&new_name),
        nid = py_json(nid),
        proj = py_json(&root.to_string_lossy()),
    );
    run_python_code(&code)
}

// ═══════════════════════════════════════════════════════
// V3: Check — constraint validation + change summary
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_run_check(path: String) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", path);
    let root = project_root();
    let output = silent_command(&python())
        .current_dir(&root)
        .args(["-m", "src_python"])
        .args(["check", &path, "--json", "-g", &graph_path])
        .output()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    // ── Debug: log raw output to help diagnose "简报解析失败" ──
    let debug_log = project_root().join("_check_debug.log");
    let _ = std::fs::write(&debug_log, format!(
        "=== CHECK DEBUG {} ===\npath: {}\nexit: {}\n--- STDOUT ---\n{}\n--- STDERR ---\n{}\n=== END ===\n",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        path,
        output.status,
        stdout,
        stderr,
    ));

    // cmd_check returns exit code 1 when violations found — that's NOT a system error,
    // the JSON output in stdout still encodes the full pass/fail/violations result.
    if !stdout.trim().is_empty() {
        return Ok(stdout);
    }

    // Truly empty output: stderr might have the error detail
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            format!("Check failed with exit code {}", output.status)
        } else {
            stderr
        });
    }

    // Exit code 0 but no output: return a synthetic pass
    Ok("{\"passed\": true, \"message\": \"No output\"}".into())
}

// ═══════════════════════════════════════════════════════
// V3: Preflight — pre-commit impact analysis
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_run_preflight(path: String, files: Vec<String>) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", path);
    let mut args: Vec<&str> = vec!["preflight", &path, "--json", "-g", &graph_path];
    if !files.is_empty() {
        args.push("--files");
        // We need to collect the file strings into the args vec
        // Use a different approach: build args as Vec<String> and then convert
    }
    // Build args with owned strings
    let mut owned_args: Vec<String> = vec![
        "preflight".into(), path.clone(), "--json".into(), "-g".into(), graph_path,
    ];
    if !files.is_empty() {
        owned_args.push("--files".into());
        owned_args.extend(files);
    }
    let str_args: Vec<&str> = owned_args.iter().map(|s| s.as_str()).collect();
    run_hologram(&str_args)
}

// ═══════════════════════════════════════════════════════
// V3: Health — project health trends
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_run_health(path: String, days: Option<i32>) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", path);
    let d = days.unwrap_or(30);
    run_hologram(&["health", &path, "--json", "-g", &graph_path, "--days", &d.to_string()])
}

// ═══════════════════════════════════════════════════════
// Agent native tools — graph introspection (from MCP)
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_history(node_id: String) -> Result<String, String> {
    let root = project_root();
    let graph = active_graph();
    // Safely escape node_id for Python string literal
    let safe_id = serde_json::to_string(&node_id).unwrap_or_else(|_| format!(r#""{}""#, node_id));
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{root}")
from core.graph import Graph
graph = Graph.from_json(r"{graph}")
node_id = json.loads({safe_id})
node = graph.resolve_node(node_id)
if not node:
    print(json.dumps({{"error": "Node not found", "query": node_id}}))
else:
    incoming = graph.incoming_edges(node.id)
    outgoing = graph.outgoing_edges(node.id)
    result = {{
        "node": node.to_dict(),
        "query": node_id,
        "decision_history": node.properties.get("history", []) if node.properties else [],
        "dependency_count": len(incoming),
        "dependent_count": len(outgoing),
    }}
    print(json.dumps(result, indent=2, ensure_ascii=False))
"#,
        root = root.join("src_python").to_string_lossy(),
        graph = graph,
        safe_id = safe_id,
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_community(node_id: String) -> Result<String, String> {
    let root = project_root();
    let graph = active_graph();
    let safe_id = serde_json::to_string(&node_id).unwrap_or_else(|_| format!(r#""{}""#, node_id));
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{root}")
from core.graph import Graph
graph = Graph.from_json(r"{graph}")
node_id = json.loads({safe_id})
node = graph.resolve_node(node_id)
if not node:
    print(json.dumps({{"error": "Node not found", "query": node_id}}))
elif not hasattr(node, 'community_id') or not node.community_id:
    print(json.dumps({{"node_id": node.id, "node_name": node.name, "query": node_id, "community": None, "message": "Community detection not yet run"}}))
else:
    found = None
    for c in graph.communities:
        if c.id == node.community_id:
            found = c
            break
    if found:
        print(json.dumps({{
            "node_id": node.id,
            "node_name": node.name,
            "query": node_id,
            "community": found.to_dict(),
            "sibling_nodes": [nid for nid in found.node_ids if nid != node.id],
        }}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({{"node_id": node.id, "node_name": node.name, "query": node_id, "community": None}}))
"#,
        root = root.join("src_python").to_string_lossy(),
        graph = graph,
        safe_id = safe_id,
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_delayed() -> Result<String, String> {
    let root = project_root();
    let graph = active_graph();
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{root}")
from core.graph import Graph, EdgeType
graph = Graph.from_json(r"{graph}")
delayed = []
for edge in graph.edges.values():
    delay = getattr(edge, 'temporal_delay_sec', None)
    edge_type = edge.type.value if isinstance(edge.type, EdgeType) else str(edge.type)
    if delay is not None and edge_type == 'temporal':
        src = graph.get_node(edge.source)
        tgt = graph.get_node(edge.target)
        delayed.append({{
            "source": src.to_dict() if src else {{"id": edge.source}},
            "target": tgt.to_dict() if tgt else {{"id": edge.target}},
            "delay_sec": delay,
            "edge_direction": getattr(edge, 'direction', 'unknown'),
        }})
realtime = [d for d in delayed if d["delay_sec"] is None or d["delay_sec"] == 0]
periodic = [d for d in delayed if d["delay_sec"] and d["delay_sec"] > 0]
result = {{
    "total_delayed_edges": len(delayed),
    "realtime_count": len(realtime),
    "periodic_count": len(periodic),
    "realtime": realtime[:20],
    "periodic": periodic[:20],
}}
print(json.dumps(result, indent=2, ensure_ascii=False))
"#,
        root = root.join("src_python").to_string_lossy(),
        graph = graph,
    );
    run_python_code(&code)
}

#[tauri::command]
async fn hologram_changes() -> Result<String, String> {
    let root = project_root();
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{py_src}")
from timeline import TimelineStore
store = TimelineStore(r"{project_root}")
# Query the most recent file_changed or commit event
rows = store.query(limit=1, event_type="file_changed")
if not rows:
    rows = store.query(limit=1, event_type="commit")
if not rows:
    print(json.dumps({{"message": "No timeline data available", "changes": []}}))
else:
    last = rows[0]
    related = last.get("related_nodes", [])
    total = len(store.query(limit=1000))
    commit_hash = ""
    cb = last.get("changed_by", "")
    if cb.startswith("git commit "):
        commit_hash = cb[len("git commit "):]
    print(json.dumps({{
        "last_change": {{
            "timestamp": last.get("timestamp"),
            "summary": last.get("summary"),
            "event_type": last.get("event_type"),
            "file": last.get("file"),
            "impact_count": len(related),
            "delayed_count": 0,
            "affected_nodes": related,
            "commit_hash": commit_hash,
        }},
        "timeline_anchor_count": total,
    }}, indent=2, ensure_ascii=False, default=str))
store.close()
"#,
        py_src = root.join("src_python").to_string_lossy(),
        project_root = root.to_string_lossy(),
    );
    run_python_code(&code)
}

// ═══════════════════════════════════════════════════════
// P6: Hotspots — 复发热点检测（L4 复发计数）
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_hotspots(
    days: Option<i32>,
    min_count: Option<i32>,
) -> Result<String, String> {
    let root = project_root();
    let d = days.unwrap_or(30);
    let mc = min_count.unwrap_or(2);
    let code = format!(
        r#"
import sys, json, sqlite3, os
db_path = os.path.join(r"{project_root}", ".hologram", "timeline.db")
if not os.path.exists(db_path):
    print(json.dumps({{"hotspots": [], "total_events": 0, "message": "No timeline data yet"}}))
else:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    # Query check events from the last N days
    rows = conn.execute(
        "SELECT * FROM events WHERE event_type IN ('commit_violation','commit_clean') "
        "AND timestamp >= datetime('now', '-{days} days') "
        "ORDER BY timestamp DESC"
    ).fetchall()
    # Aggregate L4 violations per file
    file_counts = {{}}
    file_details = {{}}
    for row in rows:
        try:
            props = json.loads(row["properties"] or "{{}}")
        except:
            continue
        violations = props.get("violations", {{}})
        l4_list = violations.get("l4_violations", [])
        if not isinstance(l4_list, list):
            continue
        for v in l4_list:
            sig = v.get("signal", {{}}) if isinstance(v, dict) else {{}}
            fp = sig.get("file_path", "") or v.get("file_path", "")
            if not fp:
                continue
            if fp not in file_counts:
                file_counts[fp] = 0
                file_details[fp] = []
            file_counts[fp] += 1
            file_details[fp].append({{
                "description": sig.get("description", ""),
                "level": sig.get("level", 4),
                "line": sig.get("line", 0),
                "timestamp": row["timestamp"],
            }})
    conn.close()
    # Filter by min_count, sort by count desc
    hotspots = [
        {{
            "file": fp,
            "count": cnt,
            "last_details": file_details[fp][-1],
            "recent_timestamps": [d["timestamp"] for d in file_details[fp][-5:]],
        }}
        for fp, cnt in sorted(file_counts.items(), key=lambda x: -x[1])
        if cnt >= {min_count}
    ]
    result = {{
        "hotspots": hotspots,
        "total_check_events": len(rows),
        "days": {days},
        "min_count": {min_count},
    }}
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
"#,
        project_root = root.to_string_lossy(),
        days = d,
        min_count = mc,
    );
    run_python_code(&code)
}

// ═══════════════════════════════════════════════════════
// P7: Workspace Conflict — 多工作区冲突预演
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_workspace_conflict(
    path_a: String,
    path_b: String,
) -> Result<String, String> {
    let root = project_root();
    let code = format!(
        r#"
import sys, json, os
sys.path.insert(0, json.loads({py_src_ws}))
from core.graph import Graph

result = {{"workspace_a": {{}}, "workspace_b": {{}}, "overlapping_nodes": [], "shared_files": [], "risk_summary": {{"high": 0, "medium": 0, "low": 0}}}}

# Load both workspace graphs
a_path = os.path.join(json.loads({path_a_ws}), "hologram_graph.json")
b_path = os.path.join(json.loads({path_b_ws}), "hologram_graph.json")

if not os.path.exists(a_path):
    print(json.dumps({{"error": "Workspace A graph not found", "path": a_path}}))
    sys.exit(0)
if not os.path.exists(b_path):
    print(json.dumps({{"error": "Workspace B graph not found", "path": b_path}}))
    sys.exit(0)

ga = Graph.from_json(a_path)
gb = Graph.from_json(b_path)

# Collect node info: node name → location (for overlap detection)
def node_info(g):
    info = {{}}
    for nid, node in g.nodes.items():
        loc = node.location or ""
        f = loc.rsplit(":", 1)[0] if ":" in loc else loc
        info[nid] = {{
            "id": nid,
            "name": node.name,
            "location": loc,
            "file": f,
            "type": str(node.type) if hasattr(node, 'type') else "unknown",
        }}
    return info

a_info = node_info(ga)
b_info = node_info(gb)

# BFS downstream impact for a node
def downstream(node_id, g, max_depth=3):
    visited = set()
    queue = [(node_id, 0)]
    while queue:
        nid, depth = queue.pop(0)
        if nid in visited or depth > max_depth:
            continue
        visited.add(nid)
        for edge in g.outgoing_edges(nid):
            if edge.target not in visited:
                queue.append((edge.target, depth + 1))
    return visited

# Find changed files baselines (diff analysis via file-level comparison)
# Simplification: compare node sets by file
a_files = set()
b_files = set()
for info in a_info.values():
    if info["file"]:
        a_files.add(info["file"])
for info in b_info.values():
    if info["file"]:
        b_files.add(info["file"])

shared = a_files & b_files
result["shared_files"] = sorted(shared)

# For each shared file, find nodes and analyze coupling
a_nodes_by_file = {{}}
b_nodes_by_file = {{}}
for nid, info in a_info.items():
    f = info["file"]
    if f not in a_nodes_by_file:
        a_nodes_by_file[f] = []
    a_nodes_by_file[f].append(nid)
for nid, info in b_info.items():
    f = info["file"]
    if f not in b_nodes_by_file:
        b_nodes_by_file[f] = []
    b_nodes_by_file[f].append(nid)

# Analyze overlapping nodes in shared files
overlapping = []
for f in shared:
    a_node_ids = a_nodes_by_file.get(f, [])
    b_node_ids = b_nodes_by_file.get(f, [])
    if not a_node_ids or not b_node_ids:
        continue
    # Impact analysis
    a_impact_union = set()
    for nid in a_node_ids:
        a_impact_union |= downstream(nid, ga, 3)
    b_impact_union = set()
    for nid in b_node_ids:
        b_impact_union |= downstream(nid, gb, 3)

    # Nodes present in both workspaces (same file, potentially same symbol)
    for anid in a_node_ids:
        a_node = a_info.get(anid)
        if not a_node:
            continue
        a_name = a_node["name"]
        # Find matching node in B by name
        for bnid in b_node_ids:
            b_node = b_info.get(bnid)
            if not b_node:
                continue
            if b_node["name"] == a_name:
                # Calculate conflict risk
                a_ds = len(downstream(anid, ga, 2))
                b_ds = len(downstream(bnid, gb, 2))
                a_us = len(ga.incoming_edges(anid))
                b_us = len(gb.incoming_edges(bnid))
                ds_change = abs(a_ds - b_ds)
                us_change = abs(a_us - b_us)
                risk = "low"
                if ds_change > 5 or us_change > 3:
                    risk = "high"
                elif ds_change > 2 or us_change > 1:
                    risk = "medium"
                overlapping.append({{
                    "node_name": a_name,
                    "node_id": anid,
                    "location": a_node["location"],
                    "file": f,
                    "a_impact": {{"depth": a_ds, "upstream_count": a_us, "downstream_count": a_ds}},
                    "b_impact": {{"depth": b_ds, "upstream_count": b_us, "downstream_count": b_ds}},
                    "conflict_risk": risk,
                }})
                break

# Sort by risk
risk_order = {{"high": 0, "medium": 1, "low": 2}}
overlapping.sort(key=lambda x: risk_order.get(x["conflict_risk"], 2))

# Risk summary
for ov in overlapping:
    risk = ov["conflict_risk"]
    result["risk_summary"][risk] = result["risk_summary"].get(risk, 0) + 1

# Workspace info
result["workspace_a"] = {{
    "path": json.loads({path_ws_a2}),
    "node_count": len(ga.nodes),
    "edge_count": len(ga.edges),
    "file_count": len(a_files),
}}
result["workspace_b"] = {{
    "path": json.loads({path_ws_b2}),
    "node_count": len(gb.nodes),
    "edge_count": len(gb.edges),
    "file_count": len(b_files),
}}
result["overlapping_nodes"] = overlapping[:50]  # Cap at 50

print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
"#,
        py_src_ws = py_json(&root.join("src_python").to_string_lossy()),
        path_a_ws = py_json(&path_a),
        path_b_ws = py_json(&path_b),
        path_ws_a2 = py_json(&path_a),
        path_ws_b2 = py_json(&path_b),
    );
    run_python_code(&code)
}

// ═══════════════════════════════════════════════════════
// P8: Gate Check — 门禁模式（新模块 fan-in/fan-out/耦合评估）
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_gate_check(
    path: String,
    module_file: Option<String>,
) -> Result<String, String> {
    let root = project_root();
    let graph_path = format!("{}/hologram_graph.json", path);
    let mf = module_file.unwrap_or_default();

    let code = format!(
        r#"
import sys, json, os
sys.path.insert(0, json.loads({py_src_gate}))
from core.graph import Graph

graph_path = json.loads({graph_path_gate})
if not os.path.exists(graph_path):
    print(json.dumps({{"error": "Graph not found", "path": graph_path}}))
    sys.exit(0)

g = Graph.from_json(graph_path)

# Determine which modules/files to evaluate
target_files = []
mf_val = json.loads({module_file_gate})
path_val = json.loads({path_gate})
if mf_val:
    target_files = [mf_val]
else:
    # Find "new" modules — those with no coupling history in any community
    import glob as _glob
    all_py = _glob.glob(os.path.join(path_val, "**", "*.py"), recursive=True)
    # Consider files with fewer than 3 edges as potentially "new"
    for fp in all_py:
        rel = os.path.relpath(fp, path_val).replace("\\", "/")
        # Skip hidden/venv
        if any(part.startswith('.') or part == 'venv' or part == 'node_modules' or part == '__pycache__'
               for part in rel.split('/')):
            continue
        target_files.append(rel)

# Limit to manageable size
if len(target_files) > 20:
    target_files = target_files[:20]

results = []
for tf in target_files:
    # Collect all nodes in this file
    file_nodes = []
    for nid, node in g.nodes.items():
        loc = node.location or ""
        f = loc.rsplit(":", 1)[0] if ":" in loc else loc
        f_norm = f.replace("\\", "/")
        tf_norm = tf.replace("\\", "/")
        if f_norm.endswith(tf_norm) or tf_norm.endswith(f_norm):
            file_nodes.append(nid)

    if not file_nodes:
        continue

    # Aggregate: fan-in, fan-out, coupling levels
    total_fan_in = 0
    total_fan_out = 0
    coupling_levels = {{1: 0, 2: 0, 3: 0, 4: 0}}
    for nid in file_nodes:
        incoming = g.incoming_edges(nid)
        outgoing = g.outgoing_edges(nid)
        total_fan_in += len(incoming)
        total_fan_out += len(outgoing)
        for edge in incoming + outgoing:
            depth = getattr(edge, 'coupling_depth', 0)
            if depth in coupling_levels:
                coupling_levels[depth] += 1

    fn = tf.replace("\\", "/").split("/")[-1] if "/" in tf else tf

    # Risk assessment
    l4_count = coupling_levels.get(4, 0)
    l3_count = coupling_levels.get(3, 0)
    risk = "low"
    if l4_count > 3 or (total_fan_out > 20 and total_fan_in > 15):
        risk = "high"
    elif l4_count > 1 or total_fan_in + total_fan_out > 20:
        risk = "medium"

    recommendations = []
    if l4_count > 0:
        recommendations.append(f"发现 {{l4_count}} 处 L4 封装穿透，建议检查 import 可见性")
    if total_fan_out > 15:
        recommendations.append(f"扇出偏高 ({{total_fan_out}})，考虑拆分模块")
    if total_fan_in > 10:
        recommendations.append(f"扇入偏高 ({{total_fan_in}})，此模块是潜在枢纽")
    if not recommendations:
        recommendations.append("模块结构合理，无需操作")

    results.append({{
        "file": tf,
        "name": fn,
        "node_count": len(file_nodes),
        "fan_in": total_fan_in,
        "fan_out": total_fan_out,
        "coupling_l1": coupling_levels.get(1, 0),
        "coupling_l2": coupling_levels.get(2, 0),
        "coupling_l3": coupling_levels.get(3, 0),
        "coupling_l4": coupling_levels.get(4, 0),
        "risk": risk,
        "recommendations": recommendations,
    }})

# Sort by risk
risk_order = {{"high": 0, "medium": 1, "low": 2}}
results.sort(key=lambda x: risk_order.get(x["risk"], 2))

output = {{
    "modules": results,
    "total_evaluated": len(results),
    "high_risk": sum(1 for r in results if r["risk"] == "high"),
    "medium_risk": sum(1 for r in results if r["risk"] == "medium"),
    "low_risk": sum(1 for r in results if r["risk"] == "low"),
}}
print(json.dumps(output, indent=2, ensure_ascii=False, default=str))
"#,
        py_src_gate = py_json(&root.join("src_python").to_string_lossy()),
        graph_path_gate = py_json(&graph_path),
        module_file_gate = py_json(&mf),
        path_gate = py_json(&path),
    );
    run_python_code(&code)
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
        let mut c = silent_command("cmd");
        c.arg("/c").arg(cmd_escape(&command));
        c
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
    let content = std::fs::read_to_string(&file_path)
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
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    // Atomic write: temp file then rename
    let tmp_path = format!("{}.tmp", file_path);
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("无法写入临时文件 {}: {}", tmp_path, e))?;
    std::fs::rename(&tmp_path, &file_path)
        .map_err(|e| format!("无法保存文件 {}: {}", file_path, e))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════
// File tree operations
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("无法创建目录 {}: {}", path, e))
}

#[tauri::command]
async fn delete_file_or_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() { return Err(format!("路径不存在: {}", path)); }
    if p.is_dir() {
        std::fs::remove_dir_all(p)
            .map_err(|e| format!("无法删除目录 {}: {}", path, e))
    } else {
        std::fs::remove_file(p)
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
    let src = std::path::Path::new(&source);
    let name = src.file_name()
        .ok_or_else(|| format!("无效路径: {}", source))?;
    let dest = std::path::Path::new(&dest_dir).join(name);
    std::fs::rename(src, &dest)
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
            // Check for link-local (fe80::/10)
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

    // helper: refuse stale .hologram when .json is newer
    fn holo_fresh(holo_path: &std::path::Path) -> bool {
        let json_path = holo_path.to_string_lossy().replace(".hologram", ".json");
        if let (Ok(h_meta), Ok(j_meta)) = (std::fs::metadata(holo_path), std::fs::metadata(&json_path)) {
            if let (Ok(h_time), Ok(j_time)) = (h_meta.modified(), j_meta.modified()) {
                return h_time >= j_time;
            }
        }
        true // can't compare — assume fresh
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
/// Fast (~0.1s) — only loads the graph and runs to_file_graph(), no re-analysis.
fn regenerate_file_graph(project_path: &str) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", project_path);
    let code = format!(
        "from src_python.core.graph import Graph\n\
         g = Graph.from_json({:?})\n\
         fg = g.to_file_graph()\n\
         fg.to_json({:?})\n\
         print('ok')\n",
        graph_path,
        format!("{}/hologram_graph_files.json", project_path),
    );
    let root = project_root();
    let output = silent_command(&python())
        .current_dir(&root)
        .args(["-c", &code])
        .output()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("file-graph generation failed: {}", stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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

    let root = project_root();
    let python = python();

    let mut child = silent_command(&python)
        .current_dir(&root)
        .args(["-m", "src_python", &path, "--format", "json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 Python:\n  Python: {python}\n  错误: {e}"))?;

    // ── Stream stderr: parse progress lines, accumulate rest ──
    let stderr_pipe = child.stderr.take().expect("stderr piped");
    let stderr_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf2 = stderr_buf.clone();
    let app2 = app.clone();

    let reader_handle = thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr_pipe);
        for line_result in reader.lines() {
            let Ok(line) = line_result else { break };
            // Accumulate raw bytes for error reporting
            stderr_buf2.lock().unwrap().extend_from_slice(line.as_bytes());
            stderr_buf2.lock().unwrap().push(b'\n');

            if let Some(rest) = line.strip_prefix("HOLO:PROGRESS:") {
                let parts: Vec<&str> = rest.splitn(3, ':').collect();
                if parts.len() >= 3 {
                    let current: u32 = parts[0].parse().unwrap_or(0);
                    let total: u32 = parts[1].parse().unwrap_or(0);
                    let file = parts[2].to_string();
                    let payload = serde_json::json!({
                        "current": current, "total": total, "file": file
                    });
                    let _ = app2.emit("analyze-progress", payload);
                }
            } else if let Some(rest) = line.strip_prefix("HOLO:PHASE:") {
                let parts: Vec<&str> = rest.splitn(2, ':').collect();
                if !parts.is_empty() {
                    let phase = parts[0].to_string();
                    let message = if parts.len() > 1 { parts[1].to_string() } else { String::new() };
                    let payload = serde_json::json!({
                        "phase": phase, "message": message
                    });
                    let _ = app2.emit("analyze-phase", payload);
                }
            } else if let Some(rest) = line.strip_prefix("HOLO:HEARTBEAT:") {
                let parts: Vec<&str> = rest.splitn(2, ':').collect();
                if !parts.is_empty() {
                    let label = parts[0].to_string();
                    let elapsed = if parts.len() > 1 { parts[1].to_string() } else { String::new() };
                    let payload = serde_json::json!({
                        "label": label, "elapsed": elapsed
                    });
                    let _ = app2.emit("analyze-heartbeat", payload);
                }
            }
        }
    });

    let analyze_timeout = std::time::Duration::from_secs(600);
    let start = std::time::Instant::now();
    let (stdout, stderr) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_pipe(child.stdout.take());
                // Wait for reader thread to finish draining stderr
                let _ = reader_handle.join();
                let stderr_bytes = stderr_buf.lock().unwrap().clone();
                let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
                if !status.success() {
                    return Err(format!(
                        "分析失败 (exit code {}):\n--- stderr ---\n{}\n--- stdout ---\n{}",
                        status,
                        stderr,
                        if stdout.len() > 500 { format!("{}...", &stdout[..500]) } else { stdout }
                    ));
                }
                break (stdout, stderr);
            }
            Ok(None) => {
                if start.elapsed() >= analyze_timeout {
                    child.kill().ok();
                    let _ = child.wait();
                    let _ = reader_handle.join();
                    return Err("项目分析超时 (600s)，项目过大或 Python 引擎卡死。已强制终止。".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("分析进程异常: {e}")),
        }
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站");
    }

    if stdout.trim().is_empty() {
        return Err(format!("分析完成但无输出。stderr:\n{}", stderr));
    }

    // Register as active workspace — all tool commands now route here
    *ACTIVE_PROJECT.lock().unwrap() = path.clone();

    // ── Ensure file-level graph exists (may be missing if cached .hologram was loaded) ──
    let files_path = format!("{}/hologram_graph_files.json", path);
    if !std::path::Path::new(&files_path).exists() {
        let _ = regenerate_file_graph(&path);
    }

    // Track last project for cold-start fallback
    let last_path_file = project_root().join(".last_project");
    if let Err(e) = std::fs::write(&last_path_file, &path) {
        eprintln!("[hologram] failed to write .last_project: {e}");
    }

    Ok(stdout)
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
    let root = project_root();
    let code = format!(
        r#"
import sys, json, os, ast, re

project_root = {}

source_exts = {{
    '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs',
    '.go', '.rs', '.java', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
    '.rb', '.cs', '.kt', '.kts', '.swift', '.php', '.lua',
}}

skip_dirs = {{
    '.git', '.hg', '.svn', '__pycache__', '.pytest_cache', '.mypy_cache',
    'node_modules', '.venv', 'venv', '.hologram', 'dist', 'build', 'target',
    '.next', '.nuxt', '.cache', 'egg-info', '.eggs',
}}

LANG_MAP = {{
    '.py': 'python', '.pyi': 'python',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
    '.go': 'go', '.rs': 'rust', '.java': 'java',
    '.c': 'c', '.cpp': 'c++', '.cc': 'c++', '.cxx': 'c++',
    '.h': 'c', '.hpp': 'c++', '.hh': 'c++',
    '.rb': 'ruby', '.cs': 'csharp',
    '.kt': 'kotlin', '.kts': 'kotlin',
    '.swift': 'swift', '.php': 'php', '.lua': 'lua',
}}

def detect_lang(fp):
    return LANG_MAP.get(os.path.splitext(fp)[1].lower(), 'unknown')

# ── Import extractors per language ──

def extract_py(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            tree = ast.parse(f.read(), filename=filepath)
    except Exception:
        return set()
    imps = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imps.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imps.add(node.module.split('.')[0])
    return imps

def extract_js_ts(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except Exception:
        return set()
    imps = set()
    for m in re.finditer(r"""(?:from\s+['"]|import\s+['"]|require\s*\(\s*['"])([^'"]+)['"]""", content):
        mod = m.group(1)
        # Relative imports: keep as-is for resolution; external: take top-level pkg
        imps.add(mod if mod.startswith('.') else mod.split('/')[0])
    return imps

def extract_go(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except Exception:
        return set()
    return set(m.group(1).split('/')[-1] for m in re.finditer(r'"([^"]+)"', content))

def extract_rust(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except Exception:
        return set()
    return set(m.group(1).split('::')[0] for m in re.finditer(r'use\s+([a-zA-Z_][\w:]*)', content))

EXTRACTORS = {{
    'python': extract_py,
    'typescript': extract_js_ts,
    'javascript': extract_js_ts,
    'go': extract_go,
    'rust': extract_rust,
}}

def extract_imports(fp):
    lang = detect_lang(fp)
    fn = EXTRACTORS.get(lang)
    return fn(fp) if fn else set()

# ── Step 1: Collect source files ──
all_files = []
for dirpath, dirnames, filenames in os.walk(project_root):
    dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith('.')]
    for fn in filenames:
        ext = os.path.splitext(fn)[1].lower()
        if ext in source_exts:
            all_files.append(os.path.join(dirpath, fn))

sys.stderr.write("HOLO:PHASE:scan:{{}} files found\n".format(len(all_files)))
sys.stderr.flush()

# ── Step 2: Build file nodes ──
nodes = []
node_index = {{}}  # key → node_id (multiple keys per file for fuzzy matching)

for i, fp in enumerate(sorted(all_files)):
    nid = "file_{{}}".format(i)
    nodes.append({{
        "id": nid,
        "type": "symbol",
        "name": os.path.basename(fp),
        "location": fp,
        "language": detect_lang(fp),
        "kind": "file",
        "community_id": None,
        "position": None,
        "properties": {{"path": fp}},
    }})
    # Index by absolute normpath, relative path, and basename-no-ext
    nfp = os.path.normpath(fp)
    node_index[nfp] = nid
    rel = os.path.relpath(fp, project_root).replace('\\', '/')
    node_index[rel] = nid
    base_no_ext = os.path.splitext(os.path.basename(fp))[0]
    # Don't overwrite an existing nid for the same basename (ambiguous imports)
    if base_no_ext not in node_index:
        node_index[base_no_ext] = nid

# ── Step 3: Extract imports & build edges ──
edges = []
edge_keys = set()

for idx, fp in enumerate(sorted(all_files)):
    if idx % 50 == 0:
        sys.stderr.write("HOLO:PROGRESS:{{}}:{{}}:{{}}\n".format(idx, len(all_files), os.path.basename(fp)))
        sys.stderr.flush()

    src_id = node_index.get(os.path.normpath(fp))
    if not src_id:
        continue

    imports = extract_imports(fp)
    src_dir = os.path.dirname(fp)

    for imp in imports:
        target_id = None

        # 1) Direct match: import name == file basename without extension
        if imp in node_index:
            target_id = node_index[imp]

        # 2) Relative import: './foo' / '../foo' → resolve against src_dir
        if not target_id and imp.startswith('.'):
            for ext in ('.py', '.ts', '.js', '.go', '.rs'):
                resolved = os.path.normpath(os.path.join(src_dir, imp + ext))
                if resolved in node_index:
                    target_id = node_index[resolved]
                    break
            # Also try /index.py, /index.ts etc.
            if not target_id:
                for ext in ('.py', '.ts', '.js'):
                    resolved = os.path.normpath(os.path.join(src_dir, imp, 'index' + ext))
                    if resolved in node_index:
                        target_id = node_index[resolved]
                        break

        if target_id and target_id != src_id:
            key = (src_id, target_id)
            if key not in edge_keys:
                edge_keys.add(key)
                edges.append({{
                    "id": "fe_{{}}".format(len(edges)),
                    "type": "structural",
                    "direction": "import",
                    "source": src_id,
                    "target": target_id,
                    "coupling_depth": 1,
                }})

# ── Step 3.5: Community detection (Label Propagation, pure Python) ──
import random
random.seed(42)

adj = {{n['id']: [] for n in nodes}}
for e in edges:
    s, t = e['source'], e['target']
    adj[s].append(t)
    adj[t].append(s)

labels = {{n['id']: i for i, n in enumerate(nodes)}}
nids = list(labels.keys())
for _ in range(100):
    changed = False
    random.shuffle(nids)
    for nid in nids:
        neighbors = adj.get(nid, [])
        if not neighbors:
            continue
        counts = {{}}
        for nb in neighbors:
            nl = labels[nb]
            counts[nl] = counts.get(nl, 0) + 1
        best = max(counts, key=counts.get)
        if labels[nid] != best:
            labels[nid] = best
            changed = True
    if not changed:
        break

groups = {{}}
for nid, lbl in labels.items():
    groups.setdefault(lbl, []).append(nid)

min_size = 3
valid_groups = [(lbl, ms) for lbl, ms in groups.items() if len(ms) >= min_size]
valid_groups.sort(key=lambda x: -len(x[1]))

nodes_by_id = {{n['id']: n for n in nodes}}
communities = []
for ci, (lbl, member_ids) in enumerate(valid_groups):
    cid = "community_{{:04d}}".format(ci)
    for nid in member_ids:
        if nid in nodes_by_id:
            nodes_by_id[nid]['community_id'] = cid
    degrees = [(nid, len(adj.get(nid, []))) for nid in member_ids]
    degrees.sort(key=lambda x: -x[1])
    top_names = []
    for nid, _ in degrees[:2]:
        node = nodes_by_id.get(nid)
        if node:
            name = node['name']
            if '.' in name:
                name = name.rsplit('.', 1)[0]
            top_names.append(name)
    c_label = '/'.join(top_names[:2]) if top_names else 'unknown'
    communities.append({{
        'id': cid,
        'level': 0,
        'label': c_label,
        'node_ids': member_ids,
        'parent_id': None,
        'properties': {{'size': len(member_ids)}},
    }})

sys.stderr.write("HOLO:PHASE:community:{{}} file-communities\n".format(len(communities)))
sys.stderr.flush()

# ── Step 3.6: Recursive sub-communities (Level 1+) for large clusters ──
def _recursive_label_prop(member_ids, adj, nodes_by_id, level, parent_id, min_size):
    """Run label propagation on a subset of nodes, producing sub-communities."""
    if len(member_ids) < 12:
        return []
    sub_adj = {{}}
    id_set = set(member_ids)
    for nid in member_ids:
        sub_adj[nid] = [nb for nb in adj.get(nid, []) if nb in id_set]

    sub_labels = {{nid: i for i, nid in enumerate(member_ids)}}
    sub_nids = list(sub_labels.keys())
    for _ in range(50):
        changed = False
        random.shuffle(sub_nids)
        for nid in sub_nids:
            neighbors = sub_adj.get(nid, [])
            if not neighbors:
                continue
            counts = {{}}
            for nb in neighbors:
                nl = sub_labels[nb]
                counts[nl] = counts.get(nl, 0) + 1
            best = max(counts, key=counts.get)
            if sub_labels[nid] != best:
                sub_labels[nid] = best
                changed = True
        if not changed:
            break

    sub_groups = {{}}
    for nid, lbl in sub_labels.items():
        sub_groups.setdefault(lbl, []).append(nid)

    result = []
    sub_ci = 0
    for lbl, ms in sorted(sub_groups.items(), key=lambda x: -len(x[1])):
        if len(ms) < min_size:
            continue
        scid = "{{}}_{{:03d}}_{{:03d}}".format(parent_id, level, sub_ci)
        sub_ci += 1
        for nid in ms:
            if nid in nodes_by_id:
                nodes_by_id[nid]['community_id'] = scid
        degrees = [(nid, len(adj.get(nid, []))) for nid in ms]
        degrees.sort(key=lambda x: -x[1])
        top_names = []
        for nid, _ in degrees[:2]:
            node = nodes_by_id.get(nid)
            if node:
                name = node['name']
                if '.' in name:
                    name = name.rsplit('.', 1)[0]
                top_names.append(name)
        sc_label = '/'.join(top_names[:2]) if top_names else 'sub'
        result.append({{
            'id': scid,
            'level': level,
            'label': sc_label,
            'node_ids': ms,
            'parent_id': parent_id,
            'properties': {{'size': len(ms)}},
        }})
        # Recurse deeper for very large sub-communities
        if len(ms) >= 20 and level < 2:
            result.extend(_recursive_label_prop(ms, adj, nodes_by_id, level + 1, scid, 5))
    return result

# Run sub-community detection on each Level 0 community
sub_communities = []
for comm in communities:
    subs = _recursive_label_prop(comm['node_ids'], adj, nodes_by_id, level=1, parent_id=comm['id'], min_size=4)
    sub_communities.extend(subs)
communities.extend(sub_communities)

sys.stderr.write("HOLO:PHASE:community:{{}} L0 + {{}} L1+ sub-communities\n".format(len(communities) - len(sub_communities), len(sub_communities)))
sys.stderr.flush()

# ── Step 4: Write output ──
result = {{
    "meta": {{
        "source_root": project_root,
        "generated_at": __import__('datetime').datetime.now().isoformat(),
        "version": "0.1.0",
        "node_count": len(nodes),
        "edge_count": len(edges),
        "community_count": len(communities),
        "lightweight": True,
    }},
    "nodes": nodes,
    "edges": edges,
    "communities": communities,
}}

for fname in ["hologram_graph.json", "hologram_graph_files.json"]:
    out = os.path.join(project_root, fname)
    tmp = out + ".tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    os.replace(tmp, out)

print(json.dumps({{"ok": True, "file_count": len(nodes), "edge_count": len(edges)}}))
"#,
        py_json(&path),
    );

    let timeout = std::time::Duration::from_secs(120);
    let mut child = silent_command(&python())
        .current_dir(&root)
        .args(["-c", &code])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = read_pipe(child.stdout.take());
                let stderr = read_pipe(child.stderr.take());
                if !status.success() {
                    return Err(format!("文件图生成失败 (exit {}):\n{}", status, stderr));
                }
                if stdout.trim().is_empty() {
                    return Err(format!("文件图生成无输出。stderr:\n{}", stderr));
                }
                return Ok(stdout);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    child.kill().ok();
                    let _ = child.wait();
                    return Err("文件图生成超时 (120s)".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("分析进程异常: {e}")),
        }
    }
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
    let root = project_root();
    let python = python();
    let graph_path = format!("{}/hologram_graph.json", path);

    // Spawn Python directly — bypass spawn_bg to avoid cmd /c wrapper
    let child = silent_command(&python)
        .current_dir(&root)
        .args(["-m", "src_python", "analyze", &path, "-o", &graph_path])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动后台分析进程: {e}"))?;

    let job_id = NEXT_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let job = BgJob {
        child,
        stdout_buf: Vec::new(),
        stderr_buf: Vec::new(),
        start_time: std::time::Instant::now(),
    };
    BG_JOBS.lock().unwrap().insert(job_id, job);

    // Monitor the job in a background thread — poll every 10s
    let app2 = app.clone();
    let path2 = path.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            // Drain output without removing the job
            let (done, success, stderr_snippet) = {
                let mut jobs = BG_JOBS.lock().unwrap();
                let Some(job) = jobs.get_mut(&job_id) else {
                    // Job was cleaned up externally — exit monitoring
                    break;
                };
                // Drain stdout/stderr into buffers
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
                let status = job.child.try_wait();
                let done = matches!(status, Ok(Some(_)));
                let success = matches!(status, Ok(Some(s)) if s.success());
                let stderr_snip = String::from_utf8_lossy(&job.stderr_buf)
                    .chars().take(500).collect::<String>();
                (done, success, stderr_snip)
            };

            if done {
                if success {
                    *ACTIVE_PROJECT.lock().unwrap() = path2.clone();
                    let _ = std::fs::write(project_root().join(".last_project"), &path2);
                    // Clean up job entry
                    BG_JOBS.lock().unwrap().remove(&job_id);
                    let _ = app2.emit("analysis-complete", serde_json::json!({
                        "path": path2,
                        "graph_path": graph_path,
                    }));
                } else {
                    BG_JOBS.lock().unwrap().remove(&job_id);
                    let _ = app2.emit("analysis-failed", serde_json::json!({
                        "path": path2,
                        "error": stderr_snippet,
                    }));
                }
                break;
            }
        }
    });

    Ok(serde_json::json!({"job_id": job_id, "status": "started"}).to_string())
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
                if let Some(json) = run_incremental_analysis(&path, &changed_files) {
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
    run_git(&path, &["show", "--stat", "--format=", &commit])
}

static MCP_MANAGER: std::sync::LazyLock<Arc<Mutex<McpManager>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(McpManager::new())));

// ═══════════════════════════════════════════════════════
// MCP Server 命令 — Step 1: 持久进程 + 自动工具发现
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn start_mcp_server(project_root: String) -> Result<String, String> {
    let py = python();
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.start(&project_root, &py)
}

#[tauri::command]
async fn mcp_call(tool_name: String, args: String) -> Result<String, String> {
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.call(&tool_name, &args)
}

#[tauri::command]
async fn mcp_list_tools() -> Result<String, String> {
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.list_tools()
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
                // Kill all orphaned background jobs on window close
                if let Ok(mut jobs) = BG_JOBS.lock() {
                    for (_, job) in jobs.iter_mut() {
                        let _ = job.child.kill();
                        let _ = job.child.wait();
                    }
                    jobs.clear();
                }
                // Stop MCP server on exit
                if let Ok(mut mgr) = MCP_MANAGER.lock() {
                    mgr.stop();
                }
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
            mcp_call,
            mcp_list_tools,
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
        ])
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
