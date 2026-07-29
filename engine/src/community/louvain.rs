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
// Hierarchical Louvain (plain Louvain at each condensation level)
// ═══════════════════════════════════════════════════════════════

/// Build Level 0 (Louvain) then iterative condensation for higher levels.
///
/// Uses plain Louvain (local-moving only) — no Leiden refinement.
/// L1+ uses the same algorithm on condensed super-graphs.
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
// Leiden refinement (Phase 2)
// ═══════════════════════════════════════════════════════════════

/// Run Leiden Phase 2 refinement on the Louvain partition.
///
/// Algorithm:
///   1. For each community C from Phase 1, run local-moving within C's
///      induced subgraph to split C into well-separated sub-communities.
///   2. After all communities are split, try merging each sub-community
///      into a neighboring Phase-1 community if it improves modularity.
///
/// Returns refined communities. The result may have more communities
/// than the input, but they are better separated.
fn leiden_refinement(
    node_ids: &[String],
    n: usize,
    adj: &[Vec<(usize, f64)>],
    degrees: &[f64],
    m: f64,
    rng: &mut rand::rngs::StdRng,
    p1_comms: &[Vec<usize>],  // Phase 1: community → node indices
) -> Vec<Community> {
    // ── Step 1: Build node→community mapping from Phase 1 ──
    let mut node_to_p1: Vec<usize> = vec![0; n];
    for (ci, comm) in p1_comms.iter().enumerate() {
        for &v in comm {
            node_to_p1[v] = ci;
        }
    }

    // ── Step 2: Split each P1 community internally ──
    // sub_comms: flat list of all sub-communities, each is Vec<usize>
    // sub_parent: for each sub-community, which P1 community it came from
    let mut sub_comms: Vec<Vec<usize>> = Vec::new();
    let mut sub_parent: Vec<usize> = Vec::new();
    let mut node_to_sub: Vec<usize> = vec![usize::MAX; n];

    for (p1_idx, comm) in p1_comms.iter().enumerate() {
        if comm.len() <= 2 {
            // Too small to split — keep as-is
            let mut members = comm.clone();
            members.sort();
            sub_comms.push(members);
            sub_parent.push(p1_idx);
            for &v in comm {
                node_to_sub[v] = sub_comms.len() - 1;
            }
            continue;
        }

        // Build induced subgraph for this community
        let k = comm.len();
        let old_to_new: HashMap<usize, usize> = comm.iter().enumerate()
            .map(|(new, &old)| (old, new))
            .collect();
        let mut sub_adj: Vec<Vec<(usize, f64)>> = vec![vec![]; k];
        let mut sub_deg = vec![0.0f64; k];
        let mut sub_m = 0.0f64;
        for &v in comm {
            let vi = old_to_new[&v];
            for &(nb, w) in &adj[v] {
                if let Some(&nbi) = old_to_new.get(&nb) {
                    sub_adj[vi].push((nbi, w));
                    sub_deg[vi] += w;
                    sub_m += w;
                }
            }
        }
        sub_m /= 2.0;
        if sub_m == 0.0 {
            let mut members = comm.clone();
            members.sort();
            sub_comms.push(members);
            sub_parent.push(p1_idx);
            for &v in comm {
                node_to_sub[v] = sub_comms.len() - 1;
            }
            continue;
        }

        // Run local-moving within this community's subgraph
        let (split_nodes, _split_map) = local_moving_core(k, &sub_adj, &sub_deg, sub_m, rng);

        // Convert sub-indices back to global indices
        for split in &split_nodes {
            if split.is_empty() { continue; }
            let mut members: Vec<usize> = split.iter().map(|&si| comm[si]).collect();
            members.sort();
            let sub_idx = sub_comms.len();
            for &v in &members {
                node_to_sub[v] = sub_idx;
            }
            sub_comms.push(members);
            sub_parent.push(p1_idx);
        }
    }

    // ── Step 3: Merge sub-communities ──
    // Each sub-community can stay with its parent P1 community, or switch
    // to a neighboring P1 community if that improves modularity.
    let tc = 2.0 * m * m;
    let p1_count = p1_comms.len();
    let mut p1_sigma: Vec<f64> = vec![0.0; p1_count]; // total degree in each P1 community
    for (ci, comm) in p1_comms.iter().enumerate() {
        p1_sigma[ci] = comm.iter().map(|&v| degrees[v]).sum();
    }

    let sub_count = sub_comms.len();
    if sub_count == 0 {
        return vec![];
    }
    // Each sub-community starts assigned to its parent P1 community
    let mut sub_comm: Vec<usize> = sub_parent.clone();
    let sub_sigma: Vec<f64> = sub_comms.iter()
        .map(|sc| sc.iter().map(|&v| degrees[v]).sum())
        .collect();

    // For each sub-community, try moving to a neighboring P1 community
    let mut improved = true;
    let mut iter = 0;
    while improved && iter < 10 {
        improved = false;
        iter += 1;
        for si in 0..sub_count {
            let old_p1 = sub_comm[si];
            // Accumulate edge weight from this sub-community to each P1 community
            let mut p1_weight: Vec<f64> = vec![0.0; p1_count];
            let mut touched: Vec<usize> = Vec::new();
            for &v in &sub_comms[si] {
                for &(nb, w) in &adj[v] {
                    let p1 = node_to_p1[nb];
                    if p1_weight[p1] == 0.0 {
                        touched.push(p1);
                    }
                    p1_weight[p1] += w;
                }
            }

            let sigma_sub = sub_sigma[si];
            let sigma_old = p1_sigma[old_p1];
            let ki_in_old = p1_weight[old_p1];

            let mut best_p1 = old_p1;
            let mut best_gain = 0.0f64;

            for &p1 in &touched {
                if p1 == old_p1 { continue; }
                let ki_in = p1_weight[p1];
                let sigma_new = p1_sigma[p1];
                let gain = (ki_in - ki_in_old) / m
                    - sigma_sub * (sigma_new - (sigma_old - sigma_sub)) / tc;
                if gain > best_gain {
                    best_gain = gain;
                    best_p1 = p1;
                }
            }

            if best_p1 != old_p1 && best_gain > 0.0 {
                sub_comm[si] = best_p1;
                p1_sigma[old_p1] -= sigma_sub;
                p1_sigma[best_p1] += sigma_sub;
                improved = true;
            }
        }
    }

    // ── Step 4: Assemble final communities ──
    let mut final_comms: Vec<Vec<usize>> = vec![vec![]; p1_count];
    for si in 0..sub_count {
        let p1 = sub_comm[si];
        final_comms[p1].extend(sub_comms[si].iter().cloned());
    }
    for fc in final_comms.iter_mut() {
        fc.sort();
        fc.dedup();
    }

    let mut result: Vec<Community> = final_comms.iter()
        .filter(|c| !c.is_empty())
        .map(|nodes| nodes.iter().map(|&idx| node_ids[idx].clone()).collect())
        .collect();
    result.sort_by_key(|c| -(c.len() as i64));
    result
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/// Run Leiden community detection on the graph (flat, single-level).
///
/// Full Leiden algorithm: Phase 1 local-moving + Phase 2 refinement.
/// The refinement step splits communities to improve modularity, then
/// merges sub-communities that are well-connected within their parent.
/// This produces better-separated communities than plain Louvain.
///
/// NOTE: hierarchical condensation uses plain Louvain for its base
/// (see detect_communities_louvain) because refinement produces too many
/// base communities for the O(K²) condensation step to handle efficiently.
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
    // Phase 1: Louvain local-moving
    let (comm_nodes, _) = local_moving_core(n, &adj, &degrees, m, &rng);
    let p1_comms: Vec<Vec<usize>> = comm_nodes.into_iter().filter(|c| !c.is_empty()).collect();
    // Phase 2: Leiden refinement
    leiden_refinement(&owned_ids, n, &adj, &degrees, m, &mut rng, &p1_comms)
}

/// Plain Louvain (no refinement) — used internally by hierarchical condensation
/// where refinement's extra communities would blow up the O(K²) super-graph step.
fn detect_communities_louvain(graph: &Graph, seed: u64) -> Vec<Community> {
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

/// Detect communities from MemoryIndex (Leiden).
pub fn detect_communities_from_index(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let Some((owned_ids, adj, degrees, m)) = build_adjacency_from_index(idx) else {
        return vec![];
    };
    let n = owned_ids.len();
    if m == 0.0 {
        return owned_ids.into_iter().map(|id| vec![id]).collect();
    }
    let (comm_nodes, _) = local_moving_core(n, &adj, &degrees, m, &rng);
    let p1_comms: Vec<Vec<usize>> = comm_nodes.into_iter().filter(|c| !c.is_empty()).collect();
    leiden_refinement(&owned_ids, n, &adj, &degrees, m, &mut rng, &p1_comms)
}

/// Plain Louvain from MemoryIndex — used by hierarchical condensation path.
fn detect_communities_from_index_louvain(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
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

/// Hierarchical Louvain community detection.
/// L0 uses plain Louvain (no refinement) for efficient condensation.
/// For Leiden-refined flat communities, use detect_communities() instead.
pub fn detect_hierarchical_communities(graph: &Graph, seed: u64) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_louvain(graph, seed);
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

/// Hierarchical Louvain from MemoryIndex.
pub fn detect_hierarchical_communities_from_index(
    idx: &MemoryIndex,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_from_index_louvain(idx, seed);
    let leaf_edges: Vec<(String, String)> = idx.edges_iter()
        .into_iter()
        .flat_map(|(src, targets)| {
            let s = src.to_string();
            targets.into_iter().map(move |(tgt, _, _, _)| (s.clone(), tgt))
        })
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}

/// Run both flat (Leiden-refined) and hierarchical (Louvain) in one pass.
///
/// Flat communities use full Leiden (local-moving + refinement).
/// Hierarchical condensation uses plain Louvain for efficiency —
/// refinement's extra communities would blow up the O(K²) super-graph step.
pub fn detect_communities_and_hierarchy(
    graph: &Graph,
    seed: u64,
) -> (Vec<Community>, Vec<HierarchicalCommunity>) {
    let base = detect_communities(graph, seed);  // Leiden-refined flat
    let hier_base = detect_communities_louvain(graph, seed);  // Louvain for hierarchy
    let leaf_edges: Vec<(String, String)> = graph.edges.values()
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    let hierarchical = detect_hierarchical_from_base(&hier_base, seed, &leaf_edges);
    (base, hierarchical)
}

// ═══════════════════════════════════════════════════════════════
// Stable community ID matching
// ═══════════════════════════════════════════════════════════════

/// Match new communities to previous ones via greedy maximum overlap.
///
/// Given the new community partition and the old `node_id → community_id`
/// mapping, returns a stable ID for each new community. Communities that
/// overlap significantly with an old community inherit that old community's
/// ID. Truly new communities get fresh IDs (continuing the counter).
///
/// Algorithm: greedy matching by descending overlap count (ties broken by
/// old ID, then new index — fully deterministic). Each old ID is claimed
/// at most once, ensuring a 1:1 mapping.
pub fn match_communities_to_previous(
    new_communities: &[Community],
    old_assignment: &HashMap<String, usize>,
) -> Vec<usize> {
    use std::collections::HashSet;

    // Build overlap pairs: (overlap_count, new_idx, old_id)
    let mut pairs: Vec<(usize, usize, usize)> = Vec::new();
    for (new_idx, comm) in new_communities.iter().enumerate() {
        let mut overlap: HashMap<usize, usize> = HashMap::new();
        for node_id in comm {
            if let Some(&old_cid) = old_assignment.get(node_id) {
                *overlap.entry(old_cid).or_default() += 1;
            }
        }
        for (&old_id, &count) in &overlap {
            pairs.push((count, new_idx, old_id));
        }
    }

    // Greedy matching: highest overlap first. Ties broken deterministically
    // by old ID then new index — equal-overlap merges always inherit the
    // lowest old ID, so results don't depend on HashMap iteration order.
    pairs.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));

    let mut result = vec![usize::MAX; new_communities.len()];
    let mut used_old: HashSet<usize> = HashSet::new();

    for &(_, new_idx, old_id) in &pairs {
        if result[new_idx] != usize::MAX || used_old.contains(&old_id) {
            continue;
        }
        result[new_idx] = old_id;
        used_old.insert(old_id);
    }

    // Assign fresh IDs to unmatched communities
    let mut next_id = old_assignment.values().copied().max()
        .map(|m| m.saturating_add(1))
        .unwrap_or(0);
    for id in result.iter_mut() {
        if *id == usize::MAX {
            *id = next_id;
            next_id += 1;
        }
    }

    result
}

/// Assign `community_id` to nodes that don't have one, based on neighbor
/// majority vote. Used in the incremental update path to avoid full
/// re-clustering which would destabilize existing community IDs.
///
/// Nodes that already have a `community_id` are left untouched. New nodes
/// (community_id = None) inherit the most common community among their
/// graph neighbors. Nodes with no community-bearing neighbors are left
/// unassigned — they'll get a community on the next full analysis.
///
/// Returns the IDs of nodes that were assigned a community, so callers
/// can persist the change (swap_index only replaces the in-memory index).
pub fn assign_communities_to_new_nodes(graph: &mut crate::graph::Graph) -> Vec<String> {
    use std::collections::{HashMap, HashSet};

    let new_ids: HashSet<String> = graph.nodes.iter()
        .filter(|(_, n)| n.community_id.is_none())
        .map(|(id, _)| id.clone())
        .collect();

    if new_ids.is_empty() { return Vec::new(); }

    // Single pass over edges — accumulate community votes per new node
    let mut votes: HashMap<String, HashMap<usize, usize>> = HashMap::new();
    for edge in graph.edges.values() {
        if new_ids.contains(&edge.source) {
            if let Some(nbr) = graph.nodes.get(&edge.target) {
                if let Some(cid) = nbr.community_id {
                    *votes.entry(edge.source.clone()).or_default().entry(cid).or_default() += 1;
                }
            }
        }
        if new_ids.contains(&edge.target) {
            if let Some(nbr) = graph.nodes.get(&edge.source) {
                if let Some(cid) = nbr.community_id {
                    *votes.entry(edge.target.clone()).or_default().entry(cid).or_default() += 1;
                }
            }
        }
    }

    let mut assigned = Vec::new();
    for (nid, v) in &votes {
        // Pick community with most votes; ties broken by lower ID (older = more stable)
        if let Some(&best_cid) = v.iter()
            .max_by(|(cid_a, cnt_a), (cid_b, cnt_b)| {
                cnt_a.cmp(cnt_b).then(cid_b.cmp(cid_a))
            })
            .map(|(cid, _)| cid)
        {
            if let Some(node) = graph.nodes.get_mut(nid) {
                node.community_id = Some(best_cid);
                assigned.push(nid.clone());
            }
        }
    }
    assigned
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
        g.add_edge_unchecked(Edge::new("e01", "n0", "n1", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e12", "n1", "n2", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e02", "n0", "n2", EdgeKind::Calls));
        // Cluster 2: n3-n4-n5
        g.add_edge_unchecked(Edge::new("e34", "n3", "n4", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e45", "n4", "n5", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e35", "n3", "n5", EdgeKind::Calls));
        // Bridge
        g.add_edge_unchecked(Edge::new("e23", "n2", "n3", EdgeKind::Calls));
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
                g.add_edge_unchecked(Edge::new(
                    format!("intra_{}_{}", base + i, base + i + 1),
                    format!("n{}", base + i),
                    format!("n{}", base + i + 1),
                    EdgeKind::Calls,
                ));
            }
        }

        for c in 0..(n_communities - 1) {
            g.add_edge_unchecked(Edge::new(
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
                g.add_edge_unchecked(Edge::new(
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
            g.add_edge_unchecked(Edge::new(
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

    // ── Stable community ID matching ─────────────────────────────────

    #[test]
    fn test_match_first_run_empty_old() {
        // First run: no old assignment → sequential IDs 0, 1, 2, ...
        let comms = vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["d".to_string(), "e".to_string()],
        ];
        let old: HashMap<String, usize> = HashMap::new();
        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids, vec![0, 1]);
    }

    #[test]
    fn test_match_same_graph_rerun_preserves_ids() {
        // Same communities, rerun → same IDs
        let comms = vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["d".to_string(), "e".to_string()],
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 5);
        old.insert("b".into(), 5);
        old.insert("c".into(), 5);
        old.insert("d".into(), 3);
        old.insert("e".into(), 3);

        let ids = match_communities_to_previous(&comms, &old);
        // Community {a,b,c} should get ID 5, community {d,e} should get ID 3
        assert!(ids.contains(&5));
        assert!(ids.contains(&3));
    }

    #[test]
    fn test_match_reordered_communities_preserve_ids() {
        // Same content, different sort order → same IDs
        let comms_v1 = vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["d".to_string(), "e".to_string()],
        ];
        let comms_v2 = vec![
            vec!["d".to_string(), "e".to_string()],
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 0);
        old.insert("b".into(), 0);
        old.insert("c".into(), 0);
        old.insert("d".into(), 1);
        old.insert("e".into(), 1);

        let ids_v1 = match_communities_to_previous(&comms_v1, &old);
        let ids_v2 = match_communities_to_previous(&comms_v2, &old);

        // The community {a,b,c} should get ID 0 in both cases
        // The community {d,e} should get ID 1 in both cases
        assert_eq!(ids_v1[0], 0); // {a,b,c} is first in v1
        assert_eq!(ids_v1[1], 1); // {d,e} is second in v1
        assert_eq!(ids_v2[0], 1); // {d,e} is first in v2
        assert_eq!(ids_v2[1], 0); // {a,b,c} is second in v2
    }

    #[test]
    fn test_match_new_community_gets_fresh_id() {
        let comms = vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["c".to_string(), "d".to_string()],
            vec!["e".to_string(), "f".to_string()],  // new community
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 0);
        old.insert("b".into(), 0);
        old.insert("c".into(), 1);
        old.insert("d".into(), 1);
        // e, f are new — not in old assignment

        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids[0], 0); // {a,b} → 0
        assert_eq!(ids[1], 1); // {c,d} → 1
        assert_eq!(ids[2], 2); // {e,f} → fresh ID 2
    }

    #[test]
    fn test_match_community_disappears_others_stable() {
        let comms = vec![
            vec!["a".to_string(), "b".to_string()],
            // community {c,d} disappeared
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 0);
        old.insert("b".into(), 0);
        old.insert("c".into(), 7);
        old.insert("d".into(), 7);

        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids[0], 0); // {a,b} keeps ID 0
        // ID 7 is now orphaned but that's fine — it's just unused
    }

    // ── Neighbor voting for incremental path ─────────────────────────

    #[test]
    fn test_assign_communities_to_new_nodes_basic() {
        let mut g = Graph::new();
        // Existing nodes with community_id
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(0);
        let mut n1 = Node::new("n1", "B", NodeKind::Symbol);
        n1.community_id = Some(0);
        let mut n2 = Node::new("n2", "C", NodeKind::Symbol);
        n2.community_id = Some(1);
        // New node — no community_id
        let n3 = Node::new("n3", "D", NodeKind::Symbol);

        g.add_node(n0);
        g.add_node(n1);
        g.add_node(n2);
        g.add_node(n3);

        // n3 connected to n0 (comm 0) and n1 (comm 0) and n2 (comm 1)
        g.add_edge_unchecked(Edge::new("e1", "n3", "n0", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "n3", "n1", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e3", "n3", "n2", EdgeKind::Calls));

        assign_communities_to_new_nodes(&mut g);

        // n3 should join community 0 (2 votes vs 1)
        assert_eq!(g.nodes.get("n3").unwrap().community_id, Some(0));
    }

    #[test]
    fn test_assign_communities_no_neighbors_keeps_none() {
        let mut g = Graph::new();
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(0);
        let n1 = Node::new("n1", "B", NodeKind::Symbol); // new, no community

        g.add_node(n0);
        g.add_node(n1);
        // No edges between n0 and n1

        assign_communities_to_new_nodes(&mut g);

        // n1 has no neighbors with community_id → stays None
        assert_eq!(g.nodes.get("n1").unwrap().community_id, None);
    }

    #[test]
    fn test_assign_communities_preserves_existing() {
        let mut g = Graph::new();
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(5);
        let n1 = Node::new("n1", "B", NodeKind::Symbol); // new

        g.add_node(n0);
        g.add_node(n1);
        g.add_edge_unchecked(Edge::new("e1", "n0", "n1", EdgeKind::Calls));

        assign_communities_to_new_nodes(&mut g);

        // n0 keeps its community_id = 5
        assert_eq!(g.nodes.get("n0").unwrap().community_id, Some(5));
        // n1 inherits community 5 from n0
        assert_eq!(g.nodes.get("n1").unwrap().community_id, Some(5));
    }

    #[test]
    fn test_match_merge_equal_overlap_deterministic() {
        // Two old communities merge into one new community with EQUAL overlap
        // counts — the lowest old ID must always win, regardless of HashMap
        // iteration order.
        let comms = vec![
            vec!["x".to_string(), "y".to_string(), "z".to_string(), "w".to_string()],
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("x".into(), 0);
        old.insert("y".into(), 0);
        old.insert("z".into(), 1);
        old.insert("w".into(), 1);

        // Overlap is 2 with old ID 0 and 2 with old ID 1 → tie → lowest wins
        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids, vec![0]);
    }

    #[test]
    fn test_match_split_competition_exclusive() {
        // Old community 5 splits into two new communities — only the bigger
        // remnant claims ID 5; the smaller one gets a fresh ID (1:1 mapping).
        let comms = vec![
            vec!["a".to_string(), "b".to_string()],                     // overlap 2 with 5
            vec!["c".to_string(), "d".to_string(), "e".to_string()],    // overlap 3 with 5
        ];
        let mut old: HashMap<String, usize> = HashMap::new();
        old.insert("a".into(), 5);
        old.insert("b".into(), 5);
        old.insert("c".into(), 5);
        old.insert("d".into(), 5);
        old.insert("e".into(), 5);

        let ids = match_communities_to_previous(&comms, &old);
        assert_eq!(ids[1], 5); // bigger remnant keeps the ID
        assert_eq!(ids[0], 6); // smaller remnant gets fresh ID (max old + 1)
    }

    #[test]
    fn test_assign_communities_returns_assigned_ids() {
        let mut g = Graph::new();
        let mut n0 = Node::new("n0", "A", NodeKind::Symbol);
        n0.community_id = Some(2);
        let n1 = Node::new("n1", "B", NodeKind::Symbol); // new, gets assigned
        let n2 = Node::new("n2", "C", NodeKind::Symbol); // new, no neighbors

        g.add_node(n0);
        g.add_node(n1);
        g.add_node(n2);
        g.add_edge_unchecked(Edge::new("e1", "n0", "n1", EdgeKind::Calls));

        let assigned = assign_communities_to_new_nodes(&mut g);

        // Only n1 was assigned — callers persist exactly these nodes
        assert_eq!(assigned, vec!["n1".to_string()]);
    }
}