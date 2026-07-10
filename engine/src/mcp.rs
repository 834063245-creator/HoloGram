// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP Server — JSON-RPC over stdin/stdout
// Replaces src_python/mcp_server.py entirely.
//
// Protocol: reads one JSON-RPC request per line from stdin,
// writes one JSON-RPC response per line to stdout.
// Supports tools/list and tools/call with all 28 hologram_* tools (via ToolRegistry).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::engine;

// All graph access goes through Engine (engine::engine_* functions).
// GRAPH_STORE / CACHED_GRAPH / ANALYZE_LOCK / with_graph_store — all removed.

/// Parse CLI args for `engine.exe serve [--project-root <path>]`.
/// Returns None if not in serve mode.
/// Returns Some(None) for serve mode without --project-root (lazy startup).
/// Returns Some(Some(path)) for serve mode with --project-root.
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


fn has_active_index() -> bool {
    engine::engine_read(|idx| idx.node_count() > 0).unwrap_or(false)
}

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

const HOLOGRAM_INSTRUCTIONS_NO_INDEX: &str = r#"
# HoloGram — 3D code dependency graph

No project index loaded yet. Use `hologram_analyze_project` to create one,
or open a project folder to auto-analyze.
"#;

// ═══════════════════════════════════════════════════════════════
// MCP Server
// ═══════════════════════════════════════════════════════════════

pub struct McpServer {
    /// Path to the project root directory (for re-analysis, timeline, etc.)
    /// Wrapped in Mutex so tool_analyze can switch projects at runtime.
    #[allow(dead_code)] // legacy field; tools now use global ENGINE, but kept for future per-server routing
    project_root: Mutex<PathBuf>,
}

impl McpServer {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: Mutex::new(project_root.to_path_buf()),
        }
    }

    /// Get a clone of the current project root.
    #[allow(dead_code)] // legacy; tools now use global ENGINE
    fn project_root(&self) -> PathBuf {
        self.project_root.lock().unwrap().clone()
    }

    // ── JSON-RPC protocol ──

    /// Process one JSON-RPC request line, return JSON-RPC response line (or None for notifications).
    pub fn handle_request(&self, line: &str) -> Option<String> {
        let start = std::time::Instant::now();
        let request: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return None,
        };

        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let req_id = request.get("id").cloned();

        // Notifications have no id — ignore
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

    /// Main loop: read JSON-RPC from stdin, write responses to stdout.
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

    // ── JSON-RPC helpers ──

    fn success_response(id: &Value, result: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    }

    fn error_response(id: &Value, code: i32, message: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
    }

    // ── initialize ──

    fn handle_initialize(&self, id: &Value) -> Value {
        info!("MCP initialize handshake");
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

    // ── tools/list ──

    fn handle_tools_list(&self, id: &Value) -> Value {
        McpServer::success_response(id, json!({ "tools": crate::tools::ToolRegistry::global().tools_list() }))
    }

    // ── tools/call dispatch ──

    fn handle_tools_call(&self, request: &Value, id: &Value) -> Value {
        let empty_params = json!({});
        let params = request.get("params").unwrap_or(&empty_params);
        let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));

        let mut result = crate::tools::ToolRegistry::dispatch(tool_name, &args, id);

        // Inject staleness banner when pending file changes exist
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

    fn make_rpc(method: &str, params: Value, id: u64) -> Value {
        json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": id })
    }

    fn make_tool_call(name: &str, args: Value, id: u64) -> Value {
        make_rpc("tools/call", json!({ "name": name, "arguments": args }), id)
    }

    fn make_notification(method: &str) -> Value {
        json!({ "jsonrpc": "2.0", "method": method })
    }

    fn server() -> McpServer {
        McpServer::new(&std::env::temp_dir())
    }

    // ── parse_serve_args ──

    #[test]
    fn test_parse_serve_args_basic() {
        let args: Vec<String> = std::env::args().collect();
        if !args.contains(&"serve".to_string()) {
            assert!(parse_serve_args().is_none());
        }
    }

    // ── JSON-RPC protocol ──

    #[test]
    fn test_handle_invalid_json() {
        let srv = server();
        assert!(srv.handle_request("not json").is_none());
    }

    #[test]
    fn test_handle_notification_no_id() {
        let srv = server();
        let req = serde_json::to_string(&make_notification("tools/list")).unwrap();
        assert!(srv.handle_request(&req).is_none(), "notifications should be ignored");
    }

    #[test]
    fn test_handle_unknown_method() {
        let srv = server();
        let req = serde_json::to_string(&make_rpc("bogus/method", json!({}), 1)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_tools_list() {
        let srv = server();
        let req = serde_json::to_string(&make_rpc("tools/list", json!({}), 1)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let tools = v["result"]["tools"].as_array().unwrap();
        assert!(tools.len() >= 6, "at least 6 default tools exposed");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"explore_deps"), "default tools must include explore_deps");
        assert!(names.contains(&"search_symbols"), "default tools must include search_symbols");
    }

    #[test]
    fn test_tool_call_unknown_tool() {
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("nonexistent_tool", json!({}), 2)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        // Unknown tool returns a Degraded response (success with _isDegraded flag)
        assert!(v.get("result").is_some(), "unknown tool should return degraded success");
        assert!(v.get("error").is_none(), "unknown tool should NOT be a JSON-RPC error");
    }

    // ── Tool: timeline ──

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
