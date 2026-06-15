use crate::graph::Graph;
use crate::routing::patterns::PatternMatcher;
use serde_json::{json, Value};

pub struct SignalGenerator {
    matcher: PatternMatcher,
}

impl SignalGenerator {
    pub fn new() -> Self { Self { matcher: PatternMatcher::new() } }

    pub fn generate(&self, before: &Graph, after: &Graph, changed_files: &[String],
        coupling_l4_count: usize, cycle_count: usize) -> Vec<Value> {
        let mut signals = Vec::new();

        // L5 — irreversible
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

        // L4 — encapsulation / silent coupling
        if coupling_l4_count > 0 {
            signals.push(json!({"signal":{"description":format!("{} L4 deep coupling edges detected — encapsulation violations.", coupling_l4_count),"file_path":"","line":0,"level":4,"affected_nodes":[]},"level":4}));
        }

        // L3 — shared data
        for edge in after.edges.values() {
            if edge.coupling_depth >= 3 && changed_files.iter().any(|f|
                after.nodes.get(&edge.source).and_then(|n| n.location.as_deref()).unwrap_or("").contains(f)) {
                signals.push(json!({"signal":{"description":format!("{} -> {} writes shared data.", edge.source, edge.target),"file_path":"","line":0,"level":3,"affected_nodes":[edge.source.clone(), edge.target.clone()]},"level":3}));
            }
        }

        // L2 — blast radius
        if cycle_count > 0 {
            signals.push(json!({"signal":{"description":format!("{} cycles detected — circular dependencies found.", cycle_count),"file_path":"","line":0,"level":2,"affected_nodes":[]},"level":2}));
        }

        // L1 — documentation/test only (skip for v1)
        signals
    }
}
