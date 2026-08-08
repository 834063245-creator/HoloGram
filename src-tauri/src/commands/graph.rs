// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 图谱加载、分析、后台分析和引擎查询命令。

use tauri::Manager;

#[tauri::command]
pub(crate) async fn load_graph_json(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    if let Some(ref p) = path {
        if p.contains("..") || p.contains('\0') {
            return Err("路径包含非法字符".into());
        }
        let content = std::fs::read_to_string(p)
            .map_err(|e| format!("Graph JSON not found at {}: {}", p, e))?;
        if content.trim().is_empty() {
            return Err(format!("Graph JSON file is empty: {}", p));
        }
        return crate::utils::guard_ipc_size(content, "Graph JSON");
    }

    if let Some(ref handle) = *state.lock().unwrap() {
        let p = std::path::PathBuf::from(&handle.path).join("hologram_graph.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if !content.trim().is_empty() {
                return crate::utils::guard_ipc_size(content, "Graph JSON");
            }
        }
    }

    let last_path_file = crate::utils::project_root().join(".last_project");
    if let Ok(last_path) = std::fs::read_to_string(&last_path_file) {
        let trim = last_path.trim();
        if !trim.is_empty() {
            let p = std::path::PathBuf::from(trim).join("hologram_graph.json");
            if let Ok(content) = std::fs::read_to_string(&p) {
                if !content.trim().is_empty() {
                    return crate::utils::guard_ipc_size(content, "Graph JSON");
                }
            }
        }
    }

    Err("No cached graph found".into())
}

#[tauri::command]
pub(crate) async fn analyze_and_load(path: String, force: Option<bool>, app: tauri::AppHandle) -> Result<String, String> {
    let force = force.unwrap_or(false);
    let _ = std::fs::write(crate::utils::project_root().join(".last_project"), &path);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站 — 分析中...");
    }

    let analyze_future = crate::utils::run_analyze_with_progress(path.clone(), app.clone(), force);
    analyze_future.await.map_err(|e| format!("Rust 引擎分析失败: {e}"))?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("全息观测站");
    }

    let files_path = format!("{}/hologram_graph_files.json", path);
    if !std::path::Path::new(&files_path).exists() {
        let _ = crate::utils::regenerate_file_graph(&path);
    }

    let path_clone = path.clone();
    let serialized = tokio::task::spawn_blocking(move || crate::utils::serialize_cached_graph(&path_clone))
        .await
        .map_err(|e| format!("序列化任务失败: {e}"))??;
    crate::utils::guard_ipc_size(serialized, "序列化图")
}

// ═══════════════════════════════════════════════════════
// 引擎图谱查询命令
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn engine_impact(node_id: String, max_depth: usize) -> Result<String, String> {
    crate::utils::with_index(move |idx| {
        let layers = idx.impact(&node_id, max_depth);
        serde_json::json!({"layers": layers})
    })
}