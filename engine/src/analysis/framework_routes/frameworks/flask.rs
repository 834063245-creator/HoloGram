// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use super::super::DetectedRoute;

pub(crate) fn is_flask_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py")
}

/// 检测 Flask `@app.route("/path", methods=["GET"])` 装饰器。
/// 与 FastAPI 使用相同的 tree-sitter 模式，但装饰器名为 `route`（不是 HTTP 方法）。
pub(crate) fn detect_flask_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "decorated_definition" {
            let mut handler_name = String::new();
            let mut decorators = Vec::new();

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

            for deco in &decorators {
                if let Some((method, path)) = extract_flask_decorator(deco, source) {
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

/// 从 Flask @app.route 装饰器中提取 (HTTP_METHOD, route_path)。
/// 模式：@app.route("/path", methods=["GET", "POST"]) 或仅 @app.route("/path")
fn extract_flask_decorator(
    decorator: &tree_sitter::Node,
    source: &str,
) -> Option<(String, String)> {
    let mut dec_cursor = decorator.walk();
    let children: Vec<_> = decorator.children(&mut dec_cursor).collect();

    // 查找 call 节点
    let call_node = children.iter().find(|c| c.kind() == "call")?;

    // 检查函数是否为以 "route" 结尾的属性
    let func = call_node.child_by_field_name("function")?;
    if func.kind() != "attribute" {
        return None;
    }
    let mut attr_cursor = func.walk();
    let last_id = func.children(&mut attr_cursor)
        .filter(|c| c.kind() == "identifier")
        .last()
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())?;
    if last_id != "route" {
        return None;
    }

    // 从第一个字符串参数中提取路径
    let args = call_node.child_by_field_name("arguments")?;
    let mut args_cursor = args.walk();
    let mut path = String::new();
    let mut methods: Vec<String> = vec!["GET".into()]; // Flask 默认方法

    for child in args.children(&mut args_cursor) {
        if child.kind() == "string" && path.is_empty() {
            path = child.utf8_text(source.as_bytes()).unwrap_or("")
                .trim_matches(&['\'', '"', 'r', 'b'][..]).to_string();
        }
        // 查找 methods=["GET", "POST"] 关键字
        if child.kind() == "keyword_argument" {
            let kw_text = child.utf8_text(source.as_bytes()).unwrap_or("");
            if kw_text.starts_with("methods=") {
                // 从列表中提取方法名
                let mut kw_cursor = child.walk();
                for kw_child in child.children(&mut kw_cursor) {
                    if kw_child.kind() == "string" {
                        let m = kw_child.utf8_text(source.as_bytes()).unwrap_or("")
                            .trim_matches(&['\'', '"'][..]).to_uppercase();
                        if !m.is_empty() && m != "METHODS" {
                            if methods.len() == 1 && methods[0] == "GET" { methods.clear(); }
                            methods.push(m);
                        }
                    }
                }
            }
        }
    }

    if !path.is_empty() {
        let method = methods.join(",");
        Some((method, path))
    } else {
        None
    }
}
