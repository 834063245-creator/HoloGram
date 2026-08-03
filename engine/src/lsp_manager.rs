// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # LSP 管理器 —— 长生命周期的 LSP 服务器池
//!
//! 用于按需解析函数调用关系。
//!
//! ## 架构
//! ```text
//! LspManager（惰性单例）→ ServerPool → 每种语言一个 LSP 进程
//! 每个服务器：通过 stdio JSON-RPC 通信，首次使用时启动，永久存活
//! ```
//!
//! ## 生命周期
//! - 索引完成 → `pool.warm(project_root)` → 后台启动所有服务器
//! - Agent 查询 → `pool.resolve(file, l, c)` → JSON-RPC textDocument/definition
//! - UI 影响范围 → `pool.references(file, l, c)` → JSON-RPC textDocument/references
//!
//! ## 降级策略
//! 如果服务器无法启动（未安装 / spawn 失败 / 超时），
//! 透明降级到现有的手写适配器。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use serde_json::{json, Value};

// ═══════════════════════════════════════════════════════════════
// LSP 服务器进程句柄
// ═══════════════════════════════════════════════════════════════

/// 默认 LSP 请求超时时间。
/// ponytail: 曾为 30s。typescript-language-server 在这台机器上
/// 初始化后 references 请求 30s 不响应（服务器侧环境问题），
/// 导致工具调用卡死 30s 才 fallback。降到 5s 快速失败 ——
/// LSP 可用时 5s 足够（本地语言服务器响应毫秒级），
/// 不可用时避免长时间阻塞用户。
const LSP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 单个 LSP 服务器进程的句柄。
///
/// 持有子进程的 stdin/stdout/stderr，维护自增的请求 ID，
/// 通过 LSP Content-Length 帧协议读写 JSON-RPC 消息。
struct LspProcess {
    process: Child,
    /// Arc<Mutex> 包装：读响应线程也需要写回复
    /// （服务器发来的 workspace/configuration 等请求必须回 null，
    ///   否则服务器阻塞、后续所有查询排队超时）。
    stdin: Arc<Mutex<ChildStdin>>,
    reader: Option<BufReader<std::process::ChildStdout>>,
    #[allow(dead_code)]
    stderr: Option<std::process::ChildStderr>,
    next_id: u64,
    timeout: std::time::Duration,
}

impl LspProcess {
    /// 以 LSP Content-Length 帧协议写一条完整消息。
    /// 静态版本供读线程（无 &self）回复服务器请求使用。
    fn write_message_static(stdin: &Arc<Mutex<ChildStdin>>, body: &str) -> Result<(), String> {
        let mut stdin = stdin.lock().map_err(|e| format!("stdin lock: {}", e))?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        stdin.write_all(header.as_bytes()).map_err(|e| format!("write: {}", e))?;
        stdin.write_all(body.as_bytes()).map_err(|e| format!("write body: {}", e))?;
        stdin.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    fn write_message(&self, body: &str) -> Result<(), String> {
        Self::write_message_static(&self.stdin, body)
    }

    /// 发送 JSON-RPC 请求并等待响应。
    ///
    /// LSP 服务器会在请求/响应周期之间异步发送诊断和日志通知——
    /// 这些消息会被跳过，只等待与请求 id 匹配的响应。
    ///
    /// 使用独立线程读取响应以实现超时控制。
    /// 超时后 reader 丢失，下次调用会触发 get_or_warm_server 重建进程。
    fn send_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let body = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        self.write_message(&body)?;

        // 在独立线程中读取响应以实现超时控制
        // LSP 服务器会异步发送诊断/日志通知——跳过这些，等待匹配 id 的响应
        let mut reader = self.reader.take()
            .ok_or("LSP reader lost (previous call timed out) — server will be recreated")?;
        // 读线程需要写回复（服务器发来的请求），克隆 stdin 句柄
        let stdin_for_thread = self.stdin.clone();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = loop {
                match Self::read_one_message(&mut reader) {
                    Ok((resp_id, response)) => {
                        if resp_id == Some(id) {
                            if let Some(err) = response.get("error") {
                                break Err(format!("LSP error: {}", err));
                            }
                            break Ok(response);
                        }
                        // 服务器发来的请求（有 id + method 字段，如
                        // workspace/configuration、client/registerCapability）——
                        // 必须回复 null 空结果，否则服务器阻塞等待，
                        // 我们后续的查询全部排队超时。
                        if let Some(req_id) = resp_id {
                            if response.get("method").and_then(|m| m.as_str()).is_some() {
                                let reply = json!({"jsonrpc": "2.0", "id": req_id, "result": null});
                                if let Ok(reply_body) = serde_json::to_string(&reply) {
                                    if let Err(e) = Self::write_message_static(&stdin_for_thread, &reply_body) {
                                        tracing::debug!(err = %e, "[lsp_manager] failed to reply to server request");
                                    }
                                }
                                continue;
                            }
                        }
                        // 通知或过期响应 → 跳过
                    }
                    Err(e) => break Err(format!("LSP read error: {}", e)),
                }
            };
            let _ = tx.send((reader, result));
        });

        match rx.recv_timeout(self.timeout) {
            Ok((reader_back, result)) => {
                self.reader = Some(reader_back);
                result
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 线程仍然存活但我们不再等待
                // reader 已丢失——下次调用失败 → get_or_warm_server 重建
                Err(format!(
                    "LSP timeout after {:?} waiting for {}(id {})",
                    self.timeout, method, id,
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("LSP reader thread panicked".to_string())
            }
        }
    }

    /// 发送通知消息（无 id，不期望响应）。
    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let notif = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let body = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
        self.write_message(&body)
    }

    /// 读取单条 JSON-RPC 消息并返回 (id, body)。
    ///
    /// 设为 static 方法以便在超时线程中调用而无需借用 self。
    /// 解析 LSP 帧协议：扫描 "Content-Length: N\r\n\r\n" 定界，
    /// 然后精确读取 N 字节 body。
    ///
    /// ponytail: 曾用 read_line 逐行读 header，但服务器可能一次
    /// write 粘连多条消息（帧+帧），且 JSON body 内可能含 \n，
    /// read_line 行边界会错位 → body 读进帧头（曾出现 body 开头是
    /// "Content-Length: 185\r\n\r\n{...}" 的 parse 错误）。
    /// 改按字节流扫描定界符，帧边界精确。
    fn read_one_message(reader: &mut BufReader<std::process::ChildStdout>) -> Result<(Option<u64>, Value), String> {
        use std::io::Read;
        // 扫描 header 直到 "\r\n\r\n"，收集 Content-Length。
        let mut header = Vec::with_capacity(256);
        let mut content_length: Option<usize> = None;
        loop {
            let mut byte = [0u8; 1];
            reader.read_exact(&mut byte).map_err(|e| format!("read header: {}", e))?;
            header.push(byte[0]);
            // 检测 "\r\n\r\n" 结尾（header 结束）
            let hlen = header.len();
            if hlen >= 4 && &header[hlen - 4..] == b"\r\n\r\n" {
                break;
            }
            // 防御：header 过长（>8KB）说明协议错乱，避免无限读
            if hlen > 8192 {
                return Err(format!("header too long ({} bytes)", hlen));
            }
        }
        // 从 header 中解析 Content-Length（大小写不敏感、容忍空格）
        let header_text = String::from_utf8_lossy(&header);
        for line in header_text.split("\r\n") {
            let lower = line.trim().to_lowercase();
            if let Some(val) = lower.strip_prefix("content-length:") {
                content_length = val.trim().parse().ok();
            }
        }
        let len = content_length.ok_or_else(|| format!("missing Content-Length in header: {:?}", header_text))?;
        let mut body_buf = vec![0u8; len];
        reader.read_exact(&mut body_buf).map_err(|e| format!("read body: {}", e))?;
        let msg: Value = serde_json::from_slice(&body_buf).map_err(|e| {
            // 把原始字节带进错误消息 — 定位"服务器发了非 JSON 内容"
            //（typescript-language-server 曾把日志/横幅混进 stdout）。
            let raw = String::from_utf8_lossy(&body_buf[..len.min(200)]);
            format!("parse: {} raw={:?}", e, raw)
        })?;
        let id = msg.get("id").and_then(|v| v.as_u64());
        Ok((id, msg))
    }

    /// LSP initialize 握手：发送 initialize 请求 + initialized 通知。
    ///
    /// 声明客户端能力（definition、references、hover），
    /// 等待服务器返回能力声明后发送 initialized 通知。
    fn initialize(&mut self, root: &str) -> Result<(), String> {
        let params = json!({
            "processId": std::process::id(),
            "rootUri": format!("file:///{}", root.replace('\\', "/")),
            "workspaceFolders": [{
                "uri": format!("file:///{}", root.replace('\\', "/")),
                "name": "project"
            }],
            "capabilities": {
                "textDocument": {
                    "definition": { "linkSupport": true },
                    "references": {},
                    "hover": {},
                },
            },
        });
        let resp = self.send_request("initialize", params)
            .map_err(|e| {
                // 尝试读取 stderr 以获取诊断信息
                let mut extra = String::new();
                if let Some(ref mut stderr) = self.stderr {
                    let mut buf = [0u8; 512];
                    use std::io::Read;
                    if let Ok(n) = stderr.read(&mut buf) {
                        if n > 0 {
                            extra = format!(" stderr: {}", String::from_utf8_lossy(&buf[..n]).trim());
                        }
                    }
                }
                format!("{}{}", e, extra)
            })?;
        let _capabilities = resp.get("result").ok_or("no capabilities")?;

        // initialized 是通知，不是请求
        self.send_notification("initialized", json!({}))?;

        // 排空初始化后的诊断/日志通知
        // 100ms 应该足够等待启动消息
        std::thread::sleep(std::time::Duration::from_millis(100));

        Ok(())
    }

    /// 通知服务器打开文件（textDocument/didOpen）。
    fn open_file(&mut self, uri: &str, text: &str, language: &str) -> Result<(), String> {
        // didOpen 是通知——无 id，不期望响应
        self.send_notification("textDocument/didOpen", json!({
            "textDocument": {
                "uri": uri,
                "languageId": language,
                "version": 1,
                "text": text,
            }
        }))
    }

    /// 查询指定位置的定义（textDocument/definition）。
    fn definition(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/definition", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }

    /// 查询指定位置的实现（textDocument/implementation）。
    ///
    /// 用于查找接口/trait 的所有具体实现。
    fn implementation(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/implementation", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }

    /// 查询指定位置的悬停信息（textDocument/hover）。
    ///
    /// 用于获取类型信息、文档等。
    fn hover(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<String, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/hover", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        if result.is_null() {
            return Ok(String::new());
        }
        // hover 结果格式: { contents: MarkupContent | MarkedString | MarkedString[] }
        let contents = result.get("contents").cloned().unwrap_or(Value::Null);
        match contents {
            Value::String(s) => Ok(s),
            Value::Object(ref m) => m.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or("no hover value".into()),
            Value::Array(ref arr) => {
                // MarkedString[] —— 取第一个带语言标签的
                for item in arr {
                    if let Some(s) = item.as_str() { return Ok(s.to_string()); }
                    if let Some(v) = item.get("value").and_then(|v| v.as_str()) { return Ok(v.to_string()); }
                }
                Ok(String::new())
            }
            _ => Ok(String::new()),
        }
    }

    /// 查询指定位置符号的所有引用（textDocument/references）。
    ///
    /// 用于 UI 的影响范围分析。
    fn references(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
            "context": {"includeDeclaration": false},
        });
        let resp = self.send_request("textDocument/references", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }
}

impl Drop for LspProcess {
    fn drop(&mut self) {
        // 尝试优雅关闭：发送 shutdown 请求后 kill 进程
        let _ = self.write_message(
            json!({"jsonrpc":"2.0","method":"shutdown","params":null}).to_string().as_ref(),
        );
        let _ = self.process.kill();
    }
}

// ═══════════════════════════════════════════════════════════════
// 位置解析
// ═══════════════════════════════════════════════════════════════

/// LSP 位置信息：URI + 范围（起止行列）。
#[derive(Debug, Clone)]
pub struct LspLocation {
    pub uri: String,
    pub range_start_line: u32,
    pub range_start_char: u32,
    pub range_end_line: u32,
    pub range_end_char: u32,
}

/// 将 file:/// URI 转换为绝对路径。
///
/// 在 Windows 上将正斜杠转回反斜杠。
pub fn uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file:///")
        .unwrap_or(uri)
        .replace('/', if cfg!(windows) { "\\" } else { "/" })
}

/// 解析 definition/references 的返回结果。
///
/// LSP 返回格式可能是：
/// - null（无结果）
/// - 单个 Location `{uri, range}`
/// - Location 数组 `[{uri, range}, ...]`
/// - LocationLink 数组 `[{targetUri, targetRange, ...}, ...]`
/// - 单个 LocationLink
fn parse_definition_results(value: &Value) -> Result<Vec<LspLocation>, String> {
    if value.is_null() {
        return Ok(vec![]);
    }
    // LocationLink[] —— 含 targetUri + targetRange
    if let Some(arr) = value.as_array() {
        if let Some(first) = arr.first() {
            if first.get("targetUri").is_some() {
                return arr.iter().map(parse_location_link).collect();
            }
        }
        return arr.iter().map(parse_one_location).collect();
    }
    // 单个 Location
    if value.get("uri").is_some() {
        return Ok(vec![parse_one_location(value)?]);
    }
    // 单个 LocationLink
    if value.get("targetUri").is_some() {
        return Ok(vec![parse_location_link(value)?]);
    }
    Ok(vec![])
}

/// 解析 LocationLink（含 targetUri + targetSelectionRange/targetRange）。
fn parse_location_link(v: &Value) -> Result<LspLocation, String> {
    let uri = v.get("targetUri").and_then(|u| u.as_str()).ok_or("missing targetUri")?.to_string();
    let range = v.get("targetSelectionRange").or(v.get("targetRange")).ok_or("missing range")?;
    parse_range(uri, range)
}

/// 解析单个 Location（含 uri + range）。
fn parse_one_location(v: &Value) -> Result<LspLocation, String> {
    let uri = v.get("uri").and_then(|u| u.as_str()).ok_or("missing uri")?.to_string();
    let range = v.get("range").ok_or("missing range")?;
    parse_range(uri, range)
}

/// 从 range JSON 中提取起止行列，构造 LspLocation。
fn parse_range(uri: String, range: &Value) -> Result<LspLocation, String> {
    let start = range.get("start").ok_or("missing start")?;
    let end = range.get("end").unwrap_or(start);
    Ok(LspLocation {
        uri,
        range_start_line: start.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
        range_start_char: start.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
        range_end_line: end.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
        range_end_char: end.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
    })
}

// ═══════════════════════════════════════════════════════════════
// 每种语言的 LSP 服务器配置
// ═══════════════════════════════════════════════════════════════

/// 单种语言的 LSP 服务器配置。
struct LspServerConfig {
    /// 启动命令（如 "rust-analyzer"）
    command: &'static str,
    /// 命令行参数
    args: &'static [&'static str],
    /// LSP 语言 ID（如 "rust"、"python"）
    language_id: &'static str,
    /// 此服务器处理的文件扩展名
    extensions: &'static [&'static str],
    /// 标记正确工作区根目录的配置文件。
    /// 如果在项目根目录下未找到，则搜索一级子目录，
    /// 使用第一个匹配项的父目录作为 rootUri。
    config_marker: &'static [&'static str],
}

/// 所有支持的 LSP 服务器配置表。
///
/// 覆盖 9 种语言：Rust、Go、Python、TypeScript/JavaScript、C/C++、Java、C#、PHP、Kotlin。
const SERVER_CONFIGS: &[LspServerConfig] = &[
    LspServerConfig {
        command: "rust-analyzer",
        args: &[],
        language_id: "rust",
        extensions: &["rs"],
        config_marker: &["Cargo.toml"],
    },
    LspServerConfig {
        command: "gopls",
        args: &[],
        language_id: "go",
        extensions: &["go"],
        config_marker: &["go.mod"],
    },
    LspServerConfig {
        command: "pyright-langserver",
        args: &["--stdio"],
        language_id: "python",
        extensions: &["py", "pyi"],
        config_marker: &["pyproject.toml", "setup.py", "setup.cfg"],
    },
    LspServerConfig {
        command: "typescript-language-server",
        args: &["--stdio"],
        language_id: "typescript",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        config_marker: &["tsconfig.json", "jsconfig.json"],
    },
    LspServerConfig {
        command: "clangd",
        args: &[],
        language_id: "cpp",
        extensions: &["c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx"],
        config_marker: &["compile_commands.json", "CMakeLists.txt", "Makefile"],
    },
    LspServerConfig {
        command: "jdtls",
        args: &[],
        language_id: "java",
        extensions: &["java"],
        config_marker: &["pom.xml", "build.gradle", "build.gradle.kts"],
    },
    LspServerConfig {
        command: "omnisharp",
        args: &["--languageserver"],
        language_id: "csharp",
        extensions: &["cs"],
        config_marker: &["*.sln", "*.csproj"],
    },
    LspServerConfig {
        command: "intelephense",
        args: &["--stdio"],
        language_id: "php",
        extensions: &["php"],
        config_marker: &["composer.json"],
    },
    LspServerConfig {
        command: "kotlin-language-server",
        args: &[],
        language_id: "kotlin",
        extensions: &["kt", "kts"],
        config_marker: &["build.gradle.kts", "settings.gradle.kts"],
    },
];

// ═══════════════════════════════════════════════════════════════
// 服务器池
// ═══════════════════════════════════════════════════════════════

/// 服务器池类型：命令名 → LSP 进程的 Arc<Mutex<Option<>>>。
///
/// Option<None> 表示进程已失败/被销毁，需要重建。
type PoolMap = HashMap<&'static str, Arc<Mutex<Option<LspProcess>>>>;

/// LSP 管理器：全局单例，管理所有语言的 LSP 服务器进程。
///
/// 使用 RwLock 保护内部状态，支持并发读取。
/// 通过 `LspManager::global()` 获取全局实例。
pub struct LspManager {
    /// 服务器池：命令名 → 进程句柄
    pool: RwLock<PoolMap>,
    /// 项目根目录
    project_root: RwLock<Option<String>>,
    /// 是否已初始化（warm 已调用）
    initialized: RwLock<bool>,
    /// 每个命令的最后一次预热错误，用于诊断
    last_warm_errors: RwLock<HashMap<String, String>>,
}

impl LspManager {
    /// 获取全局单例实例。
    pub fn global() -> &'static Self {
        use std::sync::LazyLock;
        static MANAGER: LazyLock<LspManager> = LazyLock::new(LspManager::new);
        &MANAGER
    }

    /// 检查 LSP 池是否已初始化（warm 已调用）。
    pub fn is_initialized() -> bool {
        *Self::global().initialized.read().unwrap()
    }

    /// 检查项目根目录是否与上次 warm 时不同（工作区切换）。
    pub fn root_changed(new_root: &str) -> bool {
        match Self::global().project_root.read().unwrap().as_ref() {
            Some(old) => old != new_root,
            None => true,
        }
    }

    fn new() -> Self {
        Self {
            pool: RwLock::new(HashMap::new()),
            project_root: RwLock::new(None),
            initialized: RwLock::new(false),
            last_warm_errors: RwLock::new(HashMap::new()),
        }
    }

    /// 预热服务器池——并行启动所有已配置的 LSP 服务器。
    ///
    /// 不做扩展名扫描和过滤：如果服务器在 PATH 上存在就尝试启动。
    /// 启动慢的不阻塞启动快的。失败记录到 `last_warm_errors` 中供诊断。
    /// 应在索引完成后调用。
    pub fn warm(project_root: &str) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap() = Some(project_root.to_string());
        *mgr.initialized.write().unwrap() = true;

        let root = project_root.to_string();
        for cfg in SERVER_CONFIGS {
            let cmd = cfg.command;
            // 跳过池中已在运行的服务器 —— 避免在重复 warm 调用
            //（如 engine_status 轮询）时杀死健康的进程。
            {
                let pool = mgr.pool.read().unwrap();
                if let Some(arc) = pool.get(cmd) {
                    if let Ok(guard) = arc.lock() {
                        if guard.is_some() {
                            tracing::debug!(cmd, "[lsp_manager] already running, skip warm");
                            continue;
                        }
                    }
                }
            }
            let ws_root = Self::resolve_workspace_root(&root, cfg.config_marker);
            let cfg: &'static LspServerConfig = cfg; // const slice → 'static
            std::thread::spawn(move || {
                match Self::spawn_server(cfg, &ws_root) {
                    Ok(process) => {
                        tracing::info!(cmd, "[lsp_manager] server started");
                        mgr.pool
                            .write()
                            .unwrap()
                            .insert(cmd, Arc::new(Mutex::new(Some(process))));
                        mgr.last_warm_errors.write().unwrap().remove(cmd);
                    }
                    Err(e) => {
                        let diagnosed = Self::diagnose_error(cmd, &e);
                        let err_msg = format!("spawn+init {}: {}", cmd, diagnosed);
                        tracing::error!(cmd, err = %diagnosed, "[lsp_manager] server unavailable");
                        mgr.last_warm_errors
                            .write()
                            .unwrap()
                            .insert(cmd.to_string(), err_msg);
                    }
                }
            });
        }
    }

    /// 同步预热服务器池——阻塞直到所有服务器启动或失败。
    ///
    /// 返回 (已启动数, 失败数)。供压力测试使用。
    pub fn warm_blocking(project_root: &str) -> (usize, usize) {
        Self::warm_blocking_filtered(project_root, &[])
    }

    /// 同步预热服务器池，仅启动扩展名与 `ext_filter` 有交集的服务器。
    ///
    /// 如果 `ext_filter` 为空则启动全部。供压力测试按语言过滤使用。
    pub fn warm_blocking_filtered(project_root: &str, ext_filter: &[&str]) -> (usize, usize) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap() = Some(project_root.to_string());
        *mgr.initialized.write().unwrap() = true;

        let root = project_root.to_string();
        let mut handles = Vec::new();

        for cfg in SERVER_CONFIGS {
            // 应用扩展名过滤
            if !ext_filter.is_empty() {
                let has_match = ext_filter.iter()
                    .any(|e| cfg.extensions.contains(e));
                if !has_match { continue; }
            }

            let root = Self::resolve_workspace_root(&root, cfg.config_marker);
            let cmd = cfg.command;
            let cfg: &'static LspServerConfig = cfg;
            let handle = std::thread::spawn(move || {
                match Self::spawn_server(cfg, &root) {
                    Ok(process) => {
                        tracing::info!(cmd, "[lsp_manager] server started (blocking)");
                        mgr.pool
                            .write()
                            .unwrap()
                            .insert(cmd, Arc::new(Mutex::new(Some(process))));
                        mgr.last_warm_errors.write().unwrap().remove(cmd);
                        Ok(cmd)
                    }
                    Err(e) => {
                        let diagnosed = Self::diagnose_error(cmd, &e);
                        let err_msg = format!("spawn+init {}: {}", cmd, diagnosed);
                        tracing::error!(cmd, err = %diagnosed, "[lsp_manager] server unavailable (blocking)");
                        mgr.last_warm_errors
                            .write()
                            .unwrap()
                            .insert(cmd.to_string(), err_msg);
                        Err(cmd)
                    }
                }
            });
            handles.push(handle);
        }

        let mut started = 0;
        let mut failed = 0;
        for h in handles {
            match h.join() {
                Ok(Ok(_)) => started += 1,
                Ok(Err(_)) => failed += 1,
                Err(_) => {
                    eprintln!("[lsp] warm-up thread panicked");
                    failed += 1;
                }
            }
        }

        (started, failed)
    }

    /// 为 LSP 服务器查找正确的工作区根目录。
    ///
    /// 在项目根目录下搜索 config_marker 文件，如果未找到则搜索一级子目录。
    /// 返回包含第一个匹配项的目录，如果都未找到则返回项目根目录。
    fn resolve_workspace_root(project_root: &str, markers: &[&str]) -> String {
        if markers.is_empty() {
            return project_root.to_string();
        }
        // 先检查项目根目录
        if Self::dir_has_marker(project_root, markers) {
            return project_root.to_string();
        }
        // 搜索一级子目录
        if let Ok(entries) = std::fs::read_dir(project_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(dir_str) = path.to_str() {
                        if Self::dir_has_marker(dir_str, markers) {
                            return dir_str.to_string();
                        }
                    }
                }
            }
        }
        // 回退到项目根目录
        project_root.to_string()
    }

    /// 检查目录中是否包含任意一个给定的标记文件。
    ///
    /// 支持字面文件名和扩展名通配（如 "*.sln"）。
    fn dir_has_marker(dir: &str, markers: &[&str]) -> bool {
        for marker in markers {
            if marker.starts_with("*.") {
                // 扩展名通配：检查是否存在任何带此扩展名的文件
                let ext = &marker[1..]; // ".sln", ".csproj"
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() {
                            if let Some(file_ext) = p.extension().and_then(|e| e.to_str()) {
                                let dot_ext = format!(".{}", file_ext);
                                if dot_ext.eq_ignore_ascii_case(ext) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            } else {
                // 字面文件名
                let full = std::path::Path::new(dir).join(marker);
                if full.exists() {
                    return true;
                }
            }
        }
        false
    }

    /// 诊断常见的 LSP 启动失败并返回可操作的指导信息。
    fn diagnose_error(cmd: &str, raw: &str) -> String {
        let lower = raw.to_lowercase();
        // npm 全局包损坏——node_modules 缺失
        if lower.contains("cannot find module") && lower.contains("node_modules") {
            return format!(
                "{} — npm package appears corrupted. Reinstall: npm uninstall -g {} && npm install -g {}",
                raw,
                cmd.replace("-langserver", "").replace("-language-server", ""),
                cmd.replace("-langserver", "").replace("-language-server", ""),
            );
        }
        // rustup 代理缺少实际组件
        if cmd == "rust-analyzer" && lower.contains("unknown binary") && lower.contains("toolchain") {
            return format!(
                "{} — rust-analyzer not installed for your Rust toolchain. Run: rustup component add rust-analyzer",
                raw,
            );
        }
        // gopls 未安装
        if cmd == "gopls" && (lower.contains("not found") || lower.contains("no such file")) {
            return format!(
                "{} — gopls not found. Install: go install golang.org/x/tools/gopls@latest",
                raw,
            );
        }
        // 通用的 "not found"
        if lower.contains("program not found") || lower.contains("no such file") {
            return format!(
                "{} — {} is not installed or not on PATH. See 安装指南 for install instructions.",
                raw, cmd,
            );
        }
        // 原样返回
        raw.to_string()
    }

    /// 按扩展名尝试预热单个 LSP 服务器。
    ///
    /// 当 resolve_definition 发现池中无服务器时作为惰性重试使用。
    fn try_warm_one(ext: &str) -> bool {
        let cfg = match SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)) {
            Some(c) => c,
            None => return false,
        };
        let mgr = Self::global();
        let root = match mgr.project_root.read().unwrap().as_ref() {
            Some(r) => r.clone(),
            None => return false,
        };
        let cmd = cfg.command;
        match Self::spawn_server(cfg, &root) {
            Ok(process) => {
                tracing::info!(cmd, ext, "[lsp_manager] lazy warm succeeded");
                mgr.pool
                    .write()
                    .unwrap()
                    .insert(cmd, Arc::new(Mutex::new(Some(process))));
                mgr.last_warm_errors.write().unwrap().remove(cmd);
                true
            }
            Err(e) => {
                let err_msg = format!("lazy-spawn+init {}: {}", cmd, e);
                tracing::error!(cmd, ext, err = %e, "[lsp_manager] lazy warm failed — retry exhausted");
                mgr.last_warm_errors
                    .write()
                    .unwrap()
                    .insert(cmd.to_string(), err_msg);
                false
            }
        }
    }

    /// 启动单个 LSP 服务器进程并完成 initialize 握手。
    ///
    /// Windows 上 npm 全局工具是 .cmd 包装器，需要通过 cmd.exe /c 运行。
    fn spawn_server(cfg: &LspServerConfig, root: &str) -> Result<LspProcess, String> {
        // 解析完整路径——Windows 上 npm 全局工具是 .cmd 包装器
        // .cmd/.bat 文件必须通过 cmd.exe /c 运行（它们是脚本，不是 PE 可执行文件）
        let exe = Self::resolve_cmd_path(cfg.command)
            .unwrap_or_else(|| std::path::PathBuf::from(cfg.command));
        let (program, args_vec) = {
            #[cfg(target_os = "windows")]
            {
                let ext = exe.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if ext == "cmd" || ext == "bat" {
                    let mut v = vec!["/c".to_string(), exe.to_string_lossy().into_owned()];
                    v.extend(cfg.args.iter().map(|a| a.to_string()));
                    (std::path::PathBuf::from("cmd.exe"), v)
                } else {
                    let v: Vec<String> = cfg.args.iter().map(|a| a.to_string()).collect();
                    (exe, v)
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let v: Vec<String> = cfg.args.iter().map(|a| a.to_string()).collect();
                (exe, v)
            }
        };

        let mut c = Command::new(&program);
        c.args(&args_vec)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()); // 捕获 stderr 用于诊断
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW —— 不弹出控制台窗口
        }
        let mut child = c.spawn()
            .map_err(|e| format!("spawn {}: {}", cfg.command, e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();

        let mut process = LspProcess {
            process: child,
            stdin: Arc::new(Mutex::new(stdin)),
            reader: Some(BufReader::new(stdout)),
            stderr,
            next_id: 0,
            timeout: LSP_TIMEOUT,
        };

        // 快速死亡检测：如果进程在几百毫秒内就退出了（典型：版本不兼容），
        // 立即报错而不是等 initialize 超时 30 秒。
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Ok(Some(status)) = process.process.try_wait() {
            let mut stderr_output = String::new();
            if let Some(ref mut stderr) = process.stderr {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut stderr_output);
            }
            let hint = if stderr_output.is_empty() {
                format!(
                    "exited with code {} immediately after spawn (no stderr) — \
                     likely a version incompatibility between {} and its language runtime",
                    status, cfg.command,
                )
            } else {
                format!(
                    "exited with code {} immediately after spawn: {}",
                    status, stderr_output.trim(),
                )
            };
            // 进程已死，清理
            let _ = process.process.kill();
            return Err(hint);
        }

        process.initialize(root)?;

        Ok(process)
    }

    /// 按文件扩展名查找对应的 LSP 服务器。
    fn get_server(ext: &str) -> Option<Arc<Mutex<Option<LspProcess>>>> {
        let mgr = Self::global();
        let pool = mgr.pool.read().unwrap();
        for cfg in SERVER_CONFIGS {
            if cfg.extensions.contains(&ext) {
                return pool.get(cfg.command).cloned();
            }
        }
        None
    }

    /// 获取服务器，如果池中不存在则尝试惰性预热。
    ///
    /// 返回 Ok(server_arc) 或 Err(原因)。
    fn get_or_warm_server(ext: &str) -> Result<Arc<Mutex<Option<LspProcess>>>, String> {
        // 池中已有条目：仅当进程存活（Some）才复用。
        // with_process 失败会把进程置 None 但 Arc 留在池中 ——
        // 若不检查存活，get_server 恒返回 Some，导致永久
        // "server not running" 死壳、LSP 永远无法自愈。
        if let Some(arc) = Self::get_server(ext) {
            let alive = arc.lock().map(|g| g.is_some()).unwrap_or(false);
            if alive {
                return Ok(arc);
            }
            // 死壳：从池中移除，走下方重建路径
            let mgr = Self::global();
            let cmd = SERVER_CONFIGS
                .iter()
                .find(|c| c.extensions.contains(&ext))
                .map(|c| c.command);
            if let Some(cmd) = cmd {
                tracing::warn!(ext, "[lsp_manager] stale dead server removed, rebuilding");
                mgr.pool.write().unwrap().remove(cmd);
            }
        }
        tracing::info!(ext, "[lsp_manager] server not in pool, attempting lazy warm");
        if !Self::try_warm_one(ext) {
            return Err(format!("no server for .{} (lazy warm failed)", ext));
        }
        Self::get_server(ext).ok_or_else(|| format!("no server for .{} after warm", ext))
    }

    /// 在 LSP 进程上执行操作。
    ///
    /// 锁定服务器，执行闭包 f，如果 f 失败则清空池条目，
    /// 使下次调用时重新预热新进程。
    fn with_process<T>(
        server_arc: &Arc<Mutex<Option<LspProcess>>>,
        f: impl FnOnce(&mut LspProcess) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;
        match f(process) {
            Ok(v) => Ok(v),
            Err(e) => {
                *guard = None; // 销毁损坏的进程，下次调用强制重建
                Err(e)
            }
        }
    }

    /// 解析指定位置的函数定义。
    ///
    /// 参数：
    /// - `file_path`: 文件路径（相对或绝对）
    /// - `source`: 文件源码文本
    /// - `line`/`column`: 0-based 行列号
    /// - `ext`: 文件扩展名（用于选择 LSP 服务器）
    ///
    /// 返回定义位置列表，或 Err（无可用服务器）。
    pub fn resolve_definition(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let mgr = Self::global();
        if !*mgr.initialized.read().unwrap() {
            return Err("LSP pool not initialized".into());
        }
        let server_arc = Self::get_or_warm_server(ext)?;
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let root = mgr.project_root.read().unwrap();
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));
        let lang_id = SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)).map(|c| c.language_id).unwrap_or(ext);
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, lang_id);
            process.definition(&uri, line, column)
        })
    }

    /// 通过 hover 解析指定位置的类型信息。
    pub fn resolve_type(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<String, String> {
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            process.hover(&uri, line, column)
        })
    }

    /// 查找指定位置接口/trait 的所有实现。
    pub fn find_implementations(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            process.implementation(&uri, line, column)
        })
    }

    /// 查找指定位置符号的所有引用。
    pub fn find_references(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            process.references(&uri, line, column)
        })
    }

    /// 辅助函数：从文件路径和扩展名解析 URI 和语言 ID。
    fn prepare(file_path: &str, ext: &str) -> Result<(String, String), String> {
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let mgr = Self::global();
            let root = mgr.project_root.read().unwrap();
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));
        let lang_id = SERVER_CONFIGS
            .iter()
            .find(|c| c.extensions.contains(&ext))
            .map(|c| c.language_id)
            .unwrap_or(ext)
            .to_string();
        Ok((uri, lang_id))
    }

    /// 检查指定文件扩展名是否有可用的 LSP 服务器。
    ///
    /// 仅当池中有服务器进程实际运行时返回 true。
    pub fn is_available(ext: &str) -> bool {
        Self::get_server(ext)
            .and_then(|arc| {
                arc.lock().ok().map(|guard| guard.is_some())
            })
            .unwrap_or(false)
    }

    /// 返回最近一次预热错误，用于诊断显示。
    ///
    /// 返回命令名 → 错误消息的映射。
    pub fn warm_errors() -> HashMap<String, String> {
        Self::global().last_warm_errors.read().unwrap().clone()
    }

    /// 在文件系统上解析命令的完整路径。
    ///
    /// Windows 上优先检查 .exe/.cmd/.bat——npm 全局工具
    /// 有无扩展名的 Unix 脚本和 .cmd 包装器并存；
    /// 无扩展名的文件是 shell 脚本，不能直接 spawn。
    fn resolve_cmd_path(cmd: &str) -> Option<std::path::PathBuf> {
        if let Ok(paths) = std::env::var("PATH") {
            for dir in std::env::split_paths(&paths) {
                #[cfg(target_os = "windows")]
                {
                    for ext in ["exe", "cmd", "bat"] {
                        let with_ext = dir.join(cmd).with_extension(ext);
                        if with_ext.exists() {
                            return Some(with_ext);
                        }
                    }
                }
                // 回退：无扩展名（Unix）或非 Windows
                let full = dir.join(cmd);
                if full.exists() {
                    return Some(full);
                }
            }
        }
        None
    }

    /// 检查命令是否在 PATH 上存在（不启动进程）。
    ///
    /// 始终可用——不需要 warm()。供 lsp_status() 区分"未启动"和"未安装"。
    fn find_on_path(cmd: &str) -> bool {
        Self::resolve_cmd_path(cmd).is_some()
    }

    /// 完整的 LSP 状态，供设置面板 / engine_status 使用。
    ///
    /// 返回每个服务器的可用性 + 安装提示。
    /// `installed` 通过 PATH 检查——即使 warm() 未运行也可用。
    pub fn lsp_status() -> Vec<Value> {
        let mgr = Self::global();
        let errors = mgr.last_warm_errors.read().unwrap().clone();
        let pool = mgr.pool.read().unwrap();
        SERVER_CONFIGS
            .iter()
            .map(|cfg| {
                let available = pool.get(cfg.command)
                    .and_then(|arc| arc.lock().ok().map(|g| g.is_some()))
                    .unwrap_or(false);
                let error = errors.get(cfg.command).cloned();
                // 始终检查 PATH——独立于 warm 状态
                let installed = available || Self::find_on_path(cfg.command);
                // 兜底：已安装但不可用且无错误记录 → warm 可能在进行中或静默失败
                let error = if installed && !available && error.is_none()
                    && *mgr.initialized.read().unwrap()
                {
                    Some("warm in progress or silent failure — retry if persists".to_string())
                } else {
                    error
                };
                json!({
                    "command": cfg.command,
                    "language_id": cfg.language_id,
                    "extensions": cfg.extensions,
                    "available": available,
                    "installed": installed,
                    "error": error,
                })
            })
            .collect()
    }
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_single_location() {
        // 单个 Location 应正确解析
        let json = json!({
            "uri": "file:///src/main.rs",
            "range": {
                "start": {"line": 10, "character": 5},
                "end": {"line": 10, "character": 9}
            }
        });
        let locs = parse_definition_results(&json).unwrap();
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].uri, "file:///src/main.rs");
        assert_eq!(locs[0].range_start_line, 10);
    }

    #[test]
    fn test_parse_null_result() {
        // null 结果应返回空列表
        let locs = parse_definition_results(&Value::Null).unwrap();
        assert!(locs.is_empty());
    }

    #[test]
    fn test_server_configs_complete() {
        // 验证所有主要语言的扩展名都在配置表中
        let covered: Vec<&str> = SERVER_CONFIGS
            .iter()
            .flat_map(|c| c.extensions.iter().copied())
            .collect();
        assert!(covered.contains(&"rs"));
        assert!(covered.contains(&"py"));
        assert!(covered.contains(&"go"));
        assert!(covered.contains(&"java"));
        assert!(covered.contains(&"ts"));
        assert!(covered.contains(&"cs"));
        assert!(covered.contains(&"php"));
        assert!(covered.contains(&"kt"));
    }

    // ── 辅助函数 ──


    /// 启动一个会挂起 60 秒的进程——用于超时测试。
    fn spawn_hanging_process() -> LspProcess {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(&["/c", "ping -n 60 127.0.0.1 > nul"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.args(&["-c", "sleep 60"]);
            c
        };
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn hanging process");

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        LspProcess {
            process: child,
            stdin: Arc::new(Mutex::new(stdin)),
            reader: Some(BufReader::new(stdout)),
            stderr: None,
            next_id: 0,
            timeout: std::time::Duration::from_secs(2), // 测试用 2 秒超时
        }
    }

    // ── 超时测试 ──

    #[test]
    fn test_read_one_message_parses_coalesced_frames() {
        // ponytail: 服务器一次 write 粘连多条消息（帧+帧），
        // 曾导致 read_line 行边界错位、body 读进帧头。
        // 验证新解析器能精确拆帧。
        use std::io::Write;
        use std::process::{Command, Stdio};
        // 用一个子进程模拟服务器：输出两条粘连的 LSP 帧
        let mut child = Command::new("python")
            .args(["-c", r#"
import sys, json, time
def frame(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
    sys.stdout.buffer.flush()
# 两条消息粘连在同一个 write 里
frame({"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}})
frame({"jsonrpc":"2.0","id":2,"result":[{"uri":"file:///x.ts","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}]})
time.sleep(0.2)
"#])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn python");
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);

        // 第一条帧
        let (id1, msg1) = LspProcess::read_one_message(&mut reader).expect("frame 1");
        assert_eq!(id1, Some(1));
        assert!(msg1.get("result").is_some(), "frame1 result missing");

        // 第二条帧 — 粘连场景下第二条必须能精确解析
        let (id2, msg2) = LspProcess::read_one_message(&mut reader).expect("frame 2");
        assert_eq!(id2, Some(2));
        let result = msg2.get("result").unwrap();
        assert!(result.is_array(), "frame2 should be an array, got {:?}", result);
        let _ = child.wait();
    }

    #[test]
    fn test_send_request_timeout() {
        // 挂起进程的请求应在超时后返回错误，而非永久阻塞
        let mut process = spawn_hanging_process();
        let start = std::time::Instant::now();
        let result = process.send_request(
            "textDocument/references",
            json!({"textDocument":{"uri":"file:///x.rs"},"position":{"line":0,"character":0}}),
        );
        let elapsed = start.elapsed();
        // 不应挂起——必须在 5 秒内返回（超时设为 2 秒）
        assert!(elapsed < std::time::Duration::from_secs(5),
            "send_request should not block forever, took {:?}, result: {:?}", elapsed, result);
        assert!(result.is_err(), "expected error from hanging process, got {:?}", result);
    }

    // ── E2E: 真实 rust-analyzer ──

    // 注意：曾尝试 rust-analyzer E2E 测试，但在 CI 中不可靠：
    // cargo check 的耗时因机器而异波动很大。超时机制已由 test_send_request_timeout 验证；
    // 真实 LSP 调用在每次引擎运行时被测试（索引 + 通过 MCP 工具的 agent 查询）。

}
