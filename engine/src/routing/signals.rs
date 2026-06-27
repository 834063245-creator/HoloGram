// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::analysis::detect_cycles;
use crate::graph::Graph;
use crate::routing::patterns::PatternMatcher;
use serde_json::{json, Value};

fn count_l4_edges(graph: &Graph) -> usize {
    graph.edges.values().filter(|e| e.coupling_depth >= 4).count()
}

pub struct SignalGenerator {
    matcher: PatternMatcher,
}

impl SignalGenerator {
    pub fn new() -> Self { Self { matcher: PatternMatcher::new() } }

    /// Generate change signals by diffing `before` → `after`.
    /// L4/L2 only fire when coupling/cycles **increase** — not for static project state.
    pub fn generate(&self, before: &Graph, after: &Graph, changed_files: &[String],
        _coupling_l4_after: usize, cycle_count_after: usize) -> Vec<Value> {
        let mut signals = Vec::new();
        let l4_before = count_l4_edges(before);
        let l4_after = count_l4_edges(after);
        let cycles_before = detect_cycles(before).len();

        // L5 — irreversible (only when user actually changed these files)
        for f in changed_files {
            if self.matcher.is_migration_file(f) {
                signals.push(json!({"signal":{"description":"Migration file changed — may irreversibly alter data schema. Requires manual review.","file_path":f,"line":0,"level":5,"affected_nodes":[]},"level":5}));
            }
            if self.matcher.is_serialization_file(f) {
                signals.push(json!({"signal":{"description":"Serialization format changed — may break data interchange.","file_path":f,"line":0,"level":5,"affected_nodes":[]},"level":5}));
            }
            if self.matcher.is_config_file(f) {
                signals.push(json!({"signal":{"description":"Configuration file changed — may alter runtime behavior globally.","file_path":f,"line":0,"level":5,"affected_nodes":[]},"level":5}));
            }
        }

        // L4 — new deep coupling since last baseline
        if l4_after > l4_before {
            let delta = l4_after - l4_before;
            signals.push(json!({"signal":{"description":format!("{} new L4 deep coupling edge(s) since last check.", delta),"file_path":"","line":0,"level":4,"affected_nodes":[]},"level":4}));
        }

        // L3 — shared data
        for edge in after.edges.values() {
            if edge.coupling_depth >= 3 && changed_files.iter().any(|f|
                after.nodes.get(&edge.source).and_then(|n| n.location.as_deref()).unwrap_or("").contains(f)) {
                signals.push(json!({"signal":{"description":format!("{} -> {} writes shared data.", edge.source, edge.target),"file_path":"","line":0,"level":3,"affected_nodes":[edge.source.clone(), edge.target.clone()]},"level":3}));
            }
        }

        // L2 — new cycles since last baseline
        if cycle_count_after > cycles_before {
            let delta = cycle_count_after - cycles_before;
            signals.push(json!({"signal":{"description":format!("{} new circular dependency cycle(s) since last check.", delta),"file_path":"","line":0,"level":2,"affected_nodes":[]},"level":2}));
        }

        // L1 — documentation/test only (skip for v1)
        signals
    }
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};
    use super::*;

    #[test]
    fn test_signals_empty() {
        let gen = SignalGenerator::new();
        let g = Graph::new();
        let signals = gen.generate(&g, &g, &[], 0, 0);
        assert!(signals.is_empty());
    }

    #[test]
    fn test_signals_l5_migration() {
        let gen = SignalGenerator::new();
        let g = Graph::new();
        let signals = gen.generate(&g, &g, &["migrations/0001_init.py".into()], 0, 0);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 5);
    }

    #[test]
    fn test_signals_l5_config() {
        let gen = SignalGenerator::new();
        let g = Graph::new();
        let signals = gen.generate(&g, &g, &["config.yaml".into()], 0, 0);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 5);
    }

    #[test]
    fn test_signals_l4_coupling() {
        let gen = SignalGenerator::new();
        let before = Graph::new();
        let mut after = Graph::new();
        after.add_node(Node::new("a", "mod_a", NodeKind::Symbol));
        after.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e.coupling_depth = 4;
        after.add_edge(e);
        let signals = gen.generate(&before, &after, &["src/a.rs".into()], 1, 0);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 4);
    }

    #[test]
    fn test_signals_l2_cycles() {
        let gen = SignalGenerator::new();
        let before = Graph::new();
        let mut after = Graph::new();
        after.add_node(Node::new("a", "a", NodeKind::Symbol));
        after.add_node(Node::new("b", "b", NodeKind::Symbol));
        after.add_node(Node::new("c", "c", NodeKind::Symbol));
        after.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        after.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));
        after.add_edge(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let signals = gen.generate(&before, &after, &[], 0, 1);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 2);
    }

    #[test]
    fn test_signals_no_false_alarm_on_static_cycles() {
        let gen = SignalGenerator::new();
        let mut g = Graph::new();
        g.add_node(Node::new("a", "a", NodeKind::Symbol));
        g.add_node(Node::new("b", "b", NodeKind::Symbol));
        g.add_node(Node::new("c", "c", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));
        g.add_edge(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let signals = gen.generate(&g, &g, &[], 0, 1);
        assert!(signals.is_empty(), "same graph should not re-alert on existing cycles");
    }

    #[test]
    fn test_signals_l3_shared_data() {
        let gen = SignalGenerator::new();
        let mut g = Graph::new();
        let mut a = Node::new("a", "mod_a", NodeKind::Symbol);
        a.location = Some("src/handler.rs".into());
        g.add_node(a);
        g.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Writes);
        e.coupling_depth = 3;
        g.add_edge(e);

        let signals = gen.generate(&g, &g, &["src/handler.rs".into()], 0, 0);
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0]["level"], 3);
    }

    #[test]
    fn test_signals_multiple_levels() {
        let gen = SignalGenerator::new();
        let before = Graph::new();
        let mut after = Graph::new();
        after.add_node(Node::new("a", "a", NodeKind::Symbol));
        after.add_node(Node::new("b", "b", NodeKind::Symbol));
        after.add_node(Node::new("c", "c", NodeKind::Symbol));
        after.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        after.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));
        after.add_edge(Edge::new("e3", "c", "a", EdgeKind::Calls));
        let mut l4 = Edge::new("e4", "a", "b", EdgeKind::Calls);
        l4.coupling_depth = 4;
        after.add_edge(l4);
        let signals = gen.generate(&before, &after,
            &["migrations/init.py".into(), "config.toml".into()],
            1, 1);
        // L5: migration + config + serialization? config only = 1 config + 1 migration = 2, L4 delta 1, L2 delta 1
        assert!(signals.len() >= 3);
    }
}
