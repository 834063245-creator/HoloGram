// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// CDP (Chrome DevTools Protocol) 客户端 — 让 Agent 观察/操作外部 Chromium 页面。
//
// 设计原则（借鉴 HanaAgent computer-use 的设计思路，实现完全不同）：
//   - 短连接：每次调用建立 WS 连接，用完即关。本地回环开销可忽略，
//     避免长连接状态机（重连/心跳/事件流）的复杂度。
//   - 全链路超时兜底：connect/发送/等待全部包在 tokio timeout 里，
//     Runtime.evaluate 另带 CDP 层 5s 超时——页面死循环或主线程卡死
//     不会挂死 Agent 流。
//   - 语义化操作：模型只给 CSS selector，坐标由本模块从 getBoundingClientRect
//     计算，模型不接触裸坐标。
//   - 会话按 agent 键控：每个 Agent 自己的端口/attach/Chrome 进程，
//     多 Agent 互不干扰；无 agent_id 的调用共用 "default" 键。
//   - 结果截断：大结果防上下文爆炸。
//   - 只连 127.0.0.1；launch 用独立 profile，不碰用户日常 Chrome。
//
// 目标形态（快照 ref/持久连接/统一后端）见 docs/adr/0003-agent-browser-cdp-suite.md。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

// ═══════════════════════════════════════════════════════════
// 会话状态 — 按 agent 键控
// ═══════════════════════════════════════════════════════════

#[derive(Default)]
pub(crate) struct CdpSession {
    /// 当前连接的调试端口（launch 时确定）
    pub port: u16,
    /// 当前 attach 的 target id（None = 未 attach）
    pub target_id: Option<String>,
    /// launch 启动的受控 Chrome 子进程（用于 kill）
    pub chrome_child: Option<std::process::Child>,
}

/// 所有 Agent 的会话表。key = agent_id；无 agent_id 的调用共用 DEFAULT_SESSION_KEY。
static SESSIONS: LazyLock<Mutex<HashMap<String, CdpSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const DEFAULT_SESSION_KEY: &str = "default";

fn session_key(agent_id: Option<&str>) -> String {
    agent_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_SESSION_KEY)
        .to_string()
}

fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, CdpSession>> {
    crate::utils::lock_or_recover(&SESSIONS)
}

/// HoloGram 自家 webview 的调试端口（tauri.conf.json additionalBrowserArgs）。
/// 受控 Chrome 永远不许用这个端口——连上它等于把自家页面当外部页面操作。
const WEBVIEW_DEBUG_PORT: u16 = 9222;

/// 受控 Chrome 默认端口起点。必须避开 9222 —— 那是 HoloGram 自家 webview
/// 的调试端口（tauri.conf.json additionalBrowserArgs），占用会吞掉整个会话
/// （wait_for_port 误判就绪、targets 列出的全是自家页面）。占用则向后探测。
const DEFAULT_PORT_BASE: u16 = 9223;
const PORT_PROBE_LIMIT: u16 = 16;

/// 探测一个空闲端口（默认范围）。同进程其他 Agent 已占用的端口也算占用，
/// 堵住"两个 Agent 同时探测到同一端口"的竞态窗口。
fn probe_free_port() -> Result<u16, String> {
    for offset in 0..PORT_PROBE_LIMIT {
        let p = DEFAULT_PORT_BASE + offset;
        let occupied = {
            let sessions = lock_sessions();
            sessions.values().any(|s| s.port == p && s.chrome_child.is_some())
        };
        if !occupied && list_targets_raw(p).is_err() {
            return Ok(p);
        }
    }
    Err(format!(
        "默认端口 {DEFAULT_PORT_BASE}~{} 全部被占用，请显式指定 port 参数",
        DEFAULT_PORT_BASE + PORT_PROBE_LIMIT - 1
    ))
}

// ═══════════════════════════════════════════════════════════
// Chrome 启动
// ═══════════════════════════════════════════════════════════

/// 查找 Chrome 可执行文件（Windows 常见路径 + 环境变量覆盖）。
fn find_chrome() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("HOLOGRAM_CHROME") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let candidates = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 等待调试端口就绪（launch 后 Chrome 需要几百 ms 启动）。
async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if list_targets_raw(port).is_ok() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("CDP 端口 {port} 在 {timeout:?} 内未就绪"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 启动受控 Chrome（独立 profile）。已在运行则复用。返回端口。
pub(crate) async fn cdp_launch(
    url: Option<String>,
    port: Option<u16>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    // 已启动过且 Chrome 还活着 → 复用：
    //   - 未显式指定端口：直接复用本 agent 的现有端口；
    //   - 显式指定端口：与本 agent 现有端口一致且活着才复用。
    {
        let mut sessions = lock_sessions();
        let sess = sessions.entry(session_key(agent_id)).or_default();
        if sess.chrome_child.is_some() && sess.port != 0 && list_targets_raw(sess.port).is_ok() {
            let reuse = match port {
                None => true,
                Some(p) => p == sess.port,
            };
            if reuse {
                return Ok(json!({ "status": "reused", "port": sess.port, "url": url }).to_string());
            }
        }
    }

    let port = match port {
        // 9222 是自家 webview 的调试端口——受控 Chrome 用它会把自家页面
        // 当外部页面接管（wait_for_port 误判就绪、targets 全是自家页面）。
        Some(p) if p == WEBVIEW_DEBUG_PORT => {
            return Err(format!(
                "端口 {WEBVIEW_DEBUG_PORT} 是 HoloGram 自家 webview 的调试端口，不能用于受控浏览器。\
                 请用默认端口（{DEFAULT_PORT_BASE} 起）或指定其他端口"
            ));
        }
        Some(p) => p,
        None => probe_free_port()?,
    };

    let chrome = find_chrome().ok_or("未找到 Chrome/Edge。可设置环境变量 HOLOGRAM_CHROME 指定路径")?;
    // 独立 profile — 绝不污染用户日常 Chrome 的 cookie/登录态
    let profile_dir = std::env::temp_dir().join("hologram-browser-profile");

    let mut cmd = std::process::Command::new(&chrome);
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile_dir.to_string_lossy()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-features=TranslateUI");
    if let Some(u) = url {
        if !u.is_empty() {
            cmd.arg(&u);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::utils::NO_WINDOW);
    }
    let child = cmd.spawn().map_err(|e| format!("启动 Chrome 失败: {e}"))?;

    {
        let mut sessions = lock_sessions();
        let sess = sessions.entry(session_key(agent_id)).or_default();
        // 走到这里说明旧 Chrome 已退出或显式指定了不同端口——
        // 无论哪种，回收旧句柄并 kill 残留进程，避免双开。
        if let Some(mut old) = sess.chrome_child.take() {
            let exited = old.try_wait().map(|s| s.is_some()).unwrap_or(false);
            if !exited {
                let _ = old.kill();
                let _ = old.wait();
            }
        }
        sess.port = port;
        sess.chrome_child = Some(child);
    }

    wait_for_port(port, Duration::from_secs(10)).await?;
    Ok(json!({ "status": "launched", "port": port, "chrome": chrome.to_string_lossy() }).to_string())
}

/// 终止本 agent 的受控 Chrome。
pub(crate) fn cdp_kill(agent_id: Option<&str>) -> Result<String, String> {
    let mut sessions = lock_sessions();
    let sess = sessions.entry(session_key(agent_id)).or_default();
    if let Some(mut child) = sess.chrome_child.take() {
        let _ = child.kill();
        let _ = child.wait();
        sess.target_id = None;
        Ok("受控 Chrome 已终止".into())
    } else {
        Err("没有正在运行的受控 Chrome".into())
    }
}

// ═══════════════════════════════════════════════════════════
// target 发现与 attach
// ═══════════════════════════════════════════════════════════

/// GET http://127.0.0.1:port/json — 列出所有 target（原始 JSON）。
fn list_targets_raw(port: u16) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:{port}/json");
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_per_call(Some(Duration::from_secs(2)))
            .build(),
    );
    let resp = agent
        .get(&url)
        .call()
        .map_err(|e| format!("CDP /json 请求失败: {e}"))?;
    let mut body = resp.into_body();
    let text = body
        .read_to_string()
        .map_err(|e| format!("CDP /json 读取失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("CDP /json 解析失败: {e}"))
}

/// 列出所有页面 target（type=page），返回 [{id, title, url}]。
pub(crate) fn cdp_targets(agent_id: Option<&str>) -> Result<String, String> {
    let port = {
        let mut sessions = lock_sessions();
        sessions.entry(session_key(agent_id)).or_default().port
    };
    let raw = list_targets_raw(port)?;
    let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
    let pages: Vec<Value> = arr
        .iter()
        .filter(|t| t["type"] == "page")
        .map(|t| {
            json!({
                "id": t["id"].as_str().unwrap_or(""),
                "title": t["title"].as_str().unwrap_or(""),
                "url": t["url"].as_str().unwrap_or(""),
            })
        })
        .collect();
    Ok(json!({ "port": port, "targets": pages }).to_string())
}

/// attach 到指定 target id。后续 inspect/click/type 都作用于它。
pub(crate) fn cdp_attach(target_id: &str, agent_id: Option<&str>) -> Result<String, String> {
    let mut sessions = lock_sessions();
    let sess = sessions.entry(session_key(agent_id)).or_default();
    if sess.port == 0 {
        return Err("尚未 launch 浏览器。先调用 browser(launch) 或 browser(targets) 确认端口".into());
    }
    let raw = list_targets_raw(sess.port)?;
    let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
    // 只按 target id 精确匹配——URL 不是 target id，传 URL 会得到明确错误而非意外 attach
    let found = arr.iter().find(|t| t["id"].as_str() == Some(target_id));
    match found {
        Some(t) => {
            let id = t["id"].as_str().unwrap_or("").to_string();
            sess.target_id = Some(id.clone());
            Ok(json!({
                "attached": true,
                "targetId": id,
                "title": t["title"].as_str().unwrap_or(""),
                "url": t["url"].as_str().unwrap_or(""),
            })
            .to_string())
        }
        None => Err(format!(
            "target 不存在: {target_id}（先用 browser(targets) 查看可用 target，targetId 是 CDP target id 而非 URL）"
        )),
    }
}

// ═══════════════════════════════════════════════════════════
// WS 命令
// ═══════════════════════════════════════════════════════════

/// WS 命令全链路超时——connect/发送/等待响应任一步卡住都在此上限内返回错误。
const WS_TIMEOUT: Duration = Duration::from_secs(10);

fn require_target(agent_id: Option<&str>) -> Result<(u16, String), String> {
    let mut sessions = lock_sessions();
    let sess = sessions.entry(session_key(agent_id)).or_default();
    if sess.port == 0 {
        return Err("尚未 launch 浏览器".into());
    }
    let tid = sess
        .target_id
        .clone()
        .ok_or("未 attach target。先调用 browser(attach) 选择页面")?;
    Ok((sess.port, tid))
}

/// 通过 CDP WebSocket 发送一条命令，返回响应 JSON（含 result）。
async fn ws_command(port: u16, target_id: &str, method: &str, params: Value) -> Result<Value, String> {
    let fut = async {
        // 1. 从 /json 拿该 target 的 webSocketDebuggerUrl
        let raw = list_targets_raw(port)?;
        let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
        let ws_url = arr
            .iter()
            .find(|t| t["id"].as_str() == Some(target_id))
            .and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from))
            .ok_or_else(|| format!("target {target_id} 已消失（页面可能被关闭）"))?;

        // 2. 短连接：connect → send → 等匹配 id 的响应 → close
        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("CDP WS 连接失败: {e}"))?;

        let id: u64 = 1;
        let msg = json!({ "id": id, "method": method, "params": params }).to_string();
        ws.send(Message::text(msg))
            .await
            .map_err(|e| format!("CDP WS 发送失败: {e}"))?;

        loop {
            let reply = ws
                .next()
                .await
                .ok_or("CDP WS 连接关闭")?
                .map_err(|e| format!("CDP WS 接收失败: {e}"))?;
            match reply {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).map_err(|e| format!("CDP 响应解析失败: {e}"))?;
                    if v["id"].as_u64() == Some(id) {
                        let _ = ws.close(None).await;
                        if let Some(err) = v["error"].as_object() {
                            return Err(format!(
                                "CDP {} 错误: {}",
                                method,
                                err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown")
                            ));
                        }
                        return Ok(v);
                    }
                    // 非匹配 id 的消息（事件）忽略
                }
                _ => {}
            }
        }
    };
    tokio::time::timeout(WS_TIMEOUT, fut)
        .await
        .map_err(|_| format!("CDP {method} 超时（{WS_TIMEOUT:?} 无响应）——页面主线程可能卡死"))?
}

/// Runtime.evaluate 的 CDP 层超时（毫秒）——表达式死循环在此上限内被打断。
const EVAL_TIMEOUT_MS: u64 = 5000;

/// 在 target 内执行 JS 表达式，返回 result.value（JSON 字符串或值）。
async fn runtime_evaluate(expr: &str, agent_id: Option<&str>) -> Result<Value, String> {
    let (port, tid) = require_target(agent_id)?;
    let resp = ws_command(
        port,
        &tid,
        "Runtime.evaluate",
        json!({
            "expression": expr,
            "returnByValue": true,
            "awaitPromise": true,
            "timeout": EVAL_TIMEOUT_MS,
        }),
    )
    .await?;
    // 检查 exceptionDetails — 表达式抛错时 result 里只有 exception
    if let Some(exc) = resp["result"]["exceptionDetails"].as_object() {
        let text = exc
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("JS exception");
        let desc = exc
            .get("exception")
            .and_then(|e| e.get("description"))
            .and_then(|d| d.as_str())
            .unwrap_or("");
        // CDP 超时表现为 text=Timeout 的 exception——给出可行动的提示
        if text.to_lowercase().contains("timeout") {
            return Err(format!(
                "页面内 JS 执行超时（{EVAL_TIMEOUT_MS}ms）——表达式可能死循环或页面主线程卡死"
            ));
        }
        return Err(format!("页面内 JS 错误: {text} {desc}"));
    }
    Ok(resp["result"]["result"]["value"].clone())
}

// ═══════════════════════════════════════════════════════════
// 探针 JS — 独立文件，include_str! 嵌入（单一来源，见 ADR 0003 D4/D7）
// ═══════════════════════════════════════════════════════════

/// 元素检查探针。返回 JSON 数组字符串。
/// 语法由本文件底部的 #[cfg(test)] probes_are_valid_javascript 用 node --check 强制验证。
const INSPECT_PROBE: &str = include_str!("cdp/probes/inspect.js");

pub(crate) async fn cdp_inspect(
    selector: &str,
    props: Option<Vec<String>>,
    max_results: Option<usize>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    if selector.trim().is_empty() {
        return Err("inspect: selector 不能为空".into());
    }
    let expr = format!(
        "JSON.stringify(({})({}, {}, {}))",
        INSPECT_PROBE,
        serde_json::to_string(selector).map_err(|e| e.to_string())?,
        serde_json::to_string(&props.unwrap_or_default()).map_err(|e| e.to_string())?,
        max_results.unwrap_or(20)
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    let s = val.as_str().unwrap_or("[]").to_string();
    // 截断保护：超 8k 字符截断并提示
    const MAX: usize = 8000;
    if s.len() > MAX {
        Ok(format!("{}...[已截断，共 {} 字符]", &s[..MAX], s.len()))
    } else {
        Ok(s)
    }
}

// ═══════════════════════════════════════════════════════════
// 视觉 lint 探针 — report（对比度/间距/对齐/层级/溢出）
// ═══════════════════════════════════════════════════════════

/// 视觉检查探针。返回 {issues: [...], ok: bool} JSON。
const REPORT_PROBE: &str = include_str!("cdp/probes/report.js");

pub(crate) async fn cdp_report(scope: Option<String>, agent_id: Option<&str>) -> Result<String, String> {
    let expr = format!(
        "JSON.stringify(({})({}))",
        REPORT_PROBE,
        serde_json::to_string(&scope.unwrap_or_default()).map_err(|e| e.to_string())?
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    Ok(val.as_str().unwrap_or("{\"issues\":[],\"ok\":true}").to_string())
}

// ═══════════════════════════════════════════════════════════
// 操作 — click / type / press / scroll
// ═══════════════════════════════════════════════════════════

/// 取元素中心点坐标（viewport 相对）。返回 {x, y, found, visible}。
async fn element_center(selector: &str, agent_id: Option<&str>) -> Result<(f64, f64), String> {
    let expr = format!(
        r#"(() => {{ const el = document.querySelector({sel}); if (!el) return null; const r = el.getBoundingClientRect(); return {{ x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 }}; }})()"#,
        sel = serde_json::to_string(selector).map_err(|e| e.to_string())?
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    if val.is_null() {
        return Err(format!("click: selector 无匹配元素: {selector}"));
    }
    let x = val["x"].as_f64().ok_or("click: 无法读取 x")?;
    let y = val["y"].as_f64().ok_or("click: 无法读取 y")?;
    let visible = val["visible"].as_bool().unwrap_or(false);
    if !visible {
        return Err(format!("click: 元素不可见（可能被遮挡或隐藏）: {selector}。先 scroll 或换 selector"));
    }
    Ok((x, y))
}

/// 点击元素（中心点）。CDP Input.dispatchMouseEvent — 页面内派发，非 OS 级。
pub(crate) async fn cdp_click(selector: &str, agent_id: Option<&str>) -> Result<String, String> {
    let (x, y) = element_center(selector, agent_id).await?;
    let (port, tid) = require_target(agent_id)?;
    let base = json!({ "x": x, "y": y, "button": "left", "clickCount": 1 });
    let mut pressed = base.clone();
    pressed["type"] = json!("mousePressed");
    let mut released = base.clone();
    released["type"] = json!("mouseReleased");
    ws_command(port, &tid, "Input.dispatchMouseEvent", pressed).await?;
    ws_command(port, &tid, "Input.dispatchMouseEvent", released).await?;
    Ok(json!({ "clicked": selector, "x": x.round(), "y": y.round() }).to_string())
}

/// 输入文本（聚焦元素 + insertText）。中文/IME 友好。
pub(crate) async fn cdp_type(
    selector: &str,
    text: &str,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let focus_expr = format!(
        r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.focus(); return true; }})()"#,
        sel = serde_json::to_string(selector).map_err(|e| e.to_string())?
    );
    let ok = runtime_evaluate(&focus_expr, agent_id).await?;
    if !ok.as_bool().unwrap_or(false) {
        return Err(format!("type: selector 无匹配元素: {selector}"));
    }
    let (port, tid) = require_target(agent_id)?;
    ws_command(
        port,
        &tid,
        "Input.insertText",
        json!({ "text": text }),
    )
    .await?;
    Ok(json!({ "typed": text.chars().take(50).collect::<String>() }).to_string())
}

/// 按键（Enter/Tab/Escape/Backspace/方向键/单字符）。
/// 单字符按键必须携带 text 字段——React 受控输入等场景 keyDown 不带 text
/// 不会产生字符（P0-6）。
pub(crate) async fn cdp_press(key: &str, agent_id: Option<&str>) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    // CDP key 参数 — 常见键的映射（key_name, code, vk, text）
    let (key_name, code, vk, text): (&str, String, u32, Option<String>) = match key.to_lowercase().as_str() {
        "enter" => ("Enter", "Enter".into(), 13, None),
        "tab" => ("Tab", "Tab".into(), 9, None),
        "escape" | "esc" => ("Escape", "Escape".into(), 27, None),
        "backspace" => ("Backspace", "Backspace".into(), 8, None),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp".into(), 38, None),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown".into(), 40, None),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft".into(), 37, None),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight".into(), 39, None),
        "space" => (" ", "Space".into(), 32, None),
        "delete" | "del" => ("Delete", "Delete".into(), 46, None),
        "home" => ("Home", "Home".into(), 36, None),
        "end" => ("End", "End".into(), 35, None),
        "pageup" => ("PageUp", "PageUp".into(), 33, None),
        "pagedown" => ("PageDown", "PageDown".into(), 34, None),
        _ => {
            // 单字符直接按键。按字符数判（chars().count()）而非字节长——
            // 多字节字符（中文等）用 len() 会误判并走"不支持"分支。
            if key.chars().count() == 1 {
                let c = key.chars().next().expect("单字符按键必有且仅有一个字符");
                (
                    key,
                    format!("Key{}", c.to_ascii_uppercase()),
                    c.to_ascii_uppercase() as u32,
                    Some(key.to_string()),
                )
            } else {
                return Err(format!("不支持的按键: {key}（支持 Enter/Tab/Escape/Backspace/方向键/单字符）"));
            }
        }
    };
    let mut down = json!({ "type": "keyDown", "key": key_name, "code": code, "windowsVirtualKeyCode": vk });
    let mut up = json!({ "type": "keyUp", "key": key_name, "code": code, "windowsVirtualKeyCode": vk });
    if let Some(t) = text {
        down["text"] = json!(t);
        up["text"] = json!(t);
    }
    ws_command(port, &tid, "Input.dispatchKeyEvent", down).await?;
    ws_command(port, &tid, "Input.dispatchKeyEvent", up).await?;
    Ok(json!({ "pressed": key_name }).to_string())
}

/// 滚动：有 selector → 滚到元素可见；否则页面滚动 direction（down/up/top）。
pub(crate) async fn cdp_scroll(
    selector: Option<String>,
    direction: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    if let Some(sel) = selector {
        if !sel.trim().is_empty() {
            let expr = format!(
                r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.scrollIntoView({{ behavior: 'smooth', block: 'center' }}); return true; }})()"#,
                sel = serde_json::to_string(&sel).map_err(|e| e.to_string())?
            );
            let ok = runtime_evaluate(&expr, agent_id).await?;
            if !ok.as_bool().unwrap_or(false) {
                return Err(format!("scroll: selector 无匹配元素: {sel}"));
            }
            return Ok(json!({ "scrolled": "element", "selector": sel }).to_string());
        }
    }
    let dir = direction.unwrap_or("down".into());
    let delta_y = match dir.as_str() {
        "up" => -600.0,
        "top" => -100000.0,
        _ => 600.0,
    };
    ws_command(
        port,
        &tid,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseWheel", "x": 400, "y": 400, "deltaX": 0, "deltaY": delta_y }),
    )
    .await?;
    Ok(json!({ "scrolled": "page", "direction": dir }).to_string())
}

// ═══════════════════════════════════════════════════════════
// eval — 任意 JS（白名单限制）
// ═══════════════════════════════════════════════════════════

/// eval 静态白名单：禁止网络外联、存储写入、弹窗等。
/// 注：静态字符串匹配是纵深防御而非安全边界（eval 本身走权限 Ask），
/// 动态方法名等写法可绕过——P2 前措辞保持"基础拦截"。
fn check_eval_expr(expr: &str) -> Result<(), String> {
    let lower = expr.to_lowercase();
    let banned: &[(&str, &str)] = &[
        ("fetch(", "网络请求 fetch"),
        ("xmlhttprequest", "网络请求 XHR"),
        ("websocket", "网络请求 WebSocket"),
        ("navigator.sendbeacon", "网络请求 sendBeacon"),
        ("localstorage", "localStorage 访问"),
        ("sessionstorage", "sessionStorage 访问"),
        ("document.cookie", "cookie 访问"),
        ("indexeddb", "IndexedDB 访问"),
        ("window.open", "打开新窗口"),
        ("location.href=", "页面跳转"),
        ("location.assign", "页面跳转"),
        ("location.replace", "页面跳转"),
        ("location.reload", "页面刷新"),
        ("window.close", "关闭窗口"),
    ];
    for (pat, what) in banned {
        if lower.contains(pat) {
            return Err(format!("eval 表达式被拒绝：包含 {what}（白名单限制）。需要读 DOM/样式/几何请用 browser(inspect)，需要操作请用 click/type/scroll。"));
        }
    }
    Ok(())
}

/// 执行任意 JS（只读为主，白名单限制网络/存储/跳转）。
pub(crate) async fn cdp_eval(expr: &str, agent_id: Option<&str>) -> Result<String, String> {
    if expr.trim().is_empty() {
        return Err("eval: 表达式不能为空".into());
    }
    check_eval_expr(expr)?;
    let val = runtime_evaluate(expr, agent_id).await?;
    let s = match val {
        Value::String(s) => s,
        other => other.to_string(),
    };
    const MAX: usize = 4000;
    if s.len() > MAX {
        Ok(format!("{}...[已截断，共 {} 字符]", &s[..MAX], s.len()))
    } else {
        Ok(s)
    }
}

/// 当前会话状态（供 UI 显示）。
pub(crate) fn cdp_status(agent_id: Option<&str>) -> String {
    let mut sessions = lock_sessions();
    let sess = sessions.entry(session_key(agent_id)).or_default();
    json!({
        "port": sess.port,
        "attached": sess.target_id.is_some(),
        "chromeRunning": sess.chrome_child.is_some(),
    })
    .to_string()
}

// ═══════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::{INSPECT_PROBE, REPORT_PROBE};

    /// 探针语法验证（P0-4）：探针是注入页面的 JS，语法错误要运行时才发现。
    /// 此处用 node --check 强制验证——改坏探针 cargo test 必红。
    /// node 不可用（纯 Rust 环境）时跳过，不视为失败。
    fn assert_valid_js(probe: &str, name: &str) {
        // 探针是箭头函数表达式，包成表达式语句后 node --check 可验证
        let js = format!("({probe});\n");
        let dir = std::env::temp_dir().join("hologram-probe-syntax");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("{name}.js"));
        std::fs::write(&path, &js).expect("写探针临时文件失败");
        match std::process::Command::new("node").arg("--check").arg(&path).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => panic!(
                "探针 {name} 语法错误（node --check 失败）:\n{}",
                String::from_utf8_lossy(&out.stderr)
            ),
            Err(_) => eprintln!("警告: node 不可用，跳过探针 {name} 语法检查"),
        }
    }

    #[test]
    fn probes_are_valid_javascript() {
        assert_valid_js(INSPECT_PROBE, "inspect");
        assert_valid_js(REPORT_PROBE, "report");
    }

    #[test]
    fn session_key_falls_back_to_default() {
        assert_eq!(super::session_key(None), "default");
        assert_eq!(super::session_key(Some("")), "default");
        assert_eq!(super::session_key(Some("  ")), "default");
        assert_eq!(super::session_key(Some("agent-7")), "agent-7");
    }
}
