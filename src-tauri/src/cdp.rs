// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// CDP (Chrome DevTools Protocol) 客户端 — 让 Agent 观察/操作 Chromium 页面。
//
// 架构（ADR 0003 落地，P1/P2）：
//   - 命令通道：短连接（每次调用建立 WS，用完即关）——本地回环开销可忽略，
//     避免长连接命令状态机；connect/发送/等待全部包在 tokio timeout 里，
//     Runtime.evaluate 另带 CDP 层 5s 超时——页面死循环不会挂死 Agent 流。
//   - 事件通道：attach 后起一条持久 WS 后台 task，订阅 Runtime/Log/Network/Page
//     事件进环形缓冲，browser(console)/browser(network)/browser(dialog) 随时查询；
//     事件 task 随 target 消失自然退出，惰性重启。
//   - 快照 + ref：snapshot 给可交互元素打 data-hg-ref 标记，操作按 ref 引用；
//     ref 失效返回可恢复错误。selector 保留为高级参数。
//   - 操作反馈：操作前做 actionability 等待（可见/无遮挡/位置稳定），
//     操作后返回世界变化（URL / DOM 大小 / 新增错误数）。
//   - 会话按 agent 键控 + 空闲租约自动回收（默认 10 分钟，
//     HOLOGRAM_BROWSER_LEASE_SECS 可调，便于实测）+ Chrome 崩溃检测。
//   - profile 按端口隔离（hologram-browser-profile-<port>），随会话回收
//     一并删除；launch 时清扫上次进程强杀遗留的目录。
//   - self 会话：HoloGram 自家 webview 调试端口（9222）上的只读会话，
//     Agent 自查渲染结果走这里；操作类动作在 rpc 层被拒。
//   - 审计：全部写操作落盘（临时目录 jsonl），browser(audit) 可查。
//   - 只连 127.0.0.1；launch 用独立 profile，不碰用户日常 Chrome。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

mod probes;
mod transport;
use probes::{probe_result_str, CONTENT_PROBE, INSPECT_PROBE, REPORT_PROBE, SNAPSHOT_PROBE};
use transport::{
    http_close_tab, http_new_tab, list_targets_raw, ws_command, ws_command_batch,
};

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/// HoloGram 自家 webview 的调试端口（tauri.conf.json additionalBrowserArgs）。
/// 受控 Chrome 永远不许用这个端口；self 会话专用。
const WEBVIEW_DEBUG_PORT: u16 = 9222;

/// 受控 Chrome 默认端口起点，占用则向后探测（避开 9222）。
const DEFAULT_PORT_BASE: u16 = 9223;
const PORT_PROBE_LIMIT: u16 = 16;

/// Runtime.evaluate 的 CDP 层超时（毫秒）——表达式死循环在此上限内被打断。
const EVAL_TIMEOUT_MS: u64 = 5000;

/// actionability 等待上限——元素可见/无遮挡/位置稳定。
const ACTIONABILITY_TIMEOUT: Duration = Duration::from_secs(5);

/// 操作后等待世界稳定再采样的时间。
const POST_ACTION_SETTLE: Duration = Duration::from_millis(300);

/// 会话空闲租约（默认值）——超时自动 kill 受控 Chrome 并回收会话。
const DEFAULT_SESSION_LEASE: Duration = Duration::from_secs(600);

/// 会话空闲租约。默认 10 分钟；HOLOGRAM_BROWSER_LEASE_SECS（秒，≥1）可覆盖，
/// 让租约回收实测不必干等。
fn session_lease() -> Duration {
    std::env::var("HOLOGRAM_BROWSER_LEASE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&s| s >= 1)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_SESSION_LEASE)
}

/// 受控 Chrome profile 目录名前缀（临时目录下）。按端口分目录，
/// 杜绝多 Agent 共用同一 user-data-dir 导致 Chrome 实例委托、端口失效。
const PROFILE_DIR_PREFIX: &str = "hologram-browser-profile";

/// 指定端口的 profile 目录。
fn profile_dir_for(port: u16) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{PROFILE_DIR_PREFIX}-{port}"))
}

/// 尽力删除 profile 目录（Chrome 残留句柄可能致失败——静默，清理是尽力而为）。
fn remove_profile_dir(dir: &std::path::Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// 清扫遗留 profile 目录：只动本套件前缀的目录，跳过仍被存活会话引用的。
/// 在 sessions 锁内调用（调用方已持锁），登记新目录必须先于 spawn（见 cdp_launch），
/// 否则并发 launch 可能互删对方正在使用的目录。
fn sweep_stale_profiles(sessions: &HashMap<String, CdpSession>) {
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
        let is_ours = name == PROFILE_DIR_PREFIX
            || name.starts_with(&format!("{PROFILE_DIR_PREFIX}-"));
        if !is_ours || !path.is_dir() || live.iter().any(|l| **l == path) {
            continue;
        }
        remove_profile_dir(&path);
    }
}

/// 事件缓冲上限（条）。
const CONSOLE_BUF_MAX: usize = 200;
const NETWORK_BUF_MAX: usize = 200;
const ERROR_BUF_MAX: usize = 100;
const DIALOG_BUF_MAX: usize = 20;
const FILE_CHOOSER_BUF_MAX: usize = 20;

/// 审计内存环形上限（条）。
const AUDIT_MAX: usize = 500;

/// self 会话的 session key / agent_id（与 Agent 会话隔离，见 SELF_AGENT_ID）。
const DEFAULT_SESSION_KEY: &str = "default";

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
struct NetworkEntry {
    request_id: String,
    method: String,
    /// 全量 URL（查询列表时再截断展示；详情保留完整 URL 便于复现请求）。
    url: Option<String>,
    status: Option<u64>,
    status_text: Option<String>,
    mime_type: Option<String>,
    resource_type: Option<String>,
    frame_id: Option<String>,
    wall_time: Option<f64>,
    request_headers: Option<Value>,
    response_headers: Option<Value>,
    post_data: Option<String>,
    error: Option<String>,
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
    fn summary_value(&self) -> Value {
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
    fn detail_value(&self) -> Value {
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
    fn har_entry(&self) -> Value {
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
fn har_headers(headers: &Option<Value>) -> Vec<Value> {
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

fn har_query_string(url: &str) -> Vec<Value> {
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
struct EventBuffers {
    console: VecDeque<String>,
    network: VecDeque<NetworkEntry>,
    /// requestId -> 配对条目。与 network 环形缓冲同步淘汰，
    /// 保证 network_detail 只能查到仍在缓冲窗口内的请求。
    network_index: HashMap<String, NetworkEntry>,
    errors: VecDeque<String>,
    dialogs: VecDeque<String>,
    file_choosers: VecDeque<String>,
    /// 当前是否有未处理的 javascript dialog（Page.javascriptDialogOpening 起，
    /// Closed / 主动 handle 后复位）。
    dialog_open: bool,
    /// 最近一次 Page.fileChooserOpened 是否尚未被 upload 消费。
    file_chooser_open: bool,
}

/// 事件观察句柄。alive 标志由后台 task 维护：
/// 连接建立成功 → true；WS 断开/task 退出 → false。
/// 命令执行前检查 alive，false 且 target 还在则惰性重启。
#[derive(Clone)]
struct Observer {
    buffers: Arc<Mutex<EventBuffers>>,
    alive: Arc<AtomicBool>,
}

fn push_capped(buf: &mut VecDeque<String>, entry: String, cap: usize) {
    if buf.len() >= cap {
        buf.pop_front();
    }
    buf.push_back(entry);
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

/// 写入/替换一条网络条目，并同步维护 requestId 索引与环形上限。
fn network_upsert(bufs: &mut EventBuffers, entry: NetworkEntry) {
    if let Some(pos) = bufs.network.iter().position(|e| e.request_id == entry.request_id) {
        bufs.network.remove(pos);
    }
    bufs.network_index.insert(entry.request_id.clone(), entry.clone());
    bufs.network.push_back(entry);
    if bufs.network.len() > NETWORK_BUF_MAX {
        if let Some(old) = bufs.network.pop_front() {
            bufs.network_index.remove(&old.request_id);
        }
    }
}

/// Network.requestWillBeSent：新请求建立配对条目。redirect 会复用 requestId，
/// 因此同 id 再出现时替换旧条目，保留环形缓冲里的唯一记录。
fn network_on_request(bufs: &mut EventBuffers, params: &Value) {
    network_upsert(bufs, NetworkEntry::from_request(params));
}

/// Network.responseReceived：按 requestId 回填 status/headers，不再追加一条
/// 与请求割裂的 "method":"resp" 流水账。请求早于 observer 启动而缺失时，
/// 退化为一条只有响应信息的记录（url 未知比伪造 url 更诚实）。
fn network_on_response(bufs: &mut EventBuffers, params: &Value) {
    let request_id = params["requestId"].as_str().unwrap_or("").to_string();
    if request_id.is_empty() {
        return;
    }
    let response = &params["response"];
    let updated = if let Some(entry) = bufs.network_index.get_mut(&request_id) {
        entry.url = response["url"].as_str().map(String::from).or_else(|| entry.url.clone());
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
fn network_on_failed(bufs: &mut EventBuffers, params: &Value) {
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
fn start_observer(port: u16, target_id: &str, reuse_buffers: Option<Arc<Mutex<EventBuffers>>>) -> Observer {
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
            let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
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
                                .filter_map(|a| a["value"].as_str().or_else(|| a["description"].as_str()))
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    let entry = json!({ "type": ctype, "text": truncate_str(&text, 300) }).to_string();
                    push_capped(&mut bufs.console, entry.clone(), CONSOLE_BUF_MAX);
                    if ctype == "error" {
                        push_capped(&mut bufs.errors, entry, ERROR_BUF_MAX);
                    }
                }
                "Runtime.exceptionThrown" => {
                    let text = params["exceptionDetails"]["exception"]["description"]
                        .as_str()
                        .unwrap_or("exception");
                    let entry = json!({ "type": "exception", "text": truncate_str(text, 300) }).to_string();
                    push_capped(&mut bufs.errors, entry.clone(), ERROR_BUF_MAX);
                    push_capped(&mut bufs.console, entry, CONSOLE_BUF_MAX);
                }
                "Log.entryAdded" => {
                    let entry_obj = &params["entry"];
                    let level = entry_obj["level"].as_str().unwrap_or("info");
                    let text = entry_obj["text"].as_str().unwrap_or("");
                    let entry = json!({ "type": level, "text": truncate_str(text, 300) }).to_string();
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
fn ensure_observer_started(sess: &mut CdpSession, port: u16, tid: &str) {
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

pub(crate) struct CdpSession {
    /// 当前连接的调试端口（launch 时确定）
    pub port: u16,
    /// 当前 attach 的 target id（None = 未 attach）
    pub target_id: Option<String>,
    /// launch 启动的受控 Chrome 子进程（用于 kill）
    pub chrome_child: Option<std::process::Child>,
    /// 该 Chrome 的 profile 目录（随 Chrome 终止一并删除）
    profile_dir: Option<std::path::PathBuf>,
    /// launch 时的 headless 标记（复用会话时校验参数一致性）
    headless: Option<bool>,
    /// launch 时的 window-size（复用会话时校验参数一致性）
    window_size: Option<(u32, u32)>,
    /// 事件观察（attach 时启动；self 会话在首次 attach 时启动）
    observer: Option<Observer>,
    /// 观察任务在途启动闸——防并发重复启动同一 target 的观察任务（A4 竞态）。
    observer_starting: Arc<AtomicBool>,
    /// 最近一次活动时间（租约依据）
    last_active: Instant,
}

impl Default for CdpSession {
    fn default() -> Self {
        Self {
            port: 0,
            target_id: None,
            chrome_child: None,
            profile_dir: None,
            headless: None,
            window_size: None,
            observer: None,
            observer_starting: Arc::new(AtomicBool::new(false)),
            last_active: Instant::now(),
        }
    }
}

static SESSIONS: LazyLock<Mutex<HashMap<String, CdpSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn session_key(agent_id: Option<&str>) -> String {
    agent_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_SESSION_KEY)
        .to_string()
}

fn lock_sessions() -> std::sync::MutexGuard<'static, HashMap<String, CdpSession>> {
    crate::utils::lock_or_recover(&SESSIONS)
}

/// 租约回收 + 崩溃检测：空闲超时的会话 kill 掉 Chrome 并移除；
/// Chrome 已退出的会话清掉进程句柄（target/observer 保留，attach 可重来）；
/// 外部连接（connect，无 chrome_child）空闲超时只断开不杀进程。
/// profile 目录随 Chrome 终止一并删除。
fn enforce_lease() {
    let mut sessions = lock_sessions();
    let mut expired: Vec<String> = Vec::new();
    for (key, sess) in sessions.iter_mut() {
        if let Some(child) = &mut sess.chrome_child {
            if let Ok(Some(_)) = child.try_wait() {
                // Chrome 已自行退出
                sess.chrome_child = None;
                if let Some(dir) = sess.profile_dir.take() {
                    remove_profile_dir(&dir);
                }
            }
        }
        if sess.chrome_child.is_some() && sess.last_active.elapsed() > session_lease() {
            if let Some(mut child) = sess.chrome_child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(dir) = sess.profile_dir.take() {
                remove_profile_dir(&dir);
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

/// 取会话并刷新活跃时间。
fn session_mut(agent_id: Option<&str>) -> std::sync::MutexGuard<'static, HashMap<String, CdpSession>> {
    enforce_lease();
    let mut sessions = lock_sessions();
    sessions.entry(session_key(agent_id)).or_default().last_active = Instant::now();
    sessions
}

/// 审计日志 — 内存环形 + 落盘（临时目录 jsonl）。
static AUDIT: LazyLock<Mutex<VecDeque<String>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

/// 审计落盘文件名前缀。按日期轮转：hologram-browser-audit-YYYYMMDD.jsonl。
const AUDIT_FILE_PREFIX: &str = "hologram-browser-audit";
/// 截图目录/文件名前缀。
const SHOT_DIR_NAME: &str = "hologram-browser-shots";
const SHOT_FILE_PREFIX: &str = "shot-";
/// HAR 导出目录/文件名前缀。
const HAR_DIR_NAME: &str = "hologram-browser-har";
const HAR_FILE_PREFIX: &str = "hologram-";

/// 保留天数读取：`HOLOGRAM_BROWSER_AUDIT_RETAIN_DAYS` / `HOLOGRAM_BROWSER_SHOT_RETAIN_DAYS`
/// 可覆盖，最小 1 天。测试与真实运行共享临时目录——清理只看本套件前缀。
fn audit_retain_days() -> u64 {
    std::env::var("HOLOGRAM_BROWSER_AUDIT_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

fn shot_retain_days() -> u64 {
    std::env::var("HOLOGRAM_BROWSER_SHOT_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

fn har_retain_days() -> u64 {
    std::env::var("HOLOGRAM_BROWSER_HAR_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

fn is_expired_file_time(modified: std::time::SystemTime, now: std::time::SystemTime, retain_days: u64) -> bool {
    now.duration_since(modified)
        .map(|age| age.as_secs() > retain_days.saturating_mul(24 * 60 * 60))
        .unwrap_or(false)
}

/// 清理目录中指定前缀、按修改时间早于保留窗口的文件。失败静默（清理是尽力而为）。
fn cleanup_old_files_by_age(dir: &std::path::Path, prefix: &str, retain_days: u64, now: std::time::SystemTime) {
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

fn audit_file_path() -> std::path::PathBuf {
    let day = chrono::Local::now().format("%Y%m%d").to_string();
    std::env::temp_dir().join(format!("{AUDIT_FILE_PREFIX}-{day}.jsonl"))
}

fn audit_log(agent_id: Option<&str>, action: &str, target: &str, summary: &str) {
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
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
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
fn chrome_candidate_paths() -> Vec<std::path::PathBuf> {
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

fn find_executable_on_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    })
}

/// 查找 Chrome 可执行文件（各平台固定路径 + PATH 兜底 + 环境变量覆盖）。
fn find_chrome() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("HOLOGRAM_CHROME") {
        let p = std::path::PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    chrome_candidate_paths().into_iter().find(|p| p.exists())
}

/// 等待调试端口就绪（launch 后 Chrome 需要几百 ms 启动）。
async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
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

/// 启动受控 Chrome（独立 profile）。已在运行则复用。返回端口。
/// headless/windowSize 与端口一样是启动期参数：复用时会校验一致性，
/// 参数不一致则回收旧实例重新启动，避免「要 headless 却复用了一个有头窗口」。
pub(crate) async fn cdp_launch(
    url: Option<String>,
    port: Option<u16>,
    headless: Option<bool>,
    window_size: Option<(u32, u32)>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    if let Some((w, h)) = window_size {
        if w == 0 || h == 0 || w > 16384 || h > 16384 {
            return Err("launch: windowSize 宽高必须在 1-16384 之间".into());
        }
    }
    // 已启动过且 Chrome 还活着 → 复用：
    //   - 未显式指定端口：直接复用本 agent 的现有端口；
    //   - 显式指定端口：与本 agent 现有端口一致且活着才复用；
    //   - headless/windowSize 与启动时不一致：不复用，走重启路径。
    {
        let mut sessions = session_mut(agent_id);
        let sess = sessions.entry(session_key(agent_id)).or_default();
        if sess.chrome_child.is_some() && sess.port != 0 && list_targets_raw(sess.port).is_ok() {
            let port_matches = match port {
                None => true,
                Some(p) => p == sess.port,
            };
            let headless_matches = headless.is_none() || sess.headless == headless;
            let size_matches = window_size.is_none() || sess.window_size == window_size;
            if port_matches && headless_matches && size_matches {
                return Ok(json!({
                    "status": "reused",
                    "port": sess.port,
                    "url": url,
                    "headless": sess.headless.unwrap_or(false),
                    "windowSize": sess.window_size.map(|(w, h)| json!({ "width": w, "height": h })),
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

    let chrome = find_chrome().ok_or("未找到 Chrome/Edge。可设置环境变量 HOLOGRAM_CHROME 指定路径")?;
    // 独立 profile（按端口隔离）— 绝不污染用户日常 Chrome 的 cookie/登录态
    let profile_dir = profile_dir_for(port);

    {
        let mut sessions = session_mut(agent_id);
        // 先清扫遗留 profile 再登记本会话目录：目录登记先于 spawn，
        // 并发 launch 的清扫会跳过它，不会互删正在使用的目录。
        sweep_stale_profiles(&sessions);
        let sess = sessions.entry(session_key(agent_id)).or_default();
        // 走到这里说明旧 Chrome 已退出或显式指定了不同端口/启动形态——
        // 无论哪种，回收旧句柄并 kill 残留进程，避免双开。
        if let Some(mut old) = sess.chrome_child.take() {
            let exited = old.try_wait().map(|s| s.is_some()).unwrap_or(false);
            if !exited {
                let _ = old.kill();
                let _ = old.wait();
            }
        }
        if let Some(old_dir) = sess.profile_dir.take() {
            remove_profile_dir(&old_dir);
        }
        sess.port = port;
        sess.profile_dir = Some(profile_dir.clone());
        sess.headless = headless;
        sess.window_size = window_size;

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

    wait_for_port(port, Duration::from_secs(10)).await?;
    audit_log(agent_id, "launch", &port.to_string(), "ok");
    Ok(json!({
        "status": "launched",
        "port": port,
        "chrome": chrome.to_string_lossy(),
        "headless": headless.unwrap_or(false),
        "windowSize": window_size.map(|(w, h)| json!({ "width": w, "height": h })),
    })
    .to_string())
}

/// 终止本 agent 的受控 Chrome；若当前是外部连接（connect 来的、非本 agent
/// 启动的进程），只断开连接，不杀进程。
pub(crate) fn cdp_kill(agent_id: Option<&str>) -> Result<String, String> {
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(session_key(agent_id)).or_default();
    let had_child = sess.chrome_child.is_some();
    let had_conn = sess.port != 0;
    if let Some(mut child) = sess.chrome_child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(dir) = sess.profile_dir.take() {
        remove_profile_dir(&dir);
    }
    if had_child || had_conn {
        sess.target_id = None;
        sess.observer = None;
        sess.port = 0;
        sess.headless = None;
        sess.window_size = None;
        audit_log(agent_id, "kill", "", if had_child { "ok" } else { "disconnected" });
        Ok(if had_child {
            "受控 Chrome 已终止".into()
        } else {
            "已断开外部浏览器连接（进程未终止——它不是本 agent 启动的）".into()
        })
    } else {
        Err("没有正在运行的受控 Chrome 或外部连接".into())
    }
}

/// 连接到用户已启动的、开了调试端口的浏览器实例（Chrome/Edge/Electron 等）。
/// 与 launch 不同：进程不是本 agent 起的——kill 只断开、租约到期只断连，
/// 绝不杀用户自己的进程；操作的是用户真实登录态（批准在 rpc 层 Ask）。
pub(crate) fn cdp_connect(port: u16, agent_id: Option<&str>) -> Result<String, String> {
    if port == 0 {
        return Err("端口必须在 1-65535".into());
    }
    if port == WEBVIEW_DEBUG_PORT {
        return Err(format!(
            "端口 {WEBVIEW_DEBUG_PORT} 是 HoloGram 自家 webview 的调试端口，不能作为外部实例连接。\
             webview 只读通道用 target=\"self\""
        ));
    }
    // 端口必须真的有调试服务——connect 不猜端口，由用户告诉 Agent
    let raw = list_targets_raw(port)
        .map_err(|e| format!("端口 {port} 没有可用的调试服务: {e}"))?;
    let pages = raw
        .as_array()
        .map(|arr| arr.iter().filter(|t| t["type"] == "page").count())
        .unwrap_or(0);

    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(session_key(agent_id)).or_default();
    // 替换前回收旧状态：受控 Chrome kill 掉（换目标不再需要），外部连接直接覆盖
    if let Some(mut old) = sess.chrome_child.take() {
        let exited = old.try_wait().map(|s| s.is_some()).unwrap_or(false);
        if !exited {
            let _ = old.kill();
            let _ = old.wait();
        }
    }
    if let Some(dir) = sess.profile_dir.take() {
        remove_profile_dir(&dir);
    }
    sess.port = port;
    sess.target_id = None;
    sess.observer = None;
    sess.headless = None;
    sess.window_size = None;

    audit_log(agent_id, "connect", &port.to_string(), &format!("{pages} 个页面 target"));
    Ok(json!({ "status": "connected", "port": port, "pages": pages }).to_string())
}

/// 新开 tab（Chrome 调试 HTTP /json/new），并自动 attach 到新 tab。
/// 受控 launch 与外部 connect 的会话都可用；后续操作立即作用于新 tab。
pub(crate) fn cdp_new_tab(
    url: Option<String>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let url = url.unwrap_or_else(|| "about:blank".into());
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(session_key(agent_id)).or_default();
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
    let sess = sessions.entry(session_key(agent_id)).or_default();
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
fn query_process_debug_ports() -> Result<String, String> {
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
fn parse_discover_process_lines(text: &str) -> Vec<(String, u16)> {
    static PS_LINE_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^\s*(\d+)\s+(\S+)\s+(.*)$").expect("ps 行格式正则")
    });
    let mut out: Vec<(String, u16)> = Vec::new();
    for line in text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if line.contains('|') {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 2 {
                if let Ok(port) = parts[1].trim().parse::<u16>() {
                    out.push((parts[0].trim().to_string(), port));
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

fn extract_debug_port_from_args(args: &str) -> Option<u16> {
    args.split_whitespace().find_map(|tok| {
        tok.strip_prefix("--remote-debugging-port=")
            .and_then(|p| p.parse::<u16>().ok())
    })
}

// ═══════════════════════════════════════════════════════════
// target 发现与 attach
// ═══════════════════════════════════════════════════════════

/// 列出所有页面 target（type=page），返回 [{id, title, url}]。
pub(crate) fn cdp_targets(agent_id: Option<&str>) -> Result<String, String> {
    let port = {
        let mut sessions = session_mut(agent_id);
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
/// attach 时启动事件观察（持久 WS 后台 task）。
pub(crate) fn cdp_attach(target_id: &str, agent_id: Option<&str>) -> Result<String, String> {
    let mut sessions = session_mut(agent_id);
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
fn find_webview_target() -> Result<String, String> {
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
    page.and_then(|t| t["id"].as_str().map(String::from))
        .ok_or_else(|| "找不到自家 webview 的调试 target（tauri 调试端口未开启？）".to_string())
}

/// 惰性确保 self 会话已 attach 到自家 webview。返回 (port, target_id)。
/// 只在读动作里被调用；操作动作在 rpc 层被拒。
fn ensure_self_attached() -> Result<(u16, String), String> {
    let mut sessions = lock_sessions();
    let sess = sessions.entry(SELF_AGENT_ID.to_string()).or_default();
    let tid = match &sess.target_id {
        Some(t) => {
            // 确认 target 还活着，死了重找
            match list_targets_raw(WEBVIEW_DEBUG_PORT) {
                Ok(raw) => match raw.as_array().and_then(|a| a.iter().find(|tt| tt["id"].as_str() == Some(t.as_str()))) {
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
fn observer_of(agent_id: Option<&str>) -> Option<Observer> {
    if is_self(agent_id) && ensure_self_attached().is_err() {
        return None;
    }
    let mut sessions = lock_sessions();
    sessions.entry(session_key(agent_id)).or_default().observer.clone()
}

/// 惰性重启事件观察（命令路径）——target 还在但观察任务死了就重开。
fn ensure_observer(agent_id: Option<&str>) -> Option<Observer> {
    if is_self(agent_id) && ensure_self_attached().is_err() {
        return None;
    }
    let mut sessions = lock_sessions();
    let sess = sessions.entry(session_key(agent_id)).or_default();
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

// ═══════════════════════════════════════════════════════════
// WS 命令通道（短连接）
// ═══════════════════════════════════════════════════════════

fn require_target(agent_id: Option<&str>) -> Result<(u16, String), String> {
    let mut sessions = session_mut(agent_id);
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

/// 在 target 内执行 JS 表达式，返回 result.value（JSON 字符串或值）。
async fn runtime_evaluate(expr: &str, agent_id: Option<&str>) -> Result<Value, String> {
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
            return Err(format!(
                "页面内 JS 执行超时（{EVAL_TIMEOUT_MS}ms）——表达式可能死循环或页面主线程卡死"
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

pub(crate) async fn cdp_report(scope: Option<String>, agent_id: Option<&str>) -> Result<String, String> {
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
struct AxNode {
    backend_node_id: u64,
    role: String,
    name: String,
    focusable: bool,
}

fn ax_node_from_value(v: &Value) -> Option<AxNode> {
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

fn ax_role_is_interactive(role: &str) -> bool {
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

/// 清掉页面（含 same-origin iframe / open shadow root）里残留的 data-hg-ref。
const CLEAR_HG_REFS_EXPR: &str = r#"(() => { const seen = new Set(); const clearRoot = (root) => { if (!root || seen.has(root)) return; seen.add(root); if (root.querySelectorAll) { root.querySelectorAll('[data-hg-ref]').forEach((el) => el.removeAttribute('data-hg-ref')); } if (root.querySelectorAll) { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) clearRoot(el.shadowRoot); } for (const f of root.querySelectorAll('iframe, frame')) { try { if (f.contentDocument) clearRoot(f.contentDocument); } catch (e) {} } } }; clearRoot(document); return true; })()"#;

/// 尝试走 Accessibility.getFullAXTree（Chrome DevTools MCP 同款）生成快照。
/// 成功时把选中的 backendNodeId resolve 回 DOM 并补 data-hg-ref 标记，
/// ref 语义与 DOM 探针完全一致（click/type/select 无需感知来源差异）。
/// 任何一步失败都返回 None，由调用方回退增强 DOM 探针。
async fn try_ax_snapshot(
    port: u16,
    target_id: &str,
    max_results: usize,
    offset: usize,
) -> Result<Option<String>, String> {
    let resp = match ws_command(port, target_id, "Accessibility.getFullAXTree", json!({})).await {
        Ok(v) => v,
        Err(_) => return Ok(None), // 旧版 Chromium / 非浏览器 target 没有 AX domain → 回退探针
    };
    let nodes = resp["result"]["nodes"].as_array().cloned().unwrap_or_default();
    if nodes.is_empty() {
        return Ok(None);
    }
    let candidates: Vec<AxNode> = nodes
        .iter()
        .filter_map(ax_node_from_value)
        .filter(|n| ax_role_is_interactive(&n.role) || n.focusable)
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

    // 清残留 ref，再批量 resolve backendNodeId → objectId。
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

    let resolve_cmds: Vec<(u64, String, Value)> = selected
        .iter()
        .enumerate()
        .map(|(i, n)| {
            (
                i as u64 + 1,
                "DOM.resolveNode".to_string(),
                json!({ "backendNodeId": n.backend_node_id }),
            )
        })
        .collect();
    let resolve_replies = match ws_command_batch(port, target_id, resolve_cmds).await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    // 只保留 resolve 成功的节点；ref 从 0 连续编号。
    let mut resolved: Vec<(&AxNode, String)> = Vec::new();
    for (i, node) in selected.iter().enumerate() {
        let object_id = resolve_replies
            .get(&(i as u64 + 1))
            .and_then(|v| v["result"]["object"]["objectId"].as_str())
            .map(String::from);
        if let Some(object_id) = object_id {
            resolved.push((node, object_id));
        }
    }
    if resolved.is_empty() {
        return Ok(None);
    }

    let mark_cmds: Vec<(u64, String, Value)> = resolved
        .iter()
        .enumerate()
        .map(|(i, (_, object_id))| {
            (
                i as u64 + 1,
                "Runtime.callFunctionOn".to_string(),
                json!({
                    "objectId": object_id,
                    "functionDeclaration": "function(ref){ this.setAttribute('data-hg-ref', ref); return { tag: this.tagName ? this.tagName.toLowerCase() : '', id: this.id || '', type: (this.tagName === 'INPUT' || this.tagName === 'BUTTON') ? (this.type || '') : '' }; }",
                    "arguments": [{ "value": i.to_string() }],
                    "returnByValue": true,
                }),
            )
        })
        .collect();
    let mark_replies = match ws_command_batch(port, target_id, mark_cmds).await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    // 标记失败会造成 ref 缺口/错位（属性里写的是 resolved 下标，输出若跳过
    // 失败项就会对不上）。AX 路径只是优先路径——任一条标记失败就整体回退
    // DOM 探针，由探针清标重打，保证 ref 与 data-hg-ref 永远一致。
    let mut refs: Vec<Value> = Vec::new();
    for (i, (node, _)) in resolved.iter().enumerate() {
        let Some(info) = mark_replies
            .get(&(i as u64 + 1))
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
        if let Some(id) = info.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            out["id"] = json!(id);
        }
        if let Some(ty) = info.get("type").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
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
    let scoped = scope.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

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
fn ref_to_selector(target: &str) -> String {
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
fn find_el_expr(sel: &str) -> Result<String, String> {
    let sel_json = serde_json::to_string(sel).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"(() => {{ const sel = {sel_json}; const seen = new Set(); const findIn = (root) => {{ if (!root || seen.has(root)) return null; seen.add(root); if (root.querySelector) {{ const hit = root.querySelector(sel); if (hit) return hit; }} if (root.querySelectorAll) {{ for (const el of root.querySelectorAll('*')) {{ if (el.shadowRoot) {{ const hit = findIn(el.shadowRoot); if (hit) return hit; }} }} for (const f of root.querySelectorAll('iframe, frame')) {{ try {{ if (f.contentDocument) {{ const hit = findIn(f.contentDocument); if (hit) return hit; }} }} catch (e) {{}} }} }} return null; }}; return findIn(document); }})()"#
    ))
}

// ═══════════════════════════════════════════════════════════
// 事件查询 — console / network
// ═══════════════════════════════════════════════════════════

/// 读取事件缓冲的尾部 N 条，返回 JSON 数组字符串。
fn read_buffer(buf: &VecDeque<String>, limit: usize) -> String {
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
        return json!({ "entries": [], "note": "未 attach target" }).to_string();
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let s = read_buffer(&bufs.console, limit.unwrap_or(30));
    format!("{{\"entries\":{s}}}")
}

/// 查询网络事件（最新 N 条，请求/响应已按 requestId 配对）。
pub(crate) fn cdp_network(agent_id: Option<&str>, limit: Option<usize>) -> String {
    let Some(obs) = ensure_observer(agent_id) else {
        return json!({ "entries": [], "paired": true, "note": "未 attach target" }).to_string();
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let n = limit.unwrap_or(30).min(bufs.network.len());
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
        "note": "同一条记录含 requestId/method/url/status/error；status 为 null 表示尚无响应，error 非 null 表示加载失败",
    })
    .to_string()
}

/// 查询单个网络请求详情（仍在 200 条事件窗口内的 requestId）。
/// HAR 作为后续导出项；本动作先覆盖日常排查「这个请求到底带了什么头/回了什么状态」。
pub(crate) fn cdp_network_detail(request_id: &str, agent_id: Option<&str>) -> Result<String, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("network_detail: requestId 不能为空".into());
    }
    let Some(obs) = ensure_observer(agent_id) else {
        return Err("network_detail: 未 attach target（先 browser(attach) 后事件才会被观察）".into());
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
pub(crate) fn cdp_network_har(agent_id: Option<&str>, limit: Option<usize>) -> Result<String, String> {
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
    cleanup_old_files_by_age(&dir, HAR_FILE_PREFIX, har_retain_days(), std::time::SystemTime::now());
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

fn entries_count(har: &Value) -> usize {
    har["log"]["entries"].as_array().map(|a| a.len()).unwrap_or(0)
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
    ws_command(port, &tid, "Page.handleJavaScriptDialog", params).await?;
    set_dialog_open(agent_id, false);
    audit_log(
        agent_id,
        if accept { "dialog_accept" } else { "dialog_dismiss" },
        "",
        "ok",
    );
    Ok(json!({ "handled": true, "accept": accept }).to_string())
}

/// 取最近一次 file chooser 事件（upload 优先用 backendNodeId 注入）。
fn latest_file_chooser(agent_id: Option<&str>) -> Option<Value> {
    let obs = ensure_observer(agent_id)?;
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let raw = bufs.file_choosers.back()?;
    serde_json::from_str(raw).ok()
}

fn set_dialog_open(agent_id: Option<&str>, open: bool) {
    if let Some(obs) = observer_of(agent_id) {
        crate::utils::lock_or_recover(&obs.buffers).dialog_open = open;
    }
}

fn set_file_chooser_open(agent_id: Option<&str>, open: bool) {
    if let Some(obs) = observer_of(agent_id) {
        crate::utils::lock_or_recover(&obs.buffers).file_chooser_open = open;
    }
}

/// 当前错误缓冲条数（世界变化对比用）。
fn error_count(agent_id: Option<&str>) -> usize {
    let Some(obs) = observer_of(agent_id) else { return 0 };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    bufs.errors.len()
}

// ═══════════════════════════════════════════════════════════
// 操作 — actionability + 世界变化反馈
// ═══════════════════════════════════════════════════════════

/// 从 CDP returnByValue 结果解析世界状态。契约：evaluate 表达式必须
/// 直接返回 {u, d} 对象（非 JSON.stringify 字符串）——见 world_snapshot。
fn parse_world_value(val: &Value) -> (String, usize) {
    let u = val["u"].as_str().unwrap_or("").to_string();
    let d = val["d"].as_u64().unwrap_or(0) as usize;
    (u, d)
}

/// 世界状态采样：URL / DOM 大小 / 错误数。
async fn world_snapshot(agent_id: Option<&str>) -> Result<(String, usize, usize), String> {
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
fn world_diff(
    before: &(String, usize, usize),
    after: &(String, usize, usize),
) -> Option<String> {
    let mut changes: Vec<String> = Vec::new();
    if after.0 != before.0 {
        changes.push(format!("URL 变化: {} → {}", before.0, after.0));
    }
    let dom_delta = (after.1 as i64) - (before.1 as i64);
    if dom_delta.abs() > 100 {
        changes.push(format!("DOM 大小变化: {dom_delta:+} 字符（{} → {}）", before.1, after.1));
    }
    if after.2 > before.2 {
        changes.push(format!("新增 {} 条错误（用 browser(console) 查看）", after.2 - before.2));
    }
    if changes.is_empty() {
        None
    } else {
        Some(changes.join("；"))
    }
}

/// 导航轮询上限——链接点击的导航通常 <1s，2s 兜底。
const NAV_POLL_TIMEOUT: Duration = Duration::from_secs(2);
/// reload 新文档提交等待上限——reload 可能重建 service worker/长缓存，给得比导航宽。
const RELOAD_POLL_TIMEOUT: Duration = Duration::from_secs(5);
/// 导航轮询间隔。
const NAV_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// 操作后等待潜在导航完成。端到端实测发现：固定 300ms 等待对导航类点击
/// 不够——采样仍落在旧文档上下文，世界反馈漏报"无显著变化"（点击实际跳了页）。
/// 策略（每种情况都尽早返回，不为无导航点击付满超时）：
///   - URL 已变 → 新文档已提交，再 settle 一次让 DOM 初始化，返回；
///   - URL 未变但 DOM 已显著变化 → SPA 原地更新，无导航，返回；
///   - 采样出错（导航中旧上下文销毁）→ 继续轮询；
///   - 超时（两样都没有）→ 返回，交 world_diff 如实报"无显著变化"。
async fn wait_nav_settle(before: &(String, usize, usize), agent_id: Option<&str>) {
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
async fn wait_reload_commit(before_origin: f64, agent_id: Option<&str>) {
    let deadline = Instant::now() + RELOAD_POLL_TIMEOUT;
    loop {
        match runtime_evaluate("({t: performance.timeOrigin, r: document.readyState})", agent_id).await {
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
async fn navigation_outcome(
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
async fn cdp_history_step(delta: isize, action: &str, agent_id: Option<&str>) -> Result<String, String> {
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
async fn wait_actionable(target: &str, label: &str, agent_id: Option<&str>) -> Result<(f64, f64), String> {
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
            return Err(format!(
                "{label}: 目标不存在或已失效（{target}）——页面可能已变化，请重新 browser(snapshot)"
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
            return Err(format!(
                "{label}: 等待可交互超时（{ACTIONABILITY_TIMEOUT:?}）——元素被遮挡或位置持续变化"
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
    let label = element_label(&sel, agent_id).await.unwrap_or_else(|| target.to_string());
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
async fn element_label(sel: &str, agent_id: Option<&str>) -> Option<String> {
    let expr = format!(
        r#"(() => {{ const el = {finder}; if (!el) return null; const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '); return t.slice(0, 40); }})()"#,
        finder = find_el_expr(sel).ok()?
    );
    let val = runtime_evaluate(&expr, agent_id).await.ok()?;
    let s = val.as_str()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
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
        return Err(format!(
            "type: 目标不存在或已失效（{target}）——页面可能已变化，请重新 browser(snapshot)"
        ));
    }
    let (port, tid) = require_target(agent_id)?;
    ws_command(
        port,
        &tid,
        "Input.insertText",
        json!({ "text": text }),
    )
    .await?;
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
                    return Err(format!("upload: file chooser 注入失败且未提供 selector 回退: {e}"));
                }
                Err(_) => {
                    // 有 selector，继续走 DOM.querySelector 回退。
                }
            }
        }
    }

    // 路径 B：selector → DOM.getDocument + DOM.querySelector。
    let Some(sel) = selector.filter(|s| !s.trim().is_empty()) else {
        return Err("upload: 需要 selector 参数（或先在页面触发 file chooser 事件）".into());
    };
    let sel = ref_to_selector(&sel);
    let doc = ws_command(port, &tid, "DOM.getDocument", json!({ "depth": -1 })).await?;
    let root_node_id = doc["result"]["root"]["nodeId"]
        .as_i64()
        .ok_or("upload: DOM.getDocument 未返回 root.nodeId")?;
    let found = ws_command(
        port,
        &tid,
        "DOM.querySelector",
        json!({ "nodeId": root_node_id, "selector": sel }),
    )
    .await?;
    let node_id = found["result"]["nodeId"]
        .as_i64()
        .ok_or("upload: DOM.querySelector 未返回 nodeId")?;
    if node_id == 0 {
        return Err(format!("upload: selector 无匹配: {sel}"));
    }
    ws_command(
        port,
        &tid,
        "DOM.setFileInputFiles",
        json!({ "files": files, "nodeId": node_id }),
    )
    .await?;
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
fn parse_modifiers(
    modifiers: Option<Vec<String>>,
) -> Result<Vec<(&'static str, &'static str, u32, u32)>, String> {
    let mut mods: Vec<(&'static str, &'static str, u32, u32)> = Vec::new();
    for raw in modifiers.unwrap_or_default() {
        let item = match raw.to_lowercase().as_str() {
            "ctrl" | "control" => ("Control", "ControlLeft", 17u32, 2u32),
            "alt" => ("Alt", "AltLeft", 18, 1),
            "shift" => ("Shift", "ShiftLeft", 16, 8),
            "meta" | "cmd" | "command" | "win" | "windows" => ("Meta", "MetaLeft", 91, 4),
            other => return Err(format!("不支持的修饰键: {other}（支持 ctrl/alt/shift/meta）")),
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
            mods.iter().map(|m| m.0.to_lowercase()).collect::<Vec<_>>().join("+"),
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
                return Err(format!("scroll: 目标不存在或已失效: {sel}（请重新 browser(snapshot)）"));
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
        let ok = runtime_evaluate(&expr, agent_id).await.unwrap_or(Value::Bool(false));
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
const SENSITIVE_CLICK_RE_SOURCE: &str = r"(确认|提交|支付|转账|购买|删除|注销|退订|清空|\b(pay(?:\s+now)?|payment|purchase|buy(?:\s+now)?|delete|confirm|unsubscribe|sign\s*out|log\s*out|transfer|checkout|clear|submit)\b)";

/// 纯函数版高危文本判定（单测锁定英文词覆盖）。页面内 JS 用同一正则源。
#[cfg(test)]
fn is_sensitive_click_text(text: &str) -> bool {
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
    ws_command(
        port,
        &tid,
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width,
            "height": height,
            "deviceScaleFactor": dpr,
            "mobile": mobile.unwrap_or(false),
        }),
    )
    .await?;
    audit_log(agent_id, "viewport", &format!("{width}x{height}@{dpr}"), "ok");
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
    cleanup_old_files_by_age(&dir, SHOT_FILE_PREFIX, shot_retain_days(), std::time::SystemTime::now());
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

// ═══════════════════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════════════════

/// 当前会话状态（供 UI 显示）。external=true 表示连接的是用户自己的实例
/// （connect 来的），kill 只断开、租约只断连，不会杀进程。
pub(crate) fn cdp_status(agent_id: Option<&str>) -> String {
    let mut sessions = session_mut(agent_id);
    let sess = sessions.entry(session_key(agent_id)).or_default();
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
        "attached": sess.target_id.is_some(),
        "chromeRunning": sess.chrome_child.is_some(),
        "external": external,
        "observerAlive": observer_alive,
        "dialogPending": dialog_open,
        "fileChooserPending": file_chooser_open,
    })
    .to_string()
}

// ═══════════════════════════════════════════════════════════
// self 只读动作 — 惰性 attach 自家 webview（首次读操作触发）
// ═══════════════════════════════════════════════════════════
// rpc 层 self=true 时以 SELF_AGENT_ID 路由进来；runtime_evaluate /
// observer_of / ensure_observer 在需要时惰性 attach，无需显式 attach 命令。


// ═══════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    /// 探针语法验证（P0-4）：探针是注入页面的 JS，语法错误要运行时才发现。
    /// 此处用 node --check 强制验证——改坏探针 cargo test 必红。
    /// node 不可用（纯 Rust 环境）时跳过，不视为失败。
    fn assert_valid_js(probe: &str, name: &str) {
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
        assert_valid_js(CONTENT_PROBE, "content");
        assert_valid_js(INSPECT_PROBE, "inspect");
        assert_valid_js(REPORT_PROBE, "report");
        assert_valid_js(SNAPSHOT_PROBE, "snapshot");
    }

    #[test]
    fn chrome_candidate_paths_cover_current_platform() {
        let paths = chrome_candidate_paths();
        assert!(!paths.is_empty(), "每个平台都应有 Chrome/Edge 候选路径");
        #[cfg(target_os = "windows")]
        assert!(paths.iter().any(|p| p.to_string_lossy().ends_with("chrome.exe")));
        #[cfg(target_os = "macos")]
        assert!(paths.iter().any(|p| p.to_string_lossy().contains("Google Chrome.app")));
        #[cfg(all(unix, not(target_os = "macos")))]
        assert!(paths.iter().any(|p| p.to_string_lossy().contains("google-chrome")));
    }

    #[test]
    fn discover_parser_handles_powershell_and_ps_formats() {
        let text = "chrome|9333|1234
bash|9222|99
  456 chromium --remote-debugging-port=9444 --user-data-dir=/tmp/x
";
        let found = parse_discover_process_lines(text);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], ("chrome".to_string(), 9333));
        assert_eq!(found[1], ("chromium".to_string(), 9444));
        assert_eq!(extract_debug_port_from_args("--remote-debugging-port=9447 --flag"), Some(9447));
        assert_eq!(extract_debug_port_from_args("--remote-debugging-port 9447"), None, "Chrome 使用 = 形态");
    }

    #[test]
    fn session_key_falls_back_to_default() {
        assert_eq!(super::session_key(None), "default");
        assert_eq!(super::session_key(Some("")), "default");
        assert_eq!(super::session_key(Some("  ")), "default");
        assert_eq!(super::session_key(Some("agent-7")), "agent-7");
    }

    #[test]
    fn ref_to_selector_handles_ref_and_selector() {
        assert_eq!(super::ref_to_selector("37"), "[data-hg-ref=\"37\"]");
        assert_eq!(super::ref_to_selector("ref:5"), "[data-hg-ref=\"5\"]");
        assert_eq!(super::ref_to_selector(".btn-primary"), ".btn-primary");
        assert_eq!(super::ref_to_selector("#submit"), "#submit");
        assert_eq!(super::ref_to_selector(""), "");
    }

    /// P0 二轮评审：敏感点击检测只有中文动词 → 英文 "Pay now / Delete / Confirm /
    /// Unsubscribe" 不触发单独 Ask。此处锁定页面内 JS 同源正则的 Rust 纯函数版。
    #[test]
    fn sensitive_click_text_covers_english_high_risk_words() {
        for text in [
            "Pay now",
            "PAY NOW",
            "Delete account",
            "Confirm subscription",
            "Unsubscribe",
            "Sign out",
            "Transfer money",
            "Checkout",
            "确认支付",
        ] {
            assert!(
                super::is_sensitive_click_text(text),
                "高危文本应触发敏感点击 Ask: {text}"
            );
        }
        for text in [
            "Read more",
            "Sign in",
            "Delivery status",
            "Deletion is not supported", // 单词边界：delete 不匹配 deletion
            "Play now",                  // 单词边界：pay 不匹配 play
        ] {
            assert!(
                !super::is_sensitive_click_text(text),
                "普通文本不应触发敏感点击 Ask: {text}"
            );
        }
    }

    #[test]
    fn world_diff_reports_changes() {
        let before = ("http://a/".to_string(), 1000, 0);
        let same = ("http://a/".to_string(), 1050, 0);
        let moved = ("http://b/".to_string(), 2000, 3);
        assert_eq!(super::world_diff(&before, &same), None);
        let d = super::world_diff(&before, &moved).unwrap();
        assert!(d.contains("URL 变化"), "应报 URL 变化: {d}");
        assert!(d.contains("DOM 大小变化"), "应报 DOM 变化: {d}");
        assert!(d.contains("3 条错误"), "应报新增错误: {d}");
    }

    /// 契约锁定：world_snapshot 的 evaluate 表达式必须直接返回对象。
    /// 对象形式（当前）能解析出 URL/DOM；JSON.stringify 字符串形式
    /// （b4dd1f5 起的静默失效形态）解析结果为空——防止回归。
    #[test]
    fn parse_world_value_requires_object_form() {
        let obj = serde_json::json!({ "u": "https://a/", "d": 12345 });
        assert_eq!(super::parse_world_value(&obj), ("https://a/".to_string(), 12345));
        // 字符串形态（旧 bug）：索引不到 u/d，全部落空
        let str_form = serde_json::json!(r#"{"u":"https://a/","d":12345}"#);
        assert_eq!(super::parse_world_value(&str_form), (String::new(), 0));
    }

    /// 契约锁定：probe 返回值必须是 stringify 字符串。字符串形态（契约正确）
    /// 原样放行；对象/其他形态（e1679a0f 修复的"形态错乱"同类病）必须报错，
    /// 而非先前静默落到空快照/空结果。
    #[test]
    fn probe_result_str_requires_string_contract() {
        // 正确形态：returnByValue 返回 stringify 后的 JSON 字符串
        let ok = serde_json::json!("{\"refs\":[{\"ref\":0,\"tag\":\"button\"}],\"count\":1}");
        assert_eq!(
            super::probe_result_str(&ok, "snapshot").unwrap(),
            "{\"refs\":[{\"ref\":0,\"tag\":\"button\"}],\"count\":1}"
        );
        // 错误形态 1：返回了对象（探针未 stringify / 被二次序列化的镜像 bug）
        let obj = serde_json::json!({ "refs": [], "count": 0 });
        let e = super::probe_result_str(&obj, "snapshot").unwrap_err();
        assert!(e.contains("snapshot"), "错误应带上调用点标签: {e}");
        assert!(e.contains("形态异常"), "错误应明确提示形态异常: {e}");
        assert!(e.contains("对象"), "对象形态应被指出: {e}");
        // 错误形态 2：Null / 数字 / 非字符串
        for bad in [serde_json::Value::Null, serde_json::json!(42), serde_json::json!(true)] {
            assert!(super::probe_result_str(&bad, "inspect").is_err(), "非字符串形态应报错: {bad}");
        }
    }

    /// A4：ensure_observer_started 在重启时复用旧缓冲（Arc 同一）——
    /// 观察任务短暂断连/重启不丢已累积事件历史。无需真实 CDP：
    /// start_observer 的 tokio 任务连不上端口会自动静默退出，buffers Arc 不受影响。
    #[tokio::test]
    async fn observer_restart_reuses_buffers_arc() {
        use std::sync::Arc;
        let mut sess = CdpSession::default();
        // 首次启动：产生一个全新 buffers Arc
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let first = sess.observer.as_ref().expect("首次启动应生成 observer").buffers.clone();
        // 模拟观察任务已死（alive=false），触发惰性重启
        sess.observer.as_ref().unwrap().alive.store(false, Ordering::SeqCst);
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let second = sess.observer.as_ref().expect("重启后 observer 应存在").buffers.clone();
        assert!(
            Arc::ptr_eq(&first, &second),
            "重启必须复用同一个 buffers Arc——否则历史被清空"
        );
    }

    /// A4：在途启动闸——第二个 ensure_observer_started 在闸生效时被跳过，
    /// observer 不被替换（防并发重复 spawn 出孤儿观察任务）。
    #[tokio::test]
    async fn observer_inflight_guard_blocks_duplicate_start() {
        let mut sess = CdpSession::default();
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let before = sess.observer.as_ref().map(|o| Arc::clone(&o.buffers));
        // 模拟并发：另一条路径已置起在途闸
        sess.observer_starting.store(true, Ordering::SeqCst);
        super::ensure_observer_started(&mut sess, 39998, "t1");
        let after = sess.observer.as_ref().map(|o| Arc::clone(&o.buffers));
        assert!(
            Arc::ptr_eq(&before.unwrap(), &after.unwrap()),
            "在途闸生效时不得替换 observer（防孤儿任务）"
        );
    }

    /// P0 新动作的参数校验单测：在触及真实 CDP 前先拒绝非法参数，
    /// 避免坏参数被误判成「需要真实浏览器」而漏测。
    #[tokio::test]
    async fn new_actions_reject_invalid_args_before_cdp() {
        let e = super::cdp_navigate("   ", None).await.unwrap_err();
        assert!(e.contains("url 不能为空"), "{e}");
        let e = super::cdp_content(None, Some("pdf".into()), None, None, None)
            .await
            .unwrap_err();
        assert!(e.contains("text 或 markdown"), "{e}");
        let e = super::cdp_select("37", "", None).await.unwrap_err();
        assert!(e.contains("value 不能为空"), "{e}");
        let e = super::cdp_upload(None, vec![], None).await.unwrap_err();
        assert!(e.contains("files 不能为空"), "{e}");
        let e = super::cdp_close_tab("  ", None).unwrap_err();
        assert!(e.contains("targetId 不能为空"), "{e}");
        let e = super::cdp_press("a", Some(vec!["hyper".into()]), None)
            .await
            .unwrap_err();
        assert!(e.contains("不支持的修饰键"), "{e}");
    }

    /// 第三批 network 配对：requestWillBeSent 建立一条记录，
    /// responseReceived 按 requestId 回填同一条（不追加 resp 流水账），
    /// loadingFailed 回填 error 且不把 requestId 塞进 url。
    #[test]
    fn network_events_pair_by_request_id() {
        let mut bufs = EventBuffers::default();
        network_on_request(
            &mut bufs,
            &serde_json::json!({
                "requestId": "r1",
                "url": "https://example.com/a",
                "method": "GET",
                "type": "Document",
                "wallTime": 1.5,
                "request": { "url": "https://example.com/a", "method": "GET", "headers": { "accept": "*/*" } }
            }),
        );
        network_on_response(
            &mut bufs,
            &serde_json::json!({
                "requestId": "r1",
                "response": { "url": "https://example.com/a", "status": 200, "statusText": "OK", "mimeType": "text/html", "headers": { "content-type": "text/html" } }
            }),
        );
        assert_eq!(bufs.network.len(), 1, "response 必须回填同一条请求，而不是追加第二条");
        let entry = &bufs.network[0];
        assert_eq!(entry.request_id, "r1");
        assert_eq!(entry.status, Some(200));
        assert_eq!(entry.mime_type.as_deref(), Some("text/html"));

        network_on_failed(
            &mut bufs,
            &serde_json::json!({
                "requestId": "r1",
                "errorText": "net::ERR_CONNECTION_REFUSED"
            }),
        );
        assert_eq!(bufs.network.len(), 1);
        let entry = &bufs.network[0];
        assert_eq!(entry.error.as_deref(), Some("net::ERR_CONNECTION_REFUSED"));
        assert_eq!(entry.url.as_deref(), Some("https://example.com/a"), "loadingFailed 不得用 requestId 覆盖 url");

        // 缺失 request 的孤立失败：只记 error，url 保持 null（诚实，不伪造 requestId=url）
        network_on_failed(
            &mut bufs,
            &serde_json::json!({ "requestId": "r2", "errorText": "net::ERR_FAILED" }),
        );
        let entry = bufs.network_index.get("r2").expect("孤立失败也应有索引条目");
        assert_eq!(entry.url, None);
        assert!(entry.summary_value()["error"].as_str().is_some());
    }

    /// 第三批 AX 解析：锁住 getFullAXTree 节点形态与可交互 role 白名单，
    /// 避免「命令成功但解析错位」只能在真实 Chrome 上才能暴露。
    #[test]
    fn ax_node_parsing_and_interactive_role_filter() {
        let node = serde_json::json!({
            "nodeId": "3",
            "ignored": false,
            "role": { "type": "role", "value": "button" },
            "name": { "type": "string", "value": "Save" },
            "backendDOMNodeId": 17,
            "properties": [
                { "name": "focusable", "value": { "type": "boolean", "value": true } }
            ]
        });
        let parsed = ax_node_from_value(&node).expect("标准 AX 节点应可解析");
        assert_eq!(parsed.backend_node_id, 17);
        assert_eq!(parsed.role, "button");
        assert_eq!(parsed.name, "Save");
        assert!(parsed.focusable);
        assert!(ax_role_is_interactive("Button"));
        assert!(ax_role_is_interactive("textbox"));
        assert!(!ax_role_is_interactive("StaticText"));

        let ignored = serde_json::json!({
            "role": { "value": "button" },
            "name": { "value": "x" },
            "backendDOMNodeId": 18,
            "ignored": true
        });
        assert!(ax_node_from_value(&ignored).is_none(), "ignored 节点不应进入快照");
        let no_backend = serde_json::json!({ "role": { "value": "button" }, "name": { "value": "x" } });
        assert!(ax_node_from_value(&no_backend).is_none(), "没有 backendDOMNodeId 无法回写 ref");
    }

    /// 第四批 HAR 导出的纯函数部分：不依赖 observer/Chrome 即可锁定
    /// entry 形状（queryString、headers、postData、状态、error 均不丢）。
    #[test]
    fn network_entry_har_shape_keeps_observable_fields() {
        let entry = NetworkEntry {
            request_id: "r1".into(),
            method: "GET".into(),
            url: Some("https://example.com/p?q=1&x=a b".into()),
            status: Some(200),
            status_text: Some("OK".into()),
            mime_type: Some("application/json".into()),
            resource_type: Some("XHR".into()),
            wall_time: Some(1_700_000_000.5),
            request_headers: Some(serde_json::json!({ "accept": "*/*" })),
            response_headers: Some(serde_json::json!({ "content-type": "application/json" })),
            post_data: Some("{\"a\":1}".into()),
            error: None,
            ..NetworkEntry::default()
        };
        let har = entry.har_entry();
        assert_eq!(har["request"]["method"], "GET");
        assert_eq!(har["request"]["url"], "https://example.com/p?q=1&x=a b");
        assert_eq!(har["request"]["queryString"][0]["name"], "q");
        assert_eq!(har["request"]["postData"]["text"], "{\"a\":1}");
        assert_eq!(har["response"]["status"], 200);
        assert_eq!(har["response"]["content"]["mimeType"], "application/json");
        assert_eq!(har["response"]["headers"][0]["name"], "content-type");
        assert!(!har["startedDateTime"].as_str().unwrap_or("").is_empty());
        assert_eq!(har["connection"], "r1");

        let failed = NetworkEntry {
            request_id: "r2".into(),
            url: Some("https://example.com/fail".into()),
            error: Some("net::ERR_FAILED".into()),
            ..NetworkEntry::default()
        };
        assert_eq!(failed.har_entry()["response"]["_error"], "net::ERR_FAILED");
    }

    /// 第四批 viewport 参数：坏尺寸/DPR 在碰真实 CDP 前拒绝。
    #[tokio::test]
    async fn viewport_rejects_invalid_args_before_cdp() {
        let e = cdp_set_viewport(0, 600, None, None, None).await.unwrap_err();
        assert!(e.contains("width/height"), "{e}");
        let e = cdp_set_viewport(800, 600, Some(4.0), None, None)
            .await
            .unwrap_err();
        assert!(e.contains("deviceScaleFactor"), "{e}");
    }

    /// 第三批 launch 参数：windowSize 非法值在找 Chrome 之前就被拒绝。
    #[tokio::test]
    async fn launch_rejects_invalid_window_size_before_cdp() {
        let e = cdp_launch(None, None, Some(false), Some((0, 600)), None)
            .await
            .unwrap_err();
        assert!(e.contains("windowSize"), "{e}");
    }

    /// 组合键参数归一化：别名收口、去重、非法值明确报错。
    #[test]
    fn parse_modifiers_normalizes_aliases_and_dedupes() {
        let m = super::parse_modifiers(Some(vec!["ctrl".into(), "Control".into(), "cmd".into()])).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].0, "Control");
        assert_eq!(m[1].0, "Meta");
        assert!(super::parse_modifiers(Some(vec!["bad".into()])).is_err());
    }

    /// Chrome 调试 HTTP 端点协议级测试：/json/new?url=... 走 PUT 且解析 target；
    /// /json/close/{targetId} 走 GET 且不要求 JSON body。不依赖真实 Chrome。
    #[test]
    fn http_new_tab_and_close_tab_protocol() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 本地测试端口");
        let port = listener.local_addr().expect("读取端口").port();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    let n = reader.read_line(&mut line).expect("read line");
                    if n == 0 || line == "\r\n" || line == "\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let (status, body) = if head.starts_with("PUT /json/new?") {
                    (
                        "200 OK",
                        r#"{"id":"tab-1","title":"x","url":"https://example.com/?q=1","webSocketDebuggerUrl":"ws://127.0.0.1/devtools/page/tab-1"}"#,
                    )
                } else if head.starts_with("GET /json/close/tab-1") {
                    ("200 OK", "Target is closing")
                } else {
                    ("404 Not Found", "not found")
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(resp.as_bytes()).expect("write response");
            }
        });

        let created = super::http_new_tab(port as u16, "https://example.com/?q=1").expect("new tab 请求");
        assert_eq!(created["id"].as_str(), Some("tab-1"));
        super::http_close_tab(port as u16, "tab-1").expect("close tab 请求");
        server.join().expect("server join");
    }

    /// B3：cdp_wait 的固定 ms 路径——确定性休眠，不需要真实浏览器。
    #[tokio::test]
    async fn wait_fixed_ms_sleeps_and_returns() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        // 阈值上限 30s；这里用 200ms 验证至少等待了该时长
        let out = super::cdp_wait(None, Some(200), None).await.unwrap();
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(200), "应至少等待 200ms, 实际 {elapsed:?}");
        assert!(out.contains("200"), "返回值应含 waited_ms: {out}");
    }

    /// B3：无 selector 也无 ms → 明确错误。
    #[tokio::test]
    async fn wait_requires_selector_or_ms() {
        let err = super::cdp_wait(None, None, None).await.unwrap_err();
        assert!(err.contains("selector 或 ms"), "应提示需要参数: {err}");
    }

    /// 租约回收 + profile 清理（遗留项实测的代码侧）：空闲超时 → kill 子进程、
    /// 移除会话、删除 profile 目录。用真实哑进程验证 kill 链路，不依赖 Chrome。
    #[test]
    fn lease_expiry_kills_child_and_cleans_profile() {
        // 哑进程：长时间存活（Windows 用 ping 循环，其他平台 sleep）
        let mut cmd = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            cmd.args(["/C", "ping", "-n", "1000", "127.0.0.1"]);
        } else {
            cmd.args(["-c", "sleep 1000"]);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::utils::NO_WINDOW);
        }
        let child = cmd.spawn().expect("spawn 哑进程");

        let key = "lease-test-agent";
        let dir = std::env::temp_dir().join("hologram-browser-profile-99997");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("stale.txt"), "stale").ok();

        {
            let mut sessions = lock_sessions();
            sessions.insert(
                key.to_string(),
                CdpSession {
                    port: 9999,
                    target_id: None,
                    chrome_child: Some(child),
                    profile_dir: Some(dir.clone()),
                    headless: None,
                    window_size: None,
                    observer: None,
                    observer_starting: Arc::new(AtomicBool::new(false)),
                    // 活跃时间放到租约之外，强制命中回收分支
                    last_active: Instant::now() - session_lease() - Duration::from_secs(5),
                },
            );
        }

        enforce_lease();

        {
            let sessions = lock_sessions();
            assert!(!sessions.contains_key(key), "租约到期会话应被移除");
        }
        assert!(!dir.exists(), "profile 目录应随会话回收一并删除");
    }

    /// 第四批轮转清理：按修改时间淘汰前缀文件。用 File::set_times 把
    /// 文件 mtime 拨回过去，验证「保留窗口内不动、窗口外删除」。
    #[test]
    fn cleanup_old_files_by_age_removes_expired_prefix_only() {
        let dir = std::env::temp_dir().join(format!("hologram-cleanup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建清理测试目录");
        let now = std::time::SystemTime::now();
        let old_path = dir.join("hologram-browser-audit-20200101.jsonl");
        let fresh_path = dir.join("hologram-browser-audit-20260815.jsonl");
        let other_path = dir.join("keep-me.txt");
        for path in [&old_path, &fresh_path, &other_path] {
            let f = std::fs::File::create(path).expect("创建测试文件");
            let modified = if path == &old_path {
                now - std::time::Duration::from_secs(8 * 24 * 60 * 60)
            } else {
                now
            };
            let times = std::fs::FileTimes::new().set_modified(modified);
            f.set_times(times).expect("设置 mtime");
        }
        cleanup_old_files_by_age(&dir, "hologram-browser-audit-", 7, now);
        assert!(!old_path.exists(), "过期审计文件应被删除");
        assert!(fresh_path.exists(), "窗口内文件应保留");
        assert!(other_path.exists(), "非本套件前缀文件不得误删");
        assert!(
            !is_expired_file_time(now - std::time::Duration::from_secs(6 * 24 * 60 * 60), now, 7)
        );
        assert!(
            is_expired_file_time(now - std::time::Duration::from_secs(8 * 24 * 60 * 60), now, 7)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 审计回放（遗留项实测的代码侧）：写入 → 查询可见，内存环形路径闭环。
    /// 同时覆盖 agent 过滤：过滤匹配命中、过滤不匹配落空。
    #[test]
    fn audit_roundtrip() {
        let marker = format!("audit-test-{}", std::process::id());
        audit_log(Some("tester"), "eval", "1+1", &marker);
        let out = cdp_audit(Some("tester"), Some(50));
        assert!(out.contains(&marker), "审计查询应包含刚写入的条目: {out}");
        let out2 = cdp_audit(Some("no-such-agent"), Some(50));
        assert!(!out2.contains(&marker), "agent 过滤应排除他人条目: {out2}");
    }
}

// 真实 Chrome 端到端测试（无 Chrome 自动跳过，覆盖 connect/launch 全链路）。
#[cfg(test)]
mod e2e;
