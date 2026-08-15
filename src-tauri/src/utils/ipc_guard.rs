// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// IPC 护栏 + 锁降级 — 大响应防护与锁中毒恢复（从 utils.rs 拆出）

/// 工具/命令输出上限 — 超长输出进 Agent 上下文会滚雪球烧 token，
/// 经 IPC 回传也有击毁 WebView2 的风险（2026-08-08 事故）。
/// 对齐 DeepSeek-Reasonix 的 32KB（head+tail 各半 + 截断标记）。
pub(crate) const MAX_TOOL_OUTPUT_CHARS: usize = 32_000;

/// 截断超长输出：head 50% + tail 50%，中间插截断标记。
/// 按 char 边界切，避免 UTF-8 切坏；保留首尾最有信息量的部分。
pub(crate) fn truncate_output(s: &str) -> String {
    let total = s.chars().count();
    if total <= MAX_TOOL_OUTPUT_CHARS {
        return s.to_string();
    }
    let half = MAX_TOOL_OUTPUT_CHARS / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(total - half).collect();
    let omitted = total - MAX_TOOL_OUTPUT_CHARS;
    format!(
        "{head}\n…[output truncated: {omitted} chars omitted — 可拆小命令或加窄参数后重试]…\n{tail}"
    )
}

/// shell 溢出文件前缀（全量落盘，Agent 可用 fs(read) 读取）。
const SHELL_SPILL_PREFIX: &str = "hologram-shell-spill-";
static SHELL_SPILL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 截断 + 全量落盘（shell-stability P4，对齐 dsh spill 模型）：
/// 超过上限时不再丢弃中间——完整输出写入 temp 溢出文件，
/// 模型拿 head+tail + 落盘路径指引（fs(read) 可读全量日志）。
/// 溢出文件按前缀 + 7 天年龄清扫（尽力而为，失败静默）。
pub(crate) fn truncate_output_spill(s: &str, label: &str) -> String {
    let total = s.chars().count();
    if total <= MAX_TOOL_OUTPUT_CHARS {
        return s.to_string();
    }
    // 落盘全量（失败则回退旧截断，不丢 head+tail）
    let mut spill_note = "可拆小命令或加窄参数后重试".to_string();
    if let Some(path) = write_shell_spill(s, label) {
        spill_note = format!("完整输出已落盘: {}（用 fs(read) 读取全量日志）", path.display());
        sweep_shell_spills();
    }
    let half = MAX_TOOL_OUTPUT_CHARS / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(total - half).collect();
    let omitted = total - MAX_TOOL_OUTPUT_CHARS;
    format!("{head}\n…[output truncated: {omitted} chars omitted — {spill_note}]…\n{tail}")
}

/// 写全量输出到 temp 溢出文件，返回路径；失败返回 None（静默降级）。
fn write_shell_spill(s: &str, label: &str) -> Option<std::path::PathBuf> {
    let safe: String = label
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let seq = SHELL_SPILL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "{SHELL_SPILL_PREFIX}{safe}-{}-{seq}.log",
        std::process::id()
    ));
    std::fs::write(&path, s).ok()?;
    Some(path)
}

/// 清扫超过 7 天的 shell 溢出文件（每次落盘时顺手做，O(目录) 可接受）。
fn sweep_shell_spills() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 3600);
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(SHELL_SPILL_PREFIX) {
            continue;
        }
        if e.metadata()
            .and_then(|m| m.modified())
            .map(|m| m < cutoff)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// IPC 响应尺寸硬上限 — 2026-08-08 事故：256MB 响应经 IPC 击毁 WebView2 进程栈。
/// 图 JSON 是唯一合法的大 payload（kernel 级仓库可达数百 MB），
/// 暂以硬上限换「明确报错」替代「白屏假死」；真正的解法是图分页/流式
/// （见 docs/landmine-map.md P0-2 → L 级项目）。
pub(crate) const MAX_IPC_RESPONSE_BYTES: usize = 128 * 1024 * 1024;

/// 大响应护栏：超过 IPC 上限则报错而非静默传输（宪法·错误不静默）。
pub(crate) fn guard_ipc_size(content: String, what: &str) -> Result<String, String> {
    if content.len() > MAX_IPC_RESPONSE_BYTES {
        return Err(format!(
            "{what} 大小 {}MB 超过 IPC 上限 {}MB——直接传输会击毁 WebView2。需要图分页支持（见 docs/landmine-map.md P0-2）",
            content.len() / (1024 * 1024),
            MAX_IPC_RESPONSE_BYTES / (1024 * 1024),
        ));
    }
    Ok(content)
}

/// 统一加锁：锁中毒（持锁线程 panic）时恢复数据并告警，绝不让 panic
/// 沿 IPC 面连锁扩散——一处 panic 不得拖死整个命令面（雷区地图 P0-12）。
pub(crate) fn lock_or_recover<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| {
        eprintln!("[hologram] Mutex 中毒（持锁线程曾 panic），已恢复继续: {e}");
        e.into_inner()
    })
}

/// RwLock 读版本，语义同 lock_or_recover。
pub(crate) fn read_or_recover<T>(l: &std::sync::RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| {
        eprintln!("[hologram] RwLock 读中毒（持锁线程曾 panic），已恢复继续: {e}");
        e.into_inner()
    })
}