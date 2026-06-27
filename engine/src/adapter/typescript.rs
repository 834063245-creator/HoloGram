// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::cell::RefCell;
use std::path::Path;
use tree_sitter::{Language, Parser};

use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use crate::path_utils::normalize_path;

thread_local! {
    static TS_PARSER: RefCell<Option<Parser>> = RefCell::new(None);
    static JS_PARSER: RefCell<Option<Parser>> = RefCell::new(None);
}

/// Combined JavaScript / TypeScript / TSX adapter.
/// Uses thread-local parsers to avoid per-file allocation overhead.
pub struct TypeScriptAdapter {
    ts_lang: Language,
    js_lang: Language,
}

impl TypeScriptAdapter {
    pub fn new() -> Self {
        Self {
            ts_lang: tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            js_lang: tree_sitter_javascript::LANGUAGE.into(),
        }
    }
}

impl LanguageAdapter for TypeScriptAdapter {
    fn extensions(&self) -> Vec<String> {
        vec!["js".into(), "jsx".into(), "ts".into(), "tsx".into(), "mjs".into(), "cjs".into(), "mts".into(), "cts".into()]
    }

    fn analyze(&self, file_path: &str, source: &str) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        let is_ts = file_path.ends_with(".ts") || file_path.ends_with(".tsx") || file_path.ends_with(".mts") || file_path.ends_with(".cts");
        let lang = if is_ts { self.ts_lang.clone() } else { self.js_lang.clone() };
        let cell = if is_ts { &TS_PARSER } else { &JS_PARSER };

        let tree = cell.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let parser = borrow.get_or_insert_with(|| {
                let mut p = Parser::new();
                p.set_language(&lang).ok();
                p
            });
            parser.parse(source, None)
        });
        let tree = match tree {
            Some(t) => t,
            None => return (vec![], vec![], None),
        };

        // Full dotted path as module ID (aligns with generic TreeSitterAdapter).
        // "src-ui/src/ui/graph.ts" → "src-ui.src.ui.graph_ts"
        // This ensures different directories can have files with the same name.
        let file_id = crate::path_utils::normalize_path(file_path)
            .trim_end_matches('.')
            .replace('/', ".")
            .replace(".ts", "_ts")
            .replace(".tsx", "_tsx")
            .replace(".js", "_js")
            .replace(".jsx", "_jsx")
            .replace(".mjs", "_mjs")
            .replace(".cjs", "_cjs")
            .replace(".mts", "_mts")
            .replace(".cts", "_cts");

        let (nodes, edges) = walk_ts_tree(&tree, source, &file_id, file_path);
        (nodes, edges, Some(tree))
    }
}

fn extract_inherits(node: &tree_sitter::Node, source: &str, nid: &str, file_id: &str, counter: &mut u32, edges: &mut Vec<Edge>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "member_expression" | "property_identifier" => {
                if let Ok(base) = child.utf8_text(source.as_bytes()) {
                    *counter += 1;
                    edges.push(Edge::new(format!("inh_{}_{}", file_id, *counter), nid, base, EdgeKind::Inherits));
                    return;
                }
            }
            _ => {}
        }
    }
}

/// Resolve a relative import path against the current file's directory,
/// returning a dotted module ID consistent with file_id generation.
fn resolve_import_target(import_path: &str, current_file: &str) -> String {
    let trimmed = import_path.trim_matches(|c| c == '\'' || c == '"' || c == '`');
    if trimmed.starts_with("./") || trimmed.starts_with("../") {
        let current_dir = Path::new(current_file).parent().unwrap_or(Path::new("."));
        let resolved = current_dir.join(trimmed);
        let s = normalize_path(&resolved.to_string_lossy());
        // Produce dotted path matching file_id format (replace / with ., drop extension placeholders —
        // the real extension gets appended by the merge/resolver step)
        s.replace('/', ".")
    } else {
        // Bare module import (e.g. 'react', 'lodash') — keep as-is
        trimmed.to_string()
    }
}

fn walk_ts_tree(tree: &tree_sitter::Tree, source: &str, file_id: &str, file_path: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut edge_counter = 0u32;

    // Module node — file-level anchor so edges have a valid source
    nodes.push(Node::new(file_id, file_id, NodeKind::File));

    let root = tree.root_node();
    // Scope stack: each entry is (node, scope_id)
    // scope_id tracks the enclosing function/class for accurate call attribution
    let mut to_visit: Vec<(tree_sitter::Node, String)> = vec![(root, file_id.to_string())];

    while let Some((node, scope_id)) = to_visit.pop() {
        match node.kind() {
            "function_declaration" | "generator_function_declaration"
            | "function_expression" | "generator_function_expression"
            | "method_definition" | "arrow_function" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let nid = format!("{}.{}", file_id, name);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), file_id, &nid, EdgeKind::Defines));
                        nodes.push(Node::new(&nid, name, NodeKind::Function));
                        // Children of this function inherit its scope
                        push_children_with_scope(&node, &nid, &mut to_visit);
                        continue;
                    }
                }
                // Arrow functions / anonymous expressions: no name → no scope tracking.
                // Children inherit the parent scope.
            }
            "class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let nid = format!("{}.{}", file_id, name);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), file_id, &nid, EdgeKind::Defines));
                        nodes.push(Node::new(&nid, name, NodeKind::Class));

                        // extends → inheritance edge
                        // (JS "extends" is nested under "class_heritage", TS is direct field)
                        if let Some(extends) = node.child_by_field_name("extends") {
                            extract_inherits(&extends, source, &nid, file_id, &mut edge_counter, &mut edges);
                        } else {
                            for child in node.children(&mut node.walk()) {
                                if child.kind() == "class_heritage" {
                                    extract_inherits(&child, source, &nid, file_id, &mut edge_counter, &mut edges);
                                }
                            }
                        }
                        push_children_with_scope(&node, &nid, &mut to_visit);
                        continue;
                    }
                }
            }
            "interface_declaration" | "type_alias_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let nid = format!("{}.{}", file_id, name);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), file_id, &nid, EdgeKind::Defines));
                        nodes.push(Node::new(&nid, name, NodeKind::Interface));
                    }
                }
            }
            "import_statement" => {
                if let Some(src_node) = node.child_by_field_name("source") {
                    if let Ok(target) = src_node.utf8_text(source.as_bytes()) {
                        let resolved = resolve_import_target(target, file_path);
                        edge_counter += 1;
                        let mut e = Edge::new(format!("imp_{}_{}", file_id, edge_counter), file_id, &resolved, EdgeKind::Imports);
                        e.cross_file = true;
                        e.coupling_depth = 2;
                        edges.push(e);
                    }
                }
            }
            "call_expression" | "new_expression" => {
                let field = if node.kind() == "new_expression" { "constructor" } else { "function" };
                if let Some(func) = node.child_by_field_name(field) {
                    if let Ok(name) = func.utf8_text(source.as_bytes()) {
                        // ALL calls create edges — no filter.
                        // The old filter (only dot-method or uppercase calls) was
                        // discarding >90% of function calls in TypeScript codebases.
                        edge_counter += 1;
                        let mut e = Edge::new(format!("call_{}_{}", file_id, edge_counter), &scope_id, name, EdgeKind::Calls);
                        e.cross_file = true;
                        e.coupling_depth = 1;
                        edges.push(e);
                    }
                }
            }
            _ => {}
        }
        // Push children with current scope
        push_children_with_scope(&node, &scope_id, &mut to_visit);
    }

    (nodes, edges)
}

/// Push a node's children onto the visit stack, each tagged with the given scope_id.
fn push_children_with_scope<'a>(node: &tree_sitter::Node<'a>, scope_id: &str, to_visit: &mut Vec<(tree_sitter::Node<'a>, String)>) {
    let mut cursor = node.walk();
    let mut children: Vec<tree_sitter::Node<'a>> = node.children(&mut cursor).collect();
    children.reverse(); // so first child is processed first (LIFO stack)
    for child in children {
        to_visit.push((child, scope_id.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_js_function_and_class() {
        let adapter = TypeScriptAdapter::new();
        let src = "function hello() {}\nclass Foo {}\nclass Bar extends Foo {}";
        let (nodes, _edges, _) = adapter.analyze("test.js", src);
        assert!(nodes.iter().any(|n| n.name == "hello"));
        assert!(nodes.iter().any(|n| n.name == "Foo"));
        assert!(nodes.iter().any(|n| n.name == "Bar"));
    }

    #[test]
    fn test_ts_import_and_interface() {
        let adapter = TypeScriptAdapter::new();
        let src = "import { stuff } from './module';\ninterface IUser { name: string }\nexport type ID = string;";
        let (nodes, edges, _) = adapter.analyze("types.ts", src);
        assert!(nodes.iter().any(|n| n.name == "IUser"));
        assert!(nodes.iter().any(|n| n.name == "ID"));
        assert!(edges.iter().any(|e| matches!(e.kind, EdgeKind::Imports)));
    }

    #[test]
    fn test_empty_js() {
        let adapter = TypeScriptAdapter::new();
        let (nodes, _, _) = adapter.analyze("empty.js", "// nothing");
        assert_eq!(nodes.len(), 1); // module node always created
    }

    #[test]
    fn test_regular_function_call_creates_edge() {
        // Bug 1 fix: plain function calls (lowercase, no dot) should create edges
        let adapter = TypeScriptAdapter::new();
        let src = "function foo() {}\nfunction bar() { foo(); }";
        let (nodes, edges, _) = adapter.analyze("test.ts", src);
        assert!(nodes.iter().any(|n| n.name == "foo"));
        assert!(nodes.iter().any(|n| n.name == "bar"));
        let call_edges: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls)).collect();
        assert!(!call_edges.is_empty(), "regular fn call should create edge");
        assert!(call_edges.iter().any(|e| e.target == "foo"), "should find call to foo");
    }

    #[test]
    fn test_call_source_is_enclosing_function() {
        // Bug 4 fix: calls inside a function should originate from that function
        let adapter = TypeScriptAdapter::new();
        let src = "function outer() {\n  inner();\n}\nfunction inner() {}";
        let (_nodes, edges, _) = adapter.analyze("scope.ts", src);
        // Find the call edge to "inner"
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "inner");
        assert!(call.is_some(), "should have call to inner");
        let call = call.unwrap();
        // Source should be outer's node ID, not the file's module ID
        assert!(call.source.contains("outer"), "call source should be 'outer', got '{}'", call.source);
    }

    #[test]
    fn test_file_id_preserves_directory() {
        // Bug 2 fix: file_id should include directory, not just filename
        let adapter = TypeScriptAdapter::new();
        let src = "function hello() {}";
        let (nodes, _, _) = adapter.analyze("src/ui/graph.ts", src);
        let file_node = nodes.iter().find(|n| matches!(n.kind, NodeKind::File));
        assert!(file_node.is_some());
        let fid = &file_node.unwrap().id;
        assert!(fid.contains("src"), "file_id should contain dir, got '{}'", fid);
        assert!(fid.contains("ui"), "file_id should contain subdir, got '{}'", fid);
        assert!(fid.contains("graph_ts"), "file_id should contain filename, got '{}'", fid);
    }

    #[test]
    fn test_no_duplicate_ids_for_same_filename() {
        // Same filename in different directories should produce different IDs
        let adapter = TypeScriptAdapter::new();
        let src = "function foo() {}";
        let (nodes_a, _, _) = adapter.analyze("src/a/util.ts", src);
        let (nodes_b, _, _) = adapter.analyze("src/b/util.ts", src);
        let id_a = nodes_a.iter().find(|n| matches!(n.kind, NodeKind::File)).unwrap().id.clone();
        let id_b = nodes_b.iter().find(|n| matches!(n.kind, NodeKind::File)).unwrap().id.clone();
        assert_ne!(id_a, id_b, "different dirs should have different file IDs: {} vs {}", id_a, id_b);
    }

    #[test]
    fn test_relative_import_resolved_to_path() {
        // Bug 3 fix: relative imports should resolve to dotted path, not raw './foo'
        let adapter = TypeScriptAdapter::new();
        let src = "import { stuff } from './module';\nimport { other } from '../parent/other';";
        let (_, edges, _) = adapter.analyze("src/ui/graph.ts", src);
        let import_edges: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert_eq!(import_edges.len(), 2);
        // './module' should resolve to something containing 'module'
        let module_edge = import_edges.iter().find(|e| e.target.contains("module")).unwrap();
        assert!(!module_edge.target.starts_with("./"), "import target should not be raw './x', got '{}'", module_edge.target);
        // '../parent/other' should resolve with 'parent'
        let parent_edge = import_edges.iter().find(|e| e.target.contains("parent")).unwrap();
        assert!(!parent_edge.target.starts_with("../"), "import target should not be raw '../x', got '{}'", parent_edge.target);
    }

    #[test]
    fn test_new_expression_creates_call_edge() {
        // new Foo() should create a Calls edge
        let adapter = TypeScriptAdapter::new();
        let src = "class Foo {}\nfunction bar() { new Foo(); }";
        let (_, edges, _) = adapter.analyze("newtest.ts", src);
        let calls_to_foo: Vec<_> = edges.iter()
            .filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "Foo")
            .collect();
        assert!(!calls_to_foo.is_empty(), "new Foo() should create a call edge");
    }

    #[test]
    fn test_nested_scope_call_attribution() {
        // Calls in nested functions should be attributed to the innermost function
        let adapter = TypeScriptAdapter::new();
        let src = "function a() {\n  function b() {\n    c();\n  }\n}\nfunction c() {}";
        let (_, edges, _) = adapter.analyze("nested.ts", src);
        let call_to_c = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "c");
        assert!(call_to_c.is_some());
        // The call to c() is inside b(), so source should be b
        assert!(call_to_c.unwrap().source.contains("b"), "nested call should be attributed to innermost fn");
    }
}
