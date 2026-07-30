// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Dataflow Tauri 命令 — 逐文件 tree-sitter 分析 + 结果持久化。
// 引擎查询是确定性的；存储保存引擎结果（而非 Agent 快照）。

use tauri;
use serde_json;
use std::path::PathBuf;
use std::fs;
use chrono::Utc;


// ═══════════════════════════════════════════════════════════════
// dataflow_save — 将 Agent 产生的追踪内容持久化为 JSON
// ═══════════════════════════════════════════════════════════════
// ponytail: .hologram/dataflow/ 中的 JSON 文件 — 无 SQLite schema，无迁移。
// `content` 是 Agent 的自由格式追踪（markdown 或结构化文本）。
// `exploreResult` / `dataflowResult` 是遗留引擎转储；仍然接受。

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
// dataflow_query — 列出摘要或加载特定追踪记录
// ═══════════════════════════════════════════════════════════════
// trace_id=Some → 加载完整追踪记录。trace_id=None + list=true → 摘要。
// trace_id=None + list=false/absent → 完整内容列表（遗留模式）。

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

    // 加载特定追踪记录
    if let Some(tid) = trace_id {
        crate::utils::sanitize_path_id(&tid, "trace_id")?;
        let path = dir.join(format!("{tid}.json"));
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取失败: {e}"))?;
        return Ok(content);
    }

    // 收集条目（最新优先）
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

    // 摘要模式 — 面板/Agent 浏览用的轻量列表
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

    // 完整内容列表（遗留模式）
    let traces: Vec<serde_json::Value> = entries.into_iter().take(50).filter_map(|(p, _)| {
        let content = fs::read_to_string(&p).ok()?;
        serde_json::from_str::<serde_json::Value>(&content).ok()
    }).collect();

    Ok(serde_json::json!({ "traces": traces }).to_string())
}

// ═══════════════════════════════════════════════════════════════
// dataflow_delete — 删除已保存的追踪记录
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn dataflow_delete(
    trace_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::sanitize_path_id(&trace_id, "trace_id")?;
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
