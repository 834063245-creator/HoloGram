// HoloGram Tauri Backend
// 桥接层：Agent (TypeScript) → Tauri commands → Python engine
// 不做分析逻辑，只做进程管理和文本转发

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};

// ═══════════════════════════════════════════════════════
// Python helpers
// ═══════════════════════════════════════════════════════

/// Find the Python executable with required dependencies.
fn python() -> String {
    let system_python = r"C:\Users\Administrator\AppData\Local\Python\pythoncore-3.14-64\python.exe";
    if std::path::Path::new(system_python).exists() {
        return system_python.to_string();
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
        .join("hologram_full.json")
        .to_string_lossy()
        .to_string()
}

/// Run a Python hologram CLI command and capture combined stdout+stderr.
fn run_hologram(args: &[&str]) -> Result<String, String> {
    let root = project_root();
    let output = Command::new(python())
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
    let output = Command::new(python())
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
    let exts = [".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs"];
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

    let output = Command::new(python())
        .current_dir(&root)
        .args(&args)
        .output()
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !stdout.trim().is_empty() {
            return Some(stdout);
        }
    }
    None
}

// ═══════════════════════════════════════════════════════
// 13 Tauri commands — one per hologram tool
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn hologram_analyze(path: Option<String>) -> Result<String, String> {
    let target = path.unwrap_or_else(|| project_root().to_string_lossy().to_string());
    let graph_path = default_graph();
    run_hologram(&["analyze", &target, "-o", &graph_path])
}

#[tauri::command]
async fn hologram_neighbors(node_id: String, _depth: Option<i32>) -> Result<String, String> {
    let graph = default_graph();
    run_hologram(&["neighbors", &node_id, "-g", &graph])
}

#[tauri::command]
async fn hologram_impact(node_id: String, max_depth: Option<i32>) -> Result<String, String> {
    let graph = default_graph();
    let d = max_depth.unwrap_or(0);
    if d > 0 {
        run_hologram(&["impact", &node_id, "-d", &d.to_string(), "-g", &graph])
    } else {
        run_hologram(&["impact", &node_id, "-g", &graph])
    }
}

#[tauri::command]
async fn hologram_path(from: String, to: String) -> Result<String, String> {
    run_hologram(&["path", &from, &to, "-g", &default_graph()])
}

#[tauri::command]
async fn hologram_diff(before_path: String, after_path: Option<String>) -> Result<String, String> {
    let after = after_path.unwrap_or_else(default_graph);
    run_hologram(&["diff", &before_path, &after, "--json"])
}

#[tauri::command]
async fn hologram_fragile(limit: Option<i32>) -> Result<String, String> {
    let l = limit.unwrap_or(10);
    run_hologram(&["fragile", "-l", &l.to_string(), "-g", &default_graph()])
}

#[tauri::command]
async fn hologram_cycle(mode: Option<String>) -> Result<String, String> {
    let m = mode.unwrap_or_else(|| "all".into());
    run_hologram(&["cycle", "-m", &m, "-g", &default_graph()])
}

#[tauri::command]
async fn hologram_coupling_report(module: String) -> Result<String, String> {
    run_hologram(&["coupling-report", &module, "-g", &default_graph()])
}

#[tauri::command]
async fn hologram_blindspots(threshold: Option<f64>) -> Result<String, String> {
    let t = threshold.unwrap_or(0.5);
    let root = project_root();
    let code = format!(
        r#"
import sys, json
sys.path.insert(0, r"{}")
from analysis.blindspots import find_blindspots
from core.graph import Graph
graph = Graph.from_json(r"{}")
results = find_blindspots(graph, min_confidence={})
print(json.dumps(results, indent=2, ensure_ascii=False))
"#,
        root.join("src_python").to_string_lossy(),
        default_graph(),
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
from analysis.threading import thread_conflict_report
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
        root.join("src_python").to_string_lossy(),
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
from core.graph import Graph
from core.community import CommunityDetector
graph = Graph.from_json(r"{}")
detector = CommunityDetector()
communities = detector.detect(graph)
filtered = [c for c in communities if len(c.get('nodes', [])) >= {}]
print(json.dumps(filtered, indent=2, ensure_ascii=False))
"#,
        project_root().join("src_python").to_string_lossy(),
        default_graph(),
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
        default_graph(),
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
// P4: File viewer — read file content for floating editor
// ═══════════════════════════════════════════════════════

#[tauri::command]
async fn read_file_content(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))
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
    std::fs::write(&yaml_path, &content)
        .map_err(|e| format!("无法写入约束文件: {}", e))
}

// ═══════════════════════════════════════════════════════
// Graph loading — for star graph rendering
// ═══════════════════════════════════════════════════════

/// Load the graph JSON file and return it as a string.
/// Tries: 1) explicit path, 2) default (hologram_full.json), 3) last project's hologram_graph.json.
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

    // 2) default graph (written by analyze_and_load on every open)
    let def = default_graph();
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
    let exts = [".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs"];
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
                // Still update last-project tracking
                let _ = std::fs::write(default_graph(), &content);
                let _ = std::fs::write(project_root().join(".last_project"), &path);
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

    let output = Command::new(&python)
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

    // Persist to default graph path for next startup
    let _ = std::fs::write(default_graph(), &stdout);
    // Also save the last project path to a simple config file
    let last_path_file = project_root().join(".last_project");
    let _ = std::fs::write(&last_path_file, &path);

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
        let poll_interval = Duration::from_secs(1); // 1s polling, quicker than 3s

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
                    // Only update last_mtimes on SUCCESS — prevents event loss on error
                    last_mtimes = current_mtimes;
                    let _ = app_handle.emit("graph-updated", json);
                }
                // On failure: changed_files will be re-detected next poll (last_mtimes unchanged)
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
        .invoke_handler(tauri::generate_handler![
            hologram_analyze,
            hologram_neighbors,
            hologram_impact,
            hologram_path,
            hologram_diff,
            hologram_fragile,
            hologram_cycle,
            hologram_coupling_report,
            hologram_blindspots,
            hologram_thread_conflicts,
            hologram_timeline,
            hologram_community_report,
            hologram_graph_summary,
            load_graph_json,
            analyze_and_load,
            hologram_run_check,
            hologram_run_preflight,
            hologram_run_health,
            start_watching,
            stop_watching,
            read_file_content,
            read_constraints,
            write_constraints,
        ])
        .run(tauri::generate_context!())
        .expect("error running hologram");
}
