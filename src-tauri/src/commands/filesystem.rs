// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// File system operations — list, read, write, delete, rename, move.

use std::io::Write;
use base64::Engine;
use hologram_engine::engine as engine_api;
use hologram_engine::pipeline::discovery::is_ignored_path;

#[tauri::command]
pub(crate) async fn list_directory(
    path: String,
    is_agent: Option<bool>,
    filter_ignored: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::utils::DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let filter = filter_ignored.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_recursive(&root, filter))
    })
    .await
    .map_err(|e| format!("目录列表任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_directory_flat(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::utils::DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_flat(&root))
    })
    .await
    .map_err(|e| format!("目录列表任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn read_file_content(
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (_, content) = crate::confined_fs::read_text(&file_path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    Ok(crate::confined_fs::format_lines(&content, offset, limit))
}

#[tauri::command]
pub(crate) fn read_memory_batch(
    paths: Vec<String>,
) -> Result<String, String> {
    let mut map = serde_json::Map::new();
    for path in &paths {
        crate::utils::validate_hologram_path(path)?;
        match std::fs::read_to_string(path) {
            Ok(content) => { map.insert(path.clone(), serde_json::Value::String(content)); }
            Err(_) => { map.insert(path.clone(), serde_json::Value::Null); }
        }
    }
    serde_json::to_string(&map).map_err(|e| format!("序列化失败: {}", e))
}

#[tauri::command]
pub(crate) async fn read_file_base64(
    file_path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (_, bytes) = crate::confined_fs::read_bytes(&file_path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub(crate) async fn write_file_content(
    file_path: String,
    content: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let real_path = crate::confined_fs::write_text(&file_path, &content, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let rp = real_path.to_string_lossy().to_string();

    if let Some(ref handle) = *state.lock().unwrap() {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit(['/', '\\']).next().unwrap_or(&rp);
            let _ = engine_api::engine_record_timeline("agent_write", Some(&rp), &format!("Agent 写入: {}", short));
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }

    let size = content.len();
    let preview = crate::confined_fs::preview(&content, 80, 20);
    Ok(format!(
        "已写入 {} ({})\n```\n{}\n```",
        rp,
        if size < 1024 { format!("{} B", size) } else { format!("{:.1} KB", size as f64 / 1024.0) },
        preview
    ))
}

#[tauri::command]
pub(crate) fn log_append(
    path: String,
    content: String,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(&path), _agent_id.as_deref());
    let physical_str = physical.to_string_lossy().to_string();
    let tool = crate::tools::EditTool { path: physical_str.clone(), agent_id: _agent_id.clone() };
    crate::utils::check_permission_sync(&tool, &ctx)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&physical)
        .map_err(|e| format!("log_append: cannot open {}: {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("log_append: write failed: {}", e))
}

#[tauri::command]
pub(crate) async fn create_directory(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    crate::confined_fs::create_dir(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_global_memory_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/.hologram/global_memory", home.replace("\\", "/"))
}

#[tauri::command]
pub(crate) async fn delete_file_or_dir(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let real = crate::confined_fs::delete(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let rp = real.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *state.lock().unwrap() {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            let _ = engine_api::engine_record_timeline("agent_delete", Some(&rp), &format!("Agent 删除: {}", short));
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn rename_file_or_dir(
    file_path: String,
    new_name: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let is_agent = is_agent.unwrap_or(false);
    let parent = std::path::Path::new(&file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let to = if parent.is_empty() {
        new_name.clone()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), new_name.trim_start_matches('/'))
    };
    let (_, resolved_to) = crate::confined_fs::rename(&file_path, &to, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let rp = resolved_to.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *state.lock().unwrap() {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            let _ = engine_api::engine_record_timeline("agent_rename", Some(&rp), &format!("Agent 重命名: {}", short));
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn move_file(
    from: String,
    to: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let is_agent = is_agent.unwrap_or(false);
    let (_, resolved_to) = crate::confined_fs::rename(&from, &to, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let rp = resolved_to.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *state.lock().unwrap() {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            let _ = engine_api::engine_record_timeline("agent_move", Some(&rp), &format!("Agent 移动: {}", short));
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_in_explorer(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let real = crate::confined_fs::verify_read_path(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    #[cfg(target_os = "windows")]
    {
        if real.is_dir() {
            std::process::Command::new("explorer")
                .arg(&real)
                .spawn()
                .map_err(|e| format!("无法打开资源管理器: {}", e))?;
        } else {
            std::process::Command::new("explorer")
                .args(["/select,", &real.to_string_lossy()])
                .spawn()
                .map_err(|e| format!("无法打开资源管理器: {}", e))?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if real.is_dir() {
            std::process::Command::new("open")
                .arg(&real)
                .spawn()
                .map_err(|e| format!("无法打开访达: {}", e))?;
        } else {
            std::process::Command::new("open")
                .args(["-R", &real.to_string_lossy()])
                .spawn()
                .map_err(|e| format!("无法打开访达: {}", e))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if real.is_dir() { &real } else { real.parent().unwrap_or(&real) };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器: {}", e))?;
    }
    Ok(())
}
