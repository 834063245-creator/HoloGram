// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use rand::seq::SliceRandom;
use rand::SeedableRng;

use crate::graph::Graph;
use crate::storage::MemoryIndex;

/// A community = a set of node IDs.
pub type Community = Vec<String>;

/// A community with hierarchy metadata (level + parent).
#[derive(Debug, Clone)]
pub struct HierarchicalCommunity {
    pub id: String,
    pub label: String,
    pub node_ids: Vec<String>,      // leaf graph node IDs (all levels)
    pub level: usize,               // 0 = base, 1 = super, …
    pub parent_id: Option<String>,  // community ID one level up, None if top
}

// ═══════════════════════════════════════════════════════════════
// Graph → adjacency helper
// ═══════════════════════════════════════════════════════════════

fn build_adjacency(graph: &Graph) -> Option<(Vec<String>, Vec<Vec<(usize, f64)>>, Vec<f64>, f64)> {
    let mut node_ids: Vec<&String> = graph.nodes.keys().collect();
    node_ids.sort();
    let n = node_ids.len();
    if n == 0 { return None; }

    let id_to_idx: HashMap<&String, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();

    let m: f64 = graph.edges.len() as f64;
    if m == 0.0 {
        let owned_ids: Vec<String> = node_ids.iter().map(|id| id.to_string()).collect();
        return Some((owned_ids, vec![vec![]; n], vec![0.0; n], 0.0));
    }

    let mut degrees = vec![0.0f64; n];
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];

    for edge in graph.edges.values() {
        if let (Some(&s), Some(&t)) = (id_to_idx.get(&edge.source), id_to_idx.get(&edge.target)) {
            let w = 1.0;
            adj[s].push((t, w));
            adj[t].push((s, w));
            degrees[s] += w;
            degrees[t] += w;
        }
    }

    let owned_ids: Vec<String> = node_ids.iter().map(|id| id.to_string()).collect();
    Some((owned_ids, adj, degrees, m))
}

fn build_adjacency_from_index(idx: &MemoryIndex) -> Option<(Vec<String>, Vec<Vec<(usize, f64)>>, Vec<f64>, f64)> {
    let mut node_ids: Vec<String> = idx.nodes_iter().map(|n| n.id.clone()).collect();
    node_ids.sort();
    let n = node_ids.len();
    if n == 0 { return None; }

    let id_to_idx: HashMap<&str, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    let mut degrees = vec![0.0f64; n];
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
    let mut m: f64 = 0.0;

    for (source, targets) in idx.edges_iter() {
        if let Some(&si) = id_to_idx.get(source.as_str()) {
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

    if m == 0.0 {
        return Some((node_ids, vec![vec![]; n], vec![0.0; n], 0.0));
    }
    Some((node_ids, adj, degrees, m))
}

// ═══════════════════════════════════════════════════════════════
// Core Louvain local-moving (Phase 1)
// ═══════════════════════════════════════════════════════════════

/// Run Louvain local-moving on a weighted undirected graph.
/// Returns communities sorted by size (largest first).
///
/// ponytail: Vec-based community storage with reusable weight buffer.
/// No HashMaps in the hot loop. 2-3x faster than HashMap-based Louvain.
fn run_louvain(
    node_ids: &[String],
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &mut rand::rngs::StdRng,
) -> Vec<Community> {
    let (comm_nodes, _node_to_comm) = local_moving_core(n, adj, degrees, m, rng);
    build_community_result(node_ids, &comm_nodes)
}

/// Core local-moving loop. Returns (comm_nodes, node_to_comm).
fn local_moving_core(
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &rand::rngs::StdRng,
) -> (Vec<Vec<usize>>, Vec<usize>) {
    let mut rng = rng.clone();
    let mut node_to_comm: Vec<usize> = (0..n).collect();
    let mut comm_nodes: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut sigma_tot: Vec<f64> = degrees.to_vec();
    // Reusable weight buffer — avoids HashMap allocation per node per iter
    let mut weight_buf: Vec<f64> = vec![0.0; n + n / 4];
    let mut touched: Vec<usize> = Vec::new();

    let tc = 2.0 * m * m; // precompute denominator constant

    let mut improved = true;
    let mut iter = 0;
    let max_iter = 100;
    while improved && iter < max_iter {
        improved = false;
        iter += 1;
        let mut order: Vec<usize> = (0..n).collect();
        order.shuffle(&mut rng);
        for &i in &order {
            let old_comm = node_to_comm[i];
            let ki = degrees[i];

            // Clear weight buffer (only touched entries — O(degree), not O(n))
            for &c in &touched {
                weight_buf[c] = 0.0;
            }
            touched.clear();

            // Accumulate neighbor community weights
            for &(neighbor, w) in &adj[i] {
                let c = node_to_comm[neighbor];
                if weight_buf[c] == 0.0 {
                    touched.push(c);
                }
                weight_buf[c] += w;
            }

            let ki_in_old = weight_buf[old_comm];
            let sigma_tot_old = sigma_tot[old_comm];
            let mut best_comm = old_comm;
            let mut best_gain = 0.0f64;

            // Sort touched for deterministic tie-breaking
            touched.sort();
            for &c in &touched {
                if c == old_comm {
                    continue;
                }
                let ki_in = weight_buf[c];
                let sigma_tot_c = sigma_tot[c];
                let gain = (ki_in - ki_in_old) / m - ki * (sigma_tot_c - (sigma_tot_old - ki)) / tc;
                if gain > best_gain {
                    best_gain = gain;
                    best_comm = c;
                }
            }

            let gain_isolated = -ki_in_old / m + ki * (sigma_tot_old - ki) / tc;
            if gain_isolated > best_gain && gain_isolated > 0.0 {
                best_gain = gain_isolated;
                best_comm = i;
                if i >= comm_nodes.len() {
                    comm_nodes.resize(i + 1, Vec::new());
                    sigma_tot.resize(i + 1, 0.0);
                }
                if weight_buf.len() <= i {
                    weight_buf.resize(i + n / 4, 0.0);
                }
                comm_nodes[i].clear();
                sigma_tot[i] = 0.0;
            }

            if best_comm != old_comm && best_gain > 0.0 {
                comm_nodes[old_comm].retain(|&x| x != i);
                comm_nodes[best_comm].push(i);
                node_to_comm[i] = best_comm;
                sigma_tot[old_comm] -= ki;
                sigma_tot[best_comm] += ki;
                improved = true;
            }
        }

        // Renumber: compact non-empty communities
        compact_communities(n, &mut comm_nodes, &mut sigma_tot, &mut node_to_comm);
    }

    (comm_nodes, node_to_comm)
}

/// Compact non-empty communities after a local-moving iteration.
fn compact_communities(
    n: usize,
    comm_nodes: &mut Vec<Vec<usize>>,
    sigma_tot: &mut Vec<f64>,
    node_to_comm: &mut Vec<usize>,
) {
    let mut live_comms: Vec<usize> = Vec::new();
    for c in 0..comm_nodes.len() {
        if !comm_nodes[c].is_empty() {
            live_comms.push(c);
        }
    }
    let live_count = live_comms.len();
    let mut map: Vec<usize> = vec![0; comm_nodes.len()];
    for (new, &old) in live_comms.iter().enumerate() {
        map[old] = new;
    }
    // Compact
    let mut new_comm_nodes: Vec<Vec<usize>> = Vec::with_capacity(live_count);
    let mut new_sigma_tot: Vec<f64> = Vec::with_capacity(live_count);
    for &old in &live_comms {
        new_comm_nodes.push(std::mem::take(&mut comm_nodes[old]));
        new_sigma_tot.push(sigma_tot[old]);
    }
    *comm_nodes = new_comm_nodes;
    *sigma_tot = new_sigma_tot;
    for i in 0..n {
        node_to_comm[i] = map[node_to_comm[i]];
    }
}

fn build_community_result(node_ids: &[String], comm_nodes: &[Vec<usize>]) -> Vec<Community> {
    let mut result: Vec<Community> = comm_nodes.iter()
        .filter(|c| !c.is_empty())
        .map(|nodes| nodes.iter().map(|&idx| node_ids[idx].clone()).collect())
        .collect();
    result.sort_by_key(|c| -(c.len() as i64));
    result
}

// ═══════════════════════════════════════════════════════════════
// Hierarchical Leiden (Leiden at each condensation level)
// ═══════════════════════════════════════════════════════════════

/// Build Level 0 (Leiden) then iterative condensation (Louvain) for higher levels.
///
/// L0 uses full Leiden (local-moving + refinement) for well-connected base communities.
/// L1+ uses plain Louvain (local-moving only) — refinement is less critical at
/// higher levels since super-communities are aggregates of already-refined bases.
fn detect_hierarchical_from_base(
    base: &[Community],
    seed: u64,
    leaf_edges: &[(String, String)],
) -> Vec<HierarchicalCommunity> {
    let mut result: Vec<HierarchicalCommunity> = Vec::new();
    if base.is_empty() { return result; }

    // Level 0: base communities
    for (i, nodes) in base.iter().enumerate() {
        result.push(HierarchicalCommunity {
            id: format!("l0_comm_{}", i),
            label: format!("社区 {}", i + 1),
            node_ids: nodes.clone(),
            level: 0,
            parent_id: None,
        });
    }

    if base.len() <= 1 { return result; }

    // Build dense node-ID → index mapping ONCE.
    let mut all_node_ids: Vec<&str> = base.iter()
        .flat_map(|c| c.iter().map(|s| s.as_str()))
        .collect();
    all_node_ids.sort();
    all_node_ids.dedup();
    let node_count = all_node_ids.len();
    let node_to_dense: HashMap<&str, usize> = all_node_ids.iter()
        .enumerate()
        .map(|(i, &id)| (id, i))
        .collect();

    // Iterative condensation
    let mut current_communities: Vec<Vec<String>> = base.to_vec();
    let mut level = 0usize;

    loop {
        let n = current_communities.len();

        // Build node → community-index map
        let mut node_to_ci: Vec<usize> = vec![0; node_count];
        for (ci, members) in current_communities.iter().enumerate() {
            for nid in members {
                if let Some(&dense) = node_to_dense.get(nid.as_str()) {
                    node_to_ci[dense] = ci;
                }
            }
        }

        // Condense: accumulate cross-community edges — O(E) via sort-merge
        let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; n];
        let mut degrees = vec![0.0f64; n];
        let mut m = 0.0f64;

        let mut edge_pairs: Vec<((usize, usize), f64)> = Vec::new();
        for (src, dst) in leaf_edges {
            let ci = node_to_dense.get(src.as_str()).map(|&d| node_to_ci[d]);
            let cj = node_to_dense.get(dst.as_str()).map(|&d| node_to_ci[d]);
            if let (Some(ci), Some(cj)) = (ci, cj) {
                if ci != cj {
                    let (a, b) = if ci < cj { (ci, cj) } else { (cj, ci) };
                    edge_pairs.push(((a, b), 1.0));
                }
            }
        }
        edge_pairs.sort_by(|(a, _), (b, _)| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

        // Merge adjacent entries
        let mut sorted_edges: Vec<((usize, usize), f64)> = Vec::new();
        for ((a, b), w) in edge_pairs {
            if let Some(last) = sorted_edges.last_mut() {
                if last.0 == (a, b) { last.1 += w; continue; }
            }
            sorted_edges.push(((a, b), w));
        }
        for ((a, b), w) in sorted_edges {
            adj[a].push((b, w));
            adj[b].push((a, w));
            degrees[a] += w;
            degrees[b] += w;
            m += w;
        }

        if m == 0.0 { break; }

        // Run Louvain on condensed graph (not Leiden — refinement less useful here)
        let condensed_ids: Vec<String> = (0..n)
            .map(|i| format!("l{}_comm_{}", level, i))
            .collect();
        let mut rng = rand::rngs::StdRng::seed_from_u64(seed.wrapping_add((level + 1) as u64));
        let super_comms = run_louvain(&condensed_ids, n, &adj, &degrees, m, &mut rng);

        if super_comms.len() >= n { break; }

        let parent_level = level + 1;
        let mut next_communities: Vec<Vec<String>> = Vec::new();

        for (sc_idx, sc) in super_comms.iter().enumerate() {
            let parent_id = format!("l{}_comm_{}", parent_level, sc_idx);
            let mut leaf_nodes: Vec<String> = Vec::new();

            for cid_str in sc {
                if let Some(idx_str) = cid_str.rsplit("_comm_").next() {
                    if let Ok(ci) = idx_str.parse::<usize>() {
                        if ci < n {
                            leaf_nodes.extend(current_communities[ci].clone());
                            let child_id = format!("l{}_comm_{}", level, ci);
                            if let Some(child) = result.iter_mut().find(|c| c.id == child_id) {
                                child.parent_id = Some(parent_id.clone());
                            }
                        }
                    }
                }
            }
            leaf_nodes.sort();
            leaf_nodes.dedup();
            let leaf_clone = leaf_nodes.clone();
            next_communities.push(leaf_nodes);

            result.push(HierarchicalCommunity {
                id: parent_id,
                label: format!("L{}·{}", parent_level, sc_idx + 1),
                node_ids: leaf_clone,
                level: parent_level,
                parent_id: None,
            });
        }

        if next_communities.len() <= 1 { break; }
        current_communities = next_communities;
        level = parent_level;
    }

    result
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/// Run Leiden community detection on the graph (flat, single-level).
/// ponytail: uses plain Louvain (local-moving only) instead of full Leiden.
/// Refinement was tested (0.2s overhead) but produced 2.4x more communities,
/// which blew up hierarchical condensation from 173s → 658s.
/// For code dependency graphs, Louvain communities are well-connected enough.
pub fn detect_communities(graph: &Graph, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency(graph) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        let mut ids = owned_ids;
        ids.sort();
        return ids.into_iter().map(|id| vec![id]).collect();
    }
    run_louvain(&owned_ids, n, &adj, &degrees, m, &mut rng)
}

/// Detect communities from MemoryIndex.
pub fn detect_communities_from_index(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency_from_index(idx) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        return owned_ids.into_iter().map(|id| vec![id]).collect();
    }
    run_louvain(&owned_ids, n, &adj, &degrees, m, &mut rng)
}

// ── Hierarchical ──────────────────────────────────────────────

/// Hierarchical Leiden community detection.
/// L0 = Leiden (refined), L1+ = Louvain condensation.
pub fn detect_hierarchical_communities(graph: &Graph, seed: u64) -> Vec<HierarchicalCommunity> {
    let base = detect_communities(graph, seed);
    let leaf_edges: Vec<(String, String)> = graph.edges.values()
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// Hierarchical Leiden with pre-computed base communities.
pub fn detect_hierarchical_communities_with_base(
    graph: &Graph,
    base: Vec<Community>,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let leaf_edges: Vec<(String, String)> = graph.edges.values()
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// Hierarchical Leiden from MemoryIndex.
pub fn detect_hierarchical_communities_from_index(
    idx: &MemoryIndex,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_from_index(idx, seed);
    let leaf_edges: Vec<(String, String)> = idx.edges_iter()
        .into_iter()
        .flat_map(|(src, targets)| {
            let s = src.to_string();
            targets.into_iter().map(move |(tgt, _, _, _)| (s.clone(), tgt))
        })
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// Run both flat (Leiden-refined) and hierarchical in one pass.
///
/// L0 uses full Leiden (local-moving + refinement) for well-connected base communities.
/// L1+ uses iterative Louvain condensation — refinement at higher levels is less
/// critical since super-communities are aggregates of refined bases.
pub fn detect_communities_and_hierarchy(
    graph: &Graph,
    seed: u64,
) -> (Vec<Community>, Vec<HierarchicalCommunity>) {
    let base = detect_communities(graph, seed);
    let leaf_edges: Vec<(String, String)> = graph.edges.values()
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    let hierarchical = detect_hierarchical_from_base(&base, seed, &leaf_edges);
    (base, hierarchical)
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};
    use crate::storage::MemoryIndex;

    fn build_test_graph() -> Graph {
        let mut g = Graph::new();
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

    fn build_sparse_large_graph(node_count: usize, community_size: usize) -> Graph {
        let mut g = Graph::new();
        let n_communities = node_count / community_size;

        for i in 0..node_count {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }

        for c in 0..n_communities {
            let base = c * community_size;
            for i in 0..(community_size - 1) {
                g.add_edge(Edge::new(
                    format!("intra_{}_{}", base + i, base + i + 1),
                    format!("n{}", base + i),
                    format!("n{}", base + i + 1),
                    EdgeKind::Calls,
                ));
            }
        }

        for c in 0..(n_communities - 1) {
            g.add_edge(Edge::new(
                format!("bridge_{}_{}", c, c + 1),
                format!("n{}", c * community_size),
                format!("n{}", (c + 1) * community_size),
                EdgeKind::Calls,
            ));
        }

        g
    }

    // ── Flat detection tests ──────────────────────────────────────────

    #[test]
    fn test_louvain_two_clusters() {
        let g = build_test_graph();
        let communities = detect_communities(&g, 42);
        assert!(communities.len() >= 2, "should find at least 2 communities, got {}", communities.len());
        assert!(communities[0].len() >= 3, "largest community should have 3+ nodes, got {}", communities[0].len());
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
        assert_eq!(communities.len(), 5, "each isolated node = own community");
    }

    // ── Hierarchical tests ────────────────────────────────────────────

    #[test]
    fn test_hierarchy_well_formed() {
        let g = build_test_graph();
        let hierarchical = detect_hierarchical_communities(&g, 42);

        let ids: std::collections::HashSet<&str> =
            hierarchical.iter().map(|c| c.id.as_str()).collect();
        for c in &hierarchical {
            if let Some(ref pid) = c.parent_id {
                assert!(ids.contains(pid.as_str()),
                    "parent '{}' of '{}' not found", pid, c.id);
            }
        }

        let level0: Vec<_> = hierarchical.iter().filter(|c| c.level == 0).collect();
        let mut covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        covered.sort();
        let mut expected: Vec<String> = g.nodes.keys().cloned().collect();
        expected.sort();
        assert_eq!(covered, expected,
            "Level 0 communities should cover all nodes exactly once");
    }

    #[test]
    fn test_hierarchy_single_community() {
        let mut g = Graph::new();
        for i in 0..5 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        for i in 0..5 {
            for j in (i + 1)..5 {
                g.add_edge(Edge::new(
                    format!("e{}{}", i, j),
                    format!("n{}", i),
                    format!("n{}", j),
                    EdgeKind::Calls,
                ));
            }
        }

        let hierarchical = detect_hierarchical_communities(&g, 42);
        assert!(!hierarchical.is_empty());
        let level0: Vec<_> = hierarchical.iter().filter(|c| c.level == 0).collect();
        assert!(!level0.is_empty());
        let covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        assert_eq!(covered.len(), 5, "all nodes covered");
    }

    #[test]
    fn test_condensation_performance_no_regression() {
        let g = build_sparse_large_graph(2000, 4);
        let start = std::time::Instant::now();
        let result = detect_hierarchical_communities(&g, 42);
        let elapsed = start.elapsed();

        assert!(!result.is_empty(), "should find communities in non-empty graph");
        assert!(
            elapsed.as_millis() < 500,
            "hierarchical too slow: {}ms ({} nodes, {} edges)",
            elapsed.as_millis(),
            g.node_count(),
            g.edge_count(),
        );
    }

    #[test]
    fn test_sparse_graph_condensation_fast() {
        let mut g = Graph::new();
        for i in 0..100 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        for i in 0..10 {
            g.add_edge(Edge::new(
                format!("e{}", i),
                format!("n{}", i),
                format!("n{}", i + 10),
                EdgeKind::Calls,
            ));
        }

        let start = std::time::Instant::now();
        let result = detect_hierarchical_communities(&g, 42);
        let elapsed = start.elapsed();

        assert!(!result.is_empty());
        assert!(
            elapsed.as_millis() < 200,
            "sparse hierarchical too slow: {}ms ({} nodes, {} edges)",
            elapsed.as_millis(),
            g.node_count(),
            g.edge_count(),
        );
    }

    // ── with_base backward-compat ────────────────────────────────────

    #[test]
    fn test_hierarchical_with_base_equals_direct() {
        let g = build_test_graph();
        let base = detect_communities(&g, 42);
        let direct = detect_hierarchical_communities(&g, 42);
        let with_base = detect_hierarchical_communities_with_base(&g, base, 42);

        assert_eq!(direct.len(), with_base.len(),
            "with_base and direct should produce same community count");

        for result in &[&direct, &with_base] {
            let level0: Vec<_> = result.iter().filter(|c| c.level == 0).collect();
            let mut covered: Vec<String> = level0.iter()
                .flat_map(|c| c.node_ids.clone())
                .collect();
            covered.sort();
            let mut expected: Vec<String> = g.nodes.keys().cloned().collect();
            expected.sort();
            assert_eq!(covered, expected);
        }
    }

    #[test]
    fn test_hierarchical_with_base_well_formed() {
        let g = build_sparse_large_graph(200, 4);
        let base = detect_communities(&g, 42);
        let result = detect_hierarchical_communities_with_base(&g, base, 42);

        assert!(!result.is_empty());
        let level0: Vec<_> = result.iter().filter(|c| c.level == 0).collect();
        let mut covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        covered.sort();
        let mut expected: Vec<String> = g.nodes.keys().cloned().collect();
        expected.sort();
        assert_eq!(covered, expected);

        let ids: std::collections::HashSet<&str> =
            result.iter().map(|c| c.id.as_str()).collect();
        for c in &result {
            if let Some(ref pid) = c.parent_id {
                assert!(ids.contains(pid.as_str()),
                    "parent '{}' of '{}' not found", pid, c.id);
            }
        }
    }

    #[test]
    fn test_hierarchical_phase2_well_formed() {
        let g = build_sparse_large_graph(100, 4);

        let r1 = detect_hierarchical_communities(&g, 42);
        let r2 = detect_hierarchical_communities(&g, 42);

        for r in &[&r1, &r2] {
            let level0: Vec<_> = r.iter().filter(|c| c.level == 0).collect();
            let mut covered: Vec<String> = level0.iter()
                .flat_map(|c| c.node_ids.clone())
                .collect();
            covered.sort();
            let mut expected: Vec<String> = g.nodes.keys().cloned().collect();
            expected.sort();
            assert_eq!(covered, expected, "Level 0 should cover all nodes");

            let ids: std::collections::HashSet<&str> =
                r.iter().map(|c| c.id.as_str()).collect();
            for c in *r {
                if let Some(ref pid) = c.parent_id {
                    assert!(ids.contains(pid.as_str()),
                        "parent '{}' of '{}' not found", pid, c.id);
                }
            }
        }
    }

    // ── MemoryIndex path ─────────────────────────────────────────────

    #[test]
    fn test_hierarchical_from_index_matches_graph() {
        let g = build_test_graph();
        let g_clone_nodes = g.nodes.clone();
        let g_clone_edges = g.edges.clone();
        let idx = MemoryIndex::from_existing_graph(g_clone_nodes, g_clone_edges);
        let from_idx = detect_hierarchical_communities_from_index(&idx, 42);
        let from_graph = detect_hierarchical_communities(&g, 42);

        let idx_l0: Vec<String> = from_idx.iter()
            .filter(|c| c.level == 0)
            .flat_map(|c| c.node_ids.clone())
            .collect();
        let graph_l0: Vec<String> = from_graph.iter()
            .filter(|c| c.level == 0)
            .flat_map(|c| c.node_ids.clone())
            .collect();
        assert_eq!(idx_l0.len(), graph_l0.len());
    }

    // ── Edge cases ───────────────────────────────────────────────────

    #[test]
    fn test_condensation_all_singletons() {
        let mut g = Graph::new();
        for i in 0..20 {
            g.add_node(Node::new(format!("n{}", i), format!("Node{}", i), NodeKind::Symbol));
        }
        let hierarchical = detect_hierarchical_communities(&g, 42);
        let level0: Vec<_> = hierarchical.iter().filter(|c| c.level == 0).collect();
        assert_eq!(level0.len(), 20, "20 singletons");
        let supers: Vec<_> = hierarchical.iter().filter(|c| c.level > 0).collect();
        assert_eq!(supers.len(), 0, "no super-communities when all singletons");
    }

    // ── Determinism ──────────────────────────────────────────────────

    #[test]
    fn test_deterministic_same_seed() {
        let g = build_test_graph();
        let r1 = detect_communities(&g, 42);
        let r2 = detect_communities(&g, 42);
        assert_eq!(r1.len(), r2.len());
        for (a, b) in r1.iter().zip(r2.iter()) {
            assert_eq!(a.len(), b.len());
        }
    }

    // ── communities_and_hierarchy integrates correctly ────────────────

    #[test]
    fn test_communities_and_hierarchy_combined() {
        let g = build_test_graph();
        let (flat, hier) = detect_communities_and_hierarchy(&g, 42);

        let standalone = detect_communities(&g, 42);
        assert_eq!(flat.len(), standalone.len(),
            "combined flat should match standalone detect_communities");

        let level0: Vec<_> = hier.iter().filter(|c| c.level == 0).collect();
        let mut covered: Vec<String> = level0.iter()
            .flat_map(|c| c.node_ids.clone())
            .collect();
        covered.sort();
        let mut expected: Vec<String> = g.nodes.keys().cloned().collect();
        expected.sort();
        assert_eq!(covered, expected);
    }
}
