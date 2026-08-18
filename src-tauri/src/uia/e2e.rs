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

/// 记事本全流程：树 → find Edit → type(SetValue) → read 回读断言。
/// Win11 记事本 Edit 控件（"Text Editor"）支持 ValuePattern；旧版记事本同理。
#[tokio::test]
async fn notepad_tree_type_read_flow() {
    if !e2e_enabled() {
        return;
    }
    let mut child = Command::new("notepad.exe").spawn().expect("启动记事本");
    let pid = child.id();
    // 等窗口就绪（最多 5s）：tree 按 pid 轮询
    let mut tree = None;
    for _ in 0..20 {
        if let Ok(t) = uia_tree(None, Some(pid), None, None, false, 0, 80).await {
            tree = Some(t);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let tree = tree.expect("记事本窗口应在 5s 内可建树");
    assert!(
        tree.contains("\"Text Editor\"") || tree.contains("Edit"),
        "树应含编辑控件: {tree}"
    );

    // find → type（pattern-only，不碰焦点）
    let found = uia_find(None, Some(pid), None, None, Some("Edit"), None, None)
        .await
        .expect("find Edit");
    let v: serde_json::Value = serde_json::from_str(&found).unwrap();
    let edit_ref = v["controls"][0]["ref"].as_u64().expect("Edit ref") as u32;

    let marker = format!("hologram-uia-e2e-{}", std::process::id());
    let typed = uia_type(None, Some(pid), None, Some(edit_ref), &marker, None, None, None, false)
        .await
        .expect("SetValue 输入");
    assert!(typed.contains("setvalue"), "应走 ValuePattern: {typed}");

    // read 回读（world-diff 之外的单控件复核）
    let read = uia_read(None, Some(pid), None, Some(edit_ref), None, None, None)
        .await
        .expect("read");
    assert!(read.contains(&marker), "读回应包含输入内容: {read}");

    let _ = child.kill();
    let _ = child.wait();
}

/// ref 失效自愈：type 后树仍在（同 generation 缓存），旧 ref 依旧可解析。
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
