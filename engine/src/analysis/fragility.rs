use crate::graph::Graph;

pub fn fragile_nodes(graph: &Graph, limit: usize) -> Vec<serde_json::Value> {
    let mut scored: Vec<(f64, &str)> = graph.nodes.values().map(|n| {
        let fan = (n.out_degree + n.in_degree) as f64;
        let coupling_penalty = graph.edges.values()
            .filter(|e| e.source == n.id)
            .map(|e| e.coupling_depth as f64)
            .sum::<f64>() / fan.max(1.0);
        let score = fan * (1.0 + coupling_penalty);
        (score, n.id.as_str())
    }).collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored.iter().map(|(s, id)| serde_json::json!({
        "node_id": id, "fragility_score": format!("{:.1}", s)
    })).collect()
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_fragile_empty_graph() {
        let g = Graph::new();
        let result = fragile_nodes(&g, 5);
        assert!(result.is_empty());
    }

    #[test]
    fn test_fragile_single_node() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        let result = fragile_nodes(&g, 5);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["node_id"], "a");
    }

    #[test]
    fn test_fragile_truncates_to_limit() {
        let mut g = Graph::new();
        for i in 0..10 {
            let mut n = Node::new(format!("n{}", i), format!("fn_{}", i), NodeKind::Symbol);
            n.out_degree = (10 - i) as u32; // descending
            g.add_node(n);
        }
        let result = fragile_nodes(&g, 3);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_fragile_higher_coupling_scores_higher() {
        let mut g = Graph::new();
        // Node a: degree 10, L4 coupling → high score
        let mut a = Node::new("a", "high_coupling", NodeKind::Symbol);
        a.out_degree = 5;
        a.in_degree = 5;
        g.add_node(a);
        // Node b: degree 10, no coupling → lower score
        let mut b = Node::new("b", "low_coupling", NodeKind::Symbol);
        b.out_degree = 5;
        b.in_degree = 5;
        g.add_node(b);
        // Edge from a with high coupling
        let mut e = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e.coupling_depth = 4;
        g.add_edge(e);

        let result = fragile_nodes(&g, 2);
        assert_eq!(result[0]["node_id"], "a", "high coupling should rank first");
    }

    #[test]
    fn test_fragile_limit_zero() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        let result = fragile_nodes(&g, 0);
        assert!(result.is_empty());
    }

    #[test]
    fn test_fragile_limit_larger_than_graph() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        let result = fragile_nodes(&g, 100);
        assert_eq!(result.len(), 2);
    }
}
