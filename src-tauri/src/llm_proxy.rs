// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// LLM 本地反向代理 — 让 provider 的 HTTP 调用走后端，绕开 WebView 的 CORS 限制。
//
// 背景（2026-08-16 全链路审计）：
//   此前 provider 请求从 WebView 直接 fetch()，受浏览器 CORS 约束——Anthropic
//   不返回 Access-Control-Allow-Origin（浏览器必被挡）、OpenAI 亦然；只有少数
//   厂商（如 DeepSeek）放行。这是「配置了多供应商却全部无法实际调用」的根因。
//   成熟 Agent 软件（Cline / Cherry Studio / Chatbox）均把 LLM HTTP 走后端转发。
//
// 形态：
//   本地 HTTP 服务仅监听 127.0.0.1:<port>。前端 provider 层把真实目标 URL 放
//   在 `x-hologram-target` 头，POST 到本代理；本代理用 reqwest 流式转发到目标，
//   把上游响应体（SSE）逐块透传回来，并给每个响应加 `Access-Control-Allow-Origin: *`。
//   前端既有的 SSE 解析（sseEvents / readSSE）完全不变——只是 fetch 指向本代理。
//
// 安全：
//   - 仅绑定 loopback；丢弃非 loopback 来源连接。
//   - 只接受 POST / OPTIONS（另有 GET /plugins/* 走 plugin_assets 静态通道）；
//     目标 URL 必须是绝对 http/https（允许 localhost——
//     用户配置的本地端点如 Ollama `http://localhost:11434/v1` 是合法场景）。
//   - 禁止 `file:`/`data:` 等非 http 协议。
//   - 请求体有 64MB 上限；上游响应体无界但由调用方各自流式消费。
//   - CORS 头无条件放行（本代理只接受 loopback 调用，无跨站风险面）。

use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::OnceLock;
use tokio::net::TcpListener;

/// 代理监听端口（相对稳定，避免与引擎 9777 / memory 9600 冲突）。
const PROXY_PORT: u16 = 14570;

/// 全局端口分配器冲突时自增兜底；导出端口用 OnceLock 缓存。
static AVAILABLE_PROXY_PORT: OnceLock<u16> = OnceLock::new();

/// 请求体上限（64MB）— 防止本地恶意/异常大负载住内存。
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// 记录实际绑定的端口（若 14570 被占则 +1 重试）。
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

/// 进程级停机标志 — 窗口关闭 drain 阶段由 LlmProxyService 置位，accept 循环
/// 每 200ms 轮询一次后退出。否则 std::process::exit(0) 会撞上仍在跑的
/// hyper/reqwest 网络线程（Winsock I/O 与 ExitProcess 竞争 → 0x40000015
/// unknown software exception 弹窗，2026-08-17 修复）。
static PROXY_SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// 请求代理优雅停机：置位标志后服务线程 ≤200ms 内退出 accept 循环，
/// tokio runtime 随之 drop（在途连接被中止）。幂等，可重复调用。
pub fn stop_llm_proxy() {
    PROXY_SHUTDOWN.store(true, Ordering::SeqCst);
}

pub fn proxy_port() -> u16 {
    BOUND_PORT.load(Ordering::SeqCst)
}

// ── 出网日志（日志可观测性批 3，2026-10-12）────────────────────────────
//
// 立项理由：2026-09-27 事故里用户报「本地模型（baseUrl http://127.0.0.1:8080/v1）
// 配好了却一直无法调用」，而那份 ui.log 对「请求到底发出去没有、上游回了什么」
// **一个字节都没有**——因为这条链的失败此前只 `eprintln!` 到 stderr：GUI 进程的
// stderr 没人看得见，用户抓不到、也交不出来。
//
// 出口选择（「**失败不静默**」是硬要求）：本代理在 `main.rs` 的 setup 期就起来了，
// 而 bridge.log 的 tracing subscriber 要等工作区打开才装（`logging.rs`）——窗口期内
// `tracing::warn!` 的记录会**静默消失**（无 subscriber = 无人接盘）。故未就绪时回退
// `log` 门面（`.lantai/logs/boot.log`，boot_log.rs 在进程启动期即装上）。诊断时三个
// 文件合并看：boot.log（启动期）+ bridge.log（工作区期）+ ui.log（前端）。
//
// 脱敏：**只记 `host:port`**（协议 / 路径 / query 一律不落盘——query 里可能带 Azure
// 风格的 `?api-key=`），第三方错误原文先过 `scrub_url_query`。凭据头本就不在我们手上。
macro_rules! net_log {
    ($level:ident, $($arg:tt)*) => {{
        let line = format!($($arg)*);
        if crate::logging::bridge_sink_ready() {
            tracing::$level!("{}", line);
        } else {
            log::$level!("{}", line);
        }
    }};
}

/// 目标 URL → `host:port`（**只记这个**）。
/// 刻意走 `Url::parse` 而不是字符串裁剪：userinfo（`https://user:pass@h/v1`）
/// 会被 parser 摘掉，字符串裁剪不会——凭据就是这样漏进日志的。
fn target_host_port(target: &str) -> String {
    match url::Url::parse(target) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => "<no-host>".to_string(),
        },
        Err(_) => "<unparsable>".to_string(),
    }
}

/// 抹掉文本里 URL 的 query（与前端 `obs.ts` 的 REDACTIONS ① 同形同判）。
/// reqwest 的 Display 会带上整条 URL，而 **Rust 侧没有前端那套脱敏门面**——
/// 第三方错误原文落盘前必须过这里。
fn scrub_url_query(s: &str) -> String {
    static URL_QUERY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(https?://[^\s?#<>"']+)\?[^\s"'<>]*"#).expect("URL query 脱敏正则")
    });
    URL_QUERY.replace_all(s, "$1?<redacted>").into_owned()
}

/// 上游回错（4xx/5xx）一行：请求**发出去了**、上游给了答复——这正是「配好了
/// 却调不通」时最该一眼看到的那条（错误码是判据：401 是 Key，404 是路径，
/// 502 是本地端点没起）。
fn upstream_status_line(target: &str, status: u16) -> String {
    format!(
        "[llm_proxy] 上游回错 target={} status={status}",
        target_host_port(target)
    )
}

/// 请求失败（连不上 / 超时 / 中途断流）一行：只带 `host:port` 与脱敏后的原文。
fn upstream_error_line(target: &str, detail: &str) -> String {
    format!(
        "[llm_proxy] 出网失败 target={} err={}",
        target_host_port(target),
        scrub_url_query(detail)
    )
}

/// 在 127.0.0.1 上启动本地代理服务器（后台 tokio 任务）。
/// 幂等：只启动一次；重复调用返回既有端口。
pub fn spawn_llm_proxy() -> u16 {
    if let Some(port) = AVAILABLE_PROXY_PORT.get() {
        return *port;
    }
    // 代理线程进入 run_server 后：绑定成功 → 永不返回（常驻 accept 循环）；
    // 全部端口绑定失败 → 立即返回 0。
    // ⚠️ 不能 join 这个线程：绑定成功的路径 run_server 永不退出，join 会永久
    // 挂起调用方（setup 主线程），App 直接卡死在启动阶段（2026-08-17 修复：
    // 未提交版曾把 spawn_llm_proxy 放进 setup 又 join，任何带代理的构建都无法启动）。
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let done_flag = std::sync::Arc::clone(&done);
    let _rt_thread = std::thread::spawn(move || {
        // 启动即复位停机标志。
        PROXY_SHUTDOWN.store(false, Ordering::SeqCst);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("llm_proxy: tokio runtime build");
        let _port = rt.block_on(run_server());
        // 走到这里只有一种可能：run_server 全部端口绑定失败（返回 0）。
        // BOUND_PORT 保持 0，无需回传端口；置完成标记让主线程停止自旋。
        done_flag.store(true, Ordering::SeqCst);
    });
    // 自旋等端口就绪：成功（BOUND_PORT != 0）立即退出；失败（线程结束）也退出，
    // 不空等满 10 秒。真实端口由 run_server 在 bind 成功后写入 BOUND_PORT。
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < 10 && !done.load(Ordering::SeqCst) {
        let p = BOUND_PORT.load(Ordering::SeqCst);
        if p != 0 {
            let _ = AVAILABLE_PROXY_PORT.set(p);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let p = BOUND_PORT.load(Ordering::SeqCst);
    if p == 0 {
        // 启动失败 — 进程内降级返回 0，调用方应回退到直连（不阻塞用户）。
        net_log!(error, "[llm_proxy] 代理启动失败（端口未就绪）");
        return 0;
    }
    let _ = AVAILABLE_PROXY_PORT.set(p);
    p
}

async fn run_server() -> u16 {
    // 依次尝试若干端口直到 bind 成功（多窗口/重复进程占端口容错）。
    for attempt in 0..8u16 {
        let port = PROXY_PORT + attempt;
        let addr: SocketAddr = loopback_bind_addr(port);
        match TcpListener::bind(addr).await {
            Ok(listener) => {
                BOUND_PORT.store(port, Ordering::SeqCst);
                println!("[llm_proxy] listening on 127.0.0.1:{port}");
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .expect("llm_proxy: reqwest client build");
                serve_listener(&listener, client, &PROXY_SHUTDOWN).await;
                // serve_listener 只在停机标志置位后返回——直接结束，
                // 不得继续 for 循环去 rebind 新端口（否则停机变无限重启）。
                return port;
            }
            Err(e) if attempt < 7 => {
                // ⚠ 这里在**启动期**（main.rs setup）——tracing 尚无 subscriber，
                //   故实际落 boot.log（见 net_log 的出口选择注）。
                net_log!(warn, "[llm_proxy] bind 127.0.0.1:{port} 失败: {e}，尝试下一端口");
            }
            Err(e) => {
                net_log!(error, "[llm_proxy] 无可用端口: {e}");
                return 0;
            }
        }
    }
    0
}

/// 构造仅 loopback 的监听地址——插件资产通道（plugin_assets）安全三件套之一：
/// 绑定保证。测试钉住 loopback 语义（防有人改成 0.0.0.0 暴露插件通道）。
fn loopback_bind_addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// 服务监听器上的连接（常驻 accept 循环，200ms 间隔轮询停机标志）。
/// 供生产 run_server 与集成测试复用；测试可传入私有标志避免全局串扰。
/// pub(crate)：plugin_assets 的 HTTP 端到端测试复用同一监听器。
pub(crate) async fn serve_listener(listener: &TcpListener, client: reqwest::Client, shutdown: &AtomicBool) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            net_log!(info, "[llm_proxy] shutdown flag set, exiting accept loop");
            break;
        }
        // 200ms 超时轮询：无连接时也要醒来检查停机标志。
        match tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept()).await {
            Ok(Ok((stream, _peer))) => {
                let io = TokioIo::new(stream);
                let client = client.clone();
                tokio::task::spawn(async move {
                    let svc = service_fn(move |req| handle(client.clone(), req));
                    let _ = http1::Builder::new()
                        .serve_connection(io, svc)
                        .with_upgrades()
                        .await;
                });
            }
            Ok(Err(_)) => continue,
            Err(_) => continue, // accept 超时 → 回到循环头检查停机标志
        }
    }
}

/// 转发真实 LLM 调用。
async fn handle(client: reqwest::Client, req: Request<Incoming>) -> Result<Response<BoxBody>, Infallible> {
    let resp = handle_inner(client, req).await;
    Ok(resp)
}

pub(crate) type BoxBody = http_body_util::combinators::BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

async fn handle_inner(client: reqwest::Client, req: Request<Incoming>) -> Response<BoxBody> {
    // CORS 预检
    if req.method() == Method::OPTIONS {
        return cors_response(StatusCode::NO_CONTENT, Bytes::new());
    }
    if req.method() != Method::POST && req.method() != Method::GET {
        return err_response(StatusCode::METHOD_NOT_ALLOWED, "proxy: 仅支持 GET / POST / OPTIONS");
    }
    // 插件静态资源通道（WO-S0B）：GET /plugins/* 由 plugin_assets 模块服务。
    // 必须在 x-hologram-target 检查之前——静态请求不带该头（WO-S0A spike 立此规矩；
    // 假设已证实：webview 可从此通道动态 import ES module）。
    if let Some(path) = req.uri().path().strip_prefix("/plugins/") {
        if req.method() == Method::GET {
            return crate::plugin_assets::serve_plugin_path(path).await;
        }
        return crate::plugin_assets::method_not_allowed();
    }
    // 组合 patch 通道（S2-2 + S4-0 preset 域扩展）：GET /composition/* 服务
    // ~/.lantai/composition/ 下的用户层 roster.patch.yml、presets/ 目录
    // 索引与 preset 文件——安全三件套与插件通道同一套（resolve_asset
    // 逐段拒绝 + canonicalize 前缀 + 仅 GET + loopback 绑定天然保证）。
    if let Some(path) = req.uri().path().strip_prefix("/composition/") {
        if req.method() == Method::GET {
            return crate::plugin_assets::serve_composition_path(path).await;
        }
        return crate::plugin_assets::method_not_allowed();
    }
    // 先在消费 body 前取出 method / target / 业务头（into_body 会 move req）
    let method = req.method().clone();
    let target = match req.headers().get("x-hologram-target").and_then(|v| v.to_str().ok()) {
        Some(t) if validate_target(t) => t.to_string(),
        _ => return err_response(StatusCode::BAD_REQUEST, "proxy: 缺少或非法 x-hologram-target"),
    };
    let passthrough_headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str().to_ascii_lowercase();
            match name.as_str() {
                "x-hologram-target" | "host" | "content-length" | "connection" | "keep-alive"
                | "transfer-encoding" | "upgrade" | "proxy-connection" | "te" => None,
                _ => v.to_str().ok().map(|s| (k.as_str().to_string(), s.to_string())),
            }
        })
        .collect();

    // 读取请求体（仅 POST；GET 无体）
    let body_bytes = if method == Method::POST {
        match req.into_body().collect().await {
            Ok(col) => col.to_bytes(),
            Err(_) => return err_response(StatusCode::BAD_REQUEST, "proxy: 读取请求体失败"),
        }
    } else {
        Bytes::new()
    };
    if body_bytes.len() > MAX_BODY_BYTES {
        return err_response(StatusCode::PAYLOAD_TOO_LARGE, "proxy: 请求体超过 64MB 上限");
    }

    // 透传内容类型 / 授权等业务头（跳过 hop-by-hop + 我们的目标头）
    let method = reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut builder = client.request(method.clone(), &target);
    for (k, v) in passthrough_headers {
        builder = builder.header(k, v);
    }
    if method == reqwest::Method::POST {
        builder = builder.body(body_bytes.to_vec());
    }
    let outbound = builder.send().await;

    match outbound {
        Ok(upstream) => {
            let status = upstream.status();
            // 上游回错留痕（批 3）：请求**发出去了**、上游给了答复——「配好了却
            // 调不通」时这一行 + 前端 llm.error 就是完整答案（谁拒的、什么码）。
            if status.is_client_error() || status.is_server_error() {
                net_log!(warn, "{}", upstream_status_line(&target, status.as_u16()));
            }
            // 透传上游响应头（同样去掉 hop-by-hop）
            let mut rb = Response::builder().status(status);
            for (k, v) in upstream.headers().iter() {
                let name = k.as_str().to_ascii_lowercase();
                if matches!(
                    name.as_str(),
                    "connection" | "keep-alive" | "transfer-encoding" | "upgrade" | "proxy-connection" | "te"
                ) {
                    continue;
                }
                // ⚠️ 上游自带的 CORS 头**一律不透传**（2026-09-23 实测事故，见下
                // `upstream_cors_headers_are_not_duplicated`）：上游若返回
                // `Access-Control-Allow-Origin`，原样透传后再由下面追加本代理的一套
                // ⇒ 响应里出现两个 ACAO，浏览器按 CORS 规范判「multiple values '*, *'」
                // 并**拒收整条响应**（请求其实 200 到过，前端只看到 Failed to fetch）。
                // 实测受害者：`api.commandcode.ai/provider/v1/models` 与
                // `opencode.ai/zen/go/v1/models` 都自带 ACAO ⇒ 凡经代理的调用必失败，
                // 回退直连又被自定义头（`x-opencode-session`）的上游预检拦下 ⇒
                // 设置页「刷新目录」永远失败。CORS 策略归本代理独占（只服务 loopback）。
                if name.starts_with("access-control-") {
                    continue;
                }
                if let Ok(s) = v.to_str() {
                    rb = rb.header(k.as_str(), s);
                }
            }
            // 强制 CORS + 透传 SSE 内容类型。
            // access-control-allow-private-network 兼容 WebView2/Chrome 的
            // Private Network Access 预检（否则 http://127.0.0.1 代理可能被拦）。
            rb = rb
                .header("access-control-allow-origin", "*")
                .header("access-control-allow-methods", "GET, POST, OPTIONS")
                .header("access-control-allow-headers", "*")
                .header("access-control-allow-private-network", "true")
                .header("access-control-expose-headers", "x-hologram-proxy-error");
            // 中途断流也要留痕（批 3）：SSE 半路断掉在用户侧的表现是「答到一半停了」，
            // 而这条此前完全不可见（前端只看到 fetch 抛错）。
            let tgt = target_host_port(&target);
            let body = StreamBody::new(upstream.bytes_stream().map(move |r| {
                r.map(|bytes| hyper::body::Frame::data(bytes))
                    .map_err(|e| {
                        net_log!(warn, "{}", upstream_error_line(&tgt, &e.to_string()));
                        Box::new(e) as Box<dyn std::error::Error + Send + Sync>
                    })
            }));
            // 显式调 BodyExt::boxed —— StreamBody 也实现了 Stream，`.boxed()` 会被
            // StreamExt::boxed 劫持（返回 Pin<Box<dyn Stream>>），必须指名 Body 装箱。
            rb.body(http_body_util::BodyExt::boxed(body))
                .unwrap_or_else(|_| err_response(StatusCode::BAD_GATEWAY, "proxy: 响应构造失败"))
        }
        Err(e) => {
            // 出网失败留痕（批 3）：连不上 / 超时 / DNS 错——原文经 scrub_url_query
            // 削掉 query（reqwest 的 Display 会带上整条 URL，可能含 `?api-key=`）。
            net_log!(error, "{}", upstream_error_line(&target, &e.to_string()));
            err_response(StatusCode::BAD_GATEWAY, &format!("proxy: 目标请求失败: {e}"))
        }
    }
}

/// 目标 URL 校验：必须是绝对 http/https（允许本地端点），拒绝其它协议。
fn validate_target(t: &str) -> bool {
    match url::Url::parse(t) {
        Ok(u) => matches!(u.scheme(), "http" | "https"),
        Err(_) => false,
    }
}

fn cors_response(status: StatusCode, body: Bytes) -> Response<BoxBody> {
    Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "*")
        .header("access-control-allow-private-network", "true")
        .header("access-control-expose-headers", "x-hologram-proxy-error")
        .body(full_boxed(body))
        .unwrap_or_else(|_| err_response(StatusCode::INTERNAL_SERVER_ERROR, "proxy: 构造 CORS 响应失败"))
}

/// 把 `Full<Bytes>`（Infallible 错误）装箱为统一 BoxBody。
/// pub(crate)：plugin_assets 模块复用同一响应类型。
pub(crate) fn full_boxed(data: Bytes) -> BoxBody {
    Full::new(data)
        .map_err(|never| match never { /* Infallible —— 不可达 */ })
        .boxed()
}

/// pub(crate)：plugin_assets 模块作为响应构造失败时的兜底复用。
pub(crate) fn err_response(status: StatusCode, msg: &str) -> Response<BoxBody> {
    Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "*")
        .header("access-control-allow-private-network", "true")
        .header("access-control-expose-headers", "x-hologram-proxy-error")
        .header("x-hologram-proxy-error", "1")
        .header("content-type", "text/plain; charset=utf-8")
        .body(full_boxed(Bytes::copy_from_slice(msg.as_bytes())))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(full_boxed(Bytes::new()))
                .unwrap()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_url_validation_accepts_http_https_and_localhost() {
        assert!(validate_target("https://api.openai.com/v1/chat/completions"));
        assert!(validate_target("http://localhost:11434/v1/chat/completions"));
        assert!(validate_target("http://127.0.0.1:8080/v1"));
        assert!(!validate_target("file:///etc/passwd"));
        assert!(!validate_target("data:text/plain,hi"));
        assert!(!validate_target("ftp://example.com"));
        assert!(!validate_target("not a url"));
        assert!(!validate_target(""));
    }

    /// 出网留痕只带 `host:port`（批 3）：协议 / 路径 / query 一律不落盘。
    /// userinfo 形态（`https://user:pass@h/v1`）必须被摘掉——这是「字符串裁剪」
    /// 与「parser 取值」的差别的实测点。
    #[test]
    fn target_host_port_keeps_host_and_port_only() {
        assert_eq!(
            target_host_port("https://api.example.com/v1/chat/completions?api-key=SK-LEAK0123"),
            "api.example.com"
        );
        assert_eq!(target_host_port("http://127.0.0.1:8080/v1"), "127.0.0.1:8080");
        assert_eq!(target_host_port("http://localhost:11434/v1/chat"), "localhost:11434");
        assert_eq!(target_host_port("https://user:pass@api.example.com/v1"), "api.example.com");
        assert_eq!(target_host_port("not a url"), "<unparsable>");
    }

    /// 第三方错误原文里的 URL query 必须先削掉（前端 obs.ts 同判）——
    /// reqwest 的 Display 会带上整条 URL，而 Rust 侧没有那套脱敏门面。
    #[test]
    fn scrub_url_query_never_leaks_credentials_in_query() {
        let raw = "error sending request for url (https://api.example.com/v1?api-key=SK-LEAK0123): connection refused";
        let out = scrub_url_query(raw);
        assert!(!out.contains("SK-LEAK0123"), "query 里的凭据不得落盘: {out}");
        assert!(out.contains("https://api.example.com/v1?<redacted>"), "URL 主体与后续文本要保留: {out}");
        assert!(out.contains("connection refused"));
        // 无 URL / 无 query 的文本一字不改
        assert_eq!(scrub_url_query("connection refused"), "connection refused");
        assert_eq!(
            scrub_url_query("https://api.example.com/v1/chat"),
            "https://api.example.com/v1/chat"
        );
    }

    /// 两行留痕的字段面：**target 只带 `host:port`**、status 带码；错误原文按前端同判
    /// 只削 query（路径保留——404 判别要看它，且路径不是凭据）。
    #[test]
    fn upstream_lines_carry_target_and_status_without_secrets() {
        let line = upstream_error_line(
            "http://127.0.0.1:8080/v1/chat?api-key=SK-LEAK0123",
            "error sending request for url (http://127.0.0.1:8080/v1/chat?api-key=SK-LEAK0123)",
        );
        assert!(line.contains("target=127.0.0.1:8080"), "{line}");
        assert!(!line.contains("SK-LEAK0123"), "query 里的凭据不得落盘: {line}");
        assert!(line.contains("?<redacted>"), "{line}");

        let status_line = upstream_status_line("https://api.deepseek.com/v1/chat/completions", 401);
        assert!(status_line.contains("target=api.deepseek.com"), "{status_line}");
        assert!(status_line.contains("status=401"), "{status_line}");
        assert!(!status_line.contains("/v1/chat"), "target 字段不落路径: {status_line}");
    }

    /// 端到端：本地代理把上游 SSE 流式透传给调用方（模拟 provider 流式对话）。
    /// 证明 CORS 绕开 + SSE 透传在真实 HTTP 栈上成立。
    /// 在测试自己的 multi-thread runtime 上驱动代理，避免跨 runtime 死锁。
    #[test]
    fn proxy_streams_sse_end_to_end() {
        use std::io::{Read, Write};

        // 普通 TCP 上游：返回固定两段 SSE。
        let upstream = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = upstream.local_addr().unwrap();
        let upstream_thread = std::thread::spawn(move || {
            use std::io::Read;
            let (mut sock, _) = upstream.accept().unwrap();
            // 真实服务器：先读完请求（头 + 2 字节 body），再响应，避免连接中断。
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: [DONE]\n\n";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
            sock.flush().unwrap();
        });

        // 测试自有的 multi-thread runtime：起代理 server + 并发的客户端探测。
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_addr = listener.local_addr().unwrap();
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();

            // 代理 server 常驻 accept（私有标志永不复位，保证本测试不受停机逻辑干扰）
            let shutdown = std::sync::atomic::AtomicBool::new(false);
            let server_handle = tokio::spawn(async move { serve_listener(&listener, client, &shutdown).await });

            // 客户端：等代理就绪后发请求并读响应（带读取超时防挂）
            let ctrl = std::net::TcpStream::connect(proxy_addr).unwrap();
            let mut probe = ctrl.try_clone().unwrap();
            probe
                .set_read_timeout(Some(std::time::Duration::from_secs(8)))
                .unwrap();
            let req = format!(
                "POST /proxy HTTP/1.1\r\nHost: {proxy_addr}\r\nx-hologram-target: http://{target_addr}/v1/chat\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
            );
            probe.write_all(req.as_bytes()).unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            let read_res = probe.read_to_string(&mut buf);
            assert!(read_res.is_ok(), "代理读取超时/失败: {read_res:?} 已收: {buf}");

            assert!(buf.starts_with("HTTP/1.1 200"), "上游 200 应透传: {buf}");
            assert!(buf.contains("data: {\"a\":1}"), "SSE 第一段必须透传: {buf}");
            assert!(buf.contains("data: {\"b\":2}"), "SSE 第二段必须透传: {buf}");
            assert!(buf.contains("[DONE]"), "SSE [DONE] 必须透传");

            server_handle.abort();
        });
        upstream_thread.join().unwrap();
    }

    /// ⚠️ 上游自带 CORS 头不得与本代理的 CORS 头叠加（2026-09-23 实测事故）。
    ///
    /// 浏览器按 CORS 规范拒收「`Access-Control-Allow-Origin` 有两个值」的响应
    /// （`'*, *'`）——请求明明 200 到过，前端只看到 `Failed to fetch`。实测两端点
    /// （`api.commandcode.ai/provider/v1/models`、`opencode.ai/zen/go/v1/models`）
    /// 都自带 ACAO ⇒ 经代理的每次调用必失败，回落直连又被上游预检拦下 ⇒
    /// 设置页「刷新目录」永远失败。本测试在真实 HTTP 栈上钉住：ACAO 恒只有一条。
    #[test]
    fn upstream_cors_headers_are_not_duplicated() {
        use std::io::{Read, Write};

        // 上游：一条 GET /models 响应，自带上游那套 CORS 头（ACAO + credentials + expose）。
        let upstream = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = upstream.local_addr().unwrap();
        let upstream_thread = std::thread::spawn(move || {
            let (mut sock, _) = upstream.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = "{\"object\":\"list\",\"data\":[]}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                 Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Credentials: true\r\n\
                 Access-Control-Expose-Headers: x-upstream-thing\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
            sock.flush().unwrap();
        });

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_addr = listener.local_addr().unwrap();
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let shutdown = std::sync::atomic::AtomicBool::new(false);
            let server_handle = tokio::spawn(async move { serve_listener(&listener, client, &shutdown).await });

            let mut probe = std::net::TcpStream::connect(proxy_addr).unwrap();
            probe
                .set_read_timeout(Some(std::time::Duration::from_secs(8)))
                .unwrap();
            let req = format!(
                "GET /proxy HTTP/1.1\r\nHost: {proxy_addr}\r\nx-hologram-target: http://{target_addr}/v1/models\r\nconnection: close\r\n\r\n"
            );
            probe.write_all(req.as_bytes()).unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            let read_res = probe.read_to_string(&mut buf);
            assert!(read_res.is_ok(), "代理读取超时/失败: {read_res:?} 已收: {buf}");

            let lower = buf.to_ascii_lowercase();
            assert!(buf.starts_with("HTTP/1.1 200"), "上游 200 应透传: {buf}");
            assert!(lower.contains("{\"object\":\"list\""), "响应体必须透传: {buf}");
            assert_eq!(
                lower.matches("access-control-allow-origin").count(),
                1,
                "ACAO 只能有一条（两条 = 浏览器判 '*, *' 拒收整条响应）: {buf}"
            );
            assert!(
                lower.contains("access-control-allow-origin: *"),
                "本代理自己的 CORS 头必须还在: {buf}"
            );
            assert!(
                !lower.contains("access-control-allow-credentials")
                    && !lower.contains("access-control-expose-headers: x-upstream-thing"),
                "上游 CORS 头一律不得透传（凭据头与 '*' 冲突、expose 名单也不归上游）: {buf}"
            );
            assert!(
                lower.contains("access-control-expose-headers: x-hologram-proxy-error"),
                "本代理的 expose 头必须还在: {buf}"
            );

            server_handle.abort();
        });
        upstream_thread.join().unwrap();
    }

    /// 代理自身的错误响应必须带 x-hologram-proxy-error 标记，前端据此回退直连；
    /// 同时携带 Private Network Access 允许头，兼容 WebView2/Chrome 的本地代理预检。
    #[test]
    fn err_response_marks_proxy_error_and_allows_private_network() {
        let resp = err_response(StatusCode::BAD_GATEWAY, "proxy: boom");
        assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            resp.headers().get("x-hologram-proxy-error").and_then(|v| v.to_str().ok()),
            Some("1")
        );
        assert_eq!(
            resp.headers().get("access-control-allow-private-network").and_then(|v| v.to_str().ok()),
            Some("true")
        );
        assert_eq!(
            resp.headers().get("access-control-expose-headers").and_then(|v| v.to_str().ok()),
            Some("x-hologram-proxy-error")
        );
    }

    /// 停机标志置位后 serve_listener 必须在 ≤1s 内退出。
    /// 回归：退出流程 std::process::exit(0) 会撞上仍活着的 hyper/reqwest
    /// 网络线程（Winsock I/O 与 ExitProcess 竞争 → 0x40000015 弹窗）。
    #[test]
    fn serve_listener_exits_when_shutdown_flag_set() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = reqwest::Client::builder().build().unwrap();
            // 私有标志（非全局 PROXY_SHUTDOWN）：测试隔离，避免并行测试串扰。
            let shutdown = std::sync::atomic::AtomicBool::new(true);
            let res = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                serve_listener(&listener, client, &shutdown),
            )
            .await;
            assert!(
                res.is_ok(),
                "serve_listener 必须在停机标志置位后退出（防 exit(0) 撞网络线程）"
            );
        });
    }

    /// WO-S0B：插件资产通道的 loopback 绑定保证（安全三件套之一）。
    #[test]
    fn loopback_bind_addr_pins_plugin_channel_to_127_0_0_1() {
        for port in [14570u16, 14571, 0] {
            assert!(loopback_bind_addr(port).ip().is_loopback(), "插件资产通道必须只绑 loopback");
        }
    }
}
