// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool registry — schema definitions + handler dispatch for all 27 hologram_* tools.
// Separated from MCP transport so Tauri / TCP / CLI can share the same tool layer.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{json, Value};

use crate::analysis::*;
use crate::community::detect_communities_from_index;
use crate::engine;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{query, Edge, EdgeKind, Graph, Node, NodeKind};
use crate::pipeline::discovery::discover_files;
use crate::routing::preflight::{load_baseline, run_full_check, save_baseline};
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

    pub fn tools_list(&self) -> Vec<Value> {
        all_schemas().iter().map(|s| s.mcp_value()).collect()
    }

    pub fn get_schema(&self, name: &str) -> Option<&'static ToolSchema> {
        all_schemas().iter().find(|s| s.name == name)
    }

    pub fn dispatch(name: &str, args: &Value) -> Value {
        match name {
            "get_neighbors" => handler_neighbors(args),
            "trace_impact" => handler_impact(args),
            "find_dep_path" => handler_path(args),
            "inspect_symbol" | "symbol_history" => handler_node(args),
            "get_community" => handler_community(args),
            "async_edges" => handler_delayed(args),
            "fragile_modules" => handler_fragile(args),
            "detect_cycles" => handler_cycle(args),
            "thread_conflicts" => handler_thread_conflicts(args),
            "coupling_report" => handler_coupling_report(args),
            "project_timeline" => handler_timeline(args),
            "arch_blindspots" => handler_blindspots(args),
            "preflight_check" => handler_preflight(args),
            "search_symbols" => handler_search(args),
            "explore_deps" => handler_explore(args),
            "graph_summary" => handler_graph_summary(args),
            "cluster_report" => handler_clusters(args),
            "graph_diff" => handler_diff(args),
            "analyze_project" => handler_analyze(args),
            "validate_project" => handler_run_check(args),
            "project_health" => handler_run_health(args),
            "rename_symbol" => handler_rename(args),
            "engine_status" => handler_status(args),
            "check_boundaries" => handler_policy_check(args),
            "find_unused" => handler_unused(args),
            "trace_dataflow" => handler_dataflow(args),
            "resolve_call" => handler_resolve_call(args),
            "infer_type" => handler_resolve_type(args),
            "find_implementations" => handler_find_implementations(args),
            "find_references" => handler_find_references(args),
            _ => json!({"error": format!("Tool not found: {}", name)}),
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

fn get_str(args: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    String::new()
}

fn get_usize(args: &Value, key: &str, default: usize) -> usize {
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
fn snake_to_camel(s: &str) -> String {
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

fn project_root() -> PathBuf {
    engine::with_engine(|eng| eng.project_root()).unwrap_or_default()
}

fn with_store<F>(f: F) -> Value
where
    F: FnOnce(&MemoryIndex) -> Value,
{
    match engine::engine_read(|idx| f(idx)) {
        Ok(value) => value,
        Err(e) => json!({"error": e}),
    }
}

fn with_graph<F>(f: F) -> Value
where
    F: FnOnce(&Graph) -> Value,
{
    match engine::engine_read_graph(|g| f(g)) {
        Ok(value) => value,
        Err(e) => json!({"error": e}),
    }
}

/// Resolve node reference in MemoryIndex: exact ID → exact name → not found.
fn resolve_in_index(idx: &MemoryIndex, node_id_or_name: &str) -> Option<String> {
    if idx.get_node(node_id_or_name).is_some() {
        return Some(node_id_or_name.to_string());
    }
    idx.get_nodes_by_name(node_id_or_name).first().cloned()
}

/// Resolve node reference in legacy Graph: exact ID → search → not found.
fn resolve_in_graph(g: &Graph, node_id_or_name: &str) -> Option<String> {
    if g.get_node(node_id_or_name).is_some() {
        return Some(node_id_or_name.to_string());
    }
    query::search_nodes(g, node_id_or_name).first().map(|n| n.id.clone())
}

fn discover_source_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let exts: Vec<String> = GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    discover_files(root, &ext_strs).into_iter().take(limit).collect()
}

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
        .unwrap_or_else(|| format!("Community({})", members.len()))
}

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
        "temporal_delay_sec": e.temporal_delay_sec,
    })
}

// ═══════════════════════════════════════════════════════════════
// V1 Handlers — graph queries
// ═══════════════════════════════════════════════════════════════

fn handler_neighbors(args: &Value) -> Value {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return json!({"error": "node_id is required"});
    }
    match engine::engine_read(|idx| {
        let resolved = match resolve_in_index(idx, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let node = idx.get_node(&resolved).unwrap().clone();
        let nb = idx.neighbors(&resolved, 1, None);
        let incoming = idx.get_incoming_edges(&resolved);
        let outgoing = idx.get_outgoing_edges(&resolved);
        json!({
            "node": node_to_value(&node),
            "neighbor_count": nb.len(),
            "neighbors": nb.iter().map(|(_, t, d)| json!({"id": t, "coupling_depth": d})).collect::<Vec<_>>(),
            "incoming": incoming.iter().map(|e| edge_to_value(e)).collect::<Vec<_>>(),
            "outgoing": outgoing.iter().map(|e| edge_to_value(e)).collect::<Vec<_>>(),
        })
    }) {
        Ok(value) => {
            if value.get("error").is_none() {
                return value;
            }
        }
        Err(_) => {}
    }
    with_graph(|g| {
        let resolved = match resolve_in_graph(g, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let node = g.get_node(&resolved).unwrap();
        let nb = query::neighbors(g, &resolved, 1);
        let incoming: Vec<_> = g.incoming_edges(&resolved).iter().map(|e| edge_to_value(e)).collect();
        let outgoing: Vec<_> = g.outgoing_edges(&resolved).iter().map(|e| edge_to_value(e)).collect();
        json!({
            "node": node_to_value(node),
            "neighbor_count": nb.len(),
            "neighbors": nb.iter().map(|(_, t, d)| json!({"id": t, "coupling_depth": d})).collect::<Vec<_>>(),
            "incoming": incoming,
            "outgoing": outgoing,
        })
    })
}

fn handler_impact(args: &Value) -> Value {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return json!({"error": "node_id is required"});
    }
    let depth = get_usize(args, "depth", 3);
    with_store(|idx| {
        let resolved = match resolve_in_index(idx, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let layers = idx.impact(&resolved, depth);
        let total_affected: usize = layers.iter().map(|(_, nodes)| nodes.len()).sum();
        json!({
            "source_node_id": resolved,
            "max_depth": depth,
            "total_affected_nodes": total_affected.saturating_sub(1),
            "layers": layers.iter().map(|(d, nodes)| json!({"depth": d, "nodes": nodes})).collect::<Vec<_>>(),
        })
    })
}

fn handler_path(args: &Value) -> Value {
    let from_id = get_str(args, &["from_id", "fromId", "from"]);
    let to_id = get_str(args, &["to_id", "toId", "to"]);
    if from_id.is_empty() || to_id.is_empty() {
        return json!({"error": "from_id and to_id are required"});
    }
    let depth = get_usize(args, "depth", 20).max(1);
    with_store(|idx| {
        let resolved_from = match resolve_in_index(idx, &from_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", from_id)}),
        };
        let resolved_to = match resolve_in_index(idx, &to_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", to_id)}),
        };
        match idx.shortest_path_with_limits(&resolved_from, &resolved_to, depth, 5000) {
            Some(path) => json!({"from_id": resolved_from, "to_id": resolved_to, "path_count": 1, "paths": [path]}),
            None => json!({"from_id": resolved_from, "to_id": resolved_to, "path_count": 0, "paths": []}),
        }
    })
}

// ponytail: handler_history deleted — symbol_history now routes to handler_node (richer output)

fn handler_community(args: &Value) -> Value {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return json!({"error": "node_id is required"});
    }
    with_store(|idx| {
        let resolved = match resolve_in_index(idx, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let cid = match idx.get_node(&resolved).and_then(|n| n.community_id) {
            Some(c) => c,
            None => {
                let communities = detect_communities_from_index(idx, 42);
                for (i, comm) in communities.iter().enumerate() {
                    if comm.contains(&resolved) {
                        let siblings: Vec<_> = comm.iter().filter(|nid| *nid != &resolved).cloned().collect();
                        return json!({
                            "node_id": resolved,
                            "community": {
                                "id": format!("comm_{}", i),
                                "level": 0,
                                "label": format!("Community {}", i + 1),
                                "node_count": comm.len(),
                                "node_ids": comm,
                            },
                            "sibling_nodes": siblings,
                        });
                    }
                }
                return json!({"node_id": resolved, "community": null, "message": "Node not in any community"});
            }
        };
        let mut comm_node_ids = Vec::new();
        let mut siblings = Vec::new();
        for node in idx.nodes_iter() {
            if node.community_id == Some(cid) {
                comm_node_ids.push(node.id.clone());
                if node.id != resolved {
                    siblings.push(node.id.clone());
                }
            }
        }
        json!({
            "node_id": resolved,
            "community": {
                "id": format!("comm_{}", cid),
                "level": 0,
                "label": format!("Community {}", cid + 1),
                "node_count": comm_node_ids.len(),
                "node_ids": comm_node_ids,
            },
            "sibling_nodes": siblings,
        })
    })
}

fn handler_delayed(args: &Value) -> Value {
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let root = project_root();
    let paths: Vec<PathBuf> = if files.is_empty() {
        discover_source_files(&root, 500)
    } else {
        files
            .iter()
            .map(|f| {
                let p = Path::new(f);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    root.join(f)
                }
            })
            .collect()
    };
    let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&paths);
    let mut triggers: Vec<Value> = Vec::new();
    let mut awaits: Vec<Value> = Vec::new();
    let mut sequences: Vec<Value> = Vec::new();
    for r in &df_results {
        if let Ok(df) = &r.result {
            for s in &df.scopes {
                for t in &s.triggers {
                    triggers.push(json!({"file": r.file, "scope": s.name, "target": t, "type": "trigger"}));
                }
                for a in &s.awaits_callbacks {
                    awaits.push(json!({"file": r.file, "scope": s.name, "target": a, "type": "await"}));
                }
                for seq in &s.sequence_calls {
                    sequences.push(json!({"file": r.file, "scope": s.name, "target": seq, "type": "sequence"}));
                }
            }
        }
    }
    let total = triggers.len() + awaits.len() + sequences.len();
    json!({
        "total_delayed_edges": total,
        "triggers_count": triggers.len(),
        "awaits_count": awaits.len(),
        "sequences_count": sequences.len(),
        "triggers": triggers,
        "awaits": awaits,
        "sequences": sequences,
        "_note": "from dataflow engine (on-demand query, no graph storage)",
    })
}

// ═══════════════════════════════════════════════════════════════
// V2 Analysis Handlers
// ═══════════════════════════════════════════════════════════════

fn handler_fragile(args: &Value) -> Value {
    let limit = get_usize(args, "limit", 5).max(1);
    let root = project_root();
    with_store(|idx| {
        // ── Step 1: Aggregate graph structure scores per file ──
        // Walk all nodes, group by file (from location), sum fan + coupling penalty.
        let mut file_scores: std::collections::HashMap<String, (f64, usize)> = std::collections::HashMap::new();
        for node in idx.nodes_iter() {
            let loc = match node.location.as_ref() {
                Some(l) => l.replace('\\', "/"),
                None => continue,
            };
            let file_path = loc.rsplit_once(':').map(|(f, _)| f.to_string()).unwrap_or(loc);

            let out = idx.outgoing(&node.id, None);
            let incoming = idx.incoming(&node.id, None);
            let fan = (out.len() + incoming.len()) as f64;
            let coupling_penalty: f64 = out.iter()
                .map(|(_, _, depth, _)| (*depth as f64).powi(2))
                .chain(incoming.iter().map(|(_, _, depth, _)| (*depth as f64).powi(2)))
                .sum::<f64>() / fan.max(1.0);
            let node_score = fan * (1.0 + coupling_penalty);

            file_scores.entry(file_path)
                .and_modify(|(s, c)| { *s += node_score; *c += 1; })
                .or_insert((node_score, 1));
        }

        // ── Step 2: Query dataflow engine for per-file L3/L4 ──
        let files: Vec<PathBuf> = discover_source_files(&root, 500);
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&files);
        let mut file_l3l4: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
        for r in &df_results {
            if let Ok(df) = &r.result {
                let mut l3 = 0u32;
                let mut l4 = 0u32;
                for s in &df.scopes {
                    l3 += (s.reads.len() + s.writes.len()) as u32;
                    l4 += (s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len()) as u32;
                }
                l3 += df.shared.len() as u32;
                let key = r.file.replace('\\', "/");
                file_l3l4.entry(key).and_modify(|(e3, e4)| { *e3 += l3; *e4 += l4; }).or_insert((l3, l4));
            }
        }

        // ── Step 3: Merge structure + dataflow into per-file fragility ──
        let mut scored: Vec<(f64, String, u32, u32, usize)> = Vec::new();
        for (file, (struct_score, node_count)) in &file_scores {
            // Normalize structure score by node count (average fragility per node)
            let avg_struct = struct_score / (*node_count as f64).max(1.0);
            // Match L3/L4 by file path (try both directions)
            let mut l3 = 0u32;
            let mut l4 = 0u32;
            for (df_file, (d3, d4)) in &file_l3l4 {
                if file.ends_with(df_file.as_str()) || df_file.ends_with(file.as_str()) || file == df_file {
                    l3 = *d3;
                    l4 = *d4;
                    break;
                }
            }
            // Final score: structure foundation + dataflow penalty
            // Structure is the base; L4 weighs 4x, L3 weighs 3x (same ratio as coupling_report)
            let df_penalty = (l4 as f64) * 4.0 + (l3 as f64) * 3.0;
            let total = avg_struct + df_penalty;
            scored.push((total, file.clone(), l3, l4, *node_count));
        }

        // Also include files that have dataflow but no graph nodes (rare but possible)
        for (df_file, (l3, l4)) in &file_l3l4 {
            let already = scored.iter().any(|(_, f, _, _, _)| f == df_file || df_file.ends_with(f.as_str()) || f.ends_with(df_file.as_str()));
            if !already && (*l3 > 0 || *l4 > 0) {
                let df_penalty = (*l4 as f64) * 4.0 + (*l3 as f64) * 3.0;
                scored.push((df_penalty, df_file.clone(), *l3, *l4, 0));
            }
        }

        // ── Step 4: Sort and format ──
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        let result: Vec<serde_json::Value> = scored.iter().map(|(score, file, l3, l4, nodes)| {
            let short_name = file.rsplit('/').next().unwrap_or(file).to_string();
            json!({
                "module": short_name,
                "file": file,
                "fragility_score": format!("{:.1}", score),
                "l3_edges": l3,
                "l4_edges": l4,
                "node_count": nodes,
                "_score_breakdown": format!("struct={:.1} + L3×3={} + L4×4={}", score - (*l4 as f64) * 4.0 - (*l3 as f64) * 3.0, l3, l4),
            })
        }).collect();

        json!({"fragile_modules": result, "limit": limit})
    })
}

fn handler_cycle(args: &Value) -> Value {
    let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("all");
    with_store(|idx| {
        let classified = classify_cycles_from_index(idx);
        let all_cycles: Vec<_> = classified["cycles"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let filtered: Vec<_> = match mode {
            "data" => all_cycles
                .into_iter()
                .filter(|c| c.get("category").and_then(|v| v.as_str()) == Some("data_persistent"))
                .collect(),
            "llm" => all_cycles
                .into_iter()
                .filter(|c| c.get("category").and_then(|v| v.as_str()) == Some("llm_involved"))
                .collect(),
            _ => all_cycles,
        };
        json!({"total_cycles": filtered.len(), "mode_filter": mode, "cycles": filtered})
    })
}

fn handler_thread_conflicts(args: &Value) -> Value {
    let _node_id = args.get("node_id").or_else(|| args.get("nodeId")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let root = project_root();
    with_store(|idx| {
        let mut resources = serde_json::Map::new();
        let files: Vec<PathBuf> = discover_source_files(&root, 500);
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&files);
        let mut var_writers: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        let mut var_readers: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for r in &df_results {
            if let Ok(df) = &r.result {
                for s in &df.scopes {
                    for w in &s.writes {
                        var_writers.entry(w.clone()).or_default().push(s.name.clone());
                    }
                    for rd in &s.reads {
                        var_readers.entry(rd.clone()).or_default().push(s.name.clone());
                    }
                }
                for sh in &df.shared {
                    for w in &sh.writers {
                        var_writers.entry(sh.var.clone()).or_default().push(w.clone());
                    }
                    for rd in &sh.readers {
                        var_readers.entry(sh.var.clone()).or_default().push(rd.clone());
                    }
                }
            }
        }
        for (var, writers) in &var_writers {
            if writers.len() > 1 {
                let readers = var_readers.get(var).cloned().unwrap_or_default();
                let has_concurrent_write = writers.len() > 1;
                resources.insert(var.clone(), json!({
                    "medium_type": "variable",
                    "threads": writers.iter().map(|w| json!({"name": w, "access": "W"})).collect::<Vec<_>>(),
                    "thread_count": writers.len() + readers.len(),
                    "has_concurrent_write": has_concurrent_write,
                    "lock_detected": false,
                    "lock_edges": Vec::<String>::new(),
                }));
            }
        }
        for medium in idx.nodes_iter().filter(|n| matches!(n.kind, NodeKind::Medium)) {
            if resources.contains_key(&medium.name) {
                continue;
            }
            let incoming = idx.incoming(&medium.id, None);
            let mut threads_info = Vec::new();
            let mut has_write = false;
            let mut lock_edges = Vec::new();
            for (src_id, kind, _depth, _delay) in &incoming {
                if let Some(src) = idx.get_node(src_id) {
                    let access = if matches!(kind, EdgeKind::Writes) { "W" } else { "R" };
                    if access == "W" {
                        has_write = true;
                    }
                    threads_info.push(json!({"name": src.name, "location": src.location, "access": access}));
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
        let unlocked_keys: Vec<_> = resources
            .iter()
            .filter(|(_, v)| {
                v["has_concurrent_write"].as_bool().unwrap_or(false)
                    && !v["lock_detected"].as_bool().unwrap_or(true)
            })
            .map(|(k, _)| k.clone())
            .collect();
        json!({
            "resources": resources,
            "total_shared_resources": resources.len(),
            "unlocked_concurrent_writes": unlocked_keys.len(),
            "unlocked_resources": unlocked_keys,
            "_note": "shared vars from dataflow engine + Medium nodes from graph",
        })
    })
}

fn handler_coupling_report(args: &Value) -> Value {
    let module = get_str(args, &["module_name", "module"]);
    if module.is_empty() {
        return json!({"error": "module_name is required"});
    }
    let root = project_root();
    with_store(|idx| {
        let report = coupling_report_from_index(idx, &module);
        let l1 = report["L1"].as_u64().unwrap_or(0) as u32;
        let l2 = report["L2"].as_u64().unwrap_or(0) as u32;
        let normalized = module.replace('\\', "/");
        let module_files: Vec<String> = {
            let mut files: Vec<String> = idx
                .get_nodes_by_file(&normalized)
                .iter()
                .filter_map(|nid| idx.get_node(nid))
                .filter_map(|n| n.location.as_ref())
                .map(|loc| {
                    let f = loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(loc);
                    f.replace('\\', "/")
                })
                .collect();
            let mut seen = std::collections::HashSet::new();
            files.retain(|f| seen.insert(f.clone()));
            files
        };
        let mut l3 = 0u32;
        let mut l4 = 0u32;
        if !module_files.is_empty() {
            let paths: Vec<PathBuf> = module_files
                .iter()
                .map(|f| {
                    let p = Path::new(f);
                    if p.is_absolute() {
                        p.to_path_buf()
                    } else {
                        root.join(f)
                    }
                })
                .collect();
            let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&paths);
            for r in &df_results {
                if let Ok(df) = &r.result {
                    for s in &df.scopes {
                        l3 += (s.reads.len() + s.writes.len()) as u32;
                        l4 += (s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len()) as u32;
                    }
                    l3 += df.shared.len() as u32;
                }
            }
        }
        let total = (l1 + l2 + l3 + l4).max(1) as f64;
        let fragility = (l4 as f64 * 4.0 + l3 as f64 * 3.0) / total;
        json!({
            "module": module,
            "total_edges": l1 + l2 + l3 + l4,
            "L1": l1, "L2": l2, "L3": l3, "L4": l4,
            "fragility": format!("{:.1}", fragility),
            "_note": "L1/L2 from graph, L3/L4 from dataflow engine",
        })
    })
}

fn handler_timeline(args: &Value) -> Value {
    let limit = get_usize(args, "limit", 100).max(1);
    let events = engine::engine_query_timeline(limit).unwrap_or_default();
    json!({"events": events, "total": events.len()})
}

fn handler_blindspots(args: &Value) -> Value {
    let _filter = args.get("filter").and_then(|v| v.as_str()).unwrap_or("all");
    let root = project_root();
    with_store(|idx| {
        let files: Vec<PathBuf> = discover_source_files(&root, 500);
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&files);
        let mut l4 = count_l4_from_index(idx);
        let mut conflict_count = 0usize;
        let mut var_writers: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for r in &df_results {
            if let Ok(df) = &r.result {
                for s in &df.scopes {
                    l4 += s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len();
                    for w in &s.writes {
                        var_writers.entry(w.clone()).or_default().push(s.name.clone());
                    }
                }
                for sh in &df.shared {
                    for w in &sh.writers {
                        var_writers.entry(sh.var.clone()).or_default().push(w.clone());
                    }
                }
            }
        }
        for writers in var_writers.values() {
            if writers.len() > 1 {
                conflict_count += 1;
            }
        }
        for medium in idx.nodes_iter().filter(|n| matches!(n.kind, NodeKind::Medium)) {
            let incoming = idx.incoming(&medium.id, None);
            let has_write = incoming.iter().any(|(_, kind, _, _)| matches!(kind, EdgeKind::Writes));
            let has_lock = incoming.iter().any(|(_, kind, _, _)| kind.as_str().contains("lock"));
            if has_write && !has_lock && incoming.len() > 1 {
                conflict_count += 1;
            }
        }
        let cycles = detect_cycles_from_index(idx);
        let blind = find_blindspots(l4, cycles.len(), conflict_count);
        json!(blind)
    })
}

fn handler_preflight(args: &Value) -> Value {
    let files: Vec<String> = args
        .get("files")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return json!({"error": "files list is required"});
    }
    let root = project_root();
    with_store(|idx| {
        let mut file_reports = Vec::new();
        for file in &files {
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
        let paths: Vec<PathBuf> = files
            .iter()
            .map(|f| {
                let p = Path::new(f);
                if p.is_absolute() { p.to_path_buf() } else { root.join(f) }
            })
            .collect();
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&paths);
        let mut df_signals: Vec<Value> = Vec::new();
        let mut shared_vars = 0usize;
        let mut temporal = 0usize;
        for r in &df_results {
            if let Ok(df) = &r.result {
                for sh in &df.shared {
                    shared_vars += 1;
                    df_signals.push(json!({
                        "level": 3,
                        "file": r.file,
                        "var": sh.var,
                        "readers": sh.readers,
                        "writers": sh.writers,
                        "description": format!("Shared variable {}: {} writers, {} readers", sh.var, sh.writers.len(), sh.readers.len()),
                    }));
                }
                for s in &df.scopes {
                    temporal += s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len();
                    for t in &s.triggers {
                        df_signals.push(json!({"level": 4, "file": r.file, "scope": s.name, "target": t, "kind": "trigger"}));
                    }
                }
            }
        }
        let structural_risk = file_reports
            .iter()
            .filter_map(|r| r["risk"].as_str())
            .max_by_key(|r| match *r { "high" => 3, "medium" => 2, _ => 1 })
            .unwrap_or("low");
        let risk_level = if shared_vars > 0 && structural_risk == "low" {
            "medium"
        } else if temporal > 5 {
            "high"
        } else {
            structural_risk
        };
        json!({
            "files": files,
            "risk_level": risk_level,
            "file_reports": file_reports,
            "dataflow_signals": df_signals,
            "dataflow_summary": {"shared_vars": shared_vars, "temporal_edges": temporal},
        })
    })
}

fn handler_search(args: &Value) -> Value {
    let query_str = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = get_usize(args, "limit", 20);
    if query_str.is_empty() {
        return json!({"error": "query is required"});
    }
    if let Ok(results) = engine::engine_fts_search(query_str, limit) {
        if !results.is_empty() {
            return json!({
                "query": query_str,
                "count": results.len(),
                "results": results.iter().map(|n| node_to_value(n)).collect::<Vec<_>>(),
                "engine": "fts5",
            });
        }
    }
    with_graph(|g| {
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

fn handler_explore(args: &Value) -> Value {
    let symbols: Vec<String> = args
        .get("symbols")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let query_str = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());
    if symbols.is_empty() && query_str.is_none() {
        return json!({"error": "symbols array or query string is required"});
    }
    let include_source = args.get("includeSource").and_then(|v| v.as_bool()).unwrap_or(true);
    let root = project_root();
    with_graph(|g| explore(g, &root, &symbols, query_str.as_deref(), include_source))
}

fn handler_graph_summary(_args: &Value) -> Value {
    with_store(|idx| graph_summary_from_index(idx))
}

fn handler_clusters(args: &Value) -> Value {
    let min_size = get_usize(args, "min_size", 3).max(1);
    let max_nodes = get_usize(args, "max_nodes", 20).max(1).min(200);
    with_store(|idx| {
        let mut comm_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
        let mut has_any = false;
        for node in idx.nodes_iter() {
            if let Some(cid) = node.community_id {
                comm_map.entry(cid).or_default().push(node.id.clone());
                has_any = true;
            }
        }
        if !has_any {
            let communities = detect_communities_from_index(idx, 42);
            for (i, c) in communities.iter().enumerate() {
                comm_map.insert(i, c.clone());
            }
        }
        let mut communities: Vec<_> = comm_map.into_iter().collect();
        communities.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
        let filtered: Vec<_> = communities
            .iter()
            .filter(|(_, c)| c.len() >= min_size)
            .enumerate()
            .map(|(display_idx, (cid, node_ids))| {
                let truncated = node_ids.len() > max_nodes;
                let shown: Vec<_> = node_ids.iter().take(max_nodes).cloned().collect();
                let label = derive_comm_label(&node_ids, idx);
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

fn handler_diff(args: &Value) -> Value {
    let before_path = args.get("before_path").or_else(|| args.get("beforePath")).and_then(|v| v.as_str()).unwrap_or("");
    if before_path.is_empty() {
        return json!({"error": "before_path is required"});
    }
    with_graph(|after| {
        let before = match Graph::from_json_file(before_path) {
            Ok(g) => g,
            Err(_) => {
                let graph_json = serde_json::to_string_pretty(after).unwrap_or_default();
                if let Err(e) = std::fs::write(before_path, &graph_json) {
                    return json!({"error": format!("Cannot create baseline: {}", e)});
                }
                return json!({
                    "is_empty": true,
                    "message": "Baseline created. Run diff again to compare.",
                    "baseline_path": before_path,
                });
            }
        };
        let diff = before.diff(&after);
        let added_nodes: Vec<_> = diff.added_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
        let removed_nodes: Vec<_> = diff.removed_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
        let modified_nodes: Vec<_> = diff.modified_nodes.iter().map(|(old, new)| json!({
            "node_id": new.id, "name": new.name,
            "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
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

fn handler_analyze(args: &Value) -> Value {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return json!({"error": "path is required"});
    }
    let root = PathBuf::from(path);
    if !root.exists() {
        return json!({"error": format!("Path not found: {}", path)});
    }
    if let Err(e) = engine::engine_init(&root) {
        return json!({"error": format!("Engine init failed: {}", e)});
    }
    if engine::engine_state().is_analyzing() {
        return json!({
            "status": "already_running",
            "message": "Analysis already in progress. Call engine_status to track progress.",
        });
    }
    let root_clone = root.clone();
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            match engine::engine_analyze(&root_clone) {
                Ok(_) => {
                    engine::with_engine(|eng| {
                        eng.stop_watcher();
                        eng.start_watcher(root_clone.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
                    });
                }
                Err(_) => {}
            }
        })
        .ok();
    json!({
        "status": "started",
        "message": "Analysis running in background. Call engine_status to track progress.",
    })
}

fn handler_run_check(args: &Value) -> Value {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return json!({"error": "path is required"});
    }
    let root = PathBuf::from(path);
    if !root.exists() {
        return json!({"error": format!("Path not found: {}", path)});
    }
    // Load baseline snapshot (saved from last check) for before/after diff
    let before = load_baseline(&root);
    // Prefer in-memory cached graph; only re-analyze when truly empty
    let after = match engine::engine_read_graph(|g| g.clone()) {
        Ok(g) if g.node_count() > 0 || g.edge_count() > 0 => g,
        _ => {
            match engine::engine_init(&root) {
                Ok(_) => {}
                Err(e) => return json!({"error": format!("Engine init failed: {}", e)}),
            }
            match engine::engine_analyze(&root) {
                Ok(r) => r.graph,
                Err(e) => return json!({"error": e}),
            }
        }
    };
    let changed_files: Vec<String> = args.get("changed_files")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let check_result = run_full_check(&before, &after, &changed_files, path);
    // Advance baseline so next check diffs against this snapshot
    save_baseline(&root, &after);
    // Record to timeline (skip quiet polls — only meaningful checks)
    let passed = check_result["passed"].as_bool().unwrap_or(true);
    let violation_count = check_result["violation_count"].as_u64().unwrap_or(0);
    if violation_count > 0 || !changed_files.is_empty() {
        let event_type = if passed { "commit_clean" } else { "commit_violation" };
        let summary = if passed {
            format!("Check passed ({} violations)", violation_count)
        } else {
            format!("Check failed: {} violations", violation_count)
        };
        let props = json!({"passed": check_result["passed"], "violation_count": check_result["violation_count"]});
        let _ = engine::engine_record_timeline_with_props(event_type, None::<&str>, &summary, &props);
    }
    json!(check_result)
}

fn handler_run_health(args: &Value) -> Value {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let days = get_usize(args, "days", 30);
    if path.is_empty() {
        return json!({"error": "path is required"});
    }
    let root = project_root();
    let dataflow_l4: usize = {
        let files: Vec<PathBuf> = discover_source_files(&root, 500);
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&files);
        let mut l4 = 0usize;
        for r in &df_results {
            if let Ok(df) = &r.result {
                for s in &df.scopes {
                    l4 += s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len();
                }
            }
        }
        l4
    };
    with_store(|idx| {
        let summary = graph_summary_from_index(idx);
        let n = idx.node_count().max(1) as f64;
        let e = idx.edge_count() as f64;
        let density = (e / n).min(5.0) / 5.0 * 40.0;
        let cycles = detect_cycles_from_index(idx).len().min(20) as f64;
        let cycle_score = (1.0 - cycles / 20.0).max(0.0) * 10.0;
        let fragile = fragile_nodes_from_index(idx, 20);
        let fragile_count = fragile.len().min(20) as f64;
        let fragile_score = (1.0 - fragile_count / 20.0).max(0.0) * 20.0;
        let l4_count = dataflow_l4.max(count_l4_from_index(idx)) as f64;
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

fn handler_rename(args: &Value) -> Value {
    let old_name = args.get("old_name").or_else(|| args.get("oldName")).and_then(|v| v.as_str()).unwrap_or("");
    let new_name = args.get("new_name").or_else(|| args.get("newName")).and_then(|v| v.as_str()).unwrap_or("");
    let dry_run = args.get("dry_run").or_else(|| args.get("dryRun")).and_then(|v| v.as_bool()).unwrap_or(false);
    let _node_id = args.get("node_id").or_else(|| args.get("nodeId")).and_then(|v| v.as_str());
    if old_name.is_empty() || new_name.is_empty() {
        return json!({"error": "old_name and new_name are required"});
    }
    if dry_run {
        return with_graph(|g| {
            let matched: Vec<_> = g.nodes.values().filter(|n| n.name == old_name).collect();
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
        });
    }
    let (matched_ids, count) = {
        match engine::engine_read(|idx| {
            let ids: Vec<String> = idx.nodes_iter().filter(|n| n.name == old_name).map(|n| n.id.clone()).collect();
            (ids.len(), ids)
        }) {
            Ok((0, _)) => return json!({"error": format!("No nodes match '{}'", old_name)}),
            Ok((cnt, ids)) => (ids, cnt),
            Err(e) => return json!({"error": e}),
        }
    };
    if let Err(e) = engine::engine_write(|idx| {
        for nid in &matched_ids {
            idx.rename_node_name(nid, &new_name);
        }
    }) {
        return json!({"error": e});
    }
    let _ = engine::engine_save();
    json!({
        "dry_run": false,
        "old_name": old_name,
        "new_name": new_name,
        "renamed_count": count,
        "renamed_ids": matched_ids,
        "note": "Rename applied to graph and persisted to storage.",
    })
}

fn handler_status(_args: &Value) -> Value {
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
            json!({
                "phase": phase,
                "store": "MemoryIndex",
                "nodes": nodes,
                "edges": edges,
                "has_aux_indexes": has_aux,
                "is_watching": is_watching,
            })
        }
        Err(_) => json!({"phase": "empty", "store": "none", "nodes": 0, "edges": 0}),
    }
}

fn handler_policy_check(args: &Value) -> Value {
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
            "message": format!("{} -> {} dependency violation", source, target),
        });
        if let Some(kinds) = args.get("edge_kinds") {
            rule["edge_kinds"] = kinds.clone();
        }
        json!([rule])
    } else {
        return json!({"error": "Provide either 'rules' (array of rule objects) or both 'source' and 'target' (string patterns)."});
    };
    with_store(|idx| policy_check_from_index(idx, &rules))
}

fn handler_node(args: &Value) -> Value {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return json!({"error": "node_id is required"});
    }
    with_store(|idx| {
        let resolved = match resolve_in_index(idx, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node '{}' not found in graph", node_id)}),
        };
        let node = idx.get_node(&resolved).unwrap().clone();
        let incoming = idx.get_incoming_edges(&resolved);
        let outgoing = idx.get_outgoing_edges(&resolved);
        let group_by_kind = |edges: &[Edge]| -> serde_json::Map<String, Value> {
            let mut groups: serde_json::Map<String, Value> = serde_json::Map::new();
            for e in edges {
                let k = e.kind.as_str().to_string();
                groups
                    .entry(k)
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap()
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

fn handler_unused(args: &Value) -> Value {
    let limit = get_usize(args, "limit", 20).min(200);
    let kind_str = args
        .get("kind_filter")
        .and_then(|v| v.as_str())
        .unwrap_or("function,class");
    let kind_label = kind_str.to_string();
    let kinds: Vec<&str> = kind_str.split(',').map(|s| s.trim()).collect();
    with_store(|idx| {
        let mut candidates: Vec<&Node> = idx
            .nodes_iter()
            .filter(|n| n.in_degree == 0 && kinds.iter().any(|k| n.kind.as_str() == *k))
            .collect();
        candidates.sort_by_key(|n| std::cmp::Reverse(n.out_degree));
        candidates.truncate(limit);
        json!({
            "total_unused": candidates.len(),
            "limit": limit,
            "kind_filter": kind_label,
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

/// On-demand type-aware call resolution. Tries real LSP server first,
/// falls back to handwritten adapters transparently.
fn handler_resolve_call(args: &Value) -> Value {
    let file_path = args.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let func_name = args.get("function").and_then(|v| v.as_str()).unwrap_or("");
    let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let column = args.get("column").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if file_path.is_empty() {
        return json!({"error": "file is required"});
    }
    let root = project_root();
    let abs_path = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        root.join(file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();

    // Read source
    let source = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) => return json!({"error": format!("cannot read file: {}", e)}),
    };

    // ── Path 1: Real LSP server (if pool is warm) ──
    let lsp_result = if line > 0 || column > 0 {
        crate::lsp_manager::LspManager::resolve_definition(
            &path_str, &source, line, column, &ext,
        )
        .ok()
        .map(|locs| {
            locs.iter()
                .map(|loc| json!({
                    "file": crate::lsp_manager::uri_to_path(&loc.uri),
                    "line": loc.range_start_line,
                    "column": loc.range_start_char,
                    "backend": "native_lsp",
                }))
                .collect::<Vec<_>>()
        })
    } else {
        None
    };

    if let Some(ref locs) = lsp_result {
        if !locs.is_empty() {
            return json!({
                "file": path_str,
                "function": func_name,
                "backend": "native_lsp",
                "definitions": locs,
                "note": "resolved via real LSP server",
            });
        }
    }

    // ── Path 2: Handwritten adapter (always available) ──
    let Some(tree) = engine::reparse_source_lsp(&source, &ext) else {
        return json!({"error": format!("parse failed or unsupported extension: {}", ext)});
    };
    let module_qn = path_str.trim_end_matches(&format!(".{}", ext)).replace(['/', '\\'], ".");
    let registry = match engine::engine_read_graph(|g| {
        crate::adapter::type_registry::TypeRegistry::from_graph(g)
    }) {
        Ok(r) => r,
        Err(e) => return json!({"error": format!("cannot access graph: {}", e)}),
    };

    use crate::adapter::*;
    use crate::adapter::ResolvedCall;
    let raw_calls: Vec<ResolvedCall> = match ext.as_str() {
        "py" | "pyi" => python_lsp::run_py_lsp(&source, &tree, &module_qn, &registry),
        "go" => go_lsp::run_go_lsp(&source, &tree, &module_qn, &registry),
        "java" => java_lsp::run_java_lsp(&source, &tree, &module_qn, &registry),
        "cs" => cs_lsp::run_cs_lsp(&source, &tree, &module_qn, &registry),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
            ts_lsp::run_ts_lsp(&source, &tree, &module_qn, &registry).0
        }
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" =>
            c_lsp::run_c_lsp(&source, &tree, &module_qn, &registry),
        "php" => php_lsp::run_php_lsp(&source, &tree, &module_qn, &registry),
        "kt" | "kts" => kotlin_lsp::run_kotlin_lsp(&source, &tree, &module_qn, &registry),
        "rs" => rust_lsp::run_rust_lsp(&source, &tree, &module_qn, &registry),
        _ => return json!({"error": format!("unsupported extension: .{}", ext)}),
    };

    let call_values: Vec<Value> = raw_calls
        .into_iter()
        .map(|rc| json!({
            "caller": rc.caller_qn, "callee": rc.callee_qn,
            "strategy": rc.strategy, "confidence": rc.confidence,
        }))
        .collect();

    let filtered: Vec<&Value> = if func_name.is_empty() {
        call_values.iter().collect()
    } else {
        call_values
            .iter()
            .filter(|c| {
                c.get("caller")
                    .and_then(|v| v.as_str())
                    .map(|s| s.contains(func_name))
                    .unwrap_or(false)
            })
            .collect()
    };

    json!({
        "file": path_str,
        "function": func_name,
        "backend": if lsp_result.is_some() { "hybrid" } else { "handwritten" },
        "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
        "resolved_calls": filtered,
        "total": filtered.len(),
    })
}

/// Resolve the type of a symbol at a specific position.
fn handler_resolve_type(args: &Value) -> Value {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // Try native LSP
    match crate::lsp_manager::LspManager::resolve_type(&path_str, &source, line, column, &ext) {
        Ok(hover) if !hover.is_empty() => {
            return json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "type_info": hover,
            });
        }
        _ => {}
    }

    // Fallback: handwritten type inference via eval_expr_type on the adapter
    let Some(tree) = engine::reparse_source_lsp(&source, &ext) else {
        return json!({"error": format!("parse failed for .{}", ext)});
    };
    // ponytail: walk to the node at (line, column) in the parse tree and eval its type
    // For now return what the adapter can do at file level
    let module_qn = path_str.trim_end_matches(&format!(".{}", ext)).replace(['/', '\\'], ".");
    let registry = match engine::engine_read_graph(|g| {
        crate::adapter::type_registry::TypeRegistry::from_graph(g)
    }) {
        Ok(r) => r,
        Err(e) => return json!({"error": format!("cannot access graph: {}", e)}),
    };

    use crate::adapter::*;
    let calls: Vec<Value> = match ext.as_str() {
        "py" | "pyi" => python_lsp::run_py_lsp(&source, &tree, &module_qn, &registry),
        "go" => go_lsp::run_go_lsp(&source, &tree, &module_qn, &registry),
        "java" => java_lsp::run_java_lsp(&source, &tree, &module_qn, &registry),
        "cs" => cs_lsp::run_cs_lsp(&source, &tree, &module_qn, &registry),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
            ts_lsp::run_ts_lsp(&source, &tree, &module_qn, &registry).0
        }
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" =>
            c_lsp::run_c_lsp(&source, &tree, &module_qn, &registry),
        "php" => php_lsp::run_php_lsp(&source, &tree, &module_qn, &registry),
        "kt" | "kts" => kotlin_lsp::run_kotlin_lsp(&source, &tree, &module_qn, &registry),
        "rs" => rust_lsp::run_rust_lsp(&source, &tree, &module_qn, &registry),
        _ => return json!({"error": format!("unsupported extension: .{}", ext)}),
    }
    .into_iter()
    .map(|rc| json!({"caller": rc.caller_qn, "callee": rc.callee_qn, "strategy": rc.strategy, "confidence": rc.confidence}))
    .collect();

    json!({
        "file": path_str, "line": line, "column": column,
        "backend": "handwritten",
        "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
        "note": "Type resolution via call targets — use native LSP (rust-analyzer/gopls/pyright) for precise type info",
        "resolved_calls": calls,
    })
}

/// Find all implementations of an interface/trait at a specific position.
fn handler_find_implementations(args: &Value) -> Value {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // Try native LSP
    match crate::lsp_manager::LspManager::find_implementations(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "implementations": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            });
        }
        _ => {}
    }

    // Fallback: use registry to find types
    match engine::engine_read_graph(|g| {
        crate::adapter::type_registry::TypeRegistry::from_graph(g)
    }) {
        Ok(registry) => {
            // ponytail: without a specific position, return all non-interface types
            let impls: Vec<Value> = registry.types_by_qn.iter()
                .filter(|(_, rt)| !rt.is_interface && rt.alias_of.is_none())
                .take(50)
                .map(|(qn, _)| json!({"qualified_name": qn}))
                .collect();
            json!({
                "file": path_str, "line": line, "column": column,
                "backend": "registry",
                "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
                "note": "Registry-based fallback — use native LSP for precise interface implementations",
                "implementations": impls,
                "count": impls.len(),
            })
        }
        Err(e) => json!({"error": format!("cannot access graph: {}", e)}),
    }
}

/// Find all references to a symbol at a specific position.
fn handler_find_references(args: &Value) -> Value {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;
    let _include_decl = args.get("includeDeclaration").and_then(|v| v.as_bool()).unwrap_or(false);

    // Try native LSP
    match crate::lsp_manager::LspManager::find_references(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "references": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            });
        }
        _ => {}
    }

    // Fallback: use graph to find incoming references
    match engine::engine_read_graph(|g| {
        let _node_ids: Vec<String> = g.nodes.keys().cloned().collect();
        let refs: Vec<Value> = g.edges.iter()
            .take(100)
            .map(|(_, e)| json!({
                "source": e.source,
                "target": e.target,
                "kind": format!("{:?}", e.kind),
            }))
            .collect();
        json!({
            "file": path_str, "line": line, "column": column,
            "backend": "graph",
            "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
            "note": "Graph-based fallback — use native LSP for precise symbol references. Provide line+column for precise resolution.",
            "references": refs,
            "count": refs.len(),
        })
    }) {
        Ok(v) => v,
        Err(e) => json!({"error": format!("cannot access graph: {}", e)}),
    }
}

/// Shared preparation for resolve_* tools: read file, get ext, return (path, source, ext).
fn resolve_tool_prepare(args: &Value) -> Result<(String, String, String), Value> {
    let file_path = get_str(args, &["file"]);
    if file_path.is_empty() {
        return Err(json!({"error": "file is required"}));
    }
    let root = project_root();
    let abs_path = if Path::new(&file_path).is_absolute() {
        PathBuf::from(&file_path)
    } else {
        root.join(&file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();
    let source = std::fs::read_to_string(&abs_path)
        .map_err(|e| json!({"error": format!("cannot read file: {}", e)}))?;
    Ok((path_str, source, ext))
}

fn handler_dataflow(args: &Value) -> Value {
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return json!({"error": "files is required and must be a non-empty array"});
    }
    let root = project_root();
    let paths: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            let p = Path::new(f);
            if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
        })
        .collect();
    let results = crate::analysis::dataflow_engine::query_dataflow_files(&paths);
    let json_results: Vec<Value> = results
        .iter()
        .map(|r| match &r.result {
            Ok(df) => json!({
                "file": r.file,
                "scopes": df.scopes.iter().map(|s| json!({
                    "name": s.name,
                    "reads": s.reads,
                    "writes": s.writes,
                    "triggers": s.triggers,
                    "awaits_callbacks": s.awaits_callbacks,
                    "sequence_calls": s.sequence_calls,
                })).collect::<Vec<_>>(),
                "shared": df.shared.iter().map(|sh| json!({
                    "var": sh.var,
                    "readers": sh.readers,
                    "writers": sh.writers,
                })).collect::<Vec<_>>(),
            }),
            Err(e) => json!({"file": r.file, "error": e}),
        })
        .collect();
    json!({"results": json_results})
}

// ═══════════════════════════════════════════════════════════════
// Schema definitions
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

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

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
        let result = ToolRegistry::dispatch("nonexistent_tool", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("not found"));
    }

    #[test]
    fn test_all_tools_dispatchable() {
        let schemas = all_schemas();
        for schema in schemas {
            let args = json!({});
            let result = ToolRegistry::dispatch(schema.name, &args);
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
        let result = ToolRegistry::dispatch("get_neighbors", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("node_id"));
        let result = ToolRegistry::dispatch("find_dep_path", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("from_id"));
        let result = ToolRegistry::dispatch("coupling_report", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("module_name"));
        let result = ToolRegistry::dispatch("search_symbols", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("query"));
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
