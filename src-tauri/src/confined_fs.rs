// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 受限文件 I/O — 统一包装器，在每次文件读/写前强制执行权限检查。
// 替代 tools.rs 中裸露的 std::fs 调用，使新工具
// 不会遗漏安全检查。该包装器是每个文件操作的唯一入口；
// 没有任何工具命令直接调用 std::fs。
//
// ponytail: 之所以存在，是因为安全审计发现 read_file_content /
// write_file_content / edit_file 都需要先执行 resolve_*_dispatch 再单独执行 std::fs
// — 每个命令都得记住这两步。现在不会遗忘了。

use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

use crate::WorkspaceState;

// ═══════════════════════════════════════════════════════════════
// Guards — 文件大小限制、读取超时、重试预算
// ═══════════════════════════════════════════════════════════════

/// 读取文件的最大大小 (100 MiB)。防止读取大文件导致 OOM。
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;

/// 写入内容的最大大小 (100 MiB)。
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;

/// 读取超时 — 卡住的 NFS 挂载不能阻塞 agent。
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// 瞬态 I/O 错误的重试次数（Interrupted、TimedOut、WouldBlock）。
const IO_RETRY_COUNT: u32 = 3;

/// 重试之间的延迟，每次翻倍。
const IO_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);

// ═══════════════════════════════════════════════════════════════
// I/O 重试辅助函数
// ═══════════════════════════════════════════════════════════════

/// 在瞬态错误时最多重试 IO_RETRY_COUNT 次 I/O 闭包。
/// 瞬态 = Interrupted、TimedOut、WouldBlock。永久错误（NotFound、
/// PermissionDenied 等）立即失败。
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
// 读取操作 — 权限检查 + I/O 合为一步
// ═══════════════════════════════════════════════════════════════

/// 带超时和大小限制的文本文件读取。将阻塞式 I/O 包装在
/// spawn_blocking 中，使卡住的 NFS 挂载不会阻塞异步运行时。
pub(crate) async fn read_text(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.clone();
    let fp = file_path.to_string();

    // 读取前检查文件大小 — 防止大文件导致 OOM
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

/// 带超时和大小限制的二进制文件读取。
pub(crate) async fn read_bytes(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, Vec<u8>), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await?;
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

/// 仅解析和验证读取路径 — 无 I/O。当下游逻辑需要已解析路径时使用
/// （如 git 命令、资源管理器打开）。
pub(crate) async fn verify_read_path(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await
}

// ═══════════════════════════════════════════════════════════════
// 写入操作 — 权限检查 + I/O 合为一步
// ═══════════════════════════════════════════════════════════════

/// 原子地写入文件（临时文件 → 重命名）。如需要则创建父目录。
/// 内容大小会与 MAX_WRITE_BYTES 比较以防止 OOM。
pub(crate) async fn write_text(
    file_path: &str,
    content: &str,
    is_agent: bool,
    agent_id: Option<&str>,
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
    let real_path = crate::utils::resolve_write_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.to_string_lossy().to_string();
    if let Some(parent) = real_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    crate::utils::write_atomic(&rp, content)?;
    Ok(real_path)
}

/// 创建目录（及其所有父目录）。
pub(crate) async fn create_dir(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let resolved = crate::utils::resolve_write_dispatch(path, is_agent, agent_id, state, app).await?;
    std::fs::create_dir_all(&resolved)
        .map_err(|e| format!("无法创建目录 {}: {}", path, e))?;
    Ok(resolved)
}

/// 删除文件或目录树。
pub(crate) async fn delete(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let real = crate::utils::resolve_write_dispatch(path, is_agent, agent_id, state, app).await?;
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

/// 重命名/移动文件或目录。`from` 和 `to` 都通过写入
/// 权限检查，`from` 还需通过读取检查 (spec §4.7)。
pub(crate) async fn rename(
    from: &str,
    to: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    let resolved_from = crate::utils::resolve_read_dispatch(from, is_agent, agent_id, state, app).await?;
    let resolved_to = crate::utils::resolve_write_dispatch(to, is_agent, agent_id, state, app).await?;
    let rf = resolved_from.clone();
    let rt = resolved_to.clone();
    with_io_retry(
        || std::fs::rename(&rf, &rt),
        &format!("rename {} -> {}", from, to),
    )?;
    Ok((resolved_from, resolved_to))
}

// ═══════════════════════════════════════════════════════════════
// 展示辅助函数 — 格式化，非 I/O
// ═══════════════════════════════════════════════════════════════

/// 将内容格式化为 cat -n 风格的带行号输出，支持 offset/limit。
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

/// 预览内容的前 `max_lines` 行，每行截断为 `max_width` 个字符。
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
// 测试 — 从 tools.rs 迁移（preview_content 原先在那里）
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
        assert_eq!(out.chars().count(), 81); // 80 字符 + U+2026 (3 字节)
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
