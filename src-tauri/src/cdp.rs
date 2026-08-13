// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// CDP (Chrome DevTools Protocol) 客户端 — 让 Agent 观察/操作 Chromium 页面。
//
// 架构（ADR 0003 落地，P1/P2）：
//   - 命令通道：短连接（每次调用建立 WS，用完即关）——本地回环开销可忽略，
//     避免长连接命令状态机；connect/发送/等待全部包在 tokio timeout 里，
//     Runtime.evaluate 另带 CDP 层 5s 超时——页面死循环不会挂死 Agent 流。
//   - 事件通道：attach 后起一条持久 WS 后台 task，订阅 Runtime/Log/Network
//     事件进环形缓冲，browser(console)/browser(network) 随时查询；
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

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/// HoloGram 自家 webview 的调试端口（tauri.conf.json additionalBrowserArgs）。
/// 受控 Chrome 永远不许用这个端口；self 会话专用。
const WEBVIEW_DEBUG_PORT: u16 = 9222;

/// 受控 Chrome 默认端口起点，占用则向后探测（避开 9222）。
const DEFAULT_PORT_BASE: u16 = 9223;
const PORT_PROBE_LIMIT: u16 = 16;

/// WS 命令全链路超时——connect/发送/等待响应任一步卡住都在此上限内返回错误。
const WS_TIMEOUT: Duration = Duration::from_secs(10);

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

/// 页面事件环形缓冲——事件 task 写入，查询动作读取。
#[derive(Default)]
struct EventBuffers {
    console: VecDeque<String>,
    network: VecDeque<String>,
    errors: VecDeque<String>,
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
        // 订阅三类事件（命令 id 用 ≥1000 与命令通道区分，响应直接跳过）
        for (id, method) in [(1000u64, "Runtime.enable"), (1001, "Log.enable"), (1002, "Network.enable")] {
            let msg = json!({ "id": id, "method": method }).to_string();
            if ws.send(Message::text(msg)).await.is_err() {
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
                    let url = params["request"]["url"].as_str().unwrap_or("");
                    let entry = json!({
                        "method": params["request"]["method"].as_str().unwrap_or(""),
                        "url": truncate_str(url, 200),
                        "status": null
                    })
                    .to_string();
                    push_capped(&mut bufs.network, entry, NETWORK_BUF_MAX);
                }
                "Network.responseReceived" => {
                    let url = params["response"]["url"].as_str().unwrap_or("");
                    let status = params["response"]["status"].as_u64().unwrap_or(0);
                    // 与上一个同 URL 的请求配对更新 status；简化：直接追加一条响应记录
                    let entry = json!({ "method": "resp", "url": truncate_str(url, 200), "status": status }).to_string();
                    push_capped(&mut bufs.network, entry, NETWORK_BUF_MAX);
                }
                "Network.loadingFailed" => {
                    let entry = json!({
                        "method": "failed",
                        "url": truncate_str(params["requestId"].as_str().unwrap_or(""), 200),
                        "status": params["errorText"].as_str().unwrap_or("failed")
                    })
                    .to_string();
                    push_capped(&mut bufs.network, entry, NETWORK_BUF_MAX);
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
    // 落盘：临时目录 jsonl，跨会话可查。失败静默（审计是尽力而为）。
    use std::io::Write;
    let path = std::env::temp_dir().join("hologram-browser-audit.jsonl");
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
pub(crate) async fn cdp_launch(
    url: Option<String>,
    port: Option<u16>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    // 已启动过且 Chrome 还活着 → 复用：
    //   - 未显式指定端口：直接复用本 agent 的现有端口；
    //   - 显式指定端口：与本 agent 现有端口一致且活着才复用。
    {
        let mut sessions = session_mut(agent_id);
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
    // 独立 profile（按端口隔离）— 绝不污染用户日常 Chrome 的 cookie/登录态
    let profile_dir = profile_dir_for(port);

    {
        let mut sessions = session_mut(agent_id);
        // 先清扫遗留 profile 再登记本会话目录：目录登记先于 spawn，
        // 并发 launch 的清扫会跳过它，不会互删正在使用的目录。
        sweep_stale_profiles(&sessions);
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
        if let Some(old_dir) = sess.profile_dir.take() {
            remove_profile_dir(&old_dir);
        }
        sess.port = port;
        sess.profile_dir = Some(profile_dir.clone());

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
        sess.chrome_child = Some(child);
    }

    wait_for_port(port, Duration::from_secs(10)).await?;
    audit_log(agent_id, "launch", &port.to_string(), "ok");
    Ok(json!({ "status": "launched", "port": port, "chrome": chrome.to_string_lossy() }).to_string())
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

    audit_log(agent_id, "connect", &port.to_string(), &format!("{pages} 个页面 target"));
    Ok(json!({ "status": "connected", "port": port, "pages": pages }).to_string())
}

/// 发现本机所有开了调试端口的 Chromium 系实例（用户自己启动的 Chrome/Edge/
/// Electron 等）。查进程表命令行拿端口，再逐个确认 CDP 应答并列出页面——
/// 用户无需知道端口号，从清单里选即可。
/// 自家 webview（9222）被过滤——那是 self 只读通道，不是可连接实例。
pub(crate) fn cdp_discover() -> Result<String, String> {
    // PowerShell 查所有进程命令行里的 --remote-debugging-port=<port>。
    // 不限定进程名：Electron 应用进程名各异，端口参数是唯一可靠特征。
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps.creation_flags(crate::utils::NO_WINDOW);
    }
    let out = ps.output()
        .map_err(|e| format!("discover: 查询进程表失败: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);

    // 同端口多进程（Chrome 主进程 + 各渲染进程共享一个调试端口）去重。
    // 启动器进程（bash/cmd/powershell）命令行也含端口参数——若已有条目
    // 名字是启动器而新名字更可信，替换显示名。
    fn is_launcher(name: &str) -> bool {
        let n = name.to_lowercase();
        n.contains("bash") || n.contains("cmd") || n.contains("powershell") || n.ends_with(".sh")
    }

    let mut seen: Vec<u16> = Vec::new();
    let mut instances: Vec<Value> = Vec::new();
    for line in text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 2 {
            continue;
        }
        let port: u16 = match parts[1].trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if port == 0 || port == WEBVIEW_DEBUG_PORT {
            continue;
        }
        if let Some(idx) = seen.iter().position(|&p| p == port) {
            let old = instances[idx]["browser"].as_str().unwrap_or("");
            if is_launcher(old) && !is_launcher(parts[0]) {
                instances[idx]["browser"] = json!(parts[0]);
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
            "browser": parts[0],
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

/// 通过 CDP WebSocket 发送一条命令，返回响应 JSON（含 result）。
async fn ws_command(port: u16, target_id: &str, method: &str, params: Value) -> Result<Value, String> {
    let fut = async {
        let raw = list_targets_raw(port)?;
        let arr = raw.as_array().ok_or("CDP /json 返回非数组")?;
        let ws_url = arr
            .iter()
            .find(|t| t["id"].as_str() == Some(target_id))
            .and_then(|t| t["webSocketDebuggerUrl"].as_str().map(String::from))
            .ok_or_else(|| format!("target {target_id} 已消失（页面可能被关闭）"))?;

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
                }
                _ => {}
            }
        }
    };
    tokio::time::timeout(WS_TIMEOUT, fut)
        .await
        .map_err(|_| format!("CDP {method} 超时（{WS_TIMEOUT:?} 无响应）——页面主线程可能卡死"))?
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

// ═══════════════════════════════════════════════════════════
// 探针 JS — 独立文件，include_str! 嵌入（单一来源，ADR 0003 D4/D7）
// 语法由底部 #[cfg(test)] probes_are_valid_javascript 用 node --check 强制验证。
// ═══════════════════════════════════════════════════════════

const INSPECT_PROBE: &str = include_str!("cdp/probes/inspect.js");
const REPORT_PROBE: &str = include_str!("cdp/probes/report.js");
const SNAPSHOT_PROBE: &str = include_str!("cdp/probes/snapshot.js");

/// 解析探针 evaluate 返回值，统一兑现「probe 返回 stringify 字符串」的契约
/// （ADR 0003 D7：probe 用 JSON.stringify 包裹 + returnByValue 取字符串）。
/// 违反契约（如误返回对象 / 被二次序列化）时返回明确错误，而非静默落到空结果
/// ——空快照会掩盖"探针根本没跑出东西"这条线索（曾因 JSON.stringify 形态错乱
/// 在 world_snapshot 静默失效，e1679a0f 修复；这里把同类契约显式锁死）。
fn probe_result_str(val: &Value, label: &str) -> Result<String, String> {
    val.as_str().map(|s| s.to_string()).ok_or_else(|| {
        format!(
            "{label}: 探针返回形态异常（期望 stringify 字符串，实际 {:?}）——             页面上下文可能被销毁，或返回契约被破坏",
            if val.is_object() { "对象" } else { "非字符串" }
        )
    })
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

// ═══════════════════════════════════════════════════════════
// snapshot + ref — 可交互元素清单（ADR 0003 D2）
// ═══════════════════════════════════════════════════════════

/// 页面快照：给可交互元素打 data-hg-ref 标记，返回 {refs,count,total,offset,truncated}。
/// B4 分页：offset 取第 N 页（每页 max_results），truncated 表明是否还有下一页。
pub(crate) async fn cdp_snapshot(
    scope: Option<String>,
    max_results: Option<usize>,
    offset: Option<usize>,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let expr = format!(
        "JSON.stringify(({})({}, {}, {}))",
        SNAPSHOT_PROBE,
        serde_json::to_string(&scope.unwrap_or_default()).map_err(|e| e.to_string())?,
        max_results.unwrap_or(80),
        offset.unwrap_or(0)
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

/// 查询网络事件（最新 N 条）。
pub(crate) fn cdp_network(agent_id: Option<&str>, limit: Option<usize>) -> String {
    let Some(obs) = ensure_observer(agent_id) else {
        return json!({ "entries": [], "note": "未 attach target" }).to_string();
    };
    let bufs = crate::utils::lock_or_recover(&obs.buffers);
    let s = read_buffer(&bufs.network, limit.unwrap_or(30));
    format!("{{\"entries\":{s}}}")
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

/// actionability 等待：元素存在、可见、中心点未被遮挡、位置稳定（两次采样差 <1px）。
/// 返回元素中心点（viewport 相对）。超时返回带恢复指引的错误。
async fn wait_actionable(target: &str, label: &str, agent_id: Option<&str>) -> Result<(f64, f64), String> {
    let deadline = Instant::now() + ACTIONABILITY_TIMEOUT;
    let mut last_center: Option<(f64, f64)> = None;
    loop {
        let expr = format!(
            r#"(() => {{ const el = document.querySelector({sel}); if (!el) return null; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return {{ reason: 'invisible' }}; const x = r.x + r.width / 2, y = r.y + r.height / 2; const top = document.elementFromPoint(x, y); const hit = !top || el === top || el.contains(top); return {{ x, y, hit }}; }})()"#,
            sel = serde_json::to_string(target).map_err(|e| e.to_string())?
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

/// 查元素的可见文本（截断 40 字符），审计展示用。查不到返回 None。
async fn element_label(sel: &str, agent_id: Option<&str>) -> Option<String> {
    let expr = format!(
        r#"(() => {{ const el = document.querySelector({sel}); if (!el) return null; const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '); return t.slice(0, 40); }})()"#,
        sel = serde_json::to_string(sel).ok()?
    );
    let val = runtime_evaluate(&expr, agent_id).await.ok()?;
    let s = val.as_str()?.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// 输入文本（聚焦元素 + insertText）。中文/IME 友好。
pub(crate) async fn cdp_type(
    target: &str,
    text: &str,
    agent_id: Option<&str>,
) -> Result<String, String> {
    let sel = ref_to_selector(target);
    let before = world_snapshot(agent_id).await?;
    let focus_expr = format!(
        r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.focus(); return true; }})()"#,
        sel = serde_json::to_string(&sel).map_err(|e| e.to_string())?
    );
    let ok = runtime_evaluate(&focus_expr, agent_id).await?;
    if !ok.as_bool().unwrap_or(false) {
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
    Ok(json!({ "typed": text.chars().take(50).collect::<String>(), "change": change }).to_string())
}

/// 按键（Enter/Tab/Escape/Backspace/方向键/单字符）。
/// 单字符按键必须携带 text 字段——React 受控输入等场景 keyDown 不带 text
/// 不会产生字符（P0-6）。
pub(crate) async fn cdp_press(key: &str, agent_id: Option<&str>) -> Result<String, String> {
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
    let mut down = json!({ "type": "keyDown", "key": key_name, "code": code, "windowsVirtualKeyCode": vk });
    let mut up = json!({ "type": "keyUp", "key": key_name, "code": code, "windowsVirtualKeyCode": vk });
    if let Some(t) = text {
        down["text"] = json!(t);
        up["text"] = json!(t);
    }
    ws_command(port, &tid, "Input.dispatchKeyEvent", down).await?;
    ws_command(port, &tid, "Input.dispatchKeyEvent", up).await?;
    audit_log(agent_id, "press", key, "ok");
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
            let sel = ref_to_selector(&sel);
            let expr = format!(
                r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; el.scrollIntoView({{ behavior: 'smooth', block: 'center' }}); return true; }})()"#,
                sel = serde_json::to_string(&sel).map_err(|e| e.to_string())?
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
            r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }})()"#,
            sel = serde_json::to_string(&sel).map_err(|e| e.to_string())?
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

/// 判定目标是否为敏感操作：type 到已填值输入框/password 框；click 提交按钮、
/// 下载链接、或文本含高危动词的元素。判定失败（未 attach 等）静默放行——
/// 后续操作本身会给出明确错误。
pub(crate) async fn check_sensitive(target: &str, action: &str, agent_id: Option<&str>) -> bool {
    let sel = ref_to_selector(target);
    let sel_json = match serde_json::to_string(&sel) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let expr = match action {
        "type" => format!(
            r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; const t = (el.tagName || '').toLowerCase(); if (t === 'input' && el.type === 'password') return true; return (t === 'input' || t === 'textarea') && !!el.value; }})()"#,
            sel = sel_json
        ),
        "click" => format!(
            r#"(() => {{ const el = document.querySelector({sel}); if (!el) return false; const t = (el.tagName || '').toLowerCase(); const ty = (t === 'input' || t === 'button') ? (el.type || '').toLowerCase() : ''; if (ty === 'submit') return true; if (el.hasAttribute && el.hasAttribute('download')) return true; const text = (el.innerText || el.value || '').slice(0, 40); return /确认|提交|支付|转账|购买|删除|注销|退订|清空/.test(text); }})()"#,
            sel = sel_json
        ),
        _ => return false,
    };
    runtime_evaluate(&expr, agent_id)
        .await
        .map(|v| v.as_bool().unwrap_or(false))
        .unwrap_or(false)
}

// ═══════════════════════════════════════════════════════════
// 截图（P2）— Page.captureScreenshot 落盘
// ═══════════════════════════════════════════════════════════

pub(crate) async fn cdp_screenshot(agent_id: Option<&str>) -> Result<String, String> {
    let (port, tid) = require_target(agent_id)?;
    let resp = ws_command(port, &tid, "Page.captureScreenshot", json!({ "format": "png" })).await?;
    let data = resp["result"]["data"]
        .as_str()
        .ok_or("截图失败: 响应无 data（Page.captureScreenshot 未返回图片）")?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("截图 base64 解码失败: {e}"))?;
    let dir = std::env::temp_dir().join("hologram-browser-shots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("shot-{ts}.png"));
    std::fs::write(&path, bytes).map_err(|e| format!("写截图文件失败: {e}"))?;
    audit_log(agent_id, "screenshot", &tid, "ok");
    Ok(json!({
        "path": path.to_string_lossy(),
        "bytes": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        "note": "截图已落盘（纯文本模型看不到内容，可交给用户确认；vision 模型可读路径）",
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
    json!({
        "port": sess.port,
        "attached": sess.target_id.is_some(),
        "chromeRunning": sess.chrome_child.is_some(),
        "external": external,
        "observerAlive": sess.observer.as_ref().map(|o| o.alive.load(Ordering::SeqCst)).unwrap_or(false),
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
        assert_valid_js(INSPECT_PROBE, "inspect");
        assert_valid_js(REPORT_PROBE, "report");
        assert_valid_js(SNAPSHOT_PROBE, "snapshot");
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
