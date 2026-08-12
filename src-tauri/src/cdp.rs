// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// CDP (Chrome DevTools Protocol) 客户端 — 让 Agent 观察/操作外部 Chromium 页面。
//
// 设计原则（借鉴 HanaAgent computer-use 的设计思路，实现完全不同）：
//   - 短连接：每次调用建立 WS 连接，用完即关。本地回环开销可忽略，
//     避免长连接状态机（重连/心跳/事件流）的复杂度。
//   - 语义化操作：模型只给 CSS selector，坐标由本模块从 getBoundingClientRect
//     计算，模型不接触裸坐标。
//   - 结果截断：大结果防上下文爆炸。
//   - 只连 127.0.0.1；launch 用独立 profile，不碰用户日常 Chrome。

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

// ═══════════════════════════════════════════════════════════
// 全局会话状态
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

static SESSION: LazyLock<Mutex<CdpSession>> = LazyLock::new(|| Mutex::new(CdpSession::default()));

fn lock_session() -> std::sync::MutexGuard<'static, CdpSession> {
    crate::utils::lock_or_recover(&SESSION)
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
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
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
pub(crate) async fn cdp_launch(url: Option<String>, port: Option<u16>) -> Result<String, String> {
    let port = port.unwrap_or(9222);

    // 已 attach 过且端口还活着 → 直接复用
    {
        let sess = lock_session();
        if sess.port == port && list_targets_raw(port).is_ok() {
            return Ok(json!({ "status": "reused", "port": port, "url": url }).to_string());
        }
    }

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
        let mut sess = lock_session();
        sess.port = port;
        sess.chrome_child = Some(child);
    }

    wait_for_port(port, Duration::from_secs(10)).await?;
    Ok(json!({ "status": "launched", "port": port, "chrome": chrome.to_string_lossy() }).to_string())
}

/// 终止受控 Chrome。
pub(crate) fn cdp_kill() -> Result<String, String> {
    let mut sess = lock_session();
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
pub(crate) fn cdp_targets() -> Result<String, String> {
    let sess = lock_session();
    let port = sess.port;
    drop(sess);
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
pub(crate) fn cdp_attach(target_id: &str) -> Result<String, String> {
    let mut sess = lock_session();
    if sess.port == 0 {
        return Err("尚未 launch 浏览器。先调用 browser(launch) 或 browser(targets) 确认端口".into());
    }
    let raw = list_targets_raw(sess.port)?;
    let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
    let found = arr
        .iter()
        .find(|t| t["id"].as_str() == Some(target_id) || t["url"].as_str() == Some(target_id));
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
        None => Err(format!("target 不存在: {target_id}（先用 browser(targets) 查看可用 target）")),
    }
}

// ═══════════════════════════════════════════════════════════
// WS 命令
// ═══════════════════════════════════════════════════════════

fn require_target() -> Result<(u16, String), String> {
    let sess = lock_session();
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
}

/// 在 target 内执行 JS 表达式，返回 result.value（JSON 字符串或值）。
async fn runtime_evaluate(expr: &str) -> Result<Value, String> {
    let (port, tid) = require_target()?;
    let resp = ws_command(
        port,
        &tid,
        "Runtime.evaluate",
        json!({
            "expression": expr,
            "returnByValue": true,
            "awaitPromise": true,
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
        return Err(format!("页面内 JS 错误: {text} {desc}"));
    }
    Ok(resp["result"]["result"]["value"].clone())
}

// ═══════════════════════════════════════════════════════════
// 探针 JS — inspect（读元素几何/样式/文本/对比度）
// ═══════════════════════════════════════════════════════════

/// 元素检查探针。返回 JSON 数组字符串。
const INSPECT_PROBE: &str = r#"(selector, props, maxResults) => {
  const max = maxResults || 20;
  const els = Array.from(document.querySelectorAll(selector)).slice(0, max);
  const want = (k) => !props || props.length === 0 || props.includes(k);
  const parseColor = (c) => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a < 0.5) return null; // 半透明背景无法可靠计算
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  };
  const lum = (rgb) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const out = { tag: el.tagName.toLowerCase(), selector };
    if (el.id) out.id = el.id;
    if (want('geometry')) {
      out.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      out.visible = r.width > 0 && r.height > 0;
      const sr = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
      out.scrollable = sr;
    }
    if (want('style')) {
      out.style = {
        color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize,
        fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
        padding: cs.padding, margin: cs.margin,
        borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, gap: cs.gap,
      };
    }
    if (want('text')) {
      out.text = (el.textContent || '').trim().slice(0, 200);
    }
    if (want('contrast')) {
      const fg = parseColor(cs.color);
      const bg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(el.parentElement || el).backgroundColor);
      if (fg && bg) out.contrast = Math.round(contrast(fg, bg) * 100) / 100;
    }
    return out;
  });
}"#;

pub(crate) async fn cdp_inspect(
    selector: &str,
    props: Option<Vec<String>>,
    max_results: Option<usize>,
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
    let val = runtime_evaluate(&expr).await?;
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
const REPORT_PROBE: &str = r#"(scope) => {
  const issues = [];
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { issues: [{ rule: 'scope', severity: 'error', detail: 'scope 选择器无匹配' }], ok: false };
  const SPACING_SCALE = [4, 8, 12, 16, 24, 32, 48];
  const px = (v) => { const m = String(v).match(/^([\d.]+)px$/); return m ? parseFloat(m[1]) : null; };
  const onScale = (v) => { const n = px(v); if (n === null) return true; return SPACING_SCALE.some((s) => Math.abs(s - n) <= 1); };
  const parseColor = (c) => {
    const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a < 0.5) return null;
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  };
  const lum = (rgb) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const shortPath = (el) => {
    if (el.id) return '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
    let s = el.tagName.toLowerCase();
    if (cls) s += '.' + cls;
    return s + ' <' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '>';
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  // 收集可见元素（深度优先，限制 500 个防卡死）
  const all = [];
  const walk = (el) => {
    if (all.length >= 500) return;
    if (el.children.length === 0 && el.textContent.trim()) all.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  // 1. 对比度
  const contrastIssues = [];
  for (const el of all) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    const bg = parseColor(cs.backgroundColor) || parseColor(getComputedStyle(el.parentElement || el).backgroundColor);
    if (fg && bg) {
      const r = contrast(fg, bg);
      if (r < 4.5) {
        contrastIssues.push({ rule: 'contrast', severity: 'warn', detail: `对比度 ${r.toFixed(2)}:1 < 4.5:1`, selector: shortPath(el) });
      }
    }
  }
  issues.push(...contrastIssues.slice(0, 8));
  // 2. 间距纪律（抽查主要块元素）
  const spacingIssues = [];
  const blocks = Array.from(root.querySelectorAll('div, section, article, header, footer, main, aside')).filter(vis).slice(0, 200);
  for (const el of blocks) {
    const cs = getComputedStyle(el);
    for (const p of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'marginTop', 'marginBottom']) {
      const v = cs[p];
      if (!onScale(v)) {
        spacingIssues.push({ rule: 'spacing', severity: 'info', detail: `${p} = ${v}（不在 4/8/12/16/24/32 刻度上）`, selector: shortPath(el) });
        break; // 每个元素只报一次
      }
    }
  }
  issues.push(...spacingIssues.slice(0, 6));
  // 3. 对齐检测：同行元素的左缘偏差
  const alignIssues = [];
  const rows = new Map();
  for (const el of blocks.slice(0, 100)) {
    const r = el.getBoundingClientRect();
    const key = Math.round(r.y / 20); // 20px 行桶
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x: Math.round(r.x), el });
  }
  for (const [, group] of rows) {
    if (group.length >= 2) {
      const xs = [...new Set(group.map((g) => g.x))];
      if (xs.length >= 2 && Math.max(...xs) - Math.min(...xs) > 2) {
        alignIssues.push({ rule: 'alignment', severity: 'warn', detail: `同行元素左缘偏差 ${Math.max(...xs) - Math.min(...xs)}px`, selector: group.map((g) => shortPath(g.el)).join(', ') });
      }
    }
  }
  issues.push(...alignIssues.slice(0, 5));
  // 4. 层级：box-shadow 过重 / 过多同级阴影
  const shadowCounts = {};
  for (const el of blocks.slice(0, 150)) {
    const cs = getComputedStyle(el);
    const sh = cs.boxShadow;
    if (sh && sh !== 'none') shadowCounts[sh] = (shadowCounts[sh] || 0) + 1;
  }
  const heavy = Object.entries(shadowCounts).filter(([, c]) => c >= 5);
  for (const [sh, c] of heavy) {
    issues.push({ rule: 'hierarchy', severity: 'info', detail: `${c} 个元素使用相同阴影 ${sh.slice(0, 60)} — 视觉上无焦点`, selector: '—' });
  }
  // 5. 溢出
  const overflowIssues = [];
  for (const el of blocks.slice(0, 100)) {
    if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
      const cs = getComputedStyle(el);
      if (cs.overflow === 'visible' || cs.overflowX === 'visible') {
        overflowIssues.push({ rule: 'overflow', severity: 'warn', detail: `内容溢出 ${el.scrollWidth - el.clientWidth}px 宽 / ${el.scrollHeight - el.clientHeight}px 高`, selector: shortPath(el) });
      }
    }
  }
  issues.push(...overflowIssues.slice(0, 5));
  return { issues: issues.slice(0, 30), ok: issues.length === 0 };
}"#;

pub(crate) async fn cdp_report(scope: Option<String>) -> Result<String, String> {
    let expr = format!(
        "JSON.stringify(({})({}))",
        REPORT_PROBE,
        serde_json::to_string(&scope.unwrap_or_default()).map_err(|e| e.to_string())?
    );
    let val = runtime_evaluate(&expr).await?;
    Ok(val.as_str().unwrap_or("{\"issues\":[],\"ok\":true}").to_string())
}

// ═══════════════════════════════════════════════════════════
// 操作 — click / type / press / scroll
// ═══════════════════════════════════════════════════════════

/// 取元素中心点坐标（viewport 相对）。返回 {x, y, found, visible}。
async fn element_center(selector: &str) -> Result<(f64, f64), String> {
    let expr = format!(
        r#"(() => {{ const el = document.querySelector({sel}); if (!el) return null; const r = el.getBoundingClientRect(); return {{ x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 }}; }})()"#,
        sel = serde_json::to_string(selector).map_err(|e| e.to_string())?
    );
    let val = runtime_evaluate(&expr).await?;
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
pub(crate) async fn cdp_click(selector: &str) -> Result<String, String> {
    let (x, y) = element_center(selector).await?;
    let (port, tid) = require_target()?;
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
pub(crate) async fn cdp_type(selector: &str, text: &str) -> Result<String, String> {
    let focus_expr = format!(
        r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.focus(); return true; }})()"#,
        sel = serde_json::to_string(selector).map_err(|e| e.to_string())?
    );
    let ok = runtime_evaluate(&focus_expr).await?;
    if !ok.as_bool().unwrap_or(false) {
        return Err(format!("type: selector 无匹配元素: {selector}"));
    }
    let (port, tid) = require_target()?;
    ws_command(
        port,
        &tid,
        "Input.insertText",
        json!({ "text": text }),
    )
    .await?;
    Ok(json!({ "typed": text.chars().take(50).collect::<String>() }).to_string())
}

/// 按键（Enter/Tab/Escape/Backspace/方向键/组合键）。
pub(crate) async fn cdp_press(key: &str) -> Result<String, String> {
    let (port, tid) = require_target()?;
    // CDP key 参数 — 常见键的映射
    let (key_name, code, vk): (&str, String, u32) = match key.to_lowercase().as_str() {
        "enter" => ("Enter", "Enter".into(), 13),
        "tab" => ("Tab", "Tab".into(), 9),
        "escape" | "esc" => ("Escape", "Escape".into(), 27),
        "backspace" => ("Backspace", "Backspace".into(), 8),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp".into(), 38),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown".into(), 40),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft".into(), 37),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight".into(), 39),
        "space" => (" ", "Space".into(), 32),
        "delete" | "del" => ("Delete", "Delete".into(), 46),
        "home" => ("Home", "Home".into(), 36),
        "end" => ("End", "End".into(), 35),
        "pageup" => ("PageUp", "PageUp".into(), 33),
        "pagedown" => ("PageDown", "PageDown".into(), 34),
        _ => {
            // 单字符直接按键
            if key.len() == 1 {
                let c = key.chars().next().unwrap();
                (key, format!("Key{}", c.to_ascii_uppercase()), c.to_ascii_uppercase() as u32)
            } else {
                return Err(format!("不支持的按键: {key}（支持 Enter/Tab/Escape/Backspace/方向键/单字符）"));
            }
        }
    };
    let down = json!({ "type": "keyDown", "key": key_name, "code": code, "windowsVirtualKeyCode": vk });
    let up = json!({ "type": "keyUp", "key": key_name, "code": code, "windowsVirtualKeyCode": vk });
    ws_command(port, &tid, "Input.dispatchKeyEvent", down).await?;
    ws_command(port, &tid, "Input.dispatchKeyEvent", up).await?;
    Ok(json!({ "pressed": key_name }).to_string())
}

/// 滚动：有 selector → 滚到元素可见；否则页面滚动 direction（down/up）。
pub(crate) async fn cdp_scroll(selector: Option<String>, direction: Option<String>) -> Result<String, String> {
    let (port, tid) = require_target()?;
    if let Some(sel) = selector {
        if !sel.trim().is_empty() {
            let expr = format!(
                r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.scrollIntoView({{ behavior: 'smooth', block: 'center' }}); return true; }})()"#,
                sel = serde_json::to_string(&sel).map_err(|e| e.to_string())?
            );
            let ok = runtime_evaluate(&expr).await?;
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
pub(crate) async fn cdp_eval(expr: &str) -> Result<String, String> {
    if expr.trim().is_empty() {
        return Err("eval: 表达式不能为空".into());
    }
    check_eval_expr(expr)?;
    let val = runtime_evaluate(expr).await?;
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
pub(crate) fn cdp_status() -> String {
    let sess = lock_session();
    json!({
        "port": sess.port,
        "attached": sess.target_id.is_some(),
        "chromeRunning": sess.chrome_child.is_some(),
    })
    .to_string()
}
