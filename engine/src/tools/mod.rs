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
use crate::routing::preflight::run_full_check;
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
            "hologram_neighbors" => handler_neighbors(args),
            "hologram_impact" => handler_impact(args),
            "hologram_path" => handler_path(args),
            "hologram_history" => handler_history(args),
            "hologram_community" => handler_community(args),
            "hologram_delayed" => handler_delayed(args),
            "hologram_fragile" => handler_fragile(args),
            "hologram_cycle" => handler_cycle(args),
            "hologram_thread_conflicts" => handler_thread_conflicts(args),
            "hologram_coupling_report" => handler_coupling_report(args),
            "hologram_timeline" => handler_timeline(args),
            "hologram_blindspots" => handler_blindspots(args),
            "hologram_run_preflight" | "hologram_preflight" => handler_preflight(args),
            "hologram_search" => handler_search(args),
            "hologram_explore" => handler_explore(args),
            "hologram_graph_summary" => handler_graph_summary(args),
            "hologram_clusters" | "hologram_community_report" => handler_clusters(args),
            "hologram_graph_diff" | "hologram_diff" => handler_diff(args),
            "hologram_analyze" => handler_analyze(args),
            "hologram_run_check" => handler_run_check(args),
            "hologram_run_health" => handler_run_health(args),
            "hologram_rename" => handler_rename(args),
            "hologram_status" => handler_status(args),
            "hologram_policy_check" => handler_policy_check(args),
            "hologram_node" => handler_node(args),
            "hologram_unused" => handler_unused(args),
            "hologram_dataflow" => handler_dataflow(args),
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
        .unwrap_or(default)
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

fn handler_history(args: &Value) -> Value {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return json!({"error": "node_id is required"});
    }
    let decision_history = engine::engine_query_timeline(20).unwrap_or_default();
    match engine::engine_read(|idx| {
        let resolved = match resolve_in_index(idx, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let node = idx.get_node(&resolved).unwrap().clone();
        let dep_count = idx.incoming(&resolved, None).len();
        let out_count = idx.outgoing(&resolved, None).len();
        json!({
            "node": node_to_value(&node),
            "decision_history": decision_history,
            "dependency_count": dep_count,
            "dependent_count": out_count,
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
        let incoming = g.incoming_edges(&resolved);
        let outgoing = g.outgoing_edges(&resolved);
        json!({
            "node": node_to_value(node),
            "decision_history": decision_history,
            "dependency_count": incoming.len(),
            "dependent_count": outgoing.len(),
        })
    })
}

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
        discover_source_files(&root, 200)
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
    with_store(|idx| {
        let fragile = fragile_nodes_from_index(idx, limit);
        json!({"fragile_modules": fragile, "limit": limit})
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
    let _node_id = args.get("node_id").and_then(|v| v.as_str()).map(|s| s.to_string());
    let root = project_root();
    with_store(|idx| {
        let mut resources = serde_json::Map::new();
        let files: Vec<PathBuf> = discover_source_files(&root, 200);
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
    let module = args.get("module_name").and_then(|v| v.as_str()).unwrap_or("");
    if module.is_empty() {
        return json!({"error": "module_name is required"});
    }
    let root = project_root();
    with_store(|idx| {
        let report = coupling_report_from_index(idx, module);
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
        let files: Vec<PathBuf> = discover_source_files(&root, 200);
        let df_results = crate::analysis::dataflow_engine::query_dataflow_files(&files);
        let mut l4 = count_l4_from_index(idx);
        let mut conflict_count = 0usize;
        let mut var_writers: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for r in &df_results {
            if let Ok(df) = &r.result {
                for s in &df.scopes {
                    l4 = l4.max(s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len());
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
    let before_path = args.get("before_path").and_then(|v| v.as_str()).unwrap_or("");
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
            "message": "Analysis already in progress. Call hologram_status to track progress.",
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
        "message": "Analysis running in background. Call hologram_status to track progress.",
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
    let before = engine::engine_read_graph(|g| g.clone()).ok();
    match engine::engine_init(&root) {
        Ok(_) => {}
        Err(e) => return json!({"error": format!("Engine init failed: {}", e)}),
    }
    let analyze_result = match engine::engine_analyze(&root) {
        Ok(r) => r,
        Err(e) => return json!({"error": e}),
    };
    let after = analyze_result.graph.clone();
    let before_graph = before.unwrap_or_else(|| after.clone());
    let changed_files: Vec<String> = vec![];
    let check_result = run_full_check(&before_graph, &after, &changed_files, path);
    let passed = check_result["passed"].as_bool().unwrap_or(true);
    let violation_count = check_result["violation_count"].as_u64().unwrap_or(0);
    let event_type = if passed { "commit_clean" } else { "commit_violation" };
    let summary = if passed {
        format!("Check passed ({} violations)", violation_count)
    } else {
        format!("Check failed: {} violations", violation_count)
    };
    let props = json!({"passed": check_result["passed"], "violation_count": check_result["violation_count"]});
    let _ = engine::engine_record_timeline_with_props(event_type, None::<&str>, &summary, &props);
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
        let files: Vec<PathBuf> = discover_source_files(&root, 200);
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
        // V1 — graph queries
        ToolSchema {
            name: "hologram_neighbors",
            description: "Get first-order neighbors of a node, grouped by edge type (structural, data, temporal). Returns incoming and outgoing edges with coupling depth.",
            params: &[p!("node_id", "string", "The node ID")],
            required: &["node_id"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_impact",
            description: "BFS impact analysis from a source node. Returns layered results at each distance level with edge types and temporal delay info. Useful for estimating blast radius of a change.",
            params: &[p!("node_id", "string", "The source node ID"), p!("depth", "integer", "BFS max depth (default 3)")],
            required: &["node_id"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_path",
            description: "Find all paths between two nodes. Each path includes hop count and edge types along the route. Useful for understanding indirect dependencies.",
            params: &[p!("from_id", "string", "Source node ID"), p!("to_id", "string", "Target node ID"), p!("depth", "integer", "BFS search depth limit (default 20)")],
            required: &["from_id", "to_id"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_history",
            description: "Get decision history for a node — shows which past decisions involved this node. Returns dependency/dependent counts and timeline events.",
            params: &[p!("node_id", "string", "The node ID")],
            required: &["node_id"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_community",
            description: "Get community information for a node — its community ID, parent community, and sibling nodes. Uses Leiden algorithm for community detection.",
            params: &[p!("node_id", "string", "The node ID")],
            required: &["node_id"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_delayed",
            description: "Get all temporal/delayed edges — async triggers, awaits/callbacks, and sequenced calls. Sources data from the dataflow engine rather than the static graph.",
            params: &[],
            required: &[],
            read_only: true,
            category: "temporal",
        },
        // V2 — analysis
        ToolSchema {
            name: "hologram_fragile",
            description: "Get top N most fragile modules ranked by L4 encapsulation violation density. Higher scores indicate more temporal coupling and hidden dependencies.",
            params: &[p!("limit", "integer", "Number of top fragile modules to return (default 5)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "hologram_cycle",
            description: "Get all detected data flow cycles in the dependency graph. Filter by mode: all (every cycle), data (persistent data dependencies), or llm (AI/LLM-involved cycles).",
            params: &[p!("mode", "string", "Filter: all, data, or llm (default all)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "hologram_thread_conflicts",
            description: "Get thread vs resource conflict matrix. Detects shared variables with multiple writers (concurrency risk) and medium nodes with concurrent access patterns.",
            params: &[p!("node_id", "string", "Optional node ID — if omitted, returns global conflict matrix")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "hologram_coupling_report",
            description: "Get complete coupling depth distribution (L1-L4 statistics) for a specific module. L1=imports, L2=calls/inheritance, L3=data sharing, L4=temporal/async coupling.",
            params: &[p!("module_name", "string", "Module file name or path")],
            required: &["module_name"],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "hologram_timeline",
            description: "Query the causal audit timeline — shows a chronological log of analysis runs, commits, violations, and other significant events in the project lifecycle.",
            params: &[p!("limit", "integer", "Max events to return (default 100)"), p!("since", "string", "ISO timestamp filter (optional)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // V2 — boundary
        ToolSchema {
            name: "hologram_blindspots",
            description: "Get all detected architectural boundaries and risks — L4 encapsulation violations, unlocked concurrency, and LLM feedback loops. The boundary radar for your codebase.",
            params: &[p!("filter", "string", "Boundary type filter: all, L4, thread, cycle (default all)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // V3 — preflight
        ToolSchema {
            name: "hologram_run_preflight",
            description: "Pre-flight change impact analysis. Given a list of files you plan to change, estimates blast radius, risk level, shared variable impacts, and temporal edge signals before you commit.",
            params: &[p!("files", "array", "List of file paths that would be changed")],
            required: &["files"],
            read_only: true,
            category: "preflight",
        },
        // V3+ — query & explore
        ToolSchema {
            name: "hologram_search",
            description: "Fuzzy search for nodes by name or ID. Uses FTS5 full-text search when available, falls back to linear scan. Returns matching nodes with metadata.",
            params: &[p!("query", "string", "Partial name or ID to search for"), p!("limit", "integer", "Max results (default 20)")],
            required: &["query"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_explore",
            description: "Unified dependency exploration — combines flow path, blast radius, relationships, source code, and architecture alerts in a single response. Accepts natural language queries or explicit symbol names.",
            params: &[p!("query", "string", "Natural language query (e.g. 'DataRequest validate task'). Auto-extracts symbol names."), p!("symbols", "array", "List of symbol names (alternative to query)"), p!("includeSource", "boolean", "Include source code sections (default true)")],
            required: &[],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_graph_summary",
            description: "Get a high-level summary of the current dependency graph — node/edge counts, language breakdown, density metrics, and top-level architecture overview.",
            params: &[],
            required: &[],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_clusters",
            description: "Report on cluster/community structure in the codebase. Shows communities ordered by size with their member node IDs and derived labels based on most common file paths.",
            params: &[p!("min_size", "integer", "Minimum community size to report (default 3)"), p!("max_nodes", "integer", "Max node IDs per community in output (default 20, max 200)")],
            required: &[],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "hologram_graph_diff",
            description: "Compare the current dependency graph against a baseline snapshot. Shows added/removed/modified nodes and edge count changes. Auto-creates baseline on first run.",
            params: &[p!("before_path", "string", "Path to the baseline graph JSON file")],
            required: &["before_path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "hologram_analyze",
            description: "Re-analyze a project directory and reload the dependency graph. Runs the full pipeline (parse, LSP, cross-file, coupling, communities) in a background thread.",
            params: &[p!("path", "string", "Project root directory path")],
            required: &["path"],
            read_only: false,
            category: "operations",
        },
        // V3 — check + health
        ToolSchema {
            name: "hologram_run_check",
            description: "Run full constraint validation (V3) on the current project. Re-analyzes, diffs against baseline, and runs all structural constraint checks. Records results to timeline.",
            params: &[p!("path", "string", "Project root directory path")],
            required: &["path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "hologram_run_health",
            description: "Get current project health snapshot with a composite score (0-100) based on graph density, coupling depth, fragile modules, and cycle counts. Trend line requires historical data.",
            params: &[p!("path", "string", "Project root directory path"), p!("days", "integer", "Days to look back (default 30)")],
            required: &["path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "hologram_rename",
            description: "Safely rename a symbol across the dependency graph. Supports dry-run mode to preview changes before committing. Persists to storage after rename.",
            params: &[p!("oldName", "string", "Current symbol name"), p!("newName", "string", "New symbol name"), p!("dryRun", "boolean", "Preview only — no changes applied (default false)"), p!("nodeId", "string", "Optional specific node ID to rename")],
            required: &["oldName", "newName"],
            read_only: false,
            category: "operations",
        },
        ToolSchema {
            name: "hologram_status",
            description: "Get engine loading status and memory statistics — current phase, node/edge counts, aux index availability, and file watcher state.",
            params: &[],
            required: &[],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "hologram_policy_check",
            description: "Check project boundary rules against the dependency graph. Define rules with source/target file patterns (glob or regex) and edge kinds. Returns violations where source files have forbidden edges to target files. Use this to enforce architectural boundaries.",
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
        // V4 — node deep-dive
        ToolSchema {
            name: "hologram_node",
            description: "Complete deep-dive into a single node — identity metadata, in/out degree, community membership, and all incoming/outgoing edges grouped by kind. Combines neighbors + community in one call.",
            params: &[p!("node_id", "string", "The node ID")],
            required: &["node_id"],
            read_only: true,
            category: "graph",
        },
        // V4 — dead code detection
        ToolSchema {
            name: "hologram_unused",
            description: "Find potentially unused symbols — nodes with zero incoming references (in_degree=0). Sorted by out_degree descending so the most impactful candidates appear first. Defaults to functions and classes.",
            params: &[
                p!("limit", "integer", "Max results (default 20, max 200)"),
                p!("kind_filter", "string", "Node kinds to include, comma-separated. Default: \"function,class\". Options: symbol, function, class, module, interface, medium, temporal."),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // Dataflow tracing
        ToolSchema {
            name: "hologram_dataflow",
            description: "Per-function variable reads/writes, cross-function shared state, async triggers, and call sequences. Run on specific files to answer questions like 'where is X written?' or 'who reads Y?'.",
            params: &[p!("files", "array", "File paths, e.g. [\"src/auth.js\", \"src/db.js\"]")],
            required: &["files"],
            read_only: true,
            category: "dataflow",
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
        assert_eq!(schemas.len(), 27, "must have exactly 27 tools");
    }

    #[test]
    fn test_mcp_tools_list_format() {
        let registry = ToolRegistry::global();
        let tools = registry.tools_list();
        assert_eq!(tools.len(), 27);
        for tool in &tools {
            assert!(tool.get("name").and_then(|v| v.as_str()).is_some(), "every tool must have a name");
            assert!(tool.get("description").and_then(|v| v.as_str()).is_some(), "every tool must have a description");
            assert!(tool.get("inputSchema").is_some(), "every tool must have inputSchema");
        }
    }

    #[test]
    fn test_dispatch_unknown_tool() {
        let result = ToolRegistry::dispatch("hologram_nonexistent", &json!({}));
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
        let schema = registry.get_schema("hologram_neighbors");
        assert!(schema.is_some());
        assert_eq!(schema.unwrap().name, "hologram_neighbors");
        assert!(registry.get_schema("hologram_nonexistent").is_none());
    }

    #[test]
    fn test_missing_required_params_error() {
        let result = ToolRegistry::dispatch("hologram_neighbors", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("node_id"));
        let result = ToolRegistry::dispatch("hologram_path", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("from_id"));
        let result = ToolRegistry::dispatch("hologram_coupling_report", &json!({}));
        assert!(result.get("error").and_then(|v| v.as_str()).unwrap().contains("module_name"));
        let result = ToolRegistry::dispatch("hologram_search", &json!({}));
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
        assert!(!read_only_tools.contains(&"hologram_analyze"), "analyze mutates state");
        assert!(!read_only_tools.contains(&"hologram_rename"), "rename mutates state");
        assert!(read_only_tools.contains(&"hologram_neighbors"));
        assert!(read_only_tools.contains(&"hologram_search"));
        assert!(read_only_tools.contains(&"hologram_status"));
    }
}
