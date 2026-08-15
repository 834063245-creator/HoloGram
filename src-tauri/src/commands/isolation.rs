// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Agent 隔离 — 基于 worktree 的沙箱（创建、差异、合并、丢弃、状态、清理）。

use std::path::PathBuf;

use crate::agent_isolation::{AgentIsolation, IsolationKind};

/// diff 溢写阈值 — 超过则落盘 .hologram/spill/，只回传 locator。
/// 远低于 IPC 32KB 截断上限：大 diff 截断即信息丢失，且烧模型上下文。
const DIFF_SPILL_THRESHOLD_CHARS: usize = 8_000;

/// 把超长 diff 写到 .hologram/spill/ 并返回文件路径（spill 目录即创建）。
fn spill_diff_file(project_path: &str, agent_id: &str, diff: &str) -> Result<PathBuf, String> {
    let spill_dir = PathBuf::from(project_path).join(".hologram").join("spill");
    std::fs::create_dir_all(&spill_dir).map_err(|e| format!("spill 目录创建失败: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // agent_id 已在 create_worktree 校验过 slug 格式，无路径穿越风险
    let file_path = spill_dir.join(format!("{agent_id}-{ts}.diff"));
    std::fs::write(&file_path, diff).map_err(|e| format!("diff 落盘失败: {e}"))?;
    Ok(file_path)
}

#[tauri::command]
pub(crate) fn agent_isolation_create(
    agent_id: String,
    state: &crate::WorkspaceState,
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
    state: &crate::WorkspaceState,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation(Some(&agent_id))
        .ok_or("没有活跃的隔离环境")?;

    if isolation.kind == IsolationKind::None {
        return Err("当前未使用工作树隔离".into());
    }

    // 纯只读检查（diff_readonly 从不删除 worktree）。
    // 修复：cleanup() 用 git diff HEAD 判断变更，untracked 新文件不可见 →
    // 子 Agent 只新建文件时误判"无变更"并移除 worktree → 后续 merge 失败。
    // 大 diff 溢写：截断即丢信息 — 落盘 .hologram/spill/ 回传 locator，
    // 模型用 read_file 读全量；落盘失败退回截断（带明确标记，不静默）。
    match isolation.diff_readonly()? {
        crate::agent_isolation::CleanupResult::NoChanges => Ok(
            serde_json::json!({"has_changes": false, "diff": ""}).to_string(),
        ),
        crate::agent_isolation::CleanupResult::HasChanges {
            diff,
            worktree_path,
        } => {
            if diff.chars().count() > DIFF_SPILL_THRESHOLD_CHARS {
                let project_path = crate::utils::workspace_path(&state)?;
                match spill_diff_file(&project_path, &agent_id, &diff) {
                    Ok(file_path) => Ok(serde_json::json!({
                        "has_changes": true,
                        "diff": format!(
                            "[diff 全量落盘] {} — {} 字符，超过 IPC 截断阈值，已溢写到文件",
                            file_path.to_string_lossy(),
                            diff.chars().count()
                        ),
                        "spill_path": file_path.to_string_lossy(),
                        "worktree_path": worktree_path.to_string_lossy(),
                    })
                    .to_string()),
                    Err(e) => {
                        eprintln!("[isolation] diff 溢写失败（退回截断）: {e}");
                        Ok(serde_json::json!({
                            "has_changes": true,
                            "diff": crate::utils::truncate_output(&diff),
                            "spill_error": e,
                            "worktree_path": worktree_path.to_string_lossy(),
                        })
                        .to_string())
                    }
                }
            } else {
                Ok(serde_json::json!({
                    "has_changes": true,
                    "diff": diff,
                    "worktree_path": worktree_path.to_string_lossy(),
                })
                .to_string())
            }
        }
    }
}

#[tauri::command]
pub(crate) fn agent_isolation_merge(
    agent_id: String,
    state: &crate::WorkspaceState,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation(Some(&agent_id))
        .ok_or("没有活跃的隔离环境")?;

    let result = isolation.merge_to_main()?;
    ctx.clear_isolation(&agent_id);
    Ok(result)
}

#[tauri::command]
pub(crate) fn agent_isolation_discard(
    agent_id: String,
    state: &crate::WorkspaceState,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let isolation = ctx
        .get_isolation(Some(&agent_id))
        .ok_or("没有活跃的隔离环境")?;

    // discard 可能失败（目录损坏/缺失）— 始终清除注册表
    match isolation.discard() {
        Ok(()) => {
            ctx.clear_isolation(&agent_id);
            Ok("工作树已丢弃".into())
        }
        Err(e) => {
            ctx.clear_isolation(&agent_id);
            Ok(format!("工作树丢弃遇到错误但 registry 已清除: {e}"))
        }
    }
}

#[tauri::command]
pub(crate) fn agent_isolation_status(
    state: &crate::WorkspaceState,
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
pub(crate) fn agent_isolation_force_purge(
    agent_id: String,
    state: &crate::WorkspaceState,
) -> Result<String, String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let project_path = crate::utils::workspace_path(&state)?;
    let main_path = std::path::PathBuf::from(&project_path);

    // 先尝试正常丢弃（可能成功）
    if let Some(isolation) = ctx.get_isolation(Some(&agent_id)) {
        let _ = isolation.discard();
    }

    // 始终清除注册表条目
    ctx.clear_isolation(&agent_id);

    // 运行 git worktree prune 清理过期元数据
    let _ = crate::agent_isolation::git_cmd()
        .args(["-C", &main_path.to_string_lossy().replace('\\', "/"), "worktree", "prune"])
        .output();

    Ok(format!("agent {} 的隔离记录已强制清除", agent_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    // P1-18 回归：命令函数改为 &WorkspaceState 后可在 spawn_blocking 中调用
    // （tauri::State 非 'static，无法移入阻塞线程——新签名是编译期护栏）
    #[test]
    fn status_without_workspace_errors_not_panics() {
        let ws: crate::WorkspaceState = std::sync::Arc::new(std::sync::Mutex::new(None));
        let r = agent_isolation_status(&ws);
        assert!(r.is_err(), "无工作区必须报错而非 panic");
    }

    #[test]
    fn diff_without_workspace_errors_not_panics() {
        let ws: crate::WorkspaceState = std::sync::Arc::new(std::sync::Mutex::new(None));
        let r = agent_isolation_diff("agent-x".into(), &ws);
        assert!(r.is_err());
    }

    /// spill 回归：大 diff 必须完整落盘、路径含 .hologram/spill、内容无损。
    #[test]
    fn spill_diff_file_writes_full_content() {
        let tmp = std::env::temp_dir().join("hologram_test_spill_diff");
        let _ = std::fs::remove_dir_all(&tmp);
        let project = tmp.join("proj");
        std::fs::create_dir_all(&project).unwrap();

        let diff = "diff-line\n".repeat(2_000); // ~20KB > 8KB 阈值
        let path = spill_diff_file(&project.to_string_lossy(), "agent-test-spill", &diff).unwrap();
        assert!(path.exists(), "spill 文件必须存在");
        assert!(
            path.to_string_lossy().contains(".hologram/spill"),
            "spill 路径必须在 .hologram/spill 下: {}",
            path.to_string_lossy()
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            diff,
            "spill 内容必须与全量 diff 一致（不得截断）"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
