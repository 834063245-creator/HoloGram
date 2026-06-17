use tree_sitter::Parser;

use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};

/// Combined JavaScript / TypeScript / TSX adapter.
pub struct TypeScriptAdapter {
    ts_lang: tree_sitter::Language,
    js_lang: tree_sitter::Language,
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

    fn analyze(&self, file_path: &str, source: &str) -> (Vec<Node>, Vec<Edge>) {
        let lang = if file_path.ends_with(".ts") || file_path.ends_with(".tsx") || file_path.ends_with(".mts") || file_path.ends_with(".cts") {
            &self.ts_lang
        } else {
            &self.js_lang
        };

        let mut parser = Parser::new();
        parser.set_language(&lang).ok();
        let tree = match parser.parse(source, None) {
            Some(t) => t,
            None => return (vec![], vec![]),
        };

        let file_id = file_path
            .trim_end_matches(|c| matches!(c, '.'))
            .rsplit(|c| c == '/' || c == '\\')
            .next()
            .unwrap_or(file_path)
            .replace('.', "_");

        walk_ts_tree(&tree, source, &file_id)
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

fn walk_ts_tree(tree: &tree_sitter::Tree, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut edge_counter = 0u32;

    // Module node — file-level anchor so edges have a valid source
    nodes.push(Node::new(file_id, file_id, NodeKind::File));

    let root = tree.root_node();
    let cursor = &mut root.walk();
    let mut to_visit = vec![root];

    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "function_declaration" | "generator_function_declaration"
            | "method_definition" | "arrow_function" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let nid = format!("{}.{}", file_id, name);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), file_id, &nid, EdgeKind::Defines));
                        nodes.push(Node::new(&nid, name, NodeKind::Function));
                    }
                }
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
                        // We handle both: try field first, then child node
                        if let Some(extends) = node.child_by_field_name("extends") {
                            extract_inherits(&extends, source, &nid, file_id, &mut edge_counter, &mut edges);
                        } else {
                            // JS: look for class_heritage child
                            for child in node.children(&mut node.walk()) {
                                if child.kind() == "class_heritage" {
                                    extract_inherits(&child, source, &nid, file_id, &mut edge_counter, &mut edges);
                                }
                            }
                        }
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
                        let target = target.trim_matches(&['\'', '"', '`'][..]);
                        edge_counter += 1;
                        let mut e = Edge::new(format!("imp_{}_{}", file_id, edge_counter), file_id, target, EdgeKind::Imports);
                        e.cross_file = true;
                        e.coupling_depth = 2;
                        edges.push(e);
                    }
                }
            }
            "call_expression" => {
                if let Some(func) = node.child_by_field_name("function") {
                    if let Ok(name) = func.utf8_text(source.as_bytes()) {
                        if name.contains('.') || name.chars().next().map_or(false, |c| c.is_uppercase()) {
                            edge_counter += 1;
                            let mut e = Edge::new(format!("call_{}_{}", file_id, edge_counter), file_id, name, EdgeKind::Calls);
                            e.cross_file = true;
                            e.coupling_depth = 1;
                            edges.push(e);
                        }
                    }
                }
            }
            _ => {}
        }
        let mut children: Vec<_> = node.children(cursor).collect();
        children.reverse();
        to_visit.extend(children);
    }

    (nodes, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_js_function_and_class() {
        let adapter = TypeScriptAdapter::new();
        let src = "function hello() {}\nclass Foo {}\nclass Bar extends Foo {}";
        let (nodes, edges) = adapter.analyze("test.js", src);
        assert!(nodes.iter().any(|n| n.name == "hello"));
        assert!(nodes.iter().any(|n| n.name == "Foo"));
        assert!(nodes.iter().any(|n| n.name == "Bar"));
    }

    #[test]
    fn test_ts_import_and_interface() {
        let adapter = TypeScriptAdapter::new();
        let src = "import { stuff } from './module';\ninterface IUser { name: string }\nexport type ID = string;";
        let (nodes, edges) = adapter.analyze("types.ts", src);
        assert!(nodes.iter().any(|n| n.name == "IUser"));
        assert!(nodes.iter().any(|n| n.name == "ID"));
        assert!(edges.iter().any(|e| matches!(e.kind, EdgeKind::Imports)));
    }

    #[test]
    fn test_empty_js() {
        let adapter = TypeScriptAdapter::new();
        let (nodes, _) = adapter.analyze("empty.js", "// nothing");
        assert_eq!(nodes.len(), 1); // module node always created
    }
}
