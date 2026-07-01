// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Workspace lifecycle Tauri commands.

use tauri;
use crate::utils;
use crate::WorkspaceState;

#[tauri::command]
pub(crate) async fn workspace_activate(
    path: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    // Init structured logging on first project open
    let project_path = std::path::Path::new(&path);
    let _ = crate::utils::LOG_GUARD.get_or_init(|| crate::logging::init_logging(project_path));

    let handle = crate::workspace::WorkspaceHandle::new(&path);
    handle.activate(&crate::utils::project_root());

    *state.lock().unwrap() = Some(handle);
    Ok(())
}

/// Deactivate the current workspace. Stops the file watcher, clears changed files.
/// Called before switching to a new workspace or closing the app.
#[tauri::command]
pub(crate) async fn workspace_deactivate(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    // Take the handle out while briefly holding the lock, then RELEASE the
    // lock before deactivating. deactivate() stops the watcher; doing that
    // under the state mutex blocks every other command that needs state
    // (workspace_activate, get_full_graph, …) for the whole stop duration.
    let handle = {
        let mut guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
        guard.take() // take() 同时把 state 内的 Option 置 None
    };
    if let Some(mut h) = handle {
        h.deactivate();
    }
    Ok(())
}

/// Start the file watcher for the active workspace.
/// Must be called after workspace_activate.
#[tauri::command]
pub(crate) async fn workspace_start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    if let Some(ref mut handle) = *state.lock().unwrap() {
        handle.start_watcher(app);
        Ok(())
    } else {
        Err("没有活跃的工作区".into())
    }
}
