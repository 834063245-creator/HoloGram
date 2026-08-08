// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Hologram 图谱查询与分析 Tauri 命令。

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
    let serialized = tokio::task::spawn_blocking(move || crate::utils::serialize_cached_graph(&source_root))
        .await.map_err(|e| format!("任务失败: {e}"))??;
    crate::utils::guard_ipc_size(serialized, "序列化图")
}


#[tauri::command]
pub(crate) async fn hologram_run_check(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_run_check", &state)?;
    // 默认 target = 当前工作区根（而非应用安装目录 project_root()），理由同 exec_command。
    let target = match path {
        Some(p) => p,
        None => crate::utils::workspace_path(&state)?,
    };
    // 在派生阻塞任务前提取并清除 changed_files。
    // 提前清除可防止检查期间新变更到达时的竞态。
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
        // 优先使用内存/SQLite 缓存；仅在真正为空时才运行完整分析。
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

        // 始终推进基线 — 下次检查将与此快照进行差异比较。
        save_baseline(&root, &after);

        // 将有意义的检查记录到时间轴（跳过静默的项目打开轮询）。
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
/// 在统一时间轴 (hologram.db) 中记录面向用户的事件。
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
// （2026-08-04 清理：hologram_hotspots / hologram_gate_check 前端零调用，已删）
// ═══════════════════════════════════════════════════════

