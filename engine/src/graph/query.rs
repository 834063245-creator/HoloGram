// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Graph 查询函数 — O(E) 传统实现。
// 已弃用：新代码应使用 crate::storage::query 或直接使用 GraphStore。
// 这些函数保留是为了向后兼容传入 &Graph 的调用方。

use std::collections::{HashMap, HashSet, VecDeque};
use crate::graph::{Graph, Node};

/// 节点的邻居（出边 → 连接的节点，含边信息）。
/// 已弃用：请使用 storage::query::neighbors 或直接使用 MemoryIndex::neighbors()。
pub fn neighbors(graph: &Graph, node_id: &str, depth: usize) -> Vec<(String, String, u8)> {
    let mut result = Vec::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(node_id.to_string());
    queue.push_back((node_id.to_string(), 0u8));

    while let Some((current, cur_depth)) = queue.pop_front() {
        if cur_depth as usize >= depth { continue; }
        for edge in graph.edges.values() {
            let neighbor = if edge.source == current {
                Some(&edge.target)
            } else if edge.target == current {
                Some(&edge.source)
            } else {
                None
            };
            if let Some(nb) = neighbor {
                if visited.insert(nb.clone()) {
                    result.push((current.clone(), nb.clone(), edge.coupling_depth));
                    queue.push_back((nb.clone(), cur_depth + 1));
                }
            }
        }
    }
    result
}

/// BFS 最短路径：两个节点之间。
/// 已弃用：请使用 storage::query::shortest_path 或直接使用 MemoryIndex::shortest_path()。
pub fn shortest_path(graph: &Graph, from: &str, to: &str) -> Option<Vec<String>> {
    let mut prev: HashMap<&str, &str> = HashMap::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();

    visited.insert(from);
    queue.push_back(from);

    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in graph.edges.values() {
        adj.entry(&edge.source).or_default().push(&edge.target);
        adj.entry(&edge.target).or_default().push(&edge.source);
    }

    while let Some(cur) = queue.pop_front() {
        if cur == to { break; }
        if let Some(neighbors) = adj.get(cur) {
            for &nb in neighbors {
                if visited.insert(nb) {
                    prev.insert(nb, cur);
                    queue.push_back(nb);
                }
            }
        }
    }

    if !visited.contains(to) { return None; }

    let mut path = vec![to.to_string()];
    let mut cur = to;
    while let Some(&p) = prev.get(cur) {
        path.push(p.to_string());
        cur = p;
    }
    path.reverse();
    Some(path)
}

/// 按名称子串搜索节点。
/// 已弃用：请通过 tool_search 使用 FTS5 或使用 MemoryIndex::fts_search()。
pub fn search_nodes<'a>(graph: &'a Graph, query: &str) -> Vec<&'a Node> {
    let lower = query.to_lowercase();
    graph.nodes.values()
        .filter(|n| n.name.to_lowercase().contains(&lower) || n.id.to_lowercase().contains(&lower))
        .collect()
}

/// 影响分析：从节点出发的 BFS 扩散，按距离层返回节点。
/// 已弃用：请使用 storage::query::impact 或直接使用 MemoryIndex::impact()。
pub fn impact(graph: &Graph, node_id: &str, max_depth: usize) -> Vec<(usize, Vec<String>)> {
    let mut layers: Vec<(usize, Vec<String>)> = Vec::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(node_id.to_string());
    queue.push_back((node_id.to_string(), 0usize));

    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in graph.edges.values() {
        adj.entry(&edge.source).or_default().push(&edge.target);
        adj.entry(&edge.target).or_default().push(&edge.source);
    }

    while let Some((cur, depth)) = queue.pop_front() {
        if depth > max_depth { continue; }
        while layers.len() <= depth { layers.push((layers.len(), Vec::new())); }
        layers[depth].1.push(cur.clone());

        if let Some(neighbors) = adj.get(cur.as_str()) {
            for &nb in neighbors {
                if visited.insert(nb.to_string()) {
                    queue.push_back((nb.to_string(), depth + 1));
                }
            }
        }
    }
    layers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, EdgeKind, Node, NodeKind};

    fn test_graph() -> Graph {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeKind::Symbol));
        g.add_node(Node::new("b", "B", NodeKind::Symbol));
        g.add_node(Node::new("c", "C", NodeKind::Symbol));
        g.add_edge_unchecked(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge_unchecked(Edge::new("e2", "b", "c", EdgeKind::Calls));
        g
    }

    #[test]
    fn test_neighbors() {
        let g = test_graph();
        let nb = neighbors(&g, "b", 1);
        assert!(nb.iter().any(|(_, t, _)| t == "a" || t == "c"));
    }

    #[test]
    fn test_shortest_path() {
        let g = test_graph();
        let path = shortest_path(&g, "a", "c").unwrap();
        assert_eq!(path, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_search() {
        let g = test_graph();
        let results = search_nodes(&g, "B");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "b");
    }

    #[test]
    fn test_impact() {
        let g = test_graph();
        let layers = impact(&g, "a", 2);
        assert_eq!(layers.len(), 3);
    }
}
