// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 图谱加载、分析、后台分析和引擎查询命令。

use tauri::Manager;

#[tauri::command]
pub(crate) async fn load_graph_json(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    // P0-2 分页化（landmine-map.md 雷 2）：冷启动优先返回引擎图 meta + 分页信息，
    // 不再一次性回传全量 JSON（大仓库 267MB 级会击穿 128MB IPC 护栏）。
    // 磁盘 hologram_graph.json 仅作无引擎缓存时的兜底（小图兼容旧路径）。
    let mut candidate: Option<String> = None;
    if let Some(ref p) = path {
        candidate = Some(p.clone());
    } else if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        candidate = Some(handle.path.clone());
    }
    let root: Option<String> = match candidate {
        Some(r) => Some(r),
        None => {
            let last_path_file = crate::utils::project_root().join(".last_project");
            std::fs::read_to_string(&last_path_file)
                .ok()
                .map(|s| s.trim().to_string())
        }
    };
    if let Some(root) = root {
        if root.contains("..") || root.contains('\0') {
            return Err("路径包含非法字符".into());
        }
        // 引擎图（内存/SQLite 缓存）优先 — ensure_engine_graph 只加载缓存不分析。
        if let Ok(()) = crate::utils::ensure_engine_graph(&root) {
            // 冷启动新鲜度门禁（2026-08-18 修复）：SQLite 缓存可能过期
            // （源文件在上次分析后被修改）。过期时不阻断渲染，但必须留痕，
            // 由前端紧随其后的 analyze_and_load(force=false) 触发重分析，
            // graph-updated 事件随后把 UI 换到最新图。
            if crate::utils::cache_is_stale(std::path::Path::new(&root)) {
                eprintln!(
                    "[hologram] ⚠ 冷启动：SQLite 缓存的图已过期（源文件在上次分析后被修改），将触发重新分析"
                );
            }
            return crate::utils::graph_meta_json(
                &root,
                crate::utils::GRAPH_PAGE_DEFAULT_NODES,
            );
        }
        // 磁盘兜底：小图走旧路径全量返回；大文件（>64MB）不白读，直接放弃。
        let p = std::path::PathBuf::from(&root).join("hologram_graph.json");
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() <= 64 * 1024 * 1024 {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    if !content.trim().is_empty() {
                        return crate::utils::guard_ipc_size(content, "Graph JSON");
                    }
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

    // P0-2 分页化：只回 meta + 分页信息，全量图由 get_graph_page 逐页拉取。
    let path_clone = path.clone();
    let meta = tokio::task::spawn_blocking(move || crate::utils::graph_meta_json(&path_clone, crate::utils::GRAPH_PAGE_DEFAULT_NODES))
        .await
        .map_err(|e| format!("序列化任务失败: {e}"))??;
    Ok(meta)
}

/// 当前工作区图的 meta + 分页信息（重新分析/事件兜底时获取新图分页信息）。
#[tauri::command]
pub(crate) async fn get_graph_meta(state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    let root_c = root.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::ensure_engine_graph(&root_c)?;
        crate::utils::graph_meta_json(&root_c, crate::utils::GRAPH_PAGE_DEFAULT_NODES)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 分页拉取当前工作区图的第 page 页（0 基）。
/// 边只含 max(两端点页号) == page 的边（增量下发，每边恰好一次）；最后一页附带社区数据。
#[tauri::command]
pub(crate) async fn get_graph_page(
    page: usize,
    page_size: Option<usize>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    let size = page_size.unwrap_or(crate::utils::GRAPH_PAGE_DEFAULT_NODES).clamp(500, 60_000);
    let root_c = root.clone();
    let serialized = tokio::task::spawn_blocking(move || {
        crate::utils::ensure_engine_graph(&root_c)?;
        crate::utils::serialize_graph_page(&root_c, page, size)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    crate::utils::guard_ipc_size(serialized, "图谱分页")
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
