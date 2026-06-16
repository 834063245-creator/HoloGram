#![windows_subsystem = "windows"]

use hologram_engine::analysis::{coupling::compute_coupling, fragile_nodes, detect_cycles, coupling_report, graph_summary, thread_conflict_report, find_blindspots};
use hologram_engine::community::detect_communities;
use hologram_engine::graph::{CrossFileResolver, query, Graph, EdgeKind};
use hologram_engine::logging;
use hologram_engine::routing::preflight::run_full_check;
use hologram_engine::timeline::TimelineStore;
use hologram_engine::pipeline::runner::analyze_project;
use hologram_engine::mcp::{self, McpServer};
use serde_json::{self, json};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{info, debug};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // ── MCP serve mode ──
    if let Some(project_root) = mcp::parse_serve_args() {
        let root = PathBuf::from(&project_root);
        if !root.exists() {
            eprintln!("[engine] ERROR: project root not found: {}", project_root);
            std::process::exit(1);
        }
        let _log_guard = logging::init_logging(Some(&root));
        info!(project_root = %project_root, "engine starting in MCP serve mode");

        // Auto-analyze on startup
        info!("analysis started");
        let mut result = analyze_project(&root);
        CrossFileResolver::resolve(&mut result.graph);
        compute_coupling(&mut result.graph);
        detect_communities(&result.graph, 42);
        let node_count = result.graph.node_count();
        let edge_count = result.graph.edge_count();
        if let Ok(mut cache) = mcp::CACHED_GRAPH.lock() {
            *cache = Some(result.graph);
        }
        info!(nodes = node_count, edges = edge_count, elapsed = %result.elapsed_secs, "analysis complete");

        // Signal ready to parent process (McpManager reads this)
        let ready = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "ready",
            "params": {
                "node_count": node_count,
                "edge_count": edge_count,
                "elapsed_secs": result.elapsed_secs
            }
        });
        println!("{}", serde_json::to_string(&ready).unwrap_or_default());

        let server = McpServer::new(&root);
        server.run_stdio();
        return Ok(());
    }

    // ── TCP RPC server mode (default) ──
    let _log_guard = logging::init_logging(None);
    let listener = TcpListener::bind("127.0.0.1:9777").await?;
    info!("TCP server listening on 127.0.0.1:9777");

    loop {
        let (mut socket, addr) = listener.accept().await?;
        debug!(%addr, "client connected");

        let mut buf = vec![0u8; 4096];
        let n = socket.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);
        debug!(request_len = request.len(), "received request");

        let response = if request.starts_with("check:") {
    handle_check(request.trim())
} else if request.starts_with("thread") {
    handle_simple("thread", request.trim(), |g, _| thread_conflict_report(g, &[]))
} else if request.starts_with("blindspots") {
    handle_simple("blindspots", request.trim(), |g, _| {
        let c = coupling_report(g, "");
        let cycles = detect_cycles(g);
        let conflicts = thread_conflict_report(g, &[]);
        find_blindspots(c["L4"].as_u64().unwrap_or(0) as usize, cycles.len(), conflicts["conflict_count"].as_u64().unwrap_or(0) as usize)
    })
} else if request.starts_with("timeline") {
    handle_simple("timeline", request.trim(), |_g, a| {
        let path = std::path::Path::new(a);
        let store = TimelineStore::open(path).ok();
        json!(store.map(|s| s.query(50)).unwrap_or_default())
    })
} else if request.starts_with("analyze:") {
            let path = request.trim().strip_prefix("analyze:").unwrap_or(".").trim();
            handle_analyze(path)
        } else if request.starts_with("fragile:") {
            handle_simple("fragile:", request.trim(), |g, a| json!(fragile_nodes(g, a.parse().unwrap_or(10))))
        } else if request.starts_with("cycle") {
            handle_simple("cycle", request.trim(), |g, _| json!(detect_cycles(g)))
        } else if request.starts_with("coupling_report:") {
            handle_simple("coupling_report:", request.trim(), |g, a| coupling_report(g, a))
        } else if request.starts_with("graph_summary") {
            handle_simple("graph_summary", request.trim(), |g, _| graph_summary(g))
        } else if request.starts_with("community_report") {
            handle_simple("community_report", request.trim(), |g, _| {
                let communities = detect_communities(g, 42);
                json!(communities.iter().enumerate().map(|(i,c)| json!({"id":format!("comm_{}",i),"size":c.len(),"node_ids":c})).collect::<Vec<_>>())
            })
        } else if request.starts_with("community:") {
            handle_simple("community:", request.trim(), |g, a| {
                let communities = detect_communities(g, 42);
                let found = communities.iter().find(|c| c.contains(&a.to_string()));
                json!(found.map(|c| c.iter().take(50).collect::<Vec<_>>()))
            })
        } else if request.starts_with("diff:") {
            handle_simple("diff:", request.trim(), |g, _a| {
                let before = Graph::new(); // placeholder: load from file
                let d = g.diff(&before);
                json!({"added":d.added_nodes.len(),"removed":d.removed_nodes.len(),"modified":d.modified_nodes.len()})
            })
        } else if request.starts_with("history:") {
            handle_simple("history:", request.trim(), |g, a| {
                g.get_node(a).map(|n| json!({"id":n.id,"name":n.name,"type":n.kind.as_str(),"out_degree":n.out_degree,"in_degree":n.in_degree}))
                    .unwrap_or(json!({"error":"not found"}))
            })
        } else if request.starts_with("delayed") {
            handle_simple("delayed", request.trim(), |g, _| {
                let delayed: Vec<_> = g.edges.values().filter(|e| matches!(e.kind, EdgeKind::Triggers|EdgeKind::Awaits|EdgeKind::Sequences))
                    .map(|e| json!({"source":e.source,"target":e.target,"type":e.kind.as_str()}))
                    .collect();
                json!(delayed)
            })
        } else if request.starts_with("neighbors:") {
            handle_query(request.trim(), "neighbors:")
        } else if request.starts_with("path:") {
            handle_query(request.trim(), "path:")
        } else if request.starts_with("search:") {
            handle_query(request.trim(), "search:")
        } else if request.starts_with("impact:") {
            handle_query(request.trim(), "impact:")
        } else if request.contains("get_graph") {
            handle_get_graph()
        } else if request.contains("ping") {
            b"{\"ok\":true}".to_vec()
        } else {
            b"{\"error\":\"unknown command\"}".to_vec()
        };

        let framed = frame_response(&response);
        socket.write_all(&framed).await?;
        debug!(bytes = framed.len(), "response sent");
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

    // Post-processing: coupling depth + community detection
    let coupling_start = std::time::Instant::now();
    compute_coupling(&mut result.graph);
    info!(elapsed_secs = coupling_start.elapsed().as_secs_f64(), "coupling computation done");

    let comm_start = std::time::Instant::now();
    let communities = detect_communities(&result.graph, 42);

    // Cache for subsequent queries
    let graph_clone = result.graph.clone();
    if let Ok(mut cache) = mcp::CACHED_GRAPH.lock() {
        *cache = Some(graph_clone);
    }

    // Record timeline event
    if let Ok(store) = TimelineStore::open(&root) {
        store.record("analyze", None, &format!("全量分析完成：{} 节点, {} 边, {:.1}s", result.graph.node_count(), result.graph.edge_count(), result.elapsed_secs));
    }

    info!(count = communities.len(), elapsed_secs = comm_start.elapsed().as_secs_f64(), "communities detected");

    // Serialize full graph for Unity consumption
    let nodes: Vec<serde_json::Value> = result.graph.nodes.values().map(|n| {
        serde_json::json!({
            "id": n.id,
            "name": n.name,
            "type": n.kind.as_str(),
            "location": n.location
        })
    }).collect();

    let edges: Vec<serde_json::Value> = result.graph.edges.values().map(|e| {
        serde_json::json!({
            "source": e.source,
            "target": e.target,
            "type": e.kind.as_str(),
            "coupling_depth": e.coupling_depth
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

    // Save current graph as new baseline for next check
    let _ = std::fs::create_dir_all(&hologram_dir);
    if let Ok(json) = serde_json::to_string_pretty(after) {
        let _ = std::fs::write(&baseline_path, json);
    }

    // Record timeline event
    if let Ok(store) = TimelineStore::open(&root) {
        let passed = result["passed"].as_bool().unwrap_or(true);
        let violation_count = result["violation_count"].as_u64().unwrap_or(0);
        if passed {
            store.record("check_pass", None, &format!("简报通过（{} 违规）", violation_count));
        } else {
            store.record("check_fail", None, &format!("简报未通过：{} 条违规", violation_count));
        }
    }

    serde_json::to_vec(&result).unwrap_or_default()
}

fn handle_simple(prefix: &str, request: &str, f: fn(&Graph, &str) -> serde_json::Value) -> Vec<u8> {
    let arg = request.strip_prefix(prefix).unwrap_or("");
    let cache = mcp::CACHED_GRAPH.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(g) => serde_json::to_vec(&f(g, arg)).unwrap_or_default(),
        None => b"{\"error\":\"no graph loaded\"}".to_vec(),
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
    serde_json::to_vec(&serde_json::json!({
        "nodes": [
            {"id": "node_a", "name": "handle_request", "type": "function"},
            {"id": "node_b", "name": "UserModel", "type": "class"},
            {"id": "node_c", "name": "cache_get", "type": "function"}
        ],
        "edges": [
            {"id": "edge_1", "source": "node_a", "target": "node_b", "type": "calls", "coupling_depth": 2},
            {"id": "edge_2", "source": "node_b", "target": "node_c", "type": "calls", "coupling_depth": 1}
        ]
    }))
    .unwrap_or_default()
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
    fn test_handle_get_graph_returns_hardcoded_structure() {
        let response = handle_get_graph();
        let v: serde_json::Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(v["nodes"].as_array().unwrap().len(), 3);
        assert_eq!(v["edges"].as_array().unwrap().len(), 2);
        assert_eq!(v["nodes"][0]["id"], "node_a");
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
