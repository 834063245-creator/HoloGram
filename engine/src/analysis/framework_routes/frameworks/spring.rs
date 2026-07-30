// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_spring_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".java") || lower.ends_with(".kt")
}

/// 检测 Spring `@GetMapping("/path")`、`@PostMapping`、`@RequestMapping(...)` 注解。
///
/// D1：类级 `@RequestMapping` 前缀与方法级路径合并。
/// 例如类 `@RequestMapping("/api")` + 方法 `@GetMapping("/users")` → `/api/users`。
/// 类级注解本身不产生路由——它仅作为前缀。
pub(crate) fn detect_spring_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    // 确定语言
    let is_kotlin = file.ends_with(".kt") || file.ends_with(".kts");
    let lang: tree_sitter::Language = if is_kotlin {
        // Kotlin tree-sitter 尚未接入，跳过
        return result;
    } else {
        match GRAMMAR_LOADER.get("java") { Some(l) => l, None => return result }
    };

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    // 栈携带 (node, class_prefix) —— class_prefix 是来自
    // 外层 class 声明的 @RequestMapping 路径（无则为空）。
    let mut stack: Vec<(tree_sitter::Node<'_>, String)> = vec![(root, String::new())];

    while let Some((node, class_prefix)) = stack.pop() {
        if node.kind() == "class_declaration" {
            // 提取类级 @RequestMapping 前缀——不创建路由。
            let prefix = extract_class_request_mapping_prefix(&node, source);
            let children: Vec<_> = node.children(&mut cursor).collect();
            for child in children.into_iter().rev() {
                stack.push((child, prefix.clone()));
            }
            continue;
        }

        if node.kind() == "method_declaration" {
            let mut handler_name = String::new();
            if let Some(name_node) = node.child_by_field_name("name") {
                handler_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }

            // 在 modifiers/annotations 中检查 Spring 注解
            let mut node_cursor = node.walk();
            for child in node.children(&mut node_cursor) {
                if child.kind() == "modifiers" || child.kind() == "annotation" {
                    // 扫描 @GetMapping、@PostMapping 等（仅方法级注解）
                    find_spring_annotations(&child, source, &mut result, &handler_name, file, &class_prefix);
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push((child, class_prefix.clone()));
        }
    }

    result
}

/// 从 class_declaration 节点中提取类级 `@RequestMapping` 路径前缀。
/// 如果未找到类级 `@RequestMapping`，则返回空字符串。
fn extract_class_request_mapping_prefix(class_node: &tree_sitter::Node, source: &str) -> String {
    let mut node_cursor = class_node.walk();
    for child in class_node.children(&mut node_cursor) {
        if child.kind() == "modifiers" || child.kind() == "annotation" {
            let prefix = find_request_mapping_in_node(&child, source);
            if !prefix.is_empty() {
                return prefix;
            }
        }
    }
    String::new()
}

/// 在 modifiers/annotation 子树中搜索 `@RequestMapping` 注解并返回其路径。
fn find_request_mapping_in_node(node: &tree_sitter::Node, source: &str) -> String {
    let mut cursor = node.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = node.children(&mut cursor).collect();

    while let Some(child) = stack.pop() {
        if child.kind() == "annotation" || child.kind() == "marker_annotation" {
            let mut ac = child.walk();
            for ac_child in child.children(&mut ac) {
                if ac_child.kind() == "identifier" {
                    let name = ac_child.utf8_text(source.as_bytes()).unwrap_or("");
                    if name == "RequestMapping" {
                        if let Some(path) = extract_spring_path(&child, source) {
                            return path;
                        }
                    }
                }
            }
        }
        let mut cc = child.walk();
        let children: Vec<_> = child.children(&mut cc).collect();
        for c in children.into_iter().rev() {
            stack.push(c);
        }
    }
    String::new()
}

/// 合并类级前缀与方法级路径。
/// 例如 ("/api", "/users") → "/api/users"；("", "/users") → "/users"
fn merge_spring_paths(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        return path.to_string();
    }
    let p = prefix.trim_matches('/');
    let m = path.trim_matches('/');
    if m.is_empty() {
        format!("/{}", p)
    } else {
        format!("/{}/{}", p, m)
    }
}

fn find_spring_annotations(
    node: &tree_sitter::Node,
    source: &str,
    result: &mut Vec<DetectedRoute>,
    handler_name: &str,
    file: &str,
    class_prefix: &str,
) {
    // D1：仅方法级注解——方法级 RequestMapping 是有效的，
    // 但类级 @RequestMapping 作为前缀单独处理。
    let spring_annotations: HashSet<&str> = [
        "RequestMapping", "GetMapping", "PostMapping", "PutMapping",
        "DeleteMapping", "PatchMapping",
    ]
    .iter()
    .cloned()
    .collect();

    let mut cursor = node.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = node.children(&mut cursor).collect();

    while let Some(child) = stack.pop() {
        if child.kind() == "annotation" || child.kind() == "marker_annotation" {
            // 提取注解名称
            let mut ac = child.walk();
            for ac_child in child.children(&mut ac) {
                if ac_child.kind() == "identifier" {
                    let name = ac_child.utf8_text(source.as_bytes()).unwrap_or("");
                    if spring_annotations.contains(name) {
                        // 将注解名称映射到 HTTP 方法
                        let method = match name {
                            "GetMapping" => "GET",
                            "PostMapping" => "POST",
                            "PutMapping" => "PUT",
                            "DeleteMapping" => "DELETE",
                            "PatchMapping" => "PATCH",
                            _ => "ALL",
                        };
                        // 在注解参数中查找路径字符串
                        let path = extract_spring_path(&child, source)
                            .unwrap_or_else(|| "/".to_string());
                        // D1：合并类级前缀与方法级路径
                        let merged_path = merge_spring_paths(class_prefix, &path);
                        let line = child.start_position().row + 1;
                        result.push((
                            method.to_string(),
                            merged_path,
                            handler_name.to_string(),
                            file.to_string(),
                            line,
                        ));
                    }
                }
            }
        }
        let mut cc = child.walk();
        let children: Vec<_> = child.children(&mut cc).collect();
        for c in children.into_iter().rev() {
            stack.push(c);
        }
    }
}

fn extract_spring_path(annotation: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cursor = annotation.walk();
    for child in annotation.children(&mut cursor) {
        if child.kind() == "annotation_argument_list" || child.kind() == "argument_list" {
            let mut ac = child.walk();
            for arg in child.children(&mut ac) {
                if arg.kind() == "string_literal" || arg.kind() == "string" {
                    return Some(arg.utf8_text(source.as_bytes()).unwrap_or("")
                        .trim_matches(&['\'', '"'][..]).to_string());
                }
                // annotation_member：value = "/path"
                if arg.kind() == "annotation_member" || arg.kind() == "element_value_pair" {
                    let mut mc = arg.walk();
                    for mchild in arg.children(&mut mc) {
                        if mchild.kind() == "string_literal" || mchild.kind() == "string" {
                            return Some(mchild.utf8_text(source.as_bytes()).unwrap_or("")
                                .trim_matches(&['\'', '"'][..]).to_string());
                        }
                    }
                }
            }
        }
    }
    None
}
