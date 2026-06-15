use crate::graph::Graph;
use std::collections::HashMap;

pub fn detect_cycles(graph: &Graph) -> Vec<serde_json::Value> {
    let n = graph.nodes.len();
    if n == 0 { return vec![]; }
    let node_ids: Vec<&String> = graph.nodes.keys().collect();
    let id_to_idx: HashMap<&String, usize> = node_ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut adj = vec![vec![]; n];
    for e in graph.edges.values() {
        if let (Some(&s), Some(&t)) = (id_to_idx.get(&e.source), id_to_idx.get(&e.target)) {
            adj[s].push(t);
        }
    }
    // Tarjan SCC
    let mut index = 0u32;
    let mut idx = vec![u32::MAX; n];
    let mut lowlink = vec![0u32; n];
    let mut on_stack = vec![false; n];
    let mut stack = Vec::new();
    let mut sccs = Vec::new();
    fn strongconnect(v: usize, adj: &[Vec<usize>], idx: &mut [u32], lowlink: &mut [u32],
        on_stack: &mut [bool], stack: &mut Vec<usize>, index: &mut u32, sccs: &mut Vec<Vec<usize>>) {
        idx[v] = *index; lowlink[v] = *index; *index += 1;
        stack.push(v); on_stack[v] = true;
        for &w in &adj[v] {
            if idx[w] == u32::MAX { strongconnect(w, adj, idx, lowlink, on_stack, stack, index, sccs);
                lowlink[v] = lowlink[v].min(lowlink[w]);
            } else if on_stack[w] { lowlink[v] = lowlink[v].min(idx[w]); }
        }
        if lowlink[v] == idx[v] {
            let mut comp = Vec::new();
            loop { let w = stack.pop().unwrap(); on_stack[w] = false; comp.push(w); if w == v { break; } }
            sccs.push(comp);
        }
    }
    for v in 0..n { if idx[v] == u32::MAX { strongconnect(v, &adj, &mut idx, &mut lowlink, &mut on_stack, &mut stack, &mut index, &mut sccs); } }

    sccs.into_iter().filter(|c| c.len() > 1).map(|c| {
        let node_names: Vec<_> = c.iter().map(|&i| node_ids[i].clone()).collect();
        serde_json::json!({ "nodes": node_names, "size": c.len() })
    }).collect()
}
