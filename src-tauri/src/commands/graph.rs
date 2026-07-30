// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 图谱加载、分析、后台分析和引擎查询命令。

use tauri::{Emitter, Manager};
use hologram_engine::analysis::graph_summary;
use hologram_engine::graph::query;
use hologram_engine::engine as engine_api;

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
        return Ok(content);
    }

    if let Some(ref handle) = *state.lock().unwrap() {
        let p = std::path::PathBuf::from(&handle.path).join("hologram_graph.json");
        if let Ok(content) = std::fs::read_to_string(&p) {
            if !content.trim().is_empty() {
                return Ok(content);
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
                    return Ok(content);
                }
            }
        }
    }

    Err("No cached graph found".into())
}

#[tauri::command]
pub(crate) async fn load_binary_graph(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<Vec<u8>, String> {
    if let Some(ref p) = path {
        if p.contains("..") || p.contains('\0') {
            return Err("路径包含非法字符".into());
        }
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

    fn holo_fresh(holo_path: &std::path::Path) -> bool {
        let json_path = holo_path.to_string_lossy().replace(".hologram", ".json");
        if let (Ok(h_meta), Ok(j_meta)) = (std::fs::metadata(holo_path), std::fs::metadata(&json_path)) {
            if let (Ok(h_time), Ok(j_time)) = (h_meta.modified(), j_meta.modified()) {
                return h_time >= j_time;
            }
        }
        false
    }

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
    Ok(serialized)
}

#[tauri::command]
pub(crate) async fn analyze_in_background(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let app2 = app.clone();
    let path2 = path.clone();
    // 在分析前快照当前图谱，以便计算增量更新的差异。
    let before = engine_api::engine_read_graph(|g| g.clone()).ok();
    std::thread::spawn(move || {
        match crate::utils::direct_analyze(&path2, true) {
            Ok(_) => {
                let _ = std::fs::write(crate::utils::project_root().join(".last_project"), &path2);
                let diff = crate::workspace::compute_watcher_diff(before.as_ref());
                let (nc, ec) = engine_api::engine_read(|idx| (idx.node_count(), idx.edge_count())).unwrap_or((0, 0));
                let mut summary = serde_json::json!({
                    "path": path2,
                    "total_nodes": nc,
                    "node_count": nc,
                    "edge_count": ec,
                });
                if let Some(d) = diff {
                    summary["diff"] = d;
                }
                let _ = app2.emit("analysis-complete", summary.to_string());
            }
            Err(e) => {
                let _ = app2.emit("analysis-failed", serde_json::json!({"path": path2, "error": e}));
            }
        }
    });
    Ok(serde_json::json!({"job_id": 1, "status": "started"}).to_string())
}

// ═══════════════════════════════════════════════════════
// 引擎图谱查询命令
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn engine_get_graph() -> Result<String, String> {
    crate::utils::with_graph(graph_summary)
}

#[tauri::command]
pub(crate) fn engine_neighbors(node_id: String, depth: usize) -> Result<String, String> {
    let depth_u8 = crate::utils::clamp_depth(depth);
    crate::utils::with_index(move |idx| {
        let nb = idx.neighbors(&node_id, depth_u8, None);
        serde_json::json!({"neighbors": nb.iter().map(|(s,t,d)| serde_json::json!([s,t,d])).collect::<Vec<_>>()})
    })
}

#[tauri::command]
pub(crate) fn engine_path(from_id: String, to_id: String) -> Result<String, String> {
    crate::utils::with_index(move |idx| {
        match idx.shortest_path(&from_id, &to_id) {
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
    crate::utils::with_index(move |idx| {
        let layers = idx.impact(&node_id, max_depth);
        serde_json::json!({"layers": layers})
    })
}