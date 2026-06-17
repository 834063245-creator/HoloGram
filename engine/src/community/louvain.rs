use std::collections::HashMap;
use rand::seq::SliceRandom;
use rand::SeedableRng;

use crate::graph::Graph;
use crate::storage::MemoryIndex;

/// A community = a set of node IDs.
pub type Community = Vec<String>;

/// Run Louvain community detection on the graph.
/// Returns communities sorted by size (largest first).
pub fn detect_communities(graph: &Graph, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);

    // ── Phase 1: build working structures ──
    let node_ids: Vec<&String> = graph.nodes.keys().collect();
    let n = node_ids.len();
    if n == 0 {
        return vec![];
    }

    // Map node ID → index
    let id_to_idx: HashMap<&String, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();

    // Total edge weight (each edge counts as 1)
    let m: f64 = graph.edges.len() as f64;
    if m == 0.0 {
        // No edges: each node its own community
        return graph
            .nodes
            .keys()
            .map(|id| vec![id.clone()])
            .collect();
    }

    // Node degrees (weighted sum of incident edges)
    let mut degrees = vec![0.0f64; n];
    // Adjacency: (neighbor_idx, weight) — build from our Graph edges
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];

    for edge in graph.edges.values() {
        let si = id_to_idx.get(&edge.source);
        let ti = id_to_idx.get(&edge.target);
        if let (Some(&s), Some(&t)) = (si, ti) {
            let w = 1.0; // unweighted
            adj[s].push((t, w));
            adj[t].push((s, w));
            degrees[s] += w;
            degrees[t] += w;
        }
    }

    // ── Phase 2: Louvain iterations ──
    let mut communities: Vec<usize> = (0..n).collect(); // node_idx → community_idx
    let mut community_nodes: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        community_nodes.entry(i).or_default().push(i);
    }

    let mut improved = true;
    let mut iter = 0;
    let max_iter = 100;

    while improved && iter < max_iter {
        improved = false;
        iter += 1;

        // Shuffle node order for deterministic randomness
        let mut order: Vec<usize> = (0..n).collect();
        order.shuffle(&mut rng);

        for &i in &order {
            let old_comm = communities[i];
            let ki = degrees[i];

            // Count edges to each neighbor community
            let mut comm_weights: HashMap<usize, f64> = HashMap::new();
            for &(neighbor, w) in &adj[i] {
                let c = communities[neighbor];
                *comm_weights.entry(c).or_default() += w;
            }

            // Also account for self-loop removal from old community
            let ki_in_old = comm_weights.get(&old_comm).copied().unwrap_or(0.0);

            // Compute modularity gain for moving to each candidate community
            let sigma_tot_old = community_total(&community_nodes, &degrees, old_comm);
            let mut best_comm = old_comm;
            let mut best_gain = 0.0f64;

            for (&c, &ki_in) in &comm_weights {
                if c == old_comm {
                    continue;
                }
                let sigma_tot_c = community_total(&community_nodes, &degrees, c);
                // Modularity gain formula (undirected, unweighted → simplified)
                let gain = (ki_in - ki_in_old) / m
                    - ki * (sigma_tot_c - (sigma_tot_old - ki)) / (2.0 * m * m);
                if gain > best_gain {
                    best_gain = gain;
                    best_comm = c;
                }
            }

            // Try removing from old community into a new singleton
            let gain_isolated = -ki_in_old / m
                + ki * (sigma_tot_old - ki) / (2.0 * m * m);
            if gain_isolated > best_gain && gain_isolated > 0.0 {
                best_gain = gain_isolated;
                best_comm = i; // new singleton community
            }

            // Move if beneficial
            if best_comm != old_comm && best_gain > 0.0 {
                // Remove from old
                community_nodes
                    .get_mut(&old_comm)
                    .unwrap()
                    .retain(|&x| x != i);
                if community_nodes.get(&old_comm).map_or(0, |v| v.len()) == 0 {
                    community_nodes.remove(&old_comm);
                }
                // Add to new
                community_nodes.entry(best_comm).or_default().push(i);
                communities[i] = best_comm;
                improved = true;
            }
        }

        // Renumber communities contiguously
        let mut new_comm_ids: HashMap<usize, usize> = HashMap::new();
        let mut next_id = 0;
        for &c in community_nodes.keys() {
            new_comm_ids.insert(c, next_id);
            next_id += 1;
        }
        let mut new_community_nodes: HashMap<usize, Vec<usize>> = HashMap::new();
        for (old_c, nodes) in &community_nodes {
            let new_c = new_comm_ids[old_c];
            new_community_nodes.insert(new_c, nodes.clone());
        }
        community_nodes = new_community_nodes;
        for i in 0..n {
            communities[i] = new_comm_ids[&communities[i]];
        }
    }

    // ── Phase 3: convert to output format ──
    // Pre-build idx → node_id lookup for O(1) deterministic access
    let idx_to_id: Vec<&str> = node_ids.iter().map(|id| id.as_str()).collect();
    let mut result: Vec<Vec<String>> = community_nodes
        .values()
        .map(|nodes| {
            nodes
                .iter()
                .map(|&idx| idx_to_id[idx].to_string())
                .collect()
        })
        .collect();

    // Sort largest first
    result.sort_by_key(|c| -(c.len() as i64));

    // Assign community_ids to graph nodes
    // (graph is immutable here, but we return the community data)

    result
}

/// Detect communities from MemoryIndex (same Louvain algorithm, MemoryIndex input).
pub fn detect_communities_from_index(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let node_ids: Vec<String> = idx.nodes_iter().map(|n| n.id.clone()).collect();
    let n = node_ids.len();
    if n == 0 { return vec![]; }
    let id_to_idx: HashMap<&str, usize> = node_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let mut degrees = vec![0.0f64; n];
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
    let mut m: f64 = 0.0;
    for (source, targets) in idx.edges_iter() {
        if let Some(&si) = id_to_idx.get(source) {
            for (target, _, _, _) in targets {
                if let Some(&ti) = id_to_idx.get(target.as_str()) {
                    let w = 1.0;
                    adj[si].push((ti, w));
                    adj[ti].push((si, w));
                    degrees[si] += w;
                    degrees[ti] += w;
                    m += w;
                }
            }
        }
    }
    if m == 0.0 { return node_ids.into_iter().map(|id| vec![id]).collect(); }
    run_louvain(&node_ids, n, &adj, &degrees, m, &mut rng)
}

fn run_louvain(
    node_ids: &[String],
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &mut rand::rngs::StdRng,
) -> Vec<Community> {
    let mut communities: Vec<usize> = (0..n).collect();
    let mut community_nodes: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n { community_nodes.entry(i).or_default().push(i); }
    let mut improved = true;
    let mut iter = 0;
    let max_iter = 100;
    while improved && iter < max_iter {
        improved = false; iter += 1;
        let mut order: Vec<usize> = (0..n).collect();
        order.shuffle(rng);
        for &i in &order {
            let old_comm = communities[i];
            let ki = degrees[i];
            let mut comm_weights: HashMap<usize, f64> = HashMap::new();
            for &(neighbor, w) in &adj[i] { *comm_weights.entry(communities[neighbor]).or_default() += w; }
            let ki_in_old = comm_weights.get(&old_comm).copied().unwrap_or(0.0);
            let sigma_tot_old = community_total(&community_nodes, degrees, old_comm);
            let mut best_comm = old_comm;
            let mut best_gain = 0.0f64;
            for (&c, &ki_in) in &comm_weights {
                if c == old_comm { continue; }
                let sigma_tot_c = community_total(&community_nodes, degrees, c);
                let gain = (ki_in - ki_in_old) / m - ki * (sigma_tot_c - (sigma_tot_old - ki)) / (2.0 * m * m);
                if gain > best_gain { best_gain = gain; best_comm = c; }
            }
            let gain_isolated = -ki_in_old / m + ki * (sigma_tot_old - ki) / (2.0 * m * m);
            if gain_isolated > best_gain && gain_isolated > 0.0 { best_gain = gain_isolated; best_comm = i; }
            if best_comm != old_comm && best_gain > 0.0 {
                community_nodes.get_mut(&old_comm).unwrap().retain(|&x| x != i);
                if community_nodes.get(&old_comm).map_or(0, |v| v.len()) == 0 { community_nodes.remove(&old_comm); }
                community_nodes.entry(best_comm).or_default().push(i);
                communities[i] = best_comm;
                improved = true;
            }
        }
        let mut new_comm_ids: HashMap<usize, usize> = HashMap::new();
        let mut next_id = 0;
        for &c in community_nodes.keys() { new_comm_ids.insert(c, next_id); next_id += 1; }
        let mut new_community_nodes: HashMap<usize, Vec<usize>> = HashMap::new();
        for (old_c, nodes) in &community_nodes { new_community_nodes.insert(new_comm_ids[old_c], nodes.clone()); }
        community_nodes = new_community_nodes;
        for i in 0..n { communities[i] = new_comm_ids[&communities[i]]; }
    }
    let mut result: Vec<Vec<String>> = community_nodes.values()
        .map(|nodes| nodes.iter().map(|&idx| node_ids[idx].clone()).collect())
        .collect();
    result.sort_by_key(|c| -(c.len() as i64));
    result
}

/// Total degree of nodes in a community.
fn community_total(
    community_nodes: &HashMap<usize, Vec<usize>>,
    degrees: &[f64],
    comm: usize,
) -> f64 {
    community_nodes
        .get(&comm)
        .map(|nodes| nodes.iter().map(|&i| degrees[i]).sum())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};

    fn build_test_graph() -> Graph {
        let mut g = Graph::new();
        // Two clear clusters connected by a bridge
        for i in 0..6 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        // Cluster 1: n0-n1-n2
        g.add_edge(Edge::new("e01", "n0", "n1", EdgeKind::Calls));
        g.add_edge(Edge::new("e12", "n1", "n2", EdgeKind::Calls));
        g.add_edge(Edge::new("e02", "n0", "n2", EdgeKind::Calls));
        // Cluster 2: n3-n4-n5
        g.add_edge(Edge::new("e34", "n3", "n4", EdgeKind::Calls));
        g.add_edge(Edge::new("e45", "n4", "n5", EdgeKind::Calls));
        g.add_edge(Edge::new("e35", "n3", "n5", EdgeKind::Calls));
        // Bridge
        g.add_edge(Edge::new("e23", "n2", "n3", EdgeKind::Calls));
        g
    }

    #[test]
    fn test_louvain_two_clusters() {
        let g = build_test_graph();
        let communities = detect_communities(&g, 42);
        assert!(communities.len() >= 2, "should find at least 2 communities");
        // Largest community should have 3 nodes
        assert!(communities[0].len() >= 3);
    }

    #[test]
    fn test_empty_graph() {
        let g = Graph::new();
        let communities = detect_communities(&g, 42);
        assert_eq!(communities.len(), 0);
    }

    #[test]
    fn test_no_edges() {
        let mut g = Graph::new();
        for i in 0..5 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        let communities = detect_communities(&g, 42);
        // Each node in its own community
        assert_eq!(communities.len(), 5);
    }
}
