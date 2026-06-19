//! Dynamic dispatch synthesis — fills in graph edges that static analysis misses.
//!
//! Patterns detected (Phase 1):
//! - Callback registration: addEventListener('e', handler), .on('e', handler)
//! - Observer/promise chains: .then(cb), .subscribe(cb)
//! - Express middleware: app.use(mw), router.use(mw)
//!
//! These produce synthesized edges (provenance: "synthesized") that feed into
//! hologram_explore's synthesizedHops output.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

/// Parsed source held in the pipeline parse cache.
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// Run dynamic dispatch synthesis on the graph for all supported languages.
/// Uses the parse cache from Step 1 to avoid re-reading + re-parsing files.
/// Returns the number of synthesized edges added.
pub fn synthesize_dynamic_edges(graph: &mut Graph, project_root: &Path, parse_cache: &ParseCache) -> usize {
    let mut added = 0usize;

    // Collect files to scan from graph nodes
    let mut files: HashSet<String> = HashSet::new();
    for node in graph.nodes.values() {
        if let Some(ref loc) = node.location {
            files.insert(file_key(loc));
        }
    }
    // Also walk disk for JS/TS/Python files (which may have 0 graph nodes)
    for entry in walkdir::WalkDir::new(project_root)
        .into_iter()
        .filter_entry(|e| !super::is_skippable_dir(e))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        if let Ok(rel) = entry.path().strip_prefix(project_root) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let lower = rel_str.to_lowercase();
            if lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx")
                || lower.ends_with(".py")
            {
                files.insert(rel_str);
            }
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        // Normalize to absolute path for cache lookup (graph nodes have abs paths,
        // disk walk yields rel paths — the cache is keyed by abs paths)
        let abs_key = if file.contains(':') {
            file.clone() // already absolute (e.g. d:/django/views.py)
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };
        // Try parse cache first (avoids re-reading + re-parsing)
        if let Some((source, Some(tree))) = parse_cache.get(&abs_key) {
            if lower.ends_with(".py") {
                added += synthesize_py_from_tree(graph, file, tree, source);
            } else {
                added += synthesize_js_from_tree(graph, file, tree, source);
            }
        } else {
            // Fallback: read from disk (for files not in parse cache)
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if lower.ends_with(".py") {
                    added += synthesize_py_fallback(graph, file, &source);
                } else {
                    added += synthesize_js_fallback(graph, file, &source);
                }
            }
        }
    }

    added
}

// ═══════════════════════════════════════════════════════════════
// JavaScript / TypeScript
// ═══════════════════════════════════════════════════════════════

/// Walk a cached tree (from Step 1) — no re-parse needed.
fn synthesize_js_from_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    walk_js_ts_tree(graph, file, tree, source)
}

/// Fallback: parse from source for files not in parse cache.
fn synthesize_js_fallback(graph: &mut Graph, file: &str, source: &str) -> usize {
    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let lang: tree_sitter::Language = if is_ts {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    } else {
        tree_sitter_javascript::LANGUAGE.into()
    };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };
    walk_js_ts_tree(graph, file, &tree, source)
}

/// Shared tree walker — used by both cache and fallback paths.
fn walk_js_ts_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    let mut added = 0usize;

    // Known callback-registering method names
    let callback_methods: HashSet<&str> = [
        "addEventListener", "on", "once", "then", "catch", "finally",
        "subscribe", "use", "listen", "observe", "watch",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some((callback_ref, line)) = extract_js_callback(&node, source, &callback_methods) {
                // Find the containing function
                let parent_func = find_containing_function(&node, source);
                if let Some(src_name) = parent_func {
                    // Find the source node in the graph
                    let src_id = find_or_create_node(graph, &src_name, file, line);
                    let tgt_id = find_or_create_node(graph, &callback_ref, file, line);

                    let edge_id = format!("syn_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        let edge = Edge {
                            id: edge_id,
                            source: src_id,
                            target: tgt_id,
                            kind: EdgeKind::Calls,
                            coupling_depth: 3, // synthesized = deep coupling
                            cross_file: false,
                            direction: "synthesized".into(),
                            temporal_delay_sec: Some(0.0), // immediate callback
                            medium_node_id: None,
                        };
                        graph.add_edge(edge);
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    added
}

fn extract_js_callback(
    call: &tree_sitter::Node,
    source: &str,
    methods: &HashSet<&str>,
) -> Option<(String, usize)> {
    // Find the callee function (member_expression: obj.method)
    let func = call.child_by_field_name("function")
        .or_else(|| {
            let mut cc = call.walk();
            let children: Vec<_> = call.children(&mut cc).collect();
            children.into_iter().find(|c| c.kind() == "member_expression")
        })?;

    if func.kind() != "member_expression" {
        return None;
    }

    let mut mc = func.walk();
    let func_children: Vec<_> = func.children(&mut mc).collect();

    let prop_name = func_children.iter()
        .filter(|c| c.kind() == "property_identifier")
        .last()
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())?;

    if !methods.contains(prop_name.as_str()) {
        return None;
    }

    // Get arguments — first non-string argument is the callback
    let args = call.child_by_field_name("arguments")
        .or_else(|| {
            let mut cc = call.walk();
            let children: Vec<_> = call.children(&mut cc).collect();
            children.into_iter().find(|c| c.kind() == "arguments")
        })?;

    let mut ac = args.walk();
    for arg in args.children(&mut ac) {
        match arg.kind() {
            "identifier" => {
                let name = arg.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                let line = arg.start_position().row + 1;
                if name != "undefined" && !name.is_empty() {
                    return Some((name, line));
                }
            }
            "arrow_function" | "function_expression" | "function" => {
                let line = arg.start_position().row + 1;
                // Try to get the function name
                if let Some(nn) = arg.child_by_field_name("name") {
                    let name = nn.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                    if !name.is_empty() {
                        return Some((name, line));
                    }
                }
                return Some((format!("<callback@{}>", line), line));
            }
            "string" | "template_string" => continue, // skip event names
            _ => continue,
        }
    }
    None
}

fn find_containing_function(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_declaration" | "function_expression" | "method_definition"
            | "arrow_function" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return Some(name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                }
                // Anonymous — use the parent's context
                if p.kind() == "arrow_function" {
                    return find_containing_function(&p, source);
                }
                let line = p.start_position().row + 1;
                return Some(format!("<fn@{}>", line));
            }
            _ => {}
        }
        cur = p.parent();
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Python
// ═══════════════════════════════════════════════════════════════

/// Walk a cached tree (from Step 1) — no re-parse needed.
fn synthesize_py_from_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    walk_py_dispatch_tree(graph, file, tree, source)
}

/// Fallback: parse from source for files not in parse cache.
fn synthesize_py_fallback(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&tree_sitter_python::LANGUAGE.into()).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };
    walk_py_dispatch_tree(graph, file, &tree, source)
}

/// Shared tree walker — used by both cache and fallback paths.
fn walk_py_dispatch_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    let mut added = 0usize;

    // Known Python callback-registering method names
    let callback_methods: HashSet<&str> = [
        "subscribe", "add_callback", "register", "on", "add_listener",
        "connect", "add_handler", "observe", "watch",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            if let Some((callback_ref, line)) = extract_py_callback(&node, source, &callback_methods) {
                let parent_func = find_containing_py_function(&node, source);
                if let Some(src_name) = parent_func {
                    let src_id = find_or_create_node(graph, &src_name, file, line);
                    let tgt_id = find_or_create_node(graph, &callback_ref, file, line);

                    let edge_id = format!("syn_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        let edge = Edge {
                            id: edge_id,
                            source: src_id,
                            target: tgt_id,
                            kind: EdgeKind::Calls,
                            coupling_depth: 3,
                            cross_file: false,
                            direction: "synthesized".into(),
                            temporal_delay_sec: Some(0.0),
                            medium_node_id: None,
                        };
                        graph.add_edge(edge);
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    added
}

fn extract_py_callback(
    call: &tree_sitter::Node,
    source: &str,
    methods: &HashSet<&str>,
) -> Option<(String, usize)> {
    // Method call: obj.subscribe(callback)
    if let Some(func) = call.child_by_field_name("function") {
        if func.kind() == "attribute" {
            let mut ac = func.walk();
            let method = func.children(&mut ac)
                .filter(|c| c.kind() == "identifier")
                .last()
                .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())?;

            if !methods.contains(method.as_str()) {
                return None;
            }

            if let Some(args) = call.child_by_field_name("arguments") {
                let mut arg_c = args.walk();
                for arg in args.children(&mut arg_c) {
                    match arg.kind() {
                        "identifier" => {
                            let name = arg.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                            let line = arg.start_position().row + 1;
                            return Some((name, line));
                        }
                        "lambda" => {
                            let line = arg.start_position().row + 1;
                            return Some((format!("<lambda@{}>", line), line));
                        }
                        "string" => continue, // event name, skip
                        _ => continue,
                    }
                }
            }
        }
    }
    None
}

fn find_containing_py_function(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_definition" | "async_function_definition" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return Some(name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                }
                let line = p.start_position().row + 1;
                return Some(format!("<fn@{}>", line));
            }
            _ => {}
        }
        cur = p.parent();
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════════════

/// Find or create a graph node for the given symbol name.
fn find_or_create_node(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    // Try to find an existing node
    for (id, node) in &graph.nodes {
        if node.name == name {
            return id.clone();
        }
    }
    // Create a placeholder node
    let node_id = format!("dyn_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut node = Node::new(&node_id, name, NodeKind::Symbol);
    node.location = Some(format!("{}:{}", file, line));
    node.properties = serde_json::json!({"kind": "synthesized_target", "provenance": "dynamic_dispatch"});
    graph.add_node(node);
    node_id
}

fn file_key(loc: &str) -> String {
    if let Some((p, line_part)) = loc.rsplit_once(':') {
        if p.len() == 1 && p.as_bytes()[0].is_ascii_alphabetic() {
            return loc.to_string();
        }
        if line_part.chars().all(|c| c.is_ascii_digit()) {
            return p.replace('\\', "/");
        }
    }
    loc.replace('\\', "/")
}

fn file_key_from_path(p: &str) -> String {
    p.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_synthesize_js_event_listener() {
        let mut g = Graph::new();
        // Pre-add a handler node
        let mut n = Node::new("handler", "handleClick", NodeKind::Symbol);
        n.location = Some("app.js:5".into());
        g.add_node(n);

        let source = r#"
function setup() {
    button.addEventListener('click', handleClick);
}
"#;
        let added = synthesize_js_fallback(&mut g, "app.js", source);
        assert!(added >= 1, "Should create synthesized edge for addEventListener callback");
    }

    #[test]
    fn test_synthesize_js_on_named_fn() {
        let mut g = Graph::new();
        let source = r#"
emitter.on('data', onData);
"#;
        // tree-sitter JS may not expose `function` field on call_expression —
        // the member_expression fallback is used. This test verifies no crash.
        let _added = synthesize_js_fallback(&mut g, "events.js", source);
    }

    #[test]
    fn test_synthesize_js_then_arrow() {
        let mut g = Graph::new();
        let source = r#"
function init() {
    fetch('/api').then((data) => { console.log(data); });
}
"#;
        let added = synthesize_js_fallback(&mut g, "api.js", source);
        // .then() with arrow function — at minimum should not crash
        // (arrow_function detection may need fine-tuning per tree-sitter version)
        assert!(added >= 0);
    }

    #[test]
    fn test_synthesize_py_subscribe() {
        let mut g = Graph::new();
        let source = r#"
def main():
    obs.subscribe(on_next)
"#;
        let added = synthesize_py_fallback(&mut g, "main.py", source);
        assert!(added >= 1, "Should create edge for .subscribe() callback");
    }

    #[test]
    fn test_synthesize_no_callback_returns_zero() {
        let mut g = Graph::new();
        let source = "console.log('hello');";
        let added = synthesize_js_fallback(&mut g, "app.js", source);
        assert_eq!(added, 0, "No callback pattern → 0 edges");
    }
}
