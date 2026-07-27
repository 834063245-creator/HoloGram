// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::sync::OnceLock;

use super::{Edge, Graph};
use crate::engine::GRAMMAR_LOADER;

/// Source-code file extensions, derived dynamically from GRAMMAR_LOADER.
/// Automatically includes newly installed grammar DLLs without code changes.
/// Cached via OnceLock — `supported_extensions()` is only called once.
fn code_extensions() -> &'static [String] {
    static EXT: OnceLock<Vec<String>> = OnceLock::new();
    EXT.get_or_init(|| GRAMMAR_LOADER.supported_extensions())
}

fn is_common_extension(s: &str) -> bool {
    code_extensions().iter().any(|ext| ext == s)
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
        let mut ambiguous_edges: Vec<String> = Vec::new();

        // ── Diagnostic: categorize unresolved edges ──
        let mut diag_no_short: usize = 0;        // short_name not in any index
        let mut diag_bare_external: usize = 0;   // bare name, no candidates at all
        let mut diag_dotted_method: usize = 0;   // contains dot (obj.method style)
        let mut diag_source_missing: usize = 0;  // source not found
        let mut diag_bare_multi: usize = 0;      // bare name, candidates exist but best_qualified_match rejects (match_len<2)
        let mut diag_dotted_no_suffix: usize = 0;// dotted name, short exists but suffix mismatch
        let mut diag_by_kind: HashMap<String, usize> = HashMap::new();

        for (eid, edge) in &graph.edges {
            // ponytail: only resolve cross-file edges. Intra-file edges (Usage, Writes,
            // same-file Calls) have bare-name targets that aren't node IDs — they're
            // valid as-is and must not be orphan-cleaned.
            if !edge.cross_file {
                continue;
            }
            // Try to resolve source if not in graph.
            // Use edge.source itself to infer the source language for filtering.
            let src_lang = infer_language(&edge.source);
            let src_id = if graph.nodes.contains_key(&edge.source) {
                Some(edge.source.clone())
            } else {
                resolve_name(&edge.source, &name_index, &stem_index, graph, src_lang)
            };

            // Try to resolve target if not in graph.
            // Use the source's language to prefer same-language targets.
            let tgt_lang = src_id.as_ref()
                .map(|id| infer_language(id))
                .flatten()
                .or(src_lang);
            let tgt_id = if graph.nodes.contains_key(&edge.target) {
                Some(edge.target.clone())
            } else {
                resolve_name(&edge.target, &name_index, &stem_index, graph, tgt_lang)
            };

            let src_ok = src_id.is_some();
            let tgt_ok = tgt_id.is_some();

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
                // ── categorize failure ──
                *diag_by_kind.entry(format!("{:?}", edge.kind)).or_default() += 1;
                if !src_ok && !graph.nodes.contains_key(&edge.source) {
                    diag_source_missing += 1;
                }
                if !tgt_ok {
                    let tshort = short_name(&edge.target);
                    let has_dot = edge.target.contains('.');
                    let in_index = name_index.contains_key(&tshort);
                    let in_stem = stem_index.contains_key(&file_stem(&edge.target));
                    if !in_index && !in_stem {
                        diag_no_short += 1;
                        if has_dot { diag_dotted_method += 1; }
                        if !has_dot { diag_bare_external += 1; }
                    } else if !has_dot {
                        diag_bare_multi += 1; // short exists, but bare → best_qualified_match rejects
                    } else {
                        diag_dotted_no_suffix += 1; // short exists, dotted, but suffix mismatch
                    }
                    // Candidates existed but couldn't be uniquely resolved — mark as ambiguous
                    if in_index || in_stem {
                        ambiguous_edges.push(eid.clone());
                    }
                }
                tracing::debug!(
                    edge_id = %eid,
                    source = %edge.source,
                    target = %edge.target,
                    kind = ?edge.kind,
                    "cross-file edge could not be resolved"
                );
            }
        }

        // Print diagnostic summary
        if unresolved_count > 0 {
            eprintln!(
                "[cross-file diag] unresolved={} | no_short={} (dotted={}, bare_ext={}) | bare_multi={} | dotted_no_suffix={} | src_miss={}",
                unresolved_count, diag_no_short, diag_dotted_method, diag_bare_external,
                diag_bare_multi, diag_dotted_no_suffix, diag_source_missing
            );
            // Top 5 edge kinds among unresolved
            let mut kind_counts: Vec<(String, usize)> = diag_by_kind.into_iter().collect();
            kind_counts.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
            let top_kinds: Vec<String> = kind_counts.iter().take(5)
                .map(|(k, c)| format!("{}={}", k, c))
                .collect();
            eprintln!("[cross-file diag] by kind: {}", top_kinds.join(", "));
        }

        // Remove old unresolved edges, add resolved ones
        for eid in &to_remove {
            graph.remove_edge(eid);
        }
        for edge in new_edges {
            if let Err(e) = graph.add_edge(edge) {
                tracing::debug!("resolved edge not added: {}", e);
            }
        }

        // Mark ambiguous edges for user/LSP resolution instead of deleting them.
        for eid in &ambiguous_edges {
            if let Some(edge) = graph.edges.get_mut(eid) {
                edge.metadata = Some(serde_json::json!({
                    "ambiguous": true,
                    "original_target": edge.target.clone(),
                }));
            }
        }

        // Cleanup: remove cross-file edges with non-existent endpoints.
        // Intra-file edges (Usage, Writes, same-file Calls) have bare-name
        // targets that aren't node IDs — they're valid as-is.
        // Ambiguous edges (marked above) are preserved for user/LSP resolution.
        let orphan_edges: Vec<String> = graph
            .edges
            .iter()
            .filter(|(_, e)| {
                if !e.cross_file {
                    return false;
                }
                if graph.nodes.contains_key(&e.source) && graph.nodes.contains_key(&e.target) {
                    return false;
                }
                // Preserve ambiguous edges
                !e.metadata.as_ref()
                    .and_then(|m| m.get("ambiguous"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for eid in &orphan_edges {
            graph.remove_edge(eid);
        }

        if unresolved_count > 0 || !orphan_edges.is_empty() || !ambiguous_edges.is_empty() {
            if unresolved_count > 0 {
                tracing::warn!(
                    resolved,
                    unresolved = unresolved_count,
                    orphans = orphan_edges.len(),
                    ambiguous = ambiguous_edges.len(),
                    "cross-file resolver: {} edges unresolved, {} orphans cleaned, {} ambiguous (preserved)",
                    unresolved_count,
                    orphan_edges.len(),
                    ambiguous_edges.len()
                );
            } else {
                tracing::debug!(
                    resolved,
                    orphans = orphan_edges.len(),
                    ambiguous = ambiguous_edges.len(),
                    "cross-file resolver: {} orphans cleaned (stale edges), {} ambiguous (preserved)",
                    orphan_edges.len(),
                    ambiguous_edges.len()
                );
            }
        }

        resolved // NOTE: orphans are NOT counted as resolved — they're just stale cleanup
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

/// Infer the language family from a node ID or file path.
///
/// Scans dot-separated segments for known file extensions and returns
/// the language family as a static string. Used to filter cross-file
/// resolution candidates so that e.g. a TypeScript function's call to
/// `clear` resolves to another TS `clear`, not a Rust `clear`.
///
/// Node IDs encode the file extension as a segment:
///   "D:...events.ts.EventBus.clear" → Some("typescript")
///   "D:...graph.rs.Graph.clear"     → Some("rust")
///
/// Paths work the same way:
///   "src-ui/src/ui/events.ts"       → Some("typescript")
///   "engine/src/graph/graph.rs"     → Some("rust")
pub fn infer_language(id_or_path: &str) -> Option<&'static str> {
    let lower = id_or_path.to_lowercase();
    for segment in lower.split('.') {
        match segment {
            "rs" => return Some("rust"),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "mts" | "cts" => return Some("typescript"),
            "py" | "pyi" => return Some("python"),
            "go" => return Some("go"),
            "java" => return Some("java"),
            "cs" => return Some("csharp"),
            "rb" => return Some("ruby"),
            "kt" | "kts" => return Some("kotlin"),
            "php" => return Some("php"),
            "swift" => return Some("swift"),
            "dart" => return Some("dart"),
            "lua" => return Some("lua"),
            "zig" => return Some("zig"),
            "r" => return Some("r"),
            "scala" => return Some("scala"),
            "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" | "c" | "h" => return Some("c_cpp"),
            "ex" | "exs" | "erl" | "hrl" => return Some("elixir_erlang"),
            "hs" => return Some("haskell"),
            "ml" | "mli" => return Some("ocaml"),
            "svelte" => return Some("svelte"),
            "vue" => return Some("vue"),
            _ => continue,
        }
    }
    None
}

/// Filter candidates to those matching the given language, if known.
/// Returns a Vec of references to the matching candidates.
/// If `lang` is None or no same-language candidates exist, returns all candidates.
fn filter_by_language<'a>(
    candidates: &'a [String],
    lang: Option<&str>,
) -> Vec<&'a String> {
    let all: Vec<&String> = candidates.iter().collect();
    let same_lang: Vec<&String> = candidates
        .iter()
        .filter(|c| lang == infer_language(c))
        .collect();
    if same_lang.is_empty() { all } else { same_lang }
}

/// Try to resolve a name reference to an actual node ID.
fn resolve_name(
    name: &str,
    name_index: &HashMap<String, Vec<String>>,
    stem_index: &HashMap<String, Vec<String>>,
    graph: &Graph,
    source_lang: Option<&str>,
) -> Option<String> {
    // ── Strategy 1: exact match ──
    if graph.nodes.contains_key(name) {
        return Some(name.to_string());
    }

    // ── Strategy 2: short-name match ──
    // Works for bare fn/class names: "fn_a" → "a.rs.fn_a"
    let short = short_name(name);
    if let Some(candidates) = name_index.get(&short) {
        let filtered = filter_by_language(candidates, source_lang);
        if filtered.len() == 1 && !name.contains('.') {
            return Some(filtered[0].clone());
        }
        // Multiple candidates — pick the most qualified (longest) match
        if let Some(c) = best_qualified_match(name, &filtered) {
            return Some(c);
        }
        // ponytail: bare names can't suffix-match (match_len < 2).
        // Fall back to heuristic: prefer Function/Class, then shortest path.
        if !name.contains('.') {
            if let Some(c) = best_bare_match(&filtered, graph, source_lang) {
                return Some(c);
            }
        }
    }

    // ── Strategy 3: file-stem match ──
    // Works for bare module imports: "b" → "b.rs", "os" → "os.py"
    let stem = file_stem(name);
    if stem != short {
        if let Some(candidates) = stem_index.get(&stem) {
            let filtered = filter_by_language(candidates, source_lang);
            if filtered.len() == 1 {
                return Some(filtered[0].clone());
            }
            if let Some(c) = best_qualified_match(name, &filtered) {
                return Some(c);
            }
            // Same bare-name fallback for stem matches
            if !name.contains('.') {
                if let Some(c) = best_bare_match(&filtered, graph, source_lang) {
                    return Some(c);
                }
            }
        }
    }

    // ── Strategy 4: normalize path separators ──
    // Handles "::" in Rust paths and mixed "./\" in import targets
    let normalized = name.replace("::", ".").replace(['\\', '/'], ".");
    if normalized != *name {
        let short_norm = short_name(&normalized);
        if let Some(candidates) = name_index.get(&short_norm) {
            let filtered = filter_by_language(candidates, source_lang);
            if filtered.len() == 1 {
                return Some(filtered[0].clone());
            }
            if let Some(c) = best_qualified_match(&normalized, &filtered) {
                return Some(c);
            }
        }
    }

    // ── Strategy 5: dotted import → try appending file extensions ──
    // "app.models" → checks for "app.models.py", "utils.helpers" → "utils.helpers.py"
    if name.contains('.') {
        for ext in code_extensions() {
            let with_ext = format!("{}.{}", name, ext);
            if graph.nodes.contains_key(&with_ext) {
                return Some(with_ext);
            }
        }
    }

    // ── Strategy 6: progressive strip for obj.method()-style calls ──
    // "self.client.get" → try "client.get" → try bare "get"
    // ponytail: common receiver prefixes (self, this, cls) are stripped;
    // the remaining bare name falls through to best_bare_match.
    if name.contains('.') {
        let mut stripped = name.to_string();
        while let Some(dot_pos) = stripped.find('.') {
            stripped = stripped[dot_pos + 1..].to_string();
            let short = short_name(&stripped);
            if let Some(candidates) = name_index.get(&short) {
                let filtered = filter_by_language(candidates, source_lang);
                if filtered.len() == 1 {
                    return Some(filtered[0].clone());
                }
                if let Some(c) = best_qualified_match(&stripped, &filtered) {
                    return Some(c);
                }
                if !stripped.contains('.') {
                    if let Some(c) = best_bare_match(&filtered, graph, source_lang) {
                        return Some(c);
                    }
                }
            }
        }
    }

    None
}

/// Pick the best candidate when multiple nodes share the same short name.
/// "models.User" vs candidates ["auth.models.User", "shop.models.User"]
/// → matches suffix-wise against "auth.models.User" (both end with "models.User").
fn best_qualified_match(name: &str, candidates: &[&String]) -> Option<String> {
    let name_parts: Vec<&str> = name.rsplit('.').collect();
    let mut best: Option<&&String> = None;
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

    best.map(|c| (*c).clone())
}

/// Fallback for bare names with multiple candidates.
///
/// When the query is a single bare name (e.g., "render") and multiple
/// nodes share that short name, suffix matching is impossible. This
/// heuristic picks the best candidate by:
///   1. Prefer same-language candidates (+10000 bonus)
///   2. Prefer Function over Class over other node kinds
///   3. Prefer shorter paths (less nested = more likely to be the intended target)
///
/// ponytail: this is a heuristic, not a guarantee. For precise call resolution,
/// use hologram_resolve_call (LSP-based) on individual edges.
fn best_bare_match(candidates: &[&String], graph: &Graph, source_lang: Option<&str>) -> Option<String> {
    use super::node::NodeKind;

    // Score: lang_match * 100000 + kind_prio * 1000 + path depth
    // Same-language candidates always outrank cross-language ones.
    let scored: Vec<(&&String, usize)> = candidates
        .iter()
        .filter_map(|c| {
            let kind_prio = match graph.nodes.get(*c).map(|n| &n.kind) {
                Some(NodeKind::Function) => 0,
                Some(NodeKind::Class) => 1,
                Some(NodeKind::Symbol) => 2,
                Some(NodeKind::Variable) => 3,
                _ => 4,
            };
            let depth = c.split('.').count();
            let lang_bonus = if source_lang.is_some() && infer_language(c) == source_lang {
                100000
            } else {
                0
            };
            Some((c, lang_bonus + kind_prio * 1000 + depth))
        })
        .collect();

    if scored.is_empty() {
        return None;
    }

    let min_score = scored.iter().map(|(_, s)| *s).min().unwrap();
    let tied: Vec<String> = scored.iter()
        .filter(|(_, s)| *s == min_score)
        .map(|(c, _)| (**c).clone())
        .collect();

    if tied.len() > 1 {
        tracing::debug!(
            candidates = ?tied.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            "best_bare_match: {} candidates with same score — ambiguous, returning None",
            tied.len()
        );
        return None;
    }

    tied.first().cloned()
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

    // ponytail: helper to create cross-file edges for tests.
    // CrossFileResolver only processes edges with cross_file=true.
    fn cross_edge(id: &str, src: &str, tgt: &str, kind: EdgeKind) -> Edge {
        let mut e = Edge::new(id, src, tgt, kind);
        e.cross_file = true;
        e
    }

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
        let mut e = Edge::new("e1", "views.index", "User", EdgeKind::Calls);
        e.cross_file = true;
        g.add_edge_unchecked(e);

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
        g.add_edge_unchecked(cross_edge("e1", "fn_a", "fn_b", EdgeKind::Calls));

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
        g.add_edge_unchecked(cross_edge("e1", "views.index", "models.User", EdgeKind::Calls));

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
        g.add_edge_unchecked(cross_edge("e1", "a", "b", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 0, "already-resolved edge should not count");
        assert!(g.get_edge("e1").is_some());
    }

    #[test]
    fn test_orphan_edge_cleanup() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // Edge to non-existent node
        g.add_edge_unchecked(cross_edge("e1", "a", "nonexistent", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Orphan edge should be cleaned, but NOT counted as resolved
        assert!(g.get_edge("e1").is_none(), "orphan edge should be removed");
        assert_eq!(resolved, 0, "orphan cleanup does not count as resolved");
    }

    #[test]
    fn test_resolve_no_name_match() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "fn_a", NodeKind::Symbol));
        // Edge to a name that doesn't match anything
        g.add_edge_unchecked(cross_edge("e1", "a", "totally_unknown_name", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Should be cleaned as orphan
        assert!(g.get_edge("e1").is_none());
        assert_eq!(resolved, 0, "unresolved edge → orphan, not resolved");
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
        g.add_edge_unchecked(cross_edge("imp_1", "a.rs", "b", EdgeKind::Imports));

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
        g.add_edge_unchecked(cross_edge("e1", "a.rs", "b", EdgeKind::Imports));
        g.add_edge_unchecked(cross_edge("e2", "b.rs", "c", EdgeKind::Imports));
        g.add_edge_unchecked(cross_edge("e3", "c.rs", "a", EdgeKind::Imports));

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
        g.add_edge_unchecked(cross_edge("e1", "a.rs.fn_a", "fn_b", EdgeKind::Calls));
        g.add_edge_unchecked(cross_edge("e2", "b.rs.fn_b", "fn_c", EdgeKind::Calls));
        g.add_edge_unchecked(cross_edge("e3", "c.rs.fn_c", "fn_a", EdgeKind::Calls));

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
        g.add_edge_unchecked(cross_edge("e1", "a.rs", "crate::b", EdgeKind::Imports));

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
        g.add_edge_unchecked(cross_edge("e1", "app.views.py", "app.models", EdgeKind::Imports));

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
        g.add_edge_unchecked(cross_edge("e1", "main.py", "utils.helpers", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1);
        assert_eq!(g.get_edge("e1_resolved").unwrap().target, "utils.helpers.py");
    }

    #[test]
    fn test_external_import_not_resolved() {
        let mut g = Graph::new();
        g.add_node(Node::new("main.py", "main.py", NodeKind::File));

        // "import os" — os.py is not in the project graph
        g.add_edge_unchecked(cross_edge("e1", "main.py", "os", EdgeKind::Imports));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Edge should be cleaned as orphan (can't resolve stdlib)
        assert!(g.get_edge("e1").is_none());
        assert!(g.get_edge("e1_resolved").is_none());
        assert_eq!(resolved, 0, "stdlib import not resolved → orphan, not counted");
    }

    #[test]
    fn test_bare_multi_fallback_prefers_function() {
        let mut g = Graph::new();
        // Two nodes share short name "render":
        // One is a Function, one is a Variable — Function should win.
        g.add_node(Node::new("django.shortcuts.render", "render", NodeKind::Function));
        g.add_node(Node::new("django.views.View.render", "render", NodeKind::Function));
        g.add_node(Node::new("some.module.render_var", "render", NodeKind::Variable));
        g.add_node(Node::new("views.index", "index", NodeKind::Function));

        g.add_edge_unchecked(cross_edge("e1", "views.index", "render", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        assert_eq!(resolved, 1, "bare name with multiple candidates should resolve");
        let e = g.get_edge("e1_resolved").unwrap();
        // Should pick a Function node (kind prio 0) with shortest path
        // Both Function nodes have depth 3, so first in HashMap order wins
        let target_kind = g.nodes.get(&e.target).map(|n| &n.kind);
        assert_eq!(target_kind, Some(&NodeKind::Function), "should prefer Function over Variable");
    }

    #[test]
    fn test_cross_language_isolation_ts_caller_to_rs_target_blocked() {
        let mut g = Graph::new();
        // Two "clear" functions: one in Rust, one in TypeScript
        g.add_node(Node::new(
            "D:.HoloGramHG.engine.src.graph.graph.rs.Graph.clear",
            "clear", NodeKind::Function));
        g.add_node(Node::new(
            "D:.HoloGramHG.src-ui.src.ui.events.ts.EventBus.clear",
            "clear", NodeKind::Function));
        // A TS file calling clear()
        g.add_node(Node::new(
            "D:.HoloGramHG.src-ui.src.ui.chat-store.ts.ChatStore.save",
            "save", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "D:.HoloGramHG.src-ui.src.ui.chat-store.ts.ChatStore.save",
            "clear", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        let edge = g.get_edge("e1_resolved").expect("edge should be resolved");
        assert!(
            edge.target.contains(".ts."),
            "TS caller must resolve to same-language target, got {}",
            edge.target
        );
    }

    #[test]
    fn test_cross_language_isolation_rust_caller_to_rust_target() {
        let mut g = Graph::new();
        g.add_node(Node::new(
            "D:.HoloGramHG.engine.src.engine.pipeline.rs.Pipeline.start",
            "start", NodeKind::Function));
        g.add_node(Node::new(
            "D:.HoloGramHG.src-ui.src.agent.execution-state.ts.createExecState.start",
            "start", NodeKind::Function));
        g.add_node(Node::new(
            "D:.HoloGramHG.engine.src.main.rs.main",
            "main", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "D:.HoloGramHG.engine.src.main.rs.main",
            "start", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        let edge = g.get_edge("e1_resolved").expect("edge should be resolved");
        assert!(
            edge.target.contains(".rs."),
            "Rust caller must resolve to same-language target, got {}",
            edge.target
        );
    }

    #[test]
    fn test_cross_language_filter_does_not_break_same_language() {
        let mut g = Graph::new();
        // Two Python "render" candidates with different path depths — no tie.
        // A TS "render" candidate should be filtered out by language.
        g.add_node(Node::new(
            "django.shortcuts.py.render",
            "render", NodeKind::Function));  // depth 4
        g.add_node(Node::new(
            "flask.render",                    // depth 2 — shorter path wins
            "render", NodeKind::Function));
        // Cross-language candidate that should be filtered out
        g.add_node(Node::new(
            "app.tsx.render",
            "render", NodeKind::Function));
        g.add_node(Node::new(
            "app.views.py.index",
            "index", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "app.views.py.index",
            "render", EdgeKind::Calls));

        let _resolved = CrossFileResolver::resolve(&mut g);
        assert!(g.get_edge("e1_resolved").is_some(),
            "same-language resolution must still work");
    }

    #[test]
    fn test_best_bare_match_returns_none_on_tie() {
        // Two candidates with identical depth → tie → ambiguous (preserved, not resolved)
        let mut g = Graph::new();
        // Two "render" functions at same depth — neither is better
        g.add_node(Node::new("mod_a.render", "render", NodeKind::Function));
        g.add_node(Node::new("mod_b.render", "render", NodeKind::Function));
        g.add_node(Node::new("caller.py.index", "index", NodeKind::Function));
        g.add_edge_unchecked(cross_edge("e1",
            "caller.py.index",
            "render", EdgeKind::Calls));

        let resolved = CrossFileResolver::resolve(&mut g);
        // Should NOT resolve (tie) — edge should be preserved as ambiguous
        assert_eq!(resolved, 0, "tie should not produce a resolved edge");
        let edge = g.get_edge("e1").expect("ambiguous edge should be preserved");
        let meta = edge.metadata.as_ref().expect("ambiguous edge must have metadata");
        assert_eq!(meta["ambiguous"], true, "ambiguous flag must be set");
    }
}
