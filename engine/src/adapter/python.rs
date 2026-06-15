use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use tree_sitter::Parser;

/// Python adapter using tree-sitter for AST parsing.
/// Creates a fresh parser per analyze() call for thread safety.
pub struct PythonAdapter;

impl PythonAdapter {
    pub fn new() -> Self {
        Self
    }

    fn new_parser() -> Parser {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .expect("failed to load tree-sitter-python grammar");
        parser
    }
}

impl LanguageAdapter for PythonAdapter {
    fn extensions(&self) -> Vec<String> {
        vec!["py".into(), "pyi".into(), "pyx".into()]
    }

    fn analyze(&self, file_path: &str, source: &str) -> (Vec<Node>, Vec<Edge>) {
        let mut parser = Self::new_parser();
        let tree = match parser.parse(source, None) {
            Some(t) => t,
            None => return (vec![], vec![]),
        };

        let file_id = file_path
            .trim_end_matches(".py")
            .replace(['/', '\\'], ".");

        walk_python_tree(&tree, source, &file_id)
    }
}

/// Walk up to find enclosing function/class, fall back to module.
fn enclosing_symbol(node: &tree_sitter::Node, source: &str, module_id: &str) -> String {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_definition" | "async_function_definition" | "class_definition" => {
                if let Some(n) = p.child_by_field_name("name") {
                    if let Ok(name) = n.utf8_text(source.as_bytes()) {
                        return format!("{}.{}", module_id, name);
                    }
                }
            }
            _ => {}
        }
        cur = p.parent();
    }
    module_id.to_string()
}

/// Walk a tree-sitter tree and extract symbols and import edges.
fn walk_python_tree(tree: &tree_sitter::Tree, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut edge_counter = 0u32;

    // Create a file-level module node — all file-scope edges use this as source
    let module_node_id = file_id.to_string();
    nodes.push(Node::new(&module_node_id, file_id, NodeKind::Symbol));

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut to_visit: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "function_definition" | "async_function_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let node_id = format!("{}.{}", file_id, name);
                        let mut n = Node::new(&node_id, name, NodeKind::Symbol);
                        n.properties = serde_json::json!({"kind": "function"});
                        nodes.push(n);
                    }
                }
            }
            "class_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let node_id = format!("{}.{}", file_id, name);
                        let mut n = Node::new(&node_id, name, NodeKind::Symbol);
                        n.properties = serde_json::json!({"kind": "class"});

                        // Extract base classes → inheritance edges
                        if let Some(bases) = node.child_by_field_name("superclasses") {
                            for base in bases.children(&mut cursor) {
                                if let Ok(base_name) = base.utf8_text(source.as_bytes()) {
                                    edge_counter += 1;
                                    edges.push(Edge {
                                        id: format!("inh_{}_{}", node_id, edge_counter),
                                        source: node_id.clone(),
                                        target: format!("{}.{}", file_id, base_name.trim()),
                                        kind: EdgeKind::Inherits,
                                        coupling_depth: 2,
                                        cross_file: false,
                                        direction: "forward".into(),
                                        temporal_delay_sec: None,
                                        medium_node_id: None,
                                    });
                                }
                            }
                        }
                        nodes.push(n);
                    }
                }
            }
            "import_statement" => {
                for child in node.children(&mut cursor) {
                    if child.kind() == "dotted_name" {
                        if let Ok(name) = child.utf8_text(source.as_bytes()) {
                            edge_counter += 1;
                            let mut e = Edge::new(
                                format!("imp_{}_{}", file_id, edge_counter),
                                &module_node_id,
                                name,
                                EdgeKind::Imports,
                            );
                            e.coupling_depth = 1; e.cross_file = true;
                            edges.push(e);
                        }
                    }
                }
            }
            "import_from_statement" => {
                let mut module_name = String::new();
                if let Some(module_node) = node.child_by_field_name("module_name") {
                    if let Ok(name) = module_node.utf8_text(source.as_bytes()) {
                        module_name = name.to_string();
                    }
                }
                for child in node.children(&mut cursor) {
                    if child.kind() == "dotted_name" && child.utf8_text(source.as_bytes()).map_or(false, |n| n != module_name) {
                        if let Ok(name) = child.utf8_text(source.as_bytes()) {
                            edge_counter += 1;
                            let target = if module_name.is_empty() { name.to_string() } else { format!("{}.{}", module_name, name) };
                            let mut e = Edge::new(format!("frm_{}_{}", file_id, edge_counter), &module_node_id, target, EdgeKind::Imports);
                            e.coupling_depth = 2; e.cross_file = true;
                            edges.push(e);
                        }
                    }
                }
            }
            "call" => {
                if let Some(func) = node.child_by_field_name("function") {
                    if let Ok(name) = func.utf8_text(source.as_bytes()) {
                        edge_counter += 1;
                        // Find parent function/class context
                        let parent_id = enclosing_symbol(&node, source, &module_node_id);
                        let mut e = Edge::new(format!("call_{}_{}", file_id, edge_counter), &parent_id, name, EdgeKind::Calls);
                        e.coupling_depth = 1; e.cross_file = true;
                        edges.push(e);
                    }
                }
            }
            _ => {}
        }

        // Push children for BFS
        let mut children: Vec<_> = node.children(&mut cursor).collect();
        // Reverse so we pop in correct order
        children.reverse();
        to_visit.extend(children);
    }

    (nodes, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_function_and_class() {
        let adapter = PythonAdapter::new();
        let source = "def hello():\n    pass\n\nclass Foo:\n    def bar(self):\n        pass\n";
        let (nodes, _edges) = adapter.analyze("test.py", source);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"), "should find function hello");
        assert!(names.contains(&"Foo"), "should find class Foo");
        assert_eq!(nodes.len(), 4, "module + hello fn + Foo class + bar method");
    }

    #[test]
    fn test_import_edges() {
        let adapter = PythonAdapter::new();
        let source = "import os\nfrom django.http import HttpResponse\n";
        let (_nodes, edges) = adapter.analyze("views.py", source);
        // Should have at least the import statement edges
        assert!(edges.iter().any(|e| matches!(e.kind, EdgeKind::Imports)),
            "should create import edges, got {} edges", edges.len());
    }

    #[test]
    fn test_call_edge() {
        let adapter = PythonAdapter::new();
        let source = "def my_view():\n    render()\n";
        let (nodes, edges) = adapter.analyze("views.py", source);
        assert!(nodes.iter().any(|n| n.name == "my_view"), "should find my_view");
        // The call to render() should create a calls edge
        assert!(edges.iter().any(|e| matches!(e.kind, EdgeKind::Calls)),
            "should create call edge, got {} edges", edges.len());
    }

    #[test]
    fn test_empty_and_invalid() {
        let adapter = PythonAdapter::new();
        let (n1, e1) = adapter.analyze("empty.py", "");
        assert_eq!(n1.len(), 1); // module node always created
        assert_eq!(e1.len(), 0);
        let (n2, e2) = adapter.analyze("bad.py", "this is not valid python @@@");
        assert!(n2.len() >= 1);
        assert!(e2.len() >= 0);
    }
}
