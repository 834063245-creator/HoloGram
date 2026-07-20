// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Hologram graph query and analysis Tauri commands.

use tauri;
use serde_json;
use hologram_engine as engine;
use engine::engine as engine_api;
use engine::routing::preflight::{check_timeline_props, load_baseline, save_baseline};

#[tauri::command]
pub(crate) async fn get_full_graph(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let source_root = crate::utils::workspace_path(&state)?;
    tokio::task::spawn_blocking(move || crate::utils::serialize_cached_graph(&source_root))
        .await.map_err(|e| format!("任务失败: {e}"))?
}


#[tauri::command]
pub(crate) async fn hologram_run_check(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_run_check", &state)?;
    let target = path.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());
    // Extract and clear changed_files before spawning blocking task.
    // Clearing early prevents a race where new changes arrive mid-check.
    let changed_files: Vec<String> = state.lock().unwrap().as_ref()
        .and_then(|h| {
            let mut files = h.changed_files.lock().ok()?;
            let snapshot = files.clone();
            files.clear();
            Some(snapshot)
        })
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let root = std::path::PathBuf::from(&target);
        let before = load_baseline(&root);
        // Prefer in-memory / SQLite cache; only run full analyze when truly empty.
        let after = if let Ok(g) = engine_api::engine_read_graph(|g| g.clone()) {
            if g.node_count() > 0 || g.edge_count() > 0 {
                Some(g)
            } else {
                None
            }
        } else {
            None
        };
        let after = match after {
            Some(g) => g,
            None => {
                engine_api::engine_init(&root)
                    .map_err(|e| format!("引擎初始化失败: {}", e))?;
                if let Ok(g) = engine_api::engine_read_graph(|g| g.clone()) {
                    if g.node_count() > 0 || g.edge_count() > 0 {
                        g
                    } else {
                        crate::utils::direct_analyze(&target, true)?;
                        engine_api::engine_read_graph(|g| g.clone())
                            .map_err(|e| format!("分析后无图谱: {}", e))?
                    }
                } else {
                    crate::utils::direct_analyze(&target, true)?;
                    engine_api::engine_read_graph(|g| g.clone())
                        .map_err(|e| format!("分析后无图谱: {}", e))?
                }
            }
        };
        let result = run_full_check(&before, &after, &changed_files, &target);

        // Always advance baseline — next check diffs against this snapshot.
        save_baseline(&root, &after);

        // Record meaningful checks to timeline (skip quiet open-project polls).
        let quiet = result.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);
        let baseline_seed = result.get("baseline_seed").and_then(|v| v.as_bool()).unwrap_or(false);
        if !quiet || baseline_seed {
            let passed = result["passed"].as_bool().unwrap_or(true);
            let violation_count = result["violation_count"].as_u64().unwrap_or(0);
            let event_type = if passed { "commit_clean" } else { "commit_violation" };
            let summary = if baseline_seed {
                "基线已建立".to_string()
            } else if passed {
                format!("简报通过（{} 违规）", violation_count)
            } else {
                format!("简报未通过：{} 条违规", violation_count)
            };
            let props = check_timeline_props(&result);
            if engine_api::engine_record_timeline_with_props(event_type, None::<&str>, &summary, &props).is_err() {
                let _ = engine_api::engine_init(&root);
                let _ = engine_api::engine_record_timeline_with_props(event_type, None::<&str>, &summary, &props);
            }
        }

        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("简报任务失败: {e}"))?
}
/// Record a user-facing event in the unified timeline (hologram.db).
#[tauri::command]
pub(crate) async fn hologram_record_event(
    event_type: String,
    file: Option<String>,
    summary: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_record_event", &state)?;
    tokio::task::spawn_blocking(move || {
        engine_api::engine_record_timeline(&event_type, file.as_deref(), &summary)
            .map_err(|e| format!("时间轴写入失败: {}", e))
    }).await.map_err(|e| format!("时间轴写入失败: {}", e))??;
    Ok("ok".into())
}


// ═══════════════════════════════════════════════════════
// P6: Hotspots — 复发热点检测（L4 复发计数）
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_hotspots(
    days: Option<i32>,
    min_count: Option<i32>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_hotspots", &state)?;
    let limit = min_count.unwrap_or(3) as usize;
    let _ = days;
    tokio::task::spawn_blocking(move || {
        match engine_api::engine_query_timeline(limit) {
            Ok(events) => Ok(serde_json::json!({"events": events, "limit": limit}).to_string()),
            Err(e) => Ok(serde_json::json!({"error": e, "events": []}).to_string()),
        }
    }).await.map_err(|e| format!("热点查询失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// P7: Workspace Conflict — 多工作区冲突预演
// ═══════════════════════════════════════════════════════

#[tauri::command]
#[allow(dead_code)] // stub — not yet wired into the invoke_handler
pub(crate) async fn hologram_workspace_conflict(
    path_a: String,
    path_b: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_workspace_conflict", &state)?;
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
pub(crate) async fn hologram_gate_check(
    path: String,
    _module_file: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_gate_check", &state)?;
    // Gate check reuses hologram_run_check logic
    let target = path;
    let changed_files: Vec<String> = state.lock().unwrap().as_ref()
        .and_then(|h| h.changed_files.lock().ok())
        .map(|f| f.clone())
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let after = engine_api::engine_read_graph(|g| g.clone()).unwrap_or_default();
        let result = run_full_check(&after, &after, &changed_files, &target);
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}
