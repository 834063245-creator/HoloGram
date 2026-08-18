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
// 无 Chrome 环境（CI 容器等）自动跳过；全部测试用共享锁串行。
// 端口：9444（外部实例）/ 9445（受控 launch）/ 9446（round2）/ 9447（round3），
// 避开 app 的 9222 / 9223-9238。

use super::*;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// e2e 测试互斥（共享真实 Chrome/端口/profile），也与触碰
/// SESSIONS 全局的单元测试共存（不同 agent key + 锁内完成）。
static E2E_LOCK: Mutex<()> = Mutex::new(());

const E2E_EXTERNAL_PORT: u16 = 9444;
const E2E_LAUNCH_PORT: u16 = 9445;
const E2E_NAV_PORT: u16 = 9446;
const E2E_HEADLESS_PORT: u16 = 9447;
const E2E_ACCOUNT_A_PORT: u16 = 9448;
const E2E_ACCOUNT_B_PORT: u16 = 9449;
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
            // 测试进程下可见窗口可能被 Chrome 判为 occluded/backgrounded →
            // 渲染进程被节流，合成点击被丢弃（e2e-1 整租跑实测 ~50% 点击不导航）。
            // 禁掉这两个节流，保证渲染进程始终活跃接收输入。
            .arg("--disable-backgrounding-occluded-windows")
            .arg("--disable-renderer-backgrounding")
            .arg(url);
        // 刻意不设 NO_WINDOW：模拟"用户自己的浏览器"= 可见窗口。
        // （隐藏窗口里链接激活可能被吞——见 e2e 测试注释。）
        let child = cmd.spawn().ok()?;
        Some(Self { child, profile })
    }
}

impl Drop for ExternalChrome {
    fn drop(&mut self) {
        // 整树终止：只杀主进程会留孤儿子进程锁住 profile（e2e 残留目录根因）
        kill_chrome_tree(&mut self.child);
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

/// 本地 HTTP 服务：给 round3 e2e 提供可观察的真实网络事件。
/// 逐连接读完整请求头再响应；单连接错误只丢弃该连接，绝不拖垮服务器
/// （Chrome 投机/分片连接一发 RST 就 break，会让后续导航 ERR_CONNECTION_ABORTED
///  或页面 DOM 空——external/round3 曾在整租跑时相继挂掉）。
fn spawn_local_http_server() -> (u16, std::thread::JoinHandle<()>, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind 本地 e2e HTTP 端口");
    listener.set_nonblocking(true).expect("set nonblocking");
    let port = listener.local_addr().expect("读取端口").port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = Arc::clone(&stop);
    let handle = std::thread::spawn(move || {
        while !stop2.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => serve_local_http(&mut stream),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => {
                    // accept 层面错误（本地 listener 上极罕见）：退避重试而不是
                    // break 退出——服务器一死后续导航全部失败。
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
    });
    (port, handle, stop)
}

/// 读完整请求头（到空行）再响应。Windows 上 accept 出的 socket 继承监听
/// socket 的非阻塞态：单次 read 可能只拿回一部分请求头或直接 WouldBlock，
/// 必须循环累积到 `\r\n\r\n`；Chrome 投机连接的 RST 只丢弃本连接。
fn serve_local_http(stream: &mut TcpStream) {
    use std::io::{ErrorKind, Read, Write};
    // 客户端迟迟不把请求头发完（投机连接常见）就给个上限，别把服务器拖死。
    let deadline = Instant::now() + Duration::from_millis(1000);
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break, // 客户端关闭
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n")
                    || buf.windows(2).any(|w| w == b"\n\n")
                {
                    break; // 请求头读完
                }
            }
            Err(ref e) if e.kind() == ErrorKind::WouldBlock => {} // 还没发来，继续等
            Err(_) => break,                                      // RST 等 → 丢弃本连接
        }
        if Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let head = String::from_utf8_lossy(&buf);
    let path = head.split_whitespace().nth(1).unwrap_or("/");
    let (status, content_type, body): (&str, &str, &str) = match path {
        "/api.json" => ("200 OK", "application/json", r#"{"ok":true}"#),
        "/favicon.ico" => ("204 No Content", "text/plain", ""),
        // /page2：供 external 全流程测试点击链接后导航（替代真实外网站点，
        // 消除 example.com/iana.org 的网络依赖——外网慢/被墙会让 URL 变化
        // 检测在窗口内失败，测试变脆）。
        "/page2" => (
            "200 OK",
            "text/html; charset=utf-8",
            r#"<!doctype html><html><head><meta charset="utf-8"><title>External E2E Page 2</title></head><body><h1>Page Two</h1></body></html>"#,
        ),
        _ => (
            "200 OK",
            "text/html; charset=utf-8",
            r#"<!doctype html><html><head><meta charset="utf-8"><title>Round3 E2E</title>
<script>window.addEventListener('load', () => { fetch('/api.json').then((r) => r.json()).then(() => { window.__fetched = true; }); });</script>
</head><body><button id="icon-btn" aria-label="AX icon button">⚙</button>
<a href="/page2">Learn more</a></body></html>"#,
        ),
    };
    let resp = format!(
        "HTTP/1.1 {status}
Content-Type: {content_type}
Content-Length: {}
Connection: close

{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
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
    let (http_port, _server, _stop) = spawn_local_http_server();
    let external_url = format!("http://127.0.0.1:{http_port}/");
    let Some(mut ext) = ExternalChrome::spawn(&external_url) else {
        eprintln!("[cdp-e2e] 跳过：外部 Chrome 启动失败");
        return;
    };
    if !wait_port_up(E2E_EXTERNAL_PORT, Duration::from_secs(10)) {
        eprintln!("[cdp-e2e] 跳过：调试端口未在 10s 内就绪");
        return;
    }

    let agent = "e2e-connect-agent";

    // connect
    let out = cdp_connect(E2E_EXTERNAL_PORT, None, Some(agent)).expect("connect 应成功");
    assert!(out.contains("\"connected\""), "connect 返回异常: {out}");

    // targets：应看到本地页面（页面加载可能滞后，轮询等）
    let mut target_id: Option<String> = None;
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let t = cdp_targets(Some(agent)).expect("targets 应成功");
            let v: Value = serde_json::from_str(&t).expect("targets 返回应可解析");
            let pages = v["targets"].as_array().expect("targets 应含 targets 数组");
            if let Some(p) = pages.iter().find(|p| p["url"].as_str().unwrap_or("").contains("127.0.0.1")) {
                target_id = Some(p["id"].as_str().unwrap_or("").to_string());
                break;
            }
            if Instant::now() > deadline {
                panic!("外部实例应打开本地测试页面: {t}");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    let target_id = target_id.expect("轮询应已取到 target id");

    // attach
    let a = cdp_attach(&target_id, Some(agent)).expect("attach 应成功");
    assert!(a.contains("\"attached\":true"), "attach 返回异常: {a}");

    // snapshot：本地页面有一个 "Learn more" 链接。不能硬编码 ref 0——
    // AX 树顺序里 body/容器可能排前面（原 example.com 恰好第一个交互元素是
    // 链接才碰巧成立）；真实 agent 行为是从 refs 里按 name 找目标再点。
    let mut link_ref: Option<String> = None;
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let s = cdp_snapshot(Some("body".into()), Some(20), Some(0), Some(agent))
                .await
                .expect("snapshot 应成功");
            let vs: Value = serde_json::from_str(&s).expect("snapshot 返回应可解析");
            link_ref = vs["refs"]
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|r| {
                            r["name"]
                                .as_str()
                                .map(|n| n.contains("Learn more"))
                                .unwrap_or(false)
                        })
                        .and_then(|r| r["ref"].as_i64())
                })
                .map(|r| r.to_string());
            if link_ref.is_some() {
                break;
            }
            if Instant::now() > deadline {
                panic!("snapshot 应含 Learn more 链接: {s}");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    let link_ref = link_ref.expect("轮询应已取到 Learn more 链接 ref");

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

    // click ref → 导航到 /page2，世界反馈必须报 URL 变化。
    // 满载/冷启动时渲染进程可能吞掉合成点击（整租跑实测偶发），cdp_click
    // 一次没触发导航就重试；重试后仍无 URL 变化才判失败（回归 e1679a0/bfbcd95）。
    let mut click_attempt = 0;
    loop {
        click_attempt += 1;
        let c = cdp_click(&link_ref, Some(agent)).await.expect("click 应成功");
        if c.contains("URL 变化") {
            break;
        }
        if click_attempt >= 3 {
            let t =
                cdp_targets(Some(agent)).unwrap_or_else(|e| format!("targets 查询失败: {e}"));
            panic!(
                "click 世界反馈应报 URL 变化（回归 e1679a0/bfbcd95，{click_attempt} 次点击仍无导航）: {c}\n点击后 targets 状态: {t}"
            );
        }
        // 重试前给系统一个喘息；页面没动过，data-hg-ref 仍指向链接。
        tokio::time::sleep(Duration::from_millis(500)).await;
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
        None,
        None,
        None,
        None,
        None,
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

    // profile 目录随会话回收（Windows 文件锁可能滞后：kill 只杀主进程，
    // renderer/gpu/crashpad 子进程异步退出，句柄释放需要时间——重试删除，
    // 窗口放宽到 10s）。
    let dir = profile_dir_for(E2E_LAUNCH_PORT);
    let deadline = Instant::now() + Duration::from_secs(10);
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
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Hologram CDP E2E Page A</title>
<script>window.addEventListener('keydown', (e) => { if (e.key === 'a' && e.ctrlKey) window.__combo = 'ctrl+a'; });
window.addEventListener('load', () => { document.getElementById('hover-zone').addEventListener('mouseenter', () => { window.__hovered = true; }); });</script></head>
<body><main id="content"><h1>Page A</h1><p id="body-text">Hello content probe</p></main>
<input id="name" value="old value"><select id="choice"><option value="a">Option A</option><option value="b">Option B</option></select>
<input type="file" id="upload"><div id="hover-zone" style="width:120px;height:40px">hover me</div></body></html>"#,
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
    let out = cdp_launch(Some(page_a_url.clone()), Some(E2E_NAV_PORT), None, None, None, None, None, Some(agent))
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

    // hover：mouseMoved 应触发真实 mouseenter。
    let hov = cdp_hover("#hover-zone", Some(agent)).await.expect("hover 应成功");
    assert!(hov.contains(r#""hovered""#), "hover 返回异常: {hov}");
    let hovered = runtime_evaluate("window.__hovered === true", Some(agent))
        .await
        .expect("读 hover 标记");
    assert_eq!(hovered.as_bool(), Some(true), "hover 后 mouseenter 应触发");

    // 组合键：Ctrl+A 主键事件必须带 ctrlKey。
    // label 恒为规范名 "control+a"（actions.rs parse_modifiers 把 ctrl→Control 再小写），
    // 断言用 control 而非 ctrl——"control+a" 不含子串 "ctrl"（曾因跳过守卫掩盖未触发）。
    let combo = cdp_press("a", Some(vec!["ctrl".into()]), Some(agent))
        .await
        .expect("组合键应成功");
    assert!(combo.contains("control"), "组合键返回异常: {combo}");
    let combo_state = runtime_evaluate("window.__combo", Some(agent))
        .await
        .expect("读组合键标记");
    assert_eq!(combo_state.as_str(), Some("ctrl+a"), "页面应收到 ctrlKey=true 的 a 键");

    // upload：selector 回退路径 DOM.setFileInputFiles。
    let upload_file = dir.join("upload.txt");
    std::fs::write(&upload_file, "e2e upload").expect("写 upload 文件");
    let up = cdp_upload(
        Some("#upload".into()),
        vec![upload_file.to_string_lossy().to_string()],
        Some(agent),
    )
    .await
    .expect("upload 应成功");
    assert!(up.contains(r#""via":"selector""#), "upload 应走 selector 回退: {up}");
    let uploaded = runtime_evaluate(
        "document.getElementById('upload').files.length + ':' + document.getElementById('upload').files[0].name",
        Some(agent),
    )
    .await
    .expect("读 upload files");
    assert_eq!(uploaded.as_str(), Some("1:upload.txt"), "input.files 应为注入文件");

    // dialog：observer 捕获 javascriptDialogOpening，handle 后页面继续执行。
    let _ = cdp_eval(
        "setTimeout(() => { alert('e2e dialog'); window.__dialogDone = true; }, 50)",
        Some(agent),
    )
    .await
    .expect("调度 alert");
    {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let d = cdp_dialogs(Some(agent), Some(10));
            let vd: Value = serde_json::from_str(&d).expect("dialog 查询应可解析");
            if vd["pending"].as_bool().unwrap_or(false) {
                break;
            }
            if Instant::now() > deadline {
                panic!("observer 应在 5s 内捕获 dialog 事件: {d}");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    let handled = cdp_handle_dialog(true, None, Some(agent))
        .await
        .expect("dialog accept 应成功");
    assert!(handled.contains(r#""handled":true"#), "dialog 返回异常: {handled}");
    let dialog_done = runtime_evaluate("window.__dialogDone === true", Some(agent))
        .await
        .expect("读 dialog 完成标记");
    assert_eq!(dialog_done.as_bool(), Some(true), "alert 处理完后页面脚本应继续");

    // screenshot：fullPage + inline data URL。
    let shot = cdp_screenshot(true, true, Some(agent))
        .await
        .expect("screenshot 应成功");
    let vshot: Value = serde_json::from_str(&shot).expect("screenshot 返回应可解析");
    assert_eq!(vshot["fullPage"].as_bool(), Some(true));
    assert_eq!(vshot["inline"].as_bool(), Some(true));
    assert!(
        vshot["dataUrl"].as_str().unwrap_or("").starts_with("data:image/png;base64,"),
        "inline 截图应返回 data URL: {shot}"
    );

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

    // tab 管理：新开 tab 自动 attach；关闭当前 attach tab 后会话回到未 attach。
    let nt = cdp_new_tab(Some(page_a_url.clone()), Some(agent))
        .await
        .expect("new_tab 应成功");
    let vnt: Value = serde_json::from_str(&nt).expect("new_tab 返回应可解析");
    let new_tab_id = vnt["targetId"].as_str().expect("new_tab 应返回 targetId").to_string();
    wait_page_ready(agent).await;
    let new_h1 = runtime_evaluate("document.querySelector('h1').textContent", Some(agent))
        .await
        .expect("读新 tab 标题");
    assert_eq!(new_h1.as_str(), Some("Page A"), "new_tab 后应自动 attach 到新页面");
    let closed = cdp_close_tab(&new_tab_id, Some(agent)).expect("close_tab 应成功");
    assert!(closed.contains(r#""closed":true"#), "close_tab 返回异常: {closed}");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let targets = cdp_targets(Some(agent)).expect("targets 应成功");
        let vt: Value = serde_json::from_str(&targets).expect("targets 返回应可解析");
        let still_there = vt["targets"]
            .as_array()
            .map(|arr| arr.iter().any(|t| t["id"].as_str() == Some(new_tab_id.as_str())))
            .unwrap_or(false);
        if !still_there {
            break;
        }
        if Instant::now() > deadline {
            panic!("close_tab 后 target 应消失: {targets}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

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


/// E2E-4：第三批 round3 —— headless/windowSize 启动 + network 配对/详情 + AX snapshot。
/// 本地 HTTP 服务提供真实网络事件；file:// 页面不可靠地产生 Network 事件，
/// 所以这里起 127.0.0.1 服务。Linux 无 Chrome 时整段跳过（与其他 e2e 相同）。
#[tokio::test]
async fn e2e_headless_window_network_and_ax_snapshot() {
    let _g = crate::utils::lock_or_recover(&E2E_LOCK);
    if skip_if_no_chrome() {
        return;
    }
    if list_targets_raw(E2E_HEADLESS_PORT).is_ok() {
        eprintln!("[cdp-e2e] 跳过：端口 {E2E_HEADLESS_PORT} 已被占用（上次崩溃残留？）");
        return;
    }
    let (http_port, server, stop) = spawn_local_http_server();
    let page_url = format!("http://127.0.0.1:{http_port}/");

    let agent = "e2e-round3-agent";
    let out = cdp_launch(
        Some(page_url.clone()),
        Some(E2E_HEADLESS_PORT),
        Some(true),
        Some((800, 600)),
        None,
        None,
        None,
        Some(agent),
    )
    .await
    .expect("headless launch 应成功");
    let v: Value = serde_json::from_str(&out).expect("launch 返回应可解析");
    assert_eq!(v["headless"].as_bool(), Some(true), "launch 应回显 headless: {out}");
    assert_eq!(
        v["windowSize"]["width"].as_u64(),
        Some(800),
        "launch 应回显 windowSize: {out}"
    );

    // 第四批跨平台 discover：真实进程表必须能看到刚 launch 的 9447。
    // Windows 走 PowerShell，macOS/Linux 走 ps；任一路径失败都会在这里暴露。
    {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let disc = cdp_discover().expect("discover 应成功");
            let vd: Value = serde_json::from_str(&disc).expect("discover 返回应可解析");
            let seen = vd["instances"]
                .as_array()
                .map(|arr| arr.iter().any(|i| i["port"].as_u64() == Some(E2E_HEADLESS_PORT as u64)))
                .unwrap_or(false);
            if seen {
                break;
            }
            if Instant::now() > deadline {
                panic!("discover 应发现受控 Chrome 端口 {E2E_HEADLESS_PORT}: {disc}");
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }

    let target_id = wait_target_with_url(agent, "127.0.0.1", Duration::from_secs(10)).await;
    let a = cdp_attach(&target_id, Some(agent)).expect("attach 应成功");
    assert!(a.contains("\"attached\":true"), "attach 返回异常: {a}");

    // attach 后再导航一次：保证网络事件发生在 observer 已订阅之后。
    // 同一 URL 的导航 Chrome 可能去重/静默跳过（不重新触发 load → 无网络事件，
    // observer 缓冲为空的整租跑实测），用带 cache-bust 查询的 URL 强制真导航；
    // 页面内 fetch('/api.json') 是绝对路径，不受页面查询串影响。
    let busted = format!("{page_url}?hg_e2e_reload={}", std::process::id());
    let n = cdp_navigate(&busted, Some(agent)).await.expect("navigate 应成功");
    assert!(n.contains("navigated"), "navigate 应返回本次导航目标: {n}");
    wait_page_ready(agent).await;

    // 等页面 fetch 完成；然后 network 查询必须能按 requestId 拿到配对详情。
    // 窗口放宽到 20s：满载/冷启动时页面 reload + fetch 可能明显慢于 10s
    // （整租跑实测踩过 10s 卡线）。
    {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let fetched = runtime_evaluate("window.__fetched === true", Some(agent))
                .await
                .map(|v| v.as_bool().unwrap_or(false))
                .unwrap_or(false);
            if fetched {
                break;
            }
            if Instant::now() > deadline {
                panic!("页面 fetch 未在 20s 内完成");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    let (request_id, request_url) = {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let net = cdp_network(Some(agent), Some(50));
            let vn: Value = serde_json::from_str(&net).expect("network 返回应可解析");
            if let Some(entry) = vn["entries"]
                .as_array()
                .and_then(|arr| arr.iter().find(|e| e["url"].as_str().unwrap_or("").contains("/api.json")))
            {
                break (
                    entry["requestId"].as_str().expect("network 条目应含 requestId").to_string(),
                    entry["url"].as_str().unwrap_or("").to_string(),
                );
            }
            if Instant::now() > deadline {
                panic!("network 缓冲应在 15s 内观察到 /api.json 请求: {net}");
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let detail = cdp_network_detail(&request_id, Some(agent)).expect("network_detail 应成功");
    let vd: Value = serde_json::from_str(&detail).expect("network_detail 返回应可解析");
    assert_eq!(
        vd["entry"]["url"].as_str(),
        Some(request_url.as_str()),
        "detail 应返回完整请求 URL: {detail}"
    );
    assert_eq!(vd["entry"]["status"].as_u64(), Some(200), "detail 状态应为 200: {detail}");

    // 第四批 HAR 导出：写入临时目录的 HAR 文件必须可读且含已观察请求。
    let har_out = cdp_network_har(Some(agent), Some(50)).expect("network_har 应成功");
    let vh: Value = serde_json::from_str(&har_out).expect("network_har 返回应可解析");
    let har_path = vh["path"].as_str().expect("network_har 应返回 path").to_string();
    let har_bytes = vh["bytes"].as_u64().expect("network_har 应返回 bytes");
    assert!(har_bytes > 0, "HAR 文件不应为空: {har_out}");
    let har_text = std::fs::read_to_string(&har_path).expect("HAR 文件应可读");
    let har_json: Value = serde_json::from_str(&har_text).expect("HAR 文件应为合法 JSON");
    assert_eq!(har_json["log"]["version"], "1.2");
    assert!(
        har_json["log"]["entries"]
            .as_array()
            .map(|arr| arr.iter().any(|e| e["request"]["url"].as_str().unwrap_or("").contains("/api.json")))
            .unwrap_or(false),
        "HAR 应包含 /api.json 请求: {har_text}"
    );

    // AX snapshot：真实 Chrome 应走 Accessibility.getFullAXTree 并带 role/name。
    let snap = cdp_snapshot(None, Some(50), Some(0), Some(agent))
        .await
        .expect("snapshot 应成功");
    let vs: Value = serde_json::from_str(&snap).expect("snapshot 返回应可解析");
    assert_eq!(vs["source"].as_str(), Some("ax"), "真实 Chrome 应优先走 AX 树: {snap}");
    let found = vs["refs"]
        .as_array()
        .map(|arr| {
            arr.iter().any(|r| {
                r["role"].as_str() == Some("button")
                    && r["name"].as_str().unwrap_or("").contains("AX icon button")
            })
        })
        .unwrap_or(false);
    assert!(found, "AX snapshot 应含 button 的可访问名称: {snap}");

    // windowSize 只做存在性验证：不同 Chrome 版本的 headless 视口可能减去
    // 设备缩放/滚动条，这里锁「窗口确实开了」而不锁精确像素。
    let viewport = runtime_evaluate("({ w: innerWidth, h: innerHeight })", Some(agent))
        .await
        .expect("读视口应成功");
    assert!(
        viewport["w"].as_u64().unwrap_or(0) > 0 && viewport["h"].as_u64().unwrap_or(0) > 0,
        "headless 视口应可用: {viewport}"
    );

    // Emulation.setDeviceMetricsOverride：视口覆盖应立刻反映到 innerWidth/innerHeight。
    let vp = cdp_set_viewport(640, 480, Some(2.0), Some(false), Some(agent))
        .await
        .expect("viewport 应成功");
    assert!(vp.contains(r#""width":640"#), "viewport 返回异常: {vp}");
    // DPR 生效比 w/h 慢一拍：devicePixelRatio 由合成器重算，命令返回后立即读
    // 会拿旧值（1.0）——Chrome 151 headless 实测。轮询等到 2，w/h 每轮都断言。
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let inner = runtime_evaluate("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })", Some(agent))
            .await
            .expect("读覆盖后视口应成功");
        assert_eq!(inner["w"].as_i64(), Some(640), "Emulation 后 innerWidth 应为 640: {inner}");
        assert_eq!(inner["h"].as_i64(), Some(480), "Emulation 后 innerHeight 应为 480: {inner}");
        if inner["dpr"].as_f64() == Some(2.0) {
            break;
        }
        if Instant::now() > deadline {
            panic!("Emulation 后 devicePixelRatio 应在 5s 内轮询到 2: {inner}");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let k = cdp_kill(Some(agent)).expect("kill 应成功");
    assert!(k.contains("已终止"), "受控 Chrome kill 应报终止: {k}");
    stop.store(true, Ordering::SeqCst);
    let _ = server.join();
}

/// E2E-5（第五批）：具名 profile 多账号隔离 + cookie list/set/delete + switch。
/// 两个账号 slot 各自独立 Chrome profile；A 写入的 cookie 在 B 不可见，
/// switch 回 A 后仍可见，delete 后消失。无 Chrome 环境自动跳过。
#[tokio::test]
async fn e2e_multi_account_profiles_and_cookies() {
    let _g = crate::utils::lock_or_recover(&E2E_LOCK);
    if skip_if_no_chrome() {
        return;
    }
    if list_targets_raw(E2E_ACCOUNT_A_PORT).is_ok()
        || list_targets_raw(E2E_ACCOUNT_B_PORT).is_ok()
    {
        eprintln!("[cdp-e2e] 跳过：账号 e2e 端口已被占用（上次崩溃残留？）");
        return;
    }

    let (http_port, server, stop) = spawn_local_http_server();
    let page_url = format!("http://127.0.0.1:{http_port}/");
    let agent = "e2e-account-agent";
    let profile_a = "e2e-account-a";
    let profile_b = "e2e-account-b";
    let dir_a = named_profile_dir(profile_a);
    let dir_b = named_profile_dir(profile_b);
    remove_profile_dir(&dir_a);
    remove_profile_dir(&dir_b);

    // 账号 A：具名 profile 启动并种 cookie。
    let out_a = cdp_launch(
        Some(page_url.clone()),
        Some(E2E_ACCOUNT_A_PORT),
        Some(true),
        None,
        Some(profile_a.into()),
        None,
        None,
        Some(agent),
    )
    .await
    .expect("账号 A launch 应成功");
    let va: Value = serde_json::from_str(&out_a).expect("账号 A launch 返回应可解析");
    assert_eq!(va["slot"].as_str(), Some(profile_a), "账号 A 应回显 slot: {out_a}");

    let target_a = wait_target_with_url(agent, "127.0.0.1", Duration::from_secs(10)).await;
    cdp_attach(&target_a, Some(agent)).expect("账号 A attach 应成功");
    wait_page_ready(agent).await;

    let set = cdp_cookies(
        "set", None, Some(page_url.clone()), Some("acct".into()), Some("A".into()),
        None, None, None, None, None, None, Some(agent),
    )
    .await
    .expect("账号 A set cookie 应成功");
    assert!(set.contains(r#""set":true"#), "set cookie 返回异常: {set}");

    // 账号 B：第二个具名 profile 启动后成为活跃 slot。
    let out_b = cdp_launch(
        Some(page_url.clone()),
        Some(E2E_ACCOUNT_B_PORT),
        Some(true),
        None,
        Some(profile_b.into()),
        None,
        None,
        Some(agent),
    )
    .await
    .expect("账号 B launch 应成功");
    let vb: Value = serde_json::from_str(&out_b).expect("账号 B launch 返回应可解析");
    assert_eq!(vb["slot"].as_str(), Some(profile_b), "账号 B 应回显 slot: {out_b}");

    let target_b = wait_target_with_url(agent, "127.0.0.1", Duration::from_secs(10)).await;
    cdp_attach(&target_b, Some(agent)).expect("账号 B attach 应成功");
    wait_page_ready(agent).await;

    let list_b = cdp_cookies(
        "list", Some(vec![page_url.clone()]), None, None, None, None, None, None,
        None, None, None, Some(agent),
    )
    .await
    .expect("账号 B list cookie 应成功");
    assert!(
        !list_b.contains(r#""name":"acct""#),
        "账号 B 不得看到账号 A 的 cookie（profile 隔离失败）: {list_b}"
    );

    // switch 回 A：cookie 应仍在（具名 profile 持久 + 会话隔离）。
    let sw = cdp_switch_session(Some(profile_a.into()), Some(agent)).expect("切回账号 A 应成功");
    assert!(sw.contains(r#""status":"switched""#), "switch 返回异常: {sw}");
    let list_a = cdp_cookies(
        "list", Some(vec![page_url.clone()]), None, None, None, None, None, None,
        None, None, None, Some(agent),
    )
    .await
    .expect("账号 A list cookie 应成功");
    assert!(
        list_a.contains(r#""name":"acct""#),
        "切回账号 A 应看到之前写入的 cookie: {list_a}"
    );

    let del = cdp_cookies(
        "delete", None, Some(page_url.clone()), Some("acct".into()), None,
        None, None, None, None, None, None, Some(agent),
    )
    .await
    .expect("账号 A delete cookie 应成功");
    assert!(del.contains(r#""deleted":true"#), "delete cookie 返回异常: {del}");

    // 收尾：两个受控 Chrome 都 kill；具名 profile 目录由测试自行清理。
    cdp_kill(Some(agent)).expect("kill 账号 A 应成功");
    cdp_switch_session(Some(profile_b.into()), Some(agent)).expect("切到账号 B 应成功");
    cdp_kill(Some(agent)).expect("kill 账号 B 应成功");
    remove_profile_dir(&dir_a);
    remove_profile_dir(&dir_b);
    stop.store(true, Ordering::SeqCst);
    let _ = server.join();
}
