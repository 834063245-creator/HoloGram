// HoloGram Tauri Backend
// 桥接层：Agent (TypeScript) → Tauri commands → Python engine
// 不做分析逻辑，只做进程管理和文本转发

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
const NO_WINDOW: u32 = 0x08000000;

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
        c.arg("/c").arg(cmd);
        c
    } else {
        let mut c = silent_command("sh");
        c.arg("-c").arg(cmd);
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
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
    cmd
}

// ═══════════════════════════════════════════════════════
// Python helpers
// ═══════════════════════════════════════════════════════

/// Find the Python executable with required dependencies.
/// Checks: 1) HOLOGRAM_PYTHON env var  2) sibling venv  3) python3 / python on PATH
fn python() -> String {
    // 1) Explicit override via environment variable
    if let Ok(p) = std::env::var("HOLOGRAM_PYTHON") {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    // 2) Project-local venv (check both Windows and Unix layout)
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

fn project_root() -> PathBuf {
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

/// Run a Python hologram CLI command and capture combined stdout+stderr.
fn run_hologram(args: &[&str]) -> Result<String, String> {
    let root = project_root();
    let output = silent_command(&python())
        .current_dir(&root)
        .args(["-m", "src_python"])
        .args(args)
        .output()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let mut result = String::new();
    if !stderr.is_empty() {
        result.push_str(&stderr);
        result.push('\n');
    }
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }

    if !output.status.success() {
        return Err(if result.is_empty() {
            format!("Command failed with exit code {}", output.status)
        } else {
            result
        });
    }

    Ok(if result.is_empty() {
        "(no output)".into()
    } else {
        result
    })
}

/// Run inline Python code and return output.
fn run_python_code(code: &str) -> Result<String, String> {
    let root = project_root();
    let output = silent_command(&python())
        .current_dir(&root)
        .args(["-c", code])
        .output()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("{}{}", stderr, stdout));
    }
    Ok(format!("{}{}", stdout, stderr))
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

// ═══════════════════════════════════════════════════════
// V3: Check — constraint validation + change summary
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_run_check(path: String) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", path);
    run_hologram(&["check", &path, "--json", "-g", &graph_path])
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
import sys, json, os
sys.path.insert(0, r"{root}")
source_root = os.environ.get("HOLOGRAM_PROJECT", "")
timeline_path = os.path.join(source_root, ".hologram", "timeline.json") if source_root else ""
if not timeline_path or not os.path.exists(timeline_path):
    print(json.dumps({{"message": "No timeline data available", "changes": []}}))
else:
    with open(timeline_path, "r") as f:
        timeline = json.load(f)
    anchors = timeline.get("anchors", [])
    last_change = None
    for a in anchors:
        if a.get("action") == "changed":
            last_change = a
            break
    if not last_change:
        print(json.dumps({{"message": "No recent changes found", "changes": []}}))
    else:
        print(json.dumps({{
            "last_change": {{
                "timestamp": last_change.get("timestamp"),
                "summary": last_change.get("summary"),
                "impact_count": last_change.get("impactCount", 0),
                "delayed_count": last_change.get("delayedCount", 0),
                "affected_nodes": last_change.get("affectedNodeIds", []),
                "commit_hash": last_change.get("commitHash"),
            }},
            "timeline_anchor_count": len(anchors),
        }}, indent=2, ensure_ascii=False))
"#,
        root = root.join("src_python").to_string_lossy(),
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

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000)); // default 2 min

    let mut child = if cfg!(target_os = "windows") {
        let mut c = silent_command("cmd");
        c.arg("/c").arg(&command);
        c
    } else {
        let mut c = silent_command("sh");
        c.arg("-c").arg(&command);
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
                    return Err(format!("命令超时 ({}ms)，已强制终止", timeout_ms.unwrap_or(120_000)));
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
async fn read_file_content(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))
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
    let pattern_lower = if is_regex { String::new() } else { pattern.to_lowercase() };
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
                line.to_lowercase().contains(&pattern_lower)
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
        s = regex::Regex::new(r"(?si)<script[^>]*>.*?</script>").unwrap().replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?si)<style[^>]*>.*?</style>").unwrap().replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"(?s)<!--.*?-->").unwrap().replace_all(&s, " ").to_string();
        // Remove all remaining tags
        s = regex::Regex::new(r"<[^>]*>").unwrap().replace_all(&s, " ").to_string();
        // Decode common entities
        s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
             .replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
             .replace("&#x27;", "'").replace("&nbsp;", " ");
        // Collapse whitespace
        s = regex::Regex::new(r"[ \t]+").unwrap().replace_all(&s, " ").to_string();
        s = regex::Regex::new(r"\n{3,}").unwrap().replace_all(&s, "\n\n").to_string();
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
    // 1) explicit path
    if let Some(ref p) = path {
        if let Ok(content) = std::fs::read_to_string(p) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }

    // 2) active workspace graph (falls back to global if no project active)
    let def = active_graph();
    if let Ok(content) = std::fs::read_to_string(&def) {
        if !content.trim().is_empty() {
            return Ok(content);
        }
    }

    // 3) last project's hologram_graph.json
    let last_path_file = project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let p = std::path::PathBuf::from(last_path.trim()).join("hologram_graph.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }

    Err("No cached graph found".into())
}

/// A3: Load graph from MessagePack binary (.hologram) — 10× faster for >10K nodes.
/// Tries: 1) explicit path, 2) active project .hologram, 3) global fallback .hologram,
/// 4) last project .hologram.
#[tauri::command]
async fn load_binary_graph(path: Option<String>) -> Result<Vec<u8>, String> {
    // 1) explicit path
    if let Some(ref p) = path {
        if let Ok(bytes) = std::fs::read(p) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }

    // 2) active workspace .hologram
    let active = active_graph().replace(".json", ".hologram");
    if let Ok(bytes) = std::fs::read(&active) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }

    // 3) global fallback .hologram
    let def = project_root().join("hologram_graph.hologram");
    if let Ok(bytes) = std::fs::read(&def) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }

    // 4) last project's .hologram
    let last_path_file = project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let p = std::path::PathBuf::from(last_path.trim()).join("hologram_graph.hologram");
        if let Ok(bytes) = std::fs::read(&p) {
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

/// Analyze a folder and return the graph JSON. Uses incremental cache.
/// Fast path: if cached graph is up-to-date, returns it instantly (no Python).
#[tauri::command]
async fn analyze_and_load(path: String, app: tauri::AppHandle) -> Result<String, String> {
    // ── Fast path: cached graph still fresh ──
    let cached_graph = std::path::PathBuf::from(&path).join("hologram_graph.json");
    if is_graph_fresh(&cached_graph.to_string_lossy(), &path) {
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
                return Ok(content);
            }
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站 — 分析中...");
    }

    let root = project_root();
    let python = python();

    let output = silent_command(&python)
        .current_dir(&root)
        .args(["-m", "src_python", &path, "--format", "json"])
        .output()
        .map_err(|e| format!("无法启动 Python:\n  Python: {python}\n  错误: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "分析失败 (exit code {}):\n--- stderr ---\n{}\n--- stdout ---\n{}",
            output.status,
            stderr,
            if stdout.len() > 500 { format!("{}...", &stdout[..500]) } else { stdout }
        ));
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站");
    }

    if stdout.trim().is_empty() {
        return Err(format!("分析完成但无输出。stderr:\n{}", stderr));
    }

    // Register as active workspace — all tool commands now route here
    *ACTIVE_PROJECT.lock().unwrap() = path.clone();
    // Track last project for cold-start fallback
    let last_path_file = project_root().join(".last_project");
    if let Err(e) = std::fs::write(&last_path_file, &path) {
        eprintln!("[hologram] failed to write .last_project: {e}");
    }

    Ok(stdout)
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
            load_graph_json,
            load_binary_graph,
            analyze_and_load,
            hologram_run_check,
            hologram_run_preflight,
            hologram_run_health,
            hologram_history,
            hologram_community,
            hologram_delayed,
            hologram_changes,
            start_watching,
            stop_watching,
            list_directory,
            read_file_content,
            write_file_content,
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
            search_code,
            web_fetch,
            edit_file,
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
