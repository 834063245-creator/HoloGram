// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use std::cell::RefCell;
use tree_sitter::Parser;

thread_local! {
    static PY_PARSER: RefCell<Option<Parser>> = const { RefCell::new(None) };
}

/// Python adapter，使用 tree-sitter 进行 AST 解析。
/// 使用线程局部 parser 避免逐文件分配开销。
pub struct PythonAdapter;

impl Default for PythonAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl PythonAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl LanguageAdapter for PythonAdapter {
    fn extensions(&self) -> Vec<String> {
        vec!["py".into(), "pyi".into(), "pyx".into()]
    }

    fn analyze(&self, file_path: &str, source: &str) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        let tree = PY_PARSER.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let parser = borrow.get_or_insert_with(|| {
                let mut p = Parser::new();
                p.set_language(&tree_sitter_python::LANGUAGE.into())
                    .expect("failed to load tree-sitter-python grammar");
                p
            });
            parser.parse(source, None)
        });
        let tree = match tree {
            Some(t) => t,
            None => return (vec![], vec![], None),
        };

        let file_id = file_path
            .trim_end_matches(".py")
            .replace(['/', '\\'], ".");

        let (nodes, edges) = walk_python_tree(&tree, source, &file_id);
        (nodes, edges, Some(tree))
    }
}

/// 向上遍历查找外层 function/class，回退到 module。
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

/// 遍历 tree-sitter tree 并提取符号和 import 边。
fn walk_python_tree(tree: &tree_sitter::Tree, source: &str, file_id: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut edge_counter = 0u32;

    // 创建文件级 module 节点 — 所有文件作用域的边以此作为 source
    let module_node_id = file_id.to_string();
    nodes.push(Node::new(&module_node_id, file_id, NodeKind::File));

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut to_visit: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = to_visit.pop() {
        match node.kind() {
            "function_definition" | "async_function_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let node_id = format!("{}.{}", file_id, name);
                        let n = Node::new(&node_id, name, NodeKind::Function);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), &module_node_id, &node_id, EdgeKind::Defines));
                        nodes.push(n);
                    }
                }
            }
            "class_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let node_id = format!("{}.{}", file_id, name);
                        let n = Node::new(&node_id, name, NodeKind::Class);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), &module_node_id, &node_id, EdgeKind::Defines));

                        // 提取基类 → 继承边
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
                                        temporal_delay_sec: None,
                                        lsp_resolved: false,
                                        is_synthesized: false,
                                        metadata: None,
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
                    if child.kind() == "dotted_name" && child.utf8_text(source.as_bytes()).is_ok_and(|n| n != module_name) {
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
                        // 查找父级 function/class 上下文
                        let parent_id = enclosing_symbol(&node, source, &module_node_id);
                        let mut e = Edge::new(format!("call_{}_{}", file_id, edge_counter), &parent_id, name, EdgeKind::Calls);
                        e.coupling_depth = 1; e.cross_file = true;
                        edges.push(e);
                    }
                }
            }
            _ => {}
        }

        // 将子节点压入栈以进行 BFS
        let mut children: Vec<_> = node.children(&mut cursor).collect();
        // 反转以便按正确顺序弹出
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
        let (nodes, _edges, _) = adapter.analyze("test.py", source);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"), "should find function hello");
        assert!(names.contains(&"Foo"), "should find class Foo");
        assert_eq!(nodes.len(), 4, "module + hello fn + Foo class + bar method");
    }

    #[test]
    fn test_import_edges() {
        let adapter = PythonAdapter::new();
        let source = "import os\nfrom django.http import HttpResponse\n";
        let (_nodes, edges, _) = adapter.analyze("views.py", source);
        // 至少应有 import 语句的边
        assert!(edges.iter().any(|e| matches!(e.kind, EdgeKind::Imports)),
            "should create import edges, got {} edges", edges.len());
    }

    #[test]
    fn test_call_edge() {
        let adapter = PythonAdapter::new();
        let source = "def my_view():\n    render()\n";
        let (nodes, edges, _) = adapter.analyze("views.py", source);
        assert!(nodes.iter().any(|n| n.name == "my_view"), "should find my_view");
        // 对 render() 的调用应创建 calls 边
        assert!(edges.iter().any(|e| matches!(e.kind, EdgeKind::Calls)),
            "should create call edge, got {} edges", edges.len());
    }

    #[test]
    fn test_empty_and_invalid() {
        let adapter = PythonAdapter::new();
        let (n1, e1, _) = adapter.analyze("empty.py", "");
        assert_eq!(n1.len(), 1); // module 节点始终创建
        assert_eq!(e1.len(), 0);
        let (n2, e2, _) = adapter.analyze("bad.py", "this is not valid python @@@");
        assert!(!n2.is_empty());
        let _ = e2; // 解析失败时边可能为空
    }
}