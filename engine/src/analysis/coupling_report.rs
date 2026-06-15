use crate::graph::Graph;

pub fn coupling_report(graph: &Graph, module: &str) -> serde_json::Value {
    let mut l1=0u32; let mut l2=0u32; let mut l3=0u32; let mut l4=0u32;
    for e in graph.edges.values() {
        if e.source.contains(module) || e.target.contains(module) {
            match e.coupling_depth { 1=>{l1+=1} 2=>{l2+=1} 3=>{l3+=1} 4=>{l4+=1} _=>{} }
        }
    }
    let total = (l1+l2+l3+l4).max(1) as f64;
    serde_json::json!({
        "module": module, "total_edges": l1+l2+l3+l4,
        "L1": l1, "L2": l2, "L3": l3, "L4": l4,
        "fragility": format!("{:.1}", (l4 as f64*4.0 + l3 as f64*3.0) / total)
    })
}
