// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::cell::RefCell;
use std::path::Path;
use tree_sitter::{Language, Parser};

use crate::adapter::traits::LanguageAdapter;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use crate::path_utils::normalize_path;

thread_local! {
    static TS_PARSER: RefCell<Option<Parser>> = const { RefCell::new(None) };
    static JS_PARSER: RefCell<Option<Parser>> = const { RefCell::new(None) };
}

/// JavaScript / TypeScript / TSX 合并适配器。
/// 使用线程局部 parser 避免逐文件分配开销。
pub struct TypeScriptAdapter {
    ts_lang: Language,
    js_lang: Language,
}

impl Default for TypeScriptAdapter {
    fn default() -> Self {
        Self::new()
    }
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

        // 完整点分路径作为 module ID（与通用 TreeSitterAdapter 对齐）。
        // "src-ui/src/ui/graph.ts" → "src-ui.src.ui.graph_ts"
        // 这确保不同目录下可以有同名文件。
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

/// 将相对 import 路径相对于当前文件所在目录解析，
/// 返回与 file_id 生成格式一致的点分 module ID。
fn resolve_import_target(import_path: &str, current_file: &str) -> String {
    let trimmed = import_path.trim_matches(|c| c == '\'' || c == '"' || c == '`');
    if trimmed.starts_with("./") || trimmed.starts_with("../") {
        let current_dir = Path::new(current_file).parent().unwrap_or(Path::new("."));
        let resolved = current_dir.join(trimmed);
        let s = normalize_path(&resolved.to_string_lossy());
        // 生成与 file_id 格式匹配的点分路径（将 / 替换为 .，去除扩展名占位符 —
        // 真实扩展名由 merge/resolver 步骤追加）
        s.replace('/', ".")
    } else {
        // 裸模块导入（如 'react'、'lodash'）— 保持原样
        trimmed.to_string()
    }
}

fn walk_ts_tree(tree: &tree_sitter::Tree, source: &str, file_id: &str, file_path: &str) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut edge_counter = 0u32;

    // Module 节点 — 文件级锚点，确保边有有效的 source
    nodes.push(Node::new(file_id, file_id, NodeKind::File));

    let root = tree.root_node();
    // 作用域栈：每项为 (node, scope_id)
    // scope_id 追踪外层 function/class，用于准确的 call 归属
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
                        // 此函数的子节点继承其 scope
                        push_children_with_scope(&node, &nid, &mut to_visit);
                        continue;
                    }
                }
                // 箭头函数 / 匿名表达式：无名称 → 不追踪作用域。
                // 子节点继承父级作用域。
            }
            "class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(source.as_bytes()) {
                        let nid = format!("{}.{}", file_id, name);
                        edge_counter += 1;
                        edges.push(Edge::new(format!("def_{}_{}", file_id, edge_counter), file_id, &nid, EdgeKind::Defines));
                        nodes.push(Node::new(&nid, name, NodeKind::Class));

                        // extends → 继承边
                        // （JS "extends" 嵌套在 "class_heritage" 下，TS 为直接字段）
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
                        // 对于 member expression（a.b.c()），仅提取最后的
                        // property 以匹配函数定义。否则
                        // `getChatStore(x).input.getState()` 会创建
                        // target 为 "getChatStore(x).input.getState" 的 calls 边 — 永远无法匹配。
                        let call_target =
                            if func.kind() == "member_expression" {
                                func.child_by_field_name("property")
                                    .and_then(|p| p.utf8_text(source.as_bytes()).ok())
                                    .map(|c| c.to_string())
                                    .unwrap_or_else(|| name.to_string())
                            } else {
                                name.to_string()
                            };
                        edge_counter += 1;
                        let mut e = Edge::new(format!("call_{}_{}", file_id, edge_counter), &scope_id, &call_target, EdgeKind::Calls);
                        e.cross_file = true;
                        e.coupling_depth = 1;
                        edges.push(e);
                    }
                }
            }
            _ => {}
        }
        // 以当前作用域压入子节点
        push_children_with_scope(&node, &scope_id, &mut to_visit);
    }

    (nodes, edges)
}

/// 将节点的子节点压入遍历栈，每个标记为给定的 scope_id。
fn push_children_with_scope<'a>(node: &tree_sitter::Node<'a>, scope_id: &str, to_visit: &mut Vec<(tree_sitter::Node<'a>, String)>) {
    let mut cursor = node.walk();
    let mut children: Vec<tree_sitter::Node<'a>> = node.children(&mut cursor).collect();
    children.reverse(); // 使第一个子节点先处理（LIFO 栈）
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
        assert_eq!(nodes.len(), 1); // module 节点始终创建
    }

    #[test]
    fn test_regular_function_call_creates_edge() {
        // Bug 1 修复：普通函数调用（小写，无点号）应创建边
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
        // Bug 4 修复：函数内部的调用应源自该函数
        let adapter = TypeScriptAdapter::new();
        let src = "function outer() {\n  inner();\n}\nfunction inner() {}";
        let (_nodes, edges, _) = adapter.analyze("scope.ts", src);
        // 查找指向 "inner" 的 call 边
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "inner");
        assert!(call.is_some(), "should have call to inner");
        let call = call.unwrap();
        // Source 应为 outer 的 node ID，而非文件的 module ID
        assert!(call.source.contains("outer"), "call source should be 'outer', got '{}'", call.source);
    }

    #[test]
    fn test_file_id_preserves_directory() {
        // Bug 2 修复：file_id 应包含目录，而非仅文件名
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
        // 不同目录下的同名文件应产生不同的 ID
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
        // Bug 3 修复：相对 import 应解析为点分路径，而非原始 './foo'
        let adapter = TypeScriptAdapter::new();
        let src = "import { stuff } from './module';\nimport { other } from '../parent/other';";
        let (_, edges, _) = adapter.analyze("src/ui/graph.ts", src);
        let import_edges: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert_eq!(import_edges.len(), 2);
        // './module' 应解析为包含 'module' 的内容
        let module_edge = import_edges.iter().find(|e| e.target.contains("module")).unwrap();
        assert!(!module_edge.target.starts_with("./"), "import target should not be raw './x', got '{}'", module_edge.target);
        // '../parent/other' 应解析为包含 'parent' 的内容
        let parent_edge = import_edges.iter().find(|e| e.target.contains("parent")).unwrap();
        assert!(!parent_edge.target.starts_with("../"), "import target should not be raw '../x', got '{}'", parent_edge.target);
    }

    #[test]
    fn test_new_expression_creates_call_edge() {
        // new Foo() 应创建 Calls 边
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
        // 嵌套函数中的调用应归属于最内层函数
        let adapter = TypeScriptAdapter::new();
        let src = "function a() {\n  function b() {\n    c();\n  }\n}\nfunction c() {}";
        let (_, edges, _) = adapter.analyze("nested.ts", src);
        let call_to_c = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "c");
        assert!(call_to_c.is_some());
        // 对 c() 的调用在 b() 内部，因此 source 应为 b
        assert!(call_to_c.unwrap().source.contains("b"), "nested call should be attributed to innermost fn");
    }
}
