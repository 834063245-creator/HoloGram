// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_actix_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rs")
}

pub(crate) fn detect_actix_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("rs").expect("rust grammar")).is_err() {
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

    // Collect #[xxx("/path")] → next fn
    let mut pending_route: Option<(String, String)> = None; // (method, path)

    while let Some(node) = stack.pop() {
        match node.kind() {
            "attribute_item" => {
                // #[get("/path")] or #[web::get("/path")]
                let text = node.utf8_text(source.as_bytes()).unwrap_or("");
                let inner = text.trim_start_matches("#[").trim_end_matches(']').trim();
                // Split at '(' to get attr_name and args
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
