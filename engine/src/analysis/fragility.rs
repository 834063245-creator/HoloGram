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
