// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Git commands — IDE-level version control (status, diff, stage, commit, push, etc.).

#[tauri::command]
pub(crate) async fn git_status(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let branch_porcelain = crate::utils::run_git(path.clone(), vec![
        "status".to_string(), "--branch".to_string(), "--porcelain".to_string(),
    ]).await.unwrap_or_default();

    let mut branch = String::new();
    let mut ahead = 0i32;
    let mut behind = 0i32;
    let first_line = branch_porcelain.lines().next().unwrap_or("");
    if let Some(header) = first_line.strip_prefix("## ") {
        if let Some(dot_pos) = header.find("...") {
            branch = header[..dot_pos].to_string();
            let rest = &header[dot_pos..];
            for part in rest.split(['[', ']', ',']) {
                let trimmed = part.trim();
                if let Some(num) = trimmed.strip_prefix("ahead ") {
                    ahead = num.parse().unwrap_or(0);
                } else if let Some(num) = trimmed.strip_prefix("behind ") {
                    behind = num.parse().unwrap_or(0);
                }
            }
        } else {
            branch = header.trim().to_string();
        }
    }

    let porcelain = branch_porcelain
        .lines()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n");
    let files = crate::utils::parse_status(&porcelain);

    let result = serde_json::json!({
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "files": files,
    });
    Ok(result.to_string())
}

#[tauri::command]
pub(crate) async fn git_diff_unstaged(
    path: String,
    file: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["diff".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_diff_staged(
    path: String,
    file: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["diff".to_string(), "--cached".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_stage(
    path: String,
    files: Vec<String>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stage", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let mut args: Vec<String> = vec!["add".to_string()];
    args.extend(files.iter().map(|s| s.to_string()));
    crate::utils::run_git(path, args).await
}

#[tauri::command]
pub(crate) async fn git_stage_all(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stage", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["add".to_string(), "-A".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_commit(
    path: String,
    message: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "commit", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["commit".to_string(), "-m".to_string(), message.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_push(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "push", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["push".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_pull(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "pull", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["pull".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_log(
    path: String,
    limit: Option<i32>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let n = limit.unwrap_or(20);
    let raw = crate::utils::run_git(
        path.clone(),
        vec!["log".to_string(), format!("-{}", n), "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ai".to_string()],
    ).await?;
    let commits: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x00').collect();
            if parts.len() >= 5 {
                Some(serde_json::json!({
                    "hash": parts[0],
                    "short": parts[1],
                    "message": parts[2],
                    "author": parts[3],
                    "date": parts[4],
                }))
            } else {
                None
            }
        })
        .collect();
    Ok(serde_json::json!(commits).to_string())
}

#[tauri::command]
pub(crate) async fn git_init(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "init", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["init".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_checkout(
    path: String,
    branch: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "checkout", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), branch.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    path: String,
    name: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "create_branch", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), "-b".to_string(), name.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_push(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stash_push", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "push".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_pop(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stash_pop", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "pop".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_discard(
    path: String,
    file: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "discard", is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_blame(
    path: String,
    file: String,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, _agent_id.as_deref(), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["blame".to_string(), "--line-porcelain".to_string(), file.clone()]).await
}
