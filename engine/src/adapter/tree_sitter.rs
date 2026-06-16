use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use tree_sitter::Parser;

/// Generic tree-sitter adapter covering all languages beyond Python and JS/TS.
/// Each language is matched explicitly due to inconsistent crate APIs.
pub struct TreeSitterAdapter;

impl TreeSitterAdapter {
    pub fn new() -> Self { Self }

    fn parse_ext(ext: &str, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>) {
        macro_rules! do_parse { ($ts_crate:ident) => {{
            let lang: tree_sitter::Language = $ts_crate::LANGUAGE.into();
            let mut p = Parser::new();
            if p.set_language(&lang).is_err() { return (vec![], vec![]); }
            match p.parse(source, None) { Some(t) => generic_walk(&t, source, file_id), None => (vec![], vec![]) }
        }}; }

        match ext {
            "go" => do_parse!(tree_sitter_go),
            "rs" => do_parse!(tree_sitter_rust),
            "java" => do_parse!(tree_sitter_java),
            "c" | "h" => do_parse!(tree_sitter_c),
            "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => do_parse!(tree_sitter_cpp),
            "rb" => do_parse!(tree_sitter_ruby),
            "lua" => do_parse!(tree_sitter_lua),
            _ => (vec![], vec![]),
        }
    }
}

impl LanguageAdapter for TreeSitterAdapter {
    fn extensions(&self) -> Vec<String> {
        vec!["go","rs","java","c","h","cpp","hpp","cc","hh","cxx","hxx","rb","lua"]
            .into_iter().map(|s| s.into()).collect()
    }

    fn analyze(&self, file_path: &str, source: &str) -> (Vec<Node>, Vec<Edge>) {
        let ext = file_path.rsplit('.').next().unwrap_or("");
        Self::parse_ext(ext, source, file_path)
    }
}

fn generic_walk(tree: &tree_sitter::Tree, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut counter = 0u32;
    let module_id = file_id.replace(['/', '\\'], ".");
    nodes.push(Node::new(&module_id, file_id, NodeKind::Symbol));

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut queue: Vec<tree_sitter::Node> = root.children(&mut cursor).collect();

    let func_kinds = ["function_definition","function_declaration","method_definition","function_item","func_declaration",
        "constructor_declaration","arrow_function","generator_function"];
    let class_kinds = ["class_definition","class_declaration","struct_declaration",
        "interface_declaration","trait_declaration","enum_declaration","type_alias_declaration"];
    let import_kinds = ["import_statement","import_declaration","use_declaration","include_directive","require_statement"];
    let call_kinds = ["call_expression","function_call","method_invocation"];

    while let Some(node) = queue.pop() {
        let kind = node.kind();
        if func_kinds.contains(&kind) || class_kinds.contains(&kind) {
            if let Some(nn) = node.child_by_field_name("name") {
                if let Ok(name) = nn.utf8_text(source.as_bytes()) {
                    let nid = format!("{}.{}", module_id, name);
                    nodes.push(Node::new(&nid, name, NodeKind::Symbol));
                    for f in &["extends","implements","base_classes"] {
                        if let Some(b) = node.child_by_field_name(f) {
                            if let Ok(bn) = b.utf8_text(source.as_bytes()) {
                                for p in bn.split(',') { let t = p.trim(); if !t.is_empty() {
                                    counter+=1; edges.push(Edge::new(format!("inh_{}_{}", file_id, counter), &nid, t, EdgeKind::Inherits));
                                }}
                            }
                        }
                    }
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
            if let Some(func_node) = node.child_by_field_name("function") {
                if let Ok(fn_name) = func_node.utf8_text(source.as_bytes()) {
                    counter+=1; let mut e = Edge::new(format!("call_{}_{}", file_id, counter), &module_id, fn_name, EdgeKind::Calls);
                    e.cross_file=true; edges.push(e);
                }
            }
        }
        let mut children: Vec<_> = node.children(&mut cursor).collect();
        children.reverse(); queue.extend(children);
    }
    (nodes, edges)
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
        let (nodes, edges) = a.analyze("main.go", src);
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
        let (nodes, edges) = a.analyze("main.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"));
        assert!(names.contains(&"add"));
    }

    #[test]
    fn test_analyze_unknown_extension() {
        let a = TreeSitterAdapter;
        let (nodes, _edges) = a.analyze("main.xyz", "content");
        assert!(nodes.is_empty(), "unknown extension should return empty");
    }

    #[test]
    fn test_analyze_empty_source() {
        let a = TreeSitterAdapter;
        let (nodes, edges) = a.analyze("main.go", "");
        // Should have the module node at minimum
        assert!(nodes.len() >= 1, "should have at least module node");
        assert!(edges.is_empty());
    }

    #[test]
    fn test_analyze_modules_have_unique_ids() {
        let a = TreeSitterAdapter;
        let (nodes1, _) = a.analyze("src/a.go", "package a");
        let (nodes2, _) = a.analyze("src/b.go", "package b");
        let id1 = &nodes1[0].id;
        let id2 = &nodes2[0].id;
        assert_ne!(id1, id2, "different files should have different module IDs");
    }
}
