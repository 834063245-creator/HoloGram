// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! CDP 动作层：target/attach、探针动作、事件查询、页面操作、截图/视口/eval。
//! 从 cdp.rs 拆出（第四批工程债）；会话状态在 session.rs，WS 传输在 transport.rs。

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::errors::{codes, err};
use super::probes::{probe_result_str, CONTENT_PROBE, INSPECT_PROBE, REPORT_PROBE, SNAPSHOT_PROBE};
use super::session::{
    active_session_key, audit_log, cleanup_old_files_by_age, ensure_observer_started,
    har_retain_days, is_self, lock_sessions, session_mut, shot_retain_days, truncate_str,
    Observer, ACTIONABILITY_TIMEOUT, EVAL_TIMEOUT_MS, HAR_DIR_NAME, HAR_FILE_PREFIX,
    NETWORK_BUF_MAX, POST_ACTION_SETTLE, SELF_AGENT_ID, SHOT_DIR_NAME, SHOT_FILE_PREFIX,
    WEBVIEW_DEBUG_PORT,
};
use super::transport::{list_targets_raw, ws_command, ws_command_seq};

// ═══════════════════════════════════════════════════════════
// target 发现与 attach
// ═══════════════════════════════════════════════════════════

/// 列出所有页面 target（type=page），返回 [{id, title, url}]。
pub(crate) fn cdp_targets(agent_id: Option<&str>) -> Result<String, String> {
    let port = {
        let mut sessions = session_mut(agent_id);
        sessions.entry(active_session_key(agent_id)).or_default().port
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
/// attach 时启动事件观察（持久 WS 后台 task）。
pub(crate) fn cdp_attach(target_id: &str, agent_id: Option<&str>) -> Result<String, String> {
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    if sess.port == 0 {
        return Err(
            "尚未 launch 浏览器。先调用 browser(launch) 或 browser(targets) 确认端口".into(),
        );
    }
    let raw = list_targets_raw(sess.port)?;
    let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
    // 只按 target id 精确匹配——URL 不是 target id，传 URL 会得到明确错误而非意外 attach
    let found = arr.iter().find(|t| t["id"].as_str() == Some(target_id));
    match found {
        Some(t) => {
            let id = t["id"].as_str().unwrap_or("").to_string();
            let title = t["title"].as_str().unwrap_or("").to_string();
            sess.target_id = Some(id.clone());
            ensure_observer_started(sess, sess.port, &id);
            // 审计对象存人话：页面标题（UI 展示用），summary 存 URL
            let tgt = if title.is_empty() { id.clone() } else { title.clone() };
            audit_log(agent_id, "attach", &tgt, t["url"].as_str().unwrap_or(""));
            Ok(json!({
                "attached": true,
                "targetId": id,
                "title": title,
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
// self 会话 — 自家 webview 的只读通道
// ═══════════════════════════════════════════════════════════

/// 在 webview 调试端口上找 HoloGram 自家页面 target。
/// WebView2 的 URL 前缀：tauri://localhost / http(s)://tauri.localhost。
pub(super) fn find_webview_target() -> Result<String, String> {
    let raw = list_targets_raw(WEBVIEW_DEBUG_PORT)?;
    let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
    let page = arr
        .iter()
        .find(|t| {
            t["type"] == "page"
                && t["url"]
                    .as_str()
                    .map(|u| u.starts_with("tauri://localhost") || u.contains("tauri.localhost"))
                    .unwrap_or(false)
        })
        .or_else(|| arr.iter().find(|t| t["type"] == "page"));
    page.and_then(|t| t["id"].as_str().map(String::from)).ok_or_else(|| {
        err(
            codes::TARGET_GONE,
            "找不到自家 webview 的调试 target（tauri 调试端口未开启？）",
        )
    })
}

/// 惰性确保 self 会话已 attach 到自家 webview。返回 (port, target_id)。
/// 只在读动作里被调用；操作动作在 rpc 层被拒。
pub(super) fn ensure_self_attached() -> Result<(u16, String), String> {
    let mut sessions = lock_sessions();
    let sess = sessions.entry(SELF_AGENT_ID.to_string()).or_default();
    let tid = match &sess.target_id {
        Some(t) => {
            // 确认 target 还活着，死了重找
            match list_targets_raw(WEBVIEW_DEBUG_PORT) {
                Ok(raw) => match raw
                    .as_array()
                    .and_then(|a| a.iter().find(|tt| tt["id"].as_str() == Some(t.as_str())))
                {
                    Some(_) => t.clone(),
                    None => find_webview_target()?,
                },
                Err(_) => find_webview_target()?,
            }
        }
        None => find_webview_target()?,
    };
    sess.port = WEBVIEW_DEBUG_PORT;
    sess.target_id = Some(tid.clone());
    // 观察任务惰性重启
    let need_start = match &sess.observer {
        Some(o) => !o.alive.load(Ordering::SeqCst),
        None => true,
    };
    if need_start {
        ensure_observer_started(sess, WEBVIEW_DEBUG_PORT, &tid);
    }
    Ok((WEBVIEW_DEBUG_PORT, tid))
}

/// 事件观察句柄（查询用）——self 会话先惰性 attach。
pub(super) fn observer_of(agent_id: Option<&str>) -> Option<Observer> {
    if is_self(agent_id) && ensure_self_attached().is_err() {
        return None;
    }
    let mut sessions = lock_sessions();
    sessions
        .entry(active_session_key(agent_id))
        .or_default()
        .observer
        .clone()
}

/// 惰性重启事件观察（命令路径）——target 还在但观察任务死了就重开。
pub(super) fn ensure_observer(agent_id: Option<&str>) -> Option<Observer> {
    if is_self(agent_id) && ensure_self_attached().is_err() {
        return None;
    }
    let mut sessions = lock_sessions();
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    let tid = sess.target_id.clone()?;
    let need_start = match &sess.observer {
        Some(o) => !o.alive.load(Ordering::SeqCst),
        None => true,
    };
    if need_start && sess.port != 0 {
        ensure_observer_started(sess, sess.port, &tid);
    }
    sess.observer.clone()
}

/// 执行一条必须与 observer 同 session 的 CDP 命令。
///
/// Chrome 151 起 domain 状态绑定「Page.enable/Runtime.enable 的 session」：
/// 短连接（ws_command）上发 `Emulation.setDeviceMetricsOverride`，width/height
/// 生效但 deviceScaleFactor 被静默丢弃（devicePixelRatio 恒 1）——实测 observer
/// 连接 dpr=2、新连接 dpr=1（e2e-4）。dialog/file chooser 早已按同一规律改造。
/// observer 不可用/发送失败时回退新连接（老 Chrome 行为）。
pub(super) async fn observer_command(
    port: u16,
    tid: &str,
    agent_id: Option<&str>,
    method: &str,
    params: Value,
) -> Result<(), String> {
    if let Some(obs) = observer_of(agent_id) {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, String>>();
        if obs
            .cmd_tx
            .send(super::session::ObserverCmd {
                method: method.to_string(),
                params: params.clone(),
                reply: tx,
            })
            .is_ok()
        {
            return match rx.await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(format!("CDP {method} 错误: {e}")),
                Err(_) => Err("observer 命令通道中断".to_string()),
            };
        }
    }
    ws_command(port, tid, method, params).await?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════
// WS 命令通道（短连接）
// ═══════════════════════════════════════════════════════════

pub(super) fn require_target(agent_id: Option<&str>) -> Result<(u16, String), String> {
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    if sess.port == 0 {
        return Err(err(codes::SESSION, "尚未 launch 浏览器"));
    }
    let tid = sess
        .target_id
        .clone()
        .ok_or_else(|| err(codes::SESSION, "未 attach target。先调用 browser(attach) 选择页面"))?;
    Ok((sess.port, tid))
}

/// 在 target 内执行 JS 表达式，返回 result.value（JSON 字符串或值）。
pub(super) async fn runtime_evaluate(expr: &str, agent_id: Option<&str>) -> Result<Value, String> {
    if is_self(agent_id) {
        ensure_self_attached()?;
    }
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
        if text.to_lowercase().contains("timeout") {
            return Err(err(
                codes::TIMEOUT,
                format!("页面内 JS 执行超时（{EVAL_TIMEOUT_MS}ms）——表达式可能死循环或页面主线程卡死"),
            ));
        }
        return Err(format!("页面内 JS 错误: {text} {desc}"));
    }
    Ok(resp["result"]["result"]["value"].clone())
}

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
    let s = probe_result_str(&val, "inspect")?;
    const MAX: usize = 8000;
    if s.len() > MAX {
        Ok(format!("{}...[已截断，共 {} 字符]", &s[..MAX], s.len()))
    } else {
        Ok(s)
    }
}

pub(crate) async fn cdp_report(
    scope: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let expr = format!(
        "JSON.stringify(({})({}))",
        REPORT_PROBE,
        serde_json::to_string(&scope.unwrap_or_default()).map_err(|e| e.to_string())?
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    probe_result_str(&val, "report")
}

/// 页面正文提取（P0）：title/url 固定返回，正文支持 text / markdown-lite，
/// scope 限制根节点，offset/max_chars 做字符级分页（默认 8000，上限 20000）。
/// 返回探针原样 JSON（含分页信息），复用 probe_result_str 字符串契约。
pub(crate) async fn cdp_content(
    scope: Option<String>,
    content_format: Option<String>,
    max_chars: Option<usize>,
    offset: Option<usize>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let fmt = content_format.unwrap_or_else(|| "text".into());
    if fmt != "text" && fmt != "markdown" {
        return Err("content: format 只支持 text 或 markdown".into());
    }
    let max = max_chars.unwrap_or(8000).clamp(1, 20000);
    let expr = format!(
        "JSON.stringify(({})({}, {}, {}, {}))",
        CONTENT_PROBE,
        serde_json::to_string(&scope.unwrap_or_default()).map_err(|e| e.to_string())?,
        serde_json::to_string(&fmt).map_err(|e| e.to_string())?,
        offset.unwrap_or(0),
        max
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    probe_result_str(&val, "content")
}

// ═══════════════════════════════════════════════════════════
// snapshot + ref — 可交互元素清单（ADR 0003 D2）
// ═══════════════════════════════════════════════════════════

/// AX 树节点（仅保留快照需要的字段）。
pub(super) struct AxNode {
    pub(super) backend_node_id: u64,
    pub(super) role: String,
    pub(super) name: String,
    pub(super) focusable: bool,
}

pub(super) fn ax_node_from_value(v: &Value) -> Option<AxNode> {
    let backend_node_id = v["backendDOMNodeId"].as_u64()?;
    if backend_node_id == 0 {
        return None;
    }
    if v["ignored"].as_bool().unwrap_or(false) {
        return None;
    }
    let focusable = v["properties"]
        .as_array()
        .map(|props| {
            props.iter().any(|p| {
                p["name"].as_str() == Some("focusable")
                    && p["value"]["value"].as_bool().unwrap_or(false)
            })
        })
        .unwrap_or(false);
    Some(AxNode {
        backend_node_id,
        role: v["role"]["value"].as_str().unwrap_or("").to_string(),
        name: v["name"]["value"].as_str().unwrap_or("").to_string(),
        focusable,
    })
}

pub(super) fn ax_role_is_interactive(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "link"
            | "button"
            | "textbox"
            | "searchbox"
            | "combobox"
            | "listbox"
            | "checkbox"
            | "radio"
            | "switch"
            | "slider"
            | "spinbutton"
            | "tab"
            | "menuitem"
            | "menuitemcheckbox"
            | "menuitemradio"
            | "treeitem"
            | "row"
            | "gridcell"
            | "columnheader"
            | "rowheader"
    )
}

/// AX 树根/文档容器角色：不可作为点击目标。
/// RootWebArea resolve 成 HTMLDocument（没有 setAttribute），真实 agent 也
/// 不会去点"整个文档"——DOM 兜底路径同样不产出 document 条目。把这些角色
/// 从候选里剔掉，否则 callFunctionOn 打 data-hg-ref 失败会整体回退 DOM
/// （Chrome 151 的焦点态把 root 也标成 focusable，命运性放大此坑）。
pub(super) fn ax_role_is_document_container(role: &str) -> bool {
    matches!(
        role.to_ascii_lowercase().as_str(),
        "rootwebarea" | "webarea" // 旧版 Chromium 用过 WebArea
    )
}

/// 清掉页面（含 same-origin iframe / open shadow root）里残留的 data-hg-ref。
pub(super) const CLEAR_HG_REFS_EXPR: &str = r#"(() => { const seen = new Set(); const clearRoot = (root) => { if (!root || seen.has(root)) return; seen.add(root); if (root.querySelectorAll) { root.querySelectorAll('[data-hg-ref]').forEach((el) => el.removeAttribute('data-hg-ref')); } if (root.querySelectorAll) { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) clearRoot(el.shadowRoot); } for (const f of root.querySelectorAll('iframe, frame')) { try { if (f.contentDocument) clearRoot(f.contentDocument); } catch (e) {} } } }; clearRoot(document); return true; })()"#;

/// 尝试走 Accessibility.getFullAXTree（Chrome DevTools MCP 同款）生成快照。
/// 成功时把选中的 backendNodeId resolve 回 DOM 并补 data-hg-ref 标记，
/// ref 语义与 DOM 探针完全一致（click/type/select 无需感知来源差异）。
/// 任何一步失败都返回 None，由调用方回退增强 DOM 探针。
pub(super) async fn try_ax_snapshot(
    port: u16,
    target_id: &str,
    max_results: usize,
    offset: usize,
) -> Result<Option<String>, String> {
    let mut resp = match ws_command(port, target_id, "Accessibility.getFullAXTree", json!({})).await {
        Ok(v) => v,
        Err(_) => return Ok(None), // 旧版 Chromium / 非浏览器 target 没有 AX domain → 回退探针
    };
    // Chrome 151 起 AX 树是惰性构建：新连接首次 getFullAXTree 常只回 RootWebArea
    // （解析成 HTMLDocument）。此时若把 document 当候选做 callFunctionOn 会报
    // "Could not find object with given id" / TypeError 而整体回退 DOM——AX 路径在
    // 这版 Chrome 上稳定失效（e2e-4 实测首拉 1 节点、~200ms 后全树）。
    // 树稀疏（无可用候选且节点仍是根裸树）时小延迟重试逼出全树；真没有可交互
    // 元素的页面在树长全（>2 节点）后自然退出重试。
    for _ in 0..3 {
        let nodes_here = resp["result"]["nodes"].as_array().cloned().unwrap_or_default();
        let has_candidate = nodes_here.iter().filter_map(ax_node_from_value).any(|n| {
            (ax_role_is_interactive(&n.role) || n.focusable)
                && !ax_role_is_document_container(&n.role)
        });
        if has_candidate || nodes_here.is_empty() || nodes_here.len() > 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        match ws_command(port, target_id, "Accessibility.getFullAXTree", json!({})).await {
            Ok(v) => resp = v,
            Err(_) => break,
        }
    }
    let nodes = resp["result"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if nodes.is_empty() {
        return Ok(None);
    }
    // 排除 AX 根/文档容器（RootWebArea/WebArea）：它们 resolve 成 HTMLDocument，
    // 没有 setAttribute 可打 ref；真实 agent 也不点"整个文档"。
    let candidates: Vec<AxNode> = nodes
        .iter()
        .filter_map(ax_node_from_value)
        .filter(|n| {
            !ax_role_is_document_container(&n.role)
                && (ax_role_is_interactive(&n.role) || n.focusable)
        })
        .collect();
    let total = candidates.len();
    let selected: Vec<&AxNode> = candidates.iter().skip(offset).take(max_results).collect();
    if selected.is_empty() {
        // 命令可用但当前窗口没有候选：返回空快照，不要悄悄退回 DOM 口径。
        return Ok(Some(
            json!({
                "source": "ax",
                "refs": [],
                "count": 0,
                "total": total,
                "offset": offset,
                "truncated": offset + max_results < total,
                "note": "AX snapshot（Accessibility.getFullAXTree）：当前窗口无更多可交互节点",
            })
            .to_string(),
        ));
    }

    // 清残留 ref。
    if ws_command(
        port,
        target_id,
        "Runtime.evaluate",
        json!({ "expression": CLEAR_HG_REFS_EXPR, "returnByValue": true }),
    )
    .await
    .is_err()
    {
        return Ok(None);
    }

    // resolve + mark 必须走同一条 WS 连接：DOM.resolveNode 返回的 objectId 是
    // 会话（连接）本地状态，拆成两次 ws_command_batch 会各建一条连接，第二条
    // 连接上 callFunctionOn(objectId) 报 "Could not find object with given id"
    // （Chrome 151 实测，AX 路径在此整体回退 DOM）。用 ws_command_seq 在同一条
    // 连接上交错执行 resolve[i] → callFunctionOn[i]。
    const MARK_ELEMENT_FN: &str = "function(ref){ this.setAttribute('data-hg-ref', ref); return { tag: this.tagName ? this.tagName.toLowerCase() : '', id: this.id || '', type: (this.tagName === 'INPUT' || this.tagName === 'BUTTON') ? (this.type || '') : '' }; }";
    let mut commands: Vec<Box<dyn Fn(&Value) -> (String, Value) + Send + Sync>> = Vec::new();
    for (i, node) in selected.iter().enumerate() {
        let backend = node.backend_node_id;
        commands.push(Box::new(move |_| {
            (
                "DOM.resolveNode".to_string(),
                json!({ "backendNodeId": backend }),
            )
        }));
        commands.push(Box::new(move |prev| {
            let object_id = prev["result"]["object"]["objectId"]
                .as_str()
                .unwrap_or("")
                .to_string();
            (
                "Runtime.callFunctionOn".to_string(),
                json!({
                    "objectId": object_id,
                    "functionDeclaration": MARK_ELEMENT_FN,
                    "arguments": [{ "value": i.to_string() }],
                    "returnByValue": true,
                }),
            )
        }));
    }
    // 返回按顺序排满：偶数索引是 resolve、奇数索引是对应的 callFunctionOn。
    let replies = match ws_command_seq(port, target_id, commands).await {
        Ok(r) => r,
        Err(_) => return Ok(None), // resolve/mark 任一步失败 → 回退 DOM 口径
    };

    // 标记失败会造成 ref 缺口/错位（属性里写的是 i，输出若跳过失败项就对不上）。
    // AX 只是优先路径——任一条标记失败就整体回退 DOM 探针，由探针清标重打。
    let mut refs: Vec<Value> = Vec::new();
    for (i, node) in selected.iter().enumerate() {
        let Some(info) = replies
            .get(2 * i + 1)
            .and_then(|v| v["result"]["result"]["value"].as_object())
            .cloned()
        else {
            return Ok(None);
        };
        let text = node.name.as_str();
        let mut out = json!({
            "ref": i,
            "tag": info.get("tag").and_then(|v| v.as_str()).unwrap_or(""),
            "role": node.role,
            "name": truncate_str(node.name.as_str(), 80),
            "text": truncate_str(text, 80),
        });
        if let Some(id) = info
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            out["id"] = json!(id);
        }
        if let Some(ty) = info
            .get("type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            out["type"] = json!(ty);
        }
        refs.push(out);
    }

    Ok(Some(
        json!({
            "source": "ax",
            "refs": refs,
            "count": refs.len(),
            "total": total,
            "offset": offset,
            "truncated": offset + max_results < total,
            "note": "AX snapshot（Accessibility.getFullAXTree）；ref 已回写到 DOM data-hg-ref，可用 ref 数字执行 click/type/select/hover",
        })
        .to_string(),
    ))
}

/// 页面快照：优先 Accessibility.getFullAXTree（无 scope 时），失败回退增强 DOM 探针。
/// 两种路径统一给可交互元素打 data-hg-ref 标记，返回
/// {source, refs, count, total, offset, truncated}，ref 语义不变。
pub(crate) async fn cdp_snapshot(
    scope: Option<String>,
    max_results: Option<usize>,
    offset: Option<usize>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let max_results = max_results.unwrap_or(80).clamp(1, 500);
    let offset = offset.unwrap_or(0);
    let scoped = scope
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // AX 树不提供 CSS scope 映射；带 scope 的检查直接走 DOM 探针。
    if !scoped {
        if is_self(agent_id) {
            ensure_self_attached()?;
        }
        let (port, tid) = require_target(agent_id)?;
        if let Some(s) = try_ax_snapshot(port, &tid, max_results, offset).await? {
            const MAX: usize = 8000;
            if s.len() > MAX {
                return Ok(format!("{}...[已截断，共 {} 字符]", &s[..MAX], s.len()));
            }
            return Ok(s);
        }
    }

    let expr = format!(
        "JSON.stringify(({})({}, {}, {}))",
        SNAPSHOT_PROBE,
        serde_json::to_string(&scope.unwrap_or_default()).map_err(|e| e.to_string())?,
        max_results,
        offset
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    let s = probe_result_str(&val, "snapshot")?;
    const MAX: usize = 8000;
    if s.len() > MAX {
        Ok(format!("{}...[已截断，共 {} 字符]", &s[..MAX], s.len()))
    } else {
        Ok(s)
    }
}

/// 把 ref（纯数字）转成 selector；非 ref 原样返回（CSS selector 高级用法）。
pub(super) fn ref_to_selector(target: &str) -> String {
    let t = target.trim();
    if !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()) {
        format!("[data-hg-ref=\"{t}\"]")
    } else if let Some(rest) = t.strip_prefix("ref:") {
        format!("[data-hg-ref=\"{}\"]", rest.trim())
    } else {
        t.to_string()
    }
}

/// 生成一个「跨 same-origin iframe + open shadow root」的元素定位 JS 表达式。
/// 快照探针现在会在 iframe / shadow DOM 里打 ref；旧动作只查主 document.querySelector，
/// 这些 ref 会白给。这里统一收口定位逻辑，所有 selector 动作共用。
pub(super) fn find_el_expr(sel: &str) -> Result<String, String> {
    let sel_json = serde_json::to_string(sel).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"(() => {{ const sel = {sel_json}; const seen = new Set(); const findIn = (root) => {{ if (!root || seen.has(root)) return null; seen.add(root); if (root.querySelector) {{ const hit = root.querySelector(sel); if (hit) return hit; }} if (root.querySelectorAll) {{ for (const el of root.querySelectorAll('*')) {{ if (el.shadowRoot) {{ const hit = findIn(el.shadowRoot); if (hit) return hit; }} }} for (const f of root.querySelectorAll('iframe, frame')) {{ try {{ if (f.contentDocument) {{ const hit = findIn(f.contentDocument); if (hit) return hit; }} }} catch (e) {{}} }} }} return null; }}; return findIn(document); }})()"#
    ))
}

// ═══════════════════════════════════════════════════════════
// 事件查询 — console / network
// ═══════════════════════════════════════════════════════════

/// 读取事件缓冲的尾部 N 条，返回 JSON 数组字符串。
pub(super) fn read_buffer(buf: &VecDeque<String>, limit: usize) -> String {
    let n = limit.min(buf.len());
    let tail: Vec<&str> = buf
        .iter()
        .rev()
        .take(n)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|s| s.as_str())
        .collect();
    format!("[{}]", tail.join(","))
}

/// 查询 console 事件（最新 N 条）。
pub(crate) fn cdp_console(agent_id: Option<&str>, limit: Option<usize>) -> String {
    let Some(obs) = ensure_observer(agent_id) else {
        return json!({ "entries": [], "truncated": false, "note": "未 attach target" }).to_string();
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let limit = limit.unwrap_or(30);
    let s = read_buffer(&bufs.console, limit);
    format!("{{\"entries\":{s},\"truncated\":{}}}", bufs.console.len() > limit)
}

/// 查询网络事件（最新 N 条，请求/响应已按 requestId 配对）。
pub(crate) fn cdp_network(agent_id: Option<&str>, limit: Option<usize>) -> String {
    let Some(obs) = ensure_observer(agent_id) else {
        return json!({ "entries": [], "paired": true, "truncated": false, "note": "未 attach target" }).to_string();
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let limit = limit.unwrap_or(30);
    let n = limit.min(bufs.network.len());
    let entries: Vec<Value> = bufs
        .network
        .iter()
        .rev()
        .take(n)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|e| e.summary_value())
        .collect();
    json!({
        "entries": entries,
        "paired": true,
        "truncated": bufs.network.len() > limit,
        "note": "同一条记录含 requestId/method/url/status/error；status 为 null 表示尚无响应，error 非 null 表示加载失败",
    })
    .to_string()
}

/// 查询单个网络请求详情（仍在 200 条事件窗口内的 requestId）。
/// HAR 作为后续导出项；本动作先覆盖日常排查「这个请求到底带了什么头/回了什么状态」。
pub(crate) fn cdp_network_detail(
    request_id: &str,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("network_detail: requestId 不能为空".into());
    }
    let Some(obs) = ensure_observer(agent_id) else {
        return Err(
            "network_detail: 未 attach target（先 browser(attach) 后事件才会被观察）".into(),
        );
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let entry = bufs
        .network_index
        .get(request_id)
        .ok_or_else(|| {
            format!(
                "network_detail: 未找到请求 {request_id}（缓冲上限 {NETWORK_BUF_MAX} 条，旧请求可能已被挤出；HAR 导出尚未实现）"
            )
        })?;
    Ok(json!({ "entry": entry.detail_value() }).to_string())
}

/// 导出当前观察缓冲为 HAR 1.2 文件（HAR 后续落地为文件导出而非内联大 JSON）。
/// 返回 {path, bytes, entries, note}；读文件可用 fs(read) 或直接给用户路径。
pub(crate) fn cdp_network_har(
    agent_id: Option<&str>,
    limit: Option<usize>,
) -> Result<String, String> {
    let Some(obs) = ensure_observer(agent_id) else {
        return Err("network_har: 未 attach target（先 browser(attach) 后事件才会被观察）".into());
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let n = limit
        .unwrap_or(100)
        .clamp(1, NETWORK_BUF_MAX)
        .min(bufs.network.len());
    let entries: Vec<Value> = bufs
        .network
        .iter()
        .rev()
        .take(n)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|e| e.har_entry())
        .collect();
    let har = json!({
        "log": {
            "version": "1.2",
            "creator": { "name": "HoloGram browser-cdp", "version": env!("CARGO_PKG_VERSION") },
            "entries": entries,
        }
    });

    let dir = std::env::temp_dir().join(HAR_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 HAR 目录失败: {e}"))?;
    cleanup_old_files_by_age(
        &dir,
        HAR_FILE_PREFIX,
        har_retain_days(),
        std::time::SystemTime::now(),
    );
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{HAR_FILE_PREFIX}{ts}.har"));
    let bytes = serde_json::to_vec(&har).map_err(|e| format!("HAR 序列化失败: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("写 HAR 文件失败: {e}"))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": bytes.len(),
        "entries": entries_count(&har),
        "note": "HAR 1.2 文件已导出；包含 URL/请求响应头/queryString/postData/status/mimeType，timing 因观察通道未采样记为 -1",
    })
    .to_string())
}

pub(super) fn entries_count(har: &Value) -> usize {
    har["log"]["entries"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0)
}

// ═══════════════════════════════════════════════════════════
// cookie 管理（第五批：身份与多账号）
// ═══════════════════════════════════════════════════════════

/// cookie 查询需要一个 page target。优先用已 attach 的 target；
/// 尚未 attach 时（例如刚 launch 就要种 cookie 再导航）自动选第一个 page target，
/// 但不改变会话的 attach 状态。
fn cookie_target(agent_id: Option<&str>) -> Result<(u16, String), String> {
    let (port, attached) = {
        let mut sessions = session_mut(agent_id);
        let sess = sessions.entry(active_session_key(agent_id)).or_default();
        if sess.port == 0 {
            return Err("尚未 launch/connect 浏览器".into());
        }
        (sess.port, sess.target_id.clone())
    };
    if let Some(tid) = attached {
        return Ok((port, tid));
    }
    let raw = list_targets_raw(port)?;
    let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
    let first_page = arr
        .iter()
        .find(|t| t["type"] == "page")
        .and_then(|t| t["id"].as_str().map(String::from))
        .ok_or("cookie 操作需要一个 page target（当前浏览器没有打开的页面）")?;
    Ok((port, first_page))
}

fn cookie_value_display(v: &Value) -> Value {
    let value = v.as_str().unwrap_or("");
    json!({
        "value": truncate_str(value, 300),
        "valueTruncated": value.len() > 300,
    })
}

fn cookie_summary(c: &Value) -> Value {
    json!({
        "name": c["name"].as_str().unwrap_or(""),
        "domain": c["domain"].as_str().unwrap_or(""),
        "path": c["path"].as_str().unwrap_or("/"),
        "expires": c["expires"].as_f64(),
        "httpOnly": c["httpOnly"].as_bool(),
        "secure": c["secure"].as_bool(),
        "session": c["session"].as_bool(),
        "sameSite": c["sameSite"].as_str(),
        "size": c["size"].as_u64(),
    })
}

/// list：Network.getCookies（可按 urls 过滤；缺省返回该浏览器 context 的全部 cookie）。
/// set/delete：Network.setCookie / Network.deleteCookies。cookie 值只在返回时截断展示，
/// set 写入的原值不会进审计日志。
pub(crate) async fn cdp_cookies(
    action: &str,
    urls: Option<Vec<String>>,
    url: Option<String>,
    name: Option<String>,
    value: Option<String>,
    domain: Option<String>,
    path: Option<String>,
    http_only: Option<bool>,
    secure: Option<bool>,
    same_site: Option<String>,
    expires: Option<f64>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let (port, tid) = cookie_target(agent_id)?;
    match action {
        "list" => {
            let mut params = json!({});
            if let Some(u) = urls {
                params["urls"] = json!(u);
            }
            let resp = ws_command(port, &tid, "Network.getCookies", params).await?;
            let cookies = resp["result"]["cookies"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let total = cookies.len();
            const MAX_COOKIE_ROWS: usize = 100;
            let rows: Vec<Value> = cookies
                .iter()
                .take(MAX_COOKIE_ROWS)
                .map(|c| {
                    let mut v = cookie_summary(c);
                    v["value"] = cookie_value_display(c)["value"].clone();
                    v["valueTruncated"] = cookie_value_display(c)["valueTruncated"].clone();
                    v
                })
                .collect();
            Ok(json!({
                "cookies": rows,
                "count": rows.len(),
                "total": total,
                "note": if total > MAX_COOKIE_ROWS {
                    format!("仅返回前 {MAX_COOKIE_ROWS} 条；用 urls 缩小范围")
                } else {
                    "cookie value 超过 300 字符会被截断展示".into()
                },
            })
            .to_string())
        }
        "set" => {
            let name = name.as_deref().unwrap_or("").trim();
            let value = value.as_deref().unwrap_or("");
            if name.is_empty() {
                return Err("cookies set: name 不能为空".into());
            }
            let url = url.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let domain = domain.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if url.is_none() && domain.is_none() {
                return Err("cookies set: url 与 domain 至少提供一个".into());
            }
            let mut params = json!({
                "name": name,
                "value": value,
            });
            if let Some(u) = url {
                params["url"] = json!(u);
            }
            if let Some(d) = domain {
                params["domain"] = json!(d);
            }
            if let Some(p) = path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                params["path"] = json!(p);
            }
            if let Some(v) = http_only {
                params["httpOnly"] = json!(v);
            }
            if let Some(v) = secure {
                params["secure"] = json!(v);
            }
            if let Some(s) = same_site.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let normalized = match s.to_ascii_lowercase().as_str() {
                    "strict" => "Strict",
                    "lax" => "Lax",
                    "none" => "None",
                    _ => return Err("cookies set: sameSite 只支持 Strict/Lax/None".into()),
                };
                params["sameSite"] = json!(normalized);
            }
            if let Some(e) = expires {
                params["expires"] = json!(e);
            }
            let resp = ws_command(port, &tid, "Network.setCookie", params.clone()).await?;
            if resp["result"]["success"].as_bool() != Some(true) {
                return Err("Network.setCookie 返回 success=false（域名/路径与当前页面不匹配？）".into());
            }
            let target = params["url"]
                .as_str()
                .or(params["domain"].as_str())
                .unwrap_or("");
            audit_log(agent_id, "cookies_set", target, name);
            Ok(json!({
                "set": true,
                "name": name,
                "url": params["url"].as_str(),
                "domain": params["domain"].as_str(),
                "path": params["path"].as_str(),
            })
            .to_string())
        }
        "delete" => {
            let name = name.as_deref().unwrap_or("").trim();
            if name.is_empty() {
                return Err("cookies delete: name 不能为空".into());
            }
            let url = url.as_deref().map(str::trim).filter(|s| !s.is_empty());
            let domain = domain.as_deref().map(str::trim).filter(|s| !s.is_empty());
            if url.is_none() && domain.is_none() {
                return Err("cookies delete: url 与 domain 至少提供一个".into());
            }
            let mut params = json!({ "name": name });
            if let Some(u) = url {
                params["url"] = json!(u);
            }
            if let Some(d) = domain {
                params["domain"] = json!(d);
            }
            if let Some(p) = path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                params["path"] = json!(p);
            }
            ws_command(port, &tid, "Network.deleteCookies", params.clone()).await?;
            let target = params["url"]
                .as_str()
                .or(params["domain"].as_str())
                .unwrap_or("");
            audit_log(agent_id, "cookies_delete", target, name);
            Ok(json!({
                "deleted": true,
                "name": name,
                "url": params["url"].as_str(),
                "domain": params["domain"].as_str(),
                "path": params["path"].as_str(),
            })
            .to_string())
        }
        _ => Err(format!("cookies: 不支持 action \"{action}\"（只支持 list/set/delete）")),
    }
}

/// 查询 javascript dialog 事件（最新 N 条）+ 当前是否有未处理 dialog。
pub(crate) fn cdp_dialogs(agent_id: Option<&str>, limit: Option<usize>) -> String {
    let Some(obs) = ensure_observer(agent_id) else {
        return json!({ "pending": false, "entries": [], "note": "未 attach target" }).to_string();
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let s = read_buffer(&bufs.dialogs, limit.unwrap_or(10));
    json!({ "pending": bufs.dialog_open, "entries": serde_json::from_str::<Value>(&s).unwrap_or_else(|_| json!([])) })
        .to_string()
}

/// 处理当前 javascript dialog：accept=true 点确定，false 点取消；
/// prompt 可用 prompt_text 提供输入。
pub(crate) async fn cdp_handle_dialog(
    accept: bool,
    prompt_text: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    let mut params = json!({ "accept": accept });
    if let Some(t) = prompt_text {
        params["promptText"] = json!(t);
    }
    // Chrome 151 起 dialog 状态绑定「Page.enable 的 session」：新连接上
    // Page.handleJavaScriptDialog 报 "No dialog is showing"。必须走捕获事件的
    // observer 连接（同 session）执行；observer 不可用时回退 ws_command。
    let method = "Page.handleJavaScriptDialog";
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, String>>();
    let sent = match observer_of(agent_id) {
        Some(obs) => obs
            .cmd_tx
            .send(super::session::ObserverCmd {
                method: method.to_string(),
                params: params.clone(),
                reply: tx,
            })
            .is_ok(),
        None => false,
    };
    if sent {
        return match rx.await {
            Ok(Ok(_)) => {
                set_dialog_open(agent_id, false);
                audit_log(
                    agent_id,
                    if accept { "dialog_accept" } else { "dialog_dismiss" },
                    "",
                    "ok",
                );
                Ok(json!({ "handled": true, "accept": accept, "via": "observer" }).to_string())
            }
            Ok(Err(e)) => Err(format!("CDP {method} 错误: {e}")),
            Err(_) => Err("observer 命令通道中断".to_string()),
        };
    }
    // 回退：observer 不可用（未 attach 等）→ 新连接直发（老 Chrome 行为）。
    ws_command(port, &tid, method, params).await?;
    set_dialog_open(agent_id, false);
    audit_log(
        agent_id,
        if accept {
            "dialog_accept"
        } else {
            "dialog_dismiss"
        },
        "",
        "ok",
    );
    Ok(json!({ "handled": true, "accept": accept }).to_string())
}

/// 取最近一次 file chooser 事件（upload 优先用 backendNodeId 注入）。
pub(super) fn latest_file_chooser(agent_id: Option<&str>) -> Option<Value> {
    let obs = ensure_observer(agent_id)?;
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let raw = bufs.file_choosers.back()?;
    serde_json::from_str(raw).ok()
}

pub(super) fn set_dialog_open(agent_id: Option<&str>, open: bool) {
    if let Some(obs) = observer_of(agent_id) {
        crate::utils::lock_or_recover(&obs.buffers).dialog_open = open;
    }
}

pub(super) fn set_file_chooser_open(agent_id: Option<&str>, open: bool) {
    if let Some(obs) = observer_of(agent_id) {
        crate::utils::lock_or_recover(&obs.buffers).file_chooser_open = open;
    }
}

/// 当前错误缓冲条数（世界变化对比用）。
pub(super) fn error_count(agent_id: Option<&str>) -> usize {
    let Some(obs) = observer_of(agent_id) else {
        return 0;
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    bufs.errors.len()
}

// ═══════════════════════════════════════════════════════════
// 操作 — actionability + 世界变化反馈
// ═══════════════════════════════════════════════════════════

/// 从 CDP returnByValue 结果解析世界状态。契约：evaluate 表达式必须
/// 直接返回 {u, d} 对象（非 JSON.stringify 字符串）——见 world_snapshot。
pub(super) fn parse_world_value(val: &Value) -> (String, usize) {
    let u = val["u"].as_str().unwrap_or("").to_string();
    let d = val["d"].as_u64().unwrap_or(0) as usize;
    (u, d)
}

/// 世界状态采样：URL / DOM 大小 / 错误数。
pub(super) async fn world_snapshot(
    agent_id: Option<&str>,
) -> Result<(String, usize, usize), String> {
    // 直接返回对象（returnByValue 原样传回 JS 对象），不能再 JSON.stringify：
    // stringify 后 val 是字符串，val["u"] 永远取到 Null —— URL/DOM 检测
    // 从 b4dd1f5 起就静默失效，世界反馈一直报"无显著变化"（端到端实测暴露）。
    let expr = "({ u: location.href, d: document.body ? document.body.innerHTML.length : 0 })";
    let val = runtime_evaluate(expr, agent_id).await?;
    let (u, d) = parse_world_value(&val);
    let e = error_count(agent_id);
    Ok((u, d, e))
}

/// 操作后的世界变化摘要。无显著变化时返回 None。
pub(super) fn world_diff(
    before: &(String, usize, usize),
    after: &(String, usize, usize),
) -> Option<String> {
    let mut changes: Vec<String> = Vec::new();
    if after.0 != before.0 {
        changes.push(format!("URL 变化: {} → {}", before.0, after.0));
    }
    let dom_delta = (after.1 as i64) - (before.1 as i64);
    if dom_delta.abs() > 100 {
        changes.push(format!(
            "DOM 大小变化: {dom_delta:+} 字符（{} → {}）",
            before.1, after.1
        ));
    }
    if after.2 > before.2 {
        changes.push(format!(
            "新增 {} 条错误（用 browser(console) 查看）",
            after.2 - before.2
        ));
    }
    if changes.is_empty() {
        None
    } else {
        Some(changes.join("；"))
    }
}

/// 导航轮询上限——链接点击的导航通常 <1s，2s 兜底。
pub(super) const NAV_POLL_TIMEOUT: Duration = Duration::from_secs(2);
/// reload 新文档提交等待上限——reload 可能重建 service worker/长缓存，给得比导航宽。
pub(super) const RELOAD_POLL_TIMEOUT: Duration = Duration::from_secs(5);
/// 导航轮询间隔。
pub(super) const NAV_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// 操作后等待潜在导航完成。端到端实测发现：固定 300ms 等待对导航类点击
/// 不够——采样仍落在旧文档上下文，世界反馈漏报"无显著变化"（点击实际跳了页）。
/// 策略（每种情况都尽早返回，不为无导航点击付满超时）：
///   - URL 已变 → 新文档已提交，再 settle 一次让 DOM 初始化，返回；
///   - URL 未变但 DOM 已显著变化 → SPA 原地更新，无导航，返回；
///   - 采样出错（导航中旧上下文销毁）→ 继续轮询；
///   - 超时（两样都没有）→ 返回，交 world_diff 如实报"无显著变化"。
pub(super) async fn wait_nav_settle(before: &(String, usize, usize), agent_id: Option<&str>) {
    let deadline = Instant::now() + NAV_POLL_TIMEOUT;
    loop {
        let cur = match world_snapshot(agent_id).await {
            Ok(s) => s,
            Err(_) => {
                if Instant::now() >= deadline {
                    return;
                }
                tokio::time::sleep(NAV_POLL_INTERVAL).await;
                continue;
            }
        };
        if cur.0 != before.0 {
            tokio::time::sleep(POST_ACTION_SETTLE).await;
            return;
        }
        if (cur.1 as i64 - before.1 as i64).abs() > 100 {
            return;
        }
        if Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(NAV_POLL_INTERVAL).await;
    }
}

/// reload 专项等待：URL/DOM 都可能与刷新前完全相同，不能复用 wait_nav_settle
/// （它看到 URL 不变 + DOM 无显著变化会立即返回，可能抢在刷新完成前采样）。
/// 以 performance.timeOrigin 变化为「新文档已提交」信号，再等 readyState=complete。
pub(super) async fn wait_reload_commit(before_origin: f64, agent_id: Option<&str>) {
    let deadline = Instant::now() + RELOAD_POLL_TIMEOUT;
    loop {
        match runtime_evaluate(
            "({t: performance.timeOrigin, r: document.readyState})",
            agent_id,
        )
        .await
        {
            Ok(v) => {
                let committed = v["t"]
                    .as_f64()
                    .map(|t| (t - before_origin).abs() > 0.001)
                    .unwrap_or(false);
                if committed && v["r"].as_str() == Some("complete") {
                    tokio::time::sleep(POST_ACTION_SETTLE).await;
                    return;
                }
            }
            Err(_) => {
                // 刷新过程中旧文档上下文销毁——继续轮询，等新文档能响应 evaluate。
            }
        }
        if Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(NAV_POLL_INTERVAL).await;
    }
}

/// 导航后统一结算：等待潜在导航稳定 → 采样新世界 → 返回 (当前 URL, 变化摘要)。
/// 供 navigate / back / forward / reload 复用，与 click 的反馈语义一致。
pub(super) async fn navigation_outcome(
    before: &(String, usize, usize),
    agent_id: Option<&str>,
) -> Result<(String, String), String> {
    wait_nav_settle(before, agent_id).await;
    let after = world_snapshot(agent_id).await?;
    let change = world_diff(before, &after).unwrap_or_else(|| "无显著变化".into());
    Ok((after.0, change))
}

/// 导航到 URL（Page.navigate）。操作前采样旧世界，操作后返回 URL/DOM/错误变化。
pub(crate) async fn cdp_navigate(url: &str, agent_id: Option<&str>) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("navigate: url 不能为空".into());
    }
    let (port, tid) = require_target(agent_id)?;
    let before = world_snapshot(agent_id).await?;
    let resp = ws_command(port, &tid, "Page.navigate", json!({ "url": url })).await?;
    if let Some(err) = resp["result"]["errorText"].as_str() {
        return Err(format!("Page.navigate 错误: {err}"));
    }
    let (current, change) = navigation_outcome(&before, agent_id).await?;
    audit_log(agent_id, "navigate", url, &change);
    Ok(json!({ "navigated": url, "url": current, "change": change }).to_string())
}

/// 读取导航历史并跳转到 currentIndex + delta 的条目（delta = -1 back / +1 forward）。
pub(super) async fn cdp_history_step(
    delta: isize,
    action: &str,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    let before = world_snapshot(agent_id).await?;
    let resp = ws_command(port, &tid, "Page.getNavigationHistory", json!({})).await?;
    let current = resp["result"]["currentIndex"]
        .as_i64()
        .ok_or("Page.getNavigationHistory 未返回 currentIndex")?;
    let target_index = current + delta as i64;
    if target_index < 0 {
        return Err(format!("{action}: 没有更早的历史记录"));
    }
    let entries = resp["result"]["entries"]
        .as_array()
        .ok_or("Page.getNavigationHistory 未返回 entries")?;
    let entry = entries
        .get(target_index as usize)
        .ok_or_else(|| format!("{action}: 没有可跳转的历史记录"))?;
    let entry_id = entry["id"]
        .as_i64()
        .ok_or_else(|| format!("{action}: 历史条目缺少 id"))?;
    ws_command(
        port,
        &tid,
        "Page.navigateToHistoryEntry",
        json!({ "entryId": entry_id }),
    )
    .await?;
    let (current_url, change) = navigation_outcome(&before, agent_id).await?;
    audit_log(agent_id, action, &current_url, &change);
    Ok(json!({ "navigated": action, "url": current_url, "change": change }).to_string())
}

/// 后退一页。
pub(crate) async fn cdp_back(agent_id: Option<&str>) -> Result<String, String> {
    cdp_history_step(-1, "back", agent_id).await
}

/// 前进一页。
pub(crate) async fn cdp_forward(agent_id: Option<&str>) -> Result<String, String> {
    cdp_history_step(1, "forward", agent_id).await
}

/// 刷新当前页。
pub(crate) async fn cdp_reload(agent_id: Option<&str>) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    let before = world_snapshot(agent_id).await?;
    let before_origin = runtime_evaluate("performance.timeOrigin", agent_id)
        .await?
        .as_f64()
        .ok_or("reload: 无法读取 performance.timeOrigin")?;
    ws_command(port, &tid, "Page.reload", json!({ "ignoreCache": false })).await?;
    wait_reload_commit(before_origin, agent_id).await;
    let (current, change) = navigation_outcome(&before, agent_id).await?;
    audit_log(agent_id, "reload", &current, &change);
    Ok(json!({ "reloaded": true, "url": current, "change": change }).to_string())
}

/// actionability 等待：元素存在、可见、中心点未被遮挡、位置稳定（两次采样差 <1px）。
/// 返回元素中心点（viewport 相对）。超时返回带恢复指引的错误。
pub(super) async fn wait_actionable(
    target: &str,
    label: &str,
    agent_id: Option<&str>,
) -> Result<(f64, f64), String> {
    let deadline = Instant::now() + ACTIONABILITY_TIMEOUT;
    let mut last_center: Option<(f64, f64)> = None;
    loop {
        let finder = find_el_expr(target)?;
        let expr = format!(
            r#"(() => {{ const el = {finder}; if (!el) return null; const r0 = el.getBoundingClientRect(); if (r0.width <= 0 || r0.height <= 0) return {{ reason: 'invisible' }}; let x = r0.x + r0.width / 2, y = r0.y + r0.height / 2; try {{ let win = el.ownerDocument.defaultView; let frame = win && win.frameElement; while (frame) {{ const fr = frame.getBoundingClientRect(); x += fr.x; y += fr.y; win = win.parent; frame = win && win.frameElement; }} }} catch (e) {{}} const localDoc = el.ownerDocument; const localTop = localDoc.elementFromPoint ? localDoc.elementFromPoint(r0.x + r0.width / 2, r0.y + r0.height / 2) : null; let hit = !localTop || el === localTop || el.contains(localTop); if (!hit && el.getRootNode && el.getRootNode() instanceof ShadowRoot) {{ const host = el.getRootNode().host; hit = !localTop || localTop === host || host.contains(localTop); }} return {{ x, y, hit }}; }})()"#,
            finder = finder
        );
        let val = runtime_evaluate(&expr, agent_id).await?;
        if val.is_null() {
            return Err(err(
                codes::REF_STALE,
                format!("{label}: 目标不存在或已失效（{target}）——页面可能已变化，请重新 browser(snapshot)"),
            ));
        }
        if val["reason"].as_str().is_some() {
            return Err(format!("{label}: 元素不可见（{target}）"));
        }
        let x = val["x"].as_f64().ok_or(format!("{label}: 无法读取坐标"))?;
        let y = val["y"].as_f64().ok_or(format!("{label}: 无法读取坐标"))?;
        if val["hit"].as_bool().unwrap_or(false) {
            if let Some((px, py)) = last_center {
                if (px - x).abs() < 1.0 && (py - y).abs() < 1.0 {
                    return Ok((x, y));
                }
            }
            last_center = Some((x, y));
        }
        if Instant::now() >= deadline {
            return Err(err(
                codes::ACTIONABILITY,
                format!("{label}: 等待可交互超时（{ACTIONABILITY_TIMEOUT:?}）——元素被遮挡或位置持续变化"),
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 点击元素（中心点）。CDP Input.dispatchMouseEvent — 页面内派发，非 OS 级。
/// 点击前等待可交互；点击后返回世界变化摘要。
pub(crate) async fn cdp_click(target: &str, agent_id: Option<&str>) -> Result<String, String> {
    let sel = ref_to_selector(target);
    let before = world_snapshot(agent_id).await?;
    let (x, y) = wait_actionable(&sel, "click", agent_id).await?;
    let (port, tid) = require_target(agent_id)?;
    // 激活窗口再派发：Chrome 冷启动期渲染进程未激活，CDP 合成输入事件
    // 会被吞（e2e 实测：启动后 ~18s 内点击不触发导航，bringToFront 后立即生效）。
    // 对用户自己的浏览器也符合预期——Agent 操作时页面到前台。
    let _ = ws_command(port, &tid, "Page.bringToFront", json!({})).await;
    // bringToFront 是异步的：命令返回 ≠ 激活已落地。满载/冷启动时立刻派发
    // 点击可能被渲染进程丢弃（e2e-1 整租跑实测 click 秒打不导航），留一个
    // 短 settle 让激活传播到渲染进程再派发。
    tokio::time::sleep(Duration::from_millis(150)).await;
    let base = json!({ "x": x, "y": y, "button": "left", "clickCount": 1 });
    let mut pressed = base.clone();
    pressed["type"] = json!("mousePressed");
    let mut released = base.clone();
    released["type"] = json!("mouseReleased");
    ws_command(port, &tid, "Input.dispatchMouseEvent", pressed).await?;
    ws_command(port, &tid, "Input.dispatchMouseEvent", released).await?;
    tokio::time::sleep(POST_ACTION_SETTLE).await;
    wait_nav_settle(&before, agent_id).await;
    let after = world_snapshot(agent_id).await?;
    let change = world_diff(&before, &after).unwrap_or_else(|| "无显著变化".into());
    // 审计对象存人话：元素文本（UI 展示）。点击前查询；导航已跳走时
    // 元素可能消失——查询失败兜底回 ref 号，审计不因展示需求报错。
    let label = element_label(&sel, agent_id)
        .await
        .unwrap_or_else(|| target.to_string());
    audit_log(agent_id, "click", &label, &change);
    Ok(json!({ "clicked": target, "x": x.round(), "y": y.round(), "change": change }).to_string())
}

/// 悬停元素（中心点 mouseMoved）。复用 click 的 actionability 等待，
/// 但不派发按下/释放——hover 菜单、tooltip、CSS :hover 状态。
pub(crate) async fn cdp_hover(target: &str, agent_id: Option<&str>) -> Result<String, String> {
    let sel = ref_to_selector(target);
    let (x, y) = wait_actionable(&sel, "hover", agent_id).await?;
    let (port, tid) = require_target(agent_id)?;
    let _ = ws_command(port, &tid, "Page.bringToFront", json!({})).await;
    ws_command(
        port,
        &tid,
        "Input.dispatchMouseEvent",
        json!({ "type": "mouseMoved", "x": x, "y": y }),
    )
    .await?;
    audit_log(agent_id, "hover", target, "ok");
    Ok(json!({ "hovered": target, "x": x.round(), "y": y.round() }).to_string())
}

/// 查元素的可见文本（截断 40 字符），审计展示用。查不到返回 None。
pub(super) async fn element_label(sel: &str, agent_id: Option<&str>) -> Option<String> {
    let expr = format!(
        r#"(() => {{ const el = {finder}; if (!el) return null; const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '); return t.slice(0, 40); }})()"#,
        finder = find_el_expr(sel).ok()?
    );
    let val = runtime_evaluate(&expr, agent_id).await.ok()?;
    let s = val.as_str()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 输入文本（聚焦元素 + insertText）。中文/IME 友好。
pub(crate) async fn cdp_type(
    target: &str,
    text: &str,
    replace: bool,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let sel = ref_to_selector(target);
    let before = world_snapshot(agent_id).await?;
    let focus_expr = format!(
        r#"(() => {{ const el = {finder}; if (!el) return {{ ok: false, reason: 'missing' }}; el.focus(); if ({replace}) {{ if (el.isContentEditable) {{ el.textContent = ''; }} else if (el.value !== undefined) {{ const proto = Object.getPrototypeOf(el); const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (desc && desc.set) desc.set.call(el, ''); else el.value = ''; if (el.setSelectionRange) el.setSelectionRange(0, 0); el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); }} }} el.focus(); return {{ ok: true }}; }})()"#,
        finder = find_el_expr(&sel)?,
        replace = if replace { "true" } else { "false" }
    );
    let ok = runtime_evaluate(&focus_expr, agent_id).await?;
    if !ok["ok"].as_bool().unwrap_or(false) {
        return Err(err(
            codes::REF_STALE,
            format!("type: 目标不存在或已失效（{target}）——页面可能已变化，请重新 browser(snapshot)"),
        ));
    }
    let (port, tid) = require_target(agent_id)?;
    ws_command(port, &tid, "Input.insertText", json!({ "text": text })).await?;
    tokio::time::sleep(POST_ACTION_SETTLE).await;
    wait_nav_settle(&before, agent_id).await;
    let after = world_snapshot(agent_id).await?;
    let change = world_diff(&before, &after).unwrap_or_else(|| "无显著变化".into());
    // 审计对象存人话：输入内容摘要（UI 展示）；ref 号对用户无意义
    let tgt = format!("输入「{}」", text.chars().take(30).collect::<String>());
    audit_log(agent_id, "type", &tgt, &change);
    Ok(json!({
        "typed": text.chars().take(50).collect::<String>(),
        "replace": replace,
        "change": change,
    })
    .to_string())
}

/// 选择 <select> 的 option：value 优先精确匹配，其次 option 可见文本精确匹配。
/// 使用原生 setter 派发 input/change，React/Vue 受控组件也能收到更新。
pub(crate) async fn cdp_select(
    target: &str,
    value: &str,
    agent_id: Option<&str>,
) -> Result<String, String> {
    if value.is_empty() {
        return Err("select: value 不能为空".into());
    }
    let sel = ref_to_selector(target);
    let before = world_snapshot(agent_id).await?;
    // 与其他操作一致：先等元素可见/无遮挡/稳定，再改值。
    let _ = wait_actionable(&sel, "select", agent_id).await?;
    let target_json = serde_json::to_string(target).map_err(|e| e.to_string())?;
    let expr = format!(
        r#"(() => {{ const el = {finder}; if (!el) return {{ ok: false, error: '目标不存在或已失效（' + {target_json} + '）——请重新 browser(snapshot)' }}; if ((el.tagName || '').toLowerCase() !== 'select') return {{ ok: false, error: '目标不是 <select> 元素' }}; const wanted = {value}; const options = Array.from(el.options).map((o) => {{ const text = (o.textContent || '').trim().replace(/\s+/g, ' '); return {{ value: o.value, text }}; }}); const match = options.find((o) => o.value === wanted) || options.find((o) => o.text === wanted); if (!match) return {{ ok: false, error: '没有匹配的 option（value 或可见文本）: ' + wanted + '。可用: ' + options.slice(0, 20).map((o) => o.value + ':' + o.text).join(' | ') }}; const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); if (desc && desc.set) desc.set.call(el, match.value); else el.value = match.value; el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); return {{ ok: true, value: match.value, text: match.text }}; }})()"#,
        finder = find_el_expr(&sel)?,
        target_json = target_json,
        value = serde_json::to_string(value).map_err(|e| e.to_string())?
    );
    let val = runtime_evaluate(&expr, agent_id).await?;
    if let Some(err) = val["error"].as_str() {
        return Err(format!("select: {err}"));
    }
    if !val["ok"].as_bool().unwrap_or(false) {
        return Err("select: 页面返回异常结果".into());
    }
    tokio::time::sleep(POST_ACTION_SETTLE).await;
    wait_nav_settle(&before, agent_id).await;
    let after = world_snapshot(agent_id).await?;
    let change = world_diff(&before, &after).unwrap_or_else(|| "无显著变化".into());
    let selected = val["text"].as_str().unwrap_or(value);
    audit_log(agent_id, "select", selected, &change);
    Ok(json!({
        "selected": selected,
        "value": val["value"].as_str().unwrap_or(value),
        "change": change,
    })
    .to_string())
}

/// 给 <input type=file> 注入本地文件路径。
/// 优先使用 observer 捕获的 Page.fileChooserOpened.backendNodeId；
/// 没有事件（或 backend 注入失败）时回退到 selector + DOM.querySelector。
pub(crate) async fn cdp_upload(
    selector: Option<String>,
    files: Vec<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let files = files
        .into_iter()
        .filter(|f| !f.trim().is_empty())
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Err("upload: files 不能为空".into());
    }
    let file_count = files.len();
    let (port, tid) = require_target(agent_id)?;

    // 路径 A：拦截到的 file chooser 直接带 backendNodeId。
    if let Some(chooser) = latest_file_chooser(agent_id) {
        if let Some(backend_node_id) = chooser["backendNodeId"].as_u64() {
            match ws_command(
                port,
                &tid,
                "DOM.setFileInputFiles",
                json!({ "files": files.clone(), "backendNodeId": backend_node_id }),
            )
            .await
            {
                Ok(_) => {
                    set_file_chooser_open(agent_id, false);
                    audit_log(agent_id, "upload", "file_chooser", "ok");
                    return Ok(json!({ "uploaded": file_count, "via": "fileChooser" }).to_string());
                }
                Err(e) if selector.is_none() => {
                    return Err(format!(
                        "upload: file chooser 注入失败且未提供 selector 回退: {e}"
                    ));
                }
                Err(_) => {
                    // 有 selector，继续走 DOM.querySelector 回退。
                }
            }
        }
    }

    // 路径 B：selector → DOM.getDocument + DOM.querySelector + DOM.setFileInputFiles。
    // 三条命令必须在同一条 WS 连接上顺序执行：DOM nodeId 是会话（连接）本地状态，
    // 跨连接必失效（Chromium 报 "Could not find node with given id"）。
    let Some(sel) = selector.filter(|s| !s.trim().is_empty()) else {
        return Err("upload: 需要 selector 参数（或先在页面触发 file chooser 事件）".into());
    };
    let sel = ref_to_selector(&sel);
    let results = ws_command_seq(
        port,
        &tid,
        vec![
            Box::new(|_| ("DOM.getDocument".to_string(), json!({ "depth": -1 }))),
            {
                let sel = sel.clone();
                Box::new(move |prev| {
                    let root = prev["result"]["root"]["nodeId"]
                        .as_i64()
                        .unwrap_or(0);
                    (
                        "DOM.querySelector".to_string(),
                        json!({ "nodeId": root, "selector": sel }),
                    )
                })
            },
            {
                let files = files.clone();
                Box::new(move |prev| {
                    let node = prev["result"]["nodeId"].as_i64().unwrap_or(0);
                    (
                        "DOM.setFileInputFiles".to_string(),
                        json!({ "files": files, "nodeId": node }),
                    )
                })
            },
        ],
    )
    .await?;
    // 校验 querySelector 结果：nodeId 为 0 表示无匹配。
    let qs = results
        .get(1)
        .ok_or("upload: DOM.querySelector 无响应")?;
    if qs["result"]["nodeId"].as_i64().unwrap_or(0) == 0 {
        return Err(format!("upload: selector 无匹配: {sel}"));
    }
    set_file_chooser_open(agent_id, false);
    audit_log(agent_id, "upload", &sel, "ok");
    Ok(json!({ "uploaded": file_count, "via": "selector", "selector": sel }).to_string())
}

/// 按键（Enter/Tab/Escape/Backspace/方向键/单字符）+ 组合键修饰。
/// 单字符按键必须携带 text 字段——React 受控输入等场景 keyDown 不带 text
/// 不会产生字符（P0-6）。modifiers 支持 ctrl/alt/shift/meta(cmd)，按
/// “修饰键按下 → 主键按下/抬起 → 修饰键反向抬起”派发，主键事件带 modifiers 位掩码。
/// 归一化组合键修饰参数（ctrl/alt/shift/meta），并去重。
/// 返回 (CDP key 名, CDP code, windowsVirtualKeyCode, modifiers 位掩码位)。
pub(super) fn parse_modifiers(
    modifiers: Option<Vec<String>>,
) -> Result<Vec<(&'static str, &'static str, u32, u32)>, String> {
    let mut mods: Vec<(&'static str, &'static str, u32, u32)> = Vec::new();
    for raw in modifiers.unwrap_or_default() {
        let item = match raw.to_lowercase().as_str() {
            "ctrl" | "control" => ("Control", "ControlLeft", 17u32, 2u32),
            "alt" => ("Alt", "AltLeft", 18, 1),
            "shift" => ("Shift", "ShiftLeft", 16, 8),
            "meta" | "cmd" | "command" | "win" | "windows" => ("Meta", "MetaLeft", 91, 4),
            other => {
                return Err(format!(
                    "不支持的修饰键: {other}（支持 ctrl/alt/shift/meta）"
                ))
            }
        };
        if !mods.iter().any(|m| m.0 == item.0) {
            mods.push(item);
        }
    }
    Ok(mods)
}

pub(crate) async fn cdp_press(
    key: &str,
    modifiers: Option<Vec<String>>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let mods = parse_modifiers(modifiers)?;
    let (port, tid) = require_target(agent_id)?;
    let (key_name, code, vk, text): (&str, String, u32, Option<String>) =
        match key.to_lowercase().as_str() {
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
                    return Err(format!(
                        "不支持的按键: {key}（支持 Enter/Tab/Escape/Backspace/方向键/单字符）"
                    ));
                }
            }
        };

    let mask: u32 = mods.iter().map(|m| m.3).sum();

    for (name, code, vk, _) in &mods {
        ws_command(
            port,
            &tid,
            "Input.dispatchKeyEvent",
            json!({ "type": "keyDown", "key": name, "code": code, "windowsVirtualKeyCode": vk }),
        )
        .await?;
    }
    let mut down = json!({
        "type": "keyDown",
        "key": key_name,
        "code": code.clone(),
        "windowsVirtualKeyCode": vk,
        "modifiers": mask,
    });
    let mut up = json!({
        "type": "keyUp",
        "key": key_name,
        "code": code,
        "windowsVirtualKeyCode": vk,
        "modifiers": mask,
    });
    if let Some(t) = text {
        down["text"] = json!(t);
        up["text"] = json!(t);
    }
    ws_command(port, &tid, "Input.dispatchKeyEvent", down).await?;
    ws_command(port, &tid, "Input.dispatchKeyEvent", up).await?;
    for (name, code, vk, _) in mods.iter().rev() {
        ws_command(
            port,
            &tid,
            "Input.dispatchKeyEvent",
            json!({ "type": "keyUp", "key": name, "code": code, "windowsVirtualKeyCode": vk }),
        )
        .await?;
    }

    let label = if mods.is_empty() {
        key.to_string()
    } else {
        format!(
            "{}+{}",
            mods.iter()
                .map(|m| m.0.to_lowercase())
                .collect::<Vec<_>>()
                .join("+"),
            key_name
        )
    };
    audit_log(agent_id, "press", &label, "ok");
    Ok(json!({ "pressed": label }).to_string())
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
            let sel = ref_to_selector(&sel);
            let expr = format!(
                r#"(() => {{ const el = {finder}; if (!el) return false; el.scrollIntoView({{ behavior: 'smooth', block: 'center' }}); return true; }})()"#,
                finder = find_el_expr(&sel)?
            );
            let ok = runtime_evaluate(&expr, agent_id).await?;
            if !ok.as_bool().unwrap_or(false) {
                return Err(err(
                    codes::REF_STALE,
                    format!("scroll: 目标不存在或已失效: {sel}（请重新 browser(snapshot)）"),
                ));
            }
            audit_log(agent_id, "scroll", &sel, "element");
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
    audit_log(agent_id, "scroll", &dir, "page");
    Ok(json!({ "scrolled": "page", "direction": dir }).to_string())
}

/// 显式等待（B3）：selector 出现且可见，或固定 ms 休眠。
/// 覆盖"点了异步按钮弹 loading 3 秒再出结果"这类场景——已有的 POST_ACTION_SETTLE
/// (300ms) + wait_nav_settle(2s) 对长加载不够，模型需要显式等到条件满足。
/// 二选一：传 ms 则休眠相应时长；传 selector 则轮询到元素存在+可见(默认 10s 超时)。
pub(crate) async fn cdp_wait(
    selector: Option<String>,
    ms: Option<u64>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    // 固定休眠
    if let Some(dur) = ms {
        let dur = dur.min(30_000); // 上限 30s，防模型传超大值卡死
        tokio::time::sleep(Duration::from_millis(dur)).await;
        return Ok(json!({ "waited_ms": dur, "note": "固定休眠完成" }).to_string());
    }
    // 等待 selector 出现+可见
    let Some(sel) = selector.filter(|s| !s.trim().is_empty()) else {
        return Err("wait: 需要提供 selector 或 ms 参数".into());
    };
    require_target(agent_id)?; // 提前校验已 attach
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let expr = format!(
            r#"(() => {{ const el = {finder}; if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }})()"#,
            finder = find_el_expr(&sel)?
        );
        let ok = runtime_evaluate(&expr, agent_id)
            .await
            .unwrap_or(Value::Bool(false));
        if ok.as_bool().unwrap_or(false) {
            let waited = deadline.elapsed().as_millis() as u64;
            return Ok(json!({ "found": true, "selector": &sel, "waited_ms": waited, "note": "元素已出现且可见" }).to_string());
        }
        if Instant::now() >= deadline {
            return Ok(json!({ "found": false, "selector": &sel, "waited_ms": 10000, "note": "等待超时(10s)，未观察到元素出现" }).to_string());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

// ═══════════════════════════════════════════════════════════
// 敏感操作判定（ADR 0003 D6 L3）— rpc 层据此触发单独 Ask
// ═══════════════════════════════════════════════════════════

/// click 高危文本正则源（中文子串 + 英文单词边界）。Rust 单测与页面内 JS
/// 共用这一份源字符串，避免两边单词清单漂移后「英文 Pay now 不触发 Ask」复发。
pub(super) const SENSITIVE_CLICK_RE_SOURCE: &str = r"(确认|提交|支付|转账|购买|删除|注销|退订|清空|\b(pay(?:\s+now)?|payment|purchase|buy(?:\s+now)?|delete|confirm|unsubscribe|sign\s*out|log\s*out|transfer|checkout|clear|submit)\b)";

/// 纯函数版高危文本判定（单测锁定英文词覆盖）。页面内 JS 用同一正则源。
#[cfg(test)]
use std::sync::LazyLock;

#[cfg(test)]
pub(super) fn is_sensitive_click_text(text: &str) -> bool {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(&format!("(?i)({SENSITIVE_CLICK_RE_SOURCE})"))
            .expect("SENSITIVE_CLICK_RE_SOURCE 是静态正则")
    });
    RE.is_match(text)
}

/// 判定目标是否为敏感操作：type 到已填值输入框/password 框；click 提交按钮、
/// 下载链接、或文本含高危动词的元素。判定失败（未 attach 等）静默放行——
/// 后续操作本身会给出明确错误。
pub(crate) async fn check_sensitive(target: &str, action: &str, agent_id: Option<&str>) -> bool {
    let sel = ref_to_selector(target);
    let finder = match find_el_expr(&sel) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let click_re = format!("/{SENSITIVE_CLICK_RE_SOURCE}/i");
    let expr = match action {
        "type" => format!(
            r#"(() => {{ const el = {finder}; if (!el) return false; const t = (el.tagName || '').toLowerCase(); if (t === 'input' && el.type === 'password') return true; return (t === 'input' || t === 'textarea') && !!el.value; }})()"#,
            finder = finder
        ),
        "click" => format!(
            r#"(() => {{ const el = {finder}; if (!el) return false; const t = (el.tagName || '').toLowerCase(); const ty = (t === 'input' || t === 'button') ? (el.type || '').toLowerCase() : ''; if (ty === 'submit') return true; if (el.hasAttribute && el.hasAttribute('download')) return true; const text = (el.innerText || el.value || '').slice(0, 40); return {click_re}.test(text); }})()"#,
            finder = finder,
            click_re = click_re
        ),
        _ => return false,
    };
    runtime_evaluate(&expr, agent_id)
        .await
        .map(|v| v.as_bool().unwrap_or(false))
        .unwrap_or(false)
}

// ═══════════════════════════════════════════════════════════
// viewport / device metrics — Emulation.setDeviceMetricsOverride
// ═══════════════════════════════════════════════════════════

/// 设置 attach 页面的 viewport 指标（DPR / mobile 模拟）。
/// launch 的 windowSize 是窗口物理尺寸；本动作覆盖 CDP 内视口与 DPR，
/// 两者可叠加使用。width/height 1-16384，DPR 0.5-3。
pub(crate) async fn cdp_set_viewport(
    width: u32,
    height: u32,
    device_scale_factor: Option<f64>,
    mobile: Option<bool>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err("viewport: width/height 必须在 1-16384 之间".into());
    }
    let dpr = device_scale_factor.unwrap_or(1.0);
    if !dpr.is_finite() || !(0.5..=3.0).contains(&dpr) {
        return Err("viewport: deviceScaleFactor 必须在 0.5-3 之间".into());
    }
    let (port, tid) = require_target(agent_id)?;
    // Chrome 151 起 Emulation 状态跟 dialog 一样绑定 observer 的 session：
    // 走新连接发 setDeviceMetricsOverride 时 deviceScaleFactor 被丢弃（DPR 恒 1），
    // 必须经 observer_command 在 observer 连接上执行。
    observer_command(
        port,
        &tid,
        agent_id,
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width,
            "height": height,
            "deviceScaleFactor": dpr,
            "mobile": mobile.unwrap_or(false),
        }),
    )
    .await?;
    audit_log(
        agent_id,
        "viewport",
        &format!("{width}x{height}@{dpr}"),
        "ok",
    );
    Ok(json!({
        "viewport": { "width": width, "height": height, "deviceScaleFactor": dpr, "mobile": mobile.unwrap_or(false) },
    })
    .to_string())
}

// ═══════════════════════════════════════════════════════════
// 截图（P2）— Page.captureScreenshot 落盘
// ═══════════════════════════════════════════════════════════

pub(crate) async fn cdp_screenshot(
    full_page: bool,
    inline: bool,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    let resp = ws_command(
        port,
        &tid,
        "Page.captureScreenshot",
        json!({ "format": "png", "captureBeyondViewport": full_page }),
    )
    .await?;
    let data = resp["result"]["data"]
        .as_str()
        .ok_or("截图失败: 响应无 data（Page.captureScreenshot 未返回图片）")?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("截图 base64 解码失败: {e}"))?;
    let dir = std::env::temp_dir().join(SHOT_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
    cleanup_old_files_by_age(
        &dir,
        SHOT_FILE_PREFIX,
        shot_retain_days(),
        std::time::SystemTime::now(),
    );
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("shot-{ts}.png"));
    std::fs::write(&path, bytes).map_err(|e| format!("写截图文件失败: {e}"))?;
    audit_log(agent_id, "screenshot", &tid, "ok");

    // inline 上限保护：3MB 内直接回 data URL；更大的图只回路径，避免 IPC/上下文爆炸。
    const MAX_INLINE_SHOT_BYTES: usize = 3 * 1024 * 1024;
    let byte_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if inline && byte_len <= MAX_INLINE_SHOT_BYTES as u64 {
        return Ok(json!({
            "path": path.to_string_lossy(),
            "bytes": byte_len,
            "fullPage": full_page,
            "inline": true,
            "dataUrl": format!("data:image/png;base64,{data}"),
            "note": "dataUrl 为 PNG data URL，可直接作为图片内容消费",
        })
        .to_string());
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": byte_len,
        "fullPage": full_page,
        "inline": false,
        "note": if inline {
            "截图超过 3MB 内联上限，已落盘（可用 read_file_base64 读取）"
        } else {
            "截图已落盘（纯文本模型看不到内容，可交给用户确认；vision 模型可读路径）"
        },
    })
    .to_string())
}

// ═══════════════════════════════════════════════════════════
// eval — 任意 JS（白名单限制）
// ═══════════════════════════════════════════════════════════

/// eval 静态白名单：禁止网络外联、存储写入、弹窗等。
/// 注：静态字符串匹配是纵深防御而非安全边界（eval 本身走权限 Ask），
/// 动态方法名等写法可绕过。
pub(super) fn check_eval_expr(expr: &str) -> Result<(), String> {
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
            return Err(err(
                codes::EVAL_BLOCKED,
                format!("eval 表达式被拒绝：包含 {what}（白名单限制）。需要读 DOM/样式/几何请用 browser(inspect)，需要操作请用 click/type/scroll。"),
            ));
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

// ═══════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════

/// 当前会话状态（供 UI 显示）。external=true 表示连接的是用户自己的实例
/// （connect 来的），kill 只断开、租约只断连，不会杀进程。
pub(crate) fn cdp_status(agent_id: Option<&str>) -> String {
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    let external = sess.chrome_child.is_none() && sess.port != 0;
    let observer_alive = sess
        .observer
        .as_ref()
        .map(|o| o.alive.load(Ordering::SeqCst))
        .unwrap_or(false);
    let observer = sess.observer.clone();
    let (dialog_open, file_chooser_open) = match observer {
        Some(obs) => {
            let bufs = crate::utils::lock_or_recover(&obs.buffers);
            (bufs.dialog_open, bufs.file_chooser_open)
        }
        None => (false, false),
    };
    json!({
        "port": sess.port,
        "slot": sess.slot,
        "attached": sess.target_id.is_some(),
        "chromeRunning": sess.chrome_child.is_some(),
        "external": external,
        "observerAlive": observer_alive,
        "dialogPending": dialog_open,
        "fileChooserPending": file_chooser_open,
        "profileEphemeral": sess.profile_ephemeral,
        "proxy": sess.proxy,
    })
    .to_string()
}

// ═══════════════════════════════════════════════════════════
// self 只读动作 — 惰性 attach 自家 webview（首次读操作触发）
// ═══════════════════════════════════════════════════════════
// rpc 层 self=true 时以 SELF_AGENT_ID 路由进来；runtime_evaluate /
// observer_of / ensure_observer 在需要时惰性 attach，无需显式 attach 命令。
