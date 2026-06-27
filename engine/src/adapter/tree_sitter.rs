// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use std::cell::RefCell;
use crate::engine::GRAMMAR_LOADER;
use tree_sitter::{Language, Parser};

// Thread-local parser cache — reuses parser across files of the same language.
// Avoids Parser::new() + set_language() allocation overhead for thousands of files.
thread_local! {
    // ponytail: cached (Parser, Language, ext). Language is stored so GRAMMAR_LOADER
    // RwLock is hit only once per extension per thread, not once per file.
    static TL_PARSER: RefCell<Option<(Parser, Language, String)>> = RefCell::new(None);
}

/// Generic tree-sitter adapter covering all languages beyond Python and JS/TS.
/// Each language is matched explicitly due to inconsistent crate APIs.
pub struct TreeSitterAdapter;

impl TreeSitterAdapter {
    pub fn new() -> Self { Self }

    fn parse_ext(ext: &str, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        TL_PARSER.with(|cell| {
            let mut borrow = cell.borrow_mut();
            // ponytail: resolve Language inside the TL cache check.
            // GrammarLoader commit (d3d373d) moved per-file Language resolution through
            // RwLock<HashMap> — 1468 files × 6 threads contending = memory barrier storm.
            // Cache Language in TL_PARSER so GRAMMAR_LOADER is called once per extension
            // per thread (~10 calls total instead of 1468×6).
            let reuse = borrow.as_ref().map_or(false, |(_, _, cached_ext)| cached_ext == ext);
            if !reuse {
                let lang = match GRAMMAR_LOADER.get(ext) {
                    Some(l) => l,
                    None => return (vec![], vec![], None),
                };
                let mut p = Parser::new();
                if p.set_language(&lang).is_err() {
                    return (vec![], vec![], None);
                }
                *borrow = Some((p, lang, ext.to_string()));
            }
            let (ref mut parser, _, _) = borrow.as_mut().unwrap();
            match parser.parse(source, None) {
                Some(t) => {
                    let (nodes, edges) = generic_walk(&t, source, file_id);
                    (nodes, edges, Some(t))
                }
                None => (vec![], vec![], None),
            }
        })
    }
}

impl LanguageAdapter for TreeSitterAdapter {
    fn extensions(&self) -> Vec<String> {
        GRAMMAR_LOADER.supported_extensions()
    }

    fn analyze(&self, file_path: &str, source: &str) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        let ext = file_path.rsplit('.').next().unwrap_or("");
        Self::parse_ext(ext, source, file_path)
    }
}

fn generic_walk(tree: &tree_sitter::Tree, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut counter = 0u32;
    let module_id = file_id.replace(['/', '\\'], ".");
    nodes.push(Node::new(&module_id, file_id, NodeKind::File));

    let root = tree.root_node();
    // Scope stack: (node, scope_id) — tracks enclosing function/class for accurate call attribution
    let mut to_visit: Vec<(tree_sitter::Node, String)> = vec![(root, module_id.clone())];

    let func_kinds: &[&str] = &["function_definition","function_declaration","method_definition","function_item","func_declaration",
        "constructor_declaration","arrow_function","generator_function","function_expression","generator_function_expression"];
    let class_kinds: &[&str] = &["class_definition","class_declaration","struct_declaration",
        "interface_declaration","trait_declaration","enum_declaration","type_alias_declaration"];
    let import_kinds: &[&str] = &["import_statement","import_declaration","use_declaration","include_directive","require_statement"];
    let call_kinds: &[&str] = &["call_expression","function_call","method_invocation","new_expression"];

    while let Some((node, scope_id)) = to_visit.pop() {
        let kind = node.kind();
        if func_kinds.contains(&kind) || class_kinds.contains(&kind) {
            // ponytail: tree-sitter-c puts function name under declarator→identifier, not "name" field
            let name_node = node.child_by_field_name("name").or_else(|| {
                let decl = node.child_by_field_name("declarator")?;
                let mut cursor = decl.walk();
                let found = decl.children(&mut cursor).find(|c| c.kind() == "identifier");
                found
            });
            if let Some(nn) = name_node {
                if let Ok(name) = nn.utf8_text(source.as_bytes()) {
                    let nid = format!("{}.{}", module_id, name);
                    let nkind = if func_kinds.contains(&kind) {
                        NodeKind::Function
                    } else if ["interface_declaration","trait_declaration","type_alias_declaration"].contains(&kind) {
                        NodeKind::Interface
                    } else {
                        NodeKind::Class
                    };
                    counter+=1; edges.push(Edge::new(format!("def_{}_{}", file_id, counter), &module_id, &nid, EdgeKind::Defines));
                    nodes.push(Node::new(&nid, name, nkind));
                    for f in &["extends","implements","base_classes"] {
                        if let Some(b) = node.child_by_field_name(f) {
                            if let Ok(bn) = b.utf8_text(source.as_bytes()) {
                                for p in bn.split(',') { let t = p.trim(); if !t.is_empty() {
                                    counter+=1; edges.push(Edge::new(format!("inh_{}_{}", file_id, counter), &nid, t, EdgeKind::Inherits));
                                }}
                            }
                        }
                    }
                    // Children inherit this function/class as scope
                    push_children_with_scope(&node, &nid, &mut to_visit);
                    continue;
                }
            }
        }
        if import_kinds.contains(&kind) {
            let mut ec = node.walk();
            for child in node.children(&mut ec) {
                let ck = child.kind();
                if ck.contains("string")||ck.contains("path")||ck.contains("name")||ck.contains("identifier")||ck.contains("scoped") {
                    if let Ok(t) = child.utf8_text(source.as_bytes()) {
                        let t = t.trim_matches(&['\'','"','`','(',')'][..]);
                        if !t.is_empty() && t != file_id {
                            counter+=1; let mut e = Edge::new(format!("imp_{}_{}", file_id, counter), &module_id, t, EdgeKind::Imports);
                            e.cross_file=true; edges.push(e);
                        }
                    }
                }
            }
        }
        if call_kinds.contains(&kind) {
            let field = if kind == "new_expression" { "constructor" } else { "function" };
            if let Some(func_node) = node.child_by_field_name(field) {
                if let Ok(fn_name) = func_node.utf8_text(source.as_bytes()) {
                    counter+=1; let mut e = Edge::new(format!("call_{}_{}", file_id, counter), &scope_id, fn_name, EdgeKind::Calls);
                    e.cross_file=true; edges.push(e);
                }
            }
        }
        // Push children with current scope
        push_children_with_scope(&node, &scope_id, &mut to_visit);
    }
    (nodes, edges)
}

#[cfg(test)]
fn dump_ast(node: &tree_sitter::Node, source: &str, depth: usize) {
    let indent = "  ".repeat(depth);
    let text = node.utf8_text(source.as_bytes()).unwrap_or("?").chars().take(60).collect::<String>();
    eprintln!("{}[{}] {:?}", indent, node.kind(), text);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        dump_ast(&child, source, depth + 1);
    }
}

/// Push a node's children onto the visit stack, each tagged with the given scope_id.
fn push_children_with_scope<'a>(node: &tree_sitter::Node<'a>, scope_id: &str, to_visit: &mut Vec<(tree_sitter::Node<'a>, String)>) {
    let mut cursor = node.walk();
    let mut children: Vec<tree_sitter::Node<'a>> = node.children(&mut cursor).collect();
    children.reverse();
    for child in children {
        to_visit.push((child, scope_id.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_adapter_extensions() {
        let a = TreeSitterAdapter::new();
        let exts = a.extensions();
        assert!(exts.contains(&"go".to_string()));
        assert!(exts.contains(&"rs".to_string()));
        assert!(exts.contains(&"java".to_string()));
        assert!(exts.contains(&"cpp".to_string()));
        assert!(exts.contains(&"rb".to_string()));
        assert!(exts.contains(&"lua".to_string()));
        assert!(exts.contains(&"cs".to_string()));
        assert!(exts.contains(&"swift".to_string()));
        assert!(exts.contains(&"json".to_string()));
        assert!(exts.contains(&"html".to_string()));
        assert!(exts.contains(&"css".to_string()));
        assert!(exts.contains(&"hs".to_string()));
        assert!(exts.contains(&"dart".to_string()));
        assert!(exts.contains(&"scala".to_string()));
    }

    #[test]
    fn test_analyze_go_function() {
        let a = TreeSitterAdapter;
        let src = r#"
package main

import "fmt"

func main() {
    fmt.Println("hello")
}
"#;
        let (nodes, _edges, _) = a.analyze("main.go", src);
        // Should find at least the module node + main function
        assert!(nodes.len() >= 2, "expected module + at least one function");
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"main"), "should find main function");
    }

    #[test]
    fn test_analyze_rust_function() {
        let a = TreeSitterAdapter;
        let src = r#"
fn hello() {
    println!("hello");
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
"#;
        let (nodes, _edges, _) = a.analyze("main.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"));
        assert!(names.contains(&"add"));
    }

    #[test]
    fn test_analyze_unknown_extension() {
        let a = TreeSitterAdapter;
        let (nodes, _edges, _) = a.analyze("main.xyz", "content");
        assert!(nodes.is_empty(), "unknown extension should return empty");
    }

    #[test]
    fn test_analyze_empty_source() {
        let a = TreeSitterAdapter;
        let (nodes, edges, _) = a.analyze("main.go", "");
        // Should have the module node at minimum
        assert!(nodes.len() >= 1, "should have at least module node");
        assert!(edges.is_empty());
    }

    #[test]
    fn test_analyze_modules_have_unique_ids() {
        let a = TreeSitterAdapter;
        let (nodes1, _, _) = a.analyze("src/a.go", "package a");
        let (nodes2, _, _) = a.analyze("src/b.go", "package b");
        let id1 = &nodes1[0].id;
        let id2 = &nodes2[0].id;
        assert_ne!(id1, id2, "different files should have different module IDs");
    }

    #[test]
    fn test_analyze_csharp_smoke() {
        // Smoke test: C# grammar loads and parses without panic
        let a = TreeSitterAdapter;
        let (_nodes, _edges, _) = a.analyze("Service.cs", "class UserService {}");
    }

    #[test]
    fn test_analyze_swift_smoke() {
        // Smoke test: Swift grammar loads and parses without panic
        let a = TreeSitterAdapter;
        let (_nodes, _edges, _) = a.analyze("App.swift", "func greet() {}");
    }

    #[test]
    fn test_analyze_kotlin_pending() {
        // tree-sitter-kotlin pending 0.23+ upgrade (C symbol clash)
        let a = TreeSitterAdapter;
        let (nodes, _, _) = a.analyze("Main.kt", "fun main() {}");
        assert!(nodes.is_empty(), "kt not yet wired — pending grammar upgrade");
    }

    #[test]
    fn test_analyze_json() {
        let a = TreeSitterAdapter;
        let src = "{\"name\": \"test\", \"version\": \"1.0\"}";
        let (nodes, _, _) = a.analyze("config.json", src);
        // JSON doesn't have functions/classes, but should have module node
        assert!(nodes.len() >= 1, "should have at least module node");
    }

    #[test]
    fn test_analyze_bash_skipped() {
        // Temporarily skipped — tree-sitter-bash needs cross-version FFI bridge
    }

    #[test]
    fn test_analyze_c_function() {
        let a = TreeSitterAdapter;
        let src = "int add(int a, int b) { return a + b; }\nint main(void) { return add(1, 2); }";
        let (nodes, edges, tree) = a.analyze("test.c", src);
        eprintln!("C test: {} nodes, {} edges", nodes.len(), edges.len());
        for n in &nodes { eprintln!("  node: id={} name={} kind={}", n.id, n.name, n.kind.as_str()); }
        for e in &edges { eprintln!("  edge: {} -> {} kind={}", e.source, e.target, e.kind.as_str()); }
        // Dump tree-sitter AST to diagnose missing function_definition nodes
        if let Some(tree) = &tree {
            let root = tree.root_node();
            eprintln!("AST root: {} has_error={}", root.kind(), root.has_error());
            dump_ast(&root, src, 0);
        }
        assert!(nodes.len() >= 3, "should have module + add + main functions");
        assert!(edges.len() >= 3, "should have 2 defines + 1 call edge");
    }

    #[test]
    fn test_rust_call_source_is_enclosing_function() {
        // Scope tracking: calls inside a function should originate from that function
        let a = TreeSitterAdapter;
        let src = r#"
fn helper() {}

fn outer() {
    helper();
}
"#;
        let (_nodes, edges, _) = a.analyze("main.rs", src);
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "helper");
        assert!(call.is_some(), "should have call to helper");
        let call = call.unwrap();
        // Source should be outer's node ID, not the file's module ID
        assert!(call.source.contains("outer"), "call source should be 'outer', got '{}'", call.source);
    }
}
