// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Dataflow Tauri command — per-file deterministic analysis via tree-sitter.
// No trace storage, no Agent-driven snapshots. Engine queries only.

use tauri;
use serde_json;
use std::path::PathBuf;
use hologram_engine as engine;
use engine::analysis::dataflow_engine::query_dataflow_files;

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
