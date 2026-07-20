// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Dataflow Tauri commands — per-file tree-sitter analysis + result persistence.
// Engine queries are deterministic; storage saves engine results (not Agent snapshots).

use tauri;
use serde_json;
use std::path::PathBuf;
use std::fs;
use chrono::Utc;


// ═══════════════════════════════════════════════════════════════
// dataflow_save — persist Agent-produced trace content as JSON
// ═══════════════════════════════════════════════════════════════
// ponytail: JSON files in .hologram/dataflow/ — no SQLite schema, no migrations.
// `content` is the Agent's free-form trace (markdown or structured text).
// `exploreResult` / `dataflowResult` are legacy engine dumps; still accepted.

#[tauri::command]
pub(crate) async fn dataflow_save(
    query: String,
    content: Option<String>,
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
        "content": content,
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
// dataflow_query — list summaries or load a specific trace
// ═══════════════════════════════════════════════════════════════
// trace_id=Some → load full trace. trace_id=None + list=true → summaries.
// trace_id=None + list=false/absent → full content list (legacy).

#[tauri::command]
pub(crate) async fn dataflow_query(
    trace_id: Option<String>,
    list: Option<bool>,
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

    // Collect entries (newest first)
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| format!("读取目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let created = meta.modified().ok()?;
            Some((e.path(), created))
        })
        .collect();

    entries.sort_by(|a, b| b.1.cmp(&a.1));

    // Summary mode — lightweight list for panel/Agent browsing
    if list.unwrap_or(false) {
        let summaries: Vec<serde_json::Value> = entries.into_iter().take(100).filter_map(|(p, _)| {
            let raw = fs::read_to_string(&p).ok()?;
            let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
            Some(serde_json::json!({
                "traceId": v.get("traceId").and_then(|x| x.as_str()).unwrap_or(""),
                "query": v.get("query").and_then(|x| x.as_str()).unwrap_or(""),
                "createdAt": v.get("createdAt").and_then(|x| x.as_str()).unwrap_or(""),
                "hasContent": v.get("content").and_then(|x| x.as_str()).map(|c| !c.is_empty()).unwrap_or(false),
            }))
        }).collect();
        return Ok(serde_json::json!({ "traces": summaries }).to_string());
    }

    // Full content list (legacy)
    let traces: Vec<serde_json::Value> = entries.into_iter().take(50).filter_map(|(p, _)| {
        let content = fs::read_to_string(&p).ok()?;
        serde_json::from_str::<serde_json::Value>(&content).ok()
    }).collect();

    Ok(serde_json::json!({ "traces": traces }).to_string())
}

// ═══════════════════════════════════════════════════════════════
// dataflow_delete — remove a saved trace
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_delete(
    trace_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    let path = PathBuf::from(&root)
        .join(".hologram")
        .join("dataflow")
        .join(format!("{trace_id}.json"));

    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
        Ok(serde_json::json!({ "deleted": trace_id }).to_string())
    } else {
        Err(format!("追踪记录不存在: {trace_id}"))
    }
}
