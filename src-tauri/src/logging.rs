// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台 Tauri 桥接层结构化日志 — NDJSON 输出到 .lantai/logs/bridge.log
//
// ⚡ 2026-10-12（日志可观测性批 4）本文件是三份日志**共同**的轮转判据真源：
//   - `rotate_generations` / `rotate_if_large`：大小滚代（超上限 → `.1`/`.2`，
//     保 `LOG_KEEP` 代，最老代删）。bridge.log 经 `RotatingFileWriter`（本文件，
//     写时自计数）；ui.log 经 `log_rotate` RPC（前端 logger 触发）；boot.log 在
//     `boot_log.rs` 打开时调用同一函数。三份同规：8 MiB / 保 2 代。
//   - 历史病灶：`tracing_appender` 的 `Rotation::NEVER` 下 `max_log_files(5)`
//     是死参数（永不切分就没有多余文件可清），实测 bridge.log 单文件涨到
//     13 MB；ui.log 前端纯追加无上限（实测 75 MB）。
//   - 纪律：轮转失败**必须可见**（不许静默吞）——`RotatingFileWriter` 首次失败走
//     `log::warn!`（boot.log + stderr），`rotate_if_large` 的 Err 由调用方落面。
//
// ⚡ 2026-10-12（日志可观测性批 3）本文件另担两职：
//   ① `bridge_sink_ready()` —— tracing 的 global subscriber 是否已装。它是
//      `llm_proxy` 那类**启动期就存在**的模块的判据：subscriber 未装时
//      `tracing::warn!` 的记录**静默消失**（tracing 无 subscriber = 什么都不发生），
//      故那些模块据此回退到 `log` 门面（boot.log，进程启动期即装上）。
//   ② `level_hint_from_env()` —— `log_level_hint` RPC 的真源（`LANTAI_LOG_LEVEL`
//      环境变量 → 前端日志级别；见 src-ui/src/agent/logger.ts 与规格 §6）。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, EnvFilter, Registry};

// ── 日志轮转 / 保留窗口（批 4）────────────────────────────────────────

/// 单份日志文件的上限（字节）：达到即滚代。三份日志同规。
///
/// 8 MiB 的取法：boot.log 单代先例是 4 MiB；ui.log 是信息主战场，8 MiB ≈ 数万
/// 条事件、够覆盖一次完整事故现场 + 前情缓冲导出的上下文；诊断包对每份日志
/// 也按 8 MiB 截尾（`diag.rs`），两边同数 = 轮转后正常情况一份不截。
/// 保留 2 代（当前 + `.1` + `.2`）= 每通道 24 MiB 硬上限。
pub(crate) const LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 保留代数：当前 + `.1` + `.2`。最老代（`.2`）在下一次滚动时删。
/// 为什么不是 5（旧 `max_log_files(5)`）：那是 NEVER 旋转下的死参数、无人依赖；
/// 「上一份完整现场」在第 1 代已可得，更多代是纯磁盘占用。
pub(crate) const LOG_KEEP: usize = 2;

/// `path` 的第 `n` 代文件路径（`ui.log` → `ui.log.1`）。
fn generation_path(path: &Path, n: usize) -> PathBuf {
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{name}.{n}"))
}

/// 纯滚代（不做尺寸判断）：`path.{keep}` 删 → `path.{keep-1}`→`path.{keep}` → …
/// → `path`→`path.1`。每一步「源存在才动」（整体幂等，失败可重试）；任何一步
/// 失败把**步骤与原因**一起返回（失败可见——调用方负责落面）。
pub(crate) fn rotate_generations(path: &Path, keep: usize) -> Result<(), String> {
    let oldest = generation_path(path, keep);
    if oldest.exists() {
        std::fs::remove_file(&oldest)
            .map_err(|e| format!("rotate: 删除最老代失败 {}: {e}", oldest.display()))?;
    }
    for n in (1..keep).rev() {
        let from = generation_path(path, n);
        if from.exists() {
            let to = generation_path(path, n + 1);
            std::fs::rename(&from, &to)
                .map_err(|e| format!("rotate: {} → {} 失败: {e}", from.display(), to.display()))?;
        }
    }
    if path.exists() {
        let to = generation_path(path, 1);
        std::fs::rename(path, &to)
            .map_err(|e| format!("rotate: {} → {} 失败: {e}", path.display(), to.display()))?;
    }
    Ok(())
}

/// 尺寸判断 + 滚代：`size >= max_bytes` 才滚。返回 `(滚了没有, 滚前尺寸)`。
/// 文件不存在 = `(false, 0)`（不是错误——首次写入前即此态）。
pub(crate) fn rotate_if_large(path: &Path, max_bytes: u64, keep: usize) -> Result<(bool, u64), String> {
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((false, 0)),
        Err(e) => return Err(format!("rotate: stat {} 失败: {e}", path.display())),
    };
    if size < max_bytes {
        return Ok((false, size));
    }
    rotate_generations(path, keep)?;
    Ok((true, size))
}

/// `log_rotate` RPC 的路径围栏：只接受 `<...>/.lantai/logs/<name>.log`。
///
/// 为什么要有：轮转动作会删除 `path.2` 并挪动 `.1`/主文件——不加围栏等于给人
/// 一个「删任意 `<x>.log` 两个副本」的入口。形状检查把它收窄到日志目录下的
/// 主日志文件（代文件 `.1`/`.2` 不以 `.log` 结尾，天然被拒）。
pub(crate) fn is_rotatable_log(path: &Path) -> bool {
    let name_ok = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".log"));
    let parent = path.parent();
    let logs_ok = parent.and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("logs");
    let lantai_ok = parent
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some(".lantai");
    name_ok && logs_ok && lantai_ok
}

/// bridge.log 的大小滚代写入器（批 4）。
///
/// **唯一写者**：由 `tracing_appender::non_blocking` 的 worker 单线程持用——
/// 故自记字节数与滚代都无需锁（`written` 自己数，`write` 前越限就滚代重开）。
/// 打开时以现有文件尺寸为计数初值：**存量超限文件在第一次写入时即被滚动**
/// （大型遗留文件不会先被继续追加）。
struct RotatingFileWriter {
    path: PathBuf,
    file: std::fs::File,
    written: u64,
    max_bytes: u64,
    keep: usize,
    /// 轮转失败是否已报告（首次报告后置位，成功一次后重置——不刷屏、不静默）。
    failure_reported: bool,
}

impl RotatingFileWriter {
    fn open(path: PathBuf, max_bytes: u64, keep: usize) -> std::io::Result<Self> {
        let written = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self { path, file, written, max_bytes, keep, failure_reported: false })
    }

    /// 越限就滚。**失败不阻断写入**（继续追加旧文件也比丢这条日志强），但必须
    /// 可见：`log::warn!` 走 boot.log + stderr（boot logger 启动期即装）。
    fn rotate_now(&mut self) {
        let reopened = rotate_generations(&self.path, self.keep).and_then(|()| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)
                .map_err(|e| format!("rotate: 轮转后重开失败 {}: {e}", self.path.display()))
        });
        match reopened {
            Ok(f) => {
                self.file = f;
                self.written = 0;
                self.failure_reported = false;
            }
            Err(e) => {
                if !self.failure_reported {
                    self.failure_reported = true;
                    log::warn!("[logging] bridge.log 轮转失败（继续追加大文件，不再重报）：{e}");
                }
            }
        }
    }
}

impl Write for RotatingFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.written >= self.max_bytes {
            self.rotate_now();
        }
        let n = self.file.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

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

    // 批 4：自研大小滚代 writer（旧 `Rotation::NEVER + max_log_files(5)` 里
    // max_log_files 是死参数——永不切分就没有多余文件可清）。
    let writer = RotatingFileWriter::open(log_dir.join("bridge.log"), LOG_MAX_BYTES, LOG_KEEP)
        .expect("failed to create bridge log file appender");
    let (non_blocking, guard) = tracing_appender::non_blocking(writer);

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

    // ── 日志轮转 / 保留窗口（批 4）──────────────────────────────────

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lantai_log_rotate_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 滚代链：`.2` 删 → `.1`→`.2` → 主文件→`.1`；主文件滚后不再存在（直到
    /// 下一次写入重建）。
    #[test]
    fn rotate_generations_shifts_and_drops_oldest() {
        let dir = tmp_dir("shift");
        let f = dir.join("ui.log");
        std::fs::write(&f, "cur").unwrap();
        std::fs::write(dir.join("ui.log.1"), "one").unwrap();
        std::fs::write(dir.join("ui.log.2"), "two").unwrap();

        rotate_generations(&f, 2).unwrap();

        assert!(!f.exists(), "主文件滚成 .1 后不该还在");
        assert_eq!(std::fs::read_to_string(dir.join("ui.log.1")).unwrap(), "cur");
        assert_eq!(std::fs::read_to_string(dir.join("ui.log.2")).unwrap(), "one");
        // 旧的 .2 被清（保留窗口 = 当前 + 2 代）
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 尺寸判断：未达上限不动（连 `.1` 也不碰）；达到才滚。
    #[test]
    fn rotate_if_large_only_rotates_over_limit() {
        let dir = tmp_dir("limit");
        let f = dir.join("ui.log");
        std::fs::write(&f, "0123456789").unwrap(); // 10 字节

        let (rotated, size) = rotate_if_large(&f, 11, 2).unwrap();
        assert!(!rotated, "未达上限不得滚");
        assert_eq!(size, 10);
        assert!(f.exists());
        assert!(!dir.join("ui.log.1").exists());

        let (rotated, size) = rotate_if_large(&f, 10, 2).unwrap();
        assert!(rotated, "达到上限必须滚（>= 判据）");
        assert_eq!(size, 10);
        assert_eq!(std::fs::read_to_string(dir.join("ui.log.1")).unwrap(), "0123456789");

        // 不存在 = (false, 0)，不是错误（首次写入前即此态）
        let (rotated, size) = rotate_if_large(&dir.join("none.log"), 10, 2).unwrap();
        assert!(!rotated);
        assert_eq!(size, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 连滚多轮后仍只保留 `keep` 代 + 主文件（窗口不涨）。
    #[test]
    fn rotation_window_stays_fixed_across_many_rounds() {
        let dir = tmp_dir("window");
        let f = dir.join("ui.log");
        for i in 0..5 {
            std::fs::write(&f, format!("round-{i}")).unwrap();
            let (rotated, _) = rotate_if_large(&f, 4, 2).unwrap();
            assert!(rotated);
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["ui.log.1".to_string(), "ui.log.2".to_string()]);
        // 最新一轮在最前代
        assert_eq!(std::fs::read_to_string(dir.join("ui.log.1")).unwrap(), "round-4");
        assert_eq!(std::fs::read_to_string(dir.join("ui.log.2")).unwrap(), "round-3");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 围栏形状：只放行 `<...>/.lantai/logs/<name>.log`（代文件 / 别处 / 别的
    /// 后缀全拒）。
    #[test]
    fn is_rotatable_log_fences_shapes() {
        assert!(is_rotatable_log(Path::new("D:/ws/.lantai/logs/ui.log")));
        assert!(is_rotatable_log(Path::new("D:/ws/.lantai/logs/bridge.log")));
        assert!(!is_rotatable_log(Path::new("D:/ws/.lantai/logs/ui.log.1")), "代文件不是主文件");
        assert!(!is_rotatable_log(Path::new("D:/ws/logs/ui.log")), "缺 .lantai 一层");
        assert!(!is_rotatable_log(Path::new("D:/ws/.lantai/other/ui.log")), "不在 logs 目录");
        assert!(!is_rotatable_log(Path::new("D:/ws/.lantai/logs/ui.txt")), "非 .log 后缀");
        assert!(!is_rotatable_log(Path::new("D:/ws/.lantai/logs")), "目录不是文件");
    }

    /// 写器：打开时以现有尺寸为初值，达上限的**下一次写入**先滚代再写；
    /// 滚后从零计数（新文件继续写），滚动前的内容完整留在 `.1`。
    #[test]
    fn rotating_writer_rolls_same_generations() {
        let dir = tmp_dir("writer");
        let f = dir.join("bridge.log");
        std::fs::write(&f, "0123456789").unwrap(); // 10 字节，上限 10 ⇒ 首写即滚
        let mut w = RotatingFileWriter::open(f.clone(), 10, 2).unwrap();

        w.write_all(b"first\n").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("bridge.log.1")).unwrap(), "0123456789");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "first\n");

        // 未达上限的写入不动代际
        w.write_all(b"second\n").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "first\nsecond\n");
        assert_eq!(std::fs::read_to_string(dir.join("bridge.log.1")).unwrap(), "0123456789");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写器：未超限打开 + 累计到超限才滚（滚动发生在越限后的下一次写入前）。
    #[test]
    fn rotating_writer_waits_until_limit() {
        let dir = tmp_dir("writer2");
        let f = dir.join("bridge.log");
        let mut w = RotatingFileWriter::open(f.clone(), 10, 2).unwrap();
        w.write_all(b"aaaaaaaa").unwrap(); // 8 字节
        assert!(!dir.join("bridge.log.1").exists());
        w.write_all(b"bbbb").unwrap(); // 12 字节 > 10，但这批仍写进主文件
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "aaaaaaaabbbb");
        w.write_all(b"cccc").unwrap(); // 写前检查：越限 ⇒ 先滚
        assert_eq!(std::fs::read_to_string(dir.join("bridge.log.1")).unwrap(), "aaaaaaaabbbb");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "cccc");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
