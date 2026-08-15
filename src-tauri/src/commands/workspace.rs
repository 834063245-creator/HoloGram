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

    // 孤儿 worktree 收养（2026-08-15 收口）：isolation 注册表是内存态，
    // 重启后 .hologram/worktrees/ 里未合并的 worktree 会变成无法
    // diff/merge/discard 的死账。启动时扫描并重建记录，前端再把它
    // 重挂到新主 Agent 的 TaskBoard，agent_merge 即恢复可用。
    let adopted = crate::agent_isolation::AgentIsolation::scan_orphan_worktrees(std::path::Path::new(&path));
    for (slug, wt_path) in &adopted {
        match crate::agent_isolation::AgentIsolation::adopt_worktree(std::path::Path::new(&path), wt_path) {
            Ok(iso) => handle.permission_ctx.set_isolation(slug, iso),
            Err(e) => eprintln!("[isolation] 孤儿 worktree 收养失败 {slug}: {e}"),
        }
    }
    if !adopted.is_empty() {
        eprintln!("[isolation] 收养 {} 个重启前遗留的孤儿 worktree", adopted.len());
    }

    *crate::utils::lock_or_recover(&state) = Some(handle);
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
        // ⚡ 2026-08-04 状态治理：workspace 切换时清理进程池全局，
        // 防止旧项目的 LSP / PTY / 后台任务 / 引擎(MCP) 跨 workspace 串场或泄漏。
        // - LSP/PTY/MCP 绑项目根，切走必须停；
        // - 后台 shell 任务（BG_JOBS）kill_tree 防 cargo/rustc 孙进程占锁。
        crate::utils::kill_all_bg();
        crate::pty_manager::kill_all();
        crate::lsp_manager::stop_all();
        crate::commands::external::stop_mcp();
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
    if let Some(ref mut handle) = *crate::utils::lock_or_recover(&state) {
        handle.start_watcher(app);
        Ok(())
    } else {
        Err("没有活跃的工作区".into())
    }
}
