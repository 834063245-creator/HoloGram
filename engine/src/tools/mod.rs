// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool registry — schema definitions + handler dispatch for all 27 hologram_* tools.
// Separated from MCP transport so Tauri / TCP / CLI can share the same tool layer.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{json, Value};

use crate::engine;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{query, Edge, Graph, Node};
use crate::pipeline::discovery::discover_files;
use crate::storage::MemoryIndex;

// ═══════════════════════════════════════════════════════════════
// ToolSchema — metadata for a single tool
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: &'static str,
    pub description: &'static str,
    pub params: &'static [ParamDef],
    pub required: &'static [&'static str],
    pub read_only: bool,
    pub category: &'static str,
}

#[derive(Debug, Clone)]
pub struct ParamDef {
    pub name: &'static str,
    pub ptype: &'static str,
    pub description: &'static str,
}

impl ToolSchema {
    fn mcp_value(&self) -> Value {
        let mut properties = serde_json::Map::new();
        for p in self.params {
            properties.insert(p.name.to_string(), json!({
                "type": p.ptype,
                "description": p.description,
            }));
        }
        let required: Vec<Value> = self.required.iter().map(|r| json!(r)).collect();
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// ToolRegistry — singleton dispatch
// ═══════════════════════════════════════════════════════════════

pub struct ToolRegistry;

static REGISTRY: LazyLock<ToolRegistry> = LazyLock::new(|| ToolRegistry);

impl ToolRegistry {
    pub fn global() -> &'static ToolRegistry {
        &REGISTRY
    }

    const DEFAULT_MCP_TOOLS: &[&str] = &[
        "explore_deps",
        "search_symbols",
        "get_neighbors",
        "trace_impact",
        "find_dep_path",
        "inspect_symbol",
        "get_community",
        "async_edges",
        "fragile_modules",
        "detect_cycles",
        "thread_conflicts",
        "coupling_report",
        "project_timeline",
        "arch_blindspots",
        "preflight_check",
        "graph_summary",
        "cluster_report",
        "graph_diff",
        "analyze_project",
        "validate_project",
        "project_health",
        "rename_symbol",
        "engine_status",
        "check_boundaries",
        "find_unused",
        "trace_dataflow",
        "resolve_call",
        "infer_type",
        "find_implementations",
        "find_references",
    ];

    fn get_active_tool_names() -> Vec<String> {
        match std::env::var("HOLOGRAM_MCP_TOOLS") {
            Ok(val) if val == "*" => all_schemas().iter().map(|s| s.name.to_string()).collect(),
            Ok(val) => val.split(',').map(|s| s.trim().to_string()).collect(),
            Err(_) => Self::DEFAULT_MCP_TOOLS.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn tools_list(&self) -> Vec<Value> {
        let active: HashSet<String> = Self::get_active_tool_names().into_iter().collect();
        all_schemas().iter()
            .filter(|s| active.contains(s.name))
            .map(|s| s.mcp_value())
            .collect()
    }

    pub fn get_schema(&self, name: &str) -> Option<&'static ToolSchema> {
        all_schemas().iter().find(|s| s.name == name)
    }

    pub fn dispatch(name: &str, args: &Value, id: &Value) -> Value {
        let resp = match name {
            "get_neighbors" => handlers::handler_neighbors(args),
            "trace_impact" => handlers::handler_impact(args),
            "find_dep_path" => handlers::handler_path(args),
            "inspect_symbol" | "symbol_history" => handlers::handler_node(args),
            "get_community" => handlers::handler_community(args),
            "async_edges" => handlers::handler_delayed(args),
            "fragile_modules" => handlers::handler_fragile(args),
            "detect_cycles" => handlers::handler_cycle(args),
            "thread_conflicts" => handlers::handler_thread_conflicts(args),
            "coupling_report" => handlers::handler_coupling_report(args),
            "project_timeline" => handlers::handler_timeline(args),
            "arch_blindspots" => handlers::handler_blindspots(args),
            "preflight_check" => handlers::handler_preflight(args),
            "search_symbols" => handlers::handler_search(args),
            "explore_deps" => handlers::handler_explore(args),
            "graph_summary" => handlers::handler_graph_summary(args),
            "cluster_report" => handlers::handler_clusters(args),
            "graph_diff" => handlers::handler_diff(args),
            "analyze_project" => handlers::handler_analyze(args),
            "validate_project" => handlers::handler_run_check(args),
            "project_health" => handlers::handler_run_health(args),
            "rename_symbol" => handlers::handler_rename(args),
            "engine_status" => handlers::handler_status(args),
            "check_boundaries" => handlers::handler_policy_check(args),
            "find_unused" => handlers::handler_unused(args),
            "trace_dataflow" => handlers::handler_dataflow(args),
            "resolve_call" => handlers::handler_resolve_call(args),
            "infer_type" => handlers::handler_resolve_type(args),
            "find_implementations" => handlers::handler_find_implementations(args),
            "find_references" => handlers::handler_find_references(args),
            _ => return ToolResponse::Degraded {
                guidance: format!("Tool not found: {}", name),
                fallback: "Check tools/list for available tools".into(),
                details: json!({}),
            }.to_mcp_value(id),
        };
        resp.to_mcp_value(id)
    }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════


mod handlers;
mod response;
pub(crate) use response::ToolResponse;
pub mod staleness;
pub(crate) fn get_str(args: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    String::new()
}

pub(crate) fn get_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or_else(|| {
            // Try camelCase variant (e.g. "min_size" → "minSize")
            let camel = snake_to_camel(key);
            args.get(&camel)
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(default)
        })
}

/// Convert snake_case to camelCase (e.g. "min_size" → "minSize", "node_id" → "nodeId")
pub(crate) fn snake_to_camel(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut upper = false;
    for ch in s.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            result.push(ch.to_ascii_uppercase());
            upper = false;
        } else {
            result.push(ch);
        }
    }
    result
}

pub(crate) fn project_root() -> PathBuf {
    engine::with_engine(|eng| eng.project_root()).unwrap_or_default()
}

pub(crate) fn with_store<F>(f: F) -> Value
where
    F: FnOnce(&MemoryIndex) -> Value,
{
    match engine::engine_read(|idx| f(idx)) {
        Ok(value) => value,
        Err(e) => json!({"error": e}),
    }
}

pub(crate) fn with_graph<F>(f: F) -> Value
where
    F: FnOnce(&Graph) -> Value,
{
    match engine::engine_read_graph(|g| f(g)) {
        Ok(value) => value,
        Err(e) => json!({"error": e}),
    }
}

/// Resolve node reference in MemoryIndex: exact ID → exact name → not found.
pub(crate) fn resolve_in_index(idx: &MemoryIndex, node_id_or_name: &str) -> Option<String> {
    if idx.get_node(node_id_or_name).is_some() {
        return Some(node_id_or_name.to_string());
    }
    idx.get_nodes_by_name(node_id_or_name).first().cloned()
}

/// Resolve node reference in legacy Graph: exact ID → search → not found.
pub(crate) fn resolve_in_graph(g: &Graph, node_id_or_name: &str) -> Option<String> {
    if g.get_node(node_id_or_name).is_some() {
        return Some(node_id_or_name.to_string());
    }
    query::search_nodes(g, node_id_or_name).first().map(|n| n.id.clone())
}

pub(crate) fn discover_source_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let exts: Vec<String> = GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    discover_files(root, &ext_strs).into_iter().take(limit).collect()
}

pub(crate) fn derive_comm_label(members: &[String], idx: &MemoryIndex) -> String {
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
        .unwrap_or_else(|| format!("Community({})", members.len()))
}

pub(crate) fn node_to_value(n: &Node) -> Value {
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

pub(crate) fn edge_to_value(e: &Edge) -> Value {
    json!({
        "id": e.id,
        "source": e.source,
        "target": e.target,
        "type": e.kind.as_str(),
        "coupling_depth": e.coupling_depth,
        "cross_file": e.cross_file,
        "temporal_delay_sec": e.temporal_delay_sec,
        "metadata": e.metadata,
    })
}

// ═══════════════════════════════════════════════════════════════
// V1 Handlers — graph queries
// ═══════════════════════════════════════════════════════════════


macro_rules! p {
    ($name:expr, $type:expr, $desc:expr) => {
        ParamDef {
            name: $name,
            ptype: $type,
            description: $desc,
        }
    };
}

fn all_schemas() -> &'static [ToolSchema] {
    &[
        // ── Entry points ──
        ToolSchema {
            name: "explore_deps",
            description: "【DEFAULT FIRST CHOICE】NL-powered dependency exploration — one call returns: dependency flow path + blast radius + relationships + source code + architecture alerts. Just type a natural-language question like \"DataRequest validate task\" or \"auth模块的依赖链\". When unsure which tool to use, START HERE — it auto-disambiguates.",
            params: &[p!("query", "string", "Natural language query (e.g. 'DataRequest validate task'). Auto-extracts symbol names."), p!("symbols", "array", "List of symbol names (alternative to query)"), p!("includeSource", "boolean", "Include source code sections (default true)")],
            required: &[],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "search_symbols",
            description: "Find symbols by name. Fuzzy search — type a partial name, get back matching nodes with IDs, types, locations. Your FIRST step when you know the function/class name but not its node ID. \"找一下 auth 相关的模块\" → this. After finding the ID, follow up with get_neighbors or inspect_symbol.",
            params: &[p!("query", "string", "Partial name or ID to search for"), p!("limit", "integer", "Max results (default 20)")],
            required: &["query"],
            read_only: true,
            category: "graph",
        },
        // ── Graph navigation ──
        ToolSchema {
            name: "get_neighbors",
            description: "Get the direct neighborhood of a node — who depends on it and who it depends on (1-hop subgraph). Use after search_symbols when you've found a symbol and want to see its immediate coupling. \"这个模块被谁依赖？\" → call this.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "trace_impact",
            description: "Map the blast radius of a change. BFS from a node through all downstream dependents — returns the complete impact tree layered by distance. Use BEFORE editing any high-fan-in symbol. \"改这个会炸多少地方？\" → call this first.",
            params: &[p!("nodeId", "string", "The source node ID"), p!("depth", "integer", "BFS max depth (default 3)")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "find_dep_path",
            description: "Find the dependency chain between two nodes — shows every route from A to B with hop count and edge types. Use when you need to understand HOW two modules are connected. \"A 是怎么依赖到 B 的？\"",
            params: &[p!("from", "string", "Source node ID"), p!("to", "string", "Target node ID"), p!("depth", "integer", "BFS search depth limit (default 20)")],
            required: &["from", "to"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "inspect_symbol",
            description: "Everything about one symbol in a single call: identity (name/kind/degree), community membership, ALL incoming/outgoing edges grouped by kind (imports, calls, inherits, etc.). Use after search_symbols when you need the full picture of a specific symbol. Supersedes symbol_history.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "symbol_history",
            description: "Get decision history for a node — which past commits/analyses touched this symbol, dependency/dependent counts, and timeline events. Use when you need context on why a module looks the way it does. For richer data use inspect_symbol instead.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        // ── Community ──
        ToolSchema {
            name: "get_community",
            description: "Which group does this module belong to? Returns the node's community (Leiden clustering), parent community, and sibling nodes. Use when asked \"this module is in which group?\" or to find closely-related modules. For global community structure, use cluster_report.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "cluster_report",
            description: "Global community/cluster map — which modules naturally group together (Leiden algorithm). Sorted by size with member lists. Use for high-level architecture understanding. For a single node's community, use get_community instead.",
            params: &[p!("min_size", "integer", "Minimum community size to report (default 3)"), p!("max_nodes", "integer", "Max node IDs per community in output (default 20, max 200)")],
            required: &[],
            read_only: true,
            category: "graph",
        },
        // ── Analysis ──
        ToolSchema {
            name: "fragile_modules",
            description: "Top N most coupled modules ranked by L4 encapsulation violation density. High score = lots of hidden temporal/async coupling. Use to find refactoring priorities or assess codebase health. Not a bug list — well-designed hubs (auth, config) rank high by design.",
            params: &[p!("limit", "integer", "Number of top fragile modules to return (default 5)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "detect_cycles",
            description: "Find all circular dependencies in the graph. Filter by mode: all cycles, data-only (persistent data loops), or llm (AI/LLM feedback loops). \"有没有循环依赖？\" → call this. Use before large refactors to understand what can't be untangled easily.",
            params: &[p!("mode", "string", "Filter: all, data, or llm (default all)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "thread_conflicts",
            description: "Thread × resource conflict matrix. Detects shared variables with multiple writers (concurrency risk), concurrent data structure access patterns. Omit nodeId for the global conflict map. \"哪些地方有并发问题？\" → this.",
            params: &[p!("nodeId", "string", "Optional node ID — if omitted, returns global conflict matrix")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "coupling_report",
            description: "Deep-dive coupling profile for one module: L1 (imports) through L4 (temporal/async) breakdown, fan-in/out, cycle participation. Use when asked to analyze a specific file's dependency health. \"auth 模块耦合有多深？\" → this.",
            params: &[p!("module", "string", "Module file name or path")],
            required: &["module"],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "arch_blindspots",
            description: "Architecture blind-spot radar. Detects L4 encapsulation violations, unlocked concurrency, LLM feedback loops. Filter by type (all/L4/thread/cycle). Like a linter for architecture boundaries — catches what code review misses. \"项目有什么隐藏的架构问题？\" → this.",
            params: &[p!("filter", "string", "Boundary type filter: all, L4, thread, cycle (default all)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "graph_summary",
            description: "High-level project overview: total nodes/edges, language breakdown, density, top-level modules. Use at the start of a session to understand the codebase landscape. \"这个项目有多大？什么结构？\" → start here, then drill in with specific tools.",
            params: &[],
            required: &[],
            read_only: true,
            category: "graph",
        },
        // ── Temporal ──
        ToolSchema {
            name: "async_edges",
            description: "List all async/temporal edges — triggers, awaits/callbacks, scheduled tasks, sequenced calls. Use when investigating async coupling, race conditions, or temporal dependency chains. \"有哪些异步依赖？\" → this.",
            params: &[],
            required: &[],
            read_only: true,
            category: "temporal",
        },
        ToolSchema {
            name: "project_timeline",
            description: "Chronological project audit log — analysis runs, commits, violations, constraint checks in order. Use for project retrospectives or trend analysis. \"最近项目发生了什么变化？\" → this. Limit for recent, since for date range.",
            params: &[p!("limit", "integer", "Max events to return (default 100)"), p!("since", "string", "ISO timestamp filter (optional)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── Operations ──
        ToolSchema {
            name: "analyze_project",
            description: "Full pipeline re-analysis of a project directory. Parses, runs LSP, cross-file resolution, coupling depth, community detection — then reloads the graph. Use when the graph is stale or you've made many changes. SLOW — runs in background; check engine_status for progress.",
            params: &[p!("path", "string", "Project root directory path")],
            required: &["path"],
            read_only: false,
            category: "operations",
        },
        ToolSchema {
            name: "graph_diff",
            description: "Compare current dependency graph against a baseline JSON snapshot. Shows added/removed/modified nodes and edge count changes. Use to understand what changed since last analysis. NOT a git diff — use git_diff for file-level code changes.",
            params: &[p!("beforePath", "string", "Path to the baseline graph JSON file")],
            required: &["beforePath"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "preflight_check",
            description: "Change-impact rehearsal. Before you commit, feed it the files you're about to change — returns estimated blast radius, risk level (low/medium/high/critical), shared variable impacts, and temporal edge signals. \"先看看改这里会怎样？这个改动安全吗？\" → ALWAYS call this before editing high-fan-in files.",
            params: &[p!("path", "array", "List of file paths that would be changed")],
            required: &["path"],
            read_only: true,
            category: "preflight",
        },
        ToolSchema {
            name: "validate_project",
            description: "Full constraint validation — re-analyzes, diffs against baseline, runs all structural checks. Returns violations found AND confirmation of passing rules. Use when user asks for a thorough audit: \"全面检查\" \"跑一遍约束\" \"有没有违规？\". For lighter checks, use arch_blindspots first.",
            params: &[p!("path", "string", "Project root directory path")],
            required: &["path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "project_health",
            description: "Project health snapshot: coupling density score (0-100), recent trends, top-changed files, most-interconnected modules. \"项目最近怎么样？\" \"最近的趋势怎么样？\" → this. Score reflects coupling density, not code quality — different project stages have different normal ranges.",
            params: &[p!("path", "string", "Project root directory path"), p!("days", "integer", "Days to look back (default 30)")],
            required: &["path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "rename_symbol",
            description: "Safe symbol rename across the dependency graph. ALWAYS run with dryRun=true first to preview affected nodes, then dryRun=false to apply. Persists to storage. \"把这个函数名改掉\" → dry run → review → execute.",
            params: &[p!("oldName", "string", "Current symbol name"), p!("newName", "string", "New symbol name"), p!("dryRun", "boolean", "Preview only — no changes applied (default false)"), p!("nodeId", "string", "Optional specific node ID to rename")],
            required: &["oldName", "newName"],
            read_only: false,
            category: "operations",
        },
        ToolSchema {
            name: "engine_status",
            description: "Engine status and memory stats: loading phase, node/edge counts, storage type, uptime. Use when tools return empty results or Agent needs to confirm the graph is ready. \"引擎就绪了吗？\" → this.",
            params: &[],
            required: &[],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "check_boundaries",
            description: "Architecture boundary enforcer. Define rules with source/target file patterns (glob or regex) + edge kinds, then scan for violations. \"模块A有没有偷import模块B的内部文件？\" \"数据库模块有没有直接调前端代码？\" → define a rule, run this. Check before and after refactors to confirm no new violations.",
            params: &[
                p!("rules", "array", "JSON array of rule objects. Each rule: {name, source, target, edge_kinds?, message?}. source/target are glob or regex patterns. edge_kinds defaults to [\"imports\"]. Valid kinds: imports, calls, inherits, defines, reads, writes, shares, triggers, awaits, sequences."),
                p!("source", "string", "Shortcut: single source file pattern (instead of full rules array)"),
                p!("target", "string", "Shortcut: single target file pattern (instead of full rules array)"),
                p!("edge_kinds", "array", "Shortcut: edge kinds for single-rule mode. Default: [\"imports\"]"),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── Dead code detection ──
        ToolSchema {
            name: "find_unused",
            description: "Find dead code candidates — symbols with zero incoming references (nobody depends on them). Sorted by outgoing references descending (most impactful first). \"有没有没用到的代码？\" → this. Always review results before deleting — some low-fan-in symbols are intentional (entry points, tests).",
            params: &[
                p!("limit", "integer", "Max results (default 20, max 200)"),
                p!("kind_filter", "string", "Node kinds to include, comma-separated. Default: \"function,class\". Options: symbol, function, class, module, interface, medium, temporal."),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── Dataflow tracing ──
        ToolSchema {
            name: "trace_dataflow",
            description: "Per-function variable reads/writes, cross-function shared state, async triggers, call sequences. Answers: \"where is X written?\" \"who reads Y?\" \"which functions share Z?\". Pass the file paths you're investigating — returns scoped data movement analysis. Follow up with trace_impact on shared variables to trace downstream effects.",
            params: &[p!("files", "array", "File paths, e.g. [\"src/auth.js\", \"src/db.js\"]")],
            required: &["files"],
            read_only: true,
            category: "dataflow",
        },
        // ── LSP ──
        ToolSchema {
            name: "resolve_call",
            description: "Resolve a function/method call to its concrete definition(s). Uses native LSP (rust-analyzer/gopls/pyright) for polymorphic dispatch, struct methods, inheritance. When the graph shows `do_thing()` and you need to know WHICH `do_thing` — this resolves it.",
            params: &[
                p!("file", "string", "File path, e.g. \"src/views.py\""),
                p!("function", "string", "Optional: filter to calls from a specific function, e.g. \"login\""),
                p!("line", "number", "Optional: 0-based line number for native LSP resolution"),
                p!("column", "number", "Optional: 0-based column for native LSP resolution"),
            ],
            required: &["file"],
            read_only: true,
            category: "lsp",
        },
        ToolSchema {
            name: "infer_type",
            description: "What type is this expression? Uses native LSP hover for precise type info — struct fields, return types, variable types. \"这个变量是什么类型？\" → this at the position. Fallback to call-target-based inference when LSP isn't available.",
            params: &[
                p!("file", "string", "File path, e.g. \"src/views.py\""),
                p!("line", "number", "0-based line number"),
                p!("column", "number", "0-based column"),
            ],
            required: &["file", "line", "column"],
            read_only: true,
            category: "lsp",
        },
        ToolSchema {
            name: "find_implementations",
            description: "Find all implementations of an interface/trait/abstract class. Uses native LSP textDocument/implementation. \"这个接口有哪些实现？\" \"谁实现了这个 trait？\" → click on the definition, call this. Returns the full implementation tree.",
            params: &[
                p!("file", "string", "File path, e.g. \"src/interface.go\""),
                p!("line", "number", "0-based line number"),
                p!("column", "number", "0-based column"),
            ],
            required: &["file", "line", "column"],
            read_only: true,
            category: "lsp",
        },
        ToolSchema {
            name: "find_references",
            description: "Find every place that references this symbol — across the entire codebase. Uses native LSP textDocument/references. \"谁在用这个函数？\" \"这个类在哪被引用了？\" → this. Set includeDeclaration=true to include the definition itself. High reference count → call trace_impact before changing.",
            params: &[
                p!("file", "string", "File path"),
                p!("line", "number", "0-based line number"),
                p!("column", "number", "0-based column"),
                p!("includeDeclaration", "boolean", "Include the definition itself (default false)"),
            ],
            required: &["file", "line", "column"],
            read_only: true,
            category: "lsp",
        },
    ]
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_count() {
        let schemas = all_schemas();
        assert!(!schemas.is_empty(), "must have at least one tool");
    }

    #[test]
    fn test_mcp_tools_list_format() {
        let registry = ToolRegistry::global();
        let tools = registry.tools_list();
        assert!(!tools.is_empty());
        for tool in &tools {
            assert!(tool.get("name").and_then(|v| v.as_str()).is_some(), "every tool must have a name");
            assert!(tool.get("description").and_then(|v| v.as_str()).is_some(), "every tool must have a description");
            assert!(tool.get("inputSchema").is_some(), "every tool must have inputSchema");
        }
    }

    #[test]
    fn test_dispatch_unknown_tool() {
        let dummy_id = json!(1);
        let result = ToolRegistry::dispatch("nonexistent_tool", &json!({}), &dummy_id);
        // Degraded response is still a success (no error field in JSON-RPC)
        assert!(result.get("result").is_some(), "unknown tool should return degraded result, not error");
    }

    #[test]
    fn test_all_tools_dispatchable() {
        let dummy_id = json!(1);
        let schemas = all_schemas();
        for schema in schemas {
            let args = json!({});
            let result = ToolRegistry::dispatch(schema.name, &args, &dummy_id);
            assert!(result.is_object(), "dispatch({}) must return a JSON object", schema.name);
        }
    }

    #[test]
    fn test_tool_names_unique() {
        let schemas = all_schemas();
        let mut names: Vec<&str> = schemas.iter().map(|s| s.name).collect();
        names.sort();
        let mut uniq = names.clone();
        uniq.dedup();
        assert_eq!(names.len(), uniq.len(), "all tool names must be unique");
    }

    #[test]
    fn test_schema_get() {
        let registry = ToolRegistry::global();
        let schema = registry.get_schema("get_neighbors");
        assert!(schema.is_some());
        assert_eq!(schema.unwrap().name, "get_neighbors");
        assert!(registry.get_schema("nonexistent_tool").is_none());
    }

    #[test]
    fn test_missing_required_params_error() {
        let dummy_id = json!(1);
        let result = ToolRegistry::dispatch("get_neighbors", &json!({}), &dummy_id);
        // Degraded result wraps in JSON-RPC success format with _isDegraded flag
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("node_id") || text.contains("nodeId"),
            "get_neighbors should degrade on missing nodeId, got: {}", text);
        let result = ToolRegistry::dispatch("find_dep_path", &json!({}), &dummy_id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("from_id") || text.contains("fromId"),
            "find_dep_path should degrade on missing params");
        let result = ToolRegistry::dispatch("coupling_report", &json!({}), &dummy_id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("module_name") || text.contains("module"),
            "coupling_report should degrade on missing module_name");
        let result = ToolRegistry::dispatch("search_symbols", &json!({}), &dummy_id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("query"), "search_symbols should degrade on missing query");
    }

    #[test]
    fn test_category_assignments() {
        let schemas = all_schemas();
        for schema in schemas {
            assert!(!schema.category.is_empty(), "tool '{}' must have a category", schema.name);
        }
        let categories: Vec<&str> = schemas.iter().map(|s| s.category).collect();
        assert!(categories.contains(&"graph"));
        assert!(categories.contains(&"analysis"));
        assert!(categories.contains(&"operations"));
        assert!(categories.contains(&"dataflow"));
        assert!(categories.contains(&"temporal"));
        assert!(categories.contains(&"preflight"));
    }

    #[test]
    fn test_read_only_consistency() {
        let schemas = all_schemas();
        let read_only_tools: Vec<&str> = schemas.iter().filter(|s| s.read_only).map(|s| s.name).collect();
        assert!(!read_only_tools.contains(&"analyze_project"), "analyze mutates state");
        assert!(!read_only_tools.contains(&"rename_symbol"), "rename mutates state");
        assert!(read_only_tools.contains(&"get_neighbors"));
        assert!(read_only_tools.contains(&"search_symbols"));
        assert!(read_only_tools.contains(&"engine_status"));
    }
}