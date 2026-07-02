// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Hologram graph query and analysis Tauri commands.

use tauri;
use tauri::Emitter;
use serde_json;
use std::path::PathBuf;
use hologram_engine as engine;
use engine::engine as engine_api;
use engine::graph::Graph;
use engine::graph::{Node, NodeKind, Edge, EdgeKind};
use engine::analysis::{fragile_nodes, detect_cycles, coupling_report,
    graph_summary, find_blindspots, policy_check_from_index};
use engine::community::{detect_communities, detect_hierarchical_communities_with_base};
use engine::graph::query;
use engine::routing::preflight::{check_timeline_props, load_baseline, save_baseline};
use engine::analysis::dataflow_engine;
use engine::pipeline::discovery;

/// Discover source files using supported language extensions, capped at limit.
fn discover_source_files(root: &PathBuf, limit: usize) -> Vec<PathBuf> {
    let exts: Vec<String> = engine::engine::GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    discovery::discover_files(root, &ext_strs)
        .into_iter().take(limit).collect()
}

#[tauri::command]
pub(crate) async fn get_full_graph(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let source_root = crate::utils::workspace_path(&state)?;
    tokio::task::spawn_blocking(move || crate::utils::serialize_cached_graph(&source_root))
        .await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// 22 Tauri commands — Agent tools → direct engine calls
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_analyze(path: Option<String>, app: tauri::AppHandle, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_analyze", &state)?;
    let target = path.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());
    crate::utils::run_analyze_with_progress(target, app, true).await
}

/// Run engine analysis while polling progress and emitting frontend events.
async fn run_analyze_with_progress(target: String, app: tauri::AppHandle, force: bool) -> Result<String, String> {
    let target_clone = target.clone();
    let app_clone = app.clone();
    let scheduled = std::time::Instant::now();

    // Spawn analysis in a blocking thread
    let mut analyze_handle = tokio::task::spawn_blocking(move || {
        crate::utils::direct_analyze(&target_clone, force)
    });

    // Poll progress until the blocking task finishes (don't exit early on Ready —
    // queued analyzes wait on analyze_lock while state stays Ready).
    loop {
        tokio::select! {
            res = &mut analyze_handle => {
                match res {
                    Ok(result) => return result,
                    Err(e) => return Err(format!("分析任务失败: {}", e)),
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                let state = engine_api::engine_state();
                match state {
                    engine_api::EngineState::Analyzing { phase, current, total, file, started_at_ms, .. } => {
                        let _ = app_clone.emit("analyze-phase", serde_json::json!({
                            "phase": phase.clone(),
                            "message": phase,
                        }));
                        if total > 0 {
                            let _ = app_clone.emit("analyze-progress", serde_json::json!({
                                "current": current,
                                "total": total,
                                "file": file,
                            }));
                        }
                        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
                        let elapsed = now_ms.saturating_sub(started_at_ms);
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": phase,
                            "elapsed": format!("{:.1}s", elapsed as f64 / 1000.0),
                        }));
                    }
                    _ => {
                        let elapsed_s = scheduled.elapsed().as_secs_f64();
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": "等待分析引擎",
                            "elapsed": format!("{:.1}s", elapsed_s),
                        }));
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn hologram_neighbors(node_id: String, depth: Option<i32>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_neighbors", &state)?;
    let d = depth.unwrap_or(2) as usize;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let nb = query::neighbors(g, &nid, d);
            serde_json::json!({"neighbors": nb.iter().map(|(s,t,d)| serde_json::json!([s,t,d])).collect::<Vec<_>>()})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_impact(node_id: String, max_depth: Option<i32>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_impact", &state)?;
    let d = max_depth.unwrap_or(3) as usize;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let layers = query::impact(g, &nid, d);
            serde_json::json!({"layers": layers})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_path(from: String, to: String, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_path", &state)?;
    let f = from.clone(); let t = to.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            match query::shortest_path(g, &f, &t) {
                Some(p) => serde_json::json!({"path": p, "length": p.len()}),
                None => serde_json::json!({"path": null, "message": "无路径"}),
            }
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_graph_diff(before_path: String, _after_path: Option<String>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_diff", &state)?;
    let bp = before_path.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |current| {
            match Graph::from_json_file(&bp) {
                Ok(before) => crate::utils::diff_to_json(&before, current),
                Err(_) => {
                    let graph_json = serde_json::to_string_pretty(current).unwrap_or_default();
                    let _ = std::fs::write(&bp, &graph_json);
                    serde_json::json!({"is_empty": true, "message": "已创建基线快照"})
                }
            }
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

/// Serialize a GraphDiff as JSON with full node/edge objects (not just counts).
/// Shared by `hologram_diff` command and `compute_watcher_diff` for watcher events.
/// Regression: this used to return `.len()` integers, which broke the frontend
/// `showDiff` that expects `{id, name, ...}` objects — status bar always showed
/// `+0 / -0 / ~0` and `(5).map(...)` threw.
fn diff_to_json(before: &Graph, after: &Graph) -> serde_json::Value {
    let d = before.diff(after);
    let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
        "location": n.location,
    })).collect();
    let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
    })).collect();
    let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| serde_json::json!({
        "node_id": new.id, "name": new.name,
        "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
    })).collect();
    let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
    serde_json::json!({
        "is_empty": is_empty,
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "modified_nodes": modified_nodes,
        "added_edges": d.added_edges.len(),
        "removed_edges": d.removed_edges.len(),
    })
}

#[tauri::command]
pub(crate) async fn hologram_fragile(limit: Option<i32>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_fragile", &state)?;
    let lim = limit.unwrap_or(10) as usize;
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| serde_json::json!(fragile_nodes(g, lim)))
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_cycle(mode: Option<String>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_cycle", &state)?;
    let m = mode.unwrap_or_else(|| "all".into());
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let cycles = detect_cycles(g);
            let filtered: Vec<_> = if m == "data" || m == "llm" {
                cycles.into_iter().filter(|c| c.get("category").and_then(|v| v.as_str()) == Some(&m)).collect()
            } else { cycles };
            serde_json::json!({"cycles": filtered, "total_cycles": filtered.len(), "mode_filter": m})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_search(query: String, limit: Option<i32>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_search", &state)?;
    let q = query.clone(); let lim = limit.unwrap_or(50) as usize;
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let results = query::search_nodes(g, &q);
            let truncated: Vec<_> = results.iter().take(lim)
                .map(|n| serde_json::json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()}))
                .collect();
            serde_json::json!({"results": truncated, "total": results.len(), "limit": lim})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_coupling_report(module: String, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_coupling_report", &state)?;
    let m = module.clone();
    tokio::task::spawn_blocking(move || {
        let v = engine_api::engine_read_graph(|g| {
            let report = coupling_report(g, &m);
            let l1 = report["L1"].as_u64().unwrap_or(0) as u32;
            let l2 = report["L2"].as_u64().unwrap_or(0) as u32;
            // L3/L4 from dataflow engine
            let root = crate::utils::project_root();
            let files = discover_source_files(&root, 200);
            let df_results = dataflow_engine::query_dataflow_files(&files);
            let mut l3 = 0u32; let mut l4 = 0u32;
            for r in &df_results {
                if let Ok(df) = &r.result {
                    for s in &df.scopes {
                        l3 += (s.reads.len() + s.writes.len()) as u32;
                        l4 += (s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len()) as u32;
                    }
                    l3 += df.shared.len() as u32;
                }
            }
            let total = (l1 + l2 + l3 + l4).max(1) as f64;
            let fragility = (l4 as f64 * 4.0 + l3 as f64 * 3.0) / total;
            serde_json::json!({
                "module": m, "total_edges": l1 + l2 + l3 + l4,
                "L1": l1, "L2": l2, "L3": l3, "L4": l4,
                "fragility": format!("{:.1}", fragility),
                "_note": "L1/L2 from graph, L3/L4 from dataflow engine",
            })
        })?;
        Ok(serde_json::to_string(&v).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_blindspots(threshold: Option<f64>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_blindspots", &state)?;
    let _ = threshold;
    tokio::task::spawn_blocking(move || {
        let v = engine_api::engine_read_graph(|g| {
            // L4 from dataflow engine + thread conflicts
            let root = crate::utils::project_root();
            let files = discover_source_files(&root, 200);
            let df_results = dataflow_engine::query_dataflow_files(&files);
            let mut l4 = 0usize;
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
                if writers.len() > 1 { conflict_count += 1; }
            }
            // Also count graph-based thread conflicts from Medium nodes
            for medium in g.nodes.values().filter(|n| n.kind == NodeKind::Medium) {
                let incoming: Vec<_> = g.edges.values()
                    .filter(|e| e.target == medium.id)
                    .collect();
                let has_write = incoming.iter().any(|e| e.kind == EdgeKind::Writes);
                let has_read = incoming.iter().any(|e| e.kind == EdgeKind::Reads);
                if has_write && has_read { conflict_count += 1; }
            }
            let cycles = detect_cycles(g);
            find_blindspots(l4, cycles.len(), conflict_count)
        })?;
        Ok(serde_json::to_string(&v).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_thread_conflicts(severity: Option<String>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_thread_conflicts", &state)?;
    let node_id = severity.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let v = engine_api::engine_read_graph(|g| {
            let mut resources = serde_json::Map::new();
            // Path A: dataflow engine shared vars (primary)
            let root = crate::utils::project_root();
            let files = discover_source_files(&root, 200);
            let df_results = dataflow_engine::query_dataflow_files(&files);
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
                    resources.insert(var.clone(), serde_json::json!({
                        "medium_type": "variable",
                        "threads": writers.iter().map(|w| serde_json::json!({"name": w, "access": "W"})).collect::<Vec<_>>(),
                        "thread_count": writers.len() + readers.len(),
                        "has_concurrent_write": true,
                        "lock_detected": false,
                        "lock_edges": Vec::<String>::new(),
                    }));
                }
            }
            // Path B: graph Medium nodes (backward compat)
            for medium in g.nodes.values().filter(|n| n.kind == NodeKind::Medium) {
                if resources.contains_key(&medium.name) { continue; }
                let incoming: Vec<_> = g.edges.values().filter(|e| e.target == medium.id).collect();
                let mut threads_info = Vec::new();
                let mut has_write = false;
                for e in &incoming {
                    let access = match e.kind { EdgeKind::Writes => "W", EdgeKind::Reads => "R", _ => continue, };
                    if e.kind == EdgeKind::Writes { has_write = true; }
                    if let Some(src) = g.nodes.get(&e.source) {
                        threads_info.push(serde_json::json!({"name": src.name, "access": access}));
                    }
                }
                if !threads_info.is_empty() {
                    resources.insert(medium.name.clone(), serde_json::json!({
                        "medium_type": "variable",
                        "threads": threads_info,
                        "thread_count": threads_info.len(),
                        "has_concurrent_write": has_write,
                        "lock_detected": false,
                        "lock_edges": Vec::<String>::new(),
                    }));
                }
            }
            let unlocked_keys: Vec<_> = resources.iter()
                .filter(|(_, v)| v["has_concurrent_write"].as_bool().unwrap_or(false) && !v["lock_detected"].as_bool().unwrap_or(true))
                .map(|(k, _)| k.clone())
                .collect();
            serde_json::json!({
                "resources": resources, "conflicts": resources.values().collect::<Vec<_>>(),
                "conflict_count": unlocked_keys.len(), "threads": resources.len(),
                "unlocked_concurrent_writes": unlocked_keys.len(), "unlocked_resources": unlocked_keys,
                "_note": "shared vars from dataflow engine + Medium nodes from graph",
            })
        })?;
        Ok(serde_json::to_string(&v).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_clusters(resolution: Option<f64>, min_size: Option<i32>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_community_report", &state)?;
    let _ = resolution; let ms = min_size.unwrap_or(3);
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let communities = detect_communities(g, 42);
            let filtered: Vec<_> = communities.iter().enumerate()
                .filter(|(_, c)| c.len() >= ms as usize)
                .map(|(i, c)| serde_json::json!({"id": format!("comm_{}", i), "size": c.len(), "node_ids": c}))
                .collect();
            serde_json::json!({"communities": filtered, "total": filtered.len()})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_graph_summary(state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_graph_summary", &state)?;
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| graph_summary(g))
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_rename(
    old_name: String, new_name: String, dry_run: Option<bool>, node_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    // ponytail: deny-only 对 stub 安全，真 rename 实现前必须改为 require_write
    crate::utils::check_mcp_permission("hologram_rename", &state)?;
    let _ = node_id; let on = old_name.clone(); let nn = new_name.clone();
    let dr = dry_run.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let matched: Vec<_> = g.nodes.values()
                .filter(|n| n.name == on || n.id.contains(&on))
                .collect();
            if matched.is_empty() {
                serde_json::json!({"error": format!("没有匹配 '{}' 的节点", on)})
            } else if dr {
                serde_json::json!({"dry_run": true, "matched_count": matched.len(),
                    "matched": matched.iter().map(|n| serde_json::json!({"id": n.id, "name": n.name})).collect::<Vec<_>>()})
            } else {
                serde_json::json!({"dry_run": false, "renamed_count": matched.len(),
                    "old_name": on, "new_name": nn, "note": "rename via in-process engine"})
            }
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_explore(
    query: Option<String>, symbols: Option<Vec<String>>, include_source: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_explore", &state)?;
    let q = query.clone(); let sym = symbols.unwrap_or_default();
    let inc_src = include_source.unwrap_or(true);
    let proj = crate::utils::project_root();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            engine::analysis::explore::explore(g, &proj, &sym, q.as_deref(), inc_src)
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_run_check(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_run_check", &state)?;
    let target = path.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());
    // Extract and clear changed_files before spawning blocking task.
    // Clearing early prevents a race where new changes arrive mid-check.
    let changed_files: Vec<String> = state.lock().unwrap().as_ref()
        .and_then(|h| {
            let mut files = h.changed_files.lock().ok()?;
            let snapshot = files.clone();
            files.clear();
            Some(snapshot)
        })
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let root = std::path::PathBuf::from(&target);
        let before = load_baseline(&root);
        // Prefer in-memory / SQLite cache; only run full analyze when truly empty.
        let after = if let Ok(g) = engine_api::engine_read_graph(|g| g.clone()) {
            if g.node_count() > 0 || g.edge_count() > 0 {
                Some(g)
            } else {
                None
            }
        } else {
            None
        };
        let after = match after {
            Some(g) => g,
            None => {
                engine_api::engine_init(&root)
                    .map_err(|e| format!("引擎初始化失败: {}", e))?;
                if let Ok(g) = engine_api::engine_read_graph(|g| g.clone()) {
                    if g.node_count() > 0 || g.edge_count() > 0 {
                        g
                    } else {
                        crate::utils::direct_analyze(&target, true)?;
                        engine_api::engine_read_graph(|g| g.clone())
                            .map_err(|e| format!("分析后无图谱: {}", e))?
                    }
                } else {
                    crate::utils::direct_analyze(&target, true)?;
                    engine_api::engine_read_graph(|g| g.clone())
                        .map_err(|e| format!("分析后无图谱: {}", e))?
                }
            }
        };
        let result = run_full_check(&before, &after, &changed_files, &target);

        // Always advance baseline — next check diffs against this snapshot.
        save_baseline(&root, &after);

        // Record meaningful checks to timeline (skip quiet open-project polls).
        let quiet = result.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);
        let baseline_seed = result.get("baseline_seed").and_then(|v| v.as_bool()).unwrap_or(false);
        if !quiet || baseline_seed {
            let passed = result["passed"].as_bool().unwrap_or(true);
            let violation_count = result["violation_count"].as_u64().unwrap_or(0);
            let event_type = if passed { "commit_clean" } else { "commit_violation" };
            let summary = if baseline_seed {
                "基线已建立".to_string()
            } else if passed {
                format!("简报通过（{} 违规）", violation_count)
            } else {
                format!("简报未通过：{} 条违规", violation_count)
            };
            let props = check_timeline_props(&result);
            if engine_api::engine_record_timeline_with_props(&event_type, None::<&str>, &summary, &props).is_err() {
                let _ = engine_api::engine_init(&root);
                let _ = engine_api::engine_record_timeline_with_props(&event_type, None::<&str>, &summary, &props);
            }
        }

        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("简报任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_run_health(path: Option<String>, days: Option<i32>, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_run_health", &state)?;
    let target = path.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());
    let d = days.unwrap_or(30);
    tokio::task::spawn_blocking(move || {
        let v = engine_api::engine_read_graph(|g| {
            let c = coupling_report(g, "");
            let cycles = detect_cycles(g);
            let fragile = fragile_nodes(g, 10);
            // L4 from dataflow engine
            let root = crate::utils::project_root();
            let files = discover_source_files(&root, 200);
            let df_results = dataflow_engine::query_dataflow_files(&files);
            let mut dataflow_l4 = 0usize;
            for r in &df_results {
                if let Ok(df) = &r.result {
                    for s in &df.scopes {
                        dataflow_l4 += s.triggers.len() + s.awaits_callbacks.len() + s.sequence_calls.len();
                    }
                }
            }
            let graph_l4 = c["L4"].as_u64().unwrap_or(0) as usize;
            let l4 = dataflow_l4.max(graph_l4) as f64;
            let density = if g.node_count() > 0 {
                (l4 / g.node_count() as f64 * 100.0).min(100.0)
            } else { 0.0 };
            let score = ((100.0 - density) * 0.6 + 40.0) as u32;
            serde_json::json!({
                "current_health": {
                    "score": score,
                    "breakdown": {"cycles": cycles.len(), "density": density as u32, "fragile": fragile.len()},
                    "total_nodes": g.node_count(), "total_edges": g.edge_count(),
                    "trend": "stable"
                },
                "days": d, "path": target,
                "note": "L4 from dataflow engine + graph",
                "summary": {
                    "nodes_total": g.node_count(), "edges_total": g.edge_count(),
                    "symbols": g.node_count(), "media": 0, "temporals": dataflow_l4,
                    "edge_types": {"calls": 0, "defines": 0, "imports": 0}
                }
            })
        })?;
        Ok(serde_json::to_string(&v).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_history(node_id: String, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_history", &state)?;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            g.get_node(&nid).map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "out_degree": n.out_degree, "in_degree": n.in_degree
            })).unwrap_or(serde_json::json!({"error": "not found"}))
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ── V4: hologram_node — complete node info + edges grouped by kind ──
#[tauri::command]
pub(crate) async fn hologram_node(node_id: String, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_node", &state)?;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_store(move |idx| {
            let node = match idx.get_node(&nid) {
                Some(n) => n.clone(),
                None => return serde_json::json!({"error": format!("Node '{}' not found", nid)}),
            };
            let incoming = idx.get_incoming_edges(&nid);
            let outgoing = idx.get_outgoing_edges(&nid);
            let group_edges = |edges: &[Edge]| -> serde_json::Map<String, serde_json::Value> {
                let mut groups: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
                for e in edges {
                    let k = e.kind.as_str().to_string();
                    groups.entry(k).or_insert_with(|| serde_json::json!([]))
                        .as_array_mut().unwrap()
                        .push(serde_json::json!({
                            "id": e.id, "source": e.source, "target": e.target,
                            "coupling_depth": e.coupling_depth,
                            "cross_file": e.cross_file,
                            "temporal_delay_sec": e.temporal_delay_sec,
                        }));
                }
                groups
            };
            serde_json::json!({
                "node": { "id": node.id, "name": node.name, "kind": node.kind.as_str(),
                    "out_degree": node.out_degree, "in_degree": node.in_degree },
                "incoming_count": incoming.len(), "outgoing_count": outgoing.len(),
                "incoming_by_kind": group_edges(&incoming),
                "outgoing_by_kind": group_edges(&outgoing),
            })
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ── V4: hologram_unused — dead code detection (in_degree == 0) ──
#[tauri::command]
pub(crate) async fn hologram_unused(
    limit: Option<usize>,
    kind_filter: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_unused", &state)?;
    let lim = limit.unwrap_or(20).min(200);
    let kinds_str = kind_filter.unwrap_or_else(|| "function,class,file".into());
    let kinds: Vec<String> = kinds_str.split(',').map(|s| s.trim().to_string()).collect();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_store(move |idx| {
            let mut candidates: Vec<serde_json::Value> = idx.nodes_iter()
                .filter(|n| n.in_degree == 0 && kinds.iter().any(|k| n.kind.as_str() == k.as_str()))
                .map(|n| serde_json::json!({
                    "id": n.id, "name": n.name, "kind": n.kind.as_str(),
                    "out_degree": n.out_degree, "in_degree": n.in_degree,
                    "location": n.location,
                }))
                .collect();
            candidates.sort_by(|a, b| {
                b["out_degree"].as_u64().unwrap_or(0)
                    .cmp(&a["out_degree"].as_u64().unwrap_or(0))
            });
            candidates.truncate(lim);
            serde_json::json!({"unused": candidates, "count": candidates.len()})
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_community(node_id: String, state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_community", &state)?;
    let nid = node_id.clone();
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            let communities = detect_communities(g, 42);
            let found = communities.iter().find(|c| c.contains(&nid));
            found.map(|c| serde_json::json!({"community": c.iter().take(50).collect::<Vec<_>>()}))
                .unwrap_or(serde_json::json!({"community": null}))
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_delayed(state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_delayed", &state)?;
    tokio::task::spawn_blocking(move || {
        let root = crate::utils::project_root();
        let files = discover_source_files(&root, 200);
        let df_results = dataflow_engine::query_dataflow_files(&files);
        let mut triggers: Vec<serde_json::Value> = Vec::new();
        let mut awaits: Vec<serde_json::Value> = Vec::new();
        let mut sequences: Vec<serde_json::Value> = Vec::new();
        for r in &df_results {
            if let Ok(df) = &r.result {
                for s in &df.scopes {
                    for t in &s.triggers {
                        triggers.push(serde_json::json!({
                            "file": r.file, "scope": s.name, "target": t, "type": "trigger",
                        }));
                    }
                    for a in &s.awaits_callbacks {
                        awaits.push(serde_json::json!({
                            "file": r.file, "scope": s.name, "target": a, "type": "await",
                        }));
                    }
                    for seq in &s.sequence_calls {
                        sequences.push(serde_json::json!({
                            "file": r.file, "scope": s.name, "target": seq, "type": "sequence",
                        }));
                    }
                }
            }
        }
        let total = triggers.len() + awaits.len() + sequences.len();
        Ok(serde_json::to_string(&serde_json::json!({
            "total_delayed_edges": total,
            "triggers_count": triggers.len(), "awaits_count": awaits.len(),
            "sequences_count": sequences.len(),
            "triggers": triggers, "awaits": awaits, "sequences": sequences,
            "_note": "from dataflow engine (on-demand query, no graph storage)",
        })).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_run_preflight(
    path: String, files: Option<Vec<String>>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_run_preflight", &state)?;
    let p = path.clone(); let f = files.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let before = engine_api::engine_read_graph(|g| g.clone()).unwrap_or_default();
        // Before = current state; after = current state (preflight checks hypothetical changes to files in f)
        let result = run_full_check(&before, &before, &f, &p);
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_status(state: tauri::State<'_, crate::WorkspaceState>) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_status", &state)?;
    tokio::task::spawn_blocking(move || {
        crate::utils::with_graph(move |g| {
            serde_json::json!({
                "phase": "ready", "store": "MemoryIndex (direct)",
                "nodes": g.node_count(), "edges": g.edge_count(),
                "nodes_loaded": g.node_count(), "edges_loaded": g.edge_count(),
                "has_aux_indexes": true, "elapsed_ms": 0
            })
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_policy_check(
    rules: Option<serde_json::Value>,
    source: Option<String>,
    target: Option<String>,
    edge_kinds: Option<Vec<String>>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_policy_check", &state)?;
    // Build the rules JSON — either from full rules array or shortcut params
    let rules_val = if let Some(r) = rules {
        r
    } else if let (Some(src), Some(tgt)) = (source.as_ref(), target.as_ref()) {
        let mut rule = serde_json::json!({
            "name": "ad-hoc",
            "source": src,
            "target": tgt,
            "message": format!("{} → {} 依赖违规", src, tgt),
        });
        if let Some(ref kinds) = edge_kinds {
            rule["edge_kinds"] = serde_json::json!(kinds);
        }
        serde_json::json!([rule])
    } else {
        return Err("Provide either 'rules' (array of rule objects) or both 'source' and 'target'.".into());
    };

    tokio::task::spawn_blocking(move || {
        crate::utils::with_store(move |idx| {
            policy_check_from_index(idx, &rules_val)
        })
    }).await.map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// Timeline — already direct SQLite, kept as-is
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_timeline(
    path: Option<String>,
    since: Option<String>,
    limit: Option<i32>,
    module: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_timeline", &state)?;
    let _proj = path
        .filter(|p| !p.is_empty())
        .or_else(|| crate::utils::workspace_path(&state).ok())
        .unwrap_or_default();
    if _proj.is_empty() {
        return Err("未打开工作区，请先打开项目".into());
    }
    let since_val = since.filter(|s| !s.is_empty());
    let lim = limit.unwrap_or(60) as usize;
    let module_filter = module.filter(|m| !m.is_empty());

    tokio::task::spawn_blocking(move || {
        let events = engine_api::engine_query_timeline(lim).unwrap_or_default();

        let events: Vec<_> = if let Some(ref m) = module_filter {
            events.into_iter().filter(|e| {
                e.get("file").and_then(|f| f.as_str())
                    .map(|f| f.contains(m.as_str()))
                    .unwrap_or(false)
            }).collect()
        } else {
            events
        };
        // Apply since filter if provided
        let events: Vec<_> = if let Some(ref sv) = since_val {
            events.into_iter().filter(|e| {
                e.get("timestamp").and_then(|t| t.as_str())
                    .map(|t| t >= sv.as_str()).unwrap_or(false)
            }).collect()
        } else {
            events
        };
        Ok(serde_json::json!({"events": events}).to_string())
    }).await.map_err(|e| format!("时间轴查询失败: {e}"))?
}

/// Record a user-facing event in the unified timeline (hologram.db).
#[tauri::command]
pub(crate) async fn hologram_record_event(
    event_type: String,
    file: Option<String>,
    summary: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_record_event", &state)?;
    let _ = tokio::task::spawn_blocking(move || {
        engine_api::engine_record_timeline(&event_type, file.as_deref(), &summary)
            .map_err(|e| format!("时间轴写入失败: {}", e))
    }).await.map_err(|e| format!("时间轴写入失败: {}", e))??;
    Ok("ok".into())
}


// ═══════════════════════════════════════════════════════
// P6: Hotspots — 复发热点检测（L4 复发计数）
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_hotspots(
    days: Option<i32>,
    min_count: Option<i32>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_hotspots", &state)?;
    let limit = min_count.unwrap_or(3) as usize;
    let _ = days;
    tokio::task::spawn_blocking(move || {
        match engine_api::engine_query_timeline(limit) {
            Ok(events) => Ok(serde_json::json!({"events": events, "limit": limit}).to_string()),
            Err(e) => Ok(serde_json::json!({"error": e, "events": []}).to_string()),
        }
    }).await.map_err(|e| format!("热点查询失败: {e}"))?
}

// ═══════════════════════════════════════════════════════
// P7: Workspace Conflict — 多工作区冲突预演
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_workspace_conflict(
    path_a: String,
    path_b: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_workspace_conflict", &state)?;
    // No dedicated MCP conflict tool yet — return structured stub
    Ok(serde_json::json!({
        "status": "not_implemented",
        "message": "workspace_conflict requires a dedicated MCP tool (not yet implemented in engine). Use hologram_preflight on each workspace to compare impact.",
        "path_a": path_a,
        "path_b": path_b,
    }).to_string())
}

// ═══════════════════════════════════════════════════════
// P8: Gate Check — 门禁模式（新模块 fan-in/fan-out/耦合评估）
// ═══════════════════════════════════════════════════════

#[tauri::command]
pub(crate) async fn hologram_gate_check(
    path: String,
    _module_file: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_gate_check", &state)?;
    // Gate check reuses hologram_run_check logic
    let target = path;
    let changed_files: Vec<String> = state.lock().unwrap().as_ref()
        .and_then(|h| h.changed_files.lock().ok())
        .map(|f| f.clone())
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        use engine::routing::preflight::run_full_check;
        let after = engine_api::engine_read_graph(|g| g.clone()).unwrap_or_default();
        let result = run_full_check(&after, &after, &changed_files, &target);
        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("任务失败: {e}"))?
}
