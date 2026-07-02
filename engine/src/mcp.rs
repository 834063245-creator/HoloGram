// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP Server — JSON-RPC over stdin/stdout
// Replaces src_python/mcp_server.py entirely.
//
// Protocol: reads one JSON-RPC request per line from stdin,
// writes one JSON-RPC response per line to stdout.
// Supports tools/list and tools/call with all 27 hologram_* tools (via ToolRegistry).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::analysis::*;
use crate::community::detect_communities_from_index;
use crate::engine;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{query, Edge, EdgeKind, Graph, Node, NodeKind};
use crate::pipeline::discovery::discover_files;
use crate::routing::preflight::run_full_check;
use crate::storage::MemoryIndex;

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

// ═══════════════════════════════════════════════════════════════
// Tool definitions — MCP tools/list schema
// ═══════════════════════════════════════════════════════════════

fn tool_definitions() -> Vec<Value> {
    vec![
        // ── V1 tools (7) ──
        tool_def("hologram_neighbors", "Get first-order neighbors of a node, grouped by edge type (structural/data/temporal).",
            &[("node_id", "string", "The node ID")], &["node_id"]),
        tool_def("hologram_impact", "BFS impact analysis from a node. Returns layered results with distance, edge types, and temporal delay info.",
            &[("node_id", "string", "The source node ID"), ("depth", "integer", "BFS max depth (default 3)")], &["node_id"]),
        tool_def("hologram_path", "Find all paths between two nodes. Each path includes hop count and edge types.",
            &[("from_id", "string", "Source node ID"), ("to_id", "string", "Target node ID"), ("depth", "integer", "BFS search depth limit (default 20)")], &["from_id", "to_id"]),
        tool_def("hologram_history", "Get decision history for a node — what decisions involved this node.",
            &[("node_id", "string", "The node ID")], &["node_id"]),
        tool_def("hologram_community", "Get community information for a node — its community, parent, and sibling nodes.",
            &[("node_id", "string", "The node ID")], &["node_id"]),
        tool_def("hologram_delayed", "Get all nodes connected via temporal edges with non-null delays.",
            &[], &[]),
        // ponytail: hologram_changes removed — merged into hologram_timeline (timeline with limit=1 covers it)

        // ── V2 analysis (5) ──
        tool_def("hologram_fragile", "Get top N most fragile modules ranked by L4 encapsulation violation density.",
            &[("limit", "integer", "Number of top fragile modules to return (default 5)")], &[]),
        tool_def("hologram_cycle", "Get all detected data flow cycles. Filter by mode: all, data, llm.",
            &[("mode", "string", "Filter: all, data, or llm (default all)")], &[]),
        tool_def("hologram_thread_conflicts", "Get thread × resource conflict matrix.",
            &[("node_id", "string", "Optional node ID — if omitted, returns global matrix")], &[]),
        tool_def("hologram_coupling_report", "Get complete coupling depth distribution (L1-L4 stats).",
            &[("module_name", "string", "Module file name or path")], &["module_name"]),
        tool_def("hologram_timeline", "Query the causal audit timeline.",
            &[("limit", "integer", "Max events to return (default 100)"), ("since", "string", "ISO timestamp filter (optional)")], &[]),

        // ── V2 boundary (1) ──
        tool_def("hologram_blindspots", "Get all detected boundaries (L4 violations, unlocked concurrency, LLM feedback loops).",
            &[("filter", "string", "Boundary type filter: all, L4, thread, cycle (default all)")], &[]),

        // ── V3 preflight (1) ──
        tool_def("hologram_run_preflight", "Pre-flight check: analyze what would happen if the given files change.",
            &[("files", "array", "List of file paths that would be changed")], &["files"]),

        // ── V3+ parity (5) ──
        tool_def("hologram_search", "Fuzzy search for nodes by name or ID.",
            &[("query", "string", "Partial name or ID to search for"), ("limit", "integer", "Max results (default 20)")], &["query"]),
        tool_def("hologram_explore", "Unified query: Flow + Blast Radius + Relationships + Source Code + Architecture Alerts. Accepts natural language query or symbol names, returns everything in one response.",
            &[("query", "string", "Natural language query (e.g. 'DataRequest validate task'). Auto-extracts symbol names."), ("symbols", "array", "List of symbol names (alternative to query)"), ("includeSource", "boolean", "Include source code sections (default true)")], &[]),
        tool_def("hologram_graph_summary", "Get a high-level summary of the current dependency graph.",
            &[], &[]),
        tool_def("hologram_clusters", "Report on cluster/community structure in the codebase.",
            &[("min_size", "integer", "Minimum community size to report (default 3)"),
              ("max_nodes", "integer", "Max node IDs per community in output (default 20, max 200)")], &[]),
        tool_def("hologram_graph_diff", "Diff the current graph against a baseline snapshot.",
            &[("before_path", "string", "Path to the baseline graph JSON file")], &["before_path"]),
        tool_def("hologram_analyze", "Re-analyze a project directory and reload the graph.",
            &[("path", "string", "Project root directory path")], &["path"]),

        // ── V3 check + health (2) ──
        tool_def("hologram_run_check", "Run full constraint validation (V3) on the current project.",
            &[("path", "string", "Project root directory path")], &["path"]),
        tool_def("hologram_run_health", "Get current project health snapshot (trend requires historical data).",
            &[("path", "string", "Project root directory path"), ("days", "integer", "Days to look back (default 30)")], &["path"]),
        tool_def("hologram_rename", "Safely rename a symbol across all files with atomic rollback.",
            &[("oldName", "string", "Current name"), ("newName", "string", "New name"), ("dryRun", "boolean", "Preview only (default false)"), ("nodeId", "string", "Optional specific node ID")], &["oldName", "newName"]),
        tool_def("hologram_status", "Get engine loading status and memory stats.",
            &[], &[]),
        tool_def("hologram_policy_check", "Check project boundary rules against the dependency graph. Define rules with source/target file patterns (glob or regex) and edge kinds; returns violations where source files have forbidden edges to target files. Use this to enforce architectural boundaries (e.g. 'modules cannot import each other directly').",
            &[
                ("rules", "array", "JSON array of rule objects. Each rule: {name, source, target, edge_kinds?, message?}. source/target are glob or regex patterns. edge_kinds defaults to [\"imports\"]. Valid kinds: imports, calls, inherits, defines, reads, writes, shares, triggers, awaits, sequences."),
                ("source", "string", "Shortcut: single source file pattern (instead of full rules array)"),
                ("target", "string", "Shortcut: single target file pattern (instead of full rules array)"),
                ("edge_kinds", "array", "Shortcut: edge kinds for single-rule mode. Default: [\"imports\"]"),
            ],
            &[]),

        // ── V4 node deep-dive (1) ──
        tool_def("hologram_node", "Complete information about a single node — identity, degree, community, and all incoming/outgoing edges grouped by kind. Use after hologram_search to dive into a specific symbol, or when you need the full picture of a known node in one call instead of hologram_neighbors + hologram_community.",
            &[("node_id", "string", "The node ID")], &["node_id"]),

        // ── V4 dead code detection (1) ──
        tool_def("hologram_unused", "Find potentially unused symbols — nodes with zero incoming references (in_degree=0). Sorted by out_degree descending so the most impactful candidates appear first. Defaults to functions and classes; use kind_filter to expand scope.",
            &[
                ("limit", "integer", "Max results (default 20, max 200)"),
                ("kind_filter", "string", "Node kinds to include, comma-separated. Default: \"function,class\". Options: symbol, function, class, module, interface, medium, temporal."),
            ],
            &[]),

        // ── Dataflow tracing (1) ──
        tool_def("hologram_dataflow", "Per-function variable reads/writes, cross-function shared state, async triggers, and call sequences. Run on specific files to answer \"where is X written?\", \"who reads Y?\", \"which functions share Z?\".",
            &[
                ("files", "array", "File paths, e.g. [\"src/auth.js\", \"src/db.js\"]"),
            ],
            &["files"]),
    ]
}

fn tool_def(name: &str, desc: &str, props: &[(&str, &str, &str)], required: &[&str]) -> Value {
    let mut properties = serde_json::Map::new();
    for (pname, ptype, pdesc) in props {
        properties.insert(pname.to_string(), json!({
            "type": *ptype,
            "description": *pdesc,
        }));
    }
    let required: Vec<Value> = required.iter().map(|r| json!(r)).collect();
    json!({
        "name": name,
        "description": desc,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        }
    })
}

/// Discover source files in project root using supported language extensions.
/// ponytail: single helper replaces 4× repeated extension-fetch + discover_files.
fn discover_source_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let exts: Vec<String> = GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    discover_files(root, &ext_strs).into_iter().take(limit).collect()
}

// ═══════════════════════════════════════════════════════════════
// MCP Server
// ═══════════════════════════════════════════════════════════════

pub struct McpServer {
    /// Path to the project root directory (for re-analysis, timeline, etc.)
    /// Wrapped in Mutex so tool_analyze can switch projects at runtime.
    project_root: Mutex<PathBuf>,
}

impl McpServer {
    pub fn new(project_root: &Path) -> Self {
        Self {
            project_root: Mutex::new(project_root.to_path_buf()),
        }
    }

    /// Get a clone of the current project root.
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

    fn tool_result(id: &Value, data: Value) -> Value {
        let text = serde_json::to_string(&data).unwrap_or_default();
        McpServer::success_response(id, json!({
            "content": [{ "type": "text", "text": text }],
            "_meta": {
                "generator": "HoloGram v4.0",
                "license": "MIT",
                "copyright": "Copyright (c) 2026 Wenbing Jing"
            }
        }))
    }

    /// Like tool_result but detects embedded {"error": "..."} in closures
    /// and converts them to proper JSON-RPC error responses.
    fn result_or_error(id: &Value, data: Value) -> Value {
        if let Some(msg) = data.get("error").and_then(|e| e.as_str()) {
            McpServer::error_response(id, -32603, msg)
        } else {
            McpServer::tool_result(id, data)
        }
    }

    // ── initialize ──

    fn handle_initialize(&self, id: &Value) -> Value {
        info!("MCP initialize handshake");
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
            }
        }))
    }

    // ── tools/list ──

    fn handle_tools_list(&self, id: &Value) -> Value {
        McpServer::success_response(id, json!({ "tools": tool_definitions() }))
    }

    // ── tools/call dispatch ──

    fn handle_tools_call(&self, request: &Value, id: &Value) -> Value {
        let empty_params = json!({});
        let params = request.get("params").unwrap_or(&empty_params);
        let tool_name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));

        let result = crate::tools::ToolRegistry::dispatch(tool_name, &args);
        Self::result_or_error(id, result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // MUTEX enforces serial access to the process-wide CACHED_GRAPH static,
    // preventing parallel MCP tests from stepping on each other.
    static MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // ── Helpers ──

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

    /// Load a test graph into Engine's MemoryIndex.
    /// Returns the lock guard so the graph stays live until the guard
    /// is dropped at the end of the test.
    fn load_test_graph() -> std::sync::MutexGuard<'static, ()> {
        let guard = MUTEX.lock().unwrap();
        clear_graph();
        let tmp = std::env::temp_dir().join("hologram_mcp_test");
        let _ = std::fs::create_dir_all(&tmp);
        let _ = engine::engine_init(&tmp);
        let _ = engine::engine_write(|idx| {
            let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
            a.location = Some("src/a.rs".into());
            a.out_degree = 2;
            idx.insert_node(a);
            let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
            b.location = Some("src/b.rs".into());
            b.in_degree = 1;
            idx.insert_node(b);
            let mut m = Node::new("m1", "shared_db", NodeKind::Medium);
            m.location = Some("store.rs".into());
            idx.insert_node(m);
            idx.upsert_edge("a", "b", EdgeKind::Calls, 2, None);
            idx.upsert_edge("a", "m1", EdgeKind::Writes, 4, None);
        });
        // Persist to SQLite so FTS5 search works
        let _ = engine::engine_save();
        guard
    }

    fn clear_graph() {
        // Clear test data from Engine. We rebuild a fresh MemoryIndex and swap it in.
        // This avoids borrow-checker issues with iterating while mutating.
        let _ = engine::engine_write(|idx| {
            // Remove all nodes (edges go with them automatically)
            let ids: Vec<String> = {
                idx.nodes_iter().map(|n| n.id.clone()).collect()
            };
            for id in &ids {
                idx.remove_node(id);
            }
        });
    }

    // ── parse_serve_args ──

    #[test]
    fn test_parse_serve_args_basic() {
        // parse_serve_args reads from real argv; we can only test the parsing logic indirectly.
        // This test verifies that when NOT in serve mode, it returns None.
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
        assert_eq!(tools.len(), 27, "27 tools defined");
        // Check key tools exist
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"hologram_neighbors"));
        assert!(names.contains(&"hologram_analyze"));
        assert!(names.contains(&"hologram_run_preflight"));
        assert!(names.contains(&"hologram_rename"));
        assert!(names.contains(&"hologram_dataflow"));
    }

    #[test]
    fn test_tool_call_unknown_tool() {
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_nonexistent", json!({}), 2)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    // ── Tool: neighbors ──

    #[test]
    fn test_neighbors_missing_node_id() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_neighbors", json!({}), 3)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_neighbors_node_not_found() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_neighbors",
            json!({"node_id": "nonexistent"}), 4)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        // error is now a proper JSON-RPC error, not embedded in result
        assert!(v["error"]["message"].as_str().unwrap().contains("not found"));
    }

    #[test]
    fn test_neighbors_returns_data() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_neighbors",
            json!({"node_id": "a"}), 5)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert_eq!(data["node"]["id"], "a");
        assert!(data["neighbor_count"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_neighbors_no_graph() {
        let _g = MUTEX.lock().unwrap();
        let srv = server();
        clear_graph();
        let req = serde_json::to_string(&make_tool_call("hologram_neighbors",
            json!({"node_id": "a"}), 6)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    // ── Tool: impact ──

    #[test]
    fn test_impact_missing_node_id() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_impact", json!({}), 7)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_impact_with_default_depth() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_impact",
            json!({"node_id": "a"}), 8)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert_eq!(data["max_depth"], 3);
        assert_eq!(data["source_node_id"], "a");
    }

    // ── Tool: path ──

    #[test]
    fn test_path_missing_params() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_path", json!({}), 9)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_path_found() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_path",
            json!({"from_id": "a", "to_id": "b"}), 10)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert_eq!(data["path_count"], 1);
    }

    // ── Tool: history ──

    #[test]
    fn test_history_returns_data() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_history",
            json!({"node_id": "a"}), 11)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        // Node "a" has 2 outgoing edges, 0 incoming → dependent_count=2
        assert!(data["dependent_count"].as_u64().unwrap() > 0);
        assert_eq!(data["dependency_count"], 0);
    }

    // ── Tool: community ──

    #[test]
    fn test_community_returns_data() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_community",
            json!({"node_id": "a"}), 12)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert_eq!(data["node_id"], "a");
        assert!(data.get("community").is_some());
    }

    // ── Tool: delayed ──

    #[test]
    fn test_delayed_empty() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_delayed", json!({}), 13)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        // No temporal edges in test graph
        assert_eq!(data["total_delayed_edges"], 0);
    }

    // ── Tool: fragile ──

    #[test]
    fn test_fragile_returns_top_n() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_fragile",
            json!({"limit": 2}), 14)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert_eq!(data["limit"], 2);
        assert!(data["fragile_modules"].as_array().unwrap().len() <= 2);
    }

    // ── Tool: cycle ──

    #[test]
    fn test_cycle_default_mode() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_cycle", json!({}), 15)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert_eq!(data["mode_filter"], "all");
    }

    // ── Tool: thread_conflicts ──

    #[test]
    fn test_thread_conflicts() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_thread_conflicts",
            json!({}), 16)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data.get("resources").is_some());
    }

    // ── Tool: coupling_report ──

    #[test]
    fn test_coupling_report_missing_module() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_coupling_report",
            json!({}), 17)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_coupling_report_with_module() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_coupling_report",
            json!({"module_name": "a"}), 18)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data["total_edges"].as_u64().unwrap() > 0);
    }

    // ── Tool: timeline ──

    #[test]
    fn test_timeline() {
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_timeline",
            json!({"limit": 10}), 19)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert!(v.get("result").is_some() || v.get("error").is_some());
    }

    // ── Tool: blindspots ──

    #[test]
    fn test_blindspots() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_blindspots",
            json!({"filter": "all"}), 20)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data.get("boundaries").is_some());
    }

    /// F3 regression: tool_blindspots must detect thread conflicts (was hardcoded 0).
    /// Add a second concurrent writer to a Medium without locks and verify
    /// the "concurrent_access" boundary appears in the result.
    #[test]
    fn test_blindspots_reports_thread_conflicts() {
        let _g = load_test_graph();
        // Add a second writer to "m1" (the shared_db medium) to create a conflict
        let mut node_c = Node::new("c", "mod_c", NodeKind::Symbol);
        node_c.location = Some("src/c.rs".into());
        let _ = engine::engine_write(|idx| {
            idx.insert_node(node_c);
            idx.upsert_edge("c", "m1", EdgeKind::Writes, 4, None);
            // Also add one more node reading m1 to make incoming.len() > 1
            let mut node_d = Node::new("d", "mod_d", NodeKind::Symbol);
            node_d.location = Some("src/d.rs".into());
            idx.insert_node(node_d);
            idx.upsert_edge("d", "m1", EdgeKind::Reads, 2, None);
        });

        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_blindspots",
            json!({"filter": "all"}), 21)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();

        let boundaries = data["boundaries"].as_array().unwrap();
        let has_thread = boundaries.iter().any(|b| b["type"] == "concurrent_access");
        assert!(has_thread,
            "F3 regression: blindspots should report thread conflicts. Got boundaries: {:?}",
            boundaries);

        // Clean up — remove the extra nodes so subsequent tests get a clean 3-node graph
        let _ = engine::engine_write(|idx| {
            idx.remove_node("c");
            idx.remove_node("d");
        });
    }

    // ── Tool: preflight ──

    #[test]
    fn test_preflight_missing_files() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_run_preflight", json!({}), 21)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_preflight_with_files() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_run_preflight",
            json!({"files": ["src/a.rs"]}), 22)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data["risk_level"].as_str().is_some());
    }

    // ── Tool: search ──

    #[test]
    fn test_search_missing_query() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_search", json!({}), 23)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_search_finds_nodes() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_search",
            json!({"query": "mod"}), 24)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data["count"].as_u64().unwrap() > 0);
    }

    // ── Tool: graph_summary ──

    #[test]
    fn test_graph_summary() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_graph_summary", json!({}), 25)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data["nodes_total"].as_u64().unwrap() >= 3, "at least test nodes present");
        assert!(data["edges_total"].as_u64().unwrap() >= 2, "at least test edges present");
    }

    // ── Tool: community_report ──

    #[test]
    fn test_community_report() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_clusters",
            json!({"min_size": 1}), 26)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data.get("total_communities").is_some());
    }

    // ── Tool: diff ──

    #[test]
    fn test_diff_missing_before_path() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_graph_diff", json!({}), 27)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    // ── Tool: run_health ──

    #[test]
    fn test_run_health_missing_path() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_run_health", json!({}), 28)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    // ── Tool: rename ──

    #[test]
    fn test_rename_missing_names() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_rename", json!({}), 29)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_rename_dry_run() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_rename",
            json!({"oldName": "mod_a", "newName": "module_a", "dryRun": true}), 30)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        assert!(data["dry_run"].as_bool().unwrap());
        assert_eq!(data["matched_count"], 1);
    }

    // ── Tool: explore ──

    #[test]
    fn test_explore_missing_symbols() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_explore",
            json!({}), 31)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32603);
    }

    #[test]
    fn test_explore_with_query() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_explore",
            json!({"query": "mod_a mod_b"}), 35)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();
        // NL query should extract mod_a and mod_b, producing flow + blast + etc.
        assert!(data["flow"]["path"].is_array(), "NL query should produce flow");
        assert!(data["nodeIds"].as_array().unwrap().len() >= 2, "Should find at least 2 nodes");
    }

    #[test]
    fn test_explore_with_symbols() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_explore",
            json!({"symbols": ["mod_a", "mod_b"]}), 32)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();

        // Flow should exist between mod_a and mod_b
        assert!(data["flow"]["path"].is_array(), "Flow path should be an array");

        // Relationships should have calls
        assert!(data["relationships"]["calls"].is_array(), "Should have calls relationship");

        // Blast radius should be present
        assert!(data["blastRadius"]["dependents"].is_array());

        // Architecture alerts should be present (may be empty object)
        assert!(data["architectureAlerts"].is_object());

        // Node IDs for 3D linkage
        assert!(data["nodeIds"].is_array());

        // Meta
        assert!(data["meta"]["totalSymbolsFound"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_explore_single_symbol() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_explore",
            json!({"symbols": ["mod_a"]}), 33)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();

        // Flow should be null with only 1 symbol
        assert_eq!(data["flow"], json!(null));

        // But other sections should still work
        assert!(data["nodeIds"].is_array());
    }

    #[test]
    fn test_explore_no_source() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_explore",
            json!({"symbols": ["mod_a", "mod_b"], "includeSource": false}), 34)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        let data: Value = serde_json::from_str(text).unwrap();

        // Source code should be empty
        let source = data["sourceCode"].as_array().unwrap();
        assert!(source.is_empty(), "sourceCode should be empty when includeSource=false");
    }
}
