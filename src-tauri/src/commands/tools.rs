// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Agent tool Tauri commands.

use tauri::{Emitter, Manager};
use serde_json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::io::Read;
use std::thread;
use std::time::Duration;
use base64::Engine;
use crate::utils;
use crate::WorkspaceState;
use crate::mcp_manager::McpManager;
use crate::unity_manager::UnityManager;
use crate::agent_isolation::{AgentIsolation, IsolationKind};
use std::net::{TcpListener as StdTcpListener, TcpStream as StdTcpStream};

use hologram_engine as engine;
use engine::engine as engine_api;
use engine::graph::Graph;
use engine::graph::{Node, NodeKind, Edge, EdgeKind};
use engine::analysis::{fragile_nodes, detect_cycles, coupling_report,
    graph_summary, thread_conflict_report, find_blindspots, policy_check_from_index};
use engine::community::{detect_communities, detect_hierarchical_communities_with_base};
use engine::graph::query;
use engine::routing::preflight::{check_timeline_props, load_baseline, save_baseline};

// ═══════════════════════════════════════════════════════
// Background job system — timeout + background + output + kill
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn exec_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: Option<bool>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let dir = cwd.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());

    // Phase 2+3: permission check before any execution (foreground + background).
    // Phase 3: use the forward-mapped physical directory (worktree path) for
    // actual execution, not the original cwd (spec §5.6).
    let is_bg = run_in_background.unwrap_or(false);
    let physical_dir = if is_bg {
        crate::utils::require_command_sync(&command, &state)?;
        crate::utils::require_read_sync(&dir, &state)?
    } else {
        crate::utils::require_command(&command, &state, &app).await?;
        crate::utils::resolve_read_dispatch(&dir, _agent.unwrap_or(false), &state, &app).await?
    };
    let physical_dir_str = physical_dir.to_string_lossy().to_string();

    if is_bg {
        let id = crate::utils::spawn_bg(&command, &physical_dir_str)?;
        return Ok(format!("[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_kill({}) 终止任务", id, id, id));
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000)); // default 5 min

    let mut child = crate::os_sandbox::spawn_shell(&command, &physical_dir_str)
        .map_err(|e| format!("无法执行命令: {e}"))?;

    // Drain stdout/stderr in background threads to prevent pipe-buffer deadlock.
    // If the child produces >4 KB (Windows pipe buf) without the parent reading,
    // the child blocks on write and we never see an exit.
    let stdout_drainer = child.take_stdout().map(|mut reader| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = reader.read_to_end(&mut v);
            let _ = tx.send(v);
        });
        rx
    });
    let stderr_drainer = child.take_stderr().map(|mut reader| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = reader.read_to_end(&mut v);
            let _ = tx.send(v);
        });
        rx
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_drainer
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| String::from_utf8_lossy(&v).to_string())
                    .unwrap_or_default();
                let stderr = stderr_drainer
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| String::from_utf8_lossy(&v).to_string())
                    .unwrap_or_default();

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
pub(crate) async fn bash_output(job_id: u32) -> Result<String, String> {
    crate::utils::read_bg_output(job_id)
}

#[tauri::command]
pub(crate) async fn bash_kill(job_id: u32) -> Result<String, String> {
    crate::utils::kill_bg(job_id)
}

// ═══════════════════════════════════════════════════════
// File system operations
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn list_directory(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::utils::DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    // ponytail: list_dir_recursive does recursive fs::read_dir + is_dir
    // synchronously. On large projects this blocks the async worker for
    // seconds — same class of bug as serialize_cached_graph.
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_recursive(&root))
    })
    .await
    .map_err(|e| format!("目录列表任务失败: {e}"))?
}

/// Flat (non-recursive) directory listing — returns only direct children, no grandchildren.
/// Used by FileTreePanel for lazy expansion: load top level, expand folders on demand.
#[tauri::command]
pub(crate) async fn list_directory_flat(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::utils::DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_flat(&root))
    })
    .await
    .map_err(|e| format!("目录列表任务失败: {e}"))?
}

/// Flat listing: one level, children always null. Sort: dirs first, alpha.
fn list_dir_flat(root: &std::path::Path) -> Vec<crate::utils::DirEntry> {
    let mut entries: Vec<crate::utils::DirEntry> = Vec::new();
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
        entries.push(crate::utils::DirEntry {
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

#[tauri::command]
pub(crate) async fn read_file_content(
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let real_path = crate::utils::resolve_read_dispatch(&file_path, _agent.unwrap_or(false), &state, &app).await?;
    let content = std::fs::read_to_string(&real_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(0).min(lines.len());
    let end = limit
        .map(|l| (start + l).min(lines.len()))
        .unwrap_or(lines.len());
    // ponytail: cat -n format — line numbers help the LLM reference exact lines
    let numbered: Vec<String> = lines[start..end].iter().enumerate()
        .map(|(i, l)| format!("{:>6}\t{}", start + i + 1, l))
        .collect();
    Ok(numbered.join("\n"))
}

#[tauri::command]
pub(crate) async fn read_file_base64(
    file_path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let real_path = crate::utils::resolve_read_dispatch(&file_path, _agent.unwrap_or(false), &state, &app).await?;
    let bytes = std::fs::read(&real_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub(crate) async fn write_file_content(
    file_path: String,
    content: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let real_path = crate::utils::resolve_write_dispatch(&file_path, _agent.unwrap_or(false), &state, &app).await?;
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
pub(crate) fn log_append(
    path: String,
    content: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    let ctx = crate::utils::get_ctx(&state)?;
    // Phase 3: forward-map to worktree physical path (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(&path));
    let physical_str = physical.to_string_lossy().to_string();
    let tool = crate::tools::EditTool { path: physical_str.clone() };
    crate::utils::check_permission_sync(&tool, &ctx)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&physical)
        .map_err(|e| format!("log_append: cannot open {}: {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("log_append: write failed: {}", e))
}

#[tauri::command]
pub(crate) async fn create_directory(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let resolved = crate::utils::resolve_write_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    std::fs::create_dir_all(&resolved)
        .map_err(|e| format!("无法创建目录 {}: {}", path, e))
}

/// Return the global memory directory path for cross-project memory storage.
/// On Windows: %USERPROFILE%\.hologram\global_memory
/// On other: $HOME/.hologram/global_memory
#[tauri::command]
pub(crate) fn get_global_memory_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/.hologram/global_memory", home.replace("\\", "/"))
}

#[tauri::command]
pub(crate) async fn delete_file_or_dir(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let real = crate::utils::resolve_write_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
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
pub(crate) async fn rename_file_or_dir(
    from: String,
    to: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let is_agent = _agent.unwrap_or(false);
    let resolved_from = crate::utils::resolve_write_dispatch(&from, is_agent, &state, &app).await?;
    let resolved_to = crate::utils::resolve_write_dispatch(&to, is_agent, &state, &app).await?;
    std::fs::rename(&resolved_from, &resolved_to)
        .map_err(|e| format!("无法重命名 {} -> {}: {}", from, to, e))
}

#[tauri::command]
pub(crate) async fn move_file(
    source: String,
    dest_dir: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let is_agent = _agent.unwrap_or(false);
    let src_real = crate::utils::resolve_read_dispatch(&source, is_agent, &state, &app).await?;
    let dest_real = crate::utils::resolve_write_dispatch(&dest_dir, is_agent, &state, &app).await?;
    let name = src_real.file_name()
        .ok_or_else(|| format!("无效路径: {}", source))?;
    let dest = dest_real.join(name);
    std::fs::rename(&src_real, &dest)
        .map_err(|e| format!("无法移动 {} -> {}: {}", source, dest.display(), e))
}

#[tauri::command]
pub(crate) async fn open_in_explorer(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let real = crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    #[cfg(target_os = "windows")]
    {
        if real.is_dir() {
            std::process::Command::new("explorer")
                .arg(&real)
                .spawn()
                .map_err(|e| format!("无法打开资源管理器: {}", e))?;
        } else {
            std::process::Command::new("explorer")
                .args(["/select,", &real.to_string_lossy()])
                .spawn()
                .map_err(|e| format!("无法打开资源管理器: {}", e))?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if real.is_dir() {
            std::process::Command::new("open")
                .arg(&real)
                .spawn()
                .map_err(|e| format!("无法打开访达: {}", e))?;
        } else {
            std::process::Command::new("open")
                .args(["-R", &real.to_string_lossy()])
                .spawn()
                .map_err(|e| format!("无法打开访达: {}", e))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if real.is_dir() { &real } else { real.parent().unwrap_or(&real) };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器: {}", e))?;
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════
// Search & Glob — coding agent tools
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn search_code(
    directory: String,
    pattern: String,
    file_types: Option<String>,
    max_results: Option<usize>,
    use_regex: Option<bool>,
    context_lines: Option<usize>,
    output_mode: Option<String>,
    show_line_numbers: Option<bool>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    glob_filter: Option<String>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let root = crate::utils::resolve_read_dispatch(&directory, _agent.unwrap_or(false), &state, &app).await?;
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
    let ctx = context_lines.unwrap_or(0).min(10); // context lines around match
    let mode = output_mode.unwrap_or_else(|| "content".into());
    let show_ln = show_line_numbers.unwrap_or(true);
    let head = head_limit.unwrap_or(250); // 0 = unlimited
    let skip = offset.unwrap_or(0);
    let gfilter = glob_filter.clone();

    // ponytail: walkdir + read_to_string per file is heavy sync I/O.
    // Must run on blocking thread to avoid starving other async commands.
    let pat = pattern.clone();
    tokio::task::spawn_blocking(move || {
        let mut results: Vec<serde_json::Value> = Vec::new();
        let mut file_sets: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut file_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
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

        // Compile glob filter if provided
        let glob_re: Option<regex::Regex> = gfilter.and_then(|gf| {
            let pat = gf.replace(".", "\\.").replace("*", ".*").replace("?", ".");
            regex::Regex::new(&format!("^{}$", pat)).ok()
        });

        for entry in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !skip_dirs.iter().any(|d| name == *d)
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let fp = entry.path();
            let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let name = fp.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if skip_extensions.iter().any(|skip| ext == *skip || name.ends_with(skip)) {
                continue;
            }
            if !extensions.is_empty() && !extensions.iter().any(|e| ext == *e) {
                continue;
            }
            let fp_str = fp.to_string_lossy().to_string();
            if let Some(ref re) = &glob_re {
                if !re.is_match(&fp_str) { continue; }
            }

            let content = match std::fs::read_to_string(fp) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let lines: Vec<&str> = content.lines().collect();

            let mut file_has_match = false;
            for (line_no, line) in lines.iter().enumerate() {
                let matched = if let Some(ref re) = regex {
                    re.is_match(line)
                } else {
                    let line_lower = line.to_lowercase();
                    sub_patterns.iter().any(|p| line_lower.contains(p))
                };
                if matched {
                    file_has_match = true;
                    *file_counts.entry(fp_str.clone()).or_insert(0) += 1;

                    if mode == "content" {
                        let start = line_no.saturating_sub(ctx);
                        let end = (line_no + ctx + 1).min(lines.len());
                        let context_block: Vec<serde_json::Value> = lines[start..end].iter().enumerate().map(|(i, l)| {
                            let ln = start + i + 1;
                            serde_json::json!({
                                "line": if show_ln { Some(ln) } else { None },
                                "content": l,
                                "is_match": ln == line_no + 1,
                            })
                        }).collect();
                        results.push(serde_json::json!({
                            "file": fp_str,
                            "match_line": line_no + 1,
                            "match_content": line,
                            "context": ctx,
                            "context_block": context_block,
                        }));
                    }
                    if results.len() >= max { break; }
                }
            }
            if file_has_match { file_sets.insert(fp_str.clone()); }
            if results.len() >= max { break; }
        }

        // Apply output mode
        let output = match mode.as_str() {
            "files_with_matches" => {
                let mut files: Vec<&String> = file_sets.iter().collect();
                files.sort();
                let total = files.len();
                let files = if head > 0 { files.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { files };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": head > 0 && skip + head < total,
                    "files": files,
                })
            }
            "count" => {
                let mut counts: Vec<(&String, &usize)> = file_counts.iter().collect();
                counts.sort_by(|a, b| b.1.cmp(a.1));
                let total = counts.len();
                let counts = if head > 0 { counts.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { counts };
                serde_json::json!({
                    "pattern": pat,
                    "total_matches": file_counts.values().sum::<usize>(),
                    "file_count": total,
                    "truncated": head > 0 && skip + head < total,
                    "files": counts.into_iter().map(|(f, c)| serde_json::json!({"file": f, "matches": c})).collect::<Vec<_>>(),
                })
            }
            _ => { // "content"
                let total = results.len();
                let results = if head > 0 { results.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { results };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": head > 0 && skip + head < total,
                    "context_lines": ctx,
                    "results": results,
                })
            }
        };

        Ok(output.to_string())
    }).await.map_err(|e| format!("搜索任务失败: {e}"))?
}

/// Alias: LLM sometimes generates "search_content" instead of "search_code".
/// ponytail: delegate — the 70-line duplicate was a copy-paste bug magnet.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_content(
    directory: String, pattern: String, file_types: Option<String>,
    max_results: Option<usize>, use_regex: Option<bool>,
    context_lines: Option<usize>, output_mode: Option<String>,
    show_line_numbers: Option<bool>, head_limit: Option<usize>,
    offset: Option<usize>, glob_filter: Option<String>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    search_code(
        directory, pattern, file_types, max_results, use_regex,
        context_lines, output_mode, show_line_numbers, head_limit,
        offset, glob_filter, _agent, state, app,
    ).await
}

// ═══════════════════════════════════════════════════════
// Coding Agent: glob — file pattern matching
// ═══════════════════════════════════════════════════════

#[derive(serde::Serialize)]
struct GlobEntry {
    path: String,
    name: String,
}

#[tauri::command]
pub(crate) async fn glob(
    pattern: String,
    path: Option<String>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let dir = path.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());
    let root = crate::utils::resolve_read_dispatch(&dir, _agent.unwrap_or(false), &state, &app).await?;

    let glob_pattern = glob::Pattern::new(&pattern)
        .map_err(|e| format!("无效的 glob 模式: {}", e))?;
    let pat = pattern.clone();

    // ponytail: walkdir over entire project is heavy sync I/O — blocking thread.
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", dir));
        }
        let mut results: Vec<crate::utils::GlobEntry> = Vec::new();
        let max = 200;

        for entry in walkdir::WalkDir::new(&root)
            .max_depth(12)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() { continue; }
            let entry_path = entry.path();
            let eps = entry_path.to_string_lossy();
            if eps.contains("/.git/") || eps.contains("\\.git\\")
                || eps.contains("/node_modules/") || eps.contains("\\node_modules\\")
                || eps.contains("/target/") || eps.contains("\\target\\")
                || eps.contains("/dist/") || eps.contains("\\dist\\")
                || eps.contains("/build/") || eps.contains("\\build\\")
                || eps.contains("/.hologram/") || eps.contains("\\.hologram\\")
            { continue; }

            let rel = entry_path.strip_prefix(&root).unwrap_or(entry_path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");

            if glob_pattern.matches(&rel_str) {
                results.push(crate::utils::GlobEntry {
                    path: entry_path.to_string_lossy().to_string(),
                    name: rel.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| rel_str.clone()),
                });
            }
            if results.len() >= max { break; }
        }

        Ok(serde_json::json!({
            "pattern": pat,
            "count": results.len(),
            "truncated": results.len() >= max,
            "results": results,
        }).to_string())
    }).await.map_err(|e| format!("glob 任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// Coding Agent: edit_file — exact string replacement
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn edit_file(
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let is_agent = _agent.unwrap_or(false);
    // ponytail: edit = read then write — Agent needs both checks, UI skips rules
    crate::utils::resolve_read_dispatch(&file_path, is_agent, &state, &app).await?;
    let resolved = crate::utils::resolve_write_dispatch(&file_path, is_agent, &state, &app).await?;
    let file_path = resolved.to_string_lossy().to_string();
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
            // Whitespace-tolerant: match line-by-line after trimming each line.
            // Catches LLM indentation / trailing-space mismatches.
            let old_lines: Vec<&str> = old_string.lines().collect();
            if !old_lines.is_empty() {
                let file_lines: Vec<&str> = content.lines().collect();
                let first_trimmed = old_lines[0].trim();
                for start in 0..file_lines.len() {
                    if file_lines[start].trim() != first_trimmed { continue; }
                    let mut matched = true;
                    for k in 1..old_lines.len() {
                        if start + k >= file_lines.len()
                            || file_lines[start + k].trim() != old_lines[k].trim()
                        { matched = false; break; }
                    }
                    if matched && start + old_lines.len() <= file_lines.len() {
                        let prefix = file_lines[start]
                            .chars().take_while(|c| c.is_whitespace()).collect::<String>();
                        let new_ls: Vec<&str> = new_string.lines().collect();
                        let mut out = String::new();
                        for l in &file_lines[..start] { out.push_str(l); out.push('\n'); }
                        for (k, nl) in new_ls.iter().enumerate() {
                            if k == 0 { out.push_str(&prefix); }
                            out.push_str(nl); out.push('\n');
                        }
                        for l in &file_lines[start + old_lines.len()..] {
                            out.push_str(l); out.push('\n');
                        }
                        let trimmed = out.trim_end_matches('\n').to_string();
                        crate::utils::write_atomic(&file_path, &trimmed)?;
                        // Record timeline event for whitespace-tolerant edit
                        if let Some(ref handle) = *state.lock().unwrap() {
                            let short = file_path.rsplit(['/', '\\']).next().unwrap_or(&file_path);
                            let _ = engine_api::engine_record_timeline("agent_edit", Some(file_path.as_str()), &format!("Agent 编辑: {}", short));
                            if let Ok(mut changed) = handle.changed_files.lock() {
                                if !changed.contains(&file_path) { changed.push(file_path.clone()); }
                            }
                        }
                        return Ok("已替换 1 处匹配（容错模式：逐行对齐）".to_string());
                    }
                    break; // first-line matched once, no need to scan further
                }
            }
            // Diagnostic: show where the first line appears in the file
            let first_line = old_string.lines().next().unwrap_or("(empty)");
            let best = crate::utils::fuzzy_find(&content, first_line);
            let hint = match best {
                Some((ln, ctx)) => format!("line {}: {}", ln, ctx),
                None => format!("file starts: {}",
                    content.lines().take(3).collect::<Vec<_>>().join(" | ")),
            };
            let key = if first_line.len() > 60 { &first_line[..60] } else { first_line };
            return Err(format!("not found: \"{}\" | {}", key, hint));
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

    // Record timeline event + update changed files for check (简报)
    if let Some(ref handle) = *state.lock().unwrap() {
        let short = file_path.rsplit(['/', '\\']).next().unwrap_or(&file_path);
        let _ = engine_api::engine_record_timeline("agent_edit", Some(file_path.as_str()), &format!("Agent 编辑: {}", short));
        if let Ok(mut changed) = handle.changed_files.lock() {
            if !changed.contains(&file_path) { changed.push(file_path.clone()); }
        }
    }

    Ok(if replace_all {
        format!("已替换 {} 处匹配", count)
    } else {
        "已替换 1 处匹配".to_string()
    })
}

// ═══════════════════════════════════════════════════════
// Web Search & Fetch
// ═══════════════════════════════════════════════════════

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

fn search_backend() -> &'static str {
    match std::env::var("HOLOGRAM_SEARCH_BACKEND").as_deref() {
        Ok("bing") => "bing",
        _ => "duckduckgo",
    }
}

#[tauri::command]
pub(crate) async fn web_search(
    query: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let backend = search_backend();
    let (search_url, q) = (match backend {
        "bing" => format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(&query)),
        _ => format!("https://html.duckduckgo.com/html/?q={}", crate::utils::urlencoding(&query)),
    }, query.clone());

    // Permission check
    {
        let ctx = crate::utils::get_ctx(&state)?;
        let tool = crate::tools::WebFetchTool { url: search_url.clone() };
        crate::utils::check_permission(&tool, &ctx, &app).await?;
    }

    let results = match backend {
        "bing" => bing_search(&q)?,
        _ => duckduckgo_search(&q)?,
    };

    if results.is_empty() {
        return Ok(serde_json::json!({
            "query": query,
            "results": [],
            "error": "No results found.",
        }).to_string());
    }

    Ok(serde_json::json!({
        "query": query,
        "results": &results[..results.len().min(10)],
    }).to_string())
}

fn bing_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://www.bing.com/search?q={}&setlang=en", crate::utils::urlencoding(query));

    let resp = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build()
        .get(&url)
        .set("User-Agent", CHROME_UA)
        .set("Accept-Language", "en-US,en;q=0.9")
        .call()
        .map_err(|e| format!("web_search: request failed: {}", e))?;

    let html = resp.into_string().map_err(|e| format!("web_search: read error: {}", e))?;

    let mut results = Vec::new();
    // Bing results: <li class="b_algo"> with <h2><a href="URL">TITLE</a></h2> + <p>SNIPPET</p>
    let block_re = regex::Regex::new(r#"<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)</li>"#).unwrap();
    let link_re = regex::Regex::new(r#"<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a></h2>"#).unwrap();
    let snippet_re = regex::Regex::new(r#"<p[^>]*>([\s\S]*?)</p>"#).unwrap();
    let tag_re = regex::Regex::new(r"<[^>]*>").unwrap();

    for cap in block_re.captures_iter(&html) {
        let block = &cap[1];
        if let Some(lc) = link_re.captures(block) {
            let title = tag_re.replace_all(&lc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re.captures_iter(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .find(|s| s.len() > 15)
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": lc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 { break; }
            }
        }
    }
    Ok(results)
}

fn duckduckgo_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let q = crate::utils::urlencoding(query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", q);

    let resp = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build()
        .get(&url)
        .set("User-Agent", CHROME_UA)
        .set("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8")
        .call()
        .map_err(|e| format!("web_search: request failed: {}", e))?;

    let html = resp.into_string().map_err(|e| format!("web_search: read error: {}", e))?;

    let mut results = Vec::new();
    let title_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#
    ).unwrap();
    let snippet_re = regex::Regex::new(
        r#"<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>"#
    ).unwrap();
    let tag_re = regex::Regex::new(r"<[^>]*>").unwrap();

    let split_re = regex::Regex::new(r#"<div[^>]*class="[^"]*result[^"]*"[^>]*>"#).unwrap();
    let blocks: Vec<&str> = split_re.split(&html).collect();

    for block in &blocks[1..] {
        if let Some(tc) = title_re.captures(block) {
            let title = tag_re.replace_all(&tc[2], "").trim().to_string();
            if title.len() > 3 {
                let snippet = snippet_re.captures(block)
                    .map(|c| tag_re.replace_all(&c[1], "").trim().to_string())
                    .unwrap_or_default();
                results.push(serde_json::json!({
                    "title": title,
                    "url": tc[1].to_string(),
                    "snippet": snippet,
                }));
                if results.len() >= 10 { break; }
            }
        }
    }
    Ok(results)
}
/// URL-encode a string.
fn urlencoding(s: &str) -> String {
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

#[tauri::command]
pub(crate) async fn web_fetch(
    url: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Phase 2: WebFetch permission check
    {
        let ctx = crate::utils::get_ctx(&state)?;
        let tool = crate::tools::WebFetchTool { url: url.clone() };
        crate::utils::check_permission(&tool, &ctx, &app).await?;
    }

    let parsed = url::Url::parse(&url).map_err(|e| format!("无效 URL: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("不支持的协议: {}", scheme));
    }
    let host = parsed.host_str().unwrap_or("");
    if host.is_empty() || crate::utils::is_private_ip(host) {
        return Err("SSRF 防护: 不允许访问内网地址".to_string());
    }

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();

    let make_request =
        |ua: &str| -> Result<ureq::Response, ureq::Error> {
            agent.get(url.as_str())
                .set("User-Agent", ua)
                .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,text/markdown;q=0.7,*/*;q=0.1")
                .set("Accept-Language", "en-US,en;q=0.9")
                .call()
        };

    let resp = match make_request(CHROME_UA) {
        Ok(r) => r,
        // ponytail: Cloudflare bot detection → retry with honest UA (openCode pattern)
        Err(ureq::Error::Status(403, response)) if response.header("cf-mitigated") == Some("challenge") => {
            make_request("opencode").map_err(|e| format!("请求失败 (Cloudflare blocked): {}", e))?
        }
        Err(e) => return Err(format!("请求失败: {}", e)),
    };

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
// Constraints
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn read_constraints(project_path: String) -> Result<String, String> {
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    if !yaml_path.exists() {
        // Return default constraints from the repo template
        let default_path = crate::utils::project_root().join("hologram.constraints.yaml");
        return std::fs::read_to_string(&default_path)
            .map_err(|e| format!("无法读取默认约束文件: {}", e));
    }
    std::fs::read_to_string(&yaml_path)
        .map_err(|e| format!("无法读取约束文件: {}", e))
}

#[tauri::command]
pub(crate) async fn write_constraints(project_path: String, content: String) -> Result<(), String> {
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    let tmp_path = yaml_path.with_extension("yaml.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| format!("无法写入临时文件: {}", e))?;
    std::fs::rename(&tmp_path, &yaml_path)
        .map_err(|e| format!("无法保存约束文件: {}", e))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════
// Graph loading — cache load, analyze, background analysis
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn load_graph_json(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    // 1) explicit path — must exist, no silent fallthrough to wrong project
    if let Some(ref p) = path {
        let content = std::fs::read_to_string(p)
            .map_err(|e| format!("Graph JSON not found at {}: {}", p, e))?;
        if content.trim().is_empty() {
            return Err(format!("Graph JSON file is empty: {}", p));
        }
        return Ok(content);
    }

    // 2) active workspace graph (from WorkspaceHandle, not the legacy global)
    if let Some(ref handle) = *state.lock().unwrap() {
        let p = std::path::PathBuf::from(&handle.path).join("hologram_graph.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if !content.trim().is_empty() {
                return Ok(content);
            }
        }
    }

    // 3) last project recovery (read-only — no global mutation side effect)
    let last_path_file = crate::utils::project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let trim = last_path.trim();
        if !trim.is_empty() {
            let p = std::path::PathBuf::from(trim).join("hologram_graph.json");
            if let Ok(content) = std::fs::read_to_string(&p) {
                if !content.trim().is_empty() {
                    return Ok(content);
                }
            }
        }
    }

    Err("No cached graph found".into())
}

/// A3: Load graph from MessagePack binary (.hologram) — 10× faster for >10K nodes.
/// Tries: 1) explicit path, 2) active workspace .hologram, 3) last project recovery (read-only).
/// No silent fallback — if all tiers miss, returns an error.
#[tauri::command]
pub(crate) async fn load_binary_graph(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<Vec<u8>, String> {
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

    // 2) active workspace .hologram (from WorkspaceHandle, not the legacy global)
    if let Some(ref handle) = *state.lock().unwrap() {
        let p = std::path::PathBuf::from(&handle.path).join("hologram_graph.hologram");
        if p.exists() && holo_fresh(&p) {
            if let Ok(bytes) = std::fs::read(&p) {
                if !bytes.is_empty() {
                    return Ok(bytes);
                }
            }
        }
    }

    // 3) last project recovery (read-only — no global mutation side effect)
    let last_path_file = crate::utils::project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let trim = last_path.trim();
        if !trim.is_empty() {
            let p = std::path::PathBuf::from(trim).join("hologram_graph.hologram");
            if p.exists() && holo_fresh(&p) {
                if let Ok(bytes) = std::fs::read(&p) {
                    if !bytes.is_empty() {
                        return Ok(bytes);
                    }
                }
            }
        }
    }

    Err("No cached binary graph found".into())
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

/// 分析项目并返回完整图 JSON（从 CACHED_GRAPH 序列化）。
/// 唯一入口 —— 前端拿图数据的唯一途径（冷启动引导除外）。
#[tauri::command]
pub(crate) async fn analyze_and_load(path: String, force: Option<bool>, app: tauri::AppHandle) -> Result<String, String> {
    let force = force.unwrap_or(false);
    // Persist .last_project for cold-start recovery (workspace_activate has already set the handle)
    let _ = std::fs::write(crate::utils::project_root().join(".last_project"), &path);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站 — 分析中...");
    }

    // Run analysis with progress (reuses the polling helper)
    let analyze_future = crate::utils::run_analyze_with_progress(path.clone(), app.clone(), force);
    analyze_future.await.map_err(|e| format!("Rust 引擎分析失败: {e}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站");
    }

    // Ensure file-level graph exists
    let files_path = format!("{}/hologram_graph_files.json", path);
    if !std::path::Path::new(&files_path).exists() {
        let _ = crate::utils::regenerate_file_graph(&path);
    }

    // Serialize the full graph for response. Run on blocking thread —
    // ponytail: serializing 11k+ nodes is 50-200ms of sync JSON work.
    // Running it on the async worker starves other commands (e.g. concurrent
    // read_file_content) — their futures never get polled.
    let path_clone = path.clone();
    let serialized = tokio::task::spawn_blocking(move || crate::utils::serialize_cached_graph(&path_clone))
        .await
        .map_err(|e| format!("序列化任务失败: {e}"))??;
    Ok(serialized)
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
pub(crate) async fn analyze_in_background(path: String, app: tauri::AppHandle) -> Result<String, String> {
    // Rust engine background analysis — direct in-process call
    let app2 = app.clone();
    let path2 = path.clone();
    std::thread::spawn(move || {
        match crate::utils::direct_analyze(&path2, true) {
            Ok(_) => {
                let _ = std::fs::write(crate::utils::project_root().join(".last_project"), &path2);
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
// Git commands — IDE-level version control
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn git_tree_status(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    let porcelain = crate::utils::run_git(path, vec![
        "status".to_string(), "--porcelain".to_string(),
        "--ignored".to_string(), "--untracked-files".to_string(),
    ]).await.unwrap_or_default();

    let mut result = serde_json::Map::new();
    for line in porcelain.lines() {
        if line.len() < 4 { continue; }
        let st = &line[..2];
        let file_path = line[3..].trim();
        // For renames, take the new path
        let file_path = if let Some(idx) = file_path.find(" -> ") {
            &file_path[idx + 4..]
        } else {
            file_path
        };
        let status = if st == "!!" {
            "ignored"
        } else if st == "??" {
            "untracked"
        } else if st.contains('D') {
            "deleted"
        } else if st.contains('A') {
            "added"
        } else if st.contains('R') {
            "renamed"
        } else if st.contains('M') {
            "modified"
        } else {
            "modified"
        };
        result.insert(file_path.to_string(), serde_json::json!(status));
        // Also mark parent directories as containing changes
        let parts: Vec<&str> = file_path.split('/').collect();
        for i in 1..parts.len() {
            let dir = parts[..i].join("/");
            result.entry(dir).or_insert(serde_json::json!("modified-dir"));
        }
    }
    Ok(serde_json::json!(result).to_string())
}

#[tauri::command]
pub(crate) async fn git_status(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    let branch = crate::utils::run_git(path.clone(), vec!["rev-parse".to_string(), "--abbrev-ref".to_string(), "HEAD".to_string()]).await.unwrap_or_default();
    let branch = branch.trim().to_string();

    let mut ahead = 0i32;
    let mut behind = 0i32;
    if !branch.is_empty() {
        // Ahead/behind vs upstream
        if let Ok(ab) = crate::utils::run_git(path.clone(), vec!["rev-list".to_string(), "--left-right".to_string(), "--count".to_string(), format!("...origin/{}", branch)]).await {
            let parts: Vec<&str> = ab.trim().split('\t').collect();
            if parts.len() == 2 {
                ahead = parts[0].trim().parse().unwrap_or(0);   // left  = HEAD 独有的
                behind = parts[1].trim().parse().unwrap_or(0);  // right = origin 独有的
            }
        }
    }

    let porcelain = crate::utils::run_git(path.clone(), vec!["status".to_string(), "--porcelain".to_string()]).await.unwrap_or_default();
    let files = crate::utils::parse_status(&porcelain);

    let result = serde_json::json!({
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "files": files,
    });
    Ok(result.to_string())
}

#[tauri::command]
pub(crate) async fn git_diff_unstaged(
    path: String,
    file: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["diff".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_diff_staged(
    path: String,
    file: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["diff".to_string(), "--cached".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_stage(
    path: String,
    files: Vec<String>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stage", _agent.unwrap_or(false), &state, &app).await?;
    let mut args: Vec<String> = vec!["add".to_string()];
    args.extend(files.iter().map(|s| s.to_string()));
    crate::utils::run_git(path, args).await
}

#[tauri::command]
pub(crate) async fn git_unstage(
    path: String,
    files: Vec<String>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "unstage", _agent.unwrap_or(false), &state, &app).await?;
    let mut args: Vec<String> = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
    args.extend(files.iter().map(|s| s.to_string()));
    crate::utils::run_git(path, args).await
}

#[tauri::command]
pub(crate) async fn git_stage_all(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stage", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["add".to_string(), "-A".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_commit(
    path: String,
    message: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "commit", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["commit".to_string(), "-m".to_string(), message.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_push(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "push", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["push".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_pull(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "pull", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["pull".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_fetch(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "fetch", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["fetch".to_string(), "--all".to_string(), "--prune".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_log(
    path: String,
    limit: Option<i32>,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    let n = limit.unwrap_or(20);
    let raw = crate::utils::run_git(
        path.clone(),
        vec!["log".to_string(), format!("-{}", n), "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ai".to_string()],
    ).await?;
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
pub(crate) async fn git_init(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "init", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["init".to_string()]).await
}

// ── IDE-level Git operations ──

#[tauri::command]
pub(crate) async fn git_list_branches(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, _agent.unwrap_or(false), &state, &app).await?;
    let out = crate::utils::run_git(path.clone(), vec!["branch".to_string(), "--format=%(refname:short)".to_string()]).await?;
    let branches: Vec<&str> = out.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    // Find current branch (marked with *)
    let current_out = crate::utils::run_git(path.clone(), vec!["branch".to_string(), "--show-current".to_string()]).await?;
    let current = current_out.trim().to_string();
    serde_json::to_string(&serde_json::json!({ "branches": branches, "current": current }))
        .map_err(|e| format!("JSON 序列化失败: {}", e))
}

#[tauri::command]
pub(crate) async fn git_checkout(
    path: String,
    branch: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "checkout", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), branch.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    path: String,
    name: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "create_branch", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), "-b".to_string(), name.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_push(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stash_push", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "push".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_pop(
    path: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stash_pop", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "pop".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_list(
    path: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "list".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_discard(
    path: String,
    file: String,
    _agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "discard", _agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_blame(
    path: String,
    file: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["blame".to_string(), "--line-porcelain".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_file_at_head(
    path: String,
    file: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["show".to_string(), format!("HEAD:{}", file.clone())]).await
}

#[tauri::command]
pub(crate) async fn git_show(
    path: String,
    commit: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    let output = crate::utils::run_git(path.clone(), vec!["show".to_string(), "--name-only".to_string(), "--format=".to_string(), commit.clone()]).await?;
    let files: Vec<&str> = output.lines().filter(|l| !l.is_empty()).collect();
    serde_json::to_string(&files).map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════════════
// Permissions & MCP Server
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn permission_ask_response(
    request_id: String,
    allow: bool,
    remember: Option<bool>,
    rule_to_add: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    // Resolve the pending oneshot channel
    crate::permissions::resolve_ask(&request_id, allow);

    // If user wants to remember, add a session rule (in-memory only).
    // Session rules live for the current app session and are NOT persisted
    // to disk — this is distinct from permanent project rules which the user
    // edits explicitly in settings. "Always allow" means "always for this
    // session", not "always forever".
    if remember.unwrap_or(false) {
        if let Some(ref rule_str) = rule_to_add {
            if let Ok(ctx) = crate::utils::get_ctx(&state) {
                let behavior = if allow { "allow" } else { "deny" };
                ctx.add_session_rule(rule_str, behavior);
            }
        }
    }
    Ok(())
}

pub(crate) static MCP_MANAGER: std::sync::LazyLock<Arc<Mutex<McpManager>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(McpManager::new())));

// ═══════════════════════════════════════════════════════
// MCP Server 命令 — Step 1: 持久进程 + 自动工具发现
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn start_mcp_server(project_root: String) -> Result<String, String> {
    let engine = crate::utils::engine_binary();
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.start(&project_root, &engine)
}


#[tauri::command]
pub(crate) async fn stop_mcp_server() -> Result<String, String> {
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.stop();
    Ok("MCP Server 已停止".into())
}

// ═══════════════════════════════════════════════════════
// Unity event server + process manager
// ═══════════════════════════════════════════════════════

pub(crate) fn start_unity_event_server(app: tauri::AppHandle) {
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

pub(crate) static UNITY_MANAGER: std::sync::LazyLock<UnityManager> =
    std::sync::LazyLock::new(|| UnityManager::new(UnityManager::default_exe_path()));

#[tauri::command]
pub(crate) fn start_unity() -> Result<String, String> {
    match UNITY_MANAGER.start() {
        Ok(true) => Ok("Unity started".into()),
        Ok(false) => Ok("Unity already running".into()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) fn stop_unity() -> Result<String, String> {
    UNITY_MANAGER.stop().map(|_| "Unity stopped".into())
}

#[tauri::command]
pub(crate) fn unity_status() -> Result<String, String> {
    Ok(if UNITY_MANAGER.is_running() { "running" } else { "stopped" }.into())
}

#[tauri::command]
pub(crate) fn engine_get_graph() -> Result<String, String> {
    crate::utils::with_graph(|g| graph_summary(g))
}

#[tauri::command]
pub(crate) fn engine_neighbors(node_id: String, depth: usize) -> Result<String, String> {
    crate::utils::with_graph(move |g| {
        let nb = query::neighbors(g, &node_id, depth);
        serde_json::json!({"neighbors": nb.iter().map(|(s,t,d)| serde_json::json!([s,t,d])).collect::<Vec<_>>()})
    })
}

#[tauri::command]
pub(crate) fn engine_path(from_id: String, to_id: String) -> Result<String, String> {
    crate::utils::with_graph(move |g| {
        match query::shortest_path(g, &from_id, &to_id) {
            Some(p) => serde_json::json!({"path": p, "length": p.len()}),
            None => serde_json::json!({"path": null, "message": "no path"}),
        }
    })
}

#[tauri::command]
pub(crate) fn engine_search(query: String) -> Result<String, String> {
    crate::utils::with_graph(move |g| {
        let results = query::search_nodes(g, &query);
        serde_json::json!({"results": results.iter().map(|n| serde_json::json!({"id":n.id,"name":n.name})).collect::<Vec<_>>()})
    })
}

#[tauri::command]
pub(crate) fn engine_impact(node_id: String, max_depth: usize) -> Result<String, String> {
    crate::utils::with_graph(move |g| {
        let layers = query::impact(g, &node_id, max_depth);
        serde_json::json!({"layers": layers})
    })
}

// ═══════════════════════════════════════════════════════
// Credential store
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn credential_store(provider: String, key: String) -> Result<(), String> {
    crate::credential::store_api_key(&provider, &key)
}

#[tauri::command]
pub(crate) fn credential_get(provider: String) -> Result<Option<String>, String> {
    crate::credential::get_api_key(&provider)
}

#[tauri::command]
pub(crate) fn credential_clear() -> Result<(), String> {
    crate::credential::clear_credentials()
}

// ═══════════════════════════════════════════════════════
// Agent Isolation — worktree-based sandbox
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn agent_isolation_create(
    agent_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let project_path = crate::utils::workspace_path(&state)?;
    let main_path = std::path::PathBuf::from(&project_path);

    let isolation =
        AgentIsolation::create_worktree(&main_path, &agent_id)?;

    let wt_path = isolation
        .worktree_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let original_head = isolation.original_head.clone();

    // Set isolation on the permission context
    if let Ok(guard) = state.lock() {
        if let Some(ref handle) = *guard {
            handle.permission_ctx.set_isolation(isolation);
        }
    }

    let short_head = &original_head[..8.min(original_head.len())];
    Ok(serde_json::json!({
        "worktree_path": wt_path,
        "agent_id": agent_id,
        "original_head": short_head,
    })
    .to_string())
}

/// Show the diff of worktree changes (before user decides merge/discard).
#[tauri::command]
pub(crate) fn agent_isolation_diff(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation()
        .ok_or("没有活跃的隔离环境")?;

    if isolation.kind == IsolationKind::None {
        return Err("当前未使用工作树隔离".into());
    }

    match isolation.cleanup()? {
        crate::agent_isolation::CleanupResult::NoChanges => Ok(
            serde_json::json!({"has_changes": false, "diff": ""}).to_string(),
        ),
        crate::agent_isolation::CleanupResult::HasChanges {
            diff,
            worktree_path,
        } => Ok(serde_json::json!({
            "has_changes": true,
            "diff": diff,
            "worktree_path": worktree_path.to_string_lossy(),
        })
        .to_string()),
    }
}

/// Merge worktree changes back to main repo and clean up.
#[tauri::command]
pub(crate) fn agent_isolation_merge(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation()
        .ok_or("没有活跃的隔离环境")?;

    let result = isolation.merge_to_main()?;
    ctx.clear_isolation();
    Ok(result)
}

/// Discard worktree changes and clean up.
#[tauri::command]
pub(crate) fn agent_isolation_discard(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation()
        .ok_or("没有活跃的隔离环境")?;

    isolation.discard()?;
    ctx.clear_isolation();
    Ok("工作树已丢弃".into())
}

/// Get current isolation status.
#[tauri::command]
pub(crate) fn agent_isolation_status(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let iso = ctx.get_isolation();
    match iso {
        Some(i) if i.kind == IsolationKind::Worktree => Ok(serde_json::json!({
            "isolation": "worktree",
            "worktree_path": i.worktree_path.map(|p| p.to_string_lossy().to_string()),
        })
        .to_string()),
        _ => Ok(serde_json::json!({"isolation": "none"}).to_string()),
    }
}
