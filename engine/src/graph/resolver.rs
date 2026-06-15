use std::collections::{HashMap, HashSet};

use super::{Edge, EdgeKind, Graph, Node, NodeKind};

/// Cross-file edge resolver.
/// After all files are parsed and merged, resolves edge targets by
/// matching short names against full node IDs.
pub struct CrossFileResolver;

impl CrossFileResolver {
    /// Resolve all cross-file edges in the graph.
    /// Returns count of resolved edges.
    pub fn resolve(graph: &mut Graph) -> usize {
        // Build name → set of node IDs index
        // "User" → ["app.models.User", "auth.models.User"]
        let mut name_index: HashMap<String, Vec<String>> = HashMap::new();
        for (id, node) in &graph.nodes {
            let short = short_name(&node.name);
            name_index.entry(short).or_default().push(id.clone());
        }

        let mut resolved = 0usize;
        let mut new_edges: Vec<Edge> = Vec::new();
        let mut to_remove: Vec<String> = Vec::new();

        for (eid, edge) in &graph.edges {
            // Try to resolve source if not in graph
            let src_id = if graph.nodes.contains_key(&edge.source) {
                Some(edge.source.clone())
            } else {
                resolve_name(&edge.source, &name_index, graph)
            };

            // Try to resolve target if not in graph
            let tgt_id = if graph.nodes.contains_key(&edge.target) {
                Some(edge.target.clone())
            } else {
                resolve_name(&edge.target, &name_index, graph)
            };

            if let (Some(s), Some(t)) = (src_id, tgt_id) {
                if s != edge.source || t != edge.target {
                    // Edge targets changed — create resolved version
                    let mut new_edge = edge.clone();
                    new_edge.id = format!("{}_resolved", edge.id);
                    new_edge.source = s;
                    new_edge.target = t;
                    new_edge.cross_file = true;
                    new_edges.push(new_edge);
                    to_remove.push(eid.clone());
                    resolved += 1;
                }
            }
        }

        // Remove old unresolved edges, add resolved ones
        for eid in &to_remove {
            graph.edges.remove(eid);
        }
        for edge in new_edges {
            if graph.nodes.contains_key(&edge.source) && graph.nodes.contains_key(&edge.target) {
                graph.add_edge(edge);
            }
        }

        // Cleanup: remove edges with non-existent endpoints
        let orphan_edges: Vec<String> = graph
            .edges
            .iter()
            .filter(|(_, e)| {
                !graph.nodes.contains_key(&e.source) || !graph.nodes.contains_key(&e.target)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for eid in &orphan_edges {
            graph.edges.remove(eid);
        }
        resolved += orphan_edges.len(); // count cleaned edges too

        resolved
    }
}

/// Get the short name from a full qualified name.
/// "django.http.response.HttpResponse" → "HttpResponse"
/// "app.views.index" → "index"
fn short_name(full: &str) -> String {
    full.rsplit('.').next().unwrap_or(full).to_string()
}

/// Try to resolve a name reference to an actual node ID.
fn resolve_name(
    name: &str,
    name_index: &HashMap<String, Vec<String>>,
    graph: &Graph,
) -> Option<String> {
    // Try exact match first
    if graph.nodes.contains_key(name) {
        return Some(name.to_string());
    }

    // Try short name match
    let short = short_name(name);
    if let Some(candidates) = name_index.get(&short) {
        if candidates.len() == 1 {
            return Some(candidates[0].clone());
        }
        // Multiple candidates — try best match by package prefix
        for candidate in candidates {
            // If the candidate contains part of the original name path
            if name.contains('.') && candidate.contains('.') {
                let name_parts: Vec<&str> = name.rsplit('.').collect();
                let cand_parts: Vec<&str> = candidate.rsplit('.').collect();
                // Match the last N parts
                let match_len = name_parts.len().min(cand_parts.len());
                if match_len >= 2
                    && name_parts[..match_len] == cand_parts[..match_len]
                {
                    return Some(candidate.clone());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{EdgeKind, NodeKind};

    #[test]
    fn test_short_name() {
        assert_eq!(short_name("django.http.HttpResponse"), "HttpResponse");
        assert_eq!(short_name("simple"), "simple");
        assert_eq!(short_name("a.b.c.d"), "d");
    }

    #[test]
    fn test_resolve_cross_file_imports() {
        let mut g = Graph::new();

        // File A: defines User
        let mut user = Node::new("models.User", "User", NodeKind::Symbol);
        user.location = Some("app/models.py".into());
        g.add_node(user);

        // File B: imports User, defines index
        let mut index = Node::new("views.index", "index", NodeKind::Symbol);
        index.location = Some("app/views.py".into());
        g.add_node(index);

        // Edge: index → "User" (short name, needs resolution)
        g.add_edge(Edge::new("e1", "views.index", "User", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1, "should resolve 1 edge");
        let e = g.get_edge("e1_resolved").unwrap();
        assert_eq!(e.target, "models.User");
    }
}
