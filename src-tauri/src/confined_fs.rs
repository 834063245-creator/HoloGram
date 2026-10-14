// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 受限文件 I/O — 内核 fs 能力口（C 模型定稿形态，2026-09-04）。
//
// 架构史：
//   Phase 0-2  每个工具一 Rust 模块（工具业务仍在内核）——用户否决
//   D0-D2      字节执行搬 primitives-server 进程 + 每工具一后端接口——
//              用户否决（「要给每个工具准备接口？」）→ 终态 = C 模型
//   C 模型     内核留极少数能力口，每个口内嵌闸门（认能力+目标），工具
//              代码（schema/编排/解析）回 TS。本文件 = fs 能力口的实现：
//              裁决（resolve_*_unchecked：worktree 映射 + 沙箱）+ 字节执行一体。
//
// 语义：每个能力口函数被 TS 工具经 RPC 调用，入口即裁决（Read/Edit 家族门
// 在 dispatch 侧 adapter 或口内 Tool 构造）——「不管什么工具调，都过同一闸」。
//
// 本文件与 D2 前 confined_fs 同构（字节执行回迁自退役的 primitives-server
// fs_ops——错误文案/guards 逐字一致），不再转发子进程：webview 无盘权但 exe
// 有，TS 工具经本能力口碰盘即可，无需第二个进程（C 模型 §6）。

use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

use crate::WorkspaceState;

// ═══════════════════════════════════════════════════════════════
// Guards — 文件大小限制、读取超时、重试预算（confined_fs 原样）
// ═══════════════════════════════════════════════════════════════

/// 读取文件的最大大小 (100 MiB)。
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;
/// 写入内容的最大大小 (100 MiB)。
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;
/// 读取超时。
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 瞬态 I/O 错误重试次数。
const IO_RETRY_COUNT: u32 = 3;
/// 重试间延迟（翻倍）。
const IO_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);

/// 在瞬态错误时最多重试 IO_RETRY_COUNT 次。
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
                    return Err(crate::integrity::io_failure_message(label, attempt + 1, &e));
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
    match last_err {
        Some(e) => Err(crate::integrity::io_failure_message(label, IO_RETRY_COUNT + 1, &e)),
        None => Err(format!(
            "{} (尝试 {} 次后失败): 未知 I/O 错误",
            label,
            IO_RETRY_COUNT + 1
        )),
    }
}

// ═══════════════════════════════════════════════════════════════
// fs 能力口 — 读取（裁决 + 字节执行一体）
// ═══════════════════════════════════════════════════════════════

/// 文本读取（行号格式化可选）。裁决（resolve_read_unchecked）→ 就地字节执行。
pub(crate) async fn read_text_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    line_numbers: bool,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_unchecked(file_path, is_agent, agent_id, state)?;
    let rp = real_path.clone();
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
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    let content = if line_numbers {
        format_lines(&content, offset, limit)
    } else {
        content
    };
    Ok((real_path, content))
}

// ═══════════════════════════════════════════════════════════════
// fs 能力口 — 写入（裁决 + 字节执行一体）
// ═══════════════════════════════════════════════════════════════

/// 原子写入：tmp → rename（含 .bak 备份与失败恢复）。
fn write_atomic(file_path: &str, content: &str) -> Result<(), String> {
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = format!("{}.tmp.{}", file_path, seq);
    let bak_path = format!("{}.bak", file_path);

    with_io_retry(|| std::fs::write(&tmp_path, content), "write_atomic(tmp)")?;

    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        let _ = std::fs::remove_file(&bak_path);
        let _ = std::fs::rename(file_path, &bak_path);
    }
    match std::fs::rename(&tmp_path, file_path) {
        Ok(()) => {
            if had_original {
                let _ = std::fs::remove_file(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            if had_original && std::path::Path::new(&bak_path).exists() {
                let _ = std::fs::rename(&bak_path, file_path);
            }
            Err(format!("write_atomic(rename): {}", e))
        }
    }
}

/// 字节版原子写（write_base64 通道）——与 write_atomic 同 bak/回滚时序，
/// 载荷是 &[u8]。附图字节落盘用（multimodal-image-plan D-13）。
fn write_bytes_atomic(file_path: &str, bytes: &[u8]) -> Result<(), String> {
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = format!("{}.tmp.{}", file_path, seq);
    let bak_path = format!("{}.bak", file_path);

    with_io_retry(|| std::fs::write(&tmp_path, bytes), "write_bytes_atomic(tmp)")?;

    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        let _ = std::fs::remove_file(&bak_path);
        let _ = std::fs::rename(file_path, &bak_path);
    }
    match std::fs::rename(&tmp_path, file_path) {
        Ok(()) => {
            if had_original {
                let _ = std::fs::remove_file(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            if had_original && std::path::Path::new(&bak_path).exists() {
                let _ = std::fs::rename(&bak_path, file_path);
            }
            Err(format!("write_bytes_atomic(rename): {}", e))
        }
    }
}

/// 追加内容到文件（不存在则创建）。fs_cap append（log_append 语义）用。
pub(crate) fn append_text_unchecked(real_path: &str, content: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(real_path)
        .map_err(|e| format!("log_append: cannot open {}: {}", real_path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("log_append: write failed: {}", e))?;
    Ok(())
}

/// 追加 + fsync（durable 变体，2026-09-15 会话事件日志换轨起用）。
///
/// 语义照 DSH `JsonlSessionPersistence.appendLines`（`session-persistence-jsonl/src/index.ts:693-731`）：
/// 单次 `write_all` + `sync_all`；**任一步失败即回滚到写入前的 size 再抛**——
/// 调用方会用同一批次重试，残留的半截字节会让重放看到重复/缺号的序号。
///
/// O_APPEND 保证「单次 write 完整续尾」（并发追加零丢失字节——INVARIANTS #11
/// 家族的多写者面）；fsync 保证「append 返回 = 已落盘」，这是检查点（模型请求前
/// / 工具副作用前 flush 队列）能当天花板用而不只是尽力而为的前提。
pub(crate) fn append_text_durable(real_path: &str, content: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(real_path)
        .map_err(|e| format!("durable append: cannot open {}: {}", real_path, e))?;
    let before = file
        .metadata()
        .map_err(|e| format!("durable append: stat {} failed: {}", real_path, e))?
        .len();
    let rollback = |file: &std::fs::File| -> Result<(), String> {
        file.set_len(before)
            .map_err(|e| format!("durable append: rollback truncate failed: {}", e))?;
        file.sync_all()
            .map_err(|e| format!("durable append: rollback sync failed: {}", e))
    };
    if let Err(e) = file.write_all(content.as_bytes()) {
        let _ = rollback(&file);
        return Err(format!("durable append: write failed: {}", e));
    }
    if let Err(e) = file.sync_all() {
        let _ = rollback(&file);
        return Err(format!("durable append: sync failed: {}", e));
    }
    Ok(())
}

/// 截断文件到指定字节偏移并 fsync（断尾修复原语——丢弃崩溃留下的半截记录）。
/// 偏移 > 当前长度时 `set_len` 会补零扩展，调用方（扫描器）只传 committedBytes，
/// 因此不构成风险；此处仍显式拒绝越界，避免把「修复」变成「造洞」。
pub(crate) fn truncate_file(real_path: &str, offset: u64) -> Result<(), String> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(real_path)
        .map_err(|e| format!("truncate: cannot open {}: {}", real_path, e))?;
    let len = file
        .metadata()
        .map_err(|e| format!("truncate: stat {} failed: {}", real_path, e))?
        .len();
    if offset > len {
        return Err(format!(
            "truncate: offset {} exceeds file length {} ({})",
            offset, len, real_path
        ));
    }
    file.set_len(offset)
        .map_err(|e| format!("truncate: set_len failed: {}", e))?;
    file.sync_all()
        .map_err(|e| format!("truncate: sync failed: {}", e))?;
    Ok(())
}

/// 重命名/移动。`from`/`to` 双路径检查（read+write）→ 就地执行。
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
// 目录条目与展示辅助（utils.rs 迁回——字节执行随能力口回 exe）
// ═══════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    /// 线格式契约（TS rpc-contract.ts dirEntrySchema 立约）：**children 键恒在，
    /// 无子为 null**——禁止加 skip_serializing_if。键缺席会让前端 zod 边界
    /// 校验对每个文件条目整体拒收，目录列表全链路静默变空（2026-09-05
    /// 会话列表/发号对账回归根因，712fda8d 引入，见
    /// dir_entry_wire_format_children_key_always_present 测试）。
    pub(crate) children: Option<Vec<DirEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) truncated: Option<bool>,
}

/// 递归列出目录内容（深度受限）。filter_ignored 用 hologram-graph 排除规则。
pub(crate) fn list_dir_recursive(root: &std::path::Path, filter_ignored: bool) -> Vec<DirEntry> {
    fn recurse(
        dir: &std::path::Path,
        depth: usize,
        entries: &mut Vec<DirEntry>,
        entry_count: &mut usize,
        truncated: &mut bool,
        filter_ignored: bool,
    ) {
        const MAX_DEPTH: usize = 3;
        const MAX_ENTRIES: usize = 2000;

        if depth > MAX_DEPTH || *entry_count >= MAX_ENTRIES {
            *truncated = true;
            return;
        }
        let readdir = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        for entry in readdir.flatten() {
            if *entry_count >= MAX_ENTRIES {
                *truncated = true;
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = path.is_dir();
            if filter_ignored && is_dir
                && crate::ignored_paths::is_ignored_path(&path.to_string_lossy().replace('\\', "/"))
            {
                continue;
            }
            let children = if is_dir {
                let mut child_entries = Vec::new();
                recurse(&path, depth + 1, &mut child_entries, entry_count, truncated, filter_ignored);
                if child_entries.is_empty() { None } else { Some(child_entries) }
            } else {
                None
            };
            *entry_count += 1;
            entries.push(DirEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
                truncated: None,
            });
        }
    }

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut entry_count = 0usize;
    let mut truncated = false;
    recurse(root, 0, &mut entries, &mut entry_count, &mut truncated, filter_ignored);
    if truncated && !entries.is_empty() {
        entries[0].truncated = Some(true);
    }
    entries
}

/// 平铺列出（只隐藏 VCS 内部目录）。
pub(crate) fn list_dir_flat(root: &std::path::Path) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    let skip_dirs: std::collections::HashSet<&str> = [".git", ".hg", ".svn"].iter().cloned().collect();
    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };
    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
            truncated: None,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// cat -n 风格行号输出（offset/limit）。
pub(crate) fn format_lines(content: &str, offset: Option<usize>, limit: Option<usize>) -> String {
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

/// 原文切片（offset/limit；行号由 line_numbers=true 时的 format_lines 负责）。
/// 无 offset/limit 时字节直通（trailing newline 不经 lines()/join 重建）。
/// 2026-09 工具缺陷报告 Bug 1 伴生缺陷：此前 raw 读（line_numbers=false）
/// 静默忽略 offset/limit——翻转为默认原文后切片必须在原文路径同样生效。
pub(crate) fn slice_lines(content: &str, offset: Option<usize>, limit: Option<usize>) -> String {
    if offset.is_none() && limit.is_none() {
        return content.to_string();
    }
    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(0).min(lines.len());
    let end = limit
        .map(|l| (start + l).min(lines.len()))
        .unwrap_or(lines.len());
    lines[start..end].join("\n")
}

// ═══════════════════════════════════════════════════════════════
// 测试 — 字节层（自 primitives-server fs_ops 测试迁回）
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── write_bytes_atomic（write_base64 通道的字节原子写）──

    #[test]
    fn write_bytes_atomic_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!(
            "lantai_wb64_{}",
            std::process::id() * 1000 + TMP_TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("blob.bin");
        let ps = p.to_str().unwrap();

        write_bytes_atomic(ps, b"hello").unwrap();
        assert_eq!(std::fs::read(ps).unwrap(), b"hello");

        // 覆写走 bak 时序——旧内容整体替换，无 .bak/.tmp 残留
        write_bytes_atomic(ps, &[1, 2, 3]).unwrap();
        assert_eq!(std::fs::read(ps).unwrap(), vec![1, 2, 3]);
        assert!(!dir.join("blob.bin.bak").exists());
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(leftovers.len(), 1, "覆盖后只应有目标文件，无 tmp/bak 残留");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 跨用例唯一化 temp 子目录的序号（同名并发跑测试互不踩）。
    static TMP_TEST_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    // ── 事件日志写面（Phase 1 换轨，2026-09-15 DSH 参照）──

    /// durable append：续尾、按序、返回即已落盘；多次 append 内容为拼接。
    #[test]
    fn append_text_durable_appends_in_order() {
        let dir = std::env::temp_dir().join(format!(
            "lantai_durable_{}",
            std::process::id() * 1000 + TMP_TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("7.ndjson");
        let ps = p.to_str().unwrap();

        append_text_durable(ps, "{\"seq\":1}\n").unwrap();
        append_text_durable(ps, "{\"seq\":2}\n").unwrap();
        assert_eq!(std::fs::read_to_string(ps).unwrap(), "{\"seq\":1}\n{\"seq\":2}\n");

        // 文件不存在时创建（首卷首次 append）
        let p2 = dir.join("new.ndjson");
        append_text_durable(p2.to_str().unwrap(), "x").unwrap();
        assert_eq!(std::fs::read_to_string(&p2).unwrap(), "x");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// append 失败路径不留半截：目标为目录时写失败，且不产生新文件。
    #[test]
    fn append_text_durable_fails_without_partial_file() {
        let dir = std::env::temp_dir().join(format!(
            "lantai_durable_err_{}",
            std::process::id() * 1000 + TMP_TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("as_dir");
        std::fs::create_dir_all(&target).unwrap();

        let err = append_text_durable(target.to_str().unwrap(), "data").unwrap_err();
        assert!(err.contains("durable append"), "错误必须点名失败原语: {err}");
        assert!(target.is_dir(), "目录形态未被破坏");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 截断原语：丢弃断尾并 fsync；越界偏移拒绝（不造洞）。
    #[test]
    fn truncate_file_discards_tail_and_rejects_overflow() {
        let dir = std::env::temp_dir().join(format!(
            "lantai_trunc_{}",
            std::process::id() * 1000 + TMP_TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("log.ndjson");
        let ps = p.to_str().unwrap();
        std::fs::write(ps, "line1\nline2\n半截").unwrap();

        // committedBytes = 12（两条完整行）→ 断尾被丢弃
        truncate_file(ps, 12).unwrap();
        assert_eq!(std::fs::read_to_string(ps).unwrap(), "line1\nline2\n");

        // 越界 = 拒绝（修复不得变成造洞）
        let err = truncate_file(ps, 999).unwrap_err();
        assert!(err.contains("exceeds file length"), "越界必须拒绝: {err}");
        assert_eq!(std::fs::read_to_string(ps).unwrap(), "line1\nline2\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── glob 花括号展开（字节层随能力口回 exe）──

    #[test]
    fn expand_braces_simple() {
        let result = expand_braces("**/*.{ts,rs}");
        assert_eq!(result, vec!["**/*.ts".to_string(), "**/*.rs".to_string()]);
    }

    #[test]
    fn expand_braces_nested() {
        let result = expand_braces("a/{b,c}/{d,e}");
        assert_eq!(
            result,
            vec!["a/b/d".to_string(), "a/b/e".to_string(), "a/c/d".to_string(), "a/c/e".to_string()]
        );
    }

    #[test]
    fn expand_braces_at_start() {
        let result = expand_braces("{a,b}.ts");
        assert_eq!(result, vec!["a.ts".to_string(), "b.ts".to_string()]);
    }

    // ── 目录列表 ──

    /// 线格式契约钉（TS dirEntrySchema 对拍）：children 键恒在，无子为 null。
    /// 712fda8d 曾加 skip_serializing_if 使文件条目缺席 children 键，前端 zod
    /// 边界校验整体拒收 → 会话列表/发号对账/画布恢复全链路静默空（2026-09-05
    /// 「加载不出历史会话」回归根因）。本测试站在真实序列化输出一侧，
    /// 防止形状再次漂移而前端契约测试的 mock 察觉不到。
    #[test]
    fn dir_entry_wire_format_children_key_always_present() {
        let file = DirEntry {
            name: "a.txt".into(),
            path: "/x/a.txt".into(),
            is_dir: false,
            children: None,
            truncated: None,
        };
        let dir = DirEntry {
            name: "sub".into(),
            path: "/x/sub".into(),
            is_dir: true,
            children: Some(vec![]),
            truncated: None,
        };
        let file_json = serde_json::to_value(&file).unwrap();
        let dir_json = serde_json::to_value(&dir).unwrap();
        assert!(
            file_json.get("children").is_some(),
            "文件条目必须携带 children 键（null）：{file_json}"
        );
        assert!(file_json["children"].is_null(), "无子必须序列化为 null：{file_json}");
        assert!(
            dir_json.get("children").is_some(),
            "目录条目必须携带 children 键：{dir_json}"
        );
    }

    fn make_tree(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("confined_fs_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::create_dir_all(tmp.join(".git")).unwrap();
        std::fs::write(tmp.join("a.txt"), "a").unwrap();
        std::fs::write(tmp.join("b.txt"), "b").unwrap();
        std::fs::write(tmp.join("sub").join("c.txt"), "c").unwrap();
        std::fs::write(tmp.join(".git").join("config"), "x").unwrap();
        tmp
    }

    #[test]
    fn list_dir_flat_lists_direct_children_only() {
        let tmp = make_tree("flat");
        let entries = list_dir_flat(&tmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&"c.txt"), "sub/ 内不应出现在平铺层");
        assert!(!names.contains(&".git"), ".git 应被隐藏");
        assert!(entries.iter().all(|e| e.children.is_none()), "平铺无 children");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_dir_recursive_descends_and_filters_ignored() {
        let tmp = make_tree("rec");
        let entries = list_dir_recursive(&tmp, true);
        let flat_names: Vec<String> = {
            fn walk(e: &DirEntry, out: &mut Vec<String>) {
                out.push(e.name.clone());
                if let Some(ch) = &e.children {
                    for c in ch {
                        walk(c, out);
                    }
                }
            }
            let mut v = Vec::new();
            for e in &entries {
                walk(e, &mut v);
            }
            v
        };
        assert!(flat_names.iter().any(|n| n == "a.txt"));
        assert!(flat_names.iter().any(|n| n == "c.txt"), "递归应含 sub/c.txt");
        assert!(!flat_names.iter().any(|n| n == "config"), ".git 应被 is_ignored_path 过滤");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn glob_matches_pattern_and_skips_excluded() {
        let tmp = make_tree("glob");
        let results = glob_entries(&tmp.to_string_lossy(), &["**/*.txt".to_string()]).unwrap();
        assert_eq!(results.len(), 3, "a/b/sub/c 三 txt: {results:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn glob_invalid_pattern_errors() {
        let tmp = make_tree("globerr");
        let err = glob_entries(&tmp.to_string_lossy(), &["[".to_string()]).unwrap_err();
        assert!(err.contains("无效的 glob 模式"), "err = {err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── 展示辅助 ──

    #[test]
    fn format_lines_numbers() {
        assert_eq!(format_lines("aa\nbb\ncc", None, None), "     1\taa\n     2\tbb\n     3\tcc");
        assert_eq!(format_lines("aa\nbb\ncc", Some(1), Some(1)), "     2\tbb");
    }

    // ── slice_lines：原文路径的 offset/limit 切片（Bug 1 翻转后默认路径）──

    #[test]
    fn slice_lines_passthrough_without_window() {
        // 无窗口：字节直通（trailing newline 保留——不经 lines()/join 重建）
        assert_eq!(slice_lines("aa\nbb\n", None, None), "aa\nbb\n");
        assert_eq!(slice_lines("aa\r\nbb", None, None), "aa\r\nbb");
    }

    #[test]
    fn slice_lines_slices_like_format_lines() {
        // 切片窗口与 format_lines 同源：同 offset/limit 同语义，只是不加行号
        assert_eq!(format_lines("aa\nbb\ncc", Some(1), Some(1)), "     2\tbb");
        assert_eq!(slice_lines("aa\nbb\ncc", Some(1), Some(1)), "bb");
        assert_eq!(slice_lines("aa\nbb\ncc", None, Some(2)), "aa\nbb");
        assert_eq!(slice_lines("aa\nbb\ncc", Some(2), None), "cc");
        // 窗口越界安全钳制
        assert_eq!(slice_lines("aa\nbb", Some(5), Some(3)), "");
    }
}

// ═══════════════════════════════════════════════════════════════
// glob — 字节层（花括号展开 + 目录遍历匹配；自 fs 插件随能力口回迁）
// ═══════════════════════════════════════════════════════════════

#[derive(serde::Serialize, Debug)]
pub(crate) struct GlobEntry {
    pub(crate) path: String,
    pub(crate) name: String,
}

/// 展开 glob 模式中的花括号表达式。
fn expand_braces(pattern: &str) -> Vec<String> {
    if let Some(start) = pattern.find('{') {
        if let Some(end) = pattern[start..].find('}') {
            let end = start + end;
            let prefix = &pattern[..start];
            let suffix = &pattern[end + 1..];
            let alternatives: Vec<&str> = pattern[start + 1..end].split(',').collect();
            let mut result = Vec::new();
            for alt in &alternatives {
                let expanded = format!("{}{}{}", prefix, alt, suffix);
                result.extend(expand_braces(&expanded));
            }
            return result;
        }
    }
    vec![pattern.to_string()]
}

/// 目录遍历 + glob 匹配（root 已裁决）。
pub(crate) fn glob_entries(root: &str, patterns: &[String]) -> Result<Vec<GlobEntry>, String> {
    let p = std::path::Path::new(root);
    if !p.is_dir() {
        return Err(format!("不是有效目录: {}", root));
    }
    let expanded: Vec<String> = patterns.iter().flat_map(|pat| expand_braces(pat)).collect();
    let compiled: Vec<glob::Pattern> = expanded
        .iter()
        .map(|pat| {
            glob::Pattern::new(pat)
                .map_err(|e| format!("无效的 glob 模式 '{}': {}", pat, e))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut results: Vec<GlobEntry> = Vec::new();
    let max = 200;
    for entry in walkdir::WalkDir::new(p)
        .max_depth(12)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let entry_path = entry.path();
        let eps = entry_path.to_string_lossy();
        if eps.contains("/.git/") || eps.contains("\\.git\\")
            || eps.contains("/node_modules/") || eps.contains("\\node_modules\\")
            || eps.contains("/target/") || eps.contains("\\target\\")
            || eps.contains("/dist/") || eps.contains("\\dist\\")
            || eps.contains("/build/") || eps.contains("\\build\\")
            || eps.contains("/.lantai/") || eps.contains("\\.lantai\\")
        {
            continue;
        }
        let rel = entry_path.strip_prefix(p).unwrap_or(entry_path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if compiled.iter().any(|gp| gp.matches(&rel_str)) {
            results.push(GlobEntry {
                path: entry_path.to_string_lossy().to_string(),
                name: rel
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| rel_str.clone()),
            });
        }
        if results.len() >= max {
            break;
        }
    }
    Ok(results)
}

// ═══════════════════════════════════════════════════════════════
// fs_cap 能力口入口（R3-a，kernel-capability-c3-design.md）——
// 与 *_unchecked 的区别：口内过 resolve_*_dispatch（Agent 过闸 + Ask /
// UI 只解析），因为 fs_cap 直呼不经 PluginToolAdapter（search_cap 同款：
// 能力口入口即裁决）。builtin.fs 插件已随 fs 域收口退役（2026-09-04）——
// 残余 unchecked 变体：read_text_unchecked（builtin.editor 插件用）、
// append_text_unchecked（fs_cap append 用）。
// ═══════════════════════════════════════════════════════════════

/// 单张附图的字节上限（20MiB，与 TS 侧 image-intake 的 MAX_IMAGE_BYTES 同档；
/// browser 截图口的 8MiB 是另一口径——那边是自家产物转存的护栏）。
const MAX_IMAGE_ATTACH_BYTES: usize = 20 * 1024 * 1024;

/// fs_cap.read 的两种结局（2026-09-18 按路径读图）：文本（原文/行号格式）
/// 或附图（字节已落内容寻址附件 + 引用数据供 fs_cap.rs 组 JSON）。
pub(crate) enum ReadCapOutcome {
    Text {
        real: PathBuf,
        content: String,
    },
    Image {
        real: PathBuf,
        image: AttachedImage,
    },
}

/// 附图引用数据——形状契约与 TS 侧 parseToolImageOutput（id/mediaType/bytes/
/// width/height/name）一致；字节已在盘上（INVARIANTS #14）。
pub(crate) struct AttachedImage {
    pub id: String,
    pub media_type: &'static str,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub name: String,
    pub attachment: PathBuf,
}

/// fs_cap.read（能力口入口：dispatch 闸 + 行号格式化 + 图片嗅探）。
///
/// 2026-09-18 附图读图：字节先按**字节事实**嗅探（image_probe，不信任扩展名），
/// 命中受支持格式 → 转存工作区附件并返回附图引用（模型侧经 imageChannel 挂进
/// 上下文——视觉模型可见，纯文本模型走请求期占位投影）；未命中 → 与旧 read
/// 逐字节同语义（UTF-8 文本 + 行号/切片）。
pub(crate) async fn read_cap(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
    line_numbers: bool,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ReadCapOutcome, String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.clone();
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }
    // 先读字节（不再直接 read_to_string——嗅探需要原始字节）。
    let bytes = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read(&rp), "read_bytes")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;

    if let Some(probe) = crate::image_probe::probe(&bytes) {
        if bytes.len() > MAX_IMAGE_ATTACH_BYTES {
            return Err(format!(
                "图片过大 ({} MiB)，超过附图上限 ({} MiB): {}——请压缩后重试",
                bytes.len() / (1024 * 1024),
                MAX_IMAGE_ATTACH_BYTES / (1024 * 1024),
                file_path
            ));
        }
        // 无工作区 = 无处落附件；读图的产出就是附图，静默降级会成「读了但没给」→ 响亮报错。
        let ws = crate::utils::workspace_path(state)?;
        let (id, attachment) = crate::attachments::store_attachment(&ws, &bytes, probe.ext)
            .map_err(|e| format!("图片附件落盘失败: {e}"))?;
        let name = real_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{id}.{}", probe.ext));
        return Ok(ReadCapOutcome::Image {
            real: real_path,
            image: AttachedImage {
                id,
                media_type: probe.media_type,
                width: probe.width,
                height: probe.height,
                bytes: bytes.len(),
                name,
                attachment,
            },
        });
    }

    // 文本路径：UTF-8 解码语义与 read_to_string 等价（错误文案保持一致）。
    let content = String::from_utf8(bytes).map_err(|_| {
        let err = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        );
        format!("无法读取文件 {}: {}", file_path, err)
    })?;
    let content = if line_numbers {
        format_lines(&content, offset, limit)
    } else {
        // 原文默认（2026-09 工具缺陷报告 Bug 1：行号 opt-in，payload 不混入
        // 装饰前缀）——offset/limit 切片在原文路径同样生效（此前被静默忽略）。
        slice_lines(&content, offset, limit)
    };
    Ok(ReadCapOutcome::Text {
        real: real_path,
        content,
    })
}

/// fs_cap.write 文本写（能力口入口：dispatch 闸 + 原子写）。返回解析后路径。
pub(crate) async fn write_text_cap(
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
    write_atomic(&rp, content)?;
    Ok(real_path)
}

/// fs_cap.write_base64 二进制写（能力口入口：dispatch 闸 + 原子写字节）。
/// 附图入卷通道（multimodal-image-plan D-13：消息只存引用，字节经此口落
/// {ws}/.lantai/attachments/）——base64 入参先解码再过与 write_text_cap 同一道
/// 写闸；字节上限同 MAX_WRITE_BYTES。
pub(crate) async fn write_base64_cap(
    file_path: &str,
    b64: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("fs_cap write_base64: base64 解码失败: {e}"))?;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容过大 ({} MiB)，超过写入上限 ({} MiB)",
            bytes.len() / (1024 * 1024),
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let real_path = crate::utils::resolve_write_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.to_string_lossy().to_string();
    if let Some(parent) = real_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    write_bytes_atomic(&rp, &bytes)?;
    Ok(real_path)
}

/// fs_cap.list 目录树（能力口入口：dispatch 闸 + list_dir_recursive）。
pub(crate) async fn list_tree_cap(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
    filter_ignored: bool,
) -> Result<Vec<DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(path, is_agent, agent_id, state, app).await?;
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", path));
    }
    let entries = tokio::task::spawn_blocking(move || list_dir_recursive(&root, filter_ignored))
        .await
        .map_err(|e| format!("目录列表任务失败: {}", e))?;
    Ok(entries)
}

/// fs_cap.delete（能力口入口：dispatch 写闸 + 删）。返回解析后路径。
pub(crate) async fn delete_cap(
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
    let rp = real.clone();
    if real.is_dir() {
        tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&rp))
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("无法删除目录 {}: {}", path, e))?;
    } else {
        tokio::task::spawn_blocking(move || std::fs::remove_file(&rp))
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("无法删除文件 {}: {}", path, e))?;
    }
    Ok(real)
}

/// fs_cap.rename（能力口入口：read+write 双 dispatch 闸 + rename）。
pub(crate) async fn rename_cap(
    from: &str,
    to: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    rename(from, to, is_agent, agent_id, state, app).await
}

/// fs_cap.glob（能力口入口：dispatch 读闸解析 root 后 glob_entries）。
pub(crate) async fn glob_cap(
    pattern: &str,
    dir: Option<&str>,
    workspace_root: Option<&str>,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<Vec<GlobEntry>, String> {
    let dir = match dir {
        Some(p) => p.to_string(),
        None => workspace_root
            .map(String::from)
            .ok_or_else(|| "glob: 无目录参数且无工作区根".to_string())?,
    };
    let root = crate::utils::resolve_read_dispatch(&dir, is_agent, agent_id, state, app).await?;
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", dir));
    }
    let real = root.to_string_lossy().to_string();
    let pat_owned = pattern.to_string();
    let results = tokio::task::spawn_blocking(move || glob_entries(&real, &[pat_owned]))
        .await
        .map_err(|e| format!("glob 任务失败: {}", e))??;
    Ok(results)
}

/// fs_cap 读字节并 base64（媒体渲染消费——8MiB 源上限防 IPC 击穿 WebView2）。
pub(crate) async fn read_base64_cap(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<String, String> {
    use base64::Engine;
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.clone();
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
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    const MAX_BASE64_SOURCE_BYTES: usize = 8 * 1024 * 1024;
    if bytes.len() > MAX_BASE64_SOURCE_BYTES {
        return Err(format!(
            "文件 {}MiB 超过预览上限 {}MiB——base64 编码后 IPC 传不动",
            bytes.len() / (1024 * 1024),
            MAX_BASE64_SOURCE_BYTES / (1024 * 1024),
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// fs_cap.list_flat 平铺列目录（dispatch 读闸 + list_dir_flat）。
pub(crate) async fn list_flat_cap(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<Vec<DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(path, is_agent, agent_id, state, app).await?;
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", path));
    }
    let entries = tokio::task::spawn_blocking(move || list_dir_flat(&root))
        .await
        .map_err(|e| format!("目录列表任务失败: {}", e))?;
    Ok(entries)
}
