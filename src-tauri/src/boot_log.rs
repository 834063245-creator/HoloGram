// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! boot_log — 启动期诊断日志（2026-10-07 事故立法）
//!
//! **病灶**（实机取证，复盘见 `.lantai/memory/webview2-profile-integrity-label-2026-10-07.md`）：
//! `tauri-runtime-wry` 的窗口 / webview 创建失败**只走 `log::error!`**
//! （`Message::CreateWindow` / `Message::CreateWebview` 两个分支，且创建是 fire-and-forget——
//! 失败不回传给调用方），而本壳**此前不安装任何 `log` logger** ⇒ 错误彻底静默。
//!
//! 于是「WebView2 用户数据目录丢了 Low 完整性标签 → 浏览器进程建不了自己的 lockfile →
//! WebView2 环境创建失败」在用户侧的全部表现是：**双击后什么都不发生、进程永久挂着**
//! （窗口对象已进 tauri 高层表、真实窗口不存在、连 `Destroyed` 事件都没有）。
//! 排查绕了十几轮才定位到那一行被吞掉的 `log::error!`。
//!
//! **修法**：进程一启动就装一个 `log` logger，把 `log` 门面（tauri / wry / tao / webview2-com
//! 全走它）的 ERROR / WARN / INFO 落到 `<project_root>/.lantai/logs/boot.log` + stderr。
//!
//! **边界**：只接管 `log` 门面，**不碰 tracing 的 global subscriber** —— 工作区级 bridge 日志
//! （`.lantai/logs/bridge.log`，`logging.rs` + `workspace_service` 初始化）照旧，两者是并列的
//! 两个文件、互不干扰。`log` crate 只允许一个 logger，所以这里必须是唯一持有者，
//! **不能再叠 `LogTracer`**（否则启动期记录会因为 tracing 尚无 subscriber 而再次丢失）。
//!
//! **轮转（2026-10-12 批 4）**：本文件原自带单代 4 MiB 轮转（`boot.log.old`）。现统一
//! 到 `logging.rs` 的同一套判据（8 MiB / 保 2 代，`boot.log.1`/`.2`）——三份日志同规，
//! 修一个数只改 `logging.rs` 一处。

use std::io::Write;
use std::sync::Mutex;

/// 日志级别解析（纯函数，供测试）：`LANTAI_BOOT_LOG_LEVEL` 覆盖，缺省 `Info`。
/// 认不出/未设一律回 `Info`——宁可多记，不可静默。
fn level_from(raw: Option<&str>) -> log::LevelFilter {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("off") => log::LevelFilter::Off,
        Some("error") => log::LevelFilter::Error,
        Some("warn") => log::LevelFilter::Warn,
        Some("info") => log::LevelFilter::Info,
        Some("debug") => log::LevelFilter::Debug,
        Some("trace") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    }
}

/// 日志落点：文件 + stderr。文件打不开时 `file = None`，只写 stderr（**不 panic、不挡启动**）。
struct BootLogger {
    file: Option<Mutex<std::fs::File>>,
}

impl log::Log for BootLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} [{}] {}: {}",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
            record.level(),
            record.target(),
            record.args()
        );
        eprintln!("[boot] {line}");
        if let Some(file) = &self.file {
            // 锁只护一行写入，不跨 IO 边界持锁。
            let mut guard = crate::utils::lock_or_recover(file);
            let _ = writeln!(guard, "{line}");
        }
    }

    fn flush(&self) {
        if let Some(file) = &self.file {
            let _ = crate::utils::lock_or_recover(file).flush();
        }
    }
}

fn open_boot_log() -> Option<Mutex<std::fs::File>> {
    let dir = crate::utils::project_root().join(".lantai").join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let path = dir.join("boot.log");
    // 轮转统一走 logging 的同一套（批 4）：上限 8 MiB / 保 2 代，与 ui/bridge 同规
    //（旧版是本地单代 4 MiB + `.old` 后缀）。失败不挡启动：继续追加大文件，
    // stderr 留一行说明（失败可见）。
    if let Err(e) = crate::logging::rotate_if_large(&path, crate::logging::LOG_MAX_BYTES, crate::logging::LOG_KEEP) {
        eprintln!("[boot] boot.log 轮转失败（继续追加大文件）：{e}");
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
        .map(Mutex::new)
}

/// 装配启动期 logger。进程生命周期内调用一次（重复调用是安全的 no-op）。
///
/// **失败可见**：日志文件开不出来时降级为只写 stderr，并在 stderr 留一行说明——
/// 不允许「以为在记、其实没记」。
pub fn init() {
    let level = level_from(std::env::var("LANTAI_BOOT_LOG_LEVEL").ok().as_deref());
    let file = open_boot_log();
    let file_ok = file.is_some();
    if log::set_boxed_logger(Box::new(BootLogger { file })).is_err() {
        // 已有 logger（重复 init / 宿主已接管）——保持原样，不覆盖。
        return;
    }
    log::set_max_level(level);
    if !file_ok {
        eprintln!("[boot] boot.log 打不开（project_root 不可写？）——启动期日志只写 stderr");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_defaults_to_info_and_parses_names() {
        assert_eq!(level_from(None), log::LevelFilter::Info);
        assert_eq!(level_from(Some("info")), log::LevelFilter::Info);
        assert_eq!(level_from(Some("  DEBUG ")), log::LevelFilter::Debug);
        assert_eq!(level_from(Some("WARN")), log::LevelFilter::Warn);
        assert_eq!(level_from(Some("error")), log::LevelFilter::Error);
        assert_eq!(level_from(Some("off")), log::LevelFilter::Off);
        // 认不出 ⇒ 回 Info，不静默降到 Off
        assert_eq!(level_from(Some("tao=debug")), log::LevelFilter::Info);
        assert_eq!(level_from(Some("")), log::LevelFilter::Info);
    }

    #[test]
    fn boot_log_path_lives_under_project_logs_dir() {
        let dir = crate::utils::project_root().join(".lantai").join("logs");
        assert!(dir.ends_with("logs"), "启动期日志必须落 .lantai/logs 下：{dir:?}");
    }

    /// 回归（2026-10-07 事故）：装了 logger 之后，`log` 门面的记录**必须真的落盘**。
    /// 这是本次事故的核心行为——tauri-runtime-wry 的窗口/webview 创建失败只走 `log::error!`，
    /// 记录写不出去，用户侧就只剩「双击后什么都不发生」。
    #[test]
    fn file_sink_writes_records_where_asked() {
        let dir = std::env::temp_dir().join(format!("boot_log_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("boot.log");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        let logger = BootLogger { file: Some(Mutex::new(file)) };
        // 测试进程里没人设过级别，缺省 Off 会把记录挡掉——显式放开。
        log::set_max_level(log::LevelFilter::Trace);
        let record = log::Record::builder()
            .args(format_args!("[boot_log-regression] 启动期错误必须落盘"))
            .level(log::Level::Error)
            .target("boot_log::tests")
            .build();
        log::Log::log(&logger, &record);
        log::Log::flush(&logger);

        let text = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            text.contains("[boot_log-regression] 启动期错误必须落盘"),
            "log 记录必须写进指定文件：{path:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重复 init 必须是安全的 no-op（`log` 只允许一个 logger，第二次 set 会失败）。
    #[test]
    fn init_is_idempotent_and_never_panics() {
        init();
        init();
    }
}
