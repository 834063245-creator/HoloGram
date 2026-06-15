use crate::graph::Graph;
use crate::analysis::detect_cycles;
use serde_json::json;

/// Classify cycles from Tarjan SCC: pure_code, data_persistent, llm_involved
pub fn classify_cycles(graph: &Graph) -> serde_json::Value {
    let cycles = detect_cycles(graph);
    let mut pure = 0; let mut data = 0; let mut llm = 0;
    for c in &cycles {
        let nodes = c["nodes"].as_array().map(|a| a.len()).unwrap_or(0);
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
