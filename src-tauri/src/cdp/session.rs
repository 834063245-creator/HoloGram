// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! CDP 会话状态 + 事件缓冲 + 审计 + Chrome 生命周期。
//! 从 cdp.rs 拆出（第四批工程债）：actions 仍留在 cdp.rs，
//! 但会话键控/租约/observer/HAR 事件模型已与单文件解耦。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::transport::{http_close_tab, http_new_tab, list_targets_raw};

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/// HoloGram 自家 webview 的调试端口（tauri.conf.json additionalBrowserArgs）。
/// 受控 Chrome 永远不许用这个端口；self 会话专用。
pub(super) const WEBVIEW_DEBUG_PORT: u16 = 9222;

/// 受控 Chrome 默认端口起点，占用则向后探测（避开 9222）。
pub(super) const DEFAULT_PORT_BASE: u16 = 9223;
pub(super) const PORT_PROBE_LIMIT: u16 = 16;

/// Runtime.evaluate 的 CDP 层超时（毫秒）——表达式死循环在此上限内被打断。
pub(super) const EVAL_TIMEOUT_MS: u64 = 5000;

/// actionability 等待上限——元素可见/无遮挡/位置稳定。
pub(super) const ACTIONABILITY_TIMEOUT: Duration = Duration::from_secs(5);

/// 操作后等待世界稳定再采样的时间。
pub(super) const POST_ACTION_SETTLE: Duration = Duration::from_millis(300);

/// 会话空闲租约（默认值）——超时自动 kill 受控 Chrome 并回收会话。
pub(super) const DEFAULT_SESSION_LEASE: Duration = Duration::from_secs(600);

/// 会话空闲租约。默认 10 分钟；HOLOGRAM_BROWSER_LEASE_SECS（秒，≥1）可覆盖，
/// 让租约回收实测不必干等。
pub(super) fn session_lease() -> Duration {
    std::env::var("HOLOGRAM_BROWSER_LEASE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&s| s >= 1)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_SESSION_LEASE)
}

/// 受控 Chrome profile 目录名前缀（临时目录下）。按端口分目录，
/// 杜绝多 Agent 共用同一 user-data-dir 导致 Chrome 实例委托、端口失效。
pub(super) const PROFILE_DIR_PREFIX: &str = "hologram-browser-profile";

/// 具名账号 profile 目录前缀（临时目录下）。具名 profile 是持久登录态：
/// kill/租约只停 Chrome、不删目录，供下次 launch 或 switch 恢复。
pub(super) const NAMED_PROFILE_DIR_PREFIX: &str = "hologram-browser-profiles";

/// 指定端口的 profile 目录（默认无具名账号时的临时 profile）。
pub(super) fn profile_dir_for(port: u16) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{PROFILE_DIR_PREFIX}-{port}"))
}

/// 具名账号的持久 profile 目录。slot 名已由 normalize_slot_name 校验，
/// 不包含路径分隔符/控制字符，直接拼目录名是安全的。
pub(super) fn named_profile_dir(slot: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{NAMED_PROFILE_DIR_PREFIX}-{slot}"))
}

/// slot/profile 名校验：允许 Unicode（中文账号名可用），但拒绝路径分隔符、
/// Windows 非法字符、控制字符、纯 `.` / `..`，且长度有上限（目录名可读）。
pub(super) fn normalize_slot_name(slot: &str) -> Result<String, String> {
    let slot = slot.trim();
    if slot.is_empty() {
        return Ok(DEFAULT_SLOT.to_string());
    }
    if slot.len() > 48 {
        return Err("profile/session 名过长（最多 48 字符）".into());
    }
    if slot == "." || slot == ".." {
        return Err("profile/session 名不能是 . 或 ..".into());
    }
    if slot
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("profile/session 名不能包含 / \\ : * ? \" < > | 或控制字符".into());
    }
    Ok(slot.to_string())
}

/// 尽力删除 profile 目录（Chrome 残留句柄可能致失败——静默，清理是尽力而为）。
pub(super) fn remove_profile_dir(dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// 清扫遗留 profile 目录：只动本套件前缀的目录，跳过仍被存活会话引用的。
/// 在 sessions 锁内调用（调用方已持锁），登记新目录必须先于 spawn（见 cdp_launch），
/// 否则并发 launch 可能互删对方正在使用的目录。
pub(super) fn sweep_stale_profiles(sessions: &HashMap<String, CdpSession>) {
    // 测试进程与正在运行的 app 共享同一临时目录：app 的 SESSIONS 在它自己的
    // 进程里，这里看不到——若照常清扫会把 app 仍在使用的受控 Chrome profile
    // 误删（活体损坏）。e2e 只测 kill 路径的定向删除，不做全量清扫。
    if cfg!(test) {
        return;
    }
    let live: Vec<&std::path::PathBuf> = sessions
        .values()
        .filter_map(|s| s.profile_dir.as_ref())
        .collect();
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_ours =
            name == PROFILE_DIR_PREFIX || name.starts_with(&format!("{PROFILE_DIR_PREFIX}-"));
        if !is_ours || !path.is_dir() || live.iter().any(|l| **l == path) {
            continue;
        }
        remove_profile_dir(&path);
    }
}

/// 事件缓冲上限（条）。
pub(super) const CONSOLE_BUF_MAX: usize = 200;
pub(super) const NETWORK_BUF_MAX: usize = 200;
pub(super) const ERROR_BUF_MAX: usize = 100;
pub(super) const DIALOG_BUF_MAX: usize = 20;
pub(super) const FILE_CHOOSER_BUF_MAX: usize = 20;

/// 审计内存环形上限（条）。
pub(super) const AUDIT_MAX: usize = 500;

/// self 会话的 session key / agent_id（与 Agent 会话隔离，见 SELF_AGENT_ID）。
pub(super) const DEFAULT_SESSION_KEY: &str = "default";

/// 无显式 profile/session 参数时的账号槽位。
pub(super) const DEFAULT_SLOT: &str = "default";

/// self 模式的读动作路由键：rpc 层 self=true 时以它作为 agent_id 传入，
/// cdp 内部函数按 agent_id 路由到 self 会话（自家 webview 调试端口上的只读会话）。
pub(crate) const SELF_AGENT_ID: &str = "__self__";

pub(crate) fn is_self(agent_id: Option<&str>) -> bool {
    agent_id == Some(SELF_AGENT_ID)
}

// ═══════════════════════════════════════════════════════════
// 事件缓冲 + 观察任务
// ═══════════════════════════════════════════════════════════

/// 网络事件条目 — 请求与响应按 requestId 配对后落入环形缓冲。
/// 旧实现把 request / response / failed 当成三条独立流水账追加，
/// 模型要自己猜「哪条 response 对应哪条 request」；loadingFailed 甚至把
/// requestId 塞进 url 字段。现在每条 requestId 只有一条记录，响应/失败就地回填。
#[derive(Clone, Default)]
pub(super) struct NetworkEntry {
    pub(super) request_id: String,
    pub(super) method: String,
    /// 全量 URL（查询列表时再截断展示；详情保留完整 URL 便于复现请求）。
    pub(super) url: Option<String>,
    pub(super) status: Option<u64>,
    pub(super) status_text: Option<String>,
    pub(super) mime_type: Option<String>,
    pub(super) resource_type: Option<String>,
    pub(super) frame_id: Option<String>,
    pub(super) wall_time: Option<f64>,
    pub(super) request_headers: Option<Value>,
    pub(super) response_headers: Option<Value>,
    pub(super) post_data: Option<String>,
    pub(super) error: Option<String>,
}

impl NetworkEntry {
    fn from_request(params: &Value) -> Self {
        let req = &params["request"];
        Self {
            request_id: params["requestId"].as_str().unwrap_or("").to_string(),
            method: req["method"].as_str().unwrap_or("").to_string(),
            url: req["url"].as_str().map(String::from),
            resource_type: params["type"].as_str().map(String::from),
            frame_id: params["frameId"].as_str().map(String::from),
            wall_time: params["wallTime"].as_f64(),
            request_headers: req.get("headers").filter(|v| v.is_object()).cloned(),
            post_data: req["postData"].as_str().map(|s| truncate_str(s, 2000)),
            ..Self::default()
        }
    }

    /// browser(network) 列表条目：URL 截断展示，requestId 稳定可见。
    pub(super) fn summary_value(&self) -> Value {
        json!({
            "requestId": self.request_id,
            "method": self.method,
            "url": self.url.as_deref().map(|u| truncate_str(u, 200)),
            "status": self.status,
            "mimeType": self.mime_type,
            "resourceType": self.resource_type,
            "error": self.error,
        })
    }

    /// browser(network_detail) 单请求详情：完整 URL + 请求/响应头 + postData。
    pub(super) fn detail_value(&self) -> Value {
        json!({
            "requestId": self.request_id,
            "url": self.url,
            "method": self.method,
            "status": self.status,
            "statusText": self.status_text,
            "mimeType": self.mime_type,
            "resourceType": self.resource_type,
            "frameId": self.frame_id,
            "wallTime": self.wall_time,
            "requestHeaders": self.request_headers,
            "responseHeaders": self.response_headers,
            "postData": self.post_data,
            "error": self.error,
        })
    }

    /// 转成 HAR 1.2 entry。observer 没有保存 timing，所以 timings 置 -1；
    /// 请求/响应头、queryString、postData、状态与 mimeType 均保留真实内容。
    pub(super) fn har_entry(&self) -> Value {
        let url = self.url.as_deref().unwrap_or("");
        let started = self
            .wall_time
            .and_then(|secs| {
                let whole = secs.trunc() as i64;
                let nanos = ((secs.fract().abs()) * 1_000_000_000.0) as u32;
                let nanos = nanos.min(999_999_999);
                chrono::DateTime::from_timestamp(whole, nanos)
            })
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();
        let mut request = json!({
            "method": self.method,
            "url": url,
            "httpVersion": "",
            "headers": har_headers(&self.request_headers),
            "queryString": har_query_string(url),
            "cookies": [],
            "headersSize": -1,
            "bodySize": -1,
        });
        if let Some(post_data) = &self.post_data {
            request["postData"] = json!({ "mimeType": "text/plain", "text": post_data });
        }
        let mut response = json!({
            "status": self.status.unwrap_or(0),
            "statusText": self.status_text,
            "httpVersion": "",
            "headers": har_headers(&self.response_headers),
            "cookies": [],
            "content": { "size": 0, "mimeType": self.mime_type },
            "redirectURL": "",
            "headersSize": -1,
            "bodySize": -1,
        });
        if let Some(error) = &self.error {
            response["_error"] = json!(error);
        }
        json!({
            "startedDateTime": started,
            "time": 0,
            "request": request,
            "response": response,
            "cache": {},
            "timings": { "send": -1, "wait": -1, "receive": -1 },
            "connection": self.request_id,
        })
    }
}

/// CDP headers 对象 → HAR `[{name,value}]`。值为非字符串时按 JSON 序列化。
pub(super) fn har_headers(headers: &Option<Value>) -> Vec<Value> {
    headers
        .as_ref()
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    json!({
                        "name": k,
                        "value": v.as_str().map(String::from).unwrap_or_else(|| v.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn har_query_string(url: &str) -> Vec<Value> {
    url::Url::parse(url)
        .map(|u| {
            u.query_pairs()
                .map(|(k, v)| json!({ "name": k, "value": v }))
                .collect()
        })
        .unwrap_or_default()
}

/// 页面事件环形缓冲——事件 task 写入，查询动作读取。
#[derive(Default)]
pub(super) struct EventBuffers {
    pub(super) console: VecDeque<String>,
    pub(super) network: VecDeque<NetworkEntry>,
    /// requestId -> 配对条目。与 network 环形缓冲同步淘汰，
    /// 保证 network_detail 只能查到仍在缓冲窗口内的请求。
    pub(super) network_index: HashMap<String, NetworkEntry>,
    pub(super) errors: VecDeque<String>,
    pub(super) dialogs: VecDeque<String>,
    pub(super) file_choosers: VecDeque<String>,
    /// 当前是否有未处理的 javascript dialog（Page.javascriptDialogOpening 起，
    /// Closed / 主动 handle 后复位）。
    pub(super) dialog_open: bool,
    /// 最近一次 Page.fileChooserOpened 是否尚未被 upload 消费。
    pub(super) file_chooser_open: bool,
}

/// 事件观察句柄。alive 标志由后台 task 维护：
/// 连接建立成功 → true；WS 断开/task 退出 → false。
/// 命令执行前检查 alive，false 且 target 还在则惰性重启。
#[derive(Clone)]
pub(super) struct Observer {
    pub(super) buffers: Arc<Mutex<EventBuffers>>,
    pub(super) alive: Arc<AtomicBool>,
}

pub(super) fn push_capped(buf: &mut VecDeque<String>, entry: String, cap: usize) {
    if buf.len() >= cap {
        buf.pop_front();
    }
    buf.push_back(entry);
}

pub(super) fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

/// 写入/替换一条网络条目，并同步维护 requestId 索引与环形上限。
pub(super) fn network_upsert(bufs: &mut EventBuffers, entry: NetworkEntry) {
    if let Some(pos) = bufs
        .network
        .iter()
        .position(|e| e.request_id == entry.request_id)
    {
        bufs.network.remove(pos);
    }
    bufs.network_index
        .insert(entry.request_id.clone(), entry.clone());
    bufs.network.push_back(entry);
    if bufs.network.len() > NETWORK_BUF_MAX {
        if let Some(old) = bufs.network.pop_front() {
            bufs.network_index.remove(&old.request_id);
        }
    }
}

/// Network.requestWillBeSent：新请求建立配对条目。redirect 会复用 requestId，
/// 因此同 id 再出现时替换旧条目，保留环形缓冲里的唯一记录。
pub(super) fn network_on_request(bufs: &mut EventBuffers, params: &Value) {
    network_upsert(bufs, NetworkEntry::from_request(params));
}

/// Network.responseReceived：按 requestId 回填 status/headers，不再追加一条
/// 与请求割裂的 "method":"resp" 流水账。请求早于 observer 启动而缺失时，
/// 退化为一条只有响应信息的记录（url 未知比伪造 url 更诚实）。
pub(super) fn network_on_response(bufs: &mut EventBuffers, params: &Value) {
    let request_id = params["requestId"].as_str().unwrap_or("").to_string();
    if request_id.is_empty() {
        return;
    }
    let response = &params["response"];
    let updated = if let Some(entry) = bufs.network_index.get_mut(&request_id) {
        entry.url = response["url"]
            .as_str()
            .map(String::from)
            .or_else(|| entry.url.clone());
        entry.status = response["status"].as_u64();
        entry.status_text = response["statusText"].as_str().map(String::from);
        entry.mime_type = response["mimeType"].as_str().map(String::from);
        entry.response_headers = response.get("headers").filter(|v| v.is_object()).cloned();
        Some(entry.clone())
    } else {
        None
    };
    match updated {
        Some(entry) => {
            if let Some(pos) = bufs.network.iter().position(|e| e.request_id == request_id) {
                bufs.network[pos] = entry;
            }
        }
        None => {
            let entry = NetworkEntry {
                request_id,
                url: response["url"].as_str().map(String::from),
                status: response["status"].as_u64(),
                status_text: response["statusText"].as_str().map(String::from),
                mime_type: response["mimeType"].as_str().map(String::from),
                response_headers: response.get("headers").filter(|v| v.is_object()).cloned(),
                ..NetworkEntry::default()
            };
            network_upsert(bufs, entry);
        }
    }
}

/// Network.loadingFailed：按 requestId 回填 error；不再把 requestId 塞进 url 字段。
pub(super) fn network_on_failed(bufs: &mut EventBuffers, params: &Value) {
    let request_id = params["requestId"].as_str().unwrap_or("").to_string();
    if request_id.is_empty() {
        return;
    }
    let error = params["errorText"].as_str().unwrap_or("failed").to_string();
    let updated = if let Some(entry) = bufs.network_index.get_mut(&request_id) {
        entry.error = Some(error.clone());
        Some(entry.clone())
    } else {
        None
    };
    match updated {
        Some(entry) => {
            if let Some(pos) = bufs.network.iter().position(|e| e.request_id == request_id) {
                bufs.network[pos] = entry;
            }
        }
        None => {
            network_upsert(
                bufs,
                NetworkEntry {
                    request_id,
                    error: Some(error),
                    ..NetworkEntry::default()
                },
            );
        }
    }
}

/// 启动事件观察 task：持久 WS + 订阅 Runtime/Log/Network。
/// 短阻塞的 /json 查询放 spawn_blocking 里，避免卡 runtime。
///
/// A4：reuse_buffers 复用旧观察任务的缓冲。事件缓冲是会话级资产，
/// 观察任务因 target 抖动 / WS 断连短暂死亡后重启若重建新缓冲（旧实现默认），
/// 会把已累积的 console/network/error 历史清空——agent 点完按钮查错误时
/// 可能丢掉正是触发它排查的那条错误。传入旧 buffers 使历史跨重启保留。
pub(super) fn start_observer(
    port: u16,
    target_id: &str,
    reuse_buffers: Option<Arc<Mutex<EventBuffers>>>,
) -> Observer {
    let buffers = reuse_buffers.unwrap_or_else(|| Arc::new(Mutex::new(EventBuffers::default())));
    let alive = Arc::new(AtomicBool::new(false));
    let (b2, a2, tid) = (buffers.clone(), alive.clone(), target_id.to_string());
    tokio::spawn(async move {
        let ws_url = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let raw = list_targets_raw(port)?;
            let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
            arr.iter()
                .find(|t| t["id"].as_str() == Some(tid.as_str()))
                .and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from))
                .ok_or_else(|| format!("target {tid} 已消失"))
        })
        .await;
        // spawn_blocking 的 await 返回 Result<Result<String,String>, JoinError> — 两层解包
        let Ok(Ok(ws_url)) = ws_url else { return };
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(&ws_url).await else {
            return;
        };
        // 订阅事件（命令 id 用 ≥1000 与命令通道区分，响应直接跳过）。
        // Page.enable 让 dialog/file chooser 事件可达；拦截 file chooser 后
        // 文件选择框不会弹出原生窗口（upload 用 DOM.setFileInputFiles 注入）。
        for (id, method) in [
            (1000u64, "Runtime.enable"),
            (1001, "Log.enable"),
            (1002, "Network.enable"),
            (1003, "Page.enable"),
        ] {
            let msg = json!({ "id": id, "method": method }).to_string();
            if ws.send(Message::text(msg)).await.is_err() {
                return;
            }
        }
        // 只拦截 Agent 操作的外部/受控页面 file chooser。self 会话是自家 webview
        // 只读通道——若在这里也开启拦截，会把 HoloGram UI 自己的文件选择框改掉。
        if port != WEBVIEW_DEBUG_PORT {
            let intercept = json!({
                "id": 1004u64,
                "method": "Page.setInterceptFileChooserDialog",
                "params": { "enabled": true }
            })
            .to_string();
            if ws.send(Message::text(intercept)).await.is_err() {
                return;
            }
        }
        a2.store(true, Ordering::SeqCst);
        while let Some(Ok(msg)) = ws.next().await {
            let Message::Text(t) = msg else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&t) else {
                continue;
            };
            if v["id"].as_u64().is_some() {
                continue; // 命令响应，不属于事件流
            }
            let method = v["method"].as_str().unwrap_or("");
            let params = &v["params"];
            let mut bufs = crate::utils::lock_or_recover(&b2);
            match method {
                "Runtime.consoleAPICalled" => {
                    let ctype = params["type"].as_str().unwrap_or("log");
                    let text = params["args"]
                        .as_array()
                        .map(|args| {
                            args.iter()
                                .filter_map(|a| {
                                    a["value"].as_str().or_else(|| a["description"].as_str())
                                })
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    let entry =
                        json!({ "type": ctype, "text": truncate_str(&text, 300) }).to_string();
                    push_capped(&mut bufs.console, entry.clone(), CONSOLE_BUF_MAX);
                    if ctype == "error" {
                        push_capped(&mut bufs.errors, entry, ERROR_BUF_MAX);
                    }
                }
                "Runtime.exceptionThrown" => {
                    let text = params["exceptionDetails"]["exception"]["description"]
                        .as_str()
                        .unwrap_or("exception");
                    let entry =
                        json!({ "type": "exception", "text": truncate_str(text, 300) }).to_string();
                    push_capped(&mut bufs.errors, entry.clone(), ERROR_BUF_MAX);
                    push_capped(&mut bufs.console, entry, CONSOLE_BUF_MAX);
                }
                "Log.entryAdded" => {
                    let entry_obj = &params["entry"];
                    let level = entry_obj["level"].as_str().unwrap_or("info");
                    let text = entry_obj["text"].as_str().unwrap_or("");
                    let entry =
                        json!({ "type": level, "text": truncate_str(text, 300) }).to_string();
                    push_capped(&mut bufs.console, entry.clone(), CONSOLE_BUF_MAX);
                    if level == "error" {
                        push_capped(&mut bufs.errors, entry, ERROR_BUF_MAX);
                    }
                }
                "Network.requestWillBeSent" => {
                    network_on_request(&mut bufs, params);
                }
                "Network.responseReceived" => {
                    network_on_response(&mut bufs, params);
                }
                "Network.loadingFailed" => {
                    network_on_failed(&mut bufs, params);
                }
                "Page.javascriptDialogOpening" => {
                    let dialog_type = params["type"].as_str().unwrap_or("alert");
                    let entry = json!({
                        "type": dialog_type,
                        "message": truncate_str(params["message"].as_str().unwrap_or(""), 300),
                        "defaultPrompt": params["defaultPrompt"].as_str().unwrap_or(""),
                        "url": truncate_str(params["url"].as_str().unwrap_or(""), 200),
                    })
                    .to_string();
                    push_capped(&mut bufs.dialogs, entry, DIALOG_BUF_MAX);
                    bufs.dialog_open = true;
                }
                "Page.javascriptDialogClosed" => {
                    bufs.dialog_open = false;
                }
                "Page.fileChooserOpened" => {
                    let backend_node_id = params["backendNodeId"].as_u64();
                    let entry = json!({
                        "frameId": params["frameId"].as_str().unwrap_or(""),
                        "mode": params["mode"].as_str().unwrap_or(""),
                        "backendNodeId": backend_node_id,
                    })
                    .to_string();
                    push_capped(&mut bufs.file_choosers, entry, FILE_CHOOSER_BUF_MAX);
                    bufs.file_chooser_open = true;
                }
                _ => {}
            }
        }
        a2.store(false, Ordering::SeqCst);
    });
    Observer { buffers, alive }
}

/// 启动/重启会话观察任务（统一入口，A4 修复）。
/// - 复用旧观察任务的 buffers：事件历史跨短暂断连/重启保留，不因重建丢失。
/// - observer_starting 在途闸：持会话锁期间仍防并发重复 spawn 同一 target 的观察任务
///   （旧实现无闸，attach / self 惰性 attach / 惰性重启 三条路径竞态会 spawn 出
///   多个观察任务，只有最后一个被挂到 sess.observer，其余成为孤儿任务空转）。
pub(super) fn ensure_observer_started(sess: &mut CdpSession, port: u16, tid: &str) {
    if sess.observer_starting.swap(true, Ordering::SeqCst) {
        return; // 已有观察任务在途启动，跳过本次
    }
    let reuse = sess.observer.as_ref().map(|o| Arc::clone(&o.buffers));
    sess.observer = Some(start_observer(port, tid, reuse));
    sess.observer_starting.store(false, Ordering::SeqCst);
}

// ═══════════════════════════════════════════════════════════
// 会话状态 — 按 agent 键控
// ═══════════════════════════════════════════════════════════

pub(super) struct CdpSession {
    /// 当前连接的调试端口（launch 时确定）
    pub(super) port: u16,
    /// 当前 attach 的 target id（None = 未 attach）
    pub(super) target_id: Option<String>,
    /// launch 启动的受控 Chrome 子进程（用于 kill）
    pub(super) chrome_child: Option<std::process::Child>,
    /// 该 Chrome 的 profile 目录。具名 profile 是持久目录（kill/租约不删），
    /// 默认临时 profile 随 Chrome 终止一并删除（见 profile_ephemeral）。
    pub(super) profile_dir: Option<std::path::PathBuf>,
    /// profile 是否随会话终止删除。launch 默认临时 profile 为 true；
    /// 具名 profile 为 false，供多账号切换复用。
    pub(super) profile_ephemeral: bool,
    /// 当前账号槽位（default 或具名 profile 名）。
    pub(super) slot: String,
    /// launch 时的 headless 标记（复用会话时校验参数一致性）
    pub(super) headless: Option<bool>,
    /// launch 时的 window-size（复用会话时校验参数一致性）
    pub(super) window_size: Option<(u32, u32)>,
    /// launch 时的代理地址（--proxy-server，复用会话时校验参数一致性）
    pub(super) proxy: Option<String>,
    /// launch 时的代理绕过列表（--proxy-bypass-list，复用会话时校验参数一致性）
    pub(super) proxy_bypass: Option<String>,
    /// 事件观察（attach 时启动；self 会话在首次 attach 时启动）
    pub(super) observer: Option<Observer>,
    /// 观察任务在途启动闸——防并发重复启动同一 target 的观察任务（A4 竞态）。
    pub(super) observer_starting: Arc<AtomicBool>,
    /// 最近一次活动时间（租约依据）
    pub(super) last_active: Instant,
}

impl Default for CdpSession {
    fn default() -> Self {
        Self {
            port: 0,
            target_id: None,
            chrome_child: None,
            profile_dir: None,
            profile_ephemeral: false,
            slot: DEFAULT_SLOT.to_string(),
            headless: None,
            window_size: None,
            proxy: None,
            proxy_bypass: None,
            observer: None,
            observer_starting: Arc::new(AtomicBool::new(false)),
            last_active: Instant::now(),
        }
    }
}

pub(super) static SESSIONS: LazyLock<Mutex<HashMap<String, CdpSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn session_key(agent_id: Option<&str>) -> String {
    agent_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_SESSION_KEY)
        .to_string()
}

/// slot -> 活跃账号的映射（按 agent 基础 key）。锁序约定：先 SESSIONS 后
/// ACTIVE_SLOTS（session_mut 持 SESSIONS 锁时解析活跃 key）；任何代码不得
/// 反向持锁，避免与并发 switch/launch 死锁。
pub(super) static ACTIVE_SLOTS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const SLOT_SEPARATOR: char = '\u{1f}';

/// 组合 slot key。self 会话不分区（自家 webview 只有一个只读通道）。
pub(super) fn session_key_for(agent_id: Option<&str>, slot: &str) -> String {
    let base = session_key(agent_id);
    if base == SELF_AGENT_ID {
        return base;
    }
    format!("{base}{SLOT_SEPARATOR}{slot}")
}

/// 当前活跃 slot key。无显式 switch 时使用 DEFAULT_SLOT，行为与旧版一致。
pub(super) fn active_session_key(agent_id: Option<&str>) -> String {
    let base = session_key(agent_id);
    if base == SELF_AGENT_ID {
        return base;
    }
    let slot = crate::utils::lock_or_recover(&ACTIVE_SLOTS)
        .get(&base)
        .cloned()
        .unwrap_or_else(|| DEFAULT_SLOT.to_string());
    session_key_for(agent_id, &slot)
}

/// 读取当前活跃 slot 名（会话列表/状态展示用）。不修改映射。
pub(super) fn active_slot_for(agent_id: Option<&str>) -> String {
    let base = session_key(agent_id);
    if base == SELF_AGENT_ID {
        return base;
    }
    crate::utils::lock_or_recover(&ACTIVE_SLOTS)
        .get(&base)
        .cloned()
        .unwrap_or_else(|| DEFAULT_SLOT.to_string())
}

/// 切换活跃账号 slot。调用方必须已持有 SESSIONS 锁；本函数再取 ACTIVE_SLOTS 锁，
/// 保持 SESSIONS → ACTIVE_SLOTS 顺序。
pub(super) fn set_active_slot(agent_id: Option<&str>, slot: &str) {
    let base = session_key(agent_id);
    if base == SELF_AGENT_ID {
        return;
    }
    crate::utils::lock_or_recover(&ACTIVE_SLOTS).insert(base, slot.to_string());
}

pub(super) fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, CdpSession>> {
    crate::utils::lock_or_recover(&SESSIONS)
}

/// 租约回收 + 崩溃检测：空闲超时的会话 kill 掉 Chrome 并移除；
/// Chrome 已退出的会话清掉进程句柄（target/observer 保留，attach 可重来）；
/// 外部连接（connect，无 chrome_child）空闲超时只断开不杀进程。
/// 默认临时 profile 随 Chrome 终止删除；具名 profile 目录保留（多账号切换用）。
pub(super) fn enforce_lease() {
    let mut sessions = lock_sessions();
    let mut expired: Vec<String> = Vec::new();
    for (key, sess) in sessions.iter_mut() {
        if let Some(child) = &mut sess.chrome_child {
            if let Ok(Some(_)) = child.try_wait() {
                // Chrome 已自行退出
                sess.chrome_child = None;
                if sess.profile_ephemeral {
                    if let Some(dir) = sess.profile_dir.take() {
                        remove_profile_dir(&dir);
                    }
                }
            }
        }
        if sess.chrome_child.is_some() && sess.last_active.elapsed() > session_lease() {
            if let Some(mut child) = sess.chrome_child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if sess.profile_ephemeral {
                if let Some(dir) = sess.profile_dir.take() {
                    remove_profile_dir(&dir);
                }
            }
            expired.push(key.clone());
        } else if sess.chrome_child.is_none()
            && sess.port != 0
            && sess.last_active.elapsed() > session_lease()
        {
            // 外部连接空闲超时：只移除会话（断开），不动用户进程
            expired.push(key.clone());
        }
    }
    for key in expired {
        sessions.remove(&key);
    }
}

/// 取会话并刷新活跃时间（按当前活跃账号 slot）。
pub(super) fn session_mut(
    agent_id: Option<&str>,
) -> std::sync::MutexGuard<'static, HashMap<String, CdpSession>> {
    enforce_lease();
    let mut sessions = lock_sessions();
    sessions
        .entry(active_session_key(agent_id))
        .or_default()
        .last_active = Instant::now();
    sessions
}

/// 取指定 slot 的会话并刷新活跃时间（launch/connect 创建或复用指定账号时用）。
/// 不改变 ACTIVE_SLOTS；是否把该 slot 设为活跃由调用方决定。
pub(super) fn session_mut_for(
    agent_id: Option<&str>,
    slot: &str,
) -> std::sync::MutexGuard<'static, HashMap<String, CdpSession>> {
    enforce_lease();
    let mut sessions = lock_sessions();
    let key = session_key_for(agent_id, slot);
    let sess = sessions.entry(key).or_default();
    if sess.port == 0 && sess.target_id.is_none() {
        sess.slot = slot.to_string();
    }
    sess.last_active = Instant::now();
    sessions
}

/// 审计日志 — 内存环形 + 落盘（临时目录 jsonl）。
pub(super) static AUDIT: LazyLock<Mutex<VecDeque<String>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// 审计落盘文件名前缀。按日期轮转：hologram-browser-audit-YYYYMMDD.jsonl。
pub(super) const AUDIT_FILE_PREFIX: &str = "hologram-browser-audit";
/// 截图目录/文件名前缀。
pub(super) const SHOT_DIR_NAME: &str = "hologram-browser-shots";
pub(super) const SHOT_FILE_PREFIX: &str = "shot-";
/// HAR 导出目录/文件名前缀。
pub(super) const HAR_DIR_NAME: &str = "hologram-browser-har";
pub(super) const HAR_FILE_PREFIX: &str = "hologram-";

/// 保留天数读取：`HOLOGRAM_BROWSER_AUDIT_RETAIN_DAYS` / `HOLOGRAM_BROWSER_SHOT_RETAIN_DAYS`
/// 可覆盖，最小 1 天。测试与真实运行共享临时目录——清理只看本套件前缀。
pub(super) fn audit_retain_days() -> u64 {
    std::env::var("HOLOGRAM_BROWSER_AUDIT_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

pub(super) fn shot_retain_days() -> u64 {
    std::env::var("HOLOGRAM_BROWSER_SHOT_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

pub(super) fn har_retain_days() -> u64 {
    std::env::var("HOLOGRAM_BROWSER_HAR_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

pub(super) fn is_expired_file_time(
    modified: std::time::SystemTime,
    now: std::time::SystemTime,
    retain_days: u64,
) -> bool {
    now.duration_since(modified)
        .map(|age| age.as_secs() > retain_days.saturating_mul(24 * 60 * 60))
        .unwrap_or(false)
}

/// 清理目录中指定前缀、按修改时间早于保留窗口的文件。失败静默（清理是尽力而为）。
pub(super) fn cleanup_old_files_by_age(
    dir: &std::path::Path,
    prefix: &str,
    retain_days: u64,
    now: std::time::SystemTime,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(prefix) {
            continue;
        }
        let expired = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|modified| is_expired_file_time(modified, now, retain_days))
            .unwrap_or(false);
        if expired {
            let _ = std::fs::remove_file(&path);
        }
    }
}

pub(super) fn audit_file_path() -> std::path::PathBuf {
    let day = chrono::Local::now().format("%Y%m%d").to_string();
    std::env::temp_dir().join(format!("{AUDIT_FILE_PREFIX}-{day}.jsonl"))
}

pub(super) fn audit_log(agent_id: Option<&str>, action: &str, target: &str, summary: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = json!({
        "ts": ts,
        "agent": agent_id.filter(|s| !s.trim().is_empty()).unwrap_or("default"),
        "action": action,
        "target": truncate_str(target, 120),
        "summary": truncate_str(summary, 200),
    })
    .to_string();
    {
        let mut buf = crate::utils::lock_or_recover(&AUDIT);
        if buf.len() >= AUDIT_MAX {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
    }
    // 落盘：按日期轮转 jsonl，只保留最近 N 天。失败静默（审计是尽力而为）。
    cleanup_old_files_by_age(
        &std::env::temp_dir(),
        AUDIT_FILE_PREFIX,
        audit_retain_days(),
        std::time::SystemTime::now(),
    );
    use std::io::Write;
    let path = audit_file_path();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{entry}");
    }
}

/// 查询审计日志（最新 N 条，可按 agent 过滤）。
/// entries 是 JSON 字符串（audit_log 原样入环形缓冲），前端自行 parse。
pub(crate) fn cdp_audit(agent: Option<&str>, limit: Option<usize>) -> String {
    let n = limit.unwrap_or(50).min(AUDIT_MAX);
    let buf = crate::utils::lock_or_recover(&AUDIT);
    let mut entries: Vec<&String> = Vec::new();
    for e in buf.iter().rev() {
        // agent 过滤：解析每条 JSON 的 agent 字段比对（缓冲最多 500 条，成本可忽略）
        let matches = match agent {
            None => true,
            Some(a) => serde_json::from_str::<Value>(e)
                .map(|v| v["agent"].as_str() == Some(a))
                .unwrap_or(true), // 解析失败的脏条目不过滤（宁可显示不可藏）
        };
        if matches {
            entries.push(e);
            if entries.len() >= n {
                break;
            }
        }
    }
    entries.reverse();
    json!({ "count": entries.len(), "entries": entries }).to_string()
}

// ═══════════════════════════════════════════════════════════
// Chrome 启动
// ═══════════════════════════════════════════════════════════

/// 当前平台的 Chrome/Edge 固定安装路径候选。HOLOGRAM_CHROME 始终优先。
pub(super) fn chrome_candidate_paths() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for c in [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ] {
            out.push(std::path::PathBuf::from(c));
        }
    }
    #[cfg(target_os = "macos")]
    {
        for c in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            out.push(std::path::PathBuf::from(c));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for c in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/opt/google/chrome/chrome",
            "/opt/microsoft/msedge/msedge",
            "/snap/bin/chromium",
        ] {
            out.push(std::path::PathBuf::from(c));
        }
    }
    // 固定路径之外的兜底：从 PATH 找常见可执行名（Flatpak/自建安装/Nix 等）。
    for name in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "microsoft-edge-stable",
        "msedge",
    ] {
        if let Some(p) = find_executable_on_path(name) {
            out.push(p);
        }
    }
    out
}

pub(super) fn find_executable_on_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    })
}

/// 查找 Chrome 可执行文件（各平台固定路径 + PATH 兜底 + 环境变量覆盖）。
pub(super) fn find_chrome() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("HOLOGRAM_CHROME") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    chrome_candidate_paths().into_iter().find(|p| p.exists())
}

/// 等待调试端口就绪（launch 后 Chrome 需要几百 ms 启动）。
pub(super) async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if list_targets_raw(port).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("CDP 端口 {port} 在 {timeout:?} 内未就绪"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 探测一个空闲端口（默认范围）。同进程其他 Agent 已占用的端口也算占用，
/// 堵住"两个 Agent 同时探测到同一端口"的竞态窗口。
pub(super) fn probe_free_port() -> Result<u16, String> {
    for offset in 0..PORT_PROBE_LIMIT {
        let p = DEFAULT_PORT_BASE + offset;
        let occupied = {
            let sessions = lock_sessions();
            sessions
                .values()
                .any(|s| s.port == p && s.chrome_child.is_some())
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

/// 校验代理命令行参数：只拒绝换行（避免参数注入的伪影），其余交给 Chrome。
pub(super) fn validate_proxy_arg(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("launch: {name} 不能为空字符串"));
    }
    if value.contains(['\r', '\n']) {
        return Err(format!("launch: {name} 不能包含换行符"));
    }
    Ok(())
}

/// 启动受控 Chrome（独立 profile）。已在运行则复用。返回端口。
/// headless/windowSize/profile/proxy 与端口一样是启动期参数：复用时会校验一致性，
/// 参数不一致则回收旧实例重新启动，避免「要 headless 却复用了一个有头窗口」。
/// profile 缺省 = 临时 profile（随 kill/租约删除）；指定 profile = 持久登录态，
/// 目录保留且对应一个可切换的账号 slot（多账号隔离：每 slot 独立端口/profile/cookie）。
pub(crate) async fn cdp_launch(
    url: Option<String>,
    port: Option<u16>,
    headless: Option<bool>,
    window_size: Option<(u32, u32)>,
    profile: Option<String>,
    proxy: Option<String>,
    proxy_bypass: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    if let Some((w, h)) = window_size {
        if w == 0 || h == 0 || w > 16384 || h > 16384 {
            return Err("launch: windowSize 宽高必须在 1-16384 之间".into());
        }
    }
    if let Some(p) = &proxy {
        validate_proxy_arg("proxy", p)?;
    }
    if let Some(p) = &proxy_bypass {
        validate_proxy_arg("proxyBypass", p)?;
    }
    let profile_text = profile.as_deref().unwrap_or("").trim().to_string();
    let named_profile = !profile_text.is_empty();
    let slot = normalize_slot_name(&profile_text)?;

    // 已启动过且 Chrome 还活着 → 复用：
    //   - 未显式指定端口：直接复用本 agent 该 slot 的现有端口；
    //   - 显式指定端口：与该 slot 现有端口一致且活着才复用；
    //   - headless/windowSize/profile/proxy 与启动时不一致：不复用，走重启路径。
    {
        let mut sessions = session_mut_for(agent_id, &slot);
        let sess = sessions
            .entry(session_key_for(agent_id, &slot))
            .or_default();
        if sess.chrome_child.is_some() && sess.port != 0 && list_targets_raw(sess.port).is_ok() {
            let port_matches = match port {
                None => true,
                Some(p) => p == sess.port,
            };
            let headless_matches = headless.is_none() || sess.headless == headless;
            let size_matches = window_size.is_none() || sess.window_size == window_size;
            let proxy_matches = proxy.is_none() || sess.proxy == proxy;
            let bypass_matches = proxy_bypass.is_none() || sess.proxy_bypass == proxy_bypass;
            if port_matches && headless_matches && size_matches && proxy_matches && bypass_matches {
                set_active_slot(agent_id, &slot);
                return Ok(json!({
                    "status": "reused",
                    "port": sess.port,
                    "url": url,
                    "slot": sess.slot,
                    "profile": profile,
                    "headless": sess.headless.unwrap_or(false),
                    "windowSize": sess.window_size.map(|(w, h)| json!({ "width": w, "height": h })),
                    "proxy": sess.proxy,
                    "proxyBypass": sess.proxy_bypass,
                })
                .to_string());
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

    let chrome =
        find_chrome().ok_or("未找到 Chrome/Edge。可设置环境变量 HOLOGRAM_CHROME 指定路径")?;
    // 缺省 profile 按端口隔离（临时，随会话删除）；具名 profile 持久（多账号切换复用）。
    let profile_dir = if named_profile {
        named_profile_dir(&slot)
    } else {
        profile_dir_for(port)
    };

    {
        let mut sessions = session_mut_for(agent_id, &slot);
        // 先清扫遗留 profile 再登记本会话目录：目录登记先于 spawn，
        // 并发 launch 的清扫会跳过它，不会互删正在使用的目录。
        sweep_stale_profiles(&sessions);
        let sess = sessions
            .entry(session_key_for(agent_id, &slot))
            .or_default();
        // 走到这里说明旧 Chrome 已退出或显式指定了不同端口/启动形态——
        // 无论哪种，回收旧句柄并 kill 残留进程，避免双开。
        if let Some(mut old) = sess.chrome_child.take() {
            let exited = old.try_wait().map(|s| s.is_some()).unwrap_or(false);
            if !exited {
                let _ = old.kill();
                let _ = old.wait();
            }
        }
        if sess.profile_ephemeral {
            if let Some(old_dir) = sess.profile_dir.take() {
                remove_profile_dir(&old_dir);
            }
        }
        sess.port = port;
        sess.profile_dir = Some(profile_dir.clone());
        sess.profile_ephemeral = !named_profile;
        sess.slot = slot.clone();
        sess.headless = headless;
        sess.window_size = window_size;
        sess.proxy = proxy.clone();
        sess.proxy_bypass = proxy_bypass.clone();

        let mut cmd = std::process::Command::new(&chrome);
        cmd.arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={}", profile_dir.to_string_lossy()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-features=TranslateUI");
        if headless.unwrap_or(false) {
            cmd.arg("--headless");
        }
        if let Some((w, h)) = window_size {
            cmd.arg(format!("--window-size={w},{h}"));
        }
        if let Some(p) = &proxy {
            cmd.arg(format!("--proxy-server={p}"));
        }
        if let Some(p) = &proxy_bypass {
            cmd.arg(format!("--proxy-bypass-list={p}"));
        }
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
        sess.chrome_child = Some(child);
    }

    // spawn 与端口就绪全部成功后才切活跃 slot：launch 失败时旧账号仍保持活跃，
    // 不会把后续 click/type 路由到一个没起来的会话。
    wait_for_port(port, Duration::from_secs(10)).await?;
    set_active_slot(agent_id, &slot);
    audit_log(agent_id, "launch", &port.to_string(), "ok");
    Ok(json!({
        "status": "launched",
        "port": port,
        "chrome": chrome.to_string_lossy(),
        "slot": slot,
        "profile": profile,
        "headless": headless.unwrap_or(false),
        "windowSize": window_size.map(|(w, h)| json!({ "width": w, "height": h })),
        "proxy": proxy,
        "proxyBypass": proxy_bypass,
    })
    .to_string())
}

/// 终止当前活跃账号 slot 的受控 Chrome；若当前是外部连接（connect 来的、
/// 非本 agent 启动的进程），只断开连接，不杀进程。
/// 具名 profile 目录保留，供再次 launch 或 switch 恢复登录态。
pub(crate) fn cdp_kill(agent_id: Option<&str>) -> Result<String, String> {
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    let had_child = sess.chrome_child.is_some();
    let had_conn = sess.port != 0;
    let kept_profile = had_child && !sess.profile_ephemeral;
    if let Some(mut child) = sess.chrome_child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if sess.profile_ephemeral {
        if let Some(dir) = sess.profile_dir.take() {
            remove_profile_dir(&dir);
        }
    } else {
        sess.profile_dir = None;
    }
    if had_child || had_conn {
        sess.target_id = None;
        sess.observer = None;
        sess.port = 0;
        sess.headless = None;
        sess.window_size = None;
        sess.proxy = None;
        sess.proxy_bypass = None;
        sess.profile_ephemeral = false;
        audit_log(
            agent_id,
            "kill",
            "",
            if had_child { "ok" } else { "disconnected" },
        );
        let msg = if had_child {
            if kept_profile {
                "受控 Chrome 已终止；具名 profile 目录已保留，再次 launch 同 profile 可恢复登录态".to_string()
            } else {
                "受控 Chrome 已终止".into()
            }
        } else {
            "已断开外部浏览器连接（进程未终止——它不是本 agent 启动的）".into()
        };
        Ok(msg)
    } else {
        Err("没有正在运行的受控 Chrome 或外部连接".into())
    }
}

/// 连接到用户已启动的、开了调试端口的浏览器实例（Chrome/Edge/Electron 等）。
/// 与 launch 不同：进程不是本 agent 起的——kill 只断开、租约到期只断连，
/// 绝不杀用户自己的进程；操作的是用户真实登录态（批准在 rpc 层 Ask）。
/// session/profile 参数把外部实例登记成指定账号 slot，便于多账号切换。
pub(crate) fn cdp_connect(
    port: u16,
    profile: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    if port == 0 {
        return Err("端口必须在 1-65535".into());
    }
    if port == WEBVIEW_DEBUG_PORT {
        return Err(format!(
            "端口 {WEBVIEW_DEBUG_PORT} 是 HoloGram 自家 webview 的调试端口，不能作为外部实例连接。\
             webview 只读通道用 target=\"self\""
        ));
    }
    let slot = normalize_slot_name(profile.as_deref().unwrap_or(""))?;
    // 端口必须真的有调试服务——connect 不猜端口，由用户告诉 Agent
    let raw = list_targets_raw(port).map_err(|e| format!("端口 {port} 没有可用的调试服务: {e}"))?;
    let pages = raw
        .as_array()
        .map(|arr| arr.iter().filter(|t| t["type"] == "page").count())
        .unwrap_or(0);

    let mut sessions = session_mut_for(agent_id, &slot);
    let sess = sessions.entry(session_key_for(agent_id, &slot)).or_default();
    // 替换前回收旧状态：受控 Chrome kill 掉（换目标不再需要），外部连接直接覆盖
    if let Some(mut old) = sess.chrome_child.take() {
        let exited = old.try_wait().map(|s| s.is_some()).unwrap_or(false);
        if !exited {
            let _ = old.kill();
            let _ = old.wait();
        }
    }
    if sess.profile_ephemeral {
        if let Some(dir) = sess.profile_dir.take() {
            remove_profile_dir(&dir);
        }
    }
    sess.profile_dir = None;
    sess.port = port;
    sess.target_id = None;
    sess.observer = None;
    sess.slot = slot.clone();
    sess.headless = None;
    sess.window_size = None;
    sess.proxy = None;
    sess.proxy_bypass = None;
    sess.profile_ephemeral = false;
    set_active_slot(agent_id, &slot);

    audit_log(
        agent_id,
        "connect",
        &port.to_string(),
        &format!("slot={slot}; {pages} 个页面 target"),
    );
    Ok(json!({
        "status": "connected",
        "port": port,
        "pages": pages,
        "slot": slot,
        "profile": profile,
    })
    .to_string())
}

/// 列出本 agent 的全部账号 slot（含未在运行的具名 slot 记录），以及当前活跃项。
/// 每个 slot 有独立 Chrome 实例/profile/cookie，切换后原有实例继续运行，
/// 直到租约超时回收——这是多账号会话隔离的边界。
pub(crate) fn cdp_sessions(agent_id: Option<&str>) -> String {
    let sessions = lock_sessions();
    let base = session_key(agent_id);
    let active = active_slot_for(agent_id);
    let mut slots: Vec<Value> = Vec::new();
    for (key, sess) in sessions.iter() {
        let Some(slot) = key.strip_prefix(&format!("{base}{SLOT_SEPARATOR}")) else {
            continue;
        };
        let observer_alive = sess
            .observer
            .as_ref()
            .map(|o| o.alive.load(Ordering::SeqCst))
            .unwrap_or(false);
        slots.push(json!({
            "slot": if sess.slot.is_empty() { slot } else { sess.slot.as_str() },
            "active": slot == active,
            "port": sess.port,
            "chromeRunning": sess.chrome_child.is_some(),
            "external": sess.chrome_child.is_none() && sess.port != 0,
            "attached": sess.target_id.is_some(),
            "observerAlive": observer_alive,
            "profile": sess.slot,
            "profileEphemeral": sess.profile_ephemeral,
            "headless": sess.headless,
            "windowSize": sess.window_size.map(|(w, h)| json!({ "width": w, "height": h })),
            "proxy": sess.proxy,
        }));
    }
    // 当前进程尚未 launch 但磁盘上已存在的具名 profile 也列出（例如应用重启后）；
    // 这些 slot 可直接 browser(launch, profile: ...) 恢复登录态。
    if base != SELF_AGENT_ID {
        let prefix = format!("{NAMED_PROFILE_DIR_PREFIX}-");
        let listed: Vec<String> = slots
            .iter()
            .filter_map(|s| s["slot"].as_str().map(String::from))
            .collect();
        if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
            for e in entries.flatten() {
                let path = e.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let Some(slot) = name.strip_prefix(&prefix) else {
                    continue;
                };
                if slot.is_empty() || listed.iter().any(|s| s == slot) {
                    continue;
                }
                slots.push(json!({
                    "slot": slot,
                    "active": false,
                    "port": 0,
                    "chromeRunning": false,
                    "external": false,
                    "attached": false,
                    "observerAlive": false,
                    "profile": slot,
                    "profileEphemeral": false,
                    "headless": null,
                    "windowSize": null,
                    "proxy": null,
                }));
            }
        }
    }

    slots.sort_by(|a, b| {
        let av = a["active"].as_bool().unwrap_or(false);
        let bv = b["active"].as_bool().unwrap_or(false);
        bv.cmp(&av).then_with(|| {
            a["slot"]
                .as_str()
                .unwrap_or("")
                .cmp(b["slot"].as_str().unwrap_or(""))
        })
    });
    json!({
        "agent": base,
        "active": active,
        "count": slots.len(),
        "sessions": slots,
        "note": "切换用 browser_switch_session；未运行的具名 slot 仍会列出（profile 目录已持久化）",
    })
    .to_string()
}

/// 切换当前活跃账号 slot。被切走的受控 Chrome 不会立刻关闭（租约独立计时），
/// 所以可以来回切换两个已登录账号而不丢登录态。
pub(crate) fn cdp_switch_session(
    profile: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let slot = normalize_slot_name(profile.as_deref().unwrap_or(""))?;
    enforce_lease();
    let mut sessions = lock_sessions();
    let key = session_key_for(agent_id, &slot);
    let sess = sessions
        .get_mut(&key)
        .ok_or_else(|| format!("session 不存在: {slot}（先 browser(launch, profile: \"{slot}\") 或 browser(connect, session: \"{slot}\")）"))?;
    if sess.port == 0 {
        return Err(format!(
            "session {slot} 未运行（先 browser(launch, profile: \"{slot}\") 重新启动）"
        ));
    }
    sess.last_active = Instant::now();
    let current = active_slot_for(agent_id);
    if current == slot {
        return Ok(json!({
            "status": "reused",
            "active": slot,
            "port": sess.port,
            "attached": sess.target_id.is_some(),
        })
        .to_string());
    }
    set_active_slot(agent_id, &slot);
    audit_log(agent_id, "switch_session", &slot, "ok");
    Ok(json!({
        "status": "switched",
        "from": current,
        "active": slot,
        "port": sess.port,
        "attached": sess.target_id.is_some(),
        "note": "后续 browser 动作作用于该 session；旧 session 仍在运行，可再次切换",
    })
    .to_string())
}

/// 新开 tab（Chrome 调试 HTTP /json/new），并自动 attach 到新 tab。
/// 受控 launch 与外部 connect 的会话都可用；后续操作立即作用于新 tab。
pub(crate) fn cdp_new_tab(url: Option<String>, agent_id: Option<&str>) -> Result<String, String> {
    let url = url.unwrap_or_else(|| "about:blank".into());
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    if sess.port == 0 {
        return Err("尚未 launch/connect 浏览器".into());
    }
    let port = sess.port;
    let created = http_new_tab(port, &url)?;
    let target_id = created["id"]
        .as_str()
        .ok_or("CDP /json/new 未返回 target id")?
        .to_string();
    sess.target_id = Some(target_id.clone());
    ensure_observer_started(sess, port, &target_id);
    audit_log(agent_id, "new_tab", &url, &target_id);
    Ok(json!({
        "created": true,
        "targetId": target_id,
        "url": url,
        "note": "新 tab 已自动 attach，后续 browser 动作作用于该 tab",
    })
    .to_string())
}

/// 关闭 tab（Chrome 调试 HTTP /json/close）。若关闭的是当前 attach 的 tab，
/// 会话回到未 attach 状态（用 browser(targets)+browser(attach) 切到剩余页面）。
pub(crate) fn cdp_close_tab(target_id: &str, agent_id: Option<&str>) -> Result<String, String> {
    if target_id.trim().is_empty() {
        return Err("close_tab: targetId 不能为空".into());
    }
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(active_session_key(agent_id)).or_default();
    if sess.port == 0 {
        return Err("尚未 launch/connect 浏览器".into());
    }
    http_close_tab(sess.port, target_id)?;
    if sess.target_id.as_deref() == Some(target_id) {
        sess.target_id = None;
        sess.observer = None;
    }
    audit_log(agent_id, "close_tab", target_id, "ok");
    Ok(json!({
        "closed": true,
        "targetId": target_id,
        "note": if sess.target_id.is_none() {
            "已关闭当前 attach 的 tab；请用 browser(targets) 选择剩余页面"
        } else {
            "已关闭非当前 tab；当前 attach 目标不变"
        },
    })
    .to_string())
}

/// 发现本机所有开了调试端口的 Chromium 系实例（用户自己启动的 Chrome/Edge/
/// Electron 等）。查进程表命令行拿端口，再逐个确认 CDP 应答并列出页面——
/// 用户无需知道端口号，从清单里选即可。
/// 自家 webview（9222）被过滤——那是 self 只读通道，不是可连接实例。
pub(crate) fn cdp_discover() -> Result<String, String> {
    let text = query_process_debug_ports()?;
    // 同端口多进程（Chrome 主进程 + 各渲染进程共享一个调试端口）去重。
    // 启动器进程（bash/cmd/powershell）命令行也含端口参数——若已有条目
    // 名字是启动器而新名字更可信，替换显示名。
    fn is_launcher(name: &str) -> bool {
        let n = name.to_lowercase();
        n.contains("bash") || n.contains("cmd") || n.contains("powershell") || n.ends_with(".sh")
    }

    let mut seen: Vec<u16> = Vec::new();
    let mut instances: Vec<Value> = Vec::new();
    for (name, port) in parse_discover_process_lines(&text) {
        if port == 0 || port == WEBVIEW_DEBUG_PORT {
            continue;
        }
        if let Some(idx) = seen.iter().position(|&p| p == port) {
            let old = instances[idx]["browser"].as_str().unwrap_or("");
            if is_launcher(old) && !is_launcher(&name) {
                instances[idx]["browser"] = json!(name);
            }
            continue;
        }
        seen.push(port);
        let Ok(raw) = list_targets_raw(port) else {
            continue;
        };
        let pages: Vec<Value> = raw
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter(|t| t["type"] == "page")
                    .map(|t| {
                        json!({
                            "id": t["id"].as_str().unwrap_or(""),
                            "title": t["title"].as_str().unwrap_or(""),
                            "url": t["url"].as_str().unwrap_or(""),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        instances.push(json!({
            "browser": name,
            "port": port,
            "pages": pages,
        }));
    }

    if instances.is_empty() {
        Ok(json!({
            "instances": [],
            "note": "没有发现开了调试端口的浏览器实例。Chrome/Edge 需以 --remote-debugging-port=<端口> 参数启动后才会出现在这里"
        }).to_string())
    } else {
        Ok(json!({ "instances": instances }).to_string())
    }
}

/// 查进程表命令行中的 `--remote-debugging-port=<port>`。
/// Windows 走 PowerShell（Electron 进程名各异，命令行是唯一可靠特征）；
/// macOS/Linux 走 `ps -ax -o pid=,comm=,args=`。
pub(super) fn query_process_debug_ports() -> Result<String, String> {
    #[cfg(windows)]
    {
        let script = r#"
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.CommandLine -match '--remote-debugging-port=(\d+)') {
    "{0}|{1}|{2}" -f $_.Name, $Matches[1], $_.ProcessId
  }
}"#;
        let mut ps = std::process::Command::new("powershell");
        ps.args(["-NoProfile", "-Command", script]);
        // 静默后台运行：不弹 PowerShell 窗口（discover 每次调用都会闪控制台）
        use std::os::windows::process::CommandExt;
        ps.creation_flags(crate::utils::NO_WINDOW);
        let out = ps
            .output()
            .map_err(|e| format!("discover: 查询进程表失败: {e}"))?;
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("ps")
            .args(["-ax", "-o", "pid=,comm=,args="])
            .output()
            .map_err(|e| format!("discover: ps 查询进程表失败: {e}"))?;
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
}

/// 解析 discover 输出为 (进程名, 调试端口)：
///   - PowerShell 行：`chrome|9333|1234`
///   - ps 行：`  123 chrome --remote-debugging-port=9333 ...`
pub(super) fn parse_discover_process_lines(text: &str) -> Vec<(String, u16)> {
    static PS_LINE_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\s*(\d+)\s+(\S+)\s+(.*)$").expect("ps 行格式正则"));
    let mut out: Vec<(String, u16)> = Vec::new();
    for line in text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if line.contains('|') {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 2 {
                if let Ok(port) = parts[1].trim().parse::<u16>() {
                    // 9222 是 HoloGram webview 调试端口，discover 契约明确过滤；
                    // 在解析层直接跳过，避免 bash/cmd 等启动器行让单测/调用方
                    // 再各自实现一遍过滤。
                    if port != WEBVIEW_DEBUG_PORT {
                        out.push((parts[0].trim().to_string(), port));
                    }
                }
            }
            continue;
        }
        if let Some(caps) = PS_LINE_RE.captures(line) {
            let args = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            if let Some(port) = extract_debug_port_from_args(args) {
                let name = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                out.push((name, port));
            }
        }
    }
    out
}

pub(super) fn extract_debug_port_from_args(args: &str) -> Option<u16> {
    args.split_whitespace().find_map(|tok| {
        tok.strip_prefix("--remote-debugging-port=")
            .and_then(|p| p.parse::<u16>().ok())
    })
}
