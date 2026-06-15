use hologram_engine::analysis::{coupling::compute_coupling, fragile_nodes, detect_cycles, coupling_report, graph_summary,
    classify_cycles, thread_conflict_report, find_blindspots};
use hologram_engine::community::detect_communities;
use hologram_engine::graph::{CrossFileResolver, query, Graph, EdgeKind};
use hologram_engine::routing::preflight::run_full_check;
use hologram_engine::timeline::TimelineStore;
use hologram_engine::pipeline::runner::analyze_project;
use serde_json::{self, json};
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

static CACHED_GRAPH: std::sync::LazyLock<Mutex<Option<Graph>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:9777").await?;
    println!("[engine] listening on 127.0.0.1:9777");

    loop {
        let (mut socket, addr) = listener.accept().await?;
        println!("[engine] connected: {}", addr);

        let mut buf = vec![0u8; 4096];
        let n = socket.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);
        println!("[engine] received: {}", request.trim());

        let response = if request.starts_with("check:") {
    let path = request.trim().strip_prefix("check:").unwrap_or(".").trim();
    handle_check(path)
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
    handle_simple("timeline", request.trim(), |g, a| {
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
            handle_simple("diff:", request.trim(), |g, a| {
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

        // 4-byte LE length prefix + payload
        let len = response.len() as u32;
        let mut framed = Vec::with_capacity(4 + response.len());
        framed.extend_from_slice(&len.to_le_bytes());
        framed.extend_from_slice(&response);
        socket.write_all(&framed).await?;
        println!("[engine] sent {} bytes", framed.len());
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
    println!(
        "[engine] cross-file: {} edges resolved in {:.2}s",
        resolved,
        resolve_start.elapsed().as_secs_f64()
    );

    // Post-processing: coupling depth + community detection
    let coupling_start = std::time::Instant::now();
    compute_coupling(&mut result.graph);
    println!("[engine] coupling: {:.2}s", coupling_start.elapsed().as_secs_f64());

    let comm_start = std::time::Instant::now();
    let communities = detect_communities(&result.graph, 42);

    // Cache for subsequent queries
    let graph_clone = result.graph.clone();
    if let Ok(mut cache) = CACHED_GRAPH.lock() {
        *cache = Some(graph_clone);
    }
    println!(
        "[engine] communities: {} found in {:.2}s",
        communities.len(),
        comm_start.elapsed().as_secs_f64()
    );

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

fn handle_check(project_path: &str) -> Vec<u8> {
    // Auto-analyze if no cached graph
    {
        let cache = CACHED_GRAPH.lock().unwrap();
        if cache.is_none() {
            drop(cache);
            let root = PathBuf::from(project_path);
            if root.exists() {
                let mut result = analyze_project(&root);
                compute_coupling(&mut result.graph);
                let communities = detect_communities(&result.graph, 42);
                if let Ok(mut c) = CACHED_GRAPH.lock() { *c = Some(result.graph.clone()); }
            }
        }
    }

    let cache = CACHED_GRAPH.lock().unwrap();
    let after = match cache.as_ref() {
        Some(g) => g,
        None => return b"{\"error\":\"project not found\"}".to_vec(),
    };
    let before = after.clone();
    let changed_files: Vec<String> = vec![];
    let result = run_full_check(&before, after, &changed_files, project_path);
    serde_json::to_vec(&result).unwrap_or_default()
}

fn handle_simple(prefix: &str, request: &str, f: fn(&Graph, &str) -> serde_json::Value) -> Vec<u8> {
    let arg = request.strip_prefix(prefix).unwrap_or("");
    let cache = CACHED_GRAPH.lock().unwrap();
    match cache.as_ref() {
        Some(g) => serde_json::to_vec(&f(g, arg)).unwrap_or_default(),
        None => b"{\"error\":\"no graph loaded\"}".to_vec(),
    }
}

fn handle_query(request: &str, prefix: &str) -> Vec<u8> {
    let args = request.strip_prefix(prefix).unwrap_or("");
    let cache = CACHED_GRAPH.lock().unwrap();
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
