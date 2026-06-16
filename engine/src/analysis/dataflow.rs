use crate::graph::Graph;
use crate::analysis::detect_cycles;
use serde_json::json;

/// Classify cycles from Tarjan SCC: pure_code, data_persistent, llm_involved
pub fn classify_cycles(graph: &Graph) -> serde_json::Value {
    let cycles = detect_cycles(graph);
    let mut pure = 0; let mut data = 0; let llm = 0;
    for c in &cycles {
        let node_ids: Vec<&str> = c["nodes"].as_array().map(|a|
            a.iter().filter_map(|v| v.as_str()).collect()
        ).unwrap_or_default();
        let has_medium = node_ids.iter().any(|id|
            graph.nodes.get(*id).map(|n| matches!(n.kind, crate::graph::NodeKind::Medium)).unwrap_or(false));
        let has_llm = node_ids.iter().any(|id|
            graph.nodes.get(*id).and_then(|n| n.properties.get("llm")).is_some());
        if has_medium || has_llm { data += 1; } else { pure += 1; }
    }
    json!({ "total": cycles.len(), "pure_code": pure, "data_persistent": data,
        "llm_involved": llm, "cycles": cycles })
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_classify_empty() {
        let g = Graph::new();
        let r = classify_cycles(&g);
        assert_eq!(r["total"], 0);
        assert_eq!(r["pure_code"], 0);
        assert_eq!(r["data_persistent"], 0);
    }

    #[test]
    fn test_classify_pure_code_cycle() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "a", EdgeKind::Calls));

        let r = classify_cycles(&g);
        assert_eq!(r["total"], 1);
        assert_eq!(r["pure_code"], 1);
        assert_eq!(r["data_persistent"], 0);
    }

    #[test]
    fn test_classify_data_cycle_with_medium() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("m", "db", NodeKind::Medium));
        g.add_edge(Edge::new("e1", "a", "m", EdgeKind::Writes));
        g.add_edge(Edge::new("e2", "m", "a", EdgeKind::Reads));

        let r = classify_cycles(&g);
        assert_eq!(r["total"], 1);
        assert_eq!(r["data_persistent"], 1);
        assert_eq!(r["pure_code"], 0);
    }
}
