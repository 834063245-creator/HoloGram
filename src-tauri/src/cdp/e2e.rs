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
//   - 二轮评审第一批：navigate/back/forward/reload + content 分页 +
//     type(replace) + select（value/option 文本）
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
const E2E_NAV_PORT: u16 = 9446;
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

/// 等待 agent 会话的 targets 中出现 URL 含 needle 的页面，返回 target id。
async fn wait_target_with_url(agent: &str, needle: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        let t = cdp_targets(Some(agent)).expect("targets 应成功");
        let v: Value = serde_json::from_str(&t).expect("targets 返回应可解析");
        let pages = v["targets"].as_array().expect("targets 应含 targets 数组");
        if let Some(p) = pages.iter().find(|p| p["url"].as_str().unwrap_or("").contains(needle)) {
            return p["id"].as_str().unwrap_or("").to_string();
        }
        if Instant::now() > deadline {
            panic!("等待 target URL 含 {needle} 超时: {t}");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// 等待页面 readyState=complete，再留一点 settle 时间。
async fn wait_page_ready(agent: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let ready = runtime_evaluate("document.readyState", Some(agent))
            .await
            .map(|v| v.as_str() == Some("complete"))
            .unwrap_or(false);
        if ready {
            tokio::time::sleep(Duration::from_millis(300)).await;
            return;
        }
        if Instant::now() > deadline {
            panic!("页面未在 10s 内加载完成");
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// E2E-3：二轮评审第一批新动作全链路（本地 file:// 页面，零网络依赖）。
/// 覆盖：launch→attach→content(text/markdown/分页)→type(replace)→
///       select(value 与 option 文本)→navigate→back→forward→reload 真刷新。
#[tokio::test]
async fn e2e_navigation_content_forms_round2() {
    let _g = crate::utils::lock_or_recover(&E2E_LOCK);
    if skip_if_no_chrome() {
        return;
    }
    if list_targets_raw(E2E_NAV_PORT).is_ok() {
        eprintln!("[cdp-e2e] 跳过：端口 {E2E_NAV_PORT} 已被占用（上次崩溃残留？）");
        return;
    }

    // 构造两个本地页面；file:// 下相对链接与 history 行为与真实站点一致。
    let dir = std::env::temp_dir().join(format!("hologram-cdp-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建 e2e 页面目录");
    let page_a = dir.join("page-a.html");
    let page_b = dir.join("page-b.html");
    std::fs::write(
        &page_a,
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Hologram CDP E2E Page A</title></head>
<body><main id="content"><h1>Page A</h1><p id="body-text">Hello content probe</p></main>
<input id="name" value="old value"><select id="choice"><option value="a">Option A</option><option value="b">Option B</option></select></body></html>"#,
    )
    .expect("写 page-a");
    std::fs::write(
        &page_b,
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Hologram CDP E2E Page B</title></head>
<body><h1>Page B</h1><p id="body-text">Second page for navigation history</p></body></html>"#,
    )
    .expect("写 page-b");
    let page_a_url = url::Url::from_file_path(&page_a).expect("file URL 转换").to_string();
    let page_b_url = url::Url::from_file_path(&page_b).expect("file URL 转换").to_string();

    let agent = "e2e-round2-agent";
    let out = cdp_launch(Some(page_a_url.clone()), Some(E2E_NAV_PORT), Some(agent))
        .await
        .expect("launch 应成功");
    assert!(out.contains("\"launched\""), "launch 返回异常: {out}");

    let target_id = wait_target_with_url(agent, "page-a.html", Duration::from_secs(10)).await;
    let a = cdp_attach(&target_id, Some(agent)).expect("attach 应成功");
    assert!(a.contains("\"attached\":true"), "attach 返回异常: {a}");
    wait_page_ready(agent).await;

    // content：text 模式 + scope + title/url
    let c = cdp_content(
        Some("#content".into()),
        Some("text".into()),
        Some(1000),
        Some(0),
        Some(agent),
    )
    .await
    .expect("content text 应成功");
    let v: Value = serde_json::from_str(&c).expect("content 返回应可解析");
    assert_eq!(v["title"].as_str(), Some("Hologram CDP E2E Page A"));
    assert!(v["url"].as_str().unwrap_or("").contains("page-a.html"), "{c}");
    assert!(
        v["text"].as_str().unwrap_or("").contains("Hello content probe"),
        "text 正文应含页面文本: {c}"
    );

    // content：字符分页（第一页 8 字符，第二页从 offset 继续）
    let c1 = cdp_content(
        Some("#content".into()),
        Some("text".into()),
        Some(8),
        Some(0),
        Some(agent),
    )
    .await
    .expect("content 分页第一页应成功");
    let v1: Value = serde_json::from_str(&c1).expect("content 返回应可解析");
    assert!(v1["truncated"].as_bool().unwrap_or(false), "第一页应截断: {c1}");
    let c2 = cdp_content(
        Some("#content".into()),
        Some("text".into()),
        Some(1000),
        Some(8),
        Some(agent),
    )
    .await
    .expect("content 分页第二页应成功");
    let v2: Value = serde_json::from_str(&c2).expect("content 返回应可解析");
    assert!(
        v2["text"].as_str().unwrap_or("").contains("probe"),
        "offset 第二页应包含剩余正文: {c2}"
    );

    // content：markdown-lite（标题应转成 # 标题）
    let cm = cdp_content(
        None,
        Some("markdown".into()),
        Some(2000),
        Some(0),
        Some(agent),
    )
    .await
    .expect("content markdown 应成功");
    let vm: Value = serde_json::from_str(&cm).expect("content 返回应可解析");
    assert!(
        vm["markdown"].as_str().unwrap_or("").contains("# Page A"),
        "markdown-lite 应把 h1 转成 # 标题: {cm}"
    );

    // type(replace)：旧值必须被清掉，而不是 append。
    let t = cdp_type("#name", "fresh value", true, Some(agent))
        .await
        .expect("type replace 应成功");
    assert!(t.contains("\"replace\":true"), "type 返回应带 replace: {t}");
    let name = runtime_evaluate("document.getElementById('name').value", Some(agent))
        .await
        .expect("读 name 值");
    assert_eq!(name.as_str(), Some("fresh value"), "replace 后输入框值应为全新文本");

    // select：value 匹配，再切到可见文本匹配。
    let s1 = cdp_select("#choice", "b", Some(agent))
        .await
        .expect("select value 应成功");
    let vs1: Value = serde_json::from_str(&s1).expect("select 返回应可解析");
    assert_eq!(vs1["value"].as_str(), Some("b"));
    assert_eq!(vs1["selected"].as_str(), Some("Option B"));
    let choice = runtime_evaluate("document.getElementById('choice').value", Some(agent))
        .await
        .expect("读 choice 值");
    assert_eq!(choice.as_str(), Some("b"));
    let s2 = cdp_select("#choice", "Option A", Some(agent))
        .await
        .expect("select option 文本应成功");
    let vs2: Value = serde_json::from_str(&s2).expect("select 返回应可解析");
    assert_eq!(vs2["value"].as_str(), Some("a"));
    assert_eq!(vs2["selected"].as_str(), Some("Option A"));

    // navigate：跨页导航必须带世界变化反馈。
    let n = cdp_navigate(&page_b_url, Some(agent))
        .await
        .expect("navigate 应成功");
    assert!(n.contains("URL 变化"), "navigate 应报 URL 变化: {n}");
    let h1 = runtime_evaluate("document.querySelector('h1').textContent", Some(agent))
        .await
        .expect("读 page B 标题");
    assert_eq!(h1.as_str(), Some("Page B"));

    // back / forward：导航历史两条腿都走通。
    let b = cdp_back(Some(agent)).await.expect("back 应成功");
    assert!(b.contains("page-a.html"), "back 应回到 page-a: {b}");
    let f = cdp_forward(Some(agent)).await.expect("forward 应成功");
    assert!(f.contains("page-b.html"), "forward 应回到 page-b: {f}");

    // reload：页面内变量在新文档里消失，证明发生了真刷新（而不是 no-op 返回）。
    let marker = runtime_evaluate("window.__hgReloadMarker = 42", Some(agent))
        .await
        .expect("写入 reload marker");
    assert_eq!(marker.as_i64(), Some(42));
    let r = cdp_reload(Some(agent)).await.expect("reload 应成功");
    assert!(r.contains("\"reloaded\":true"), "reload 返回异常: {r}");
    let marker_after = runtime_evaluate("typeof window.__hgReloadMarker", Some(agent))
        .await
        .expect("读 reload 后 marker");
    assert_eq!(marker_after.as_str(), Some("undefined"), "reload 后旧 JS 变量应消失");

    // 收尾：受控 Chrome 终止；测试页目录尽力清理。
    let k = cdp_kill(Some(agent)).expect("kill 应成功");
    assert!(k.contains("已终止"), "受控 Chrome kill 应报终止: {k}");
    for _ in 0..5 {
        if std::fs::remove_dir_all(&dir).is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
