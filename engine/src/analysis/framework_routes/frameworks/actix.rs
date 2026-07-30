// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_actix_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rs")
}

/// Actix 检测的内容门控。`is_actix_candidate` 匹配所有 .rs
/// 文件，且路由属性（`#[get("/x")]`）与 Rocket 的拼写完全
/// 相同，因此调度器在认领文件之前需要确认真实的 actix 引用——
/// 真正的 actix 文件总是导入 actix_web（F7）。
pub(crate) fn has_actix_content(source: &str) -> bool {
    source.contains("actix")
}

pub(crate) fn detect_actix_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("rs") { Some(l) => l, None => return result };
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) { Some(t) => t, None => return result };

    let route_attrs: HashSet<&str> = [
        "get", "post", "put", "delete", "patch", "head", "options",
        "web::get", "web::post", "web::put", "web::delete",
        "route", "web::route",
    ].iter().cloned().collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // 收集 #[xxx("/path")] → 下一个 fn
    let mut pending_route: Option<(String, String)> = None; // （方法，路径）

    while let Some(node) = stack.pop() {
        match node.kind() {
            "attribute_item" => {
                // #[get("/path")] 或 #[web::get("/path")]
                let text = node.utf8_text(source.as_bytes()).unwrap_or("");
                let inner = text.trim_start_matches("#[").trim_end_matches(']').trim();
                // 在 '(' 处分割以获取 attr_name 和参数
                if let Some(paren) = inner.find('(') {
                    let attr_name = inner[..paren].trim().to_lowercase();
                    let args = &inner[paren..];
                    if route_attrs.contains(attr_name.as_str()) {
                        let path = args.trim_matches(|c| c == '(' || c == ')' || c == '"' || c == '\'').to_string();
                        let method = if attr_name.starts_with("web::") {
                            attr_name.strip_prefix("web::").unwrap_or(&attr_name).to_uppercase()
                        } else {
                            attr_name.to_uppercase()
                        };
                        pending_route = Some((method, path));
                    }
                }
            }
            "function_item" => {
                if let Some((method, path)) = pending_route.take() {
                    if let Some(name_node) = node.child_by_field_name("name") {
                        let handler = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                        let line = node.start_position().row + 1;
                        result.push((method, format!("/{}", path.trim_matches('/')), handler, file.to_string(), line));
                    }
                }
            }
            _ => {}
        }
        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }
    result
}
