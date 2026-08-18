// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 窗口截图 — 混合路径：UIA worker 定位窗口矩形（COM，毫秒级），
// PowerShell System.Drawing 做像素捕获 + PNG 编码（一次性子进程，~200ms）。
// 刻意不迁 Rust：无 PNG 编码依赖，且截图是纯读取动作，PS 开销可接受。
// 输出与 desktop_screenshot 同目录（hologram-browser-shots）。

pub(super) fn capture(x: i32, y: i32, w: i32, h: i32) -> Result<(std::path::PathBuf, usize, String), String> {
    let script = format!(
        "$ErrorActionPreference='Stop'\n\
         [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         try {{\n\
           Add-Type -AssemblyName System.Drawing\n\
           $b = New-Object System.Drawing.Bitmap({w}, {h})\n\
           $g = [System.Drawing.Graphics]::FromImage($b)\n\
           $g.CopyFromScreen({x}, {y}, 0, 0, $b.Size)\n\
           $out = Join-Path $env:TEMP (\"hologram-uia-\" + [guid]::NewGuid().ToString(\"N\") + \".png\")\n\
           $b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)\n\
           $g.Dispose(); $b.Dispose()\n\
           Write-Output $out\n\
         }} catch {{\n\
           Write-Output ('UIA_ERROR=' + $_.Exception.Message)\n\
           exit 1\n\
         }}\n"
    );
    let mut ps = std::process::Command::new("powershell");
    ps.args(["-NoProfile", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps.creation_flags(crate::utils::HIDDEN_CONSOLE);
    }
    let out = ps
        .output()
        .map_err(|e| format!("uia_window_shot: 执行 PowerShell 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if let Some(err_line) = stdout.lines().find(|l| l.trim_start().starts_with("UIA_ERROR=")) {
        return Err(format!("[UIA_INTERNAL] 窗口截图失败: {}", err_line.trim_start().trim_start_matches("UIA_ERROR=")));
    }
    let src = stdout
        .lines()
        .find(|l| l.trim_end().ends_with(".png"))
        .map(|l| l.trim().to_string())
        .ok_or("[UIA_INTERNAL] 窗口截图失败: 未找到输出路径")?;
    let bytes = std::fs::read(&src).map_err(|e| format!("[UIA_INTERNAL] 读截图失败: {e}"))?;
    let dir = std::env::temp_dir().join("hologram-browser-shots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("[UIA_INTERNAL] 创建截图目录失败: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let final_path = dir.join(format!("uia-win-{ts}.png"));
    std::fs::write(&final_path, &bytes).map_err(|e| format!("[UIA_INTERNAL] 写截图文件失败: {e}"))?;
    let _ = std::fs::remove_file(&src);
    let rect = format!("{x},{y},{w},{h}");
    Ok((final_path, bytes.len(), rect))
}
