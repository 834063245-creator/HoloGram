// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_koa_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    if !lower.ends_with(".js") && !lower.ends_with(".ts") && !lower.ends_with(".mjs") {
        return false;
    }
    lower.contains("route") || lower.contains("router") || lower.contains("app")
        || lower.contains("koa") || lower.contains("middleware")
}

/// Content gate — check for Koa-specific imports/patterns.
/// Prevents Express router split files from being misidentified as Koa.
pub(crate) fn has_koa_content(source: &str) -> bool {
    source.contains("require('koa')") || source.contains("require(\"koa\"")
        || source.contains("import Koa") || source.contains("from 'koa'")
        || source.contains("from \"koa\"")
        || source.contains("new Koa(") || source.contains("koa-router")
        || source.contains("@koa/router")
}

pub(crate) fn detect_koa_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang: tree_sitter::Language = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() { return result; }
    let tree = match parser.parse(source, None) { Some(t) => t, None => return result };

    let methods: HashSet<&str> = ["get", "post", "put", "delete", "patch", "head", "options", "all"]
        .iter().cloned().collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "member_expression" {
                    let method = func.children(&mut func.walk())
                        .filter(|c| c.kind() == "property_identifier")
                        .last()
                        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())
                        .unwrap_or_default();
                    let method_lower = method.to_lowercase();
                    if methods.contains(method_lower.as_str()) || method_lower == "use" {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            let mut ac = args.walk();
                            let arg_children: Vec<_> = args.children(&mut ac).collect();
                            let mut route_str = String::new();
                            let mut handler = String::new();
                            for ac_node in &arg_children {
                                match ac_node.kind() {
                                    "string" | "template_string" if route_str.is_empty() => {
                                        route_str = ac_node.utf8_text(source.as_bytes()).unwrap_or("")
                                            .trim_matches(&['\'', '"', '`'][..]).to_string();
                                    }
                                    "identifier" if !route_str.is_empty() => {
                                        handler = ac_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                                        break;
                                    }
                                    "arrow_function" | "function_expression" | "function" if !route_str.is_empty() => {
                                        handler = format!("<handler@{}>", ac_node.start_position().row + 1);
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                            if !route_str.is_empty() && !handler.is_empty() {
                                let method_upper = if method_lower == "use" { "USE" } else { &method_lower };
                                result.push((method_upper.to_uppercase(), route_str, handler, file.to_string(), line));
                            }
                        }
                    }
                }
            }
        }
        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }
    result
}
