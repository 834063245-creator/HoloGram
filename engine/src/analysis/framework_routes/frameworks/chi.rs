// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_chi_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".go")
}

/// Content gate for Chi detection. Chi shares the Go selector-call shape with
/// Gin/Echo/Fiber, so the dispatcher confirms Chi markers (import path or
/// constructor) before claiming the file.
pub(crate) fn has_chi_content(source: &str) -> bool {
    source.contains("chi.NewRouter") || source.contains("go-chi/chi")
}

/// Detect Chi routes (go-chi/chi). Mirrors gin.rs; `{id}` path params are kept
/// exactly as written (no `:id` normalization — the engine does not normalize
/// framework param styles).
/// Patterns:
///   r.Get("/path", handler) — capitalized method names → uppercased method
///   r.Route("/api", func(r chi.Router) { ... }) — single-level prefix
///       propagation: routes inside the closure body get the prefix (tracked
///       via the closure's byte range). Nested Route closures beyond one level
///       are out of scope — the innermost prefix wins, no composition.
pub(crate) fn detect_chi_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("go").expect("go grammar")).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "Get", "Post", "Put", "Delete", "Patch", "Head", "Options",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // Byte ranges of Route closure bodies → their prefix. Recorded in document
    // order (outermost first); a route call takes the innermost range's prefix.
    let mut route_scopes: Vec<(usize, usize, String)> = Vec::new();

    while let Some(node) = stack.pop() {
        // Chi routes are selector_expression calls: r.Get("/path", handler)
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "selector_expression" {
                    // selector_expression: r.Get → field "Get"
                    let mut sel_cursor = func.walk();
                    let method = match func.children(&mut sel_cursor)
                        .find(|c| c.kind() == "field_identifier")
                        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string()) {
                            Some(m) => m,
                            None => continue,
                        };

                    if method == "Route" {
                        // r.Route("/api", func(r chi.Router) { ... }) — record the
                        // closure's byte range; Route itself emits no route
                        if let Some(args) = node.child_by_field_name("arguments") {
                            if let Some(prefix) = first_string_arg(&args, source) {
                                let mut c = args.walk();
                                for ac in args.children(&mut c) {
                                    if ac.kind() == "func_literal" {
                                        route_scopes.push((ac.start_byte(), ac.end_byte(), prefix.clone()));
                                    }
                                }
                            }
                        }
                    } else if http_methods.contains(method.as_str()) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            if let Some((m, path, handler)) = extract_chi_route(&args, &method, source) {
                                // Innermost recorded scope containing this call wins.
                                let mut prefix = String::new();
                                for (start, end, p) in &route_scopes {
                                    if node.start_byte() >= *start && node.end_byte() <= *end {
                                        prefix = p.clone();
                                    }
                                }
                                result.push((m, join_paths(&prefix, &path), handler, file.to_string(), line));
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

/// path = first string literal arg; handler = first non-punctuation arg after it.
/// Method is uppercased (Chi writes them capitalized: Get/Post/...).
fn extract_chi_route(
    args: &tree_sitter::Node,
    method: &str,
    source: &str,
) -> Option<(String, String, String)> {
    let mut args_cursor = args.walk();
    let arg_children: Vec<_> = args.children(&mut args_cursor).collect();

    let mut path = String::new();
    let mut handler = String::new();
    let mut found_path = false;

    for ac in &arg_children {
        let kind = ac.kind();
        let text = ac.utf8_text(source.as_bytes()).unwrap_or("");

        if (kind == "interpreted_string_literal" || kind == "raw_string_literal") && !found_path {
            path = text.trim_matches(&['"', '`'][..]).to_string();
            found_path = true;
            continue;
        }

        if found_path && kind != "," && kind != "(" && kind != ")" {
            handler = text.to_string();
            break;
        }
    }

    if !path.is_empty() {
        Some((method.to_uppercase(), path, handler))
    } else {
        None
    }
}

fn first_string_arg(args: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut c = args.walk();
    for ac in args.children(&mut c) {
        if ac.kind() == "interpreted_string_literal" || ac.kind() == "raw_string_literal" {
            let text = ac.utf8_text(source.as_bytes()).unwrap_or("");
            return Some(text.trim_matches(&['"', '`'][..]).to_string());
        }
    }
    None
}

fn join_paths(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        return path.to_string();
    }
    format!("{}{}", prefix.trim_end_matches('/'), path)
}
