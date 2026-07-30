// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 工作区生命周期 Tauri 命令。

use tauri;

#[tauri::command]
pub(crate) async fn workspace_activate(
    path: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    // 在首次打开项目时初始化结构化日志
    let project_path = std::path::Path::new(&path);
    let _ = crate::utils::LOG_GUARD.get_or_init(|| crate::logging::init_logging(project_path));

    let handle = crate::workspace::WorkspaceHandle::new(&path);
    handle.activate(&crate::utils::project_root());

    *state.lock().unwrap() = Some(handle);
    Ok(())
}

/// 停用当前工作区。停止文件监视器，清除已变更文件。
/// 在切换到新工作区或关闭应用之前调用。
#[tauri::command]
pub(crate) async fn workspace_deactivate(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    // 在短暂持有锁时取出句柄，然后在停用前释放锁。
    // deactivate() 停止监视器；在 state 互斥锁下执行此操作
    // 会在整个停止期间阻塞所有需要 state 的其他命令
    // （workspace_activate、get_full_graph、…）。
    let handle = {
        let mut guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
        guard.take() // take() 同时把 state 内的 Option 置 None
    };
    if let Some(mut h) = handle {
        h.deactivate();
    }
    Ok(())
}

/// 启动活跃工作区的文件监视器。
/// 必须在 workspace_activate 之后调用。
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
