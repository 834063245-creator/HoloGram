// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_fastapi_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py")
}

/// 检测 FastAPI `@app.get("/path")` 和 `@router.post("/path")` 装饰器。
/// 模式：装饰器是对 app/router 属性的调用，属性名为 HTTP 方法名。
pub(crate) fn detect_fastapi_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("py") { Some(l) => l, None => return result };
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "get", "post", "put", "delete", "patch", "head", "options", "trace",
        "websocket", "api_route", "add_api_route",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "decorated_definition" {
            let mut handler_name = String::new();
            let mut decorators = Vec::new();

            // 收集子节点：装饰器节点 vs 定义节点
            let mut node_cursor = node.walk();
            for child in node.children(&mut node_cursor) {
                match child.kind() {
                    "decorator" => decorators.push(child),
                    "function_definition" | "async_function_definition" | "class_definition" => {
                        if let Some(name_node) = child.child_by_field_name("name") {
                            handler_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                        }
                    }
                    _ => {}
                }
            }

            // 对每个装饰器尝试 HTTP 方法模式匹配
            for deco in &decorators {
                if let Some((method, path)) = extract_fastapi_decorator(deco, source, &http_methods) {
                    let line = node.start_position().row + 1;
                    result.push((method, path, handler_name.clone(), file.to_string(), line));
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    result
}

/// 从 FastAPI 装饰器节点中提取 (HTTP_METHOD, route_path)。
/// tree-sitter-python 装饰器：`@` call
/// 其中 call 具有属性函数（app.get、router.post）和 argument_list。
fn extract_fastapi_decorator(
    decorator: &tree_sitter::Node,
    source: &str,
    http_methods: &HashSet<&str>,
) -> Option<(String, String)> {
    // 装饰器子节点：['@', call]
    let mut dec_cursor = decorator.walk();
    let children: Vec<_> = decorator.children(&mut dec_cursor).collect();

    // 查找 call 节点
    let call_node = children.iter().find(|c| c.kind() == "call")?;

    // 获取函数（必须是属性：app.get、router.post）
    let func = call_node.child_by_field_name("function")?;
    if func.kind() != "attribute" {
        return None;
    }

    // 提取方法名（属性中的最后一个标识符）
    let mut attr_cursor = func.walk();
    let method = func.children(&mut attr_cursor)
        .filter(|c| c.kind() == "identifier")
        .last()
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_uppercase())?;

    if !http_methods.contains(method.to_lowercase().as_str()) {
        return None;
    }

    // 从 argument_list 中的第一个字符串提取路由路径
    let args = call_node.child_by_field_name("arguments")?;
    let mut args_cursor = args.walk();
    for child in args.children(&mut args_cursor) {
        if child.kind() == "string" {
            let path = child.utf8_text(source.as_bytes()).unwrap_or("");
            let path = path
                .trim_matches(&['\'', '"', 'r', 'b'][..])
                .split('"')
                .next()
                .unwrap_or("")
                .to_string();
            if !path.is_empty() {
                return Some((method, path));
            }
        }
    }

    None
}
