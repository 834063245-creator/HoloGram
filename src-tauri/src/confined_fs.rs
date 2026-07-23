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

use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

use crate::WorkspaceState;

// ═══════════════════════════════════════════════════════════════
// Guards — file size limits, read timeout, retry budget
// ═══════════════════════════════════════════════════════════════

/// Maximum file size for reads (100 MiB). Prevents OOM from reading huge files.
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;

/// Maximum content size for writes (100 MiB).
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;

/// Read timeout — a stuck NFS mount must not hang the agent.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Number of retries for transient I/O errors (Interrupted, TimedOut, WouldBlock).
const IO_RETRY_COUNT: u32 = 3;

/// Delay between retries, doubles each attempt.
const IO_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);

// ═══════════════════════════════════════════════════════════════
// I/O retry helper
// ═══════════════════════════════════════════════════════════════

/// Retry a fallible I/O closure up to IO_RETRY_COUNT times on transient errors.
/// Transient = Interrupted, TimedOut, WouldBlock. Permanent errors (NotFound,
/// PermissionDenied, etc.) fail immediately.
fn with_io_retry<T, F>(mut op: F, label: &str) -> Result<T, String>
where
    F: FnMut() -> io::Result<T>,
{
    let mut last_err: Option<io::Error> = None;
    for attempt in 0..=IO_RETRY_COUNT {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                );
                if !retryable || attempt == IO_RETRY_COUNT {
                    return Err(format!("{} (尝试 {} 次后失败): {}", label, attempt + 1, e));
                }
                let delay = IO_RETRY_BASE_DELAY * 2u32.pow(attempt);
                eprintln!(
                    "[confined_fs] {}: retryable error, attempt {}/{} — {:?} (retrying in {:?})",
                    label, attempt + 1, IO_RETRY_COUNT, e, delay
                );
                std::thread::sleep(delay);
                last_err = Some(e);
            }
        }
    }
    Err(format!(
        "{} (尝试 {} 次后失败): {}",
        label,
        IO_RETRY_COUNT + 1,
        last_err.unwrap().to_string()
    ))
}

// ═══════════════════════════════════════════════════════════════
// Read operations — permission check + I/O in one call
// ═══════════════════════════════════════════════════════════════

/// Read a text file with timeout and size guard. Wraps blocking I/O in
/// spawn_blocking so a stuck NFS mount does not hang the async runtime.
pub(crate) async fn read_text(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, state, app).await?;
    let rp = real_path.clone();
    let fp = file_path.to_string();

    // Check file size before reading — prevent OOM on huge files
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }

    let content = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read_to_string(&rp), "read_to_string")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), fp))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", fp, e))?;

    Ok((real_path, content))
}

/// Read a binary file with timeout and size guard.
pub(crate) async fn read_bytes(
    file_path: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, Vec<u8>), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, state, app).await?;
    let rp = real_path.clone();
    let fp = file_path.to_string();

    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }

    let bytes = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read(&rp), "read_bytes")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), fp))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", fp, e))?;

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
/// Content size is checked against MAX_WRITE_BYTES to prevent OOM.
pub(crate) async fn write_text(
    file_path: &str,
    content: &str,
    is_agent: bool,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容过大 ({} MiB)，超过写入上限 ({} MiB)",
            content.len() / (1024 * 1024),
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
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
    let rf = resolved_from.clone();
    let rt = resolved_to.clone();
    with_io_retry(
        || std::fs::rename(&rf, &rt),
        &format!("rename {} -> {}", from, to),
    )?;
    Ok((resolved_from, resolved_to))
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
