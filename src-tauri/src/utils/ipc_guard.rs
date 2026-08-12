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