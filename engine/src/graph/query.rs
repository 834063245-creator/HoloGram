use std::collections::{HashMap, HashSet, VecDeque};
use crate::graph::{Graph, Node};

/// Neighbors of a node (outgoing edges → connected nodes, with edge info).
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

/// BFS shortest path between two nodes. Returns sequence of node IDs.
pub fn shortest_path(graph: &Graph, from: &str, to: &str) -> Option<Vec<String>> {
    let mut prev: HashMap<&str, &str> = HashMap::new();
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();

    visited.insert(from);
    queue.push_back(from);

    // Build adjacency
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

/// Search nodes by name substring. Returns matching node IDs.
pub fn search_nodes<'a>(graph: &'a Graph, query: &str) -> Vec<&'a Node> {
    let lower = query.to_lowercase();
    graph.nodes.values()
        .filter(|n| n.name.to_lowercase().contains(&lower) || n.id.to_lowercase().contains(&lower))
        .collect()
}

/// Impact analysis: BFS blast from a node, returning nodes by distance layer.
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
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b", "c", EdgeKind::Calls));
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
        assert_eq!(layers.len(), 3); // depth 0, 1, 2
    }
}
