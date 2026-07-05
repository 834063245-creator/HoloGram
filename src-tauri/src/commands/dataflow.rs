// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Dataflow Tauri commands — per-file tree-sitter analysis + result persistence.
// Engine queries are deterministic; storage saves engine results (not Agent snapshots).

use tauri;
use serde_json;
use std::path::PathBuf;
use std::fs;
use chrono::Utc;
use hologram_engine as engine;
use engine::analysis::dataflow_engine::query_dataflow_files;

// ═══════════════════════════════════════════════════════════════
// hologram_dataflow — per-file dataflow analysis (Agent tool)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// dataflow_save — persist engine query results as JSON
// ═══════════════════════════════════════════════════════════════
// ponytail: JSON files in .hologram/dataflow/ — no SQLite schema, no migrations.

#[tauri::command]
pub(crate) async fn dataflow_save(
    query: String,
    explore_result: Option<String>,
    dataflow_result: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    let dir = PathBuf::from(&root).join(".hologram").join("dataflow");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let now = Utc::now();
    let trace_id = format!("df_{}", now.format("%Y%m%dT%H%M%S%3f"));
    let path = dir.join(format!("{trace_id}.json"));

    let record = serde_json::json!({
        "traceId": trace_id,
        "query": query,
        "exploreResult": explore_result,
        "dataflowResult": dataflow_result,
        "createdAt": now.to_rfc3339(),
    });

    fs::write(&path, serde_json::to_string_pretty(&record)
        .map_err(|e| format!("序列化失败: {e}"))?)
        .map_err(|e| format!("写入失败: {e}"))?;

    Ok(serde_json::json!({ "traceId": trace_id, "savedAt": now.to_rfc3339() }).to_string())
}

// ═══════════════════════════════════════════════════════════════
// dataflow_query — list recent traces or load a specific one
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_query(
    trace_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    let dir = PathBuf::from(&root).join(".hologram").join("dataflow");

    if !dir.exists() {
        return Ok(serde_json::json!({ "traces": [] }).to_string());
    }

    // Load specific trace
    if let Some(tid) = trace_id {
        let path = dir.join(format!("{tid}.json"));
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取失败: {e}"))?;
        return Ok(content);
    }

    // List recent traces (newest first)
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| format!("读取目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "json"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let created = meta.modified().ok()?;
            Some((e.path(), created))
        })
        .collect();

    entries.sort_by(|a, b| b.1.cmp(&a.1));
    let traces: Vec<serde_json::Value> = entries.into_iter().take(50).filter_map(|(p, _)| {
        let content = fs::read_to_string(&p).ok()?;
        serde_json::from_str::<serde_json::Value>(&content).ok()
    }).collect();

    Ok(serde_json::json!({ "traces": traces }).to_string())
}
