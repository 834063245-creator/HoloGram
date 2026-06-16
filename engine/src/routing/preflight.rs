use crate::analysis::{coupling_report, detect_cycles, thread_conflict_report};
use crate::community::louvain::detect_communities;
use crate::graph::{Graph, NodeKind};
use crate::routing::{constraints::{ConstraintConfig, check_constraints}, signals::SignalGenerator, summary::generate_summary};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

/// run_full_check — equivalent of Python preflight.py run_full_check()
pub fn run_full_check(before: &Graph, after: &Graph, changed_files: &[String], _project_root: &str) -> Value {
    let coupling = coupling_report(after, ""); // full graph
    let l4_count = coupling["L4"].as_u64().unwrap_or(0) as usize;
    let cycles = detect_cycles(after);
    let cycle_count = cycles.len();
    let signals = SignalGenerator::new().generate(before, after, changed_files, l4_count, cycle_count);
    let config = ConstraintConfig::defaults();
    let constraint_result = check_constraints(&signals, &config);
    let violations: Vec<Value> = constraint_result["violations"].as_array().cloned().unwrap_or_default();
    let summary = generate_summary(changed_files, &violations, l4_count, cycle_count);

    // ── blast_radius: BFS from all nodes whose file is in changed_files ──
    let blast_radius = if changed_files.is_empty() {
        0usize
    } else {
        let mut seed_nodes: HashSet<&str> = HashSet::new();
        for node in after.nodes.values() {
            if let Some(ref loc) = node.location {
                if changed_files.iter().any(|f| loc.starts_with(f.as_str()) || loc.contains(f.as_str())) {
                    seed_nodes.insert(node.id.as_str());
                }
            }
        }
        // BFS up to depth 3 from seed nodes
        let mut visited: HashSet<&str> = HashSet::new();
        let mut queue = VecDeque::new();
        for &sid in &seed_nodes {
            visited.insert(sid);
            queue.push_back((sid, 0usize));
        }
        // Build adjacency
        let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
        for edge in after.edges.values() {
            adj.entry(&edge.source).or_default().push(&edge.target);
            adj.entry(&edge.target).or_default().push(&edge.source);
        }
        while let Some((cur, depth)) = queue.pop_front() {
            if depth >= 3 { continue; }
            if let Some(nbs) = adj.get(cur) {
                for &nb in nbs {
                    if visited.insert(nb) {
                        queue.push_back((nb, depth + 1));
                    }
                }
            }
        }
        visited.len().saturating_sub(seed_nodes.len()) // exclude seeds themselves
    };

    // ── cross_community_edges: communities on after graph ──
    let communities = detect_communities(after, 42);
    let mut node_to_comm: HashMap<&str, usize> = HashMap::new();
    for (ci, comm) in communities.iter().enumerate() {
        for nid in comm {
            node_to_comm.insert(nid.as_str(), ci);
        }
    }
    let cross_community_edges = after.edges.values()
        .filter(|e| {
            let sc = node_to_comm.get(e.source.as_str());
            let tc = node_to_comm.get(e.target.as_str());
            sc != tc || sc.is_none()
        })
        .count();

    // ── thread_conflicts ──
    let thread_report = thread_conflict_report(after, changed_files);
    let new_thread_conflicts = thread_report["conflict_count"].as_u64().unwrap_or(0) as u32;

    // ── api_signature_changes: count function/method nodes changed ──
    let api_signature_changes = if before.nodes.is_empty() {
        0u32
    } else {
        let mut changed = 0u32;
        for (nid, after_node) in after.nodes.iter() {
            if !matches!(after_node.kind, NodeKind::Symbol) { continue; }
            if let Some(before_node) = before.nodes.get(nid) {
                // Count as changed if in/out degree differs
                if before_node.out_degree != after_node.out_degree
                    || before_node.in_degree != after_node.in_degree
                {
                    changed += 1;
                }
            } else {
                // New symbol node
                changed += 1;
            }
        }
        changed
    };

    json!({
        "passed": summary["passed"],
        "one_line": summary["one_line"],
        "timestamp": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "changed_files": changed_files,
        "total_changed_files": changed_files.len(),
        "l5_violations": violations.iter().filter(|v| v["level"]==5).collect::<Vec<_>>(),
        "l4_violations": violations.iter().filter(|v| v["level"]==4).collect::<Vec<_>>(),
        "l3_violations": violations.iter().filter(|v| v["level"]==3).collect::<Vec<_>>(),
        "l2_violations": violations.iter().filter(|v| v["level"]==2).collect::<Vec<_>>(),
        "passed_checks": Vec::<String>::new(),
        "blast_radius": blast_radius as u32,
        "cross_community_edges": cross_community_edges as u32,
        "new_cycles": cycle_count as u32,
        "new_thread_conflicts": new_thread_conflicts,
        "api_signature_changes": api_signature_changes,
        "coupling_l4": l4_count as u32,
        "cycles_detected": cycle_count as u32,
        "signals_count": signals.len() as u32,
        "violation_count": violations.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_preflight_empty_graphs() {
        let g = Graph::new();
        let r = run_full_check(&g, &g, &[], ".");
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["blast_radius"], 0);
        assert_eq!(r["violation_count"], 0);
    }

    #[test]
    fn test_preflight_no_changes() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));

        let r = run_full_check(&g, &g, &[], ".");
        assert!(r["passed"].as_bool().unwrap());
        assert_eq!(r["blast_radius"], 0);
    }

    #[test]
    fn test_preflight_detects_l5_on_migration() {
        let g = Graph::new();
        let r = run_full_check(&g, &g, &["migrations/0001_init.py".into()], ".");
        assert!(!r["passed"].as_bool().unwrap());
        assert!(r["violation_count"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_preflight_blast_radius_with_changes() {
        let mut g = Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/handler.rs".into());
        g.add_node(a);
        let mut b = Node::new("b", "mod_b", NodeKind::Symbol);
        b.location = Some("src/handler.rs".into());
        g.add_node(b);
        g.add_node(Node::new("c", "mod_c", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "c", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "c", "b", EdgeKind::Calls));

        let r = run_full_check(&g, &g, &["src/handler.rs".into()], ".");
        // BFS from a,b should include c within depth 3
        assert!(r["blast_radius"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_preflight_api_signature_changes() {
        let mut before = Graph::new();
        let mut a = Node::new("a", "fn_a", NodeKind::Symbol);
        a.out_degree = 1;
        before.add_node(a);

        let mut after = Graph::new();
        let mut a2 = Node::new("a", "fn_a", NodeKind::Symbol);
        a2.out_degree = 3; // changed
        after.add_node(a2);
        // New node
        let mut b = Node::new("b", "fn_b", NodeKind::Symbol);
        b.out_degree = 1;
        after.add_node(b);

        let r = run_full_check(&before, &after, &[], ".");
        assert_eq!(r["api_signature_changes"], 2, "a changed + b new = 2");
    }
}
