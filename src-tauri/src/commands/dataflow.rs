// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Dataflow trace Tauri commands — Agent-driven dataflow tracing.
// 桥接：前端 Agent / Dataflow 面板 → Tauri command → engine dataflow API + SQLite.

use tauri;
use serde_json;
use std::path::{Path, PathBuf};
use hologram_engine as engine;
use engine::analysis::dataflow_engine::{query_dataflow_files, DataflowFileResult};
use engine::graph::query;
use engine::storage::{SqliteDb, Connection};
use engine::storage::sqlite::{
    dataflow_save_trace, dataflow_query_trace, dataflow_list_traces, dataflow_delete_trace,
    dataflow_update_meta,
};

/// Open an aux connection to <root>/.hologram/hologram.db and ensure dataflow_traces table exists.
/// ponytail: aux 连接不跑 ensure_schema，手动建 dataflow_traces 表（幂等）。
/// 复用 timeline 的 aux 模式，避免阻塞 graph store 主连接。
fn open_dataflow_db(root: &str) -> Result<Connection, String> {
    let db_path = Path::new(root).join(".hologram").join("hologram.db");
    let conn = SqliteDb::open_aux_connection(&db_path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS dataflow_traces (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            trace_id     TEXT NOT NULL UNIQUE,
            resource     TEXT NOT NULL,
            description  TEXT DEFAULT '',
            language     TEXT DEFAULT '',
            files_json   TEXT DEFAULT '[]',
            created_at   TEXT NOT NULL,
            verified_at  TEXT,
            test_file    TEXT DEFAULT '',
            test_status  TEXT DEFAULT '',
            commit_hash  TEXT DEFAULT '',
            status       TEXT DEFAULT 'active',
            trace_json   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dt_resource ON dataflow_traces(resource);
        CREATE INDEX IF NOT EXISTS idx_dt_status   ON dataflow_traces(status);",
    ).map_err(|e| format!("ensure dataflow_traces: {}", e))?;
    Ok(conn)
}

// ═══════════════════════════════════════════════════════
// hologram_dataflow — per-file dataflow analysis (Agent tool)
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_dataflow(
    files: Vec<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_dataflow", &state)?;
    if files.is_empty() {
        return Err("files is required and must be a non-empty array".into());
    }
    let root = crate::utils::workspace_path(&state)?;
    let paths: Vec<PathBuf> = files.iter().map(|f| {
        let p = PathBuf::from(f);
        if p.is_absolute() { p } else { PathBuf::from(&root).join(f) }
    }).collect();

    tokio::task::spawn_blocking(move || {
        let results = query_dataflow_files(&paths);
        let out: Vec<serde_json::Value> = results.iter().map(|r| match &r.result {
            Ok(df) => serde_json::json!({
                "file": r.file,
                "scopes": df.scopes.iter().map(|s| serde_json::json!({
                    "name": s.name, "reads": s.reads, "writes": s.writes,
                    "triggers": s.triggers, "awaits_callbacks": s.awaits_callbacks,
                    "sequence_calls": s.sequence_calls,
                })).collect::<Vec<_>>(),
                "shared": df.shared.iter().map(|sh| serde_json::json!({
                    "var": sh.var, "readers": sh.readers, "writers": sh.writers,
                })).collect::<Vec<_>>(),
            }),
            Err(e) => serde_json::json!({ "file": r.file, "error": e }),
        }).collect();
        Ok(serde_json::json!({ "results": out }).to_string())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// dataflow_save — persist a trace (Layer1 snippet + Layer2 cross-validate)
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_save(
    trace_json: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("dataflow_save", &state)?;
    let root = crate::utils::workspace_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let mut trace: serde_json::Value = serde_json::from_str(&trace_json)
            .map_err(|e| format!("parse trace_json: {}", e))?;

        if trace.get("trace_id").and_then(|v| v.as_str()).is_none() {
            return Err("trace_json missing trace_id".into());
        }
        if trace.get("resource").and_then(|v| v.as_str()).is_none() {
            return Err("trace_json missing resource".into());
        }

        // Layer 1: source_snippets anchor validation
        let snippets_ok = validate_snippets(&trace, &root);

        // Layer 2: dataflow engine cross-validation → update edge confidence
        cross_validate_edges(&mut trace, &root);

        if !snippets_ok {
            trace["status"] = serde_json::json!("stale");
        }

        let conn = open_dataflow_db(&root)?;
        dataflow_save_trace(&conn, &trace)
            .map_err(|e| format!("save trace: {}", e))?;

        Ok(serde_json::json!({
            "trace_id": trace["trace_id"],
            "status": trace["status"],
            "snippets_ok": snippets_ok,
        }).to_string())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// dataflow_query / list / delete
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_query(
    trace_id: Option<String>,
    resource: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("dataflow_query", &state)?;
    let root = crate::utils::workspace_path(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_dataflow_db(&root)?;
        let trace = dataflow_query_trace(&conn, trace_id.as_deref(), resource.as_deref())
            .map_err(|e| format!("query: {}", e))?;
        Ok(serde_json::json!({ "trace": trace }).to_string())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn dataflow_list(
    language: Option<String>,
    status: Option<String>,
    limit: Option<i32>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("dataflow_list", &state)?;
    let root = crate::utils::workspace_path(&state)?;
    let lim = limit.unwrap_or(50) as usize;
    tokio::task::spawn_blocking(move || {
        let conn = open_dataflow_db(&root)?;
        let traces = dataflow_list_traces(&conn, language.as_deref(), status.as_deref(), lim)
            .map_err(|e| format!("list: {}", e))?;
        Ok(serde_json::json!({ "traces": traces }).to_string())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn dataflow_delete(
    trace_id: String,
    hard: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("dataflow_delete", &state)?;
    let root = crate::utils::workspace_path(&state)?;
    let h = hard.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        let conn = open_dataflow_db(&root)?;
        dataflow_delete_trace(&conn, &trace_id, h)
            .map_err(|e| format!("delete: {}", e))?;
        Ok("ok".into())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// dataflow_verify — re-run Layer 1-2 + linked test, update metadata
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_verify(
    trace_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("dataflow_verify", &state)?;
    let root = crate::utils::workspace_path(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_dataflow_db(&root)?;
        let mut trace = dataflow_query_trace(&conn, Some(&trace_id), None)
            .map_err(|e| format!("query: {}", e))?
            .ok_or_else(|| format!("trace {} not found", trace_id))?;

        // Layer 1: snippet anchors
        let snippets_ok = validate_snippets(&trace, &root);

        // Layer 2: re-cross-validate edges
        cross_validate_edges(&mut trace, &root);

        // Run linked test if present
        let test_file = trace.get("test_file").and_then(|v| v.as_str()).unwrap_or("");
        let test_status = if !test_file.is_empty() {
            run_linked_test(test_file, &root)
        } else {
            String::new()
        };

        let now = chrono::Utc::now().to_rfc3339();
        let status = if !snippets_ok { "stale".to_string() }
                     else if test_status.starts_with("0/") { "broken".to_string() }
                     else { "active".to_string() };

        trace["status"] = serde_json::json!(status);
        trace["verified_at"] = serde_json::json!(now);
        if !test_status.is_empty() {
            trace["test_status"] = serde_json::json!(test_status);
        }

        // Save updated trace (full JSON) + update meta columns
        dataflow_save_trace(&conn, &trace)
            .map_err(|e| format!("save: {}", e))?;

        Ok(serde_json::json!({
            "trace_id": trace_id, "status": status,
            "snippets_ok": snippets_ok, "test_status": test_status, "verified_at": now,
        }).to_string())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// dataflow_stale_check — Layer 3: detect stale traces
// 重跑 Layer 1 snippet 锚点 + 检查 files_involved 存在性 +
// hologram_search 搜 resource → 对比引用集 → 新引用文件标 stale
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_stale_check(
    trace_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("dataflow_stale_check", &state)?;
    let root = crate::utils::workspace_path(&state)?;
    tokio::task::spawn_blocking(move || {
        let conn = open_dataflow_db(&root)?;

        let to_check: Vec<String> = if let Some(tid) = &trace_id {
            vec![tid.clone()]
        } else {
            let traces = dataflow_list_traces(&conn, None, None, 1000)
                .map_err(|e| format!("list: {}", e))?;
            traces.iter()
                .filter_map(|t| {
                    let s = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if s == "active" || s == "stale" {
                        t.get("trace_id").and_then(|v| v.as_str()).map(String::from)
                    } else { None }
                }).collect()
        };

        let mut results: Vec<serde_json::Value> = Vec::new();
        for tid in &to_check {
            let trace = match dataflow_query_trace(&conn, Some(tid), None)
                .map_err(|e| format!("query {}: {}", tid, e)) {
                Ok(Some(t)) => t,
                Ok(None) => continue,
                Err(_) => continue,
            };

            let snippets_ok = validate_snippets(&trace, &root);
            let files_exist = check_files_exist(&trace, &root);

            // Layer 3: hologram_search 搜 resource → 对比引用集
            let resource = trace.get("resource").and_then(|v| v.as_str()).unwrap_or("");
            let known_files: Vec<String> = trace.get("files_involved")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.replace('\\', "/")).collect())
                .unwrap_or_default();
            let new_refs = if !resource.is_empty() {
                check_new_references(resource, &known_files)
            } else { false };

            let is_stale = !snippets_ok || !files_exist || new_refs;

            if is_stale {
                let _ = dataflow_update_meta(&conn, tid, "stale", None, None);
            }
            results.push(serde_json::json!({
                "trace_id": tid, "stale": is_stale,
                "snippets_ok": snippets_ok, "files_exist": files_exist,
                "new_refs": new_refs,
            }));
        }

        Ok(serde_json::json!({ "results": results }).to_string())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

/// 用 hologram_search 搜 resource，检查是否有新文件引用了该 resource 但不在 known_files 里。
fn check_new_references(resource: &str, known_files: &[String]) -> bool {
    let res_str = crate::utils::with_graph(move |g| {
        let nodes = query::search_nodes(g, resource);
        // 收集所有匹配节点的 location（文件路径）
        let mut found_files: Vec<String> = Vec::new();
        for n in nodes.iter().take(50) {
            if let Some(loc) = &n.location {
                // location 格式 "path:line" 或 "path"
                let file = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                let norm = file.replace('\\', "/");
                if !found_files.contains(&norm) { found_files.push(norm); }
            }
        }
        serde_json::json!({ "found_files": found_files })
    });
    if let Ok(s) = res_str {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(found) = v.get("found_files").and_then(|f| f.as_array()) {
                for f in found {
                    if let Some(fs) = f.as_str() {
                        let norm = fs.replace('\\', "/");
                        if !known_files.iter().any(|k| k.ends_with(&norm) || norm.ends_with(k.as_str()) || k == &norm) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

// ═══════════════════════════════════════════════════════
// Layer 1: source_snippets anchor validation
// ponytail: 简单启发式 — snippet.code 首行在 file 的 line 附近 5 行内出现。
// 上限：只查首行，不验证完整片段；升级路径是全文精确 diff。
// ═══════════════════════════════════════════════════════

fn validate_snippets(trace: &serde_json::Value, root: &str) -> bool {
    let snippets = match trace.get("source_snippets").and_then(|v| v.as_object()) {
        Some(s) => s,
        None => return true,
    };
    for (_, snip) in snippets {
        let code = snip.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let file = snip.get("file").and_then(|v| v.as_str()).unwrap_or("");
        let line = snip.get("line").and_then(|v| v.as_i64()).unwrap_or(0);
        if code.is_empty() || file.is_empty() || line <= 0 { continue; }

        let path = {
            let p = PathBuf::from(file);
            if p.is_absolute() { p } else { PathBuf::from(root).join(file) }
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let code_first = code.lines().next().unwrap_or("").trim();
        if code_first.is_empty() { continue; }

        let lines: Vec<&str> = content.lines().collect();
        let idx = (line as usize).saturating_sub(1);
        let window: String = lines.get(idx..).unwrap_or(&[])
            .iter().take(5).cloned().collect::<Vec<_>>().join("\n");
        if !window.contains(code_first) {
            return false;
        }
    }
    true
}

// ═══════════════════════════════════════════════════════
// Layer 2: dataflow engine cross-validation
// 对 trace 的每条 edge，查 dataflow 引擎输出是否支持。
// 引擎看到的 → confidence 升级为 static_match；没看到 → speculative。
// calls/defines/imports 边不在 dataflow 引擎范畴，不验证（保持原 confidence）。
// ═══════════════════════════════════════════════════════

fn cross_validate_edges(trace: &mut serde_json::Value, root: &str) {
    let files: Vec<String> = trace.get("files_involved")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() { return; }

    let paths: Vec<PathBuf> = files.iter().map(|f| {
        let p = PathBuf::from(f);
        if p.is_absolute() { p } else { PathBuf::from(root).join(f) }
    }).collect();
    let results = query_dataflow_files(&paths);

    let edges = match trace.get_mut("edges").and_then(|v| v.as_array_mut()) {
        Some(e) => e,
        None => return,
    };
    for edge in edges.iter_mut() {
        let from = edge.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = edge.get("to").and_then(|v| v.as_str()).unwrap_or("");
        let kind = edge.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let cur = edge.get("confidence").and_then(|v| v.as_str()).unwrap_or("speculative");

        if cur == "verified" { continue; }

        if edge_in_dataflow(from, to, kind, &results) {
            edge["confidence"] = serde_json::json!("static_match");
        } else {
            edge["confidence"] = serde_json::json!("speculative");
        }
    }
}

fn edge_in_dataflow(from: &str, to: &str, kind: &str, results: &[DataflowFileResult]) -> bool {
    for r in results {
        let df = match &r.result { Ok(d) => d, Err(_) => continue };
        match kind {
            "shares" => {
                if df.shared.iter().any(|sh| sh.var == to
                    && (sh.readers.iter().any(|x| x == from) || sh.writers.iter().any(|x| x == from))) {
                    return true;
                }
            }
            "writes" => {
                if df.scopes.iter().any(|s| s.name == from && s.writes.iter().any(|w| w == to)) {
                    return true;
                }
            }
            "reads" => {
                if df.scopes.iter().any(|s| s.name == from && s.reads.iter().any(|x| x == to)) {
                    return true;
                }
            }
            "triggers" => {
                if df.scopes.iter().any(|s| s.name == from && s.triggers.iter().any(|x| x == to)) {
                    return true;
                }
            }
            "awaits" => {
                if df.scopes.iter().any(|s| s.name == from && s.awaits_callbacks.iter().any(|x| x == to)) {
                    return true;
                }
            }
            "sequences" => {
                if df.scopes.iter().any(|s| s.name == from && s.sequence_calls.iter().any(|x| x == to)) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

// ═══════════════════════════════════════════════════════
// Helpers for verify / stale_check
// ═══════════════════════════════════════════════════════

/// Check all files_involved still exist on disk.
fn check_files_exist(trace: &serde_json::Value, root: &str) -> bool {
    let files = match trace.get("files_involved").and_then(|v| v.as_array()) {
        Some(f) => f,
        None => return true,
    };
    for f in files {
        let path = match f.as_str() { Some(s) => s, None => continue };
        let p = {
            let pb = PathBuf::from(path);
            if pb.is_absolute() { pb } else { PathBuf::from(root).join(path) }
        };
        if !p.exists() { return false; }
    }
    true
}

/// Run a linked test file and return "N/M passed" or error string.
/// ponytail: 扩展名 → 命令映射，无框架检测。上限：单文件测试，无并行。
fn run_linked_test(test_file: &str, root: &str) -> String {
    let path = {
        let p = PathBuf::from(test_file);
        if p.is_absolute() { p } else { PathBuf::from(root).join(test_file) }
    };
    if !path.exists() { return format!("test file not found: {}", test_file); }

    let (cmd, args) = match path.extension().and_then(|e| e.to_str()) {
        Some("ts") | Some("js") | Some("tsx") | Some("jsx") =>
            ("npx", vec!["vitest", "run", path.to_str().unwrap_or(""), "--reporter=dot"]),
        Some("py") =>
            ("python", vec!["-m", "pytest", path.to_str().unwrap_or(""), "-q"]),
        Some("go") =>
            ("go", vec!["test", "-run", path.file_stem().and_then(|s| s.to_str()).unwrap_or("")]),
        Some("rs") =>
            ("cargo", vec!["test", path.file_stem().and_then(|s| s.to_str()).unwrap_or("")]),
        _ => return "unsupported test file extension".into(),
    };

    let output = std::process::Command::new(cmd)
        .args(&args)
        .current_dir(root)
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            let combined = format!("{}\n{}", stdout, stderr);
            // ponytail: 简单解析 — 数 passed/failed 关键词，不依赖框架特定格式
            let passed = combined.matches("passed").count()
                + combined.matches("PASS").count()
                + combined.matches("✓").count();
            let failed = combined.matches("failed").count()
                + combined.matches("FAIL").count()
                + combined.matches("✗").count();
            if out.status.success() {
                if passed > 0 { format!("{}/{} passed", passed, passed + failed) }
                else { "passed".into() }
            } else if failed > 0 {
                format!("{}/{} passed", passed, passed + failed)
            } else {
                format!("test failed: {}", combined.lines().last().unwrap_or("unknown"))
            }
        }
        Err(e) => format!("test run error: {}", e),
    }
}
