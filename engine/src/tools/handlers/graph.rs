use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use crate::community::detect_communities_from_index;
use crate::engine;
use crate::graph::{query, Edge};
use crate::tools::{get_str, get_usize, project_root, with_store};
use crate::tools::{with_graph, resolve_in_index, resolve_in_graph};
use crate::tools::{node_to_value, edge_to_value, discover_source_files};
use crate::tools::ToolResponse;

pub(crate) fn handler_neighbors(args: &Value) -> ToolResponse {
    let node_id = get_str(args, &["node_id", "nodeId"]);
    if node_id.is_empty() {
        return ToolResponse::Degraded {
            guidance: "node_id is required".into(),
            fallback: "Provide a valid node_id to look up neighbors".into(),
            details: json!({}),
        };
    }
    let exclude_synth = args
        .get("exclude_synthesized")
        .or_else(|| args.get("excludeSynthesized"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    match engine::engine_read(|idx| {
        let resolved = match resolve_in_index(idx, &node_id) {
            Some(rid) => rid,
            None => return json!({"error": format!("Node {} not found", node_id)}),
        };
        let node = idx.get_node(&resolved).expect("节点已解析").clone();
        let nb = idx.neighbors(&resolved, 1, None);
        let mut incoming = idx.get_incoming_edges(&resolved);
        let mut outgoing = idx.get_outgoing_edges(&resolved);
        // P0-5：合成边（动态调度/框架路由/DI 启发式）诚实标记 + 可过滤
        if exclude_synth {
            incoming.retain(|e| !idx.is_edge_synthesized(&e.source, &e.target));
            outgoing.retain(|e| !idx.is_edge_synthesized(&e.source, &e.target));
        }
        let edge_with_flag = |e: &crate::graph::Edge| {
            let mut v = edge_to_value(e);
            let synthesized = idx.is_edge_synthesized(&e.source, &e.target);
            if synthesized {
                v["synthesized"] = json!(true);
            }
            v
        };
        // neighbors 附带 name/kind/file —— 只有裸 ID 时 LLM 不知道邻居是谁。
        let neighbors_value: Vec<Value> = nb.iter().map(|(_, t, d)| {
            match idx.get_node(t) {
                Some(n) => {
                    let raw_loc = n.location.as_deref().unwrap_or("");
                    let file = raw_loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(raw_loc).to_string();
                    json!({"id": t, "name": n.name, "kind": n.kind.as_str(), "file": file, "coupling_depth": d})
                }
                None => json!({"id": t, "coupling_depth": d}),
            }
        }).collect::<Vec<_>>();
        json!({
            "node": node_to_value(&node),
            "neighbor_count": nb.len(),
            "neighbors": neighbors_value,
            "incoming": incoming.iter().map(edge_with_flag).collect::<Vec<_>>(),
            "outgoing": outgoing.iter().map(edge_with_flag).collect::<Vec<_>>(),
            "exclude_synthesized": exclude_synth,
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
        let node = g.get_node(&resolved).expect("节点已解析");
        let nb = query::neighbors(g, &resolved, 1);
        let incoming: Vec<_> = g.incoming(&resolved).map(edge_to_value).collect();
        let outgoing: Vec<_> = g.outgoing(&resolved).map(edge_to_value).collect();
        let neighbors_value: Vec<Value> = nb.iter().map(|(_, t, d)| {
            match g.get_node(t) {
                Some(n) => {
                    let raw_loc = n.location.as_deref().unwrap_or("");
                    let file = raw_loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(raw_loc).to_string();
                    json!({"id": t, "name": n.name, "kind": n.kind.as_str(), "file": file, "coupling_depth": d})
                }
                None => json!({"id": t, "coupling_depth": d}),
            }
        }).collect::<Vec<_>>();
        json!({
            "node": node_to_value(node),
            "neighbor_count": nb.len(),
            "neighbors": neighbors_value,
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
        // 每层节点附带 name/kind/location —— 只有裸 ID 时 LLM 无法
        // 知道影响的是谁，必须逐个解码（多轮补看）。name+file 让
        // Agent 一轮就能判断影响面。
        let layers_value: Vec<Value> = layers.iter().map(|(d, nodes)| {
            let entries: Vec<Value> = nodes.iter().map(|nid| {
                match idx.get_node(nid) {
                    Some(n) => {
                        let raw_loc = n.location.as_deref().unwrap_or("");
                        let file = raw_loc.rsplit_once(':').map(|(f, _)| f).unwrap_or(raw_loc).to_string();
                        json!({
                            "id": nid,
                            "name": n.name,
                            "kind": n.kind.as_str(),
                            "file": file,
                        })
                    }
                    None => json!({"id": nid}),
                }
            }).collect();
            json!({"depth": d, "nodes": entries})
        }).collect();
        json!({
            "source_node_id": resolved,
            "max_depth": depth,
            "total_affected_nodes": total_affected.saturating_sub(1),
            "layers": layers_value,
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
    // 增量漂移治理（P1-4）：图经增量维护后聚类结果是近似的，结果带标注。
    let drift = crate::tools::staleness::incremental_drift();
    let decorate = |mut v: serde_json::Value| -> serde_json::Value {
        if drift > 0 {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("staleness".into(), json!({
                    "incremental_updates_since_full": drift,
                    "note": "社区结果可能近似：新增节点按邻居投票分配，全局聚类未重跑；如需精确结果请运行全量重分析"
                }));
            }
        }
        v
    };
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
                        return decorate(json!({
                            "node_id": resolved,
                            "community": {
                                "id": format!("comm_{}", i),
                                "level": 0,
                                "label": format!("Community {}", i + 1),
                                "node_count": comm.len(),
                                "node_ids": comm,
                            },
                            "sibling_nodes": siblings,
                        }));
                    }
                }
                return decorate(json!({"node_id": resolved, "community": null, "message": "Node not in any community"}));
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
        decorate(json!({
            "node_id": resolved,
            "community": {
                "id": format!("comm_{}", cid),
                "level": 0,
                "label": format!("Community {}", cid + 1),
                "node_count": comm_node_ids.len(),
                "node_ids": comm_node_ids,
            },
            "sibling_nodes": siblings,
        }))
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
        let node = idx.get_node(&resolved).expect("节点已解析").clone();
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
                    .expect("or_insert 后必为数组")
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
pub(crate) fn strip_loc_suffix(loc: &str) -> &str {
    if let Some(pos) = loc.rfind(':') {
        let maybe_line = &loc[pos + 1..];
        if maybe_line.chars().all(|c| c.is_ascii_digit()) {
            return &loc[..pos];
        }
    }
    loc
}


