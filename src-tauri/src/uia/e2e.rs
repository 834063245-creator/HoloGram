// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA 端到端测试 — 真实窗口（记事本），env 门控：HOLOGRAM_UIA_E2E=1。
// 无桌面会话（CI/无头）自动跳过。权限/租约在 rpc 层，这里直调核心函数
// （对齐 cdp/e2e.rs 姿势）。全程 pattern 路径（SetValue），不抢焦点。

#![cfg(windows)]

use super::*;
use std::process::Command;

fn e2e_enabled() -> bool {
    let on = std::env::var("HOLOGRAM_UIA_E2E").map(|v| v == "1").unwrap_or(false);
    if !on {
        eprintln!("[uia-e2e] 跳过：设置 HOLOGRAM_UIA_E2E=1 启用（需交互桌面会话）");
    }
    on
}

/// WinForms 靶子窗口：PowerShell 拉一个带命名控件的标准 Win32 窗口
/// （TextBox e2eEdit + Button e2eBtn）。比 notepad 确定性高——Win11 的
/// notepad.exe 是 Store 跳板，真实窗口属于另一进程，按 pid 会找到空壳窗口。
/// ShowDialog 阻塞 PS 主线程直到进程被 kill，生命周期天然受控。
struct TargetWindow {
    child: std::process::Child,
}

const TARGET_TITLE: &str = "HoloGram UIA e2e target";

impl TargetWindow {
    fn spawn() -> Option<Self> {
        let script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = '{TARGET_TITLE}'
$f.Size = New-Object System.Drawing.Size(420, 200)
$t = New-Object System.Windows.Forms.TextBox
$t.Name = 'e2eEdit'
$t.Location = New-Object System.Drawing.Point(20, 30)
$t.Size = New-Object System.Drawing.Size(360, 30)
$b = New-Object System.Windows.Forms.Button
$b.Name = 'e2eBtn'
$b.Text = 'OK'
$b.Location = New-Object System.Drawing.Point(20, 80)
[void]$f.Controls.Add($t)
[void]$f.Controls.Add($b)
[void]$f.ShowDialog()
"#
        );
        let mut ps = Command::new("powershell");
        ps.args(["-NoProfile", "-STA", "-Command", &script]);
        let child = ps.spawn().ok()?;
        Some(Self { child })
    }
}

impl Drop for TargetWindow {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 靶子窗口全流程：tree（interactive）→ find(automation_id) → type(SetValue)
/// → read 回读断言 → click(InvokePattern)。
#[tokio::test]
async fn target_window_tree_type_read_click_flow() {
    if !e2e_enabled() {
        return;
    }
    let target = TargetWindow::spawn().expect("拉起 WinForms 靶子窗口");
    // 等窗口就绪（最多 5s）：按 title 轮询 tree，见到 Edit 控件才算 ready
    let mut tree = String::new();
    for _ in 0..20 {
        if let Ok(t) = uia_tree(Some(TARGET_TITLE), None, None, None, false, 0, 80).await {
            if t.contains("Edit") {
                tree = t;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert!(!tree.is_empty(), "靶子窗口应在 5s 内可见 Edit 控件");
    assert!(tree.contains("e2eEdit"), "树应含 automation_id=e2eEdit: {tree}");
    assert!(tree.contains("e2eBtn"), "树应含按钮: {tree}");

    // find by automation_id → type（pattern-only，不碰焦点）
    let found = uia_find(Some(TARGET_TITLE), None, None, None, None, Some("e2eEdit"), None)
        .await
        .expect("find e2eEdit");
    let v: serde_json::Value = serde_json::from_str(&found).unwrap();
    let edit_ref = v["controls"][0]["ref"].as_u64().expect("Edit ref") as u32;

    let marker = format!("hologram-uia-e2e-{}", std::process::id());
    let typed = uia_type(Some(TARGET_TITLE), None, None, Some(edit_ref), &marker, None, None, None, false)
        .await
        .expect("SetValue 输入");
    assert!(typed.contains("setvalue"), "应走 ValuePattern: {typed}");
    assert!(typed.contains(&marker), "world-diff 的 value 读回应含输入内容: {typed}");

    // read 回读（单控件复核）
    let read = uia_read(Some(TARGET_TITLE), None, None, Some(edit_ref), None, None, None)
        .await
        .expect("read");
    assert!(read.contains(&marker), "读回应包含输入内容: {read}");

    // click 按钮：WinForms Button 支持 InvokePattern（无弹窗副作用——未接事件）
    let clicked = uia_click(Some(TARGET_TITLE), None, None, None, Some("OK"), None, None, false, false)
        .await
        .expect("Invoke 点击");
    assert!(clicked.contains("\"method\":\"invoke\""), "按钮应走 InvokePattern: {clicked}");

    drop(target);
}

/// ref 失效自愈：无窗口 + 大 ref → 结构化错误码（可路由契约）。
#[tokio::test]
async fn stale_ref_reports_structured_error() {
    if !e2e_enabled() {
        return;
    }
    // 不启窗口直接用大 ref → STALE_REF（结构化码可路由）
    let e = uia_read(None, None, None, Some(99999), None, None, None).await.unwrap_err();
    // 无定位窗口时是 WINDOW_NOT_FOUND；这里给了不存在的 ref 路径，两码皆合法
    assert!(e.starts_with("[UIA_"), "错误应带结构化码: {e}");
}
