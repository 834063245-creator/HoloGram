use crate::graph::{Graph, NodeKind};
use std::collections::HashMap;

pub fn graph_summary(graph: &Graph) -> serde_json::Value {
    let mut sym=0; let mut med=0; let mut tmp=0;
    for n in graph.nodes.values() {
        match n.kind { NodeKind::Symbol=>{sym+=1} NodeKind::Medium=>{med+=1} NodeKind::Temporal=>{tmp+=1} }
    }
    let mut edge_types: HashMap<String, u32> = HashMap::new();
    for e in graph.edges.values() {
        *edge_types.entry(e.kind.as_str().to_string()).or_default() += 1;
    }
    serde_json::json!({
        "nodes_total": graph.nodes.len(), "edges_total": graph.edges.len(),
        "symbols": sym, "media": med, "temporals": tmp,
        "edge_types": edge_types
    })
}
