// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use std::cell::RefCell;
use tree_sitter::{Language, Parser};

// Thread-local parser cache — reuses parser across files of the same language.
// Avoids Parser::new() + set_language() allocation overhead for thousands of files.
thread_local! {
    static TL_PARSER: RefCell<Option<(Parser, String)>> = RefCell::new(None);
}

/// Generic tree-sitter adapter covering all languages beyond Python and JS/TS.
/// Each language is matched explicitly due to inconsistent crate APIs.
pub struct TreeSitterAdapter;

impl TreeSitterAdapter {
    pub fn new() -> Self { Self }

    fn parse_ext(ext: &str, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        // Two macro variants because tree-sitter crates use 3 different API patterns:
        //   do_parse!    → $crate::LANGUAGE         (old-style static const)
        //   do_parse_fn! → $crate::language()       (function returning Language)
        //   do_parse_k!  → $crate::$const.into()    (named LanguageFn constant)
        macro_rules! do_parse { ($ts_crate:ident, $lang_key:expr) => {{
            let lang: Language = $ts_crate::LANGUAGE.into();
            parse_with_lang(lang, $lang_key, source, file_id)
        }}; }
        macro_rules! do_parse_k { ($ts_crate:ident, $konst:ident, $lang_key:expr) => {{
            let lang: Language = $ts_crate::$konst.into();
            parse_with_lang(lang, $lang_key, source, file_id)
        }}; }

        match ext {
            // ── old-style: LANGUAGE const ──
            "go" => do_parse!(tree_sitter_go, "go"),
            "rs" => do_parse!(tree_sitter_rust, "rs"),
            "java" => do_parse!(tree_sitter_java, "java"),
            "c" | "h" => do_parse!(tree_sitter_c, "c"),
            "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => do_parse!(tree_sitter_cpp, "cpp"),
            "rb" => do_parse!(tree_sitter_ruby, "rb"),
            "lua" => do_parse!(tree_sitter_lua, "lua"),
            "cs" => do_parse!(tree_sitter_c_sharp, "cs"),
            "swift" => do_parse!(tree_sitter_swift, "swift"),
            "dart" => do_parse!(tree_sitter_dart, "dart"),
            "scala" | "sc" => do_parse!(tree_sitter_scala, "scala"),
            "hs" => do_parse!(tree_sitter_haskell, "hs"),
            "json" => do_parse!(tree_sitter_json, "json"),
            "html" | "htm" => do_parse!(tree_sitter_html, "html"),
            "css" => do_parse!(tree_sitter_css, "css"),
            "r" | "R" => do_parse!(tree_sitter_r, "r"),
            "nix" => do_parse!(tree_sitter_nix, "nix"),
            "sh" | "bash" => do_parse!(tree_sitter_bash, "bash"),
            "yaml" | "yml" => do_parse!(tree_sitter_yaml, "yaml"),
            "zig" => do_parse!(tree_sitter_zig, "zig"),
            "ex" | "exs" => do_parse!(tree_sitter_elixir, "elixir"),
            "erl" | "hrl" => do_parse!(tree_sitter_erlang, "erlang"),
            // ── new-style: named LanguageFn constants ──
            "php" => do_parse_k!(tree_sitter_php, LANGUAGE_PHP, "php"),
            "ml" => do_parse_k!(tree_sitter_ocaml, LANGUAGE_OCAML, "ocaml"),
            "mli" => do_parse_k!(tree_sitter_ocaml, LANGUAGE_OCAML_INTERFACE, "ocaml_interface"),
            _ => (vec![], vec![], None),
        }
    }
}

/// Shared parse driver — reused by all macro variants above.
fn parse_with_lang(lang: Language, lang_key: &str, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
    TL_PARSER.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let reuse = borrow.as_ref().map_or(false, |(_, cached)| cached == lang_key);
        if !reuse {
            let mut p = Parser::new();
            if p.set_language(&lang).is_err() {
                return (vec![], vec![], None);
            }
            *borrow = Some((p, lang_key.to_string()));
        }
        let (ref mut parser, _) = borrow.as_mut().unwrap();
        match parser.parse(source, None) {
            Some(t) => {
                let (nodes, edges) = generic_walk(&t, source, file_id);
                (nodes, edges, Some(t))
            }
            None => (vec![], vec![], None),
        }
    })
}

impl LanguageAdapter for TreeSitterAdapter {
    fn extensions(&self) -> Vec<String> {
        vec!["go","rs","java","c","h","cpp","hpp","cc","hh","cxx","hxx","rb","lua",
            "cs","swift","dart","scala","sc","hs","json","html","htm","css",
            "php","ml","mli","r","R","nix","sh","bash",
            "yaml","yml","zig","ex","exs","erl","hrl"]
            .into_iter().map(|s| s.into()).collect()
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
