// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Code editor: edit_file + build_edit_snippet.

use hologram_engine::engine as engine_api;
use hologram_engine::pipeline::discovery::is_ignored_path;

#[tauri::command]
pub(crate) async fn edit_file(
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let is_agent = is_agent.unwrap_or(false);
    let (_, content) = crate::confined_fs::read_text(&file_path, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let resolved = crate::utils::resolve_write_dispatch(&file_path, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let file_path = resolved.to_string_lossy().to_string();

    let replace_all = replace_all.unwrap_or(false);
    let count = if replace_all {
        content.matches(&old_string).count()
    } else {
        if old_string.is_empty() {
            return Err("old_string 不能为空".to_string());
        }
        let c = content.matches(&old_string).count();
        if c == 0 {
            // Whitespace-tolerant: match line-by-line after trimming each line.
            let old_lines: Vec<&str> = old_string.lines().collect();
            if !old_lines.is_empty() {
                let file_lines: Vec<&str> = content.lines().collect();
                let first_trimmed = old_lines[0].trim();
                for start in 0..file_lines.len() {
                    if file_lines[start].trim() != first_trimmed { continue; }
                    let mut matched = true;
                    for k in 1..old_lines.len() {
                        if start + k >= file_lines.len()
                            || file_lines[start + k].trim() != old_lines[k].trim()
                        { matched = false; break; }
                    }
                    if matched && start + old_lines.len() <= file_lines.len() {
                        let prefix = file_lines[start]
                            .chars().take_while(|c| c.is_whitespace()).collect::<String>();
                        let new_ls: Vec<&str> = new_string.lines().collect();
                        let mut out = String::new();
                        for l in &file_lines[..start] { out.push_str(l); out.push('\n'); }
                        for (k, nl) in new_ls.iter().enumerate() {
                            if k == 0 { out.push_str(&prefix); }
                            out.push_str(nl); out.push('\n');
                        }
                        for l in &file_lines[start + old_lines.len()..] {
                            out.push_str(l); out.push('\n');
                        }
                        let trimmed = out.trim_end_matches('\n').to_string();
                        crate::utils::write_atomic(&file_path, &trimmed)?;
                        if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
                            if !is_ignored_path(&file_path) {
                                let short = file_path.rsplit(['/', '\\']).next().unwrap_or(&file_path);
                                let _ = engine_api::engine_record_timeline("agent_edit", Some(file_path.as_str()), &format!("Agent 编辑: {}", short));
                                if let Ok(mut changed) = handle.changed_files.lock() {
                                    if !changed.contains(&file_path) { changed.push(file_path.clone()); }
                                }
                            }
                        }
                        let match_line = start + 1;
                        let ctx_start = start.saturating_sub(3);
                        let ctx_end = (start + old_lines.len() + 3).min(file_lines.len());
                        let mut ds = String::new();
                        for i in ctx_start..start {
                            if i < file_lines.len() { ds.push_str(&format!("  {}\n", file_lines[i])); }
                        }
                        for ol in &old_lines { ds.push_str(&format!("- {}\n", ol)); }
                        for (k, nl) in new_ls.iter().enumerate() {
                            ds.push_str(&format!("+ {}{}\n", if k == 0 { &prefix } else { "" }, nl));
                        }
                        for i in (start + old_lines.len())..ctx_end {
                            if i < file_lines.len() { ds.push_str(&format!("  {}\n", file_lines[i])); }
                        }
                        let ds = ds.trim_end().to_string();
                        return Ok(format!(
                            "已替换 1 处匹配（容错模式：逐行对齐）— {} (第 {} 行附近)\n```diff\n{}\n```",
                            file_path, match_line, ds
                        ));
                    }
                    break;
                }
            }
            let first_line = old_string.lines().next().unwrap_or("(empty)");
            let best = crate::utils::fuzzy_find(&content, first_line);
            let hint = match best {
                Some((ln, ctx)) => format!("line {}: {}", ln, ctx),
                None => format!("file starts: {}",
                    content.lines().take(3).collect::<Vec<_>>().join(" | ")),
            };
            let key = if first_line.len() > 60 { &first_line[..60] } else { first_line };
            return Err(format!("not found: \"{}\" | {}", key, hint));
        }
        if c > 1 {
            return Err(format!(
                "old_string 在文件中出现了 {} 次，不是唯一的。请添加更多上下文使其唯一，或设置 replace_all: true。",
                c
            ));
        }
        c
    };

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    crate::utils::write_atomic(&file_path, &new_content)?;

    if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        if !is_ignored_path(&file_path) {
            let short = file_path.rsplit(['/', '\\']).next().unwrap_or(&file_path);
            let _ = engine_api::engine_record_timeline("agent_edit", Some(file_path.as_str()), &format!("Agent 编辑: {}", short));
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&file_path) { changed.push(file_path.clone()); }
            }
        }
    }

    let first_match_line = content.lines()
        .enumerate()
        .find(|(_, l)| l.contains(old_string.lines().next().unwrap_or("")))
        .map(|(i, _)| i + 1)
        .unwrap_or(0);
    let line_info = if first_match_line > 0 {
        format!(" (第 {} 行附近)", first_match_line)
    } else {
        String::new()
    };

    let diff_snippet = build_edit_snippet(&content, &old_string, &new_string, first_match_line);

    Ok(if replace_all {
        format!(
            "已替换 {} 处匹配 — {}{}\n```diff\n{}\n```",
            count, file_path, line_info, diff_snippet
        )
    } else {
        format!(
            "已替换 1 处匹配 — {}{}\n```diff\n{}\n```",
            file_path, line_info, diff_snippet
        )
    })
}

fn build_edit_snippet(content: &str, old: &str, new: &str, match_line: usize) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let ctx_start = match_line.saturating_sub(4);
    let ctx_end = (match_line + old.lines().count() + 3).min(lines.len());

    let mut out = String::new();
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    for i in ctx_start..match_line.saturating_sub(1) {
        if i < lines.len() { out.push_str(&format!("  {}\n", lines[i])); }
    }
    for ol in &old_lines {
        out.push_str(&format!("- {}\n", ol));
    }
    for nl in &new_lines {
        out.push_str(&format!("+ {}\n", nl));
    }
    let after_start = match_line.saturating_sub(1) + old_lines.len();
    for i in after_start..ctx_end {
        if i < lines.len() { out.push_str(&format!("  {}\n", lines[i])); }
    }
    out.trim_end().to_string()
}