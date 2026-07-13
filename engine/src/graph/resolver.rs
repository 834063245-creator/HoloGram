// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;

use super::{Edge, Graph};

/// Common source-code file extensions (lowercase).
/// Used to distinguish file-extension segments from symbol-name segments
/// when building short-name and stem indexes.
const CODE_EXTENSIONS: &[&str] = &[
    "rs", "py", "pyi", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
    "go", "java", "kt", "kts", "cs", "cpp", "hpp", "cc", "hh", "cxx", "hxx",
    "c", "h", "php", "rb", "swift", "dart", "lua", "zig", "r", "scala",
    "ex", "exs", "erl", "hrl", "hs", "ml", "mli", "svelte", "vue", "css",
    "scss", "less", "html", "htm", "xml", "json", "yaml", "yml", "toml",
    "md", "txt", "sql", "sh", "bash", "ps1", "bat", "cmake", "make",
];

fn is_common_extension(s: &str) -> bool {
    CODE_EXTENSIONS.contains(&s)
}

/// Extract the file stem: filename without extension.
///
/// Examples:
///   "a.rs"        → "a"
///   "app/models.py" → "models"
///   "foo.bar.baz.ts" → "baz"
///   "django.http.HttpResponse" → "HttpResponse"  (last segment not an extension)
fn file_stem(name: &str) -> String {
    let parts: Vec<&str> = name.rsplit(&['/', '\\', '.']).collect();
    if parts.len() >= 2 && is_common_extension(parts[0]) {
        parts[1].rsplit(&['/', '\\']).next().unwrap_or(parts[1]).to_string()
    } else {
        parts[0].rsplit(&['/', '\\']).next().unwrap_or(parts[0]).to_string()
    }
}

/// Cross-file edge resolver.
///
/// After all files are parsed and merged, resolves edge targets by matching
/// short names / file stems against full node IDs.
///
/// Resolution strategies (tried in order):
///   1. Exact ID match (source/target already a valid node key)
///   2. Short-name match  — "fn_a" → "a.rs.fn_a"
///   3. File-stem match   — "b"    → "b.rs"
///   4. Multi-candidate qualified match (e.g. "models.User" vs N "User"s)
///
/// Edges that cannot be resolved are logged and then removed as orphans.
pub struct CrossFileResolver;

impl CrossFileResolver {
    /// Resolve all cross-file edges in the graph.
    /// Returns count of resolved edges (including orphan cleanups).
    pub fn resolve(graph: &mut Graph) -> usize {
        // ── Index 1: short name → node IDs ──
        // "User" → ["app.models.User", "auth.models.User"]
        let mut name_index: HashMap<String, Vec<String>> = HashMap::new();
        // ── Index 2: file stem → node IDs (for import resolution) ──
        // "a" → ["a.rs"], "models" → ["app/models.py"]
        let mut stem_index: HashMap<String, Vec<String>> = HashMap::new();

        for (id, node) in &graph.nodes {
            let short = short_name(&node.name);
            name_index.entry(short.clone()).or_default().push(id.clone());

            // File / Module nodes: also index by stem for import edges
            if node.kind == super::node::NodeKind::File
                || node.kind == super::node::NodeKind::Module
            {
                let stem = file_stem(&node.name);
                if stem != short {
                    stem_index.entry(stem).or_default().push(id.clone());
                }
            }
        }

        let mut resolved = 0usize;
        let mut unresolved_count = 0usize;
        let mut new_edges: Vec<Edge> = Vec::new();
        let mut to_remove: Vec<String> = Vec::new();

        for (eid, edge) in &graph.edges {
            // Try to resolve source if not in graph
            let src_id = if graph.nodes.contains_key(&edge.source) {
                Some(edge.source.clone())
            } else {
                resolve_name(&edge.source, &name_index, &stem_index, graph)
            };

            // Try to resolve target if not in graph
            let tgt_id = if graph.nodes.contains_key(&edge.target) {
                Some(edge.target.clone())
            } else {
                resolve_name(&edge.target, &name_index, &stem_index, graph)
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
            } else {
                unresolved_count += 1;
                tracing::debug!(
                    edge_id = %eid,
                    source = %edge.source,
                    target = %edge.target,
                    kind = ?edge.kind,
                    "cross-file edge could not be resolved"
                );
            }
        }

        // Remove old unresolved edges, add resolved ones
        for eid in &to_remove {
            graph.remove_edge(eid);
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
            graph.remove_edge(eid);
        }

        if unresolved_count > 0 {
            tracing::warn!(
                resolved,
                unresolved = unresolved_count,
                orphans = orphan_edges.len(),
                "cross-file resolver: {} edges unresolved, {} orphans cleaned",
                unresolved_count,
                orphan_edges.len()
            );
        }

        resolved += orphan_edges.len(); // count cleaned edges too
        resolved
    }
}

/// Get the short name from a full qualified name.
///
/// Strips known file extensions first so that file nodes are indexable
/// by their logical module name (not their extension).
///
/// "django.http.response.HttpResponse" → "HttpResponse"
/// "a.rs"                               → "a"
/// "app/models.py"                      → "models"
/// "app.views.index"                    → "index"
fn short_name(full: &str) -> String {
    // If the last dot-segment looks like a file extension, strip it first
    let last = full.rsplit('.').next().unwrap_or(full);
    if is_common_extension(last) {
        // Strip ".ext" and recompute — also split on path separators
        if let Some(stripped) = full.strip_suffix(&format!(".{}", last)) {
            return stripped
                .rsplit(&['.', '/', '\\'])
                .next()
                .unwrap_or(stripped)
                .to_string();
        }
    }
    full.rsplit('.').next().unwrap_or(full).to_string()
}

/// Try to resolve a name reference to an actual node ID.
fn resolve_name(
    name: &str,
    name_index: &HashMap<String, Vec<String>>,
    stem_index: &HashMap<String, Vec<String>>,
    graph: &Graph,
) -> Option<String> {
    // ── Strategy 1: exact match ──
    if graph.nodes.contains_key(name) {
        return Some(name.to_string());
    }

    // ── Strategy 2: short-name match ──
    // Works for bare fn/class names: "fn_a" → "a.rs.fn_a"
    let short = short_name(name);
    if let Some(candidates) = name_index.get(&short) {
        if candidates.len() == 1 && !name.contains('.') {
            return Some(candidates[0].clone());
        }
        // Multiple candidates — pick the most qualified (longest) match
        if let Some(c) = best_qualified_match(name, candidates) {
            return Some(c);
        }
    }

    // ── Strategy 3: file-stem match ──
    // Works for bare module imports: "b" → "b.rs", "os" → "os.py"
    let stem = file_stem(name);
    if stem != short {
        if let Some(candidates) = stem_index.get(&stem) {
            if candidates.len() == 1 {
                return Some(candidates[0].clone());
            }
            if let Some(c) = best_qualified_match(name, candidates) {
                return Some(c);
            }
        }
    }

    // ── Strategy 4: normalize path separators ──
    // Handles "::" in Rust paths and mixed "./\" in import targets
    let normalized = name.replace("::", ".").replace('\\', ".").replace('/', ".");
    if normalized != *name {
        let short_norm = short_name(&normalized);
        if let Some(candidates) = name_index.get(&short_norm) {
            if candidates.len() == 1 {
                return Some(candidates[0].clone());
            }
            if let Some(c) = best_qualified_match(&normalized, candidates) {
                return Some(c);
            }
        }
    }

    // ── Strategy 5: dotted import → try appending file extensions ──
    // "app.models" → checks for "app.models.py", "utils.helpers" → "utils.helpers.py"
    if name.contains('.') {
        for ext in CODE_EXTENSIONS {
            let with_ext = format!("{}.{}", name, ext);
            if graph.nodes.contains_key(&with_ext) {
                return Some(with_ext);
            }
        }
    }

    None
}

/// Pick the best candidate when multiple nodes share the same short name.
/// "models.User" vs candidates ["auth.models.User", "shop.models.User"]
/// → matches suffix-wise against "auth.models.User" (both end with "models.User").
fn best_qualified_match(name: &str, candidates: &[String]) -> Option<String> {
    let name_parts: Vec<&str> = name.rsplit('.').collect();
    let mut best: Option<&String> = None;
    let mut best_score = 0usize;

    for candidate in candidates {
        let cand_parts: Vec<&str> = candidate.rsplit('.').collect();
        let match_len = name_parts.len().min(cand_parts.len());
        if match_len >= 2 && name_parts[..match_len] == cand_parts[..match_len] {
            let score = cand_parts.len(); // longer full path = more qualified
            if score > best_score {
                best_score = score;
                best = Some(candidate);
            }
        }
    }

    best.cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{EdgeKind, Node, NodeKind};

    // ── short_name / file_stem unit tests ──

    #[test]
    fn test_short_name() {
        assert_eq!(short_name("django.http.HttpResponse"), "HttpResponse");
        assert_eq!(short_name("simple"), "simple");
        assert_eq!(short_name("a.b.c.d"), "d");
    }

    #[test]
    fn test_short_name_strips_file_extensions() {
        // File nodes should index by module name, not extension
        assert_eq!(short_name("a.rs"), "a");
        assert_eq!(short_name("app.models.py"), "models");
        assert_eq!(short_name("src/lib.go"), "lib");
        assert_eq!(short_name("components/Button.tsx"), "Button");
    }

    #[test]
    fn test_short_name_non_extension_unchanged() {
        // Non-extension last segments should still work
        assert_eq!(short_name("fn_a"), "fn_a");
        assert_eq!(short_name("User"), "User");
        assert_eq!(short_name("index"), "index");
    }

    #[test]
    fn test_file_stem() {
        assert_eq!(file_stem("a.rs"), "a");
        assert_eq!(file_stem("app/models.py"), "models");
        assert_eq!(file_stem("foo.bar.baz.ts"), "baz");
        assert_eq!(file_stem("django.http.HttpResponse"), "HttpResponse");
        assert_eq!(file_stem("src/components/Button.tsx"), "Button");
        assert_eq!(file_stem("simple"), "simple");
    }

    // ── Resolver tests ──

    #[test]
    fn test_resolve_cross_file_calls() {
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

    #[test]
    fn test_resolve_source_and_target() {
        let mut g = Graph::new();
        g.add_node(Node::new("lib.fn_a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("lib.fn_b", "fn_b", NodeKind::Symbol));
        // Both source and target need resolution
        g.add_edge(Edge::new("e1", "fn_a", "fn_b", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        let e = g.get_edge("e1_resolved").unwrap();
        assert_eq!(e.source, "lib.fn_a");
        assert_eq!(e.target, "lib.fn_b");
    }

    #[test]
    fn test_resolve_multiple_candidates_best_match() {
        let mut g = Graph::new();
        // Two modules define a "User" class
        g.add_node(Node::new("auth.models.User", "User", NodeKind::Symbol));
        g.add_node(Node::new("shop.models.User", "User", NodeKind::Symbol));
        // Reference uses qualified name "models.User"
        g.add_node(Node::new("views.index", "index", NodeKind::Symbol));
        g.add_edge(Edge::new("e1", "views.index", "models.User", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        // Should resolve to auth.models.User (first registered, or best match)
        let e = g.get_edge("e1_resolved");
        assert!(e.is_some(), "should resolve even with ambiguity");
    }

    #[test]
    fn test_resolve_already_resolved_edge_unchanged() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        g.add_node(Node::new("b", "fn_b", NodeKind::Symbol));
        // Edge already has correct IDs
        g.add_edge(Edge::new("e1", "a", "b", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 0, "already-resolved edge should not count");
        assert!(g.get_edge("e1").is_some());
    }

    #[test]
    fn test_orphan_edge_cleanup() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // Edge to non-existent node
        g.add_edge(Edge::new("e1", "a", "nonexistent", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Orphan edge should be cleaned
        assert!(g.get_edge("e1").is_none(), "orphan edge should be removed");
        assert!(resolved > 0, "orphan cleanup counts as resolution");
    }

    #[test]
    fn test_resolve_no_name_match() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // Edge to a name that doesn't match anything
        g.add_edge(Edge::new("e1", "a", "totally_unknown_name", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Should be cleaned as orphan
        assert!(g.get_edge("e1").is_none());
        assert!(resolved > 0);
    }

    // ── NEW: file-stem resolution for import edges ──

    #[test]
    fn test_resolve_import_edge_by_file_stem() {
        let mut g = Graph::new();

        // File nodes as created by tree_sitter generic_walk
        let mut file_a = Node::new("a.rs", "a.rs", NodeKind::File);
        file_a.location = Some("a.rs".into());
        g.add_node(file_a);

        let mut file_b = Node::new("b.rs", "b.rs", NodeKind::File);
        file_b.location = Some("b.rs".into());
        g.add_node(file_b);

        // Import edge: a.rs → "b" (bare module name from tree_sitter)
        g.add_edge(Edge::new("imp_1", "a.rs", "b", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1, "import edge should be resolved");
        let e = g.get_edge("imp_1_resolved").unwrap();
        assert_eq!(e.source, "a.rs");
        assert_eq!(e.target, "b.rs");
        assert!(e.cross_file);
    }

    #[test]
    fn test_resolve_three_file_import_cycle() {
        let mut g = Graph::new();

        g.add_node(Node::new("a.rs", "a.rs", NodeKind::File));
        g.add_node(Node::new("b.rs", "b.rs", NodeKind::File));
        g.add_node(Node::new("c.rs", "c.rs", NodeKind::File));

        // Cyclic imports: a → b → c → a
        g.add_edge(Edge::new("e1", "a.rs", "b", EdgeKind::Imports));
        g.add_edge(Edge::new("e2", "b.rs", "c", EdgeKind::Imports));
        g.add_edge(Edge::new("e3", "c.rs", "a", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 3, "all 3 import edges should resolve");

        // Verify all edges now point to real nodes
        let e1 = g.get_edge("e1_resolved").unwrap();
        assert_eq!(e1.target, "b.rs");
        let e2 = g.get_edge("e2_resolved").unwrap();
        assert_eq!(e2.target, "c.rs");
        let e3 = g.get_edge("e3_resolved").unwrap();
        assert_eq!(e3.target, "a.rs");

        // Verify cycle detection works on resolved graph
        let cycles = crate::analysis::cycles::detect_cycles(&g);
        assert_eq!(cycles.len(), 1, "should detect the import cycle");
        assert_eq!(cycles[0]["size"], 3);
    }

    #[test]
    fn test_resolve_three_file_call_cycle() {
        let mut g = Graph::new();

        // File-level nodes
        g.add_node(Node::new("a.rs", "a.rs", NodeKind::File));
        g.add_node(Node::new("b.rs", "b.rs", NodeKind::File));
        g.add_node(Node::new("c.rs", "c.rs", NodeKind::File));

        // Function nodes inside files
        g.add_node(Node::new("a.rs.fn_a", "fn_a", NodeKind::Function));
        g.add_node(Node::new("b.rs.fn_b", "fn_b", NodeKind::Function));
        g.add_node(Node::new("c.rs.fn_c", "fn_c", NodeKind::Function));

        // Cross-file calls: fn_a → fn_b → fn_c → fn_a (bare names)
        g.add_edge(Edge::new("e1", "a.rs.fn_a", "fn_b", EdgeKind::Calls));
        g.add_edge(Edge::new("e2", "b.rs.fn_b", "fn_c", EdgeKind::Calls));
        g.add_edge(Edge::new("e3", "c.rs.fn_c", "fn_a", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 3);

        // Verify resolution
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "b.rs.fn_b");
        assert_eq!(g.get_edge("e2_resolved").unwrap().target, "c.rs.fn_c");
        assert_eq!(g.get_edge("e3_resolved").unwrap().target, "a.rs.fn_a");

        // Verify cycle detection
        let cycles = crate::analysis::cycles::detect_cycles(&g);
        assert_eq!(cycles.len(), 1, "should detect cross-file call cycle");
        assert_eq!(cycles[0]["size"], 3);
    }

    #[test]
    fn test_resolve_rust_import_with_colons() {
        let mut g = Graph::new();

        g.add_node(Node::new("a.rs", "a.rs", NodeKind::File));
        g.add_node(Node::new("b.rs", "b.rs", NodeKind::File));

        // Rust-style import: "crate::b" (with :: separators)
        g.add_edge(Edge::new("e1", "a.rs", "crate::b", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "b.rs");
    }

    #[test]
    fn test_resolve_python_dotted_import() {
        let mut g = Graph::new();

        g.add_node(Node::new("app.models.py", "app/models.py", NodeKind::File));
        g.add_node(Node::new("app.views.py", "app/views.py", NodeKind::File));

        // Python: "from app.models import User" → edge target "app.models"
        g.add_edge(Edge::new("e1", "app.views.py", "app.models", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "app.models.py");
    }

    #[test]
    fn test_resolve_python_subpackage_import() {
        let mut g = Graph::new();

        g.add_node(Node::new("utils.helpers.py", "utils/helpers.py", NodeKind::File));
        g.add_node(Node::new("main.py", "main.py", NodeKind::File));

        // "from utils.helpers import foo" → target "utils.helpers"
        g.add_edge(Edge::new("e1", "main.py", "utils.helpers", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "utils.helpers.py");
    }

    #[test]
    fn test_external_import_not_resolved() {
        let mut g = Graph::new();
        g.add_node(Node::new("main.py", "main.py", NodeKind::File));

        // "import os" — os.py is not in the project graph
        g.add_edge(Edge::new("e1", "main.py", "os", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Edge should be cleaned as orphan (can't resolve stdlib)
        assert!(g.get_edge("e1").is_none());
        assert!(g.get_edge("e1_resolved").is_none());
        assert!(resolved > 0, "orphan cleanup counts");
    }
}