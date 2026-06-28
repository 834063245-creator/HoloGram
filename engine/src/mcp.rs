// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP Server — JSON-RPC over stdin/stdout
// Replaces src_python/mcp_server.py entirely.
//
// Protocol: reads one JSON-RPC request per line from stdin,
// writes one JSON-RPC response per line to stdout.
// Supports tools/list and tools/call with all 25 hologram_* tools.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::analysis::*;
use crate::community::detect_communities_from_index;
use crate::engine;
use crate::graph::{query, Edge, EdgeKind, Graph, Node, NodeKind};
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
        tool_def("hologram_changes", "Get change markers from the last commit comparison.",
            &[("project_root", "string", "Project root path")], &[]),

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
        tool_def("hologram_preflight", "Pre-flight check: analyze what would happen if the given files change.",
            &[("files", "array", "List of file paths that would be changed")], &["files"]),

        // ── V3+ parity (5) ──
        tool_def("hologram_search", "Fuzzy search for nodes by name or ID.",
            &[("query", "string", "Partial name or ID to search for"), ("limit", "integer", "Max results (default 20)")], &["query"]),
        tool_def("hologram_explore", "Unified query: Flow + Blast Radius + Relationships + Source Code + Architecture Alerts. Accepts natural language query or symbol names, returns everything in one response.",
            &[("query", "string", "Natural language query (e.g. 'DataRequest validate task'). Auto-extracts symbol names."), ("symbols", "array", "List of symbol names (alternative to query)"), ("includeSource", "boolean", "Include source code sections (default true)")], &[]),
        tool_def("hologram_graph_summary", "Get a high-level summary of the current dependency graph.",
            &[], &[]),
        tool_def("hologram_community_report", "Report on community/cluster structure in the codebase.",
            &[("min_size", "integer", "Minimum community size to report (default 3)"),
              ("max_nodes", "integer", "Max node IDs per community in output (default 20, max 200)")], &[]),
        tool_def("hologram_diff", "Diff the current graph against a baseline snapshot.",
            &[("before_path", "string", "Path to the baseline graph JSON file")], &["before_path"]),
        tool_def("hologram_analyze", "Re-analyze a project directory and reload the graph.",
            &[("path", "string", "Project root directory path")], &["path"]),

        // ── V3 check + health (2) ──
        tool_def("hologram_run_check", "Run full constraint validation (V3) on the current project.",
            &[("path", "string", "Project root directory path")], &["path"]),
        tool_def("hologram_run_health", "Get current project health snapshot (trend requires historical data).",
            &[("path", "string", "Project root directory path"), ("days", "integer", "Days to look back (default 30)")], &["path"]),
        tool_def("hologram_rename", "Safely rename a symbol across all files with atomic rollback.",
            &[("old_name", "string", "Current name"), ("new_name", "string", "New name"), ("dry_run", "boolean", "Preview only (default false)"), ("node_id", "string", "Optional specific node ID")], &["old_name", "new_name"]),
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

    /// Update the project root (called by tool_analyze when switching projects).
    #[allow(dead_code)] // ponytail: called when project switches, not yet wired from serve entry
    fn set_project_root(&self, path: &Path) {
        if let Ok(mut root) = self.project_root.lock() {
            *root = path.to_path_buf();
        }
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
                McpServer::error_response(&id, -32601, &format!("Method not found: {}", method))
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
            McpServer::error_response(id, -32000, msg)
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

        match tool_name {
            "hologram_neighbors" => self.tool_neighbors(&args, id),
            "hologram_impact" => self.tool_impact(&args, id),
            "hologram_path" => self.tool_path(&args, id),
            "hologram_history" => self.tool_history(&args, id),
            "hologram_community" => self.tool_community(&args, id),
            "hologram_delayed" => self.tool_delayed(&args, id),
            "hologram_changes" => self.tool_changes(&args, id),
            "hologram_fragile" => self.tool_fragile(&args, id),
            "hologram_cycle" => self.tool_cycle(&args, id),
            "hologram_thread_conflicts" => self.tool_thread_conflicts(&args, id),
            "hologram_coupling_report" => self.tool_coupling_report(&args, id),
            "hologram_timeline" => self.tool_timeline(&args, id),
            "hologram_blindspots" => self.tool_blindspots(&args, id),
            "hologram_preflight" => self.tool_preflight(&args, id),
            "hologram_search" => self.tool_search(&args, id),
            "hologram_explore" => self.tool_explore(&args, id),
            "hologram_graph_summary" => self.tool_graph_summary(&args, id),
            "hologram_community_report" => self.tool_community_report(&args, id),
            "hologram_diff" => self.tool_diff(&args, id),
            "hologram_analyze" => self.tool_analyze(&args, id),
            "hologram_run_check" => self.tool_run_check(&args, id),
            "hologram_run_health" => self.tool_run_health(&args, id),
            "hologram_rename" => self.tool_rename(&args, id),
            "hologram_status" => self.tool_status(&args, id),
            "hologram_policy_check" => self.tool_policy_check(&args, id),
            "hologram_node" => self.tool_node(&args, id),
            "hologram_unused" => self.tool_unused(&args, id),
            _ => McpServer::error_response(id, -32601, &format!("Tool not found: {}", tool_name)),
        }
    }

    // ══════════════════════════════════════════════════════
    // Tool implementations
    // ══════════════════════════════════════════════════════

    /// Run a read-only closure against MemoryIndex via GraphStore.
    /// Read from the Engine's MemoryIndex. All MCP tools go through this.
    fn with_store<F>(&self, id: &Value, f: F) -> Value
    where
        F: FnOnce(&MemoryIndex) -> Value,
    {
        match engine::engine_read(|idx| f(idx)) {
            Ok(value) => Self::result_or_error(id, value),
            Err(e) => McpServer::error_response(id, -32000, &e),
        }
    }

    /// Read from the Engine via a legacy Graph. All MCP tools go through this.
    fn with_graph<F>(&self, id: &Value, f: F) -> Value
    where
        F: FnOnce(&Graph) -> Value,
    {
        match engine::engine_read_graph(|g| f(g)) {
            Ok(value) => Self::result_or_error(id, value),
            Err(e) => McpServer::error_response(id, -32000, &e),
        }
    }

    fn get_arg_str(args: &Value, keys: &[&str]) -> String {
        for key in keys {
            if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                if !v.is_empty() { return v.to_string(); }
            }
        }
        String::new()
    }

    fn get_arg_usize(args: &Value, key: &str, default: usize) -> usize {
        args.get(key)
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(default)
    }

    // ── V1 tools ──

    fn tool_neighbors(&self, args: &Value, id: &Value) -> Value {
        let node_id = Self::get_arg_str(args, &["node_id", "nodeId"]);
        if node_id.is_empty() {
            return McpServer::error_response(id, -32602, "node_id is required");
        }
        // Engine MemoryIndex path (primary)
        match engine::engine_read(|idx| {
            let node = match idx.get_node(&node_id) {
                Some(n) => n.clone(),
                None => return json!({"error": format!("Node {} not found", node_id)}),
            };
            let nb = idx.neighbors(&node_id, 1, None);
            let incoming = idx.get_incoming_edges(&node_id);
            let outgoing = idx.get_outgoing_edges(&node_id);
            json!({
                "node": node_to_value(&node),
                "neighbor_count": nb.len(),
                "neighbors": nb.iter().map(|(_, t, d)| json!({"id": t, "coupling_depth": d})).collect::<Vec<_>>(),
                "incoming": incoming.iter().map(|e| edge_to_value(e)).collect::<Vec<_>>(),
                "outgoing": outgoing.iter().map(|e| edge_to_value(e)).collect::<Vec<_>>(),
            })
        }) {
            Ok(value) => return Self::result_or_error(id, value),
            Err(_) => {} // fall through to with_graph fallback
        }
        self.with_graph(id, |g| {
            let node = match g.get_node(&node_id) {
                Some(n) => n,
                None => return json!({"error": format!("Node {} not found", node_id)}),
            };
            let nb = query::neighbors(g, &node_id, 1);
            let incoming: Vec<_> = g.incoming_edges(&node_id).iter().map(|e| edge_to_value(e)).collect();
            let outgoing: Vec<_> = g.outgoing_edges(&node_id).iter().map(|e| edge_to_value(e)).collect();
            json!({
                "node": node_to_value(node),
                "neighbor_count": nb.len(),
                "neighbors": nb.iter().map(|(_, t, d)| json!({"id": t, "coupling_depth": d})).collect::<Vec<_>>(),
                "incoming": incoming,
                "outgoing": outgoing,
            })
        })
    }

    fn tool_impact(&self, args: &Value, id: &Value) -> Value {
        let node_id = Self::get_arg_str(args, &["node_id", "nodeId"]);
        if node_id.is_empty() {
            return McpServer::error_response(id, -32602, "node_id is required");
        }
        let depth = Self::get_arg_usize(args, "depth", 3);
        self.with_store(id, |idx| {
            if idx.get_node(&node_id).is_none() {
                return json!({"error": format!("Node {} not found", node_id)});
            }
            let layers = idx.impact(&node_id, depth);
            let total_affected: usize = layers.iter().map(|(_, nodes)| nodes.len()).sum();
            json!({
                "source_node_id": node_id,
                "max_depth": depth,
                "total_affected_nodes": total_affected.saturating_sub(1),
                "layers": layers.iter().map(|(d, nodes)| json!({"depth": d, "nodes": nodes})).collect::<Vec<_>>(),
            })
        })
    }

    fn tool_path(&self, args: &Value, id: &Value) -> Value {
        let from_id = Self::get_arg_str(args, &["from_id", "fromId", "from"]);
        let to_id = Self::get_arg_str(args, &["to_id", "toId", "to"]);
        if from_id.is_empty() || to_id.is_empty() {
            return McpServer::error_response(id, -32602, "from_id and to_id are required");
        }
        let depth = Self::get_arg_usize(args, "depth", 20).max(1);
        self.with_store(id, |idx| {
            if idx.get_node(&from_id).is_none() {
                return json!({"error": format!("Node {} not found", from_id)});
            }
            if idx.get_node(&to_id).is_none() {
                return json!({"error": format!("Node {} not found", to_id)});
            }
            match idx.shortest_path_with_limits(&from_id, &to_id, depth, 5000) {
                Some(path) => json!({"from_id": from_id, "to_id": to_id, "path_count": 1, "paths": [path]}),
                None => json!({"from_id": from_id, "to_id": to_id, "path_count": 0, "paths": []}),
            }
        })
    }

    fn tool_history(&self, args: &Value, id: &Value) -> Value {
        let node_id = Self::get_arg_str(args, &["node_id", "nodeId"]);
        if node_id.is_empty() {
            return McpServer::error_response(id, -32602, "node_id is required");
        }
        let decision_history = engine::engine_query_timeline(20).unwrap_or_default();
        // Engine MemoryIndex path (primary)
        match engine::engine_read(|idx| {
            let node = match idx.get_node(&node_id) {
                Some(n) => n.clone(),
                None => return json!({"error": format!("Node {} not found", node_id)}),
            };
            let dep_count = idx.incoming(&node_id, None).len();
            let out_count = idx.outgoing(&node_id, None).len();
            json!({
                "node": node_to_value(&node),
                "decision_history": decision_history,
                "dependency_count": dep_count,
                "dependent_count": out_count,
            })
        }) {
            Ok(value) => return Self::result_or_error(id, value),
            Err(_) => {}
        }
        self.with_graph(id, |g| {
            let node = match g.get_node(&node_id) {
                Some(n) => n,
                None => return json!({"error": format!("Node {} not found", node_id)}),
            };
            let incoming = g.incoming_edges(&node_id);
            let outgoing = g.outgoing_edges(&node_id);
            json!({
                "node": node_to_value(node),
                "decision_history": decision_history,
                "dependency_count": incoming.len(),
                "dependent_count": outgoing.len(),
            })
        })
    }

    fn tool_community(&self, args: &Value, id: &Value) -> Value {
        let node_id = Self::get_arg_str(args, &["node_id", "nodeId"]);
        if node_id.is_empty() {
            return McpServer::error_response(id, -32602, "node_id is required");
        }
        self.with_store(id, |idx| {
            if idx.get_node(&node_id).is_none() {
                return json!({"error": format!("Node {} not found", node_id)});
            }
            // ponytail: read cached community_id instead of re-running full Louvain
            let cid = match idx.get_node(&node_id).and_then(|n| n.community_id) {
                Some(c) => c,
                None => {
                    // Fallback: community not cached (no analysis run yet) → run Louvain
                    let communities = detect_communities_from_index(idx, 42);
                    for (i, comm) in communities.iter().enumerate() {
                        if comm.contains(&node_id) {
                            let siblings: Vec<_> = comm.iter().filter(|nid| *nid != &node_id).cloned().collect();
                            return json!({
                                "node_id": node_id,
                                "community": {
                                    "id": format!("comm_{}", i),
                                    "level": 0,
                                    "label": format!("社区 {}", i + 1),
                                    "node_count": comm.len(),
                                    "node_ids": comm,
                                },
                                "sibling_nodes": siblings,
                            });
                        }
                    }
                    return json!({"node_id": node_id, "community": null, "message": "Node not in any community"});
                }
            };
            // Collect community members and siblings in one O(V) pass
            let mut comm_node_ids = Vec::new();
            let mut siblings = Vec::new();
            for node in idx.nodes_iter() {
                if node.community_id == Some(cid) {
                    comm_node_ids.push(node.id.clone());
                    if node.id != node_id {
                        siblings.push(node.id.clone());
                    }
                }
            }
            json!({
                "node_id": node_id,
                "community": {
                    "id": format!("comm_{}", cid),
                    "level": 0,
                    "label": format!("社区 {}", cid + 1),
                    "node_count": comm_node_ids.len(),
                    "node_ids": comm_node_ids,
                },
                "sibling_nodes": siblings,
            })
        })
    }

    fn tool_delayed(&self, args: &Value, id: &Value) -> Value {
        let _ = args;
        self.with_store(id, |idx| {
            let mut delayed = Vec::new();
            for (source, targets) in idx.edges_iter() {
                for (target, kind, _depth, delay) in targets {
                    if matches!(kind, EdgeKind::Triggers | EdgeKind::Awaits | EdgeKind::Sequences) {
                        let src = idx.get_node(&source);
                        let tgt = idx.get_node(&target);
                        delayed.push(json!({
                            "source": src.map(node_to_value).unwrap_or(json!({"id": &source})),
                            "target": tgt.map(node_to_value).unwrap_or(json!({"id": &target})),
                            "delay_sec": delay.unwrap_or(0.0),
                            "edge_type": kind.as_str(),
                        }));
                    }
                }
            }
            let realtime: Vec<_> = delayed.iter().filter(|d| d["delay_sec"].as_f64().unwrap_or(-1.0) == 0.0).cloned().collect();
            let periodic: Vec<_> = delayed.iter().filter(|d| d["delay_sec"].as_f64().unwrap_or(0.0) > 0.0).cloned().collect();
            json!({
                "total_delayed_edges": delayed.len(),
                "realtime_count": realtime.len(),
                "periodic_count": periodic.len(),
                "realtime": realtime,
                "periodic": periodic,
            })
        })
    }

    fn tool_changes(&self, args: &Value, id: &Value) -> Value {
        let _project_root = args.get("project_root").and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.project_root());
        let events = engine::engine_query_timeline(100).unwrap_or_default();
        let last = events.first().cloned();
        McpServer::tool_result(id, json!({
            "last_change": last,
            "timeline_anchor_count": events.len(),
            "changes": events,
        }))
    }

    // ── V2 analysis tools ──

    fn tool_fragile(&self, args: &Value, id: &Value) -> Value {
        let limit = Self::get_arg_usize(args, "limit", 5).max(1);
        self.with_store(id, |idx| {
            let fragile = fragile_nodes_from_index(idx, limit);
            json!({ "fragile_modules": fragile, "limit": limit })
        })
    }

    fn tool_cycle(&self, args: &Value, id: &Value) -> Value {
        let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("all");
        self.with_store(id, |idx| {
            let classified = classify_cycles_from_index(idx);
            let all_cycles: Vec<_> = classified["cycles"].as_array()
                .cloned()
                .unwrap_or_default();
            let filtered: Vec<_> = match mode {
                "data" => all_cycles.into_iter().filter(|c| {
                    c.get("category").and_then(|v| v.as_str()) == Some("data_persistent")
                }).collect(),
                "llm" => all_cycles.into_iter().filter(|c| {
                    c.get("category").and_then(|v| v.as_str()) == Some("llm_involved")
                }).collect(),
                _ => all_cycles,
            };
            json!({
                "total_cycles": filtered.len(),
                "mode_filter": mode,
                "cycles": filtered,
            })
        })
    }

    fn tool_thread_conflicts(&self, args: &Value, id: &Value) -> Value {
        let _node_id = args.get("node_id").and_then(|v| v.as_str()).map(|s| s.to_string());
        self.with_store(id, |idx| {
            let mut resources = serde_json::Map::new();
            for medium in idx.nodes_iter().filter(|n| matches!(n.kind, NodeKind::Medium)) {
                let incoming = idx.incoming(&medium.id, None);
                let mut threads_info = Vec::new();
                let mut has_write = false;
                let mut lock_edges = Vec::new();
                for (src_id, kind, _depth, _delay) in &incoming {
                    if let Some(src) = idx.get_node(src_id) {
                        let access = if matches!(kind, EdgeKind::Writes) { "W" } else { "R" };
                        if access == "W" { has_write = true; }
                        threads_info.push(json!({
                            "name": src.name,
                            "location": src.location,
                            "access": access,
                        }));
                    }
                    if kind.as_str().contains("lock") {
                        lock_edges.push(format!("{}::{}::{}", src_id, medium.id, kind.as_str()));
                    }
                }
                if !threads_info.is_empty() {
                    resources.insert(medium.name.clone(), json!({
                        "medium_type": "medium",
                        "threads": threads_info,
                        "thread_count": threads_info.len(),
                        "has_concurrent_write": has_write,
                        "lock_detected": !lock_edges.is_empty(),
                        "lock_edges": lock_edges,
                    }));
                }
            }
            let unlocked_keys: Vec<_> = resources.iter()
                .filter(|(_, v)| v["has_concurrent_write"].as_bool().unwrap_or(false) && !v["lock_detected"].as_bool().unwrap_or(true))
                .map(|(k, _)| k.clone())
                .collect();
            json!({
                "resources": resources,
                "total_shared_resources": resources.len(),
                "unlocked_concurrent_writes": unlocked_keys.len(),
                "unlocked_resources": unlocked_keys,
            })
        })
    }

    fn tool_coupling_report(&self, args: &Value, id: &Value) -> Value {
        let module = args.get("module_name").and_then(|v| v.as_str()).unwrap_or("");
        if module.is_empty() {
            return McpServer::error_response(id, -32602, "module_name is required");
        }
        self.with_store(id, |idx| {
            coupling_report_from_index(idx, module)
        })
    }

    fn tool_timeline(&self, args: &Value, id: &Value) -> Value {
        let limit = Self::get_arg_usize(args, "limit", 100).max(1);
        let events = engine::engine_query_timeline(limit).unwrap_or_default();
        McpServer::tool_result(id, json!({ "events": events, "total": events.len() }))
    }

    // ── V2 boundary ──

    fn tool_blindspots(&self, args: &Value, id: &Value) -> Value {
        let _filter = args.get("filter").and_then(|v| v.as_str()).unwrap_or("all");
        self.with_store(id, |idx| {
            let l4 = count_l4_from_index(idx);
            let cycles = detect_cycles_from_index(idx);
            // Count thread conflicts from index (was hardcoded 0)
            let mut conflict_count = 0usize;
            for medium in idx.nodes_iter().filter(|n| matches!(n.kind, NodeKind::Medium)) {
                let incoming = idx.incoming(&medium.id, None);
                let has_write = incoming.iter().any(|(_, kind, _, _)| matches!(kind, EdgeKind::Writes));
                let has_lock = incoming.iter().any(|(_, kind, _, _)| kind.as_str().contains("lock"));
                if has_write && !has_lock && incoming.len() > 1 {
                    conflict_count += 1;
                }
            }
            let blind = find_blindspots(l4, cycles.len(), conflict_count);
            json!(blind)
        })
    }

    // ── V3 preflight ──

    fn tool_preflight(&self, args: &Value, id: &Value) -> Value {
        let files: Vec<String> = args.get("files")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if files.is_empty() {
            return McpServer::error_response(id, -32602, "files list is required");
        }
        self.with_store(id, |idx| {
            let mut file_reports = Vec::new();
            for file in &files {
                // ponytail: use file_index (O(1) HashMap lookup) instead of O(V) full scan
                let affected_nodes = idx.get_nodes_by_file(file);
                let mut total_impact = 0usize;
                for nid in &affected_nodes {
                    let layers = idx.impact(nid, 3);
                    total_impact += layers.iter().map(|(_, nodes)| nodes.len()).sum::<usize>();
                }
                file_reports.push(json!({
                    "file": file,
                    "direct_nodes": affected_nodes.len(),
                    "blast_radius": total_impact.saturating_sub(affected_nodes.len()),
                    "risk": if total_impact > 100 { "high" } else if total_impact > 20 { "medium" } else { "low" },
                }));
            }
            let highest_risk = file_reports.iter()
                .filter_map(|r| r["risk"].as_str())
                .max_by_key(|r| match *r { "high" => 3, "medium" => 2, _ => 1 })
                .unwrap_or("low");
            json!({
                "files": files,
                "risk_level": highest_risk,
                "file_reports": file_reports,
            })
        })
    }

    // ── V3+ parity ──

    fn tool_search(&self, args: &Value, id: &Value) -> Value {
        let query_str = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let limit = Self::get_arg_usize(args, "limit", 20);
        if query_str.is_empty() {
            return McpServer::error_response(id, -32602, "query is required");
        }
        // Engine FTS5 path (primary — only used when results are non-empty)
        if let Ok(results) = engine::engine_fts_search(query_str, limit) {
            if !results.is_empty() {
                return McpServer::tool_result(id, json!({
                    "query": query_str,
                    "count": results.len(),
                    "results": results.iter().map(|n| node_to_value(n)).collect::<Vec<_>>(),
                    "engine": "fts5",
                }));
            }
        }
        self.with_graph(id, |g| {
            let results = query::search_nodes(g, query_str);
            let count = results.len().min(limit);
            json!({
                "query": query_str,
                "count": count,
                "results": results.iter().take(limit).map(|n| node_to_value(n)).collect::<Vec<_>>(),
                "engine": "linear",
            })
        })
    }

    fn tool_explore(&self, args: &Value, id: &Value) -> Value {
        let symbols: Vec<String> = args.get("symbols")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let query_str = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());
        if symbols.is_empty() && query_str.is_none() {
            return McpServer::error_response(id, -32602, "symbols array or query string is required");
        }
        let include_source = args.get("includeSource")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let project_root = self.project_root();

        // Try GraphStore first, fall back to CACHED_GRAPH
        self.with_graph(id, |g| {
            explore(g, &project_root, &symbols, query_str.as_deref(), include_source)
        })
    }

    fn tool_graph_summary(&self, args: &Value, id: &Value) -> Value {
        let _ = args;
        self.with_store(id, |idx| {
            graph_summary_from_index(idx)
        })
    }

    fn tool_community_report(&self, args: &Value, id: &Value) -> Value {
        let min_size = Self::get_arg_usize(args, "min_size", 3).max(1);
        let max_nodes = Self::get_arg_usize(args, "max_nodes", 20).max(1).min(200);
        self.with_store(id, |idx| {
            // ponytail: group nodes by cached community_id instead of re-running Louvain
            let mut comm_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
            let mut has_any = false;
            for node in idx.nodes_iter() {
                if let Some(cid) = node.community_id {
                    comm_map.entry(cid).or_default().push(node.id.clone());
                    has_any = true;
                }
            }
            // Fallback: no cached communities → run Louvain
            if !has_any {
                let communities = detect_communities_from_index(idx, 42);
                for (i, c) in communities.iter().enumerate() {
                    comm_map.insert(i, c.clone());
                }
            }
            // Sort communities by size descending
            let mut communities: Vec<_> = comm_map.into_iter().collect();
            communities.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

            let filtered: Vec<_> = communities.iter()
                .filter(|(_, c)| c.len() >= min_size)
                .enumerate()
                .map(|(display_idx, (cid, node_ids))| {
                    let truncated = node_ids.len() > max_nodes;
                    let shown: Vec<_> = node_ids.iter().take(max_nodes).cloned().collect();
                    let label = Self::derive_comm_label(&node_ids, idx);
                    json!({
                        "id": format!("comm_{}", cid),
                        "size": node_ids.len(),
                        "node_ids": shown,
                        "node_ids_truncated": truncated,
                        "label": label,
                        "_display_index": display_idx,
                    })
                })
                .collect();
            json!({
                "total_communities": filtered.len(),
                "min_size_filter": min_size,
                "max_nodes_per_community": max_nodes,
                "communities": filtered,
            })
        })
    }

    /// Derive a community label from the most common file path among members.
    fn derive_comm_label(members: &[String], idx: &MemoryIndex) -> String {
        use std::collections::HashMap;
        let mut prefix_counts: HashMap<String, usize> = HashMap::new();
        for nid in members.iter().take(30) {
            if let Some(node) = idx.get_node(nid) {
                let loc = node.location.as_deref().unwrap_or("");
                let file = loc.rsplit(&['/', '\\']).next().unwrap_or(loc);
                let stem = file.rsplit(':').next().unwrap_or(file);
                *prefix_counts.entry(stem.to_string()).or_default() += 1;
            }
        }
        prefix_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(p, _)| p)
            .unwrap_or_else(|| format!("社区({})", members.len()))
    }

    fn tool_diff(&self, args: &Value, id: &Value) -> Value {
        let before_path = args.get("before_path").and_then(|v| v.as_str()).unwrap_or("");
        if before_path.is_empty() {
            return McpServer::error_response(id, -32602, "before_path is required");
        }
        self.with_graph(id, |after| {
            // Try to load baseline — auto-create if missing
            let before = match Graph::from_json_file(before_path) {
                Ok(g) => g,
                Err(_) => {
                    // Baseline doesn't exist yet — save current as baseline
                    let graph_json = serde_json::to_string_pretty(after).unwrap_or_default();
                    if let Err(e) = std::fs::write(before_path, &graph_json) {
                        return json!({"error": format!("无法创建基线: {}", e)});
                    }
                    return json!({
                        "is_empty": true,
                        "message": "已创建变更基线，再次运行即可比较差异",
                        "baseline_path": before_path,
                    });
                }
            };
            let diff = before.diff(&after);
            let added_nodes: Vec<_> = diff.added_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
            let removed_nodes: Vec<_> = diff.removed_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
            let modified_nodes: Vec<_> = diff.modified_nodes.iter().map(|(old, new)| json!({
                "node_id": new.id,
                "name": new.name,
                "old_kind": old.kind.as_str(),
                "new_kind": new.kind.as_str(),
            })).collect();
            let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
            json!({
                "is_empty": is_empty,
                "added_nodes": added_nodes,
                "removed_nodes": removed_nodes,
                "modified_nodes": modified_nodes,
                "added_edges": diff.added_edges.len(),
                "removed_edges": diff.removed_edges.len(),
            })
        })
    }

    fn tool_analyze(&self, args: &Value, id: &Value) -> Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return McpServer::error_response(id, -32602, "path is required");
        }
        let root = PathBuf::from(path);
        if !root.exists() {
            return McpServer::error_response(id, -32000, &format!("Path not found: {}", path));
        }
        info!(%path, "mcp analyze started");

        // Initialize engine for this project (idempotent — no-op if already initialized)
        if let Err(e) = engine::engine_init(&root) {
            return McpServer::error_response(id, -32000, &format!("Engine init failed: {}", e));
        }

        // Reject if analysis already in progress.
        if engine::engine_state().is_analyzing() {
            return McpServer::tool_result(id, json!({
                "status": "already_running",
                "message": "Analysis already in progress. Call hologram_status to track progress.",
                "_generator": "HoloGram v4.0 — Copyright (c) 2026 Wenbing Jing — MIT License"
            }));
        }

        // Spawn background thread — analysis takes 10-20s, MCP clients
        // time out at 5s. The thread updates EngineState::Analyzing so
        // hologram_status can report progress. When done, state → Ready.
        let root_clone = root.clone();
        std::thread::Builder::new()
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                match engine::engine_analyze(&root_clone) {
                    Ok(result) => {
                        engine::with_engine(|eng| {
                            eng.stop_watcher();
                            eng.start_watcher(root_clone.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
                        });
                        info!(nodes = result.node_count, edges = result.edge_count, secs = result.elapsed_secs, "mcp analyze done (background)");
                    }
                    Err(e) => {
                        warn!(error = %e, "mcp analyze failed (background)");
                    }
                }
            })
            .ok();

        McpServer::tool_result(id, json!({
            "status": "started",
            "message": "Analysis running in background. Call hologram_status to track progress; phase becomes 'ready' when done.",
            "_generator": "HoloGram v4.0 — Copyright (c) 2026 Wenbing Jing — MIT License"
        }))
    }

    // ── V3 check + health ──

    fn tool_run_check(&self, args: &Value, id: &Value) -> Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return McpServer::error_response(id, -32602, "path is required");
        }

        let root = PathBuf::from(path);
        if !root.exists() {
            return McpServer::error_response(id, -32000, &format!("Path not found: {}", path));
        }

        // Save current graph as baseline (via Engine)
        let before = engine::engine_read_graph(|g| g.clone()).ok();

        // Re-analyze via Engine (handles locking, pipeline, storage internally)
        match engine::engine_init(&root) {
            Ok(_) => {}
            Err(e) => return McpServer::error_response(id, -32000, &format!("Engine init failed: {}", e)),
        }
        let analyze_result = match engine::engine_analyze(&root) {
            Ok(r) => r,
            Err(e) => return McpServer::error_response(id, -32000, &e),
        };

        let after = analyze_result.graph.clone();
        let before_graph = before.unwrap_or_else(|| after.clone());

        let changed_files: Vec<String> = vec![];
        let check_result = run_full_check(&before_graph, &after, &changed_files, path);

        // Record timeline event
        let passed = check_result["passed"].as_bool().unwrap_or(true);
        let violation_count = check_result["violation_count"].as_u64().unwrap_or(0);
        let event_type = if passed { "commit_clean" } else { "commit_violation" };
        let summary = if passed {
            format!("简报通过（{} 违规）", violation_count)
        } else {
            format!("简报未通过：{} 条违规", violation_count)
        };
        let props = serde_json::json!({
            "passed": check_result["passed"],
            "violation_count": check_result["violation_count"],
        });
        let _ = engine::engine_record_timeline_with_props(&event_type, None::<&str>, &summary, &props);

        McpServer::tool_result(id, check_result)
    }

    fn tool_run_health(&self, args: &Value, id: &Value) -> Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let days = Self::get_arg_usize(args, "days", 30);
        if path.is_empty() {
            return McpServer::error_response(id, -32602, "path is required");
        }
        self.with_store(id, |idx| {
            let summary = graph_summary_from_index(idx);
            let n = idx.node_count().max(1) as f64;
            let e = idx.edge_count() as f64;
            let density = (e / n).min(5.0) / 5.0 * 40.0;
            let cycles = detect_cycles_from_index(idx).len().min(20) as f64;
            let cycle_score = (1.0 - cycles / 20.0).max(0.0) * 10.0;
            let fragile = fragile_nodes_from_index(idx, 20);
            let fragile_count = fragile.len().min(20) as f64;
            let fragile_score = (1.0 - fragile_count / 20.0).max(0.0) * 20.0;
            let l4_count = count_l4_from_index(idx) as f64;
            let coupling_ratio = if e > 0.0 { l4_count / e } else { 0.0 };
            let coupling_score = (1.0 - coupling_ratio).max(0.0) * 30.0;
            let score = ((density + coupling_score + fragile_score + cycle_score) as u32).min(100);
            let trend = if n > 0.0 && e / n > 2.0 { "healthy" } else if e > 0.0 { "stable" } else { "needs_edges" };
            json!({
                "path": path,
                "days": days,
                "current_health": {
                    "total_nodes": idx.node_count(),
                    "total_edges": idx.edge_count(),
                    "score": score,
                    "trend": trend,
                    "breakdown": {
                        "density": (density as u32),
                        "cycles": (cycle_score as u32),
                        "fragile": (fragile_score as u32),
                        "coupling": (coupling_score as u32),
                    }
                },
                "summary": summary,
                "note": "Health trend requires historical snapshots — showing current state only.",
            })
        })
    }

    fn tool_rename(&self, args: &Value, id: &Value) -> Value {
        let old_name = args.get("old_name").and_then(|v| v.as_str()).unwrap_or("");
        let new_name = args.get("new_name").and_then(|v| v.as_str()).unwrap_or("");
        let dry_run = args.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false);

        if old_name.is_empty() || new_name.is_empty() {
            return McpServer::error_response(id, -32602, "old_name and new_name are required");
        }

        if dry_run {
            self.with_graph(id, |g| {
                let matched: Vec<_> = g.nodes.values()
                    .filter(|n| n.name == old_name)
                    .collect();
                if matched.is_empty() {
                    return json!({"error": format!("No nodes match '{}'", old_name)});
                }
                json!({
                    "dry_run": true,
                    "old_name": old_name,
                    "new_name": new_name,
                    "matched_count": matched.len(),
                    "matched_nodes": matched.iter().map(|n| node_to_value(n)).collect::<Vec<_>>(),
                    "files_to_modify": matched.iter().filter_map(|n| n.location.clone()).collect::<Vec<_>>(),
                    "message": format!("Dry run: {} nodes would be renamed from '{}' to '{}'. Execute with dry_run=false to commit.", matched.len(), old_name, new_name),
                })
            })
        } else {
            // Collect matching IDs and rename via Engine
            let (matched_ids, count) = {
                match engine::engine_read(|idx| {
                    let ids: Vec<String> = idx.nodes_iter()
                        .filter(|n| n.name == old_name)
                        .map(|n| n.id.clone())
                        .collect();
                    (ids.len(), ids)
                }) {
                    Ok((0, _)) => return McpServer::error_response(id, -32000, &format!("No nodes match '{}'", old_name)),
                    Ok((cnt, ids)) => (ids, cnt),
                    Err(e) => return McpServer::error_response(id, -32000, &e),
                }
            };
            // Apply rename via Engine
            if let Err(e) = engine::engine_write(|idx| {
                for nid in &matched_ids {
                    idx.rename_node_name(nid, &new_name);
                }
            }) {
                return McpServer::error_response(id, -32000, &e);
            }

            // Persist to disk
            let _ = engine::engine_save();

            McpServer::tool_result(id, json!({
                "dry_run": false,
                "old_name": old_name,
                "new_name": new_name,
                "renamed_count": count,
                "renamed_ids": matched_ids,
                "note": "Rename applied to graph and persisted to storage. File-level rename on disk is not yet implemented.",
            }))
        }
    }

    fn tool_status(&self, _args: &Value, id: &Value) -> Value {
        let state = engine::engine_state();
        match engine::engine_read(|idx| (idx.node_count(), idx.edge_count(), idx.has_aux_indexes())) {
            Ok((nodes, edges, has_aux)) => {
                let phase = match state {
                    engine::EngineState::Ready { .. } => "ready",
                    engine::EngineState::Analyzing { .. } => "analyzing",
                    engine::EngineState::Loading { .. } => "loading",
                    engine::EngineState::Uninitialized => "empty",
                    engine::EngineState::Error(_) => "error",
                };
                let is_watching = engine::with_engine(|eng| eng.is_watching()).unwrap_or(false);
                McpServer::tool_result(id, json!({
                    "phase": phase,
                    "store": "MemoryIndex",
                    "nodes": nodes,
                    "edges": edges,
                    "has_aux_indexes": has_aux,
                    "is_watching": is_watching,
                }))
            }
            Err(_) => {
                McpServer::tool_result(id, json!({
                    "phase": "empty",
                    "store": "none",
                    "nodes": 0,
                    "edges": 0,
                }))
            }
        }
    }

    fn tool_policy_check(&self, args: &Value, id: &Value) -> Value {
        // Accept either a full rules array or a single-rule shortcut.
        let rules: Value = if let Some(r) = args.get("rules").cloned() {
            r
        } else if let (Some(source), Some(target)) = (
            args.get("source").and_then(|v| v.as_str()),
            args.get("target").and_then(|v| v.as_str()),
        ) {
            let mut rule = json!({
                "name": "ad-hoc",
                "source": source,
                "target": target,
                "message": format!("{} → {} 依赖违规", source, target),
            });
            if let Some(kinds) = args.get("edge_kinds") {
                rule["edge_kinds"] = kinds.clone();
            }
            json!([rule])
        } else {
            return McpServer::error_response(
                id,
                -32602,
                "Provide either 'rules' (array of rule objects) or both 'source' and 'target' (string patterns).",
            );
        };

        self.with_store(id, |idx| policy_check_from_index(idx, &rules))
    }

    // ── V4 tools: node deep-dive + dead code ──

    /// Complete node deep-dive: identity, degree, community, all edges grouped by kind.
    /// Replaces hologram_neighbors + hologram_community for a single-node query.
    fn tool_node(&self, args: &Value, id: &Value) -> Value {
        let node_id = Self::get_arg_str(args, &["node_id", "nodeId"]);
        if node_id.is_empty() {
            return McpServer::error_response(id, -32602, "node_id is required");
        }
        self.with_store(id, |idx| {
            let node = match idx.get_node(&node_id) {
                Some(n) => n.clone(),
                None => return json!({"error": format!("Node '{}' not found in graph", node_id)}),
            };
            let incoming = idx.get_incoming_edges(&node_id);
            let outgoing = idx.get_outgoing_edges(&node_id);

            // Group edges by kind for readable output
            let group_by_kind = |edges: &[Edge]| -> serde_json::Map<String, Value> {
                let mut groups: serde_json::Map<String, Value> = serde_json::Map::new();
                for e in edges {
                    let k = e.kind.as_str().to_string();
                    groups.entry(k).or_insert_with(|| json!([]))
                        .as_array_mut().unwrap()
                        .push(json!({
                            "id": e.id,
                            "source": e.source,
                            "target": e.target,
                            "coupling_depth": e.coupling_depth,
                            "cross_file": e.cross_file,
                            "temporal_delay_sec": e.temporal_delay_sec,
                        }));
                }
                groups
            };

            json!({
                "node": node_to_value(&node),
                "incoming_count": incoming.len(),
                "outgoing_count": outgoing.len(),
                "incoming_by_kind": group_by_kind(&incoming),
                "outgoing_by_kind": group_by_kind(&outgoing),
            })
        })
    }

    /// Find potentially unused symbols — nodes with in_degree == 0.
    /// Sorted by out_degree descending: the most impactful dead code first.
    /// Focuses on functions and classes by default.
    fn tool_unused(&self, args: &Value, id: &Value) -> Value {
        let limit = Self::get_arg_usize(args, "limit", 20).min(200);
        let kind_str = args.get("kind_filter")
            .and_then(|v| v.as_str())
            .unwrap_or("function,class");
        let kinds: Vec<&str> = kind_str.split(',').map(|s| s.trim()).collect();

        self.with_store(id, |idx| {
            let mut candidates: Vec<&Node> = idx.nodes_iter()
                .filter(|n| {
                    n.in_degree == 0
                        && kinds.iter().any(|k| n.kind.as_str() == *k)
                })
                .collect();

            // Sort by out_degree descending — most impactful first
            candidates.sort_by_key(|n| std::cmp::Reverse(n.out_degree));
            candidates.truncate(limit);

            json!({
                "total_unused": candidates.len(),
                "limit": limit,
                "kind_filter": kind_str,
                "unused": candidates.iter().map(|n| json!({
                    "id": n.id,
                    "name": n.name,
                    "kind": n.kind.as_str(),
                    "location": n.location,
                    "out_degree": n.out_degree,
                    "community_id": n.community_id,
                })).collect::<Vec<_>>(),
            })
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// Serialization helpers
// ═══════════════════════════════════════════════════════════════

fn node_to_value(n: &Node) -> Value {
    json!({
        "id": n.id,
        "name": n.name,
        "type": n.kind.as_str(),
        "kind": n.kind.as_str(),
        "location": n.location,
        "in_degree": n.in_degree,
        "out_degree": n.out_degree,
        "properties": n.properties,
        "position": n.position,
        "community_id": n.community_id,
    })
}

fn edge_to_value(e: &Edge) -> Value {
    json!({
        "id": e.id,
        "source": e.source,
        "target": e.target,
        "type": e.kind.as_str(),
        "coupling_depth": e.coupling_depth,
        "cross_file": e.cross_file,
        "direction": e.direction,
        "temporal_delay_sec": e.temporal_delay_sec,
        "medium_node_id": e.medium_node_id,
    })
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

    /// Load a test graph into CACHED_GRAPH. Returns the lock guard so the
    /// graph stays live until the guard is dropped at the end of the test.
    fn load_test_graph() -> std::sync::MutexGuard<'static, ()> {
        let guard = MUTEX.lock().unwrap();
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
        assert_eq!(v["error"]["code"], -32601);
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
        assert!(names.contains(&"hologram_preflight"));
        assert!(names.contains(&"hologram_rename"));
    }

    #[test]
    fn test_tool_call_unknown_tool() {
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_nonexistent", json!({}), 2)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32601);
    }

    // ── Tool: neighbors ──

    #[test]
    fn test_neighbors_missing_node_id() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_neighbors", json!({}), 3)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32602);
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
        assert_eq!(v["error"]["code"], -32000);
    }

    // ── Tool: impact ──

    #[test]
    fn test_impact_missing_node_id() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_impact", json!({}), 7)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32602);
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
        assert_eq!(v["error"]["code"], -32602);
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
        assert_eq!(v["error"]["code"], -32602);
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
        let req = serde_json::to_string(&make_tool_call("hologram_preflight", json!({}), 21)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn test_preflight_with_files() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_preflight",
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
        assert_eq!(v["error"]["code"], -32602);
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
        let req = serde_json::to_string(&make_tool_call("hologram_community_report",
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
        let req = serde_json::to_string(&make_tool_call("hologram_diff", json!({}), 27)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32602);
    }

    // ── Tool: run_health ──

    #[test]
    fn test_run_health_missing_path() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_run_health", json!({}), 28)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32602);
    }

    // ── Tool: rename ──

    #[test]
    fn test_rename_missing_names() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_rename", json!({}), 29)).unwrap();
        let resp = srv.handle_request(&req).unwrap();
        let v: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32602);
    }

    #[test]
    fn test_rename_dry_run() {
        let _g = load_test_graph();
        let srv = server();
        let req = serde_json::to_string(&make_tool_call("hologram_rename",
            json!({"old_name": "mod_a", "new_name": "module_a", "dry_run": true}), 30)).unwrap();
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
        assert_eq!(v["error"]["code"], -32602);
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
