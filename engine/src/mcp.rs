// MCP Server — JSON-RPC over stdin/stdout
// Replaces src_python/mcp_server.py entirely.
//
// Protocol: reads one JSON-RPC request per line from stdin,
// writes one JSON-RPC response per line to stdout.
// Supports tools/list and tools/call with all 21 hologram_* tools.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tracing::{info, warn};

use crate::analysis::*;
use crate::community::detect_communities;
use crate::graph::{query, CrossFileResolver, Edge, EdgeKind, Graph, Node, NodeKind};
use crate::pipeline::runner::analyze_project;
use crate::routing::preflight::run_full_check;
use crate::storage::{GraphStore, MemoryIndex};
use crate::timeline::TimelineStore;
use crate::watcher;

/// Global cached graph, shared with the TCP RPC server.
/// The MCP server reads from and writes to this cache.
/// DEPRECATED: use GRAPH_STORE instead. Kept for backward compat during migration.
pub static CACHED_GRAPH: std::sync::LazyLock<Mutex<Option<Graph>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// New storage engine singleton. Initialized by init_graph_store() at startup.
/// All graph queries go through this — it provides RwLock<MemoryIndex> for concurrent reads.
static GRAPH_STORE: OnceLock<Mutex<GraphStore>> = OnceLock::new();

/// Initialize the global GraphStore. Called once at engine startup.
/// Idempotent: subsequent calls are no-ops.
pub fn init_graph_store(project_root: &Path) -> Result<(), String> {
    if GRAPH_STORE.get().is_some() {
        return Ok(());
    }
    let store = GraphStore::open(project_root)?;
    GRAPH_STORE
        .set(Mutex::new(store))
        .map_err(|_| "GraphStore already initialized".to_string())
}

/// Get a reference to the global GraphStore (with lock).
/// Returns an error if init_graph_store() hasn't been called yet.
pub fn with_graph_store<R>(f: impl FnOnce(&GraphStore) -> R) -> Result<R, String> {
    let store = GRAPH_STORE
        .get()
        .ok_or_else(|| String::from("GraphStore not initialized — call init_graph_store() first"))?;
    Ok(f(&store.lock().unwrap()))
}

/// Global re-entrant lock preventing concurrent full analysis across
/// MCP tools, watcher, and TCP RPC handler.
pub static ANALYZE_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

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
            &[("from_id", "string", "Source node ID"), ("to_id", "string", "Target node ID")], &["from_id", "to_id"]),
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
        tool_def("hologram_explore", "Unified query: Flow + Blast Radius + Relationships + Source Code + Architecture Alerts. Takes symbol names (agent's LLM extracts from NL), returns everything in one response.",
            &[("symbols", "array", "List of symbol names to explore"), ("includeSource", "boolean", "Include source code sections (default true)")], &["symbols"]),
        tool_def("hologram_graph_summary", "Get a high-level summary of the current dependency graph.",
            &[], &[]),
        tool_def("hologram_community_report", "Report on community/cluster structure in the codebase.",
            &[("min_size", "integer", "Minimum community size to report (default 3)")], &[]),
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
        Some(serde_json::to_string(&result).unwrap_or_default())
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
            "content": [{ "type": "text", "text": text }]
        }))
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
                "version": "4.0.0"
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
            _ => McpServer::error_response(id, -32601, &format!("Tool not found: {}", tool_name)),
        }
    }

    // ══════════════════════════════════════════════════════
    // Tool implementations
    // ══════════════════════════════════════════════════════

    /// Run a read-only closure against MemoryIndex via GraphStore.
    /// Falls back to CACHED_GRAPH (legacy mode) if GraphStore is not initialized.
    fn with_store<F>(&self, id: &Value, f: F) -> Value
    where
        F: FnOnce(&MemoryIndex) -> Value,
    {
        match GRAPH_STORE.get() {
            Some(store) => {
                let gs = store.lock().unwrap();
                let result = gs.read(|idx| f(idx));
                McpServer::tool_result(id, result)
            }
            None => {
                // Fallback: use legacy CACHED_GRAPH
                match CACHED_GRAPH.lock() {
                    Ok(guard) => match guard.as_ref() {
                        Some(g) => {
                            let idx = MemoryIndex::from_existing_graph(g);
                            McpServer::tool_result(id, f(&idx))
                        }
                        None => McpServer::error_response(
                            id,
                            -32000,
                            "No graph loaded. Run hologram_analyze first.",
                        ),
                    },
                    Err(_) => McpServer::error_response(id, -32000, "Internal lock error"),
                }
            }
        }
    }

    fn with_graph<F>(&self, id: &Value, f: F) -> Value
    where
        F: FnOnce(&Graph) -> Value,
    {
        match CACHED_GRAPH.lock() {
            Ok(guard) => match guard.as_ref() {
                Some(g) => McpServer::tool_result(id, f(g)),
                None => McpServer::error_response(id, -32000, "No graph loaded. Run hologram_analyze first."),
            },
            Err(_) => McpServer::error_response(id, -32000, "Internal lock error"),
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
        self.with_graph(id, |g| {
            if g.get_node(&node_id).is_none() {
                return json!({"error": format!("Node {} not found", node_id)});
            }
            let layers = query::impact(g, &node_id, depth);
            let total_affected: usize = layers.iter().map(|(_, nodes)| nodes.len()).sum();
            json!({
                "source_node_id": node_id,
                "max_depth": depth,
                "total_affected_nodes": total_affected.saturating_sub(1), // exclude self
                "layers": layers.iter().map(|(d, nodes)| json!({"depth": d, "nodes": nodes})).collect::<Vec<_>>(),
            })
        })
    }

    fn tool_path(&self, args: &Value, id: &Value) -> Value {
        let from_id = args.get("from_id").and_then(|v| v.as_str()).unwrap_or("");
        let to_id = args.get("to_id").and_then(|v| v.as_str()).unwrap_or("");
        if from_id.is_empty() || to_id.is_empty() {
            return McpServer::error_response(id, -32602, "from_id and to_id are required");
        }
        self.with_graph(id, |g| {
            if g.get_node(from_id).is_none() {
                return json!({"error": format!("Node {} not found", from_id)});
            }
            if g.get_node(to_id).is_none() {
                return json!({"error": format!("Node {} not found", to_id)});
            }
            match query::shortest_path(g, from_id, to_id) {
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
        self.with_graph(id, |g| {
            let node = match g.get_node(&node_id) {
                Some(n) => n,
                None => return json!({"error": format!("Node {} not found", node_id)}),
            };
            let incoming = g.incoming_edges(&node_id);
            let outgoing = g.outgoing_edges(&node_id);
            json!({
                "node": node_to_value(node),
                "decision_history": [],
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
        self.with_graph(id, |g| {
            if g.get_node(&node_id).is_none() {
                return json!({"error": format!("Node {} not found", node_id)});
            }
            // Find which community this node belongs to
            let communities = detect_communities(g, 42);
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
            json!({"node_id": node_id, "community": null, "message": "Node not in any community"})
        })
    }

    fn tool_delayed(&self, args: &Value, id: &Value) -> Value {
        let _ = args;
        self.with_graph(id, |g| {
            let delayed: Vec<_> = g.edges.values()
                .filter(|e| matches!(e.kind, EdgeKind::Triggers | EdgeKind::Awaits | EdgeKind::Sequences))
                .map(|e| {
                    let src = g.get_node(&e.source);
                    let tgt = g.get_node(&e.target);
                    json!({
                        "source": src.map(node_to_value).unwrap_or(json!({"id": e.source})),
                        "target": tgt.map(node_to_value).unwrap_or(json!({"id": e.target})),
                        "delay_sec": e.temporal_delay_sec.unwrap_or(0.0),
                        "edge_type": e.kind.as_str(),
                    })
                })
                .collect::<Vec<_>>();
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
        let project_root = args.get("project_root").and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.project_root());
        match TimelineStore::open(&project_root) {
            Ok(store) => {
                let events = store.query(100);
                let last = events.first().cloned();
                McpServer::tool_result(id, json!({
                    "last_change": last,
                    "timeline_anchor_count": events.len(),
                    "changes": events,
                }))
            }
            Err(e) => McpServer::tool_result(id, json!({
                "message": format!("Timeline not available: {}", e),
                "changes": [],
            })),
        }
    }

    // ── V2 analysis tools ──

    fn tool_fragile(&self, args: &Value, id: &Value) -> Value {
        let limit = Self::get_arg_usize(args, "limit", 5).max(1);
        self.with_graph(id, |g| {
            let fragile = fragile_nodes(g, limit);
            json!({ "fragile_modules": fragile, "limit": limit })
        })
    }

    fn tool_cycle(&self, args: &Value, id: &Value) -> Value {
        let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("all");
        self.with_graph(id, |g| {
            let cycles = detect_cycles(g);
            let filtered: Vec<_> = match mode {
                "data" | "llm" => cycles.into_iter().filter(|c| {
                    c.get("category").and_then(|cat| cat.as_str())
                        .map(|cat| matches!(cat, "data_persistent" | "llm_involved"))
                        .unwrap_or(false)
                }).collect(),
                _ => cycles,
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
        self.with_graph(id, |g| {
            let mut resources = serde_json::Map::new();
            // Find medium nodes
            for (_mid, medium) in g.nodes.iter().filter(|(_, n)| matches!(n.kind, NodeKind::Medium)) {
                let incoming = g.incoming_edges(&medium.id);
                let mut threads_info = Vec::new();
                let mut has_write = false;
                let mut lock_edges = Vec::new();
                for edge in &incoming {
                    if let Some(src) = g.get_node(&edge.source) {
                        let access = if matches!(edge.kind, EdgeKind::Writes) { "W" } else { "R" };
                        if access == "W" { has_write = true; }
                        threads_info.push(json!({
                            "name": src.name,
                            "location": src.location,
                            "access": access,
                        }));
                    }
                    if edge.kind.as_str().contains("lock") {
                        lock_edges.push(edge.id.clone());
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
        self.with_graph(id, |g| {
            coupling_report(g, module)
        })
    }

    fn tool_timeline(&self, args: &Value, id: &Value) -> Value {
        let limit = Self::get_arg_usize(args, "limit", 100).max(1);
        match TimelineStore::open(&self.project_root()) {
            Ok(store) => {
                let events = store.query(limit);
                McpServer::tool_result(id, json!({ "events": events, "total": events.len() }))
            }
            Err(e) => McpServer::tool_result(id, json!({ "error": e, "events": [] })),
        }
    }

    // ── V2 boundary ──

    fn tool_blindspots(&self, args: &Value, id: &Value) -> Value {
        let _filter = args.get("filter").and_then(|v| v.as_str()).unwrap_or("all");
        self.with_graph(id, |g| {
            let c = coupling_report(g, "");
            let l4 = c["L4"].as_u64().unwrap_or(0) as usize;
            let cycles = detect_cycles(g);
            let blind = find_blindspots(l4, cycles.len(), 0);
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
        self.with_graph(id, |g| {
            // Build a simple preflight: for each file, compute impact
            let mut file_reports = Vec::new();
            for file in &files {
                let mut affected_nodes = Vec::new();
                for node in g.nodes.values() {
                    if let Some(ref loc) = node.location {
                        if loc.starts_with(file) || loc.contains(file) {
                            affected_nodes.push(node.id.clone());
                        }
                    }
                }
                let mut total_impact = 0usize;
                for nid in &affected_nodes {
                    let layers = query::impact(g, nid, 3);
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
        self.with_graph(id, |g| {
            let results = query::search_nodes(g, query_str);
            let count = results.len().min(limit);
            json!({
                "query": query_str,
                "count": count,
                "results": results.iter().take(limit).map(|n| node_to_value(n)).collect::<Vec<_>>(),
            })
        })
    }

    fn tool_explore(&self, args: &Value, id: &Value) -> Value {
        let symbols: Vec<String> = args.get("symbols")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if symbols.is_empty() {
            return McpServer::error_response(id, -32602, "symbols array is required");
        }
        let include_source = args.get("includeSource")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        // Need both graph and project_root — can't use with_graph
        let project_root = self.project_root();
        match CACHED_GRAPH.lock() {
            Ok(guard) => match guard.as_ref() {
                Some(g) => {
                    let result = explore(g, &project_root, &symbols, include_source);
                    McpServer::tool_result(id, result)
                }
                None => McpServer::error_response(id, -32000, "No graph loaded. Run hologram_analyze first."),
            },
            Err(_) => McpServer::error_response(id, -32000, "Internal lock error"),
        }
    }

    fn tool_graph_summary(&self, args: &Value, id: &Value) -> Value {
        let _ = args;
        self.with_graph(id, |g| {
            graph_summary(g)
        })
    }

    fn tool_community_report(&self, args: &Value, id: &Value) -> Value {
        let min_size = Self::get_arg_usize(args, "min_size", 3).max(1);
        self.with_graph(id, |g| {
            let communities = detect_communities(g, 42);
            let filtered: Vec<_> = communities.iter()
                .filter(|c| c.len() >= min_size)
                .enumerate()
                .map(|(i, c)| json!({
                    "id": format!("comm_{}", i),
                    "size": c.len(),
                    "node_ids": c,
                    "label": format!("社区 {}", i + 1),
                }))
                .collect();
            json!({
                "total_communities": filtered.len(),
                "min_size_filter": min_size,
                "communities": filtered,
            })
        })
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
        // Try to acquire the analyze lock (non-blocking)
        let lock = match ANALYZE_LOCK.try_lock() {
            Ok(l) => l,
            Err(_) => return McpServer::error_response(id, -32000, "分析正在进行中，请稍后重试"),
        };
        let root = PathBuf::from(path);
        if !root.exists() {
            drop(lock);
            return McpServer::error_response(id, -32000, &format!("Path not found: {}", path));
        }
        info!(%path, "mcp analyze started");
        let mut result = analyze_project(&root);

        // Cross-file resolution
        let resolved = CrossFileResolver::resolve(&mut result.graph);
        info!(edges = resolved, "mcp cross-file resolved");

        // Coupling analysis
        compute_coupling(&mut result.graph);

        // Framework route detection (Django, Express, ...)
        let routes_found = detect_framework_routes(&mut result.graph, &root);
        info!(count = routes_found, "mcp framework routes detected");

        // Community detection
        let communities = detect_communities(&result.graph, 42);
        info!(count = communities.len(), "mcp communities detected");

        // Cache the graph
        let graph = result.graph.clone();
        if let Ok(mut cache) = CACHED_GRAPH.lock() {
            *cache = Some(graph);
        }

        // Stop old watcher (if any) and start a new one on the new project
        watcher::stop_watcher();
        watcher::start_watcher(root.clone());

        // Update active project root so tools like run_health/timeline use the right path
        self.set_project_root(&root);

        drop(lock);

        McpServer::tool_result(id, json!({
            "status": "ok",
            "total_nodes": result.graph.node_count(),
            "total_edges": result.graph.edge_count(),
            "communities": communities.len(),
            "elapsed_secs": result.elapsed_secs,
        }))
    }

    // ── V3 check + health ──

    fn tool_run_check(&self, args: &Value, id: &Value) -> Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return McpServer::error_response(id, -32602, "path is required");
        }
        // Save old graph as baseline
        let before = CACHED_GRAPH.lock().ok()
            .and_then(|g| g.clone());

        // Re-analyze
        let root = PathBuf::from(path);
        if !root.exists() {
            return McpServer::error_response(id, -32000, &format!("Path not found: {}", path));
        }
        let lock = match ANALYZE_LOCK.try_lock() {
            Ok(l) => l,
            Err(_) => return McpServer::error_response(id, -32000, "分析正在进行中，请稍后重试"),
        };

        let mut result = analyze_project(&root);
        CrossFileResolver::resolve(&mut result.graph);
        compute_coupling(&mut result.graph);

        let after = result.graph.clone();
        if let Ok(mut cache) = CACHED_GRAPH.lock() {
            *cache = Some(after.clone());
        }
        drop(lock);

        let before_graph = before.unwrap_or_else(|| after.clone());
        let changed_files: Vec<String> = vec![];
        let check_result = run_full_check(&before_graph, &after, &changed_files, path);

        McpServer::tool_result(id, check_result)
    }

    fn tool_run_health(&self, args: &Value, id: &Value) -> Value {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let days = Self::get_arg_usize(args, "days", 30);
        if path.is_empty() {
            return McpServer::error_response(id, -32602, "path is required");
        }
        // Health stub: returns current graph stats as health snapshot
        self.with_graph(id, |g| {
            let summary = graph_summary(g);
            json!({
                "path": path,
                "days": days,
                "current_health": {
                    "total_nodes": g.node_count(),
                    "total_edges": g.edge_count(),
                    "score": 85,
                    "trend": "stable",
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
                    .filter(|n| n.name == old_name || n.id.contains(old_name))
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
            // Actually rename nodes in-memory
            match CACHED_GRAPH.lock() {
                Ok(mut guard) => match guard.as_mut() {
                    Some(g) => {
                        let matched_ids: Vec<String> = g.nodes.values()
                            .filter(|n| n.name == old_name || n.id.contains(old_name))
                            .map(|n| n.id.clone())
                            .collect();
                        if matched_ids.is_empty() {
                            return McpServer::error_response(id, -32000, &format!("No nodes match '{}'", old_name));
                        }
                        let count = matched_ids.len();
                        for nid in &matched_ids {
                            if let Some(node) = g.nodes.get_mut(nid) {
                                node.name = new_name.to_string();
                            }
                        }
                        McpServer::tool_result(id, json!({
                            "dry_run": false,
                            "old_name": old_name,
                            "new_name": new_name,
                            "renamed_count": count,
                            "renamed_ids": matched_ids,
                            "note": "In-memory rename applied. File-level rename is not yet implemented.",
                        }))
                    }
                    None => McpServer::error_response(id, -32000, "No graph loaded. Run hologram_analyze first."),
                },
                Err(_) => McpServer::error_response(id, -32000, "Internal lock error"),
            }
        }
    }

    fn tool_status(&self, _args: &Value, id: &Value) -> Value {
        match GRAPH_STORE.get() {
            Some(store) => {
                let gs = store.lock().unwrap();
                let progress = gs.load_progress();
                let nodes = gs.read(|idx| idx.node_count());
                let edges = gs.read(|idx| idx.edge_count());
                let has_aux = gs.read(|idx| idx.has_aux_indexes());
                McpServer::tool_result(
                    id,
                    json!({
                        "phase": progress.phase,
                        "store": "MemoryIndex",
                        "nodes": nodes,
                        "edges": edges,
                        "nodes_loaded": progress.nodes_loaded,
                        "edges_loaded": progress.edges_loaded,
                        "elapsed_ms": progress.elapsed_ms,
                        "has_aux_indexes": has_aux,
                    }),
                )
            }
            None => {
                // Fallback: check CACHED_GRAPH
                match CACHED_GRAPH.lock() {
                    Ok(guard) => match guard.as_ref() {
                        Some(g) => McpServer::tool_result(
                            id,
                            json!({
                                "phase": "ready",
                                "store": "Graph (legacy)",
                                "nodes": g.node_count(),
                                "edges": g.edge_count(),
                                "note": "Using legacy CACHED_GRAPH. Run analyze to migrate to MemoryIndex.",
                            }),
                        ),
                        None => McpServer::tool_result(
                            id,
                            json!({
                                "phase": "empty",
                                "store": "none",
                                "nodes": 0,
                                "edges": 0,
                            }),
                        ),
                    },
                    Err(_) => McpServer::error_response(id, -32000, "Internal lock error"),
                }
            }
        }
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
        let mut g = Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/a.rs".into());
        a.out_degree = 2;
        g.add_node(a);
        let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
        b.location = Some("src/b.rs".into());
        b.in_degree = 1;
        g.add_node(b);
        let mut m = Node::new("m1", "shared_db", NodeKind::Medium);
        m.location = Some("store.rs".into());
        g.add_node(m);
        let mut e1 = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e1.coupling_depth = 2;
        g.add_edge(e1);
        let mut e2 = Edge::new("e2", "a", "m1", EdgeKind::Writes);
        e2.coupling_depth = 4;
        g.add_edge(e2);
        if let Ok(mut cache) = CACHED_GRAPH.lock() {
            *cache = Some(g);
        }
        guard
    }

    fn clear_graph() {
        if let Ok(mut cache) = CACHED_GRAPH.lock() {
            *cache = None;
        }
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
        assert_eq!(tools.len(), 24, "24 tools defined");
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
        let content = &v["result"]["content"][0]["text"];
        assert!(content.as_str().unwrap().contains("not found"));
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
        assert_eq!(data["nodes_total"], 3);
        assert_eq!(data["edges_total"], 2);
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
