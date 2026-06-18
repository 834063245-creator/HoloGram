#![windows_subsystem = "windows"]

use hologram_engine::analysis::{coupling::compute_coupling, fragile_nodes, detect_cycles, coupling_report, graph_summary, thread_conflict_report, find_blindspots};
use hologram_engine::community::detect_communities;
use hologram_engine::graph::{CrossFileResolver, query, Graph, EdgeKind};
use hologram_engine::logging;
use hologram_engine::routing::preflight::run_full_check;
use hologram_engine::pipeline::runner::analyze_project;
use hologram_engine::mcp::{self, McpServer, with_graph_store};
use serde_json::{self, json};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, debug, warn};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── MCP serve mode ──
    if let Some(project_root_opt) = mcp::parse_serve_args() {
        let log_root = project_root_opt.as_deref().map(PathBuf::from);
        let _log_guard = logging::init_logging(log_root.as_deref());

        match project_root_opt {
            Some(project_root) => {
                // Serve with --project-root: auto-analyze + watcher
                let root = PathBuf::from(&project_root);
                if !root.exists() {
                    eprintln!("[engine] ERROR: project root not found: {}", project_root);
                    std::process::exit(1);
                }
                info!(project_root = %project_root, "engine starting in MCP serve mode (with project)");

                // Initialize the storage engine (GraphStore + SQLite) lazily.
                // Actual analysis is deferred to the first hologram_analyze MCP call.
                // Watcher is also deferred — Windows notify can emit spurious events
                // during startup, triggering re-analysis loops (622MB, 195 CPU seen).
                if let Err(e) = mcp::init_graph_store(&root) {
                    warn!("[main] GraphStore init failed (non-fatal): {}", e);
                }

                info!("engine MCP serve ready — analysis + watcher deferred to first hologram_analyze");

                // Send ready signal for Tauri McpManager — it expects {"method":"ready"}
                // before sending initialize + tools/list. Without this, read_ready() times out.
                println!(r#"{{"jsonrpc":"2.0","method":"ready"}}"#);

                let server = McpServer::new(&root);
                server.run_stdio();
            }
            None => {
                // Serve without --project-root: lazy startup
                // First hologram_analyze call loads the graph.
                info!("engine starting in MCP serve mode (lazy — no project)");
                let server = McpServer::new(std::path::Path::new("."));
                server.run_stdio();
            }
        }
        return Ok(());
    }

    // ── TCP RPC server mode (default) ──
    let _log_guard = logging::init_logging(None);
    let listener = TcpListener::bind("127.0.0.1:9777").await?;
    info!("TCP server listening on 127.0.0.1:9777");

    loop {
        let (mut socket, addr) = listener.accept().await?;
        debug!(%addr, "client connected");

        // Spawn each connection into its own task so the accept loop never blocks.
        // Keep-alive: loop to handle multiple requests per connection.
        // Heavy CPU work (analyze, check) is offloaded to spawn_blocking.
        tokio::spawn(async move {
            loop {
            let mut buf = vec![0u8; 4096];
            let n = match socket.read(&mut buf).await {
                Ok(0) => { debug!(%addr, "client disconnected"); return; }
                Ok(n) => n,
                Err(e) => { debug!(%addr, "read error: {}", e); return; }
            };
            let request = String::from_utf8_lossy(&buf[..n]);
            let req_owned = request.to_string();
            debug!(request_len = req_owned.len(), "received request");

            let response = if req_owned.starts_with("check:") || req_owned.starts_with("preflight:") || req_owned.starts_with("health:") {
                let req = req_owned.clone();
                tokio::task::spawn_blocking(move || handle_check(req.trim()))
                    .await.unwrap_or_else(|_| b"{\"error\":\"check panicked\"}".to_vec())
            } else if req_owned.starts_with("thread") {
                let arg = req_owned.trim().strip_prefix("thread:").unwrap_or("");
                handle_simple("thread", arg, |g, severity| {
                    let mut report = thread_conflict_report(g, &[]);
                    if !severity.is_empty() {
                        if let Some(obj) = report.as_object_mut() {
                            obj.insert("severity_filter".into(), json!(severity));
                        }
                    }
                    report
                })
            } else if req_owned.starts_with("blindspots") {
                let arg = req_owned.trim().strip_prefix("blindspots:").unwrap_or("");
                let threshold: usize = arg.parse().unwrap_or(0);
                handle_simple("blindspots", arg, move |g, _| {
                    let c = coupling_report(g, "");
                    let cycles = detect_cycles(g);
                    let conflicts = thread_conflict_report(g, &[]);
                    find_blindspots(
                        if threshold > 0 { threshold } else { c["L4"].as_u64().unwrap_or(0) as usize },
                        cycles.len(),
                        conflicts["conflict_count"].as_u64().unwrap_or(0) as usize,
                    )
                })
            } else if req_owned.starts_with("timeline") {
                handle_simple("timeline", req_owned.trim(), |_g, _a| {
                    json!(with_graph_store(|store| {
                        store.db.query_timeline(50).unwrap_or_default()
                    }).unwrap_or_default())
                })
            } else if req_owned.starts_with("analyze:") {
                let path = req_owned.trim().strip_prefix("analyze:").unwrap_or(".").trim().to_string();
                tokio::task::spawn_blocking(move || handle_analyze(&path))
                    .await.unwrap_or_else(|_| b"{\"error\":\"analyze panicked\"}".to_vec())
            } else if req_owned.starts_with("fragile:") {
                handle_simple("fragile:", req_owned.trim(), |g, a| json!(fragile_nodes(g, a.parse().unwrap_or(10))))
            } else if req_owned.starts_with("cycle") {
                handle_simple("cycle", req_owned.trim(), |g, _| json!(detect_cycles(g)))
            } else if req_owned.starts_with("coupling_report:") {
                handle_simple("coupling_report:", req_owned.trim(), |g, a| coupling_report(g, a))
            } else if req_owned.starts_with("graph_summary") {
                handle_simple("graph_summary", req_owned.trim(), |g, _| graph_summary(g))
            } else if req_owned.starts_with("community_report") {
                handle_simple("community_report", req_owned.trim(), |g, _| {
                    let communities = detect_communities(g, 42);
                    json!(communities.iter().enumerate().map(|(i,c)| json!({"id":format!("comm_{}",i),"size":c.len(),"node_ids":c})).collect::<Vec<_>>())
                })
            } else if req_owned.starts_with("community:") {
                handle_simple("community:", req_owned.trim(), |g, a| {
                    let communities = detect_communities(g, 42);
                    let found = communities.iter().find(|c| c.contains(&a.to_string()));
                    json!(found.map(|c| c.iter().take(50).collect::<Vec<_>>()))
                })
            } else if req_owned.starts_with("diff:") {
                let baseline_path = req_owned.trim().strip_prefix("diff:").unwrap_or("").trim().to_string();
                handle_diff(&baseline_path)
            } else if req_owned.starts_with("history:") {
                handle_simple("history:", req_owned.trim(), |g, a| {
                    g.get_node(a).map(|n| json!({"id":n.id,"name":n.name,"type":n.kind.as_str(),"out_degree":n.out_degree,"in_degree":n.in_degree}))
                        .unwrap_or(json!({"error":"not found"}))
                })
            } else if req_owned.starts_with("delayed") {
                handle_simple("delayed", req_owned.trim(), |g, _| {
                    let delayed: Vec<_> = g.edges.values().filter(|e| matches!(e.kind, EdgeKind::Triggers|EdgeKind::Awaits|EdgeKind::Sequences))
                        .map(|e| json!({"source":e.source,"target":e.target,"type":e.kind.as_str()}))
                        .collect();
                    json!(delayed)
                })
            } else if req_owned.starts_with("neighbors:") {
                handle_query(req_owned.trim(), "neighbors:")
            } else if req_owned.starts_with("path:") {
                handle_query(req_owned.trim(), "path:")
            } else if req_owned.starts_with("search:") {
                // Parse "search:query:limit" — limit is optional
                let args = req_owned.trim().strip_prefix("search:").unwrap_or("");
                let (query_str, limit): (&str, usize) = match args.rfind(':') {
                    Some(pos) if pos > 0 => {
                        let (q, l) = args.split_at(pos);
                        (q, l[1..].parse().unwrap_or(50))
                    }
                    _ => (args, 50),
                };
                handle_simple("search:", query_str, move |g, _| {
                    let results = query::search_nodes(g, query_str);
                    let truncated: Vec<_> = results.iter().take(limit).map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
                    json!({"results": truncated, "total": results.len(), "limit": limit})
                })
            } else if req_owned.starts_with("impact:") {
                handle_query(req_owned.trim(), "impact:")
            } else if req_owned.starts_with("rename:") {
                // Parse "rename:old_name:new_name:dry_run:node_id"
                let args = req_owned.trim().strip_prefix("rename:").unwrap_or("");
                let parts: Vec<&str> = args.splitn(4, ':').collect();
                let old_name = parts.first().copied().unwrap_or("");
                let new_name = parts.get(1).copied().unwrap_or("");
                let dry_run: bool = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(false);
                let _node_id = parts.get(3).copied().unwrap_or("");
                handle_simple("rename:", old_name, move |g, _| {
                    let matched: Vec<_> = g.nodes.values()
                        .filter(|n| n.name == old_name || n.id.contains(old_name))
                        .collect();
                    if matched.is_empty() {
                        json!({"error": format!("No nodes match '{}'", old_name)})
                    } else if dry_run {
                        json!({"dry_run": true, "matched_count": matched.len(), "matched": matched.iter().map(|n| json!({"id": n.id, "name": n.name})).collect::<Vec<_>>()})
                    } else {
                        json!({"dry_run": false, "renamed_count": matched.len(), "old_name": old_name, "new_name": new_name, "note": "TCP rename: in-memory only. Use MCP tool for full rename support."})
                    }
                })
            } else if req_owned.contains("get_graph") {
                handle_get_graph()
            } else if req_owned.contains("ping") {
                b"{\"ok\":true}".to_vec()
            } else {
                b"{\"error\":\"unknown command\"}".to_vec()
            };

            let framed = frame_response(&response);
            if let Err(e) = socket.write_all(&framed).await {
                debug!(%addr, "write error: {}", e);
                return;
            }
            } // end keep-alive loop
        });
    }
}

fn handle_analyze(path: &str) -> Vec<u8> {
    let root = PathBuf::from(path);
    if !root.exists() {
        return serde_json::to_vec(&serde_json::json!({
            "error": "path not found",
            "path": path
        }))
        .unwrap_or_default();
    }

    let mut result = analyze_project(&root);

    // Post-processing: cross-file edge resolution
    let resolve_start = std::time::Instant::now();
    let resolved = CrossFileResolver::resolve(&mut result.graph);
    info!(edges = resolved, elapsed_secs = resolve_start.elapsed().as_secs_f64(), "cross-file resolution done");

    // Post-processing: coupling depth + framework routes + dynamic dispatch
    let coupling_start = std::time::Instant::now();
    compute_coupling(&mut result.graph);
    info!(elapsed_secs = coupling_start.elapsed().as_secs_f64(), "coupling computation done");

    // Framework route detection (Django, Express, ...)
    hologram_engine::analysis::detect_framework_routes(&mut result.graph, &root);
    info!("framework routes detected");

    // Dynamic dispatch synthesis (callback/observer edges)
    hologram_engine::analysis::synthesize_dynamic_edges(&mut result.graph, &root);
    info!("dynamic dispatch edges synthesized");

    let comm_start = std::time::Instant::now();
    let communities = detect_communities(&result.graph, 42);

    // Cache for subsequent queries
    let graph_clone = result.graph.clone();
    if let Ok(mut cache) = mcp::CACHED_GRAPH.lock() {
        *cache = Some(graph_clone);
    }

    // Record timeline event
    let _ = with_graph_store(|store| {
        store.db.record_timeline(
            "analyze",
            None::<&str>,
            &format!("全量分析完成：{} 节点, {} 边, {:.1}s", result.graph.node_count(), result.graph.edge_count(), result.elapsed_secs),
        ).ok()
    });

    info!(count = communities.len(), elapsed_secs = comm_start.elapsed().as_secs_f64(), "communities detected");

    // Serialize full graph for Unity consumption
    let nodes: Vec<serde_json::Value> = result.graph.nodes.values().map(|n| {
        serde_json::json!({
            "id": n.id,
            "name": n.name,
            "type": n.kind.as_str(),
            "location": n.location,
            "in_degree": n.in_degree,
            "out_degree": n.out_degree,
            "properties": n.properties,
            "position": n.position,
            "community_id": n.community_id
        })
    }).collect();

    let edges: Vec<serde_json::Value> = result.graph.edges.values().map(|e| {
        serde_json::json!({
            "id": e.id,
            "source": e.source,
            "target": e.target,
            "type": e.kind.as_str(),
            "coupling_depth": e.coupling_depth,
            "cross_file": e.cross_file,
            "direction": e.direction,
            "temporal_delay_sec": e.temporal_delay_sec,
            "medium_node_id": e.medium_node_id
        })
    }).collect();

    let communities_json: Vec<serde_json::Value> = communities
        .iter()
        .enumerate()
        .map(|(i, c)| {
            serde_json::json!({
                "id": format!("comm_{}", i),
                "label": format!("社区 {}", i + 1),
                "size": c.len(),
                "node_ids": c
            })
        })
        .collect();

    serde_json::to_vec(&serde_json::json!({
        "nodes": nodes,
        "edges": edges,
        "communities": communities_json,
        "elapsed_secs": result.elapsed_secs,
        "node_count": result.graph.node_count(),
        "edge_count": result.graph.edge_count()
    }))
    .unwrap_or_default()
}

fn handle_check(request: &str) -> Vec<u8> {
    // Parse "check:<path>" or "check:<path>\n<json_files>"
    let body = request.strip_prefix("check:").unwrap_or(".");
    let (path, changed_files): (&str, Vec<String>) = if let Some((p, files_json)) = body.split_once('\n') {
        let files: Vec<String> = serde_json::from_str(files_json.trim()).unwrap_or_default();
        (p.trim(), files)
    } else {
        (body.trim(), vec![])
    };
    let root = PathBuf::from(path);
    let hologram_dir = root.join(".hologram");
    let baseline_path = hologram_dir.join("baseline.json");

    // Auto-analyze if no cached graph
    {
        let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
        if cache.is_none() {
            drop(cache);
            if root.exists() {
                let mut result = analyze_project(&root);
                compute_coupling(&mut result.graph);
                detect_communities(&result.graph, 42);
                if let Ok(mut c) = mcp::CACHED_GRAPH.lock() { *c = Some(result.graph.clone()); }
            }
        }
    }

    let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    let after = match cache.as_ref() {
        Some(g) => g,
        None => return b"{\"error\":\"project not found\"}".to_vec(),
    };

    // Load previous baseline — first run has no baseline, use empty graph
    let before: hologram_engine::graph::Graph = if baseline_path.exists() {
        std::fs::read_to_string(&baseline_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        hologram_engine::graph::Graph::default()
    };

    let result = run_full_check(&before, after, &changed_files, path);

    // Save current graph as new baseline — only if check passed
    let passed = result["passed"].as_bool().unwrap_or(true);
    if passed {
        let _ = std::fs::create_dir_all(&hologram_dir);
        if let Ok(json) = serde_json::to_string_pretty(after) {
            let _ = std::fs::write(&baseline_path, json);
        }
    }

    // Record timeline event with full check properties
    let _ = with_graph_store(|store| {
        let violation_count = result["violation_count"].as_u64().unwrap_or(0);
        let event_type = if passed { "commit_clean" } else { "commit_violation" };
        let summary = if passed {
            format!("简报通过（{} 违规）", violation_count)
        } else {
            format!("简报未通过：{} 条违规", violation_count)
        };
        let props = serde_json::json!({
            "passed": result["passed"],
            "timestamp": result["timestamp"],
            "changed_files": result["changed_files"],
            "total_changed_files": result["total_changed_files"],
            "l5_violations": result["l5_violations"],
            "l4_violations": result["l4_violations"],
            "l3_violations": result["l3_violations"],
            "l2_violations": result["l2_violations"],
            "passed_checks": result["passed_checks"],
            "blast_radius": result["blast_radius"],
            "cross_community_edges": result["cross_community_edges"],
            "new_cycles": result["new_cycles"],
            "new_thread_conflicts": result["new_thread_conflicts"],
            "api_signature_changes": result["api_signature_changes"],
            "violation_count": result["violation_count"],
        });
        store.db.record_timeline_with_props(&event_type, None::<&str>, &summary, &props).ok()
    });

    serde_json::to_vec(&result).unwrap_or_default()
}

fn handle_simple<F: FnOnce(&Graph, &str) -> serde_json::Value>(prefix: &str, request: &str, f: F) -> Vec<u8> {
    let arg = request.strip_prefix(prefix).unwrap_or("");
    let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(g) => serde_json::to_vec(&f(g, arg)).unwrap_or_default(),
        None => b"{\"error\":\"no graph loaded\"}".to_vec(),
    }
}

fn handle_diff(baseline_path: &str) -> Vec<u8> {
    let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    let current = match cache.as_ref() {
        Some(g) => g,
        None => return b"{\"error\":\"no graph loaded, run analyze first\"}".to_vec(),
    };

    let baseline_path = if baseline_path.is_empty() {
        "hologram_before.json".to_string()
    } else {
        baseline_path.to_string()
    };

    // Try to load baseline
    match Graph::from_json_file(&baseline_path) {
        Ok(baseline) => {
            let d = baseline.diff(&current);
            let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
            let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| json!({"id": n.id, "name": n.name, "kind": n.kind.as_str()})).collect();
            let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| json!({
                "node_id": new.id, "name": new.name,
                "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
            })).collect();
            let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
            serde_json::to_vec(&json!({
                "is_empty": is_empty,
                "added_nodes": added_nodes,
                "removed_nodes": removed_nodes,
                "modified_nodes": modified_nodes,
                "added_edges": d.added_edges.len(),
                "removed_edges": d.removed_edges.len(),
            })).unwrap_or_default()
        }
        Err(_) => {
            // Baseline doesn't exist yet — save current graph as baseline
            let graph_json = serde_json::to_string_pretty(current).unwrap_or_default();
            if let Err(e) = std::fs::write(&baseline_path, &graph_json) {
                return serde_json::to_vec(&json!({"error": format!("无法创建基线: {}", e)})).unwrap_or_default();
            }
            serde_json::to_vec(&json!({
                "is_empty": true,
                "message": "已创建变更基线，再次点击变更即可比较差异",
                "baseline_path": baseline_path,
            })).unwrap_or_default()
        }
    }
}

fn handle_query(request: &str, prefix: &str) -> Vec<u8> {
    let args = request.strip_prefix(prefix).unwrap_or("");
    let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    let graph = match cache.as_ref() {
        Some(g) => g,
        None => return b"{\"error\":\"no graph loaded, run analyze first\"}".to_vec(),
    };

    let result = match prefix {
        "neighbors:" => {
            let parts: Vec<&str> = args.split(':').collect();
            let node_id = parts[0];
            let depth: usize = parts.get(1).and_then(|d| d.parse().ok()).unwrap_or(1);
            let nb = query::neighbors(graph, node_id, depth);
            serde_json::json!({ "neighbors": nb.iter().map(|(s,t,d)| json!([s,t,d])).collect::<Vec<_>>() })
        }
        "path:" => {
            let parts: Vec<&str> = args.split(':').collect();
            if parts.len() < 2 { serde_json::json!({"error":"usage: path:from:to"}) }
            else {
                match query::shortest_path(graph, parts[0], parts[1]) {
                    Some(p) => serde_json::json!({"path": p, "length": p.len()}),
                    None => serde_json::json!({"path": null, "message": "no path found"}),
                }
            }
        }
        "search:" => {
            let results = query::search_nodes(graph, args);
            serde_json::json!({ "results": results.iter().map(|n| json!({"id":n.id,"name":n.name})).collect::<Vec<_>>() })
        }
        "impact:" => {
            let parts: Vec<&str> = args.split(':').collect();
            let node_id = parts[0];
            let max_depth: usize = parts.get(1).and_then(|d| d.parse().ok()).unwrap_or(3);
            let layers = query::impact(graph, node_id, max_depth);
            serde_json::json!({ "layers": layers })
        }
        _ => serde_json::json!({"error":"unknown query"}),
    };

    serde_json::to_vec(&result).unwrap_or_default()
}

fn handle_get_graph() -> Vec<u8> {
    let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(g) => {
            let nodes: Vec<serde_json::Value> = g.nodes.values().map(|n| {
                serde_json::json!({
                    "id": n.id, "name": n.name, "type": n.kind.as_str(),
                    "location": n.location, "in_degree": n.in_degree,
                    "out_degree": n.out_degree, "properties": n.properties,
                    "position": n.position, "community_id": n.community_id,
                })
            }).collect();
            let edges: Vec<serde_json::Value> = g.edges.values().map(|e| {
                serde_json::json!({
                    "id": e.id, "source": e.source, "target": e.target,
                    "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                    "cross_file": e.cross_file, "direction": e.direction,
                    "temporal_delay_sec": e.temporal_delay_sec,
                    "medium_node_id": e.medium_node_id,
                })
            }).collect();
            serde_json::to_vec(&serde_json::json!({"nodes": nodes, "edges": edges})).unwrap_or_default()
        }
        None => b"{\"nodes\":[],\"edges\":[]}".to_vec(),
    }
}

// ═══════════════════════════════════════════════════════════════
// Protocol helpers (testable)
// ═══════════════════════════════════════════════════════════════

/// Frame a payload with 4-byte little-endian length prefix.
fn frame_response(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&len.to_le_bytes());
    framed.extend_from_slice(payload);
    framed
}

/// Parse a framed message: returns (payload, bytes_consumed) or None.
#[allow(dead_code)]
fn unframe(buf: &[u8]) -> Option<(Vec<u8>, usize)> {
    if buf.len() < 4 { return None; }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + len { return None; }
    Some((buf[4..4 + len].to_vec(), 4 + len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hologram_engine::graph::{Edge, EdgeKind, Node, NodeKind};
    use hologram_engine::mcp;

    // Mutex to serialize CACHED_GRAPH access in bin tests
    static BIN_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_bin() -> std::sync::MutexGuard<'static, ()> {
        BIN_MUTEX.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn load_test_graph() -> std::sync::MutexGuard<'static, ()> {
        let guard = lock_bin();
        let mut g = hologram_engine::graph::Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/a.rs".into());
        g.add_node(a);
        let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
        b.location = Some("src/b.rs".into());
        g.add_node(b);
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        if let Ok(mut cache) = mcp::CACHED_GRAPH.lock() {
            *cache = Some(g);
        }
        guard
    }

    fn clear_graph() {
        if let Ok(mut cache) = mcp::CACHED_GRAPH.lock() {
            *cache = None;
        }
    }

    // ── Framing protocol ──

    #[test]
    fn test_frame_roundtrip() {
        let payload = b"{\"ok\":true}";
        let framed = frame_response(payload);
        assert_eq!(framed.len(), 4 + payload.len());
        let (decoded, consumed) = unframe(&framed).unwrap();
        assert_eq!(decoded, payload);
        assert_eq!(consumed, framed.len());
    }

    #[test]
    fn test_frame_empty_payload() {
        let framed = frame_response(b"");
        assert_eq!(&framed[..4], &[0, 0, 0, 0]); // length 0
        let (decoded, _) = unframe(&framed).unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn test_frame_large_payload() {
        let payload = vec![b'x'; 65536];
        let framed = frame_response(&payload);
        let (decoded, _) = unframe(&framed).unwrap();
        assert_eq!(decoded.len(), 65536);
    }

    #[test]
    fn test_unframe_insufficient_data() {
        assert!(unframe(&[0x01]).is_none());
        let framed = frame_response(b"hello");
        assert!(unframe(&framed[..2]).is_none()); // truncated
    }

    // ── handle_get_graph ──

    #[test]
    fn test_handle_get_graph_returns_empty_when_no_cache() {
        let _lock = lock_bin();
        clear_graph();
        let response = handle_get_graph();
        let v: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(v["nodes"].as_array().unwrap().len(), 0);
        assert_eq!(v["edges"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn test_handle_get_graph_returns_cached_data() {
        // Populate CACHED_GRAPH first
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        if let Ok(mut cache) = mcp::CACHED_GRAPH.lock() {
            *cache = Some(g);
        }
        let response = handle_get_graph();
        let v: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(v["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(v["edges"].as_array().unwrap().len(), 1);
        let ids: Vec<&str> = v["nodes"].as_array().unwrap().iter()
            .filter_map(|n| n["id"].as_str()).collect();
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"b"));
        assert_eq!(v["edges"][0]["source"], "a");
        // Clean up — must run even if assertions fail
        let _ = mcp::CACHED_GRAPH.lock().map(|mut c| *c = None);
    }

    // ── handle_simple ──

    #[test]
    fn test_handle_simple_with_graph() {
        let _g = load_test_graph();
        // "fragile:5" → calls fragile_nodes(g, "5") where "5" is parsed as limit
        let resp = handle_simple("fragile:", "fragile:5", |g, a| {
            json!(hologram_engine::analysis::fragile_nodes(g, a.parse().unwrap_or(10)))
        });
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v.is_array());
    }

    #[test]
    fn test_handle_simple_no_graph() {
        let _lock = lock_bin();
        clear_graph();
        let resp = handle_simple("fragile:", "fragile:5", |_, _| json!({}));
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "no graph loaded");
    }

    #[test]
    fn test_handle_simple_empty_arg() {
        let _g = load_test_graph();
        // "cycle" with no arg
        let resp = handle_simple("cycle", "cycle", |g, _| {
            json!(hologram_engine::analysis::detect_cycles(g))
        });
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v.is_array());
    }

    // ── handle_query ──

    #[test]
    fn test_handle_query_neighbors() {
        let _g = load_test_graph();
        let resp = handle_query("neighbors:a", "neighbors:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["neighbors"].is_array());
    }

    #[test]
    fn test_handle_query_path_found() {
        let _g = load_test_graph();
        let resp = handle_query("path:a:b", "path:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["path"].is_array());
        assert!(v["length"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_handle_query_path_missing_args() {
        let _g = load_test_graph();
        let resp = handle_query("path:a", "path:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["error"].as_str().unwrap().contains("usage"));
    }

    #[test]
    fn test_handle_query_search() {
        let _g = load_test_graph();
        let resp = handle_query("search:mod", "search:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["results"].is_array());
    }

    #[test]
    fn test_handle_query_impact() {
        let _g = load_test_graph();
        let resp = handle_query("impact:a:2", "impact:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["layers"].is_array());
    }

    #[test]
    fn test_handle_query_no_graph() {
        clear_graph();
        let resp = handle_query("neighbors:a", "neighbors:");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "no graph loaded, run analyze first");
    }

    // ── handle_analyze (smoke test with temp project) ──

    #[test]
    fn test_handle_analyze_valid_project() {
        let _g = lock_bin();
        let tmp = std::env::temp_dir().join("hologram_main_test_proj");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("main.py"), "def hello(): pass\n").unwrap();

        let path = tmp.to_str().unwrap();
        // handle_analyze takes the raw request string (prefix stripped by caller in main loop)
        let resp = handle_analyze(path);
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert!(v["nodes"].is_array());
        assert!(v["node_count"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_handle_analyze_nonexistent_path() {
        let fake = std::env::temp_dir().join("__hologram_nonexistent_dir__");
        // Ensure it doesn't exist
        let _ = std::fs::remove_dir_all(&fake);
        let resp = handle_analyze(fake.to_str().unwrap());
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "path not found");
    }

    // ── handle_check ──

    #[test]
    fn test_handle_check_no_project() {
        let _g = lock_bin();
        clear_graph();
        // handle_check strips the "check:" prefix internally
        let resp = handle_check("check:C:/nonexistent/path/xyz");
        let v: serde_json::Value = serde_json::from_slice(&resp).unwrap();
        assert_eq!(v["error"], "project not found");
    }
}
