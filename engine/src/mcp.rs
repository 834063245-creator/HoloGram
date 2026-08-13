// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # MCP 服务器 —— 基于 stdin/stdout 的 JSON-RPC
//!
//! 完全替代 src_python/mcp_server.py。
//!
//! 协议：从 stdin 逐行读取 JSON-RPC 请求，向 stdout 逐行写入 JSON-RPC 响应。
//! 支持 `tools/list`、`tools/call`、`ping`、`prompts/list`、`prompts/get`，
//! 处理 `notifications/initialized` 与 `notifications/cancelled`，
//! 长任务发出 `notifications/progress`。通过 ToolRegistry 暴露全部 35 个
//! hologram_* 工具（默认激活 34 个；`symbol_history` 经 HOLOGRAM_MCP_TOOLS=* 放开）。
//!
//! MCP 1.0 错误语义：未知工具返回规范 JSON-RPC 错误（-32000），不再用
//! `_isDegraded` 假冒成功；工具执行失败在 tools/call 结果里用 `isError`
//! 表示，而不是降级成功。

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::engine::{self, EngineState};

/// 空闲轮询周期：分析进行中时，主循环用它向客户端推送进度。
const PROGRESS_POLL_MS: u64 = 150;
/// 需要上报进度的长任务工具（内部异步分析，返回 `started` 后仍在后台跑）。
fn is_long_running(name: &str) -> bool {
    matches!(name, "analyze_project" | "validate_project")
}

/// 解析 CLI 参数 `engine.exe serve [--project-root <path>]`。
///
/// 返回值：
/// - `None`：不在 serve 模式
/// - `Some(None)`：serve 模式但未指定 --project-root（惰性启动）
/// - `Some(Some(path))`：serve 模式且指定了 --project-root
pub fn parse_serve_args() -> Option<Option<String>> {
    let args: Vec<String> = std::env::args().collect();
    let mut project_root: Option<String> = None;
    let mut is_serve = false;
    for (i, arg) in args.iter().enumerate() {
        if arg == "serve" {
            is_serve = true;
        }
        if arg == "--project-root" {
            if let Some(val) = args.get(i + 1) {
                project_root = Some(val.clone());
            }
        }
        if arg.starts_with("--project-root=") {
            project_root = Some(arg.trim_start_matches("--project-root=").to_string());
        }
    }
    if is_serve { Some(project_root) } else { None }
}

/// 检查引擎是否已有已加载的图索引（节点数 > 0）。
fn has_active_index() -> bool {
    engine::engine_read(|idx| idx.node_count() > 0).unwrap_or(false)
}

/// 已索引状态下给 AI 助手的指令文本。
const HOLOGRAM_INSTRUCTIONS_INDEXED: &str = r#"
# HoloGram — 3D code dependency graph with query tools

HoloGram has pre-parsed this project into a dependency graph. Use these tools
instead of grep/Read for structural questions — the graph already did that work.

## Primary tool: hologram_explore_deps

Use `hologram_explore_deps` for almost any code question. Give it symbol names
or a natural-language question. It returns:
- The call path between named symbols (including dynamic-dispatch hops)
- Verbatim, line-numbered source (same format as Read — safe to Edit from)
- Blast radius of what depends on them
- Architecture alerts (cycles, fragile modules, concurrency)

## Anti-patterns

- Don't re-verify explore_deps results with grep — they come from full AST parse
- Don't Read files that explore_deps already returned source for
- Don't grep/glob first to find symbols — search_symbols + explore_deps does it
"#;

/// 未索引状态下给 AI 助手的指令文本。
const HOLOGRAM_INSTRUCTIONS_NO_INDEX: &str = r#"
# HoloGram — 3D code dependency graph

No project index loaded yet. Use `hologram_analyze_project` to create one,
or open a project folder to auto-analyze.
"#;

// ═══════════════════════════════════════════════════════════════
// MCP 服务器
// ═══════════════════════════════════════════════════════════════

/// 会话级状态 — 会话隔离，每服务器实例一份。
#[derive(Default)]
struct ServerState {
    /// 客户端是否已发 `notifications/initialized`。
    initialized: bool,
    /// 已取消的请求 id（`notifications/cancelled`）。已取消请求不再返回结果。
    cancelled: HashSet<Value>,
    /// 当前正在上报进度的长任务上下文（请求带 `_meta.progressToken` 时启动）。
    progress: Option<ProgressCtx>,
}

/// 进度上报上下文。
struct ProgressCtx {
    /// 触发进度的原始请求 id。
    request_id: Value,
    /// 客户端提供的 progressToken。
    token: Option<Value>,
    /// 正在执行的长任务工具名。
    tool: String,
}

pub struct McpServer {
    /// 项目根目录路径（用于重新分析、时间线等）
    /// 用 Mutex 包装，使 tool_analyze 可在运行时切换项目
    #[allow(dead_code)] // 遗留字段；工具现在使用全局 ENGINE，但保留以备将来按服务器路由
    project_root: Mutex<PathBuf>,
    /// 会话状态。
    state: Mutex<ServerState>,
}

impl McpServer {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: Mutex::new(project_root.to_path_buf()),
            state: Mutex::new(ServerState::default()),
        }
    }

    /// 获取当前项目根目录的克隆。
    #[allow(dead_code)] // 遗留；工具现在使用全局 ENGINE
    fn project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    // ── 会话状态 ──

    /// 会话初始化状态 — 供测试断言；生产代码经 handle_notification 隐式维护。
    #[allow(dead_code)]
    fn is_initialized(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).initialized
    }

    fn mark_initialized(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).initialized = true;
    }

    /// 请求是否已被取消 — 供测试断言（生产逻辑在 current_progress_notification 内联查询）。
    #[allow(dead_code)]
    fn is_cancelled(&self, request_id: &Value) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).cancelled.contains(request_id)
    }

    // ── JSON-RPC 协议 ──

    /// 处理一行 JSON-RPC 请求。通过 `out` 回调输出零到多行（进度通知 + 响应）。
    /// 通知（无 id）不产生输出。测试友好版本见 `handle_request`。
    pub fn handle_line(&self, line: &str, out: &mut dyn FnMut(String)) {
        let start = Instant::now();
        let request: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };

        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = request.get("id").cloned();
        let Some(id) = id else {
            // ── 通知（无 id）──
            self.handle_notification(&request);
            return;
        };

        let result = match method {
            "initialize" => self.handle_initialize(&id),
            "tools/list" => self.handle_tools_list(&id),
            "tools/call" => self.handle_tools_call(&request, &id, out),
            "ping" => McpServer::success_response(&id, json!({})),
            "prompts/list" => self.handle_prompts_list(&id),
            "prompts/get" => self.handle_prompts_get(&request, &id),
            _ => {
                warn!(method = %method, id = %id, "unknown MCP method");
                McpServer::error_response(&id, -32603, &format!("Method not found: {}", method))
            }
        };

        info!(method = %method, id = %id, elapsed_ms = start.elapsed().as_millis(), "mcp response");
        match serde_json::to_string(&result) {
            Ok(s) => out(s),
            Err(e) => warn!(method = %method, id = %id, error = %e, "mcp response serialization failed"),
        }
    }

    /// 便捷封装：处理一行并返回所有输出行（测试友好）。
    pub fn handle_request(&self, line: &str) -> Vec<String> {
        let mut lines = Vec::new();
        self.handle_line(line, &mut |s| lines.push(s));
        lines
    }

    /// 处理一个通知消息（无 id）。不产生响应。
    fn handle_notification(&self, request: &Value) {
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        match method {
            "notifications/initialized" => {
                info!("MCP notifications/initialized");
                self.mark_initialized();
            }
            "notifications/cancelled" => {
                let request_id = request
                    .get("params")
                    .and_then(|p| p.get("requestId"))
                    .cloned()
                    .unwrap_or(Value::Null);
                info!(request_id = %request_id, "MCP notifications/cancelled");
                let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
                // 取消匹配到的进度上下文。
                if let Some(p) = st.progress.take() {
                    if &p.request_id != &request_id {
                        st.progress = Some(p);
                    }
                }
                st.cancelled.insert(request_id);
            }
            _ => {
                warn!(method = %method, "dropped unknown MCP notification");
            }
        }
    }

    /// 主循环：从 stdin 读取 JSON-RPC，向 stdout 写入响应。
    /// 读者线程喂入 channel；主循环处理请求并轮询分析进度。
    pub fn run_stdio(&self) {
        let (tx, rx) = mpsc::channel::<String>();
        let _reader = std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in BufReader::new(stdin.lock()).lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if tx.send(trimmed.to_string()).is_err() {
                    break;
                }
            }
        });

        let mut stdout = std::io::stdout();
        loop {
            match rx.recv_timeout(Duration::from_millis(PROGRESS_POLL_MS)) {
                Ok(line) => {
                    let mut out_lines: Vec<String> = Vec::new();
                    self.handle_line(&line, &mut |s| out_lines.push(s));
                    for s in &out_lines {
                        let _ = writeln!(stdout, "{}", s);
                    }
                    // 长任务：记录进度上下文（前提请求带了 progressToken 且已启动后台分析）。
                    self.observe_progress_after_line(&line, &out_lines);
                    let _ = stdout.flush();
                }
                Err(RecvTimeoutError::Timeout) => {
                    // 空闲：分析进行中则推一个进度通知。
                    if let Some(notif) = self.current_progress_notification() {
                        let _ = writeln!(stdout, "{}", notif);
                        let _ = stdout.flush();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    /// 若刚处理的长任务请求启动了后台分析且带 progressToken，记录进度上下文。
    fn observe_progress_after_line(&self, raw_line: &str, out_lines: &[String]) {
        let request: Value = match serde_json::from_str(raw_line) {
            Ok(v) => v,
            Err(_) => return,
        };
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        if method != "tools/call" {
            return;
        }
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let tool = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !is_long_running(tool) {
            return;
        }
        // 请求必须带 _meta.progressToken 才上报进度（MCP 规范：客户端按请求 opt-in）。
        let token = params
            .get("_meta")
            .and_then(|m| m.get("progressToken"))
            .cloned();
        if token.is_none() {
            return;
        }
        // 工具确实启动了后台分析（返回里含 started / already_running）。
        let started = out_lines.iter().any(|l| {
            let v: Value = match serde_json::from_str(l) {
                Ok(v) => v,
                Err(_) => return false,
            };
            let txt = v["result"]["content"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            txt.contains("started") || txt.contains("already_running")
        });
        if started && engine::engine_state().is_analyzing() {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            st.progress = Some(ProgressCtx { request_id: id, token, tool: tool.to_string() });
        }
    }

    /// 若当前有进度上下文且引擎正在分析、且未被取消，构造一条进度通知。
    fn current_progress_notification(&self) -> Option<String> {
        let (request_id, token, _tool) = {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let ctx = st.progress.as_ref()?;
            if st.cancelled.contains(&ctx.request_id) {
                // 已取消：清空进度上下文，不再上报。
                st.progress = None;
                return None;
            }
            (ctx.request_id.clone(), ctx.token.clone(), ctx.tool.clone())
        };
        match engine::engine_state() {
            EngineState::Analyzing { phase, current, total, .. } => {
                Some(McpServer::progress_notification(&request_id, token.as_ref(), current, total, &phase))
            }
            // 分析结束：清空上下文，不再推送。
            _ => {
                self.state.lock().unwrap_or_else(|e| e.into_inner()).progress = None;
                None
            }
        }
    }

    // ── JSON-RPC 辅助函数 ──

    /// 构造成功响应。
    fn success_response(id: &Value, result: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    }

    /// 构造错误响应。
    fn error_response(id: &Value, code: i32, message: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
    }

    /// 构造 progress 通知。
    fn progress_notification(request_id: &Value, token: Option<&Value>, progress: usize, total: usize, message: &str) -> String {
        let mut params = json!({
            "progress": progress,
            "total": total,
            "message": message,
            // 关联字段，方便客户端把进度对回请求。
            "_requestId": request_id,
        });
        if let Some(t) = token {
            if let Some(obj) = params.as_object_mut() {
                obj.insert("progressToken".into(), t.clone());
            }
        }
        json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": params }).to_string()
    }

    // ── initialize 握手 ──

    fn handle_initialize(&self, id: &Value) -> Value {
        info!("MCP initialize handshake");
        // 根据索引状态选择不同的指令文本
        let instructions = if has_active_index() {
            HOLOGRAM_INSTRUCTIONS_INDEXED
        } else {
            HOLOGRAM_INSTRUCTIONS_NO_INDEX
        };

        McpServer::success_response(id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {},
                "prompts": {},
                "progress": {}
            },
            "serverInfo": {
                "name": "hologram-engine",
                "version": "4.0.0",
                "author": "Wenbing Jing",
                "license": "MIT",
                "homepage": "https://github.com/834063245-creator/HoloGram"
            },
            "instructions": instructions
        }))
    }

    // ── tools/list：列出所有可用工具 ──

    fn handle_tools_list(&self, id: &Value) -> Value {
        McpServer::success_response(id, json!({ "tools": crate::tools::ToolRegistry::global().tools_list() }))
    }

    // ── tools/call：分发工具调用 ──

    fn handle_tools_call(&self, request: &Value, id: &Value, out: &mut dyn FnMut(String)) -> Value {
        let empty_params = json!({});
        let params = request.get("params").unwrap_or(&empty_params);
        let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));

        // 未知工具（含缺失名称）→ 规范 JSON-RPC 错误，不再 _isDegraded 假冒成功。
        if crate::tools::ToolRegistry::global().get_schema(tool_name).is_none() {
            let msg = if tool_name.is_empty() {
                "Invalid params: missing tool name".to_string()
            } else {
                format!("Tool not found: {} — check tools/list for available tools", tool_name)
            };
            return McpServer::error_response(id, -32000, &msg);
        }

        // 长任务：若请求带 progressToken，先发一条 "started" 进度通知。
        if is_long_running(tool_name) {
            if let Some(token) = params.get("_meta").and_then(|m| m.get("progressToken")).cloned() {
                out(McpServer::progress_notification(id, Some(&token), 0, 0, &format!("{} started", tool_name)));
            }
        }

        // 通过 ToolRegistry 分发——与 CLI/Tauri 使用同一套注册表
        let mut result = crate::tools::ToolRegistry::dispatch(tool_name, &args, id);

        // 注入过期横幅提示（存在待处理的文件变更时）
        if let Some(banner) = crate::tools::staleness::check_staleness(&result) {
            if let Some(obj) = result.as_object_mut() {
                if let Some(res) = obj.get_mut("result").and_then(|r| r.as_object_mut()) {
                    res.insert("_stalenessBanner".into(), json!(banner));
                }
            }
        }

        // MCP 1.0：工具执行失败应放在 result.isError，而不是 JSON-RPC error 封套。
        // 把 dispatch 返回的 error 封套转成带 isError 的 result。
        if result.get("error").is_some() {
            let err_msg = result["error"]["message"].as_str().unwrap_or("tool execution failed").to_string();
            return McpServer::success_response(id, json!({
                "content": [{ "type": "text", "text": err_msg }],
                "isError": true,
                "_meta": { "generator": "HoloGram v4.0", "license": "MIT", "copyright": "Copyright (c) 2026 Wenbing Jing" }
            }));
        }
        result
    }

    // ── prompts：暴露预置指令提示词 ──

    fn handle_prompts_list(&self, id: &Value) -> Value {
        McpServer::success_response(id, json!({
            "prompts": [
                {
                    "name": "project-context",
                    "description": "HoloGram preset guidance for the current project index state",
                    "arguments": []
                }
            ]
        }))
    }

    fn handle_prompts_get(&self, request: &Value, id: &Value) -> Value {
        let empty_params = json!({});
        let params = request.get("params").unwrap_or(&empty_params);
        let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name != "project-context" {
            return McpServer::error_response(id, -32602, "Unknown prompt: only 'project-context' is available");
        }
        let instructions = if has_active_index() {
            HOLOGRAM_INSTRUCTIONS_INDEXED
        } else {
            HOLOGRAM_INSTRUCTIONS_NO_INDEX
        };
        McpServer::success_response(id, json!({
            "description": "HoloGram preset guidance for the current project index state",
            "messages": [{ "role": "user", "content": { "type": "text", "text": instructions } }]
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造 JSON-RPC 请求。
    fn make_rpc(method: &str, params: Value, id: u64) -> Value {
        json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": id })
    }

    /// 构造工具调用请求。
    fn make_tool_call(name: &str, args: Value, id: u64) -> Value {
        make_rpc("tools/call", json!({ "name": name, "arguments": args }), id)
    }

    /// 构造通知消息（无 id）。
    fn make_notification(method: &str) -> Value {
        json!({ "jsonrpc": "2.0", "method": method })
    }

    /// 创建测试用服务器实例。
    fn server() -> McpServer {
        McpServer::new(&std::env::temp_dir())
    }

    /// 解析服务器输出中的 JSON 响应行。
    fn responses(lines: &[String]) -> Vec<Value> {
        lines
            .iter()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    // ═══ parse_serve_args 测试 ═══

    #[test]
    fn test_parse_serve_args_basic() {
        let args: Vec<String> = std::env::args().collect();
        if !args.contains(&"serve".to_string()) {
            assert!(parse_serve_args().is_none());
        }
    }

    // ═══ JSON-RPC 协议测试 ═══

    #[test]
    fn test_handle_invalid_json() {
        // 无效 JSON 无输出
        let srv = server();
        assert!(srv.handle_request("not json").is_empty());
    }

    #[test]
    fn test_handle_notification_no_response() {
        // 通知（无 id）不产生响应行
        let srv = server();
        let req = serde_json::to_string(&make_notification("notifications/initialized")).unwrap();
        assert!(srv.handle_request(&req).is_empty(), "notifications must not produce a response");
    }

    #[test]
    fn test_initialize_capabilities() {
        // initialize 应声明 tools/prompts/progress 能力
        let srv = server();
        let req = serde_json::to_string(&make_rpc("initialize", json!({}), 1)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        let caps = &v[0]["result"]["capabilities"];
        assert!(caps.get("tools").is_some(), "capabilities must declare tools");
        assert!(caps.get("prompts").is_some(), "capabilities must declare prompts");
        assert!(caps.get("progress").is_some(), "capabilities must declare progress");
        assert_eq!(v[0]["result"]["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn test_notification_initialized_sets_state() {
        // notifications/initialized 应翻转会话初始化状态
        let srv = server();
        assert!(!srv.is_initialized());
        let req = serde_json::to_string(&make_notification("notifications/initialized")).unwrap();
        srv.handle_request(&req);
        assert!(srv.is_initialized());
    }

    #[test]
    fn test_handle_unknown_method() {
        // 未知方法应返回 -32603 错误
        let srv = server();
        let req = serde_json::to_string(&make_rpc("bogus/method", json!({}), 1)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        assert_eq!(v[0]["error"]["code"], -32603);
    }

    #[test]
    fn test_tools_list() {
        // tools/list 应返回至少 30 个工具
        let srv = server();
        let req = serde_json::to_string(&make_rpc("tools/list", json!({}), 1)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        let tools = v[0]["result"]["tools"].as_array().unwrap();
        assert!(tools.len() >= 30, "at least 30 tools exposed");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"get_neighbors"));
        assert!(names.contains(&"analyze_project"));
    }

    #[test]
    fn test_tool_call_known_tool() {
        // 已知工具应返回正常 result
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("project_timeline", json!({"limit": 5}), 2)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        assert!(v[0]["result"]["content"].is_array(), "known tool returns content");
        assert_eq!(v[0]["result"]["isError"].as_bool(), None, "successful tool has no isError");
    }

    #[test]
    fn test_tool_call_unknown_tool_is_error() {
        // 未知工具必须返回规范 JSON-RPC 错误，而非降级成功
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("nonexistent_tool", json!({}), 2)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        assert!(v[0]["error"].is_object(), "unknown tool should be a JSON-RPC error");
        assert!(v[0].get("result").is_none(), "unknown tool must not return a result envelope");
    }

    #[test]
    fn test_tool_call_missing_name_is_error() {
        // 缺名称也应返回参数错误
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("", json!({}), 3)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        assert!(v[0]["error"].is_object());
    }

    #[test]
    fn test_notification_cancelled_marks_request() {
        // notifications/cancelled 应标记对应请求为已取消
        let srv = server();
        let cancel = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": 42 }
        })).unwrap();
        srv.handle_request(&cancel);
        assert!(srv.is_cancelled(&json!(42)));
    }

    #[test]
    fn test_prompts_list_and_get() {
        let srv = server();
        let req = serde_json::to_string(&make_rpc("prompts/list", json!({}), 1)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        let prompts = v[0]["result"]["prompts"].as_array().unwrap();
        assert_eq!(prompts[0]["name"], "project-context");

        let get_req = serde_json::to_string(&make_rpc("prompts/get", json!({ "name": "project-context" }), 2)).unwrap();
        let glines = srv.handle_request(&get_req);
        let gv = responses(&glines);
        assert!(gv[0]["result"]["messages"].is_array());
    }

    #[test]
    fn test_prompts_get_unknown() {
        let srv = server();
        let req = serde_json::to_string(&make_rpc("prompts/get", json!({ "name": "nope" }), 1)).unwrap();
        let lines = srv.handle_request(&req);
        let v = responses(&lines);
        assert!(v[0]["error"].is_object(), "unknown prompt errors");
    }
}

