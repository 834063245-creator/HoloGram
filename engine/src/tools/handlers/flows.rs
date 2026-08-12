use std::collections::HashSet;

use serde_json::{json, Value};
use crate::tools::handlers::strip_loc_suffix;
use crate::tools::{get_usize, project_root, with_store};
use crate::tools::ToolResponse;

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
                        changed_set.insert(n.id.as_str().to_owned());
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::engine_init;
    use crate::tools::handlers::handler_explore;

    fn init_tmp_project(name: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        engine_init(&tmp).unwrap();
        tmp
    }

    #[test]
    fn explore_requires_symbols_or_query() {
        let _ = init_tmp_project("hologram_test_explore_degraded");
        match handler_explore(&json!({})) {
            ToolResponse::Degraded { guidance, .. } => {
                assert!(!guidance.is_empty());
            }
            other => panic!("expected Degraded, got {other:?}"),
        }
    }

    #[test]
    fn explore_nl_query_without_vector_index_skips_silently() {
        let _ = init_tmp_project("hologram_test_explore_noidx");
        // 空项目无向量索引 → merge_vector_hits 即发即忘：
        // 主结构完整、不注入 vector 字段、不报错。
        let resp = handler_explore(&json!({
            "query": "memory management",
            "includeSource": false,
        }));
        match resp {
            ToolResponse::Success(v) => {
                assert!(v.get("flow").is_some(), "explore 主结构应保留");
                assert!(v.get("meta").is_some(), "explore meta 应保留");
                let vh = v.get("vector_hits");
                assert!(
                    vh.is_none() || vh.and_then(|x| x.as_array()).map_or(true, |a| a.is_empty()),
                    "无索引时应无向量命中"
                );
            }
            other => panic!("expected Success, got {other:?}"),
        }
    }
}
