use crate::graph::{EdgeKind, Graph, NodeKind};
use std::collections::HashMap;
use serde_json::json;

/// Simple thread/resource conflict detection using tree-sitter-level patterns.
/// v1: scans file content for threading patterns and builds conflict matrix.
pub fn thread_conflict_report(graph: &Graph, changed_files: &[String]) -> serde_json::Value {
    let mut threads: HashMap<String, Vec<String>> = HashMap::new(); // thread_name -> [shared_resources]
    let mut resources: HashMap<String, Vec<String>> = HashMap::new(); // resource -> [threads]

    // Scan node names for threading patterns
    for node in graph.nodes.values() {
        let name_lower = node.name.to_lowercase();
        // Detect thread-like names
        if name_lower.contains("thread") || name_lower.contains("worker") || name_lower.contains("async_task") {
            // Find resources this thread accesses
            let deps: Vec<String> = graph.edges.values()
                .filter(|e| e.source == node.id && matches!(e.kind, EdgeKind::Reads | EdgeKind::Writes | EdgeKind::Shares))
                .map(|e| e.target.clone()).collect();
            threads.entry(node.name.clone()).or_default().extend(deps);
        }
        // Detect shared resources (Medium nodes)
        if matches!(node.kind, NodeKind::Medium) {
            let accessors: Vec<String> = graph.edges.values()
                .filter(|e| e.target == node.id)
                .map(|e| e.source.clone()).collect();
            resources.entry(node.name.clone()).or_default().extend(accessors);
        }
    }

    // Build conflict matrix: resources accessed by >1 thread
    let mut conflicts = Vec::new();
    for (res, accessors) in &resources {
        if accessors.len() > 1 {
            conflicts.push(json!({
                "resource": res, "accessors": accessors,
                "risk": if accessors.len() > 3 { "high" } else { "medium" }
            }));
        }
    }

    json!({ "threads": threads.len(), "resources": resources.len(),
        "conflicts": conflicts, "conflict_count": conflicts.len() })
}
