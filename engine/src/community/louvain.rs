// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use leiden_rs::{GraphDataBuilder, Leiden, LeidenConfig};

use crate::graph::Graph;
use crate::storage::MemoryIndex;

/// A community = a set of node IDs.
pub type Community = Vec<String>;

/// A community with hierarchy metadata (level + parent).
/// Level 0 = base communities (leaf nodes).
/// Level 1 = super-communities (groups of Level 0).
/// Level N = groups of Level N-1 communities.
#[derive(Debug, Clone)]
pub struct HierarchicalCommunity {
    pub id: String,
    pub label: String,
    pub node_ids: Vec<String>,      // leaf graph node IDs (all levels)
    pub level: usize,               // 0 = base, 1 = super, …
    pub parent_id: Option<String>,  // community ID one level up, None if top
}

// ═══════════════════════════════════════════════════════════════
// GraphData builder helpers
// ═══════════════════════════════════════════════════════════════

/// Build a leiden-rs GraphData from our Graph.
/// Returns (GraphData, owned_node_ids) or None if graph is empty.
fn build_graph_data(graph: &Graph) -> Option<(leiden_rs::GraphData, Vec<String>)> {
    let mut node_ids: Vec<&String> = graph.nodes.keys().collect();
    node_ids.sort();
    let n = node_ids.len();
    if n == 0 { return None; }

    let id_to_idx: HashMap<&String, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();

    let mut builder = GraphDataBuilder::new(n);
    for edge in graph.edges.values() {
        if let (Some(&s), Some(&t)) = (id_to_idx.get(&edge.source), id_to_idx.get(&edge.target)) {
            // ponytail: undirected, add both directions (CSR stores both)
            let _ = builder.add_edge(s, t, 1.0);
        }
    }

    let data = builder.build().ok()?;
    let owned_ids: Vec<String> = node_ids.iter().map(|id| id.to_string()).collect();
    Some((data, owned_ids))
}

/// Build a leiden-rs GraphData from MemoryIndex edges.
fn build_graph_data_from_index(idx: &MemoryIndex) -> Option<(leiden_rs::GraphData, Vec<String>)> {
    let mut node_ids: Vec<String> = idx.nodes_iter().map(|n| n.id.clone()).collect();
    node_ids.sort();
    let n = node_ids.len();
    if n == 0 { return None; }

    let id_to_idx: HashMap<&str, usize> = node_ids.iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    let mut builder = GraphDataBuilder::new(n);
    for (source, targets) in idx.edges_iter() {
        if let Some(&si) = id_to_idx.get(source.as_str()) {
            for (target, _, _, _) in targets {
                if let Some(&ti) = id_to_idx.get(target.as_str()) {
                    let _ = builder.add_edge(si, ti, 1.0);
                }
            }
        }
    }

    let data = builder.build().ok()?;
    Some((data, node_ids))
}

/// Convert a leiden-rs Partition to our Community vec (sorted by size desc).
fn partition_to_communities(
    partition: &leiden_rs::Partition,
    node_count: usize,
    owned_ids: &[String],
) -> Vec<Community> {
    let num_comms = partition.num_communities();
    if num_comms == 0 || node_count == 0 { return vec![]; }

    let mut comm_nodes: Vec<Vec<usize>> = vec![Vec::new(); num_comms];
    for node_idx in 0..node_count {
        comm_nodes[partition.community_of(node_idx)].push(node_idx);
    }

    let mut result: Vec<Community> = comm_nodes.iter()
        .filter(|c| !c.is_empty())
        .map(|nodes| nodes.iter().map(|&idx| owned_ids[idx].clone()).collect())
        .collect();
    result.sort_by_key(|c| -(c.len() as i64));
    result
}

/// Build HierarchicalCommunity vec from leiden-rs HierarchicalOutput.
fn hier_output_to_communities(
    hier: &leiden_rs::HierarchicalOutput,
    owned_ids: &[String],
) -> Vec<HierarchicalCommunity> {
    let node_count = owned_ids.len();
    if hier.levels.is_empty() { return Vec::new(); }
    let mut result: Vec<HierarchicalCommunity> = Vec::new();

    // Build communities for each level
    for (level_idx, level) in hier.levels.iter().enumerate() {
        let mut comm_nodes: Vec<Vec<usize>> = vec![Vec::new(); level.num_communities];
        for n in 0..node_count {
            comm_nodes[level.membership[n]].push(n);
        }
        for (comm_id, nodes) in comm_nodes.iter().enumerate() {
            if nodes.is_empty() { continue; }
            let mut node_strs: Vec<String> = nodes.iter()
                .map(|&idx| owned_ids[idx].clone())
                .collect();
            node_strs.sort();
            result.push(HierarchicalCommunity {
                id: format!("l{}_comm_{}", level_idx, comm_id),
                label: format!("L{}·{}", level_idx, comm_id + 1),
                node_ids: node_strs,
                level: level_idx,
                parent_id: None,
            });
        }
    }

    // Back-link parent_id across adjacent levels
    // A community at level L is parent of a community at level L-1
    // if all nodes in the child map to the parent at level L.
    if hier.levels.len() >= 2 {
        for l in 0..(hier.levels.len() - 1) {
            let curr = &hier.levels[l];
            let next = &hier.levels[l + 1];
            let mut comm_to_parent: HashMap<(usize, usize), (usize, usize)> = HashMap::new();
            for n in 0..node_count {
                comm_to_parent.entry((l, curr.membership[n]))
                    .or_insert((l + 1, next.membership[n]));
            }
            for ((cl, cc), (pl, pc)) in comm_to_parent {
                let child_id = format!("l{}_comm_{}", cl, cc);
                let parent_id = format!("l{}_comm_{}", pl, pc);
                if let Some(child) = result.iter_mut().find(|c| c.id == child_id) {
                    child.parent_id = Some(parent_id);
                }
            }
        }
    }

    result
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/// Run Leiden community detection on the graph (flat, single-level).
/// Returns communities sorted by size (largest first).
pub fn detect_communities(graph: &Graph, seed: u64) -> Vec<Community> {
    let Some((data, owned_ids)) = build_graph_data(graph) else {
        return vec![];
    };

    let config = LeidenConfig::builder().seed(seed).build();
    let leiden = Leiden::new(config);
    let Ok(result) = leiden.run(&data) else {
        // Fallback: each node in its own community
        return owned_ids.into_iter().map(|id| vec![id]).collect();
    };

    let node_count = data.node_count();
    partition_to_communities(&result.partition, node_count, &owned_ids)
}

/// Run Leiden community detection from MemoryIndex (flat, single-level).
pub fn detect_communities_from_index(idx: &MemoryIndex, seed: u64) -> Vec<Community> {
    let Some((data, owned_ids)) = build_graph_data_from_index(idx) else {
        return vec![];
    };

    let config = LeidenConfig::builder().seed(seed).build();
    let leiden = Leiden::new(config);
    let Ok(result) = leiden.run(&data) else {
        return owned_ids.into_iter().map(|id| vec![id]).collect();
    };

    let node_count = data.node_count();
    partition_to_communities(&result.partition, node_count, &owned_ids)
}

/// Run both flat and hierarchical Leiden in one pass.
///
/// Returns (base_communities, hierarchical_communities).
/// `base_communities` is the Level 0 (finest) partition — same as
/// `detect_communities` would produce. `hierarchical_communities`
/// includes all levels with parent-child back-links.
pub fn detect_communities_and_hierarchy(
    graph: &Graph,
    seed: u64,
) -> (Vec<Community>, Vec<HierarchicalCommunity>) {
    let Some((data, owned_ids)) = build_graph_data(graph) else {
        return (vec![], vec![]);
    };

    let config = LeidenConfig::builder().seed(seed).build();
    let leiden = Leiden::new(config);
    let Ok(hier) = leiden.run_hierarchical(&data) else {
        let singles: Vec<Community> = owned_ids.iter().map(|id| vec![id.clone()]).collect();
        return (singles, vec![]);
    };

    let node_count = data.node_count();

    // L0 communities from first hierarchy level (guaranteed to exist if levels is non-empty)
    let base = if let Some(first) = hier.levels.first() {
        let mut comm_nodes: Vec<Vec<usize>> = vec![Vec::new(); first.num_communities];
        for n in 0..node_count {
            comm_nodes[first.membership[n]].push(n);
        }
        let mut result: Vec<Community> = comm_nodes.iter()
            .filter(|c| !c.is_empty())
            .map(|nodes| nodes.iter().map(|&idx| owned_ids[idx].clone()).collect())
            .collect();
        result.sort_by_key(|c| -(c.len() as i64));
        result
    } else {
        // ponytail: no levels = no edges to partition. Each node is its own community.
        let singles: Vec<Community> = owned_ids.iter().map(|id| vec![id.clone()]).collect();
        return (singles, vec![]);
    };

    let hierarchical = hier_output_to_communities(&hier, &owned_ids);
    (base, hierarchical)
}

/// Hierarchical Leiden community detection.
pub fn detect_hierarchical_communities(graph: &Graph, seed: u64) -> Vec<HierarchicalCommunity> {
    // ponytail: handle no-edges case — each node is its own level-0 community
    if graph.edges.is_empty() {
        let mut node_ids: Vec<String> = graph.nodes.keys().cloned().collect();
        node_ids.sort();
        return node_ids.iter().enumerate().map(|(i, id)| HierarchicalCommunity {
            id: format!("l0_comm_{}", i),
            label: format!("L0·{}", i + 1),
            node_ids: vec![id.clone()],
            level: 0,
            parent_id: None,
        }).collect();
    }
    let (_, hierarchical) = detect_communities_and_hierarchy(graph, seed);
    hierarchical
}

/// Hierarchical Leiden with pre-computed base communities.
/// The `base` parameter is ignored — Leiden handles everything internally.
/// Kept for backward-compat with existing callers.
pub fn detect_hierarchical_communities_with_base(
    graph: &Graph,
    _base: Vec<Community>,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    detect_hierarchical_communities(graph, seed)
}

/// Hierarchical Leiden from MemoryIndex.
pub fn detect_hierarchical_communities_from_index(
    idx: &MemoryIndex,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let Some((data, owned_ids)) = build_graph_data_from_index(idx) else {
        return vec![];
    };

    let config = LeidenConfig::builder().seed(seed).build();
    let leiden = Leiden::new(config);
    let Ok(hier) = leiden.run_hierarchical(&data) else {
        return vec![];
    };

    hier_output_to_communities(&hier, &owned_ids)
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

    /// Build a large sparse graph: many small communities, few cross-community edges.
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

        // Every referenced parent_id must exist
        let ids: std::collections::HashSet<&str> =
            hierarchical.iter().map(|c| c.id.as_str()).collect();
        for c in &hierarchical {
            if let Some(ref pid) = c.parent_id {
                assert!(ids.contains(pid.as_str()),
                    "parent '{}' of '{}' not found", pid, c.id);
            }
        }

        // Level 0 communities should cover all nodes exactly once
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

    /// Performance: large sparse graph must complete in < 500ms.
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

    /// Sparse graph with many singletons — still fast.
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
        // with_base should produce same result as direct call (Leiden
        // ignores the pre-computed base — it handles everything internally).
        let g = build_test_graph();
        let base = detect_communities(&g, 42);
        let direct = detect_hierarchical_communities(&g, 42);
        let with_base = detect_hierarchical_communities_with_base(&g, base, 42);

        // Same level count
        assert_eq!(direct.len(), with_base.len(),
            "with_base and direct should produce same community count");

        // Both cover all nodes at Level 0
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

        // Every parent_id must reference a real community
        let ids: std::collections::HashSet<&str> =
            result.iter().map(|c| c.id.as_str()).collect();
        for c in &result {
            if let Some(ref pid) = c.parent_id {
                assert!(ids.contains(pid.as_str()),
                    "parent '{}' of '{}' not found", pid, c.id);
            }
        }
    }

    // ── Detached hierarchy (was Phase 2 well-formed) ─────────────────

    #[test]
    fn test_hierarchical_phase2_well_formed() {
        // Hierarchical Leiden produces a well-formed hierarchy.
        // Deterministic with same seed.
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

        // Both should produce Level 0 that covers the same node count
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

        // Flat communities should match standalone detect_communities
        let standalone = detect_communities(&g, 42);
        assert_eq!(flat.len(), standalone.len(),
            "combined flat should match standalone detect_communities");

        // Hier should have Level 0 communities covering all nodes
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
