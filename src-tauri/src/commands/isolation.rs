// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Agent isolation — worktree-based sandbox (create, diff, merge, discard, status, prune).

use crate::agent_isolation::{AgentIsolation, IsolationKind};

#[tauri::command]
pub(crate) fn agent_isolation_create(
    agent_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let project_path = crate::utils::workspace_path(&state)?;
    let main_path = std::path::PathBuf::from(&project_path);

    let isolation =
        AgentIsolation::create_worktree(&main_path, &agent_id)?;

    let wt_path = isolation
        .worktree_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let original_head = isolation.original_head.clone();

    {
        let id = agent_id.clone();
        if let Ok(guard) = state.lock() {
            if let Some(ref handle) = *guard {
                handle.permission_ctx.set_isolation(&id, isolation);
                crate::permissions::set_active_agent_id(&id);
            }
        }
    }

    let short_head = &original_head[..8.min(original_head.len())];
    Ok(serde_json::json!({
        "worktree_path": wt_path,
        "agent_id": agent_id,
        "original_head": short_head,
    })
    .to_string())
}

#[tauri::command]
pub(crate) fn agent_isolation_diff(
    agent_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::permissions::set_active_agent_id(&agent_id);
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation()
        .ok_or("没有活跃的隔离环境")?;

    if isolation.kind == IsolationKind::None {
        return Err("当前未使用工作树隔离".into());
    }

    match isolation.cleanup()? {
        crate::agent_isolation::CleanupResult::NoChanges => Ok(
            serde_json::json!({"has_changes": false, "diff": ""}).to_string(),
        ),
        crate::agent_isolation::CleanupResult::HasChanges {
            diff,
            worktree_path,
        } => Ok(serde_json::json!({
            "has_changes": true,
            "diff": diff,
            "worktree_path": worktree_path.to_string_lossy(),
        })
        .to_string()),
    }
}

#[tauri::command]
pub(crate) fn agent_isolation_merge(
    agent_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::permissions::set_active_agent_id(&agent_id);
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation()
        .ok_or("没有活跃的隔离环境")?;

    let result = isolation.merge_to_main()?;
    ctx.clear_isolation(&agent_id);
    crate::permissions::clear_active_agent_id();
    Ok(result)
}

#[tauri::command]
pub(crate) fn agent_isolation_discard(
    agent_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::permissions::set_active_agent_id(&agent_id);
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation()
        .ok_or("没有活跃的隔离环境")?;

    // discard may fail (corrupted/missing directory) — always clear registry
    match isolation.discard() {
        Ok(()) => {
            ctx.clear_isolation(&agent_id);
            crate::permissions::clear_active_agent_id();
            Ok("工作树已丢弃".into())
        }
        Err(e) => {
            ctx.clear_isolation(&agent_id);
            crate::permissions::clear_active_agent_id();
            Ok(format!("工作树丢弃遇到错误但 registry 已清除: {e}"))
        }
    }
}

#[tauri::command]
pub(crate) fn agent_isolation_status(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let entries = ctx.list_isolations();
    let isolations: Vec<serde_json::Value> = entries
        .iter()
        .map(|(id, iso)| {
            let worktree_exists = iso.worktree_path
                .as_ref()
                .map(|p| p.exists())
                .unwrap_or(false);
            serde_json::json!({
                "agent_id": id,
                "kind": if iso.kind == IsolationKind::Worktree { "worktree" } else { "none" },
                "worktree_path": iso.worktree_path.as_ref().map(|p| p.to_string_lossy().to_string()),
                "worktree_exists": worktree_exists,
                "stale": !worktree_exists,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "isolations": isolations,
        "count": isolations.len(),
    }).to_string())
}

#[tauri::command]
pub(crate) fn agent_isolation_prune(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let project_path = crate::utils::workspace_path(&state)?;
    let main_path = std::path::PathBuf::from(&project_path);
    match crate::agent_isolation::prune_stale_worktrees(&main_path, 30) {
        Ok(0) => Ok(serde_json::json!({"pruned": 0}).to_string()),
        Ok(n) => Ok(serde_json::json!({"pruned": n}).to_string()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) fn agent_isolation_force_purge(
    agent_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let project_path = crate::utils::workspace_path(&state)?;
    let main_path = std::path::PathBuf::from(&project_path);

    // Try normal discard first (may succeed)
    if let Some(isolation) = ctx.get_isolation() {
        let _ = isolation.discard();
    }

    // Always clear registry entry
    ctx.clear_isolation(&agent_id);
    crate::permissions::clear_active_agent_id();

    // Run git worktree prune to clean stale metadata
    let _ = crate::agent_isolation::git_cmd()
        .args(["-C", &main_path.to_string_lossy().replace('\\', "/"), "worktree", "prune"])
        .output();

    Ok(format!("agent {} 的隔离记录已强制清除", agent_id))
}
