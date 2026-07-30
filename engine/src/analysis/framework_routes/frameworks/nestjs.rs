// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashMap;
use super::super::DetectedRoute;

pub(crate) fn is_nestjs_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".ts") || lower.ends_with(".tsx")
}

pub(crate) fn detect_nestjs_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("ts") { Some(l) => l, None => return result };
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    // NestJS 装饰器及其修饰的成员在 class_body 内是兄弟节点，
    // 不像 Python 中装饰器+定义构成单个节点。
    // 策略：顺序遍历 class_body 子节点，将装饰器与 method_definition 配对。

    let mut controller_prefixes: HashMap<usize, String> = HashMap::new();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        // 捕获每个类的 @Controller 前缀
        if node.kind() == "class_declaration" {
            let start = node.start_byte();
            let mut class_prefix = String::new();
            let mut nc = node.walk();
            for child in node.children(&mut nc) {
                if child.kind() == "decorator" {
                    if let Some(prefix) = extract_nestjs_controller_prefix(&child, source) {
                        class_prefix = prefix;
                    }
                }
            }
            controller_prefixes.insert(start, class_prefix);
        }

        // class_body：装饰器 + method_definition 是兄弟节点——将它们配对
        if node.kind() == "class_body" {
            let parent_prefix = find_parent_controller_prefix(&node, &controller_prefixes);

            let mut nc = node.walk();
            let siblings: Vec<_> = node.children(&mut nc).collect();
            let mut pending_decorator: Option<(String, String)> = None; // (method, sub_path)

            for sib in &siblings {
                if sib.kind() == "decorator" {
                    pending_decorator = extract_nestjs_method_decorator(sib, source);
                } else if sib.kind() == "method_definition" || sib.kind() == "public_field_definition" {
                    let handler_name = sib.child_by_field_name("name")
                        .map(|n| n.utf8_text(source.as_bytes()).unwrap_or("").to_string())
                        .unwrap_or_default();

                    if let Some((method, sub_path)) = pending_decorator.take() {
                        let full_path = format!("{}/{}", parent_prefix.trim_matches('/'), sub_path.trim_matches('/'));
                        let full_path = full_path.trim_matches('/').to_string();
                        let line = sib.start_position().row + 1;
                        result.push((method, format!("/{}", full_path), handler_name, file.to_string(), line));
                    }
                }
            }
            continue; // class_body children are already processed
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    result
}

fn find_parent_controller_prefix(
    node: &tree_sitter::Node,
    prefixes: &HashMap<usize, String>,
) -> String {
    let mut cur = node.parent();
    while let Some(p) = cur {
        if p.kind() == "class_declaration" {
            if let Some(prefix) = prefixes.get(&p.start_byte()) {
                return prefix.clone();
            }
        }
        cur = p.parent();
    }
    String::new()
}

fn extract_nestjs_controller_prefix(decorator: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut dc = decorator.walk();
    for child in decorator.children(&mut dc) {
        if child.kind() == "call_expression" {
            // @Controller('prefix') —— identifier 是直接子节点，不是 field
            let name = find_callee_name(&child, source);
            if name == Some("Controller".to_string()) {
                if let Some(args) = child.child_by_field_name("arguments") {
                    let mut ac = args.walk();
                    for arg in args.children(&mut ac) {
                        if arg.kind() == "string" {
                            return Some(arg.utf8_text(source.as_bytes()).unwrap_or("")
                                .trim_matches(&['\'', '"', '`'][..]).to_string());
                        }
                    }
                }
                return Some(String::new()); // 无前缀的 @Controller()
            }
        }
    }
    None
}

/// 在 call_expression 中查找被调用者名称——查找 identifier 子节点（TS）或
/// `function` field（Python/Java）。
fn find_callee_name(call: &tree_sitter::Node, source: &str) -> Option<String> {
    // 先尝试 field 名称
    if let Some(func) = call.child_by_field_name("function") {
        if func.kind() == "identifier" || func.kind() == "property_identifier" {
            return Some(func.utf8_text(source.as_bytes()).unwrap_or("").to_string());
        }
    }
    // 回退：在直接子节点中查找 identifier
    let mut cc = call.walk();
    for child in call.children(&mut cc) {
        if child.kind() == "identifier" || child.kind() == "property_identifier" {
            return Some(child.utf8_text(source.as_bytes()).unwrap_or("").to_string());
        }
    }
    None
}

fn extract_nestjs_method_decorator(decorator: &tree_sitter::Node, source: &str) -> Option<(String, String)> {
    let methods: HashMap<&str, &str> = [
        ("Get", "GET"), ("Post", "POST"), ("Put", "PUT"), ("Delete", "DELETE"),
        ("Patch", "PATCH"), ("Head", "HEAD"), ("Options", "OPTIONS"), ("All", "ALL"),
    ]
    .iter()
    .cloned()
    .collect();

    let mut dc = decorator.walk();
    for child in decorator.children(&mut dc) {
        if child.kind() == "call_expression" {
            let name = find_callee_name(&child, source)?;
            if let Some(http_method) = methods.get(name.as_str()) {
                let sub_path = if let Some(args) = child.child_by_field_name("arguments") {
                    let mut ac = args.walk();
                    let arg_children: Vec<_> = args.children(&mut ac).collect();
                    arg_children.iter()
                        .find(|a| a.kind() == "string")
                        .map(|a| a.utf8_text(source.as_bytes()).unwrap_or("")
                            .trim_matches(&['\'', '"', '`'][..]).to_string())
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                return Some((http_method.to_string(), sub_path));
            }
        }
    }
    None
}
