// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台 Tauri 桥接层结构化日志 — NDJSON 输出到 .lantai/logs/bridge.log
//
// ⚡ 2026-10-12（日志可观测性批 3）本文件另担两职：
//   ① `bridge_sink_ready()` —— tracing 的 global subscriber 是否已装。它是
//      `llm_proxy` 那类**启动期就存在**的模块的判据：subscriber 未装时
//      `tracing::warn!` 的记录**静默消失**（tracing 无 subscriber = 什么都不发生），
//      故那些模块据此回退到 `log` 门面（boot.log，进程启动期即装上）。
//   ② `level_hint_from_env()` —— `log_level_hint` RPC 的真源（`LANTAI_LOG_LEVEL`
//      环境变量 → 前端日志级别；见 src-ui/src/agent/logger.ts 与规格 §6）。
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, EnvFilter, Registry};

/// bridge.log 的 tracing subscriber 是否已装（由本文件的 `init_logging` 置位）。
///
/// **为什么需要这个读数**：进程启动期（`main.rs` 的 setup：建窗、spawn LLM 代理）
/// 还没有任何 tracing subscriber，而 `set_global_default` 之前发出的 tracing 记录
/// 不是「丢进 stderr」而是**彻底没有**（无 subscriber ⇒ 无人接盘）。llm_proxy 在
/// 该窗口期记「绑定失败 / 端口不可用」时据此回退 `log` 门面（boot_log.rs 的
/// boot.log，`main.rs:71` 启动期即装），保证「失败不静默」在启动期同样成立。
static BRIDGE_SINK_READY: AtomicBool = AtomicBool::new(false);

/// bridge.log 通道是否可用（供启动期模块选择出口，见上）。
pub fn bridge_sink_ready() -> bool {
    BRIDGE_SINK_READY.load(Ordering::SeqCst)
}

/// 级别名规范化（纯函数，供测试）：认得出才回规范名，**认不出回 None**——
/// 不猜。猜错会把「我明明设了 debug」变成更难查的形态（与 boot_log.rs 的
/// `level_from` 同判：宁可回落默认，不要静默改口径）。
fn parse_level(raw: Option<&str>) -> Option<&'static str> {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("debug") => Some("debug"),
        Some("info") => Some("info"),
        Some("warn") | Some("warning") => Some("warn"),
        Some("error") => Some("error"),
        _ => None,
    }
}

/// `log_level_hint` RPC 的返回值 = 前端（ui.log）日志级别的**壳侧提示**。
///
/// 真源 = `LANTAI_LOG_LEVEL` 环境变量（当前唯一不需要 UI 的开关——设置页开关
/// 留到下一批）。未设 / 认不出 ⇒ **空串**（前端回落 localStorage → 默认 info）。
/// 之所以要经壳转一手：WebView 里读不到进程环境变量，而壳读得到。
pub fn level_hint_from_env() -> String {
    parse_level(std::env::var("LANTAI_LOG_LEVEL").ok().as_deref())
        .unwrap_or("")
        .to_string()
}

/// 初始化桥接层日志。返回一个 `WorkerGuard`，必须在
/// 进程生命周期内持有。
pub fn init_logging(project_root: &Path) -> WorkerGuard {
    let log_dir = project_root.join(".lantai").join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::NEVER)
        .filename_prefix("bridge")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&log_dir)
        .expect("failed to create bridge log file appender");

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = fmt::layer().json().with_writer(non_blocking);

    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_writer(std::io::stderr);

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing::subscriber::set_global_default(
        Registry::default().with(filter).with(file_layer).with(stderr_layer),
    )
    .expect("bridge tracing subscriber already set");
    // 置位后，启动期模块（llm_proxy 等）的留痕改走 bridge.log（见文件头注 ①）。
    BRIDGE_SINK_READY.store(true, Ordering::SeqCst);

    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 级别名规范化：认得出才有值，认不出回 None（**不猜**）。
    /// 判据（2026-10-12 批 3）：`trace` 不在列——前端没有这一档；
    /// `RUST_LOG` 风格的 `a=b` 表达式也不入此门（那是 tracing 自己的旋钮）。
    #[test]
    fn level_names_normalize_or_reject() {
        assert_eq!(parse_level(None), None);
        assert_eq!(parse_level(Some("")), None);
        assert_eq!(parse_level(Some("   ")), None);
        assert_eq!(parse_level(Some("  DEBUG ")), Some("debug"));
        assert_eq!(parse_level(Some("Info")), Some("info"));
        assert_eq!(parse_level(Some("WARNING")), Some("warn"));
        assert_eq!(parse_level(Some("warn")), Some("warn"));
        assert_eq!(parse_level(Some("error")), Some("error"));
        assert_eq!(parse_level(Some("trace")), None);
        assert_eq!(parse_level(Some("verbose")), None);
        assert_eq!(parse_level(Some("llm_proxy=debug")), None);
    }

    /// `log_level_hint` 的真源读数：未设 ⇒ 空串（前端回落 localStorage/默认）；
    /// 认不出 ⇒ 也是空串（**不猜**——猜错比不生效更难查）。
    #[test]
    fn level_hint_reads_env_and_never_guesses() {
        let orig = std::env::var_os("LANTAI_LOG_LEVEL");
        std::env::remove_var("LANTAI_LOG_LEVEL");
        assert_eq!(level_hint_from_env(), "", "未设必须回空串（不是 info）");
        std::env::set_var("LANTAI_LOG_LEVEL", " DEBUG ");
        assert_eq!(level_hint_from_env(), "debug");
        std::env::set_var("LANTAI_LOG_LEVEL", "trace");
        assert_eq!(level_hint_from_env(), "", "认不出的值不得猜成某一档");
        match orig {
            Some(v) => std::env::set_var("LANTAI_LOG_LEVEL", v),
            None => std::env::remove_var("LANTAI_LOG_LEVEL"),
        }
    }
}
