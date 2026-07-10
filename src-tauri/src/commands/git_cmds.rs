// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Git commands — IDE-level version control (status, diff, stage, commit, push, etc.).


#[tauri::command]
pub(crate) async fn git_tree_status(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), &state, &app).await?;
    let porcelain = crate::utils::run_git(path, vec![
        "status".to_string(), "--porcelain".to_string(),
        "--ignored".to_string(), "--untracked-files".to_string(),
    ]).await.unwrap_or_default();

    let mut result = serde_json::Map::new();
    for line in porcelain.lines() {
        if line.len() < 4 { continue; }
        let st = &line[..2];
        let file_path = line[3..].trim();
        let file_path = if let Some(idx) = file_path.find(" -> ") {
            &file_path[idx + 4..]
        } else {
            file_path
        };
        let status = if st == "!!" {
            "ignored"
        } else if st == "??" {
            "untracked"
        } else if st.contains('D') {
            "deleted"
        } else if st.contains('A') {
            "added"
        } else if st.contains('R') {
            "renamed"
        } else if st.contains('M') {
            "modified"
        } else {
            "modified"
        };
        result.insert(file_path.to_string(), serde_json::json!(status));
        let parts: Vec<&str> = file_path.split('/').collect();
        for i in 1..parts.len() {
            let dir = parts[..i].join("/");
            result.entry(dir).or_insert(serde_json::json!("modified-dir"));
        }
    }
    Ok(serde_json::json!(result).to_string())
}

#[tauri::command]
pub(crate) async fn git_status(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), &state, &app).await?;
    let branch_porcelain = crate::utils::run_git(path.clone(), vec![
        "status".to_string(), "--branch".to_string(), "--porcelain".to_string(),
    ]).await.unwrap_or_default();

    let mut branch = String::new();
    let mut ahead = 0i32;
    let mut behind = 0i32;
    let first_line = branch_porcelain.lines().next().unwrap_or("");
    if first_line.starts_with("## ") {
        let header = &first_line[3..];
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
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["diff".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_diff_staged(
    path: String,
    file: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["diff".to_string(), "--cached".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_stage(
    path: String,
    files: Vec<String>,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stage", is_agent.unwrap_or(false), &state, &app).await?;
    let mut args: Vec<String> = vec!["add".to_string()];
    args.extend(files.iter().map(|s| s.to_string()));
    crate::utils::run_git(path, args).await
}

#[tauri::command]
pub(crate) async fn git_unstage(
    path: String,
    files: Vec<String>,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "unstage", is_agent.unwrap_or(false), &state, &app).await?;
    let mut args: Vec<String> = vec!["reset".to_string(), "HEAD".to_string(), "--".to_string()];
    args.extend(files.iter().map(|s| s.to_string()));
    crate::utils::run_git(path, args).await
}

#[tauri::command]
pub(crate) async fn git_stage_all(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stage", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["add".to_string(), "-A".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_commit(
    path: String,
    message: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "commit", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["commit".to_string(), "-m".to_string(), message.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_push(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "push", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["push".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_pull(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "pull", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["pull".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_fetch(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "fetch", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["fetch".to_string(), "--all".to_string(), "--prune".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_log(
    path: String,
    limit: Option<i32>,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), &state, &app).await?;
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
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "init", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["init".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_list_branches(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), &state, &app).await?;
    let out = crate::utils::run_git(path.clone(), vec!["branch".to_string(), "--format=%(refname:short)".to_string()]).await?;
    let branches: Vec<&str> = out.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let current_out = crate::utils::run_git(path.clone(), vec!["branch".to_string(), "--show-current".to_string()]).await?;
    let current = current_out.trim().to_string();
    serde_json::to_string(&serde_json::json!({ "branches": branches, "current": current }))
        .map_err(|e| format!("JSON 序列化失败: {}", e))
}

#[tauri::command]
pub(crate) async fn git_checkout(
    path: String,
    branch: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "checkout", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), branch.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    path: String,
    name: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "create_branch", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), "-b".to_string(), name.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_push(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stash_push", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "push".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_pop(
    path: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "stash_pop", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "pop".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_stash_list(
    path: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["stash".to_string(), "list".to_string()]).await
}

#[tauri::command]
pub(crate) async fn git_discard(
    path: String,
    file: String,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_git_dispatch(&path, "discard", is_agent.unwrap_or(false), &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["checkout".to_string(), "--".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_blame(
    path: String,
    file: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["blame".to_string(), "--line-porcelain".to_string(), file.clone()]).await
}

#[tauri::command]
pub(crate) async fn git_file_at_head(
    path: String,
    file: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    crate::utils::run_git(path.clone(), vec!["show".to_string(), format!("HEAD:{}", file.clone())]).await
}

#[tauri::command]
pub(crate) async fn git_show(
    path: String,
    commit: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::utils::require_read(&path, &state, &app).await?;
    let output = crate::utils::run_git(path.clone(), vec!["show".to_string(), "--name-only".to_string(), "--format=".to_string(), commit.clone()]).await?;
    let files: Vec<&str> = output.lines().filter(|l| !l.is_empty()).collect();
    serde_json::to_string(&files).map_err(|e| e.to_string())
}
