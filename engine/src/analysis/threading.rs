use crate::graph::{EdgeKind, Graph, NodeKind};
use std::collections::HashMap;
use serde_json::json;

/// Simple thread/resource conflict detection using tree-sitter-level patterns.
/// v1: scans file content for threading patterns and builds conflict matrix.
pub fn thread_conflict_report(graph: &Graph, _changed_files: &[String]) -> serde_json::Value {
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

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_thread_conflict_empty() {
        let g = Graph::new();
        let r = thread_conflict_report(&g, &[]);
        assert_eq!(r["threads"], 0);
        assert_eq!(r["resources"], 0);
        assert_eq!(r["conflict_count"], 0);
    }

    #[test]
    fn test_thread_detected_by_name() {
        let mut g = Graph::new();
        g.add_node(Node::new("t1", "worker_pool", NodeKind::Symbol));
        let r = thread_conflict_report(&g, &[]);
        assert_eq!(r["threads"], 1);
    }

    #[test]
    fn test_medium_detected_as_resource() {
        let mut g = Graph::new();
        g.add_node(Node::new("m1", "shared_cache", NodeKind::Medium));
        let r = thread_conflict_report(&g, &[]);
        assert_eq!(r["resources"], 1);
    }

    #[test]
    fn test_thread_resource_conflict() {
        let mut g = Graph::new();
        g.add_node(Node::new("t1", "thread_a", NodeKind::Symbol));
        g.add_node(Node::new("t2", "thread_b", NodeKind::Symbol));
        g.add_node(Node::new("m1", "shared_cache", NodeKind::Medium));
        // Both threads access the medium
        g.add_edge(Edge::new("e1", "t1", "m1", EdgeKind::Reads));
        g.add_edge(Edge::new("e2", "t2", "m1", EdgeKind::Reads));

        let r = thread_conflict_report(&g, &[]);
        assert_eq!(r["conflict_count"], 1);
    }

    #[test]
    fn test_no_conflict_single_accessor() {
        let mut g = Graph::new();
        g.add_node(Node::new("t1", "thread_a", NodeKind::Symbol));
        g.add_node(Node::new("m1", "shared_cache", NodeKind::Medium));
        g.add_edge(Edge::new("e1", "t1", "m1", EdgeKind::Reads));

        let r = thread_conflict_report(&g, &[]);
        assert_eq!(r["conflict_count"], 0);
    }
}
