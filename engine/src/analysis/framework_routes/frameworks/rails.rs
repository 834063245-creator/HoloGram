// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;
use super::super::find_first_string;
use super::super::find_rails_handler;
use super::super::capitalize_first;

pub(crate) fn is_rails_file(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rb") && (lower.contains("routes") || lower.contains("route"))
}

/// 检测 Rails routes.rb DSL：`get '/path', to: 'controller#action'`
/// 也包括：`resources :users`、`namespace :admin do ... end`
pub(crate) fn detect_rails_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("rb") { Some(l) => l, None => return result };
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "get", "post", "put", "patch", "delete", "head", "options",
        "match", "resources", "resource", "root", "namespace", "scope",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        // Rails 路由是 call 节点：`get '/path'` 或 `get '/path', to: 'controller#action'`
        if node.kind() == "call" || node.kind() == "method_call" {
            if let Some((method, path, handler)) = extract_rails_route(&node, source, &http_methods) {
                let line = node.start_position().row + 1;
                result.push((method, path, handler, file.to_string(), line));
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    result
}

fn extract_rails_route(
    node: &tree_sitter::Node,
    source: &str,
    http_methods: &HashSet<&str>,
) -> Option<(String, String, String)> {
    // 获取第一个标识符（HTTP 方法）
    let mut node_cursor = node.walk();
    let method = node.children(&mut node_cursor)
        .find(|c| c.kind() == "identifier")
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_lowercase())?;

    if !http_methods.contains(method.as_str()) {
        return None;
    }

    // 查找第一个字符串（路由路径）——递归搜索子节点
    let path = find_first_string(node, source)?;

    // 查找处理函数（to: 'controller#action'）
    let handler = if method == "resources" || method == "resource" {
        format!("{}Controller", capitalize_first(&path))
    } else if method == "namespace" || method == "scope" {
        String::new()
    } else {
        find_rails_handler(node, source).unwrap_or_default()
    };

    let method_upper = method.to_uppercase();
    if handler.is_empty() {
        Some((method_upper, path, String::new()))
    } else {
        Some((method_upper, path, handler))
    }
}
