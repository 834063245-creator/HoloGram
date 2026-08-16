use std::path::PathBuf;

use serde_json::{json, Value};
use crate::analysis::*;
use crate::community::detect_communities_from_index;
use crate::engine;
use crate::graph::Graph;
use crate::routing::preflight::{load_baseline, run_full_check, save_baseline};
use crate::tools::{get_usize, with_store};
use crate::tools::with_graph;
use crate::tools::derive_comm_label;
use crate::tools::ToolResponse;

pub(crate) fn handler_graph_summary(_args: &Value) -> ToolResponse {
    let mut v = with_store(graph_summary_from_index);
    // SCIP 边过期状态注入 summary（结构化、机器可读；P1-1 新鲜度治理）
    if let Some((drift, base)) = engine::with_engine(|eng| eng.scip_staleness()).flatten() {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("scip_staleness".into(), json!({
                "scip_imported": true,
                "drift_since_import": drift.saturating_sub(base),
                "stale": drift > base,
                "_note": "SCIP 边来自静态索引，不随增量刷新；stale=true 时请重新生成 index.scip 并 import_scip"
            }));
        }
    }
    ToolResponse::Success(v)
}

pub(crate) fn handler_clusters(args: &Value) -> ToolResponse {
    let min_size = get_usize(args, "min_size", 3).max(1);
    let max_nodes = get_usize(args, "max_nodes", 20).max(1).min(200);
    // 增量漂移治理（P1-4）：图经增量维护后聚类结果是近似的，结果带标注。
    let drift = crate::tools::staleness::incremental_drift();
    ToolResponse::Success(with_store(|idx| {
        let mut comm_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
        let mut has_any = false;
        for node in idx.nodes_iter() {
            if let Some(cid) = node.community_id {
                comm_map.entry(cid).or_default().push(node.id.as_str().to_owned());
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
        let mut result = json!({
            "total_communities": filtered.len(),
            "min_size_filter": min_size,
            "max_nodes_per_community": max_nodes,
            "communities": filtered,
        });
        if drift > 0 {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("staleness".into(), json!({
                    "incremental_updates_since_full": drift,
                    "note": "社区结果可能近似：新增节点按邻居投票分配，全局聚类未重跑；如需精确结果请运行全量重分析"
                }));
            }
        }
        result
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


