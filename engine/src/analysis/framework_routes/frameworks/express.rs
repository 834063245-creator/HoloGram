// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_express_file(file: &str) -> bool {
    let lower = file.to_lowercase();
    if !lower.ends_with(".js") && !lower.ends_with(".ts") && !lower.ends_with(".mjs") {
        return false;
    }
    lower.contains("route") || lower.contains("router") || lower.contains("app")
}

/// Detect Express-style route registrations.
/// Patterns:
///   app.get('/path', handler)
///   router.post('/path', middleware, handler)
///   app.use('/prefix', subRouter)
pub(crate) fn detect_express_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    // Determine which tree-sitter language to use
    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang: tree_sitter::Language = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "get", "post", "put", "delete", "patch", "head", "options", "all",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "member_expression" {
                    // e.g. app.get() or router.post()
                    let mut prop_cursor = func.walk();
                    let func_children: Vec<_> = func.children(&mut prop_cursor).collect();

                    let mut method_name = String::new();

                    for fc in &func_children {
                        if fc.kind() == "property_identifier" {
                            method_name = fc.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                        }
                    }

                    let method_lower = method_name.to_lowercase();
                    let is_http = http_methods.contains(method_lower.as_str());
                    let is_use = method_lower == "use";

                    if is_http || is_use {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            let mut args_cursor = args.walk();
                            let arg_children: Vec<_> = args.children(&mut args_cursor).collect();

                            let mut route_str = String::new();
                            let mut handler = String::new();
                            let mut found_route = false;

                            for ac in &arg_children {
                                let kind = ac.kind();
                                let text = ac.utf8_text(source.as_bytes()).unwrap_or("");

                                if kind == "string" || kind == "template_string" {
                                    if !found_route {
                                        route_str = text
                                            .trim_matches(&['\'', '"', '`'][..])
                                            .to_string();
                                        found_route = true;
                                    }
                                    continue;
                                }

                                if found_route && kind != "," && kind != "(" && kind != ")" {
                                    handler = text.to_string();
                                    break;
                                }
                            }

                            if !route_str.is_empty() {
                                let method = if is_use {
                                    "USE".into()
                                } else {
                                    method_lower.to_uppercase()
                                };
                                if handler.is_empty() {
                                    handler = format!("<inline@{}>", line);
                                }
                                result.push((method, route_str, handler, file.to_string(), line));
                            }
                        }
                    }
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
