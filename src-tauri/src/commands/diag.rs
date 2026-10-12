// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 诊断包导出（日志可观测性批 4）——`diag_export` RPC 的实现。
//
// 目标闭环（用户视角）：**点一下 → 得到一个文件 → 把文件发给 Agent**。
// 内容 = ui.log + bridge.log + boot.log（+ engine.log，存在就带）
//      + 一个「可信度段」（通道可用性 / 断档区间 / 文件 mtime / 字段来源标签）。
//
// 为什么必须有可信度段：一份日志自己不会说「我可能缺了哪一块」——没有它，
// 读的人分不清「没发生」「没记上」「被滚掉了」。验收判据：拿到一个包应能回答
//   ① 有没有丢条（log.self{dropped}）
//   ② 有没有断档（相邻记录的时间跳跃）
//
// 三个工程决定（自裁）：
//   1. **单文件纯文本 `.txt`**：用户只需认识「一个文件」，拖进聊天即可发出；
//      不做 zip/tar.gz（Windows 双击体验差 + 不引新依赖）。
//   2. **每份日志尾部截取 ≤ `PER_FILE_CAP`**（与轮转上限同数）：诊断以「最近
//      现场」为价值核心；正常轮转后一份不会触发截断。截尾丢半个行边界。
//   3. **输出到 `<ws>/.lantai/diag/`，保留最近 `DIAG_KEEP` 份**（超出删最老；
//      清理失败只留痕、不炸本次导出——导出成功优先）。
//
// 一条诚实纪律：包内统计（行数 / 时间跨度 / 空档）只覆盖**包内实际所载内容**，
// 与「文件全量」分开写（文件大小与 mtime 是全量的 [实测]）——两者不可混淆。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};

/// 每份日志随包携带的最大字节数（尾部截取）——与轮转上限同数
/// （`logging::LOG_MAX_BYTES`）：轮转后正常一份不截，两边只改一处。
const PER_FILE_CAP: u64 = crate::logging::LOG_MAX_BYTES;
/// `.lantai/diag/` 保留最近多少份诊断包（超出删最老；删失败不炸导出）。
const DIAG_KEEP: usize = 10;
/// 「显著空档」阈值：1 小时（毫秒）。空档本身不等于丢日志（可能只是没人用），
/// 报出来供读者结合上下文判断。
const GAP_MIN_MS: i64 = 60 * 60 * 1000;

/// 行时间戳的取法（按通道形态）。
#[derive(Clone, Copy, PartialEq)]
enum TsStyle {
    /// NDJSON 的 `ts` 字段（ui.log，logger 写的）。
    JsonTs,
    /// NDJSON 的 `timestamp` 字段（bridge.log / engine.log，tracing json）。
    JsonTimestamp,
    /// 行首 RFC3339 文本（boot.log，`2026-10-12T21:48:23.315+08:00 [INFO] …`）。
    TextPrefix,
}

/// 通道表（同时是正文顺序：现场优先级从高到低）。
struct ChannelSpec {
    name: &'static str,
    style: TsStyle,
}

const CHANNELS: [ChannelSpec; 4] = [
    ChannelSpec { name: "ui.log", style: TsStyle::JsonTs },
    ChannelSpec { name: "bridge.log", style: TsStyle::JsonTimestamp },
    ChannelSpec { name: "boot.log", style: TsStyle::TextPrefix },
    ChannelSpec { name: "engine.log", style: TsStyle::JsonTimestamp },
];

/// 单通道读数。
struct ChannelRead {
    exists: bool,
    /// 文件全量大小（[实测]）。
    file_size: u64,
    mtime: Option<DateTime<Local>>,
    /// 包内所载文本（可能为尾部截取）。
    text: String,
    truncated: bool,
}

/// 行扫描统计（只覆盖传入文本——即包内所载）。
#[derive(Default)]
struct Scan {
    lines: u64,
    parsed: u64,
    /// 取不出时间戳的行（JSON 坏行 / 缺字段 / 前缀不合法）。
    unparsed: u64,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
    /// 最大空档 top3（降序）。
    gaps: Vec<(i64, i64)>,
    /// 超阈值空档计数（含 top3 里的）。
    over_gap: u64,
    /// 时间回退（后一条早于前一条）计数——系统时间被改过 / 文件被拼接的线索。
    backwards: u64,
}

/// 导出摘要（RPC 返回给 UI 显示用）。
#[derive(Debug, serde::Serialize)]
pub(crate) struct ChannelOut {
    pub name: String,
    pub exists: bool,
    pub size: u64,
    pub included_bytes: u64,
    pub truncated: bool,
}

/// `diag_export` RPC 入口：组装 + 落盘 + 清理旧包，返回 JSON 摘要。
pub(crate) fn diag_export(workspace: &Path) -> Result<serde_json::Value, String> {
    let built = build_bundle(workspace, Local::now())?;
    Ok(serde_json::json!({
        "path": built.0.to_string_lossy(),
        "size": built.1,
        "channels": built.2,
    }))
}

/// 组装诊断包（可注入时间——测试用）。返回 (文件路径, 文件大小, 逐通道摘要)。
pub(crate) fn build_bundle(
    workspace: &Path,
    now: DateTime<Local>,
) -> Result<(PathBuf, u64, Vec<ChannelOut>), String> {
    let logs_dir = workspace.join(".lantai").join("logs");
    if !logs_dir.is_dir() {
        return Err(format!("诊断包：日志目录不存在（{}）——先在兰台里打开过工作区、写过日志再来导出", logs_dir.display()));
    }

    let mut reads: Vec<ChannelRead> = Vec::new();
    let mut scans: Vec<Scan> = Vec::new();
    for spec in &CHANNELS {
        let read = read_channel(&logs_dir.join(spec.name))?;
        scans.push(scan(&read.text, spec.style));
        reads.push(read);
    }

    let mut out = String::with_capacity(64 * 1024);
    render_header(&mut out, workspace, now, &reads, &scans, &CHANNELS);
    for (i, spec) in CHANNELS.iter().enumerate() {
        if !reads[i].exists {
            continue;
        }
        render_section(&mut out, spec.name, &reads[i]);
    }

    let dir = workspace.join(".lantai").join("diag");
    std::fs::create_dir_all(&dir).map_err(|e| format!("诊断包：创建目录失败 {}: {e}", dir.display()))?;
    let path = dir.join(format!("lantai-diag-{}.txt", now.format("%Y%m%d-%H%M%S")));
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("诊断包：写入失败 {}: {e}", path.display()))?;
    let size = out.len() as u64;

    prune_old(&dir);

    let summary: Vec<ChannelOut> = CHANNELS
        .iter()
        .enumerate()
        .map(|(i, spec)| ChannelOut {
            name: spec.name.to_string(),
            exists: reads[i].exists,
            size: reads[i].file_size,
            included_bytes: reads[i].text.len() as u64,
            truncated: reads[i].truncated,
        })
        .collect();
    Ok((path, size, summary))
}

/// 读一个通道（不存在 = `exists:false` 的正常态，不是错误）。
fn read_channel(path: &Path) -> Result<ChannelRead, String> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ChannelRead { exists: false, file_size: 0, mtime: None, text: String::new(), truncated: false });
        }
        Err(e) => return Err(format!("诊断包：读不到 {} 的元数据：{e}", path.display())),
    };
    let file_size = meta.len();
    let mtime = meta.modified().ok().map(DateTime::<Local>::from);
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("诊断包：打开 {} 失败：{e}", path.display()))?;
    let start = file_size.saturating_sub(PER_FILE_CAP);
    let truncated = start > 0;
    if truncated {
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("诊断包：定位 {} 失败：{e}", path.display()))?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("诊断包：读取 {} 失败：{e}", path.display()))?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        // 截尾可能切进一行中间——丢掉第一个不完整行（行边界从第一个 \n 之后起）。
        match text.find('\n') {
            Some(i) => {
                text.drain(..=i);
            }
            None => text.clear(),
        }
    }
    Ok(ChannelRead { exists: true, file_size, mtime, text, truncated })
}

/// 扫描一份文本的行时间戳（纯函数）。
fn scan(text: &str, style: TsStyle) -> Scan {
    let mut s = Scan::default();
    let mut prev: Option<i64> = None;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        s.lines += 1;
        match extract_ts(line, style) {
            Some(ms) => {
                s.parsed += 1;
                if s.first_ms.is_none() {
                    s.first_ms = Some(ms);
                }
                if let Some(p) = prev {
                    let d = ms - p;
                    if d < 0 {
                        s.backwards += 1;
                    } else if d >= GAP_MIN_MS {
                        s.over_gap += 1;
                        push_top_gap(&mut s.gaps, (p, ms));
                    }
                }
                prev = Some(ms);
                s.last_ms = Some(ms);
            }
            None => s.unparsed += 1,
        }
    }
    s
}

/// 取一行的毫秒时间戳（UTC epoch millis）。
fn extract_ts(line: &str, style: TsStyle) -> Option<i64> {
    match style {
        TsStyle::JsonTs | TsStyle::JsonTimestamp => {
            let key = if style == TsStyle::JsonTs { "ts" } else { "timestamp" };
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            parse_rfc3339_ms(v.get(key)?.as_str()?)
        }
        TsStyle::TextPrefix => {
            let head = line.split_whitespace().next()?;
            parse_rfc3339_ms(head)
        }
    }
}

fn parse_rfc3339_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw).ok().map(|dt| dt.timestamp_millis())
}

/// 空档 top3（降序、最多 3 条）。
fn push_top_gap(gaps: &mut Vec<(i64, i64)>, gap: (i64, i64)) {
    gaps.push(gap);
    gaps.sort_by_key(|g| -(g.1 - g.0));
    gaps.truncate(3);
}

// ── 渲染 ─────────────────────────────────────────────────────────

fn render_header(
    out: &mut String,
    workspace: &Path,
    now: DateTime<Local>,
    reads: &[ChannelRead],
    scans: &[Scan],
    channels: &[ChannelSpec],
) {
    let bar = "=".repeat(72);
    out.push_str(&format!("{bar}\n兰台诊断包 / lantai diag\n{bar}\n\n"));
    out.push_str(&format!("生成时间：{}\n", now.format("%Y-%m-%d %H:%M:%S %:z")));
    out.push_str(&format!("工作区：{}\n", workspace.display()));
    let boot = last_boot_identity(&reads[0].text);
    match &boot {
        Some(b) => {
            out.push_str(&format!("应用：{} ({})", b.version, b.commit));
            if let Some(lvl) = &b.log_level {
                out.push_str(&format!(" ［自报：来自日志中的 boot 记录；日志级别 {}（{}）］", lvl, b.level_source.as_deref().unwrap_or("来源未上报")));
            } else {
                out.push_str(" ［自报：来自日志中的 boot 记录；级别未上报（旧构建）］");
            }
            out.push('\n');
        }
        None => {
            out.push_str("应用：未能从包内日志中找到 boot 记录（可能在被截掉的部分、或该通道尚无记录）\n");
        }
    }

    out.push_str("\n── 怎么读这份包 ──────────────────────────────────────────\n");
    out.push_str("读数标签：[实测] = 本次导出时现场测量的客观事实（大小 / 时间 / 行数 / 空档）；\n");
    out.push_str("          [自报] = 应用运行时自己声明的（版本 / 级别 / 丢条计数——可能过时或有误）。\n\n");

    out.push_str("通道可用性（文件存在吗、多大、最后写入何时）：\n");
    for (i, spec) in channels.iter().enumerate() {
        let r = &reads[i];
        if r.exists {
            out.push_str(&format!(
                "  {:<11} {} · 最后写入 {}  [实测]\n",
                spec.name,
                fmt_bytes(r.file_size),
                r.mtime.map(|m| m.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_else(|| "未知".to_string()),
            ));
        } else {
            out.push_str(&format!("  {:<11} 不存在（该通道从未写过日志）  [实测]\n", spec.name));
        }
    }

    out.push_str("\n包内所载（以下统计只覆盖包内实际内容）：\n");
    for (i, spec) in channels.iter().enumerate() {
        let r = &reads[i];
        let s = &scans[i];
        if !r.exists {
            continue;
        }
        if r.truncated {
            out.push_str(&format!(
                "  {:<11} 尾部 {} / 全量 {}（超上限截尾）\n",
                spec.name,
                fmt_bytes(r.text.len() as u64),
                fmt_bytes(r.file_size)
            ));
        } else {
            out.push_str(&format!("  {:<11} 完整 {} \n", spec.name, fmt_bytes(r.file_size)));
        }
        out.push_str(&format!(
            "              {} 行 · 无法解析时间戳 {} 行 · 时间 {} → {}\n",
            s.lines,
            s.unparsed,
            s.first_ms.map(fmt_ms).unwrap_or_else(|| "—".to_string()),
            s.last_ms.map(fmt_ms).unwrap_or_else(|| "—".to_string()),
        ));
        let gaps = if s.gaps.is_empty() {
            "最大空档 无（未超过 1 小时）".to_string()
        } else {
            format!(
                "最大空档 {}（{} → {}）",
                fmt_duration_ms(s.gaps[0].1 - s.gaps[0].0),
                fmt_ms(s.gaps[0].0),
                fmt_ms(s.gaps[0].1)
            )
        };
        out.push_str(&format!(
            "              {} · 超 1 小时空档 {} 处 · 时间回退 {} 处\n",
            gaps, s.over_gap, s.backwards
        ));
    }

    out.push_str("\n丢条线索（「有没有丢条」的判据）：\n");
    let ui = &reads[0];
    match log_self_summary(&ui.text) {
        Some(ls) if ls.count > 0 => {
            out.push_str(&format!(
                "  ui.log：log.self 记录 {} 条——丢条补偿 dropped 合计 {} 条 / 轮转失败 {} 次 / 前情倒出 {} 次  [自报]\n",
                ls.count, ls.dropped, ls.rotate_failed, ls.ring_dumped
            ));
        }
        _ => {
            out.push_str("  ui.log：无 log.self 记录——未报告过丢条（若期间真有写入失败，这里应出现补偿记录）  [自报]\n");
        }
    }
    out.push_str("  其余通道没有丢条自报告机制——「这些通道有没有丢过」本包回答不了（现状限制）。\n");

    out.push_str("\n断档提示：空档可能只是那段时间没人用应用，未必是日志丢失——判据看空档两端\n");
    out.push_str("附近的记录连续性：前一秒还在写、后一秒跳出几小时，先怀疑丢。\n");
}

fn render_section(out: &mut String, name: &str, read: &ChannelRead) {
    let bar = "=".repeat(72);
    out.push_str(&format!("\n{bar}\n{name}"));
    if read.truncated {
        out.push_str(&format!(
            " ［包内 {}；全量 {}——超上限，只取尾部］",
            fmt_bytes(read.text.len() as u64),
            fmt_bytes(read.file_size)
        ));
    } else {
        out.push_str(&format!(" ［包内 {}，完整］", fmt_bytes(read.file_size)));
    }
    out.push_str(&format!("\n{bar}\n"));
    out.push_str(&read.text);
    if !read.text.ends_with('\n') {
        out.push('\n');
    }
}

/// ui.log 里 `log.self` 的汇总（丢条 / 轮转失败 / 前情倒出）。
#[derive(Default)]
struct LogSelfSummary {
    count: u64,
    dropped: u64,
    rotate_failed: u64,
    ring_dumped: u64,
}

fn log_self_summary(ui_text: &str) -> Option<LogSelfSummary> {
    let mut s = LogSelfSummary::default();
    let mut seen = false;
    for line in ui_text.lines() {
        if !line.contains("\"log.self\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("event").and_then(|e| e.as_str()) != Some("log.self") {
            continue;
        }
        seen = true;
        s.count += 1;
        let ctx = v.get("ctx");
        s.dropped += ctx.and_then(|c| c.get("dropped")).and_then(|x| x.as_u64()).unwrap_or(0);
        s.rotate_failed += ctx.and_then(|c| c.get("rotate_failed")).and_then(|x| x.as_u64()).unwrap_or(0);
        s.ring_dumped += ctx.and_then(|c| c.get("ring_dumped")).and_then(|x| x.as_u64()).unwrap_or(0);
    }
    if seen { Some(s) } else { None }
}

/// 包内最后一条 boot 记录的身份面（版本 / commit / 级别 / 级别来源）。
struct BootIdentity {
    version: String,
    commit: String,
    log_level: Option<String>,
    level_source: Option<String>,
}

fn last_boot_identity(ui_text: &str) -> Option<BootIdentity> {
    let mut found: Option<BootIdentity> = None;
    for line in ui_text.lines() {
        if !line.contains("\"event\":\"boot\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("event").and_then(|e| e.as_str()) != Some("boot") {
            continue;
        }
        let str_at = |root: &serde_json::Value, path: &[&str]| -> Option<String> {
            let mut cur = root;
            for seg in path {
                cur = cur.get(*seg)?;
            }
            cur.as_str().map(String::from)
        };
        found = Some(BootIdentity {
            version: str_at(&v, &["build", "v"]).unwrap_or_else(|| "unknown".into()),
            commit: str_at(&v, &["build", "commit"]).unwrap_or_else(|| "unknown".into()),
            log_level: str_at(&v, &["ctx", "log_level"]),
            level_source: str_at(&v, &["ctx", "log_level_source"]),
        });
    }
    found
}

// ── 小工具 ───────────────────────────────────────────────────────

fn fmt_bytes(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

fn fmt_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.with_timezone(&Local).format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "—".to_string())
}

fn fmt_duration_ms(ms: i64) -> String {
    let secs = ms / 1000;
    let days = secs / 86400;
    let hours = (secs % 86400) / 3600;
    let mins = (secs % 3600) / 60;
    if days > 0 {
        format!("{days} 天 {hours} 小时")
    } else if hours > 0 {
        format!("{hours} 小时 {mins} 分")
    } else if mins > 0 {
        format!("{mins} 分")
    } else {
        format!("{secs} 秒")
    }
}

/// 清理旧诊断包：按文件名（含时间戳）降序保留最近 `DIAG_KEEP` 份。
/// 删除失败只记 stderr、不打断导出（导入成功优先于清理完美）。
fn prune_old(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut packages: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("lantai-diag-") && n.ends_with(".txt"))
        })
        .collect();
    packages.sort();
    packages.reverse(); // 新的在前（名字 = 时间戳）
    for stale in packages.into_iter().skip(DIAG_KEEP) {
        if let Err(e) = std::fs::remove_file(&stale) {
            eprintln!("[diag] 旧诊断包清理失败（不影响本次导出）：{}: {e}", stale.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn tmp_ws(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lantai_diag_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".lantai").join("logs")).unwrap();
        d
    }

    fn now_fixed() -> DateTime<Local> {
        Local.timestamp_millis_opt(1_792_000_000_000).unwrap()
    }

    #[test]
    fn scan_counts_gaps_backwards_and_unparsed() {
        let text = concat!(
            "{\"ts\":\"2026-10-12T10:00:00Z\",\"event\":\"a\"}\n",
            "{\"ts\":\"2026-10-12T10:00:10Z\",\"event\":\"b\"}\n",
            "这不是 JSON\n",                                      // unparsed
            "{\"ts\":\"2026-10-12T09:00:00Z\",\"event\":\"back\"}\n", // 时间回退
            "{\"ts\":\"2026-10-12T14:00:00Z\",\"event\":\"c\"}\n",    // 回退后跳到 14:00
        );
        let s = scan(text, TsStyle::JsonTs);
        assert_eq!(s.lines, 5);
        assert_eq!(s.parsed, 4);
        assert_eq!(s.unparsed, 1);
        assert_eq!(s.backwards, 1);
        // 09:00 → 14:00 是 5 小时空档（回退时刻本身不计）
        assert_eq!(s.over_gap, 1);
        let (from, to) = s.gaps[0];
        assert_eq!(fmt_duration_ms(to - from), "5 小时 0 分");
        assert_eq!(s.first_ms.map(fmt_ms).unwrap(), fmt_ms(parse_rfc3339_ms("2026-10-12T10:00:00Z").unwrap()));
    }

    #[test]
    fn scan_reads_boot_text_prefix_and_tracing_timestamp() {
        let boot = "2026-10-12T21:48:23.315+08:00 [INFO] lantai::llm_proxy: hi\n乱行\n";
        let s = scan(boot, TsStyle::TextPrefix);
        assert_eq!(s.parsed, 1);
        assert_eq!(s.unparsed, 1);

        let bridge = "{\"timestamp\":\"2026-10-12T14:33:05.691440Z\",\"level\":\"INFO\"}\n";
        let s = scan(bridge, TsStyle::JsonTimestamp);
        assert_eq!(s.parsed, 1);
        let s = scan(bridge, TsStyle::JsonTs);
        assert_eq!(s.unparsed, 1, "键名不对不得计为解析成功");
    }

    #[test]
    fn read_channel_takes_tail_and_drops_partial_first_line() {
        let dir = tmp_ws("tail");
        let path = dir.join(".lantai").join("logs").join("big.log");
        // 造一个超上限的文件：一行 64 字节 × 超限行数太多不实际——用小样本改测半行丢弃逻辑：
        // 直接手工构造「截断后的缓冲」不可注入，故用真实大于上限的文件（多行）。
        let line = format!("{{\"ts\":\"2026-10-12T10:00:00Z\",\"pad\":\"{}\"}}\n", "x".repeat(900));
        let mut content = String::new();
        while (content.len() as u64) <= PER_FILE_CAP + 10 {
            content.push_str(&line);
        }
        std::fs::write(&path, &content).unwrap();

        let r = read_channel(&path).unwrap();
        assert!(r.exists);
        assert!(r.truncated);
        assert_eq!(r.file_size, content.len() as u64);
        assert!(r.text.len() as u64 <= PER_FILE_CAP);
        for l in r.text.lines() {
            assert!(l.starts_with('{') && l.ends_with('}'), "截尾后行必须完整：{l}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_channel_missing_is_normal() {
        let dir = tmp_ws("missing");
        let r = read_channel(&dir.join(".lantai").join("logs").join("nope.log")).unwrap();
        assert!(!r.exists);
        assert_eq!(r.file_size, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn build_bundle_contains_confidence_and_channels() {
        let ws = tmp_ws("bundle");
        let logs = ws.join(".lantai").join("logs");
        std::fs::write(
            logs.join("ui.log"),
            concat!(
                "{\"ts\":\"2026-10-12T10:00:00.000Z\",\"level\":\"info\",\"message\":\"启动 v1.0.6 (abcdef12) · 工作区 D:/x\",\"ctx\":{\"log_channel\":\"ok\",\"log_level\":\"info\",\"log_level_source\":\"default\"},\"event\":\"boot\",\"build\":{\"v\":\"1.0.6\",\"commit\":\"abcdef12\"}}\n",
                "{\"ts\":\"2026-10-12T10:05:00.000Z\",\"level\":\"warn\",\"message\":\"日志丢条补偿：此前 7 条写入失败\",\"ctx\":{\"channel\":\"ok\",\"dropped\":7},\"event\":\"log.self\"}\n",
                "{\"ts\":\"2026-10-12T10:06:00.000Z\",\"level\":\"info\",\"message\":\"hi\"}\n",
            ),
        )
        .unwrap();
        std::fs::write(
            logs.join("bridge.log"),
            "{\"timestamp\":\"2026-10-12T10:00:01.000000Z\",\"level\":\"INFO\",\"fields\":{\"message\":\"spawn\"},\"target\":\"lantai::x\"}\n",
        )
        .unwrap();
        std::fs::write(logs.join("boot.log"), "2026-10-12T09:59:00.000+08:00 [INFO] lantai: boot ok\n").unwrap();

        let (path, size, summary) = build_bundle(&ws, now_fixed()).unwrap();
        assert!(path.exists());
        assert!(size > 0);
        assert_eq!(summary.len(), 4);
        assert_eq!(summary[3].name, "engine.log");
        assert!(!summary[3].exists, "engine.log 缺席必须是 exists:false（不是错误）");

        let text = std::fs::read_to_string(&path).unwrap();
        // 判据 ①：丢条可答
        assert!(text.contains("log.self 记录 1 条——丢条补偿 dropped 合计 7 条"), "{text}");
        // 判据 ②：断档可答（本样本无超 1 小时空档 → 明确写「未超过」）
        assert!(text.contains("最大空档 无（未超过 1 小时）"), "{text}");
        // 来源标签与版本（自报）
        assert!(text.contains("应用：1.0.6 (abcdef12)"));
        assert!(text.contains("[实测]"));
        assert!(text.contains("[自报]"));
        // 通道正文有分隔与内容
        assert!(text.contains("ui.log ［包内"));
        assert!(text.contains("boot.log ［包内"));
        assert!(text.contains("怎么读这份包"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn build_bundle_reports_missing_logs_dir() {
        let dir = std::env::temp_dir().join(format!("lantai_diag_nodir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let err = build_bundle(&dir, now_fixed()).unwrap_err();
        assert!(err.contains("日志目录不存在"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_latest_packages() {
        let dir = tmp_ws("prune").join(".lantai").join("diag");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..13 {
            std::fs::write(dir.join(format!("lantai-diag-2026100{i}-000000.txt")), "x").unwrap();
        }
        // 混入非本家族文件：不许被清
        std::fs::write(dir.join("other.txt"), "keep").unwrap();
        prune_old(&dir);
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), DIAG_KEEP + 1, "保留 10 份 + other.txt：{names:?}");
        assert!(names.contains(&"other.txt".to_string()));
        assert!(names.contains(&"lantai-diag-20261009-000000.txt".to_string()), "最新一份必须在");
        assert!(!names.contains(&"lantai-diag-20261000-000000.txt".to_string()), "最老一份应被清");
    }
}
