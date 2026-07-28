// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # MCP 服务器 —— 基于 stdin/stdout 的 JSON-RPC
//!
//! 完全替代 src_python/mcp_server.py。
//!
//! 协议：从 stdin 逐行读取 JSON-RPC 请求，向 stdout 逐行写入 JSON-RPC 响应。
//! 支持 `tools/list` 和 `tools/call`，通过 ToolRegistry 暴露全部 28+ 个 hologram_* 工具。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::engine;

// 所有图访问都通过 Engine（engine::engine_* 函数）。
// GRAPH_STORE / CACHED_GRAPH / ANALYZE_LOCK / with_graph_store —— 均已移除。

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

pub struct McpServer {
    /// 项目根目录路径（用于重新分析、时间线等）
    /// 用 Mutex 包装，使 tool_analyze 可在运行时切换项目
    #[allow(dead_code)] // 遗留字段；工具现在使用全局 ENGINE，但保留以备将来按服务器路由
    project_root: Mutex<PathBuf>,
}

impl McpServer {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: Mutex::new(project_root.to_path_buf()),
        }
    }

    /// 获取当前项目根目录的克隆。
    #[allow(dead_code)] // 遗留；工具现在使用全局 ENGINE
    fn project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap().clone()
    }

    // ── JSON-RPC 协议 ──

    /// 处理一行 JSON-RPC 请求，返回 JSON-RPC 响应行（通知消息返回 None）。
    pub fn handle_request(&self, line: &str) -> Option<String> {
        let start = std::time::Instant::now();
        let request: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return None,
        };

        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let req_id = request.get("id").cloned();

        // 通知没有 id —— 忽略
        let id = req_id?;

        info!(method = %method, id = %id, "mcp request");

        let result = match method {
            "initialize" => self.handle_initialize(&id),
            "tools/list" => self.handle_tools_list(&id),
            "tools/call" => self.handle_tools_call(&request, &id),
            "ping" => McpServer::success_response(&id, json!({})),
            _ => {
                warn!(method = %method, id = %id, "unknown MCP method");
                McpServer::error_response(&id, -32603, &format!("Method not found: {}", method))
            }
        };

        info!(method = %method, id = %id, elapsed_ms = start.elapsed().as_millis(), "mcp response");
        match serde_json::to_string(&result) {
            Ok(s) => Some(s),
            Err(e) => {
                warn!(method = %method, id = %id, error = %e, "mcp response serialization failed");
                None
            }
        }
    }

    /// 主循环：从 stdin 读取 JSON-RPC，向 stdout 写入响应。
    pub fn run_stdio(&self) {
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        let reader = BufReader::new(stdin.lock());

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(response) = self.handle_request(trimmed) {
                let _ = writeln!(stdout, "{}", response);
                let _ = stdout.flush();
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
                "tools": {}
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

    fn handle_tools_call(&self, request: &Value, id: &Value) -> Value {
        let empty_params = json!({});
        let params = request.get("params").unwrap_or(&empty_params);
        let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));

        // 通过 ToolRegistry 分发——与 CLI/Tauri 使用同一套注册表
        let mut result = crate::tools::ToolRegistry::dispatch(tool_name, &args, id);

        // 当存在待处理的文件变更时，注入过期横幅提示
        if let Some(banner) = crate::tools::staleness::check_staleness(&result) {
            if let Some(obj) = result.as_object_mut() {
                if let Some(res) = obj.get_mut("result").and_then(|r| r.as_object_mut()) {
                    res.insert("_stalenessBanner".into(), json!(banner));
                }
            }
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造 JSON-RPC 请求。
    fn make_rpc(method: &str, params: Value, id: u64) -> Value {
        json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": id })
    }

    /// 构造 tools/call 请求。
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
        // 无效 JSON 应返回 None
        let srv = server();
        assert!(srv.handle_request("not json").is_none());
    }

    #[test]
    fn test_handle_notification_no_id() {
        // 通知（无 id）应被忽略，返回 None
        let srv = server();
        let req = serde_json::to_string(&make_notification("tools/list")).unwrap();
        assert!(srv.handle_request(&req).is_none(), "notifications should be ignored");
    }

    #[test]
    fn test_handle_unknown_method() {
        // 未知方法应返回 -32603 错误
        let srv = server();
        let req = serde_json::to_string(&make_rpc("bogus/method", json!({}), 1)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_tools_list() {
        // tools/list 应返回至少 30 个工具
        let srv = server();
        let req = serde_json::to_string(&make_rpc("tools/list", json!({}), 1)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let tools = v["result"]["tools"].as_array().unwrap();
        assert!(tools.len() >= 30, "at least 30 tools exposed");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"get_neighbors"));
        assert!(names.contains(&"analyze_project"));
    }

    #[test]
    fn test_tool_call_unknown_tool() {
        // 未知工具应返回降级成功响应（带 _isDegraded 标志），而非 JSON-RPC 错误
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("nonexistent_tool", json!({}), 2)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert!(v.get("result").is_some(), "unknown tool should return degraded success");
        assert!(v.get("error").is_none(), "unknown tool should NOT be a JSON-RPC error");
    }

    // ═══ 工具调用: timeline ═══

    #[test]
    fn test_timeline() {
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("project_timeline",
            json!({"limit": 10}), 19)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert!(v.get("result").is_some() || v.get("error").is_some());
    }
}
