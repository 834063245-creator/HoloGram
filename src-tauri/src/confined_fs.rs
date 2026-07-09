// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Confined file I/O — unified wrapper that enforces permission checks before
// every file read/write. Replaces bare std::fs calls in tools.rs so new tools
// can't forget security checks. The wrapper is the single door every file op
// passes through; no tool command calls std::fs directly.
//
// ponytail: this exists because the security audit found read_file_content /
// write_file_content / edit_file all do resolve_*_dispatch then std::fs
// separately — each command had to remember both steps. Now they can't forget.

use std::path::PathBuf;
use tauri::AppHandle;

use crate::WorkspaceState;

// ═══════════════════════════════════════════════════════════════
// Read operations — permission check + I/O in one call
// ═══════════════════════════════════════════════════════════════

/// Read a text file. Path resolution + sandbox + safety + deny rules + I/O.
pub(crate) async fn read_text(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, state, app).await?;
    let content = std::fs::read_to_string(&real_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    Ok((real_path, content))
}

/// Read a binary file. Same pipe as read_text but returns Vec<u8>.
pub(crate) async fn read_bytes(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, Vec<u8>), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, state, app).await?;
    let bytes = std::fs::read(&real_path)
        .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    Ok((real_path, bytes))
}

/// Only resolve and verify a read path — no I/O. Use when the resolved path is
/// needed for downstream logic (e.g. git commands, explorer open).
pub(crate) async fn verify_read_path(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    crate::utils::resolve_read_dispatch(file_path, is_agent, state, app).await
}

// ═══════════════════════════════════════════════════════════════
// Write operations — permission check + I/O in one call
// ═══════════════════════════════════════════════════════════════

/// Write a file atomically (temp file → rename). Creates parent dirs if needed.
pub(crate) async fn write_text(
    file_path: &str,
    content: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let real_path = crate::utils::resolve_write_dispatch(file_path, is_agent, state, app).await?;
    let rp = real_path.to_string_lossy().to_string();
    if let Some(parent) = real_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    crate::utils::write_atomic(&rp, content)?;
    Ok(real_path)
}

/// Create a directory (and all parents).
pub(crate) async fn create_dir(
    path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let resolved = crate::utils::resolve_write_dispatch(path, is_agent, state, app).await?;
    std::fs::create_dir_all(&resolved)
        .map_err(|e| format!("无法创建目录 {}: {}", path, e))?;
    Ok(resolved)
}

/// Delete a file or directory tree.
pub(crate) async fn delete(
    path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let real = crate::utils::resolve_write_dispatch(path, is_agent, state, app).await?;
    if !real.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if real.is_dir() {
        std::fs::remove_dir_all(&real)
            .map_err(|e| format!("无法删除目录 {}: {}", path, e))?;
    } else {
        std::fs::remove_file(&real)
            .map_err(|e| format!("无法删除文件 {}: {}", path, e))?;
    }
    Ok(real)
}

/// Rename/move a file or directory. Both `from` and `to` pass through write
/// permission checks, and `from` additionally passes read check (spec §4.7).
pub(crate) async fn rename(
    from: &str,
    to: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    let resolved_from = crate::utils::resolve_read_dispatch(from, is_agent, state, app).await?;
    let resolved_to = crate::utils::resolve_write_dispatch(to, is_agent, state, app).await?;
    std::fs::rename(&resolved_from, &resolved_to)
        .map_err(|e| format!("无法重命名 {} -> {}: {}", from, to, e))?;
    Ok((resolved_from, resolved_to))
}

/// Move a file into a target directory. Source gets read check, dest directory
/// gets write check. Returns (source_path, dest_path).
pub(crate) async fn move_into_dir(
    source: &str,
    dest_dir: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    let src_real = crate::utils::resolve_read_dispatch(source, is_agent, state, app).await?;
    let dest_real = crate::utils::resolve_write_dispatch(dest_dir, is_agent, state, app).await?;
    let name = src_real
        .file_name()
        .ok_or_else(|| format!("无效路径: {}", source))?;
    let dest = dest_real.join(name);
    std::fs::rename(&src_real, &dest)
        .map_err(|e| format!("无法移动 {} -> {}: {}", source, dest.display(), e))?;
    Ok((src_real, dest))
}

// ═══════════════════════════════════════════════════════════════
// Presentation helpers — formatting, not I/O
// ═══════════════════════════════════════════════════════════════

/// Format content as cat -n style numbered lines with offset/limit.
pub(crate) fn format_lines(
    content: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(0).min(lines.len());
    let end = limit
        .map(|l| (start + l).min(lines.len()))
        .unwrap_or(lines.len());
    let numbered: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{:>6}\t{}", start + i + 1, l))
        .collect();
    numbered.join("\n")
}

/// Preview the first `max_lines` of content, truncating each line to `max_width` chars.
pub(crate) fn preview(content: &str, max_width: usize, max_lines: usize) -> String {
    content
        .lines()
        .take(max_lines)
        .map(|l| {
            if l.len() <= max_width {
                l.to_string()
            } else {
                let truncated: String = l.chars().take(max_width).collect();
                format!("{}…", truncated)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ═══════════════════════════════════════════════════════════════
// Tests — moved from tools.rs where preview_content used to live
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_ascii_short_lines_passthrough() {
        let input = "hello\nworld\nfoo bar baz";
        let out = preview(input, 80, 20);
        assert_eq!(out, input);
    }

    #[test]
    fn preview_truncates_long_ascii_line() {
        let input = "a".repeat(100);
        let out = preview(&input, 80, 20);
        assert!(out.ends_with('\u{2026}'), "should end with ellipsis: {out:?}");
        assert_eq!(out.chars().count(), 81); // 80 chars + U+2026 (3 bytes)
    }

    #[test]
    fn preview_does_not_panic_on_multibyte_utf8() {
        let input = "x".repeat(79) + "\u{7ed9}\u{4e2d}\u{6587}\u{5185}\u{5bb9}\u{6d4b}\u{8bd5}";
        let out = preview(&input, 80, 20);
        assert!(out.ends_with('\u{2026}'), "should truncate safely at char boundary: {out:?}");
    }

    #[test]
    fn preview_all_cjk_line_truncated() {
        let input = "\u{4e2d}".repeat(100);
        let out = preview(&input, 80, 20);
        assert!(out.ends_with('\u{2026}'), "should truncate CJK-only line: {out:?}");
        assert_eq!(out.chars().count(), 81);
    }

    #[test]
    fn preview_respects_max_lines() {
        let input = "a\nb\nc\nd\ne\nf";
        let out = preview(input, 80, 2);
        assert_eq!(out.lines().count(), 2);
    }
}
