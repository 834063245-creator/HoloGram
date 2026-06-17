use crate::graph::Graph;
use crate::storage::MemoryIndex;

pub fn coupling_report(graph: &Graph, module: &str) -> serde_json::Value {
    let mut l1=0u32; let mut l2=0u32; let mut l3=0u32; let mut l4=0u32;
    for e in graph.edges.values() {
        if e.source == module || e.target == module {
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

pub fn coupling_report_from_index(idx: &MemoryIndex, module: &str) -> serde_json::Value {
    let mut l1=0u32; let mut l2=0u32; let mut l3=0u32; let mut l4=0u32;
    for (source, targets) in idx.edges_iter() {
        if source == module {
            for (_, _, depth, _) in targets {
                match depth { 1=>{l1+=1} 2=>{l2+=1} 3=>{l3+=1} 4=>{l4+=1} _=>{} }
            }
        }
        for (target, _, depth, _) in targets {
            if target == module {
                match depth { 1=>{l1+=1} 2=>{l2+=1} 3=>{l3+=1} 4=>{l4+=1} _=>{} }
            }
        }
    }
    let total = (l1+l2+l3+l4).max(1) as f64;
    serde_json::json!({
        "module": module, "total_edges": l1+l2+l3+l4,
        "L1": l1, "L2": l2, "L3": l3, "L4": l4,
        "fragility": format!("{:.1}", (l4 as f64*4.0 + l3 as f64*3.0) / total)
    })
}

#[cfg(test)]
mod tests {
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use super::*;

    #[test]
    fn test_coupling_empty_graph() {
        let g = Graph::new();
        let r = coupling_report(&g, "any");
        assert_eq!(r["total_edges"], 0);
        assert_eq!(r["L1"], 0);
        assert_eq!(r["L4"], 0);
    }

    #[test]
    fn test_coupling_all_levels() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "mod_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e1 = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e1.coupling_depth = 1;
        g.add_edge(e1);
        let mut e2 = Edge::new("e2", "a", "b", EdgeKind::Reads);
        e2.coupling_depth = 4;
        g.add_edge(e2);
        let r = coupling_report(&g, "a");
        assert_eq!(r["L1"], 1);
        assert_eq!(r["L4"], 1);
        assert_eq!(r["total_edges"], 2);
    }

    #[test]
    fn test_coupling_filters_by_module() {
        let mut g = Graph::new();
        g.add_node(Node::new("x", "mod_x", NodeKind::Symbol));
        g.add_node(Node::new("y", "mod_y", NodeKind::Symbol));
        let mut e = Edge::new("e1", "x", "y", EdgeKind::Calls);
        e.coupling_depth = 3;
        g.add_edge(e);
        let r = coupling_report(&g, "x");
        assert_eq!(r["L3"], 1);
        let r2 = coupling_report(&g, "z");
        assert_eq!(r2["total_edges"], 0);
    }

    #[test]
    fn test_coupling_target_match() {
        let mut g = Graph::new();
        g.add_node(Node::new("x", "mod_x", NodeKind::Symbol));
        g.add_node(Node::new("y", "mod_y", NodeKind::Symbol));
        let mut e = Edge::new("e1", "x", "y", EdgeKind::Calls);
        e.coupling_depth = 2;
        g.add_edge(e);
        let r = coupling_report(&g, "y");
        assert_eq!(r["L2"], 1);
    }

    #[test]
    fn test_coupling_from_index() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "mod_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "mod_b", NodeKind::Symbol));
        let mut e1 = Edge::new("e1", "a", "b", EdgeKind::Calls);
        e1.coupling_depth = 1;
        g.add_edge(e1);
        let mut e2 = Edge::new("e2", "a", "b", EdgeKind::Reads);
        e2.coupling_depth = 4;
        g.add_edge(e2);
        let idx = MemoryIndex::from_existing_graph(&g);
        let r = coupling_report_from_index(&idx, "a");
        assert_eq!(r["L1"], 1);
        assert_eq!(r["L4"], 1);
        assert_eq!(r["total_edges"], 2);
    }
}
