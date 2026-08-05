
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 工具处理器实现。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use crate::analysis::*;
use crate::community::detect_communities_from_index;
use crate::engine;
use crate::graph::{query, Edge, Graph, Node};
use crate::routing::preflight::{load_baseline, run_full_check, save_baseline};
use super::{get_str, get_usize, project_root, with_store};
use super::{with_graph, resolve_in_index, resolve_in_graph};
use super::{node_to_value, edge_to_value, discover_source_files, derive_comm_label};
use super::ToolResponse;

pub(crate) fn handler_neighbors(args: &Value) -> ToolResponse {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return ToolResponse::Degraded {
            guidance: "node_id is required".into(),
            fallback: "Provide a valid node_id to look up neighbors".into(),
            details: json!({}),
        };
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
            "incoming": incoming.iter().map(edge_to_value).collect::<Vec<_>>(),
            "outgoing": outgoing.iter().map(edge_to_value).collect::<Vec<_>>(),
        })
    }) {
        Ok(value) if value.get("error").is_none() => return ToolResponse::Success(value),
        Ok(value) => {
            let msg = value.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Use search_symbols to find the node first".into(),
                details: json!({}),
            };
        }
        Err(_) => {}
    }
    ToolResponse::Success(with_graph(|g| {
        let resolved = match resolve_in_graph(g, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let node = g.get_node(&resolved).unwrap();
        let nb = query::neighbors(g, &resolved, 1);
        let incoming: Vec<_> = g.incoming(&resolved).map(edge_to_value).collect();
        let outgoing: Vec<_> = g.outgoing(&resolved).map(edge_to_value).collect();
        json!({
            "node": node_to_value(node),
            "neighbor_count": nb.len(),
            "neighbors": nb.iter().map(|(_, t, d)| json!({"id": t, "coupling_depth": d})).collect::<Vec<_>>(),
            "incoming": incoming,
            "outgoing": outgoing,
        })
    }))
}

pub(crate) fn handler_impact(args: &Value) -> ToolResponse {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return ToolResponse::Degraded {
            guidance: "node_id is required".into(),
            fallback: "Use search_symbols to find the node first".into(),
            details: json!({}),
        };
    }
    let depth = get_usize(args, "depth", 3);
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

pub(crate) fn handler_path(args: &Value) -> ToolResponse {
    let from_id = get_str(args, &["from_id", "fromId", "from"]);
    let to_id = get_str(args, &["to_id", "toId", "to"]);
    if from_id.is_empty() || to_id.is_empty() {
        return ToolResponse::Degraded {
            guidance: "from_id and to_id are required".into(),
            fallback: "Use search_symbols to find both nodes first".into(),
            details: json!({}),
        };
    }
    let depth = get_usize(args, "depth", 20).max(1);
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

// ponytail：handler_history 已删除 —— symbol_history 现在路由到 handler_node（输出更丰富）

pub(crate) fn handler_community(args: &Value) -> ToolResponse {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return ToolResponse::Degraded {
            guidance: "node_id is required".into(),
            fallback: "Use search_symbols to find the node first".into(),
            details: json!({}),
        };
    }
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

pub(crate) fn handler_delayed(args: &Value) -> ToolResponse {
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
    ToolResponse::Success(json!({
        "total_delayed_edges": total,
        "triggers_count": triggers.len(),
        "awaits_count": awaits.len(),
        "sequences_count": sequences.len(),
        "triggers": triggers,
        "awaits": awaits,
        "sequences": sequences,
        "_note": "from dataflow engine (on-demand query, no graph storage)",
    }))
}

// ═══════════════════════════════════════════════════════════════
// V2 分析处理器
// ═══════════════════════════════════════════════════════════════

pub(crate) fn handler_fragile(args: &Value) -> ToolResponse {
    let limit = get_usize(args, "limit", 5).max(1);
    ToolResponse::Success(with_store(|idx| {
        let mut file_scores: std::collections::HashMap<String, (f64, usize)> = std::collections::HashMap::new();
        for node in idx.nodes_iter() {
            let loc = match node.location.as_ref() {
                Some(l) => l.replace('\\', "/"),
                None => continue,
            };
            let file_path = loc.rsplit_once(':').map(|(f, _)| f.to_string()).unwrap_or(loc);

            let out_raw = idx.outgoing(&node.id, None);
            let incoming_raw = idx.incoming(&node.id, None);
            let out: Vec<_> = out_raw.into_iter()
                .filter(|(tgt, _, _, _)| !idx.is_edge_synthesized(&node.id, tgt))
                .collect();
            let incoming: Vec<_> = incoming_raw.into_iter()
                .filter(|(src, _, _, _)| !idx.is_edge_synthesized(src, &node.id))
                .collect();

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

        let mut scored: Vec<(f64, String, usize)> = Vec::new();
        for (file, (struct_score, node_count)) in &file_scores {
            let avg_struct = struct_score / (*node_count as f64).max(1.0);
            scored.push((avg_struct, file.clone(), *node_count));
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit);

        let result: Vec<serde_json::Value> = scored.iter().map(|(score, file, nodes)| {
            let short_name = file.rsplit('/').next().unwrap_or(file).to_string();
            json!({
                "module": short_name,
                "file": file,
                "fragility_score": format!("{:.1}", score),
                "node_count": nodes,
                "_score_breakdown": format!("struct={:.1}", score),
            })
        }).collect();

        json!({
            "fragile_modules": result,
            "limit": limit,
            "_note": "排名基于 L1/L2 结构耦合（Imports/Calls/Defines）。L3/L4 时序和数据耦合由数据流引擎按需计算，用 trace_dataflow 或 async_edges 查询。"
        })
    }))
}

pub(crate) fn handler_cycle(args: &Value) -> ToolResponse {
    let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("all");
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

pub(crate) fn handler_thread_conflicts(_args: &Value) -> ToolResponse {
    ToolResponse::Success(with_store(|idx| {
        use crate::graph::EdgeKind;
        // 扫描所有 Writes / Shares 边，查找有多个写入者的共享资源。
        // "资源"是任何有 ≥2 个不同源节点写入/共享的图节点。
        let mut writers: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for (source, targets) in idx.edges_iter() {
            for (target, kind, _, _) in targets {
                if matches!(kind, EdgeKind::Writes | EdgeKind::Shares) {
                    writers.entry(target)
                        .or_default()
                        .push(source.clone());
                }
            }
        }

        let mut resources: Vec<serde_json::Value> = Vec::new();
        let mut total_unlocked = 0usize;
        for (resource, sources) in &writers {
            // 去重源节点（同一函数可能多次写入）
            let mut unique: Vec<&str> = sources.iter().map(|s| s.as_str()).collect();
            unique.sort();
            unique.dedup();
            if unique.len() >= 2 {
                total_unlocked += 1;
                resources.push(json!({
                    "resource": resource,
                    "writers": unique,
                    "writer_count": unique.len(),
                }));
            }
        }
        resources.sort_by(|a, b| b["writer_count"].as_u64().cmp(&a["writer_count"].as_u64()));

        json!({
            "total_shared_resources": writers.len(),
            "unlocked_concurrent_writes": total_unlocked,
            "unlocked_resources": resources,
            "_note": "Scans Writes/Shares edges for resources accessed by ≥2 functions. For per-variable temporal analysis use trace_dataflow.",
        })
    }))
}

pub(crate) fn handler_coupling_report(args: &Value) -> ToolResponse {
    let module = get_str(args, &["module_name", "module"]);
    if module.is_empty() {
        return ToolResponse::Degraded {
            guidance: "module_name is required".into(),
            fallback: "Use cluster_report to find modules first".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

pub(crate) fn handler_timeline(args: &Value) -> ToolResponse {
    let limit = get_usize(args, "limit", 100).max(1);
    let events = engine::engine_query_timeline(limit).unwrap_or_default();
    ToolResponse::Success(json!({"events": events, "total": events.len()}))
}

pub(crate) fn handler_blindspots(args: &Value) -> ToolResponse {
    let filter = args.get("filter").and_then(|v| v.as_str()).unwrap_or("all");
    let detail = args.get("detail").and_then(|v| v.as_bool()).unwrap_or(false);
    ToolResponse::Success(with_store(|idx| {
        let l4_total = count_l4_from_index(idx);
        let cycles = detect_cycles_from_index(idx);
        let mut blind = find_blindspots(l4_total, cycles.len(), 0);

        // 当 filter 为 "L4" 或请求 detail 时，包含按文件的 L4 分解
        if detail || filter == "L4" {
            let l4_files: Vec<serde_json::Value> = count_l4_by_file(idx)
                .into_iter()
                .take(20)
                .map(|(file, count)| json!({"file": file, "l4_edges": count}))
                .collect();
            blind["l4_breakdown"] = json!(l4_files);
            blind["l4_total"] = json!(l4_total);
        }

        json!(blind)
    }))
}

pub(crate) fn handler_preflight(args: &Value) -> ToolResponse {
    let files: Vec<String> = args
        .get("files")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return ToolResponse::Degraded {
            guidance: "files list is required".into(),
            fallback: "Provide a list of file paths to check".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

pub(crate) fn handler_search(args: &Value) -> ToolResponse {
    let query_str = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = get_usize(args, "limit", 20);
    if query_str.is_empty() {
        return ToolResponse::Degraded {
            guidance: "query is required".into(),
            fallback: "Provide a search query string".into(),
            details: json!({}),
        };
    }
    // 1. FTS5 精确搜索
    if let Ok(results) = engine::engine_fts_search(query_str, limit) {
        if !results.is_empty() {
            let mut out = json!({
                "query": query_str,
                "count": results.len(),
                "results": results.iter().map(node_to_value).collect::<Vec<_>>(),
                "engine": "fts5",
            });
            // 如果可用，附加向量搜索结果
            merge_vector_hits(&mut out, query_str, limit);
            return ToolResponse::Success(out);
        }
    }
    // 2. 线性模糊回退
    let mut out = with_graph(|g| {
        let results = query::search_nodes(g, query_str);
        let count = results.len().min(limit);
        json!({
            "query": query_str,
            "count": count,
            "results": results.iter().take(limit).map(|n| node_to_value(n)).collect::<Vec<_>>(),
            "engine": "linear",
        })
    });
    // 附加向量搜索结果
    merge_vector_hits(&mut out, query_str, limit);
    ToolResponse::Success(out)
}

/// 将向量（语义）搜索结果附加到输出（如果可用）。
/// ponytail：即发即忘 —— 如果向量索引未构建，静默跳过。
/// 过滤策略：低于后端阈值丢弃、与主结果去重、最多 5 条。
/// （HNSW 永远返回 top-k 个最近邻，不过滤会把无关噪音塞给 Agent。）
pub(crate) fn merge_vector_hits(out: &mut Value, query: &str, limit: usize) {
    let root = project_root();
    if root.as_os_str().is_empty() { return; }
    // 使用缓存的索引 —— 避免每次搜索都从磁盘重新加载 40+ MB
    let (index, slots) = match crate::vector::get_or_load_index(&root) {
        Ok(pair) => pair,
        Err(_) => return,
    };
    let idx = index.read().unwrap();
    let idx = match idx.as_ref() {
        Some(i) => i,
        None => return,
    };
    let slot_data = slots.read().unwrap();
    if slot_data.is_empty() { return; }

    let q_vec = crate::vector::embed(query);
    // 多取候选：阈值过滤与去重会淘汰一部分
    let fetch = (limit * 2).max(20);
    let results = match idx.search(&q_vec, fetch) {
        Ok(r) => r,
        Err(_) => return,
    };

    let threshold = crate::vector::score_threshold();
    let max_hits = 5usize.min(limit.max(1));

    // 与主结果集去重（FTS/linear 已覆盖的节点不再重复出现）
    let existing: std::collections::HashSet<&str> = out["results"].as_array()
        .map(|a| a.iter().filter_map(|v| v["id"].as_str()).collect())
        .unwrap_or_default();

    // usearch 按距离升序返回 → 相似度降序
    let raw: Vec<(String, f32)> = results.keys.iter().zip(results.distances.iter())
        .filter_map(|(slot_key, distance)| {
            let slot = *slot_key as usize;
            if slot >= slot_data.len() { return None; }
            let similarity = 1.0 - (*distance).min(2.0).max(0.0);
            Some((slot_data[slot].clone(), similarity))
        })
        .collect();
    let hits = crate::vector::filter_hits(&raw, threshold, max_hits, &existing);
    if hits.is_empty() { return; }

    let top = &hits[0];
    tracing::info!(
        "[vector] {} hits for \"{}\" — top: {} ({:.0}%)",
        hits.len(), query, top.0, top.1 * 100.0
    );
    let vec_results: Vec<Value> = hits.into_iter()
        .map(|(node_id, score)| json!({"node_id": node_id, "vector_score": (score * 100.0).round() as u32}))
        .collect();
    let count = vec_results.len();
    out["vector_hits"] = json!(vec_results);
    out["vector_backend"] = json!(crate::vector::backend_id());
    if let Some(obj) = out.as_object_mut() {
        // 不计入 count —— vector_hits 是独立字段。
        // count 仅反映主（FTS5/linear）结果集。
        obj.insert("vector_count".into(), json!(count));
    }
}

pub(crate) fn handler_explore(args: &Value) -> ToolResponse {
    let symbols: Vec<String> = args
        .get("symbols")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let query_str = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());
    if symbols.is_empty() && query_str.is_none() {
        return ToolResponse::Degraded {
            guidance: "symbols array or query string is required".into(),
            fallback: "Provide either a list of symbols or a natural language query".into(),
            details: json!({}),
        };
    }
    let include_source = args.get("includeSource").and_then(|v| v.as_bool()).unwrap_or(true);
    let root = project_root();
    ToolResponse::Success(with_graph(|g| explore(g, &root, &symbols, query_str.as_deref(), include_source)))
}

pub(crate) fn handler_graph_summary(_args: &Value) -> ToolResponse {
    ToolResponse::Success(with_store(graph_summary_from_index))
}

pub(crate) fn handler_clusters(args: &Value) -> ToolResponse {
    let min_size = get_usize(args, "min_size", 3).max(1);
    let max_nodes = get_usize(args, "max_nodes", 20).max(1).min(200);
    ToolResponse::Success(with_store(|idx| {
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
                let label = derive_comm_label(node_ids, idx);
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
    }))
}

pub(crate) fn handler_diff(args: &Value) -> ToolResponse {
    let before_path = args.get("before_path").or_else(|| args.get("beforePath")).and_then(|v| v.as_str()).unwrap_or("");
    if before_path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "before_path is required".into(),
            fallback: "Provide a path to the baseline graph JSON file".into(),
            details: json!({}),
        };
    }
    ToolResponse::Success(with_graph(|after| {
        let before = match Graph::from_json_file(before_path) {
            Ok(g) => g,
            Err(_) => {
                if let Some(parent) = std::path::Path::new(before_path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
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
        let diff = before.diff(after);
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
    }))
}

pub(crate) fn handler_analyze(args: &Value) -> ToolResponse {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "path is required".into(),
            fallback: "Provide the project root directory path".into(),
            details: json!({}),
        };
    }
    let root = PathBuf::from(path);
    if !root.exists() {
        return ToolResponse::Degraded {
            guidance: format!("Path not found: {}", path),
            fallback: "Verify the path exists and try again".into(),
            details: json!({}),
        };
    }
    if let Err(e) = engine::engine_init(&root) {
        return ToolResponse::Degraded {
            guidance: format!("Engine init failed: {}", e),
            fallback: "Check engine logs and retry".into(),
            details: json!({}),
        };
    }
    if engine::engine_state().is_analyzing() {
        return ToolResponse::Success(json!({
            "status": "already_running",
            "message": "Analysis already in progress. Call engine_status to track progress.",
        }));
    }
    let root_clone = root.clone();
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            if engine::engine_analyze(&root_clone).is_ok() {
                engine::with_engine(|eng| {
                    eng.stop_watcher();
                    eng.start_watcher(root_clone.clone(), None::<Box<dyn Fn(String) + Send + 'static>>);
                });
            }
        })
        .ok();
    ToolResponse::Success(json!({
        "status": "started",
        "message": "Analysis running in background. Call engine_status to track progress.",
    }))
}

pub(crate) fn handler_run_check(args: &Value) -> ToolResponse {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "path is required".into(),
            fallback: "Provide the project root directory path".into(),
            details: json!({}),
        };
    }
    let root = PathBuf::from(path);
    if !root.exists() {
        return ToolResponse::Degraded {
            guidance: format!("Path not found: {}", path),
            fallback: "Verify the path exists and try again".into(),
            details: json!({}),
        };
    }
    // 加载基线快照（上次检查保存的）用于前后对比
    let before = load_baseline(&root);
    // 优先使用内存缓存的图；仅在确实为空时才重新分析
    let after = match engine::engine_read_graph(|g| g.clone()) {
        Ok(g) if g.node_count() > 0 || g.edge_count() > 0 => g,
        _ => {
            match engine::engine_init(&root) {
                Ok(_) => {}
                Err(e) => return ToolResponse::Degraded {
                    guidance: format!("Engine init failed: {}", e),
                    fallback: "Check engine logs and retry".into(),
                    details: json!({}),
                },
            }
            match engine::engine_analyze(&root) {
                Ok(r) => r.graph,
                Err(e) => return ToolResponse::Degraded {
                    guidance: e,
                    fallback: "Check project structure and retry".into(),
                    details: json!({}),
                },
            }
        }
    };
    let changed_files: Vec<String> = args.get("changed_files")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let check_result = run_full_check(&before, &after, &changed_files, path);
    // 推进基线，使下次检查与此次快照对比
    save_baseline(&root, &after);
    // 记录到时间线（跳过静默轮询 —— 仅记录有意义的检查）
    let passed = check_result["passed"].as_bool().unwrap_or(true);
    let violation_count = check_result["violation_count"].as_u64().unwrap_or(0);
    if violation_count > 0 || !changed_files.is_empty() {
        let event_type = if passed { "commit_clean" } else { "commit_violation" };
        let summary = if passed {
            format!("Check passed ({} violations)", violation_count)
        } else {
            format!("Check failed: {} violations", violation_count)
        };
        let props = json!({
            "passed": check_result["passed"],
            "violation_count": check_result["violation_count"],
            "summary": check_result["summary"],
            "total_changed_files": check_result["total_changed_files"],
            "blast_radius": check_result["blast_radius"],
            "new_cycles": check_result["new_cycles"],
            "new_thread_conflicts": check_result["new_thread_conflicts"],
            "api_signature_changes": check_result["api_signature_changes"],
            "new_violations": check_result["new_violations"],
            "resolved_violations": check_result["resolved_violations"],
            "persistent_violations": check_result["persistent_violations"],
            "l5_violations": check_result["l5_violations"],
            "l4_violations": check_result["l4_violations"],
            "l3_violations": check_result["l3_violations"],
            "l2_violations": check_result["l2_violations"],
            "timestamp": check_result["timestamp"],
        });
        let _ = engine::engine_record_timeline_with_props(event_type, None::<&str>, &summary, &props);
    }
    ToolResponse::Success(json!(check_result))
}

pub(crate) fn handler_run_health(args: &Value) -> ToolResponse {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let days = get_usize(args, "days", 30);
    if path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "path is required".into(),
            fallback: "Provide the project root directory path".into(),
            details: json!({}),
        };
    }
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

// ═══════════════════════════════════════════════════════════════
// 重命名 —— 两阶段预览/应用，带过期 + 统一 diff
// ═══════════════════════════════════════════════════════════════

const RENAME_EXPIRY_SECS: u64 = 600; // 10 minutes

static REFACTOR_COUNTER: AtomicU64 = AtomicU64::new(0);

struct RenamePlan {
    old_name: String,
    new_name: String,
    matched_ids: Vec<String>,
    affected_files: Vec<String>,
    file_snapshots: HashMap<String, String>, // file_path → original content
}

static PENDING_RENAMES: std::sync::LazyLock<Mutex<HashMap<String, (Instant, RenamePlan)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn refactor_id() -> String {
    let seq = REFACTOR_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 原子计数器 + 时间戳：并发调用下无冲突。
    format!("ref_{:012x}_{:04x}", nanos, seq & 0xFFFF)
}

fn cleanup_expired_renames(lock: &mut HashMap<String, (Instant, RenamePlan)>) {
    let now = Instant::now();
    let expired: Vec<String> = lock
        .iter()
        .filter(|(_, (ts, _))| now.duration_since(*ts) >= Duration::from_secs(RENAME_EXPIRY_SECS))
        .map(|(k, _)| k.clone())
        .collect();
    for k in expired {
        lock.remove(&k);
    }
}

/// 生成跨受影响文件的重命名 unified-diff 预览。
fn generate_rename_diff(plan: &RenamePlan) -> String {
    let mut output = String::new();
    let old = &plan.old_name;
    let new = &plan.new_name;

    for file_path in &plan.affected_files {
        let original = match plan.file_snapshots.get(file_path) {
            Some(s) => s,
            None => continue,
        };
        let renamed = original.replace(old, new);
        if *original == renamed {
            continue;
        }

        let orig_lines: Vec<&str> = original.lines().collect();
        let new_lines: Vec<&str> = renamed.lines().collect();

        output.push_str(&format!("--- a/{}\n", file_path));
        output.push_str(&format!("+++ b/{}\n", file_path));

        // 收集 hunk —— 简单扫描变更行，带 3 行上下文
        let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new(); // (old_start, old_len, new_start, new_len)
        let max_len = orig_lines.len().max(new_lines.len());
        let mut i = 0usize;
        while i < max_len {
            let old_line = orig_lines.get(i).copied().unwrap_or("");
            let new_line = new_lines.get(i).copied().unwrap_or("");
            if old_line != new_line {
                let hunk_start = i.saturating_sub(3);
                let mut hunk_end = i + 1;
                // 向前扩展以捕获 3 行上下文内的相邻变更
                let mut j = i + 1;
                while j < max_len && j <= i + 6 {
                    let ol = orig_lines.get(j).copied().unwrap_or("");
                    let nl = new_lines.get(j).copied().unwrap_or("");
                    if ol != nl {
                        hunk_end = j + 1;
                    }
                    j += 1;
                }
                hunk_end = (hunk_end + 3).min(max_len);
                // Ponytail：与前一个 hunk 合并（如果重叠）
                if let Some(last) = hunks.last_mut() {
                    if hunk_start <= last.3 + 3 {
                        last.3 = hunk_end;
                        i = hunk_end;
                        continue;
                    }
                }
                let old_len = (hunk_end - hunk_start).min(orig_lines.len() - hunk_start);
                let new_len = (hunk_end - hunk_start).min(new_lines.len() - hunk_start);
                hunks.push((hunk_start + 1, old_len, hunk_start + 1, new_len));
                i = hunk_end;
            } else {
                i += 1;
            }
        }

        for (old_start, old_len, new_start, new_len) in &hunks {
            output.push_str(&format!(
                "@@ -{},{} +{},{} @@\n",
                old_start, old_len, new_start, new_len
            ));
            let ctx_start = old_start.saturating_sub(1);
            let ctx_end = (old_start + old_len - 1).min(orig_lines.len());
            // 显示前导上下文
            for li in ctx_start..(*old_start - 1) {
                if let Some(l) = orig_lines.get(li) {
                    output.push_str(&format!(" {}\n", l));
                }
            }
            // 显示变更行
            for li in (*old_start - 1)..ctx_end {
                let orig = orig_lines.get(li).copied().unwrap_or("");
                let renamed_line = new_lines.get(li).copied().unwrap_or("");
                if orig != renamed_line {
                    if !orig.is_empty() || !renamed_line.is_empty() {
                        output.push_str(&format!("-{}\n", orig));
                    }
                    if !renamed_line.is_empty() || !orig.is_empty() {
                        output.push_str(&format!("+{}\n", renamed_line));
                    }
                } else {
                    output.push_str(&format!(" {}\n", orig));
                }
            }
            // 显示后续上下文
            for li in ctx_end..(ctx_end + 3).min(orig_lines.len()) {
                if let Some(l) = orig_lines.get(li) {
                    output.push_str(&format!(" {}\n", l));
                }
            }
        }
    }
    output
}

pub(crate) fn handler_rename(args: &Value) -> ToolResponse {
    let old_name = args.get("old_name").or_else(|| args.get("oldName")).and_then(|v| v.as_str()).unwrap_or("");
    let new_name = args.get("new_name").or_else(|| args.get("newName")).and_then(|v| v.as_str()).unwrap_or("");
    let dry_run = args.get("dry_run").or_else(|| args.get("dryRun")).and_then(|v| v.as_bool()).unwrap_or(true);
    let ref_id = args.get("refactor_id").or_else(|| args.get("refactorId")).and_then(|v| v.as_str());

    // ── 阶段 2：通过 refactor_id 应用 ──
    if let Some(rid) = ref_id {
        let mut lock = PENDING_RENAMES.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_expired_renames(&mut lock);
        let plan = match lock.remove(rid) {
            Some((_, plan)) => plan,
            None => {
                return ToolResponse::Degraded {
                    guidance: format!("Refactor ID '{}' not found or expired ({}s TTL)", rid, RENAME_EXPIRY_SECS),
                    fallback: "Run rename with dry_run=true to create a new preview".into(),
                    details: json!({}),
                };
            }
        };
        // 执行实际重命名
        let count = plan.matched_ids.len();
        let matched_ids = plan.matched_ids;
        if let Err(e) = engine::engine_write(|idx| {
            for nid in &matched_ids {
                idx.rename_node_name(nid, &plan.new_name);
            }
        }) {
            return ToolResponse::Degraded {
                guidance: e,
                fallback: "Engine write failed, retry once".into(),
                details: json!({}),
            };
        }
        if let Err(e) = engine::engine_save() {
            tracing::warn!("engine_save failed after rename: {e}");
            return ToolResponse::Degraded {
                guidance: format!("Rename succeeded in memory but failed to persist: {e}"),
                fallback: "Retry the operation or save manually".into(),
                details: json!({"renamed_count": count, "renamed_ids": matched_ids}),
            };
        }
        return ToolResponse::Success(json!({
            "phase": "applied",
            "old_name": plan.old_name,
            "new_name": plan.new_name,
            "renamed_count": count,
            "renamed_ids": matched_ids,
            "note": "Rename applied to graph and persisted to storage.",
        }));
    }

    // ── 阶段 1：dry_run 预览（默认）──
    if old_name.is_empty() || new_name.is_empty() {
        return ToolResponse::Degraded {
            guidance: "old_name and new_name are required for preview".into(),
            fallback: "Provide both the old and new symbol names".into(),
            details: json!({}),
        };
    }

    if !dry_run && ref_id.is_none() {
        return ToolResponse::Degraded {
            guidance: "To apply a rename, first run with dry_run=true (or omit dry_run) to preview, then pass the returned refactor_id with dry_run=false.".into(),
            fallback: "Run rename_symbol(old_name, new_name, dry_run=true) first".into(),
            details: json!({}),
        };
    }

    // dry_run：使用统一 diff 预览
    let (matched_ids, matched_locations): (Vec<String>, Vec<String>) = {
        match engine::engine_read(|idx| {
            let ids: Vec<String> = idx.nodes_iter().filter(|n| n.name == old_name).map(|n| n.id.clone()).collect();
            let locs: Vec<String> = idx.nodes_iter()
                .filter(|n| n.name == old_name)
                .filter_map(|n| n.location.clone())
                .collect();
            (ids, locs)
        }) {
            Ok((ids, locs)) => (ids, locs),
            Err(e) => return ToolResponse::Degraded {
                guidance: e,
                fallback: "Engine read failed, retry once".into(),
                details: json!({}),
            },
        }
    };

    if matched_ids.is_empty() {
        return ToolResponse::Degraded {
            guidance: format!("No nodes match '{}'", old_name),
            fallback: "Use search_symbols to find the correct symbol name".into(),
            details: json!({}),
        };
    }

    // 为 diff 生成快照受影响文件
    let mut file_snapshots: HashMap<String, String> = HashMap::new();
    let mut seen_files: Vec<String> = Vec::new();
    for loc in &matched_locations {
        let file_path = if let Some(pos) = loc.rfind(':') {
            let maybe_line = &loc[pos + 1..];
            if maybe_line.chars().all(|c| c.is_ascii_digit()) {
                &loc[..pos]
            } else {
                loc.as_str()
            }
        } else {
            loc.as_str()
        };
        if !seen_files.iter().any(|f| f == file_path) {
            seen_files.push(file_path.to_string());
            // 从磁盘读取文件内容
            let full_path = project_root().join(file_path);
            if let Ok(content) = std::fs::read_to_string(&full_path) {
                file_snapshots.insert(file_path.to_string(), content);
            }
        }
    }

    let rid = refactor_id();
    let plan = RenamePlan {
        old_name: old_name.to_string(),
        new_name: new_name.to_string(),
        matched_ids: matched_ids.clone(),
        affected_files: seen_files.clone(),
        file_snapshots,
    };
    let diff = generate_rename_diff(&plan);

    // 存储计划供后续应用
    {
        let mut lock = PENDING_RENAMES.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_expired_renames(&mut lock);
        lock.insert(rid.clone(), (Instant::now(), plan));
    }

    ToolResponse::Success(json!({
        "phase": "preview",
        "refactor_id": rid,
        "old_name": old_name,
        "new_name": new_name,
        "matched_count": matched_ids.len(),
        "matched_ids": matched_ids,
        "affected_files": seen_files,
        "diff": diff,
        "expires_in_secs": RENAME_EXPIRY_SECS,
        "message": format!(
            "Preview: {} nodes in {} files would be renamed. Apply with rename_symbol(refactor_id=\"{}\", dry_run=false). Preview expires in {}s.",
            matched_ids.len(), seen_files.len(), rid, RENAME_EXPIRY_SECS,
        ),
    }))
}

pub(crate) fn handler_status(_args: &Value) -> ToolResponse {
    // 仅在未初始化或项目根目录变更时预热 LSP 池。
    //（不在每次 engine_status 轮询时重启健康的服务器。）
    {
        let proj = project_root();
        let root = if proj.as_os_str().is_empty() {
            std::env::current_dir().unwrap_or_default()
        } else {
            proj
        };
        let root_str = root.to_string_lossy().to_string();
        if !crate::lsp_manager::LspManager::is_initialized()
            || crate::lsp_manager::LspManager::root_changed(&root_str)
        {
            std::thread::spawn(move || {
                crate::lsp_manager::LspManager::warm(&root_str);
            });
        }
    }
    // LSP 状态独立于引擎状态 —— 始终收集
    let lsp = crate::lsp_manager::LspManager::lsp_status();
    let lsp_available: Vec<&str> = lsp.iter()
        .filter(|s| s["available"].as_bool().unwrap_or(false))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_missing: Vec<&str> = lsp.iter()
        .filter(|s| !s["available"].as_bool().unwrap_or(false))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_data = json!({
        "available": lsp_available,
        "missing": lsp_missing,
        "servers": lsp,
    });

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
            let vi_path = project_root().join(".hologram").join("vectors.usearch");
            let vi_exists = vi_path.exists();
            // 走进程级缓存（mtime 失效）——不再每次 status 调用都从磁盘全量加载索引
            let vi_count = if vi_exists {
                crate::vector::get_or_load_index(&project_root())
                    .map(|(_, slots)| slots.read().unwrap().len())
                    .unwrap_or(0)
            } else { 0 };
            ToolResponse::Success(json!({
                "phase": phase,
                "store": "MemoryIndex",
                "nodes": nodes,
                "edges": edges,
                "has_aux_indexes": has_aux,
                "is_watching": is_watching,
                "vector_index": { "exists": vi_exists, "vectors": vi_count, "backend": crate::vector::backend_id() },
                "lsp": lsp_data,
            }))
        }
        Err(_) => ToolResponse::Success(json!({
            "phase": "empty",
            "store": "none",
            "nodes": 0,
            "edges": 0,
            "lsp": lsp_data,
        })),
    }
}

pub(crate) fn handler_policy_check(args: &Value) -> ToolResponse {
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
        return ToolResponse::Degraded {
            guidance: "Provide either 'rules' (array of rule objects) or both 'source' and 'target' (string patterns).".into(),
            fallback: "Define boundary rules with source/target file patterns".into(),
            details: json!({}),
        };
    };
    ToolResponse::Success(with_store(|idx| policy_check_from_index(idx, &rules)))
}

pub(crate) fn handler_node(args: &Value) -> ToolResponse {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return ToolResponse::Degraded {
            guidance: "node_id is required".into(),
            fallback: "Use search_symbols to find the node first".into(),
            details: json!({}),
        };
    }
    ToolResponse::Success(with_store(|idx| {
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
    }))
}

/// 检查节点是否为静态分析无法识别的已知入口点
///（框架注册的命令、构造函数、测试函数等）。

/// 从位置字符串中去除末尾的 `:line_number` 后缀。
/// 处理 Windows 驱动器号路径（如 `C:\foo\bar.rs:42` → `C:\foo\bar.rs`）。
fn strip_loc_suffix(loc: &str) -> &str {
    if let Some(pos) = loc.rfind(':') {
        let maybe_line = &loc[pos + 1..];
        if maybe_line.chars().all(|c| c.is_ascii_digit()) {
            return &loc[..pos];
        }
    }
    loc
}

fn is_entry_point(node: &Node) -> bool {
    let name = &node.name;
    let raw_loc = node.location.as_deref().unwrap_or("");
    let loc = strip_loc_suffix(raw_loc);

    // 二进制入口点（任何语言的 main）
    if name == "main" {
        return true;
    }
    // 类构造函数（在 JS/TS 中通过 `new` 关键字调用）
    if name == "constructor" || name.ends_with(".constructor") {
        return true;
    }
    // 测试函数（由测试框架动态发现）
    if name.starts_with("test_") || name.ends_with("_test") || name.ends_with("Test") {
        return true;
    }
    // Tauri 命令分发器（通过 #[command] 宏注册）
    if name == "rpc" && loc.contains("rpc.rs") {
        return true;
    }
    // 引擎流水线入口
    if name == "run_pipeline" {
        return true;
    }
    // Tauri 命令处理器模块（在 commands/ 目录中，由宏注册）
    if loc.contains("/commands/") || loc.contains("\\commands\\") {
        return true;
    }
    // React/Vue 组件入口点
    if name == "App" && (loc.ends_with("App.tsx") || loc.ends_with("App.ts")) {
        return true;
    }
    // 框架初始化/引导函数
    if name == "init" && node.out_degree > 3 {
        return true;
    }
    // ponytail：跨语言的常见入口点名称模式。
    // 这些函数由框架/CLI/测试运行器调用，
    // 而非通过直接的 CALLS 边 —— 静态分析无法看到它们。
    const ENTRY_PATTERNS: &[&str] = &[
        "handle", "process", "run", "start", "stop", "serve",
        "migrate", "setup", "teardown", "bootstrap", "execute",
        "configure", "initialize", "load",
    ];
    let name_lower = name.to_lowercase();
    for pat in ENTRY_PATTERNS {
        if name_lower.starts_with(pat) || name_lower.ends_with(pat) {
            return true;
        }
    }
    false
}

/// 检查节点名称是否为 mock/stub 测试夹具。
/// 这些由测试框架连接引用，而非直接的 CALLS 边。
fn is_mock_or_stub(name: &str) -> bool {
    // mockSomething, MockXxx, createMockXxx
    if name.starts_with("mock") || name.starts_with("Mock") || name.starts_with("createMock") {
        return true;
    }
    // somethingMock, dbStub, s3Fake, userSpy（这些是代码标识符，保留英文）
    for suffix in &["Mock", "Stub", "Fake", "Spy"] {
        if name.ends_with(suffix) {
            return true;
        }
    }
    false
}

/// 通过元类/DI/框架魔法实例化的框架基类，
/// 而非通过直接的 CALLS 边。继承自其中之一意味着该类是
/// 框架管理的 —— 不是死代码。
fn is_framework_base(name: &str) -> bool {
    matches!(
        name,
        // Python ORM / Pydantic
        "Base" | "DeclarativeBase" | "Model" | "BaseModel" | "BaseSettings"
        | "db.Model" | "TableBase"
        // AWS CDK / IaC 构造
        | "Stack" | "NestedStack" | "Construct" | "Resource"
        // Django REST / DRF
        | "Serializer" | "ViewSet" | "ModelViewSet"
        // Android / 移动端
        | "Activity" | "Fragment" | "ViewModel" | "Service"
        // Spring / Java EE
        | "Application" | "Configuration"
    )
}

/// React/Vue/Android 生命周期方法 —— 由框架调用，
/// 从不通过直接的 CALLS 边。
fn is_lifecycle_method(name: &str) -> bool {
    matches!(
        name,
        "render" | "componentDidMount" | "componentWillUnmount" | "componentDidUpdate"
        | "shouldComponentUpdate" | "getDerivedStateFromProps" | "getSnapshotBeforeUpdate"
        | "mounted" | "created" | "destroyed" | "beforeMount" | "beforeDestroy"
        | "updated" | "activated" | "deactivated"
        | "onCreate" | "onDestroy" | "onStart" | "onStop" | "onResume" | "onPause"
        | "ngOnInit" | "ngOnDestroy" | "ngOnChanges" | "ngAfterViewInit"
    )
}

pub(crate) fn handler_unused(args: &Value) -> ToolResponse {
    let limit = get_usize(args, "limit", 20).min(200);
    let kind_str = args
        .get("kind_filter")
        .and_then(|v| v.as_str())
        .unwrap_or("function,class");
    let kind_label = kind_str.to_string();
    let kinds: Vec<&str> = kind_str.split(',').map(|s| s.trim()).collect();

    // ponytail：先在读锁内收集候选（轻量快照），锁外做 LSP 验证。
    // LSP references 可能触发 server warm（耗时数百 ms），不能持图锁。
    let mut candidates: Vec<Value> = match engine::engine_read(|idx| {
        idx.nodes_iter()
            .filter(|n| {
                n.non_defines_in_degree == 0
                    && kinds.iter().any(|k| n.kind.as_str() == *k)
                    && !is_entry_point(n)
                    && !is_mock_or_stub(&n.name)
                    && !is_framework_base(&n.name)
                    && !is_lifecycle_method(&n.name)
            })
            .map(|n| json!({
                "id": n.id,
                "name": n.name,
                "kind": n.kind.as_str(),
                "location": n.location,
                "out_degree": n.out_degree,
                "in_degree": n.in_degree,
                "non_defines_in_degree": n.non_defines_in_degree,
                "community_id": n.community_id,
            }))
            .collect()
    }) {
        Ok(v) => v,
        Err(e) => return ToolResponse::Degraded {
            guidance: format!("cannot access graph: {}", e),
            fallback: "Ensure the project has been analyzed first".into(),
            details: json!({}),
        },
    };

    // LSP 验证：对能定位到源码位置的候选查 references，
    // 有非定义引用（如 React JSX/对象属性使用）则不是死代码。
    // 这修复名字匹配失败导致的误报 —— 图上看不到引用，但
    // 类型系统（LSP）能确认它被使用。
    //
    // 防护：只验证 out_degree 最高的前 LSP_VERIFY_LIMIT 个候选
    // （最可疑的优先），避免批量 open_file+references 把 LSP server
    // 打崩；且任一次查询失败即停止（server 不可用时反复重试只会
    // 浪费时间），失败的候选按原判断保留。
    const LSP_VERIFY_LIMIT: usize = 50;
    candidates.sort_by_key(|n| std::cmp::Reverse(n["out_degree"].as_u64().unwrap_or(0)));
    let verify_count = candidates.len().min(LSP_VERIFY_LIMIT);
    let mut lsp_verified_removed = 0usize;
    let mut verified: Vec<Value> = Vec::with_capacity(candidates.len());
    for (i, cand) in candidates.iter().enumerate() {
        if i < verify_count {
            let loc = cand["location"].as_str().unwrap_or("");
            let name = cand["name"].as_str().unwrap_or("");
            match lsp_has_real_reference(loc, name) {
                LspCheck::HasReference => {
                    lsp_verified_removed += 1;
                    continue;
                }
                LspCheck::NoReference => {}
                LspCheck::Unavailable => {
                    // LSP 挂了——停止验证，剩余候选全部保留
                    verified.push(cand.clone());
                    verified.extend(candidates[i + 1..].iter().cloned());
                    break;
                }
            }
        }
        verified.push(cand.clone());
    }

    verified.sort_by_key(|n| std::cmp::Reverse(n["out_degree"].as_u64().unwrap_or(0)));
    let total = verified.len();
    verified.truncate(limit);
    ToolResponse::Success(json!({
        "total_unused": total,
        "limit": limit,
        "kind_filter": kind_label,
        "lsp_verified_removed": lsp_verified_removed,
        "unused": verified,
    }))
}

/// LSP 引用检查结果。
enum LspCheck {
    /// 有真实引用（应移出死代码列表）
    HasReference,
    /// 无引用（确认死代码）
    NoReference,
    /// LSP 不可用 / 无法定位（保持原判断）
    Unavailable,
}

/// 用 LSP references 验证符号是否有真实引用（非定义点）。
/// 无法定位位置 / 无 LSP 可用 / LSP 查询失败时返回 Unavailable。
fn lsp_has_real_reference(location: &str, name: &str) -> LspCheck {
    if location.is_empty() || name.is_empty() {
        return LspCheck::Unavailable;
    }
    // location 格式: "D:/path/to/file.ts:153"（路径 + :行号）。
    // rsplit_once(':') 只拆最后一个冒号，drive letter（D:）不受影响。
    let (path, line_str) = match location.rsplit_once(':') {
        Some(pair) => pair,
        None => return LspCheck::Unavailable,
    };
    // Node.location 行号是 1-based；LSP 需要 0-based。
    let line: u32 = match line_str.parse::<u32>() {
        Ok(l) if l > 0 => l - 1,
        _ => return LspCheck::Unavailable,
    };
    let ext = path.rsplit('.').next().unwrap_or("");
    if ext.is_empty() {
        return LspCheck::Unavailable;
    }
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return LspCheck::Unavailable,
    };
    // 定位符号名在该行的列（LSP 需要精确位置）。
    // 用行内首次出现；若该行无符号名则无法定位，跳过验证。
    let line_text = match source.lines().nth(line as usize) {
        Some(l) => l,
        None => return LspCheck::Unavailable,
    };
    let column = match line_text.find(name) {
        Some(c) => c as u32,
        None => return LspCheck::Unavailable,
    };
    // find_references 内部 includeDeclaration=false（不含定义本身），
    // 非空结果 = 有真实使用点。
    match crate::lsp_manager::LspManager::find_references(path, &source, line, column, ext) {
        Ok(locs) if !locs.is_empty() => LspCheck::HasReference,
        Ok(_) => LspCheck::NoReference,
        Err(_) => LspCheck::Unavailable,
    }
}

/// 通过原生 LSP 按需进行类型感知的调用解析。
/// LSP 服务器未安装时优雅降级。
pub(crate) fn handler_resolve_call(args: &Value) -> ToolResponse {
    let file_path = args.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let func_name = args.get("function").and_then(|v| v.as_str()).unwrap_or("");
    let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let column = args.get("column").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if file_path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "file is required".into(),
            fallback: "Provide the file path to resolve calls in".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    let abs_path = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        root.join(file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();

    // 读取源码
    let source = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) => return ToolResponse::Degraded {
            guidance: format!("cannot read file: {}", e),
            fallback: "Check the file path and permissions".into(),
            details: json!({}),
        },
    };

    // 尝试原生 LSP（如果池已预热）──
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
            return ToolResponse::Success(json!({
                "file": path_str,
                "function": func_name,
                "backend": "native_lsp",
                "definitions": locs,
                "note": "resolved via real LSP server",
            }));
        }
    }

    // ── 路径 2：无原生 LSP 可用 → 降级 ──
    ToolResponse::Degraded {
        guidance: format!("Native LSP unavailable for .{} — call resolution skipped.", ext),
        fallback: format!("Install an LSP server for .{} to enable precise call resolution. Check engine_status for details.", ext),
        details: json!({
            "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
            "note": "Handwritten adapters removed in v8. Use real LSP servers (pyright, gopls, rust-analyzer, etc.)"
        }),
    }
}

/// 解析指定位置符号的类型。
pub(crate) fn handler_resolve_type(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // 尝试原生 LSP
    match crate::lsp_manager::LspManager::resolve_type(&path_str, &source, line, column, &ext) {
        Ok(hover) if !hover.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "type_info": hover,
            }));
        }
        _ => {}
    }

    // ── 路径 2：无原生 LSP 可用 → 降级 ──
    ToolResponse::Degraded {
        guidance: format!("Native LSP unavailable for .{} — type resolution skipped.", ext),
        fallback: format!("Install an LSP server for .{} to enable precise type resolution. Check engine_status for details.", ext),
        details: json!({
            "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
            "note": "Handwritten adapters removed in v8. Use real LSP servers."
        }),
    }
}

/// 查找指定位置接口/trait/抽象类的所有实现。
pub(crate) fn handler_find_implementations(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // 尝试原生 LSP
    match crate::lsp_manager::LspManager::find_implementations(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "implementations": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            }));
        }
        _ => {}
    }

    // 回退：无原生 LSP → 降级
    ToolResponse::Degraded {
        guidance: format!("Native LSP unavailable for .{} — implementation search skipped.", ext),
        fallback: format!("Install an LSP server for .{} to enable interface implementation search.", ext),
        details: json!({
            "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
            "note": "Handwritten adapters removed in v8. Use real LSP servers."
        }),
    }
}

/// 查找指定位置符号的所有引用。
pub(crate) fn handler_find_references(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;
    let _include_decl = args.get("includeDeclaration").and_then(|v| v.as_bool()).unwrap_or(false);

    // 尝试原生 LSP
    let lsp_err: Option<String> = match crate::lsp_manager::LspManager::find_references(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "references": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            }));
        }
        Ok(_) => None, // 无引用 — 正常
        Err(e) => Some(e), // 记录错误供诊断
    };

    // 回退：使用图查找入边引用
    match engine::engine_read_graph(|g| {
        let _node_ids: Vec<String> = g.node_ids().map(|s| s.to_string()).collect();
        let refs: Vec<Value> = g.edges_iter()
            .take(100)
            .map(|(_, e)| json!({
                "source": e.source,
                "target": e.target,
                "kind": format!("{:?}", e.kind),
            }))
            .collect();
        let mut out = json!({
            "file": path_str, "line": line, "column": column,
            "backend": "graph",
            "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
            "note": "Graph-based fallback — use native LSP for precise symbol references. Provide line+column for precise resolution.",
            "references": refs,
            "count": refs.len(),
        });
        if let Some(e) = &lsp_err {
            out["lsp_error"] = json!(e);
        }
        out
    }) {
        Ok(v) => ToolResponse::Success(v),
        Err(e) => ToolResponse::Degraded {
            guidance: format!("cannot access graph: {}", e),
            fallback: "Ensure the project has been analyzed first".into(),
            details: json!({}),
        },
    }
}

/// resolve_* 工具的共享准备：读取文件、获取扩展名，返回 (path, source, ext)。
pub(crate) fn resolve_tool_prepare(args: &Value) -> Result<(String, String, String), Value> {
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

pub(crate) fn handler_dataflow(args: &Value) -> ToolResponse {
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return ToolResponse::Degraded {
            guidance: "files is required and must be a non-empty array".into(),
            fallback: "Provide an array of file paths to trace dataflow".into(),
            details: json!({}),
        };
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
    ToolResponse::Success(json!({"results": json_results}))
}

// ═══════════════════════════════════════════════════════════════
// 流程工具: list_flows, get_flow, get_affected_flows
// ═══════════════════════════════════════════════════════════════

pub(crate) fn handler_list_flows(args: &Value) -> ToolResponse {
    let limit = get_usize(args, "limit", 50).min(200);
    let sort_by = args
        .get("sort_by")
        .and_then(|v| v.as_str())
        .unwrap_or("criticality");
    let kind_filter = args.get("kind_filter").and_then(|v| v.as_str());
    let detail_level = args
        .get("detail_level")
        .and_then(|v| v.as_str())
        .unwrap_or("standard");

    ToolResponse::Success(with_store(|idx| {
        let mut flows: Vec<serde_json::Value> = idx
            .nodes_iter()
            .filter_map(|n| {
                let flow = n.properties.get("flow")?;
                let id = flow.get("id")?.as_u64()?;
                let entry_kind = flow.get("entry_kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let framework = flow.get("framework").and_then(|v| v.as_str());

                // 应用类型过滤
                if let Some(kf) = kind_filter {
                    if entry_kind != kf {
                        return None;
                    }
                }

                let name = if let Some(fw) = framework {
                    if entry_kind == "framework_route" {
                        format!("[{}] {}", fw, n.name)
                    } else {
                        n.name.clone()
                    }
                } else {
                    n.name.clone()
                };

                let criticality = flow.get("criticality").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let depth = flow.get("depth").and_then(|v| v.as_u64()).unwrap_or(0);
                let node_count = flow.get("node_count").and_then(|v| v.as_u64()).unwrap_or(0);

                Some(json!({
                    "id": id,
                    "name": name,
                    "entry_point_id": n.id,
                    "entry_kind": entry_kind,
                    "criticality": criticality,
                    "depth": depth,
                    "node_count": node_count,
                    "file_count": flow.get("file_count").and_then(|v| v.as_u64()).unwrap_or(0),
                    "l4_count": flow.get("l4_count").and_then(|v| v.as_u64()).unwrap_or(0),
                }))
            })
            .collect();

        // 排序
        flows.sort_by(|a, b| {
            match sort_by {
                "depth" => b["depth"].as_u64().cmp(&a["depth"].as_u64()),
                "node_count" => b["node_count"].as_u64().cmp(&a["node_count"].as_u64()),
                "file_count" => b["file_count"].as_u64().cmp(&a["file_count"].as_u64()),
                "name" => a["name"].as_str().cmp(&b["name"].as_str()),
                _ => b["criticality"].as_f64().unwrap_or(0.0)
                    .partial_cmp(&a["criticality"].as_f64().unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            }
        });

        let total = flows.len();
        flows.truncate(limit);

        let items: Vec<serde_json::Value> = if detail_level == "minimal" {
            flows.iter().map(|f| json!({
                "id": f["id"],
                "name": f["name"],
                "criticality": f["criticality"],
                "node_count": f["node_count"],
            })).collect()
        } else {
            flows
        };

        json!({
            "flows": items,
            "total": total,
            "limit": limit,
            "sort_by": sort_by,
        })
    }))
}

pub(crate) fn handler_get_flow(args: &Value) -> ToolResponse {
    let flow_id = args.get("flow_id").and_then(|v| v.as_u64()).map(|v| v as u32);
    let flow_name = args.get("flow_name").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
    let include_source = args.get("include_source").and_then(|v| v.as_bool()).unwrap_or(false);

    ToolResponse::Success(with_store(|idx| {
        // 查找匹配流程的入口点节点
        let entry: Option<(&crate::graph::Node, &serde_json::Value)> = idx
            .nodes_iter()
            .find_map(|n| {
                let flow = n.properties.get("flow")?;
                if let Some(fid) = flow_id {
                    if flow.get("id")?.as_u64()? == fid as u64 {
                        return Some((n, flow));
                    }
                } else if let Some(ref name) = flow_name {
                    if n.name.to_lowercase().contains(name) {
                        return Some((n, flow));
                    }
                }
                None
            });

        let (node, flow) = match entry {
            Some(e) => e,
            None => {
                let msg = if let Some(fid) = flow_id {
                    format!("Flow #{} not found", fid)
                } else if let Some(ref name) = flow_name {
                    format!("No flow matching '{}' found", name)
                } else {
                    "Provide flow_id or flow_name".into()
                };
                return json!({"error": msg});
            }
        };

        let node_ids: Vec<String> = flow
            .get("node_ids")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        // 构建包含节点详情的流程路径
        let path: Vec<serde_json::Value> = node_ids
            .iter()
            .filter_map(|nid| {
                let n = idx.get_node(nid)?;
                let mut step = json!({
                    "node_id": n.id,
                    "name": n.name,
                    "kind": n.kind.as_str(),
                    "location": n.location,
                });
                if include_source {
                    if let Some(loc) = &n.location {
                        // 正确去除行号后缀（处理 Windows 驱动器号）
                        let (file, line_num) = if let Some(pos) = loc.rfind(':') {
                            let maybe_line = &loc[pos + 1..];
                            if maybe_line.chars().all(|c| c.is_ascii_digit()) {
                                (&loc[..pos], maybe_line.parse::<usize>().ok())
                            } else {
                                (loc.as_str(), None)
                            }
                        } else {
                            (loc.as_str(), None)
                        };
                        let full = project_root().join(file);
                        if let Ok(content) = std::fs::read_to_string(&full) {
                            let lines: Vec<&str> = content.lines().collect();
                            let start = line_num
                                .map(|l| l.saturating_sub(10))
                                .unwrap_or(0);
                            let end = line_num
                                .map(|l| (l + 10).min(lines.len()))
                                .unwrap_or(lines.len().min(50));
                            let snippet = lines[start.min(lines.len())..end.min(lines.len())]
                                .join("\n");
                            step["source_snippet"] = json!(snippet);
                        }
                    }
                }
                Some(step)
            })
            .collect();

        json!({
            "flow": {
                "id": flow.get("id"),
                "name": node.name,
                "entry_point_id": node.id,
                "criticality": flow.get("criticality"),
                "depth": flow.get("depth"),
                "node_count": flow.get("node_count"),
                "file_count": flow.get("file_count"),
                "l4_count": flow.get("l4_count"),
                "cross_community": flow.get("cross_community"),
                "path": path,
            }
        })
    }))
}

pub(crate) fn handler_affected_flows(args: &Value) -> ToolResponse {
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let changed_node_ids: Vec<String> = args
        .get("changed_nodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    if files.is_empty() && changed_node_ids.is_empty() {
        return ToolResponse::Degraded {
            guidance: "files or changed_nodes is required".into(),
            fallback: "Pass the list of changed file paths or node IDs".into(),
            details: json!({}),
        };
    }

    ToolResponse::Success(with_store(|idx| {
        // 构建属于变更文件的节点集合
        let mut changed_set: HashSet<String> = changed_node_ids.into_iter().collect();
        for file_path in &files {
            // 归一化查询路径以便比较
            let query_normalized = file_path.replace('\\', "/");
            for n in idx.nodes_iter() {
                if let Some(loc) = &n.location {
                    let node_file = strip_loc_suffix(loc);
                    let node_normalized = node_file.replace('\\', "/");
                    if node_normalized == query_normalized
                        || node_normalized.ends_with(&format!("/{}", query_normalized))
                        || node_normalized.ends_with(&format!("\\{}", file_path))
                    {
                        changed_set.insert(n.id.clone());
                    }
                }
            }
        }

        let mut affected: Vec<serde_json::Value> = idx
            .nodes_iter()
            .filter_map(|n| {
                let flow = n.properties.get("flow")?;
                let node_ids: Vec<&str> = flow
                    .get("node_ids")
                    .and_then(|v| v.as_array())?
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect();

                let affected_nodes: Vec<&str> = node_ids
                    .iter()
                    .filter(|nid| changed_set.contains(**nid))
                    .copied()
                    .collect();

                if affected_nodes.is_empty() {
                    return None;
                }

                let impact_ratio = affected_nodes.len() as f64 / node_ids.len().max(1) as f64;
                Some(json!({
                    "flow_id": flow.get("id"),
                    "flow_name": n.name,
                    "entry_point_id": n.id,
                    "criticality": flow.get("criticality"),
                    "affected_nodes": affected_nodes,
                    "total_nodes": node_ids.len(),
                    "impact_ratio": (impact_ratio * 100.0).round() / 100.0,
                }))
            })
            .collect();

        // 按关键度降序排序
        affected.sort_by(|a, b| {
            b["criticality"].as_f64().unwrap_or(0.0)
                .partial_cmp(&a["criticality"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        json!({
            "changed_files": files,
            "affected_flows": affected,
            "total": affected.len(),
        })
    }))
}