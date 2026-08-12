use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use crate::analysis::*;
use crate::engine;
use crate::tools::{get_str, get_usize, project_root, with_store};
use crate::tools::ToolResponse;

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

pub(crate) fn handler_grpc_services(_args: &Value) -> ToolResponse {
    ToolResponse::Success(with_store(|idx| {
        // 收集 grpc 节点（properties.kind == "grpc"，合成器产出的契约节点）
        let grpc_ids: std::collections::HashSet<String> = idx
            .nodes_iter()
            .filter(|n| n.properties.get("kind") == Some(&json!("grpc")))
            .map(|n| n.id.to_string())
            .collect();

        // 边统计：出边（proto→impl）为实现边；入边（caller→proto）为客户端调用点
        let mut impl_count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut client_count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (source, targets) in idx.edges_iter() {
            for (target, _, _, _) in targets {
                if grpc_ids.contains(&source) {
                    *impl_count.entry(source.clone()).or_insert(0) += 1;
                }
                if grpc_ids.contains(&target) {
                    *client_count.entry(target.clone()).or_insert(0) += 1;
                }
            }
        }

        // 按 service 分组，方法按名排序
        let mut services: std::collections::BTreeMap<String, serde_json::Value> = std::collections::BTreeMap::new();
        let mut total_methods = 0usize;
        let mut implemented = 0usize;
        let mut missing = 0usize;
        let mut nodes: Vec<&crate::graph::Node> = idx
            .nodes_iter()
            .filter(|n| n.properties.get("kind") == Some(&json!("grpc")))
            .collect();
        nodes.sort_by(|a, b| a.name.cmp(&b.name));
        for node in nodes {
            let svc = node.properties.get("service").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            let pkg = node.properties.get("package").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let method = node.properties.get("method").and_then(|v| v.as_str()).unwrap_or(&node.name).to_string();
            let is_impl = impl_count.get(&node.id.to_string()).copied().unwrap_or(0) > 0;
            total_methods += 1;
            if is_impl { implemented += 1; } else { missing += 1; }
            let entry = services.entry(svc.clone()).or_insert_with(|| json!({
                "service": svc,
                "package": pkg,
                "methods": Vec::<serde_json::Value>::new(),
            }));
            entry["methods"].as_array_mut().expect("methods 必须是数组").push(json!({
                "method": method,
                "node": node.id,
                "input": node.properties.get("inputType").cloned().unwrap_or(json!(null)),
                "output": node.properties.get("outputType").cloned().unwrap_or(json!(null)),
                "streaming": node.properties.get("isStreaming").cloned().unwrap_or(json!(false)),
                "implemented": is_impl,
                "client_call_sites": client_count.get(&node.id.to_string()).copied().unwrap_or(0),
            }));
        }

        json!({
            "total_services": services.len(),
            "total_methods": total_methods,
            "implemented": implemented,
            "missing": missing,
            "services": services.into_values().collect::<Vec<_>>(),
        })
    }))
}


