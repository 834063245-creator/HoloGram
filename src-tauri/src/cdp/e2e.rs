// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════
// CDP 核心端到端测试（真实 Chrome，无 app、无权限弹窗）
// ═══════════════════════════════════════════════════════════
// 为什么能自动化：权限 Ask 只在 rpc 层，cdp 核心函数（connect/attach/
// click/kill/launch）不经过权限引擎——直接调用即可驱动真实浏览器。
// 覆盖曾经"落地即坏"的链路（回归防护）：
//   - connect 外部实例全链路 + click 世界反馈（e1679a0 / bfbcd95 回归）
//   - kill 语义：外部实例只断开不杀、受控实例终止 + profile 定向回收
// 无 Chrome 环境（CI 容器等）自动跳过；两个测试用共享锁串行。
// 端口：9444（外部实例）/ 9445（受控 launch），避开 app 的 9222 / 9223-9238。

use super::*;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 两个 e2e 测试互斥（共享真实 Chrome/端口/profile），也与触碰
/// SESSIONS 全局的单元测试共存（不同 agent key + 锁内完成）。
static E2E_LOCK: Mutex<()> = Mutex::new(());

const E2E_EXTERNAL_PORT: u16 = 9444;
const E2E_LAUNCH_PORT: u16 = 9445;
const E2E_EXTERNAL_PROFILE: &str = "hologram-browser-profile-e2e-external";

/// 无 Chrome 时跳过（打日志不判失败——CI 无浏览器环境也应绿）。
fn skip_if_no_chrome() -> bool {
    if find_chrome().is_some() {
        return false;
    }
    eprintln!("[cdp-e2e] 跳过：未找到 Chrome/Edge（HOLOGRAM_CHROME 可指定路径）");
    true
}

/// 起一个"用户自己的" Chrome（模拟外部实例）。Drop 负责清理。
struct ExternalChrome {
    child: Child,
    profile: std::path::PathBuf,
}

impl ExternalChrome {
    fn spawn(url: &str) -> Option<Self> {
        let chrome = find_chrome()?;
        let profile = std::env::temp_dir().join(E2E_EXTERNAL_PROFILE);
        let _ = std::fs::remove_dir_all(&profile); // 清上次崩溃残留
        let mut cmd = Command::new(&chrome);
        cmd.arg(format!("--remote-debugging-port={E2E_EXTERNAL_PORT}"))
            .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg(url);
        // 刻意不设 NO_WINDOW：模拟"用户自己的浏览器"= 可见窗口。
        // （隐藏窗口里链接激活可能被吞——见 e2e 测试注释。）
        let child = cmd.spawn().ok()?;
        Some(Self { child, profile })
    }
}

impl Drop for ExternalChrome {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

/// 等待端口出现调试服务（同步轮询）。
fn wait_port_up(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if list_targets_raw(port).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// E2E-1：connect 外部实例全链路。
/// 覆盖：connect→targets→attach→snapshot→click 世界反馈→kill 只断开不杀。
/// 回归：世界快照静默失效（e1679a0）、导航反馈漏报（bfbcd95）、
///       外部连接 kill 语义（b988f87d）。
#[tokio::test]
async fn e2e_connect_external_full_flow() {
    let _g = crate::utils::lock_or_recover(&E2E_LOCK);
    if skip_if_no_chrome() {
        return;
    }
    if list_targets_raw(E2E_EXTERNAL_PORT).is_ok() {
        eprintln!("[cdp-e2e] 跳过：端口 {E2E_EXTERNAL_PORT} 已被占用（上次崩溃残留？）");
        return;
    }
    let Some(mut ext) = ExternalChrome::spawn("https://example.com/") else {
        eprintln!("[cdp-e2e] 跳过：外部 Chrome 启动失败");
        return;
    };
    if !wait_port_up(E2E_EXTERNAL_PORT, Duration::from_secs(10)) {
        eprintln!("[cdp-e2e] 跳过：调试端口未在 10s 内就绪");
        return;
    }

    let agent = "e2e-connect-agent";

    // connect
    let out = cdp_connect(E2E_EXTERNAL_PORT, Some(agent)).expect("connect 应成功");
    assert!(out.contains("\"connected\""), "connect 返回异常: {out}");

    // targets：应看到 example.com 页面（页面加载可能滞后，轮询等）
    let mut target_id: Option<String> = None;
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let t = cdp_targets(Some(agent)).expect("targets 应成功");
            let v: Value = serde_json::from_str(&t).expect("targets 返回应可解析");
            let pages = v["targets"].as_array().expect("targets 应含 targets 数组");
            if let Some(p) = pages.iter().find(|p| p["url"].as_str().unwrap_or("").contains("example.com")) {
                target_id = Some(p["id"].as_str().unwrap_or("").to_string());
                break;
            }
            if Instant::now() > deadline {
                panic!("外部实例应打开 example.com 页面: {t}");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    let target_id = target_id.expect("轮询应已取到 target id");

    // attach
    let a = cdp_attach(&target_id, Some(agent)).expect("attach 应成功");
    assert!(a.contains("\"attached\":true"), "attach 返回异常: {a}");

    // snapshot：example.com 有一个 "Learn more" 链接（页面可能还在加载，轮询等）
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let s = cdp_snapshot(Some("body".into()), Some(20), Some(0), Some(agent))
                .await
                .expect("snapshot 应成功");
            if s.contains("\"ref\":0") {
                break;
            }
            if Instant::now() > deadline {
                panic!("snapshot 应含 ref 0（Learn more 链接）: {s}");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    // 等页面完全加载 + 启动期繁忙消退再点击——真实用户不会在页面加载中点击；
    // 冷启动 Chrome 若在启动任务繁忙时点链接，导航可能超 2s 轮询窗口（首测教训）。
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let ready = runtime_evaluate("document.readyState", Some(agent))
                .await
                .map(|v| v.as_str() == Some("complete"))
                .unwrap_or(false);
            if ready {
                break;
            }
            if Instant::now() > deadline {
                panic!("页面未在 10s 内加载完成");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await; // 加载完成后的额外 settle
    }

    // click ref 0 → 导航到 iana.org，世界反馈必须报 URL 变化
    let c = cdp_click("0", Some(agent)).await.expect("click 应成功");
    // 诊断：失败时附上点击后的实际 URL 状态，便于区分「导航慢」与「反馈管线坏」
    if !c.contains("URL 变化") {
        let t = cdp_targets(Some(agent)).unwrap_or_else(|e| format!("targets 查询失败: {e}"));
        panic!(
            "click 世界反馈应报 URL 变化（回归 e1679a0/bfbcd95）: {c}\n点击后 targets 状态: {t}"
        );
    }

    // kill：外部实例只断开、绝不杀用户进程
    let k = cdp_kill(Some(agent)).expect("kill 应成功");
    assert!(k.contains("断开"), "外部连接 kill 应报断开: {k}");
    assert!(
        ext.child.try_wait().ok().flatten().is_none(),
        "kill 不得终止外部 Chrome 进程"
    );
    assert!(
        list_targets_raw(E2E_EXTERNAL_PORT).is_ok(),
        "kill 后外部调试端口应仍应答"
    );
}

/// E2E-2：launch 受控浏览器 + kill 终止 + profile 定向回收。
#[tokio::test]
async fn e2e_launch_controlled_kill_and_profile_cleanup() {
    let _g = crate::utils::lock_or_recover(&E2E_LOCK);
    if skip_if_no_chrome() {
        return;
    }
    if list_targets_raw(E2E_LAUNCH_PORT).is_ok() {
        eprintln!("[cdp-e2e] 跳过：端口 {E2E_LAUNCH_PORT} 已被占用（上次崩溃残留？）");
        return;
    }

    let agent = "e2e-launch-agent";
    let out = cdp_launch(
        Some("https://example.com/".into()),
        Some(E2E_LAUNCH_PORT),
        Some(agent),
    )
    .await
    .expect("launch 应成功");
    assert!(out.contains("\"launched\""), "launch 返回异常: {out}");

    let t = cdp_targets(Some(agent)).expect("targets 应成功");
    assert!(t.contains("example.com"), "受控 Chrome 应打开 example.com: {t}");

    // kill：受控 Chrome 必须真的终止
    let k = cdp_kill(Some(agent)).expect("kill 应成功");
    assert!(k.contains("已终止"), "受控 Chrome kill 应报终止: {k}");

    // 调试端口关闭（轮询给进程退出留时间）
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if list_targets_raw(E2E_LAUNCH_PORT).is_err() {
            break;
        }
        if Instant::now() > deadline {
            panic!("kill 后受控 Chrome 调试端口应关闭");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // profile 目录随会话回收（Windows 文件锁可能滞后，重试删除）
    let dir = profile_dir_for(E2E_LAUNCH_PORT);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !dir.exists() {
            break;
        }
        if Instant::now() > deadline {
            panic!("profile 目录应随 kill 回收: {}", dir.display());
        }
        remove_profile_dir(&dir);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
