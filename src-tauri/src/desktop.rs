// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// Desktop 观察(只读) — 进程树 / 窗口清单 / 控制台可见性快照。
//
// 边界(与 cdp 刻意不同)：
//   - 纯进程表/窗口枚举，不连 CDP、不做长期 observer、不订阅事件流。
//   - 默认只取进程可执行名(敏感命令行摘要)，不完整回显命令行。
//   - 只探当前机，不跨用户会话/RDP。
// 用法：Agent / 用户按需调用 desktop_probe 取一帧快照;用于定位
//       "某进程带了可见控制台窗口" 这类问题(如语言服务器启动弹 cmd 窗口)。

use serde_json::json;

// ═══════════════════════════════════════════════════════════
// 进程记录
// ═══════════════════════════════════════════════════════════

#[derive(Debug)]
pub(crate) struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    /// 可执行名(去路径, 仅文件名)——不作完整命令行回显(可能含密钥/路径)。
    pub name: String,
    pub is_chromium: bool,
}

/// Chromium 系进程名特征(含 Electron 等)。用于与浏览器观察通道对齐。
fn is_chromium_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n == "chrome" || n == "msedge" || n == "brave" || n == "chromium"
        || n.contains("chrome") || n.contains("edge") || n.contains("electron")
        || n == "msedgewebview2"
}

/// 从 Get-CimInstance Win32_Process 的 "pid|ppid|name" 行解析进程条目。
/// 行格式与 desktop_probe 里 PowerShell 的 -f 输出对齐。
fn parse_proc_line(line: &str) -> Option<ProcEntry> {
    let mut it = line.split('|');
    let pid = it.next()?.trim().parse().ok()?;
    let ppid = it.next()?.trim().parse().ok()?;
    let name = it.next()?.trim().to_string();
    if name.is_empty() { return None; }
    Some(ProcEntry { pid, ppid, name: name.clone(), is_chromium: is_chromium_name(&name) })
}

// ═══════════════════════════════════════════════════════════
// 窗口记录
// ═══════════════════════════════════════════════════════════

#[derive(Debug)]
pub(crate) struct WindowEntry {
    pub pid: u32,
    pub name: String,
    pub title: String,
    /// 是否可见:有非空标题 + 非零窗口句柄视为可见顶层窗口。
    pub visible: bool,
}

/// 从 Get-Process 的 "pid|name|title|handle" 行解析窗口条目。
fn parse_window_line(line: &str) -> Option<WindowEntry> {
    let mut it = line.split('|');
    let pid = it.next()?.trim().parse().ok()?;
    let name = it.next()?.trim().to_string();
    let title = it.next()?.trim().to_string();
    let handle = it.next()?.trim().parse::<u64>().ok()?;
    if name.is_empty() || handle == 0 { return None; }
    Some(WindowEntry { pid, name, title: title.clone(), visible: !title.is_empty() })
}

// ═══════════════════════════════════════════════════════════
// 快照
// ═══════════════════════════════════════════════════════════

/// 枚举当前进程 + 顶层窗口 + 可见控制台窗口。返回序列化 JSON 字符串。
/// 实现用 PowerShell 只读查询(与 cdp_discover 同模式),失败时返回错误。
pub(crate) fn desktop_probe() -> Result<String, String> {
    #[cfg(windows)]
    {
        // 1. 进程表: pid|ppid|name
        let proc_ps = "Get-CimInstance Win32_Process | ForEach-Object { \"{0}|{1}|{2}\" -f $_.ProcessId, $_.ParentProcessId, $_.Name }";
        let proc_rows = run_ps(proc_ps)?;
        let processes: Vec<ProcEntry> = proc_rows.lines()
            .map(str::trim).filter(|l| !l.is_empty())
            .filter_map(parse_proc_line).collect();

        // 2. 顶层窗口: pid|name|title|handle(仅 MainWindowHandle != 0)
        let win_ps = "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { \"{0}|{1}|{2}|{3}\" -f $_.Id, $_.ProcessName, $_.MainWindowTitle, $_.MainWindowHandle }";
        let win_rows = run_ps(win_ps)?;
        let windows: Vec<WindowEntry> = win_rows.lines()
            .map(str::trim).filter(|l| !l.is_empty())
            .filter_map(parse_window_line).collect();

        // 3. 可见控制台窗口: conhost 带可见主窗口句柄的进程(LSP 弹窗的直接信号)
        let con_ps = "Get-Process conhost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { \"{0}|{1}\" -f $_.Id, $_.MainWindowTitle }";
        let con_rows = run_ps(con_ps)?;
        let visible_consoles: Vec<String> = con_rows.lines()
            .map(str::trim).filter(|l| !l.is_empty())
            .map(|l| l.to_string()).collect();

        Ok(json!({
            "process_count": processes.len(),
            "processes": processes.iter().map(|p| json!({
                "pid": p.pid, "ppid": p.ppid, "name": p.name, "is_chromium": p.is_chromium,
            })).collect::<Vec<_>>(),
            "window_count": windows.len(),
            "windows": windows.iter().map(|w| json!({
                "pid": w.pid, "name": w.name, "title": w.title, "visible": w.visible,
            })).collect::<Vec<_>>(),
            "visible_console_windows": visible_consoles,
            "note": "纯只读快照,不持续监控。默认仅进程名(不含命令行),可能含敏感信息的完整命令行不回显。",
        }).to_string())
    }
    #[cfg(not(windows))]
    {
        Err("desktop_probe 目前仅支持 Windows".into())
    }
}

/// 全屏截图(只读, 隐私高)。用 System.Drawing CopyFromScreen 捕获主屏,
/// 落盘到 hologram-browser-shots 临时目录, 返回 {path, bytes, note}。
/// 调用方(rpc 层)需先经权限 Ask —— 截进整个桌面属高隐私面。
/// 需交互桌面会话;无桌面(RDP headless / service)时返回明确错误。
pub(crate) fn desktop_screenshot() -> Result<String, String> {
    #[cfg(windows)]
    {
        // 捕获主屏到临时 PNG, 输出文件路径(stdout)。Add-Type 需 FullLanguage
        // (真实应用内 powershell.exe 具全权限;无桌面会话时 CopyFromScreen 抛错)。
        let script = r#"
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
try {
    $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $b = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $b.Size)
    $out = Join-Path $env:TEMP ("hologram-desk-" + [guid]::NewGuid().ToString("N") + ".png")
    $b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $b.Dispose()
    Write-Output $out
} catch {
    Write-Error ("capture-failed: " + $_.Exception.Message)
    exit 1
}
"#;
        let out_path = run_ps(script)?;
        let src = out_path.lines().next().unwrap_or("").trim().to_string();
        if src.is_empty() {
            return Err("desktop_screenshot: PowerShell 未返回截图路径".into());
        }
        let bytes = std::fs::read(&src)
            .map_err(|e| format!("desktop_screenshot: 读截图失败: {e}"))?;
        // 转存到会话截图目录(与 cdp_screenshot 同目录), 再清理临时源文件
        let dir = std::env::temp_dir().join("hologram-browser-shots");
        std::fs::create_dir_all(&dir).map_err(|e| format!("desktop_screenshot: 创建截图目录失败: {e}"))?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("desk-{ts}.png"));
        std::fs::write(&path, &bytes).map_err(|e| format!("desktop_screenshot: 写截图文件失败: {e}"))?;
        let _ = std::fs::remove_file(&src); // 清理临时源
        Ok(json!({
            "path": path.to_string_lossy(),
            "bytes": bytes.len(),
            "note": "全屏截图已落盘(纯文本模型看不到内容,可交给用户确认; vision 模型可读路径)。需交互桌面会话。",
        })
        .to_string())
    }
    #[cfg(not(windows))]
    {
        Err("desktop_screenshot 目前仅支持 Windows".into())
    }
}

/// 运行一段 PowerShell 命令并返回 stdout。
fn run_ps(script_body: &str) -> Result<String, String> {
    let script = format!("$ErrorActionPreference='SilentlyContinue'
{script_body}");
    let mut ps = std::process::Command::new("powershell");
    ps.args(["-NoProfile", "-Command", &script]);
    // 静默后台运行：不弹 PowerShell 窗口（windows 上隐含控制台会闪烁）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps.creation_flags(crate::utils::NO_WINDOW);
    }
    let out = ps.output()
        .map_err(|e| format!("desktop probe: 执行 PowerShell 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!("desktop probe: PowerShell 退出码 {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ═══════════════════════════════════════════════════════════
// 测试 — 纯解析函数,不依赖真实进程表/Chrome
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proc_line_fields() {
        let p = parse_proc_line("1234|100|python.exe").unwrap();
        assert_eq!(p.pid, 1234);
        assert_eq!(p.ppid, 100);
        assert_eq!(p.name, "python.exe");
        assert!(!p.is_chromium, "python 不是 chromium 系");
    }

    #[test]
    fn parse_proc_line_chromium_detection() {
        assert!(parse_proc_line("1|0|chrome.exe").unwrap().is_chromium);
        assert!(parse_proc_line("2|0|msedge.exe").unwrap().is_chromium);
        assert!(parse_proc_line("3|0|electron.exe").unwrap().is_chromium);
        assert!(!parse_proc_line("4|0|node.exe").unwrap().is_chromium);
        assert!(!parse_proc_line("5|0|cmd.exe").unwrap().is_chromium);
    }

    #[test]
    fn parse_proc_line_malformed_returns_none() {
        assert!(parse_proc_line("").is_none());
        assert!(parse_proc_line("1234").is_none());
        assert!(parse_proc_line("abc|0|x").is_none(), "pid 非数字应丢弃");
        assert!(parse_proc_line("1|0|").is_none(), "空进程名应丢弃");
    }

    #[test]
    fn parse_window_line_fields_and_visibility() {
        let w = parse_window_line("42|notepad|Untitled - Notepad|123456").unwrap();
        assert_eq!(w.pid, 42);
        assert_eq!(w.name, "notepad");
        assert_eq!(w.title, "Untitled - Notepad");
        assert!(w.visible);
        // 非零句柄但空标题 → 不可视
        let hidden = parse_window_line("43|app| |999").unwrap();
        assert!(!hidden.visible);
        // 句柄为 0 → 丢弃(不是顶层窗口)
        assert!(parse_window_line("44|app|title|0").is_none());
    }

    #[test]
    fn parse_window_line_malformed_returns_none() {
        assert!(parse_window_line("").is_none());
        assert!(parse_window_line("a|b|c|d").is_none(), "pid 非数字应丢弃");
    }

    #[test]
    fn chromium_name_helper() {
        assert!(is_chromium_name("chrome"));
        assert!(is_chromium_name("msedge.exe"));
        assert!(is_chromium_name("electron"));
        assert!(!is_chromium_name("notepad"));
        assert!(!is_chromium_name(""));
    }
}
