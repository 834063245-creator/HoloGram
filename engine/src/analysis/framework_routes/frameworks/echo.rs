// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::{HashMap, HashSet};
use super::super::DetectedRoute;

pub(crate) fn is_echo_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".go")
}

/// Content gate for Echo detection. Echo shares Gin's `.GET()/.POST()/.Group()`
/// selector-call shape — and gin.rs's gate (`.GET(` etc.) would swallow Echo
/// files — so the dispatcher confirms Echo markers before claiming the file.
pub(crate) fn has_echo_content(source: &str) -> bool {
    source.contains("echo.New") || source.contains("labstack/echo")
}

/// Detect Echo routes (labstack/echo). Mirrors gin.rs.
/// Patterns:
///   e.GET("/path", handler) — selector call, method as-is
///   g := e.Group("/api") (or `var g = e.Group("/api")`) — single-level
///       prefix propagation: the group's
///       prefix is recorded per variable and prepended to routes registered
///       on that variable later in the same file. Nested groups and chained
///       `e.Group("/api").GET(...)` receivers are not resolved (single level).
pub(crate) fn detect_echo_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("go") { Some(l) => l, None => return result };
    if parser.set_language(&lang).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // Group variable → prefix (e.g. `g := e.Group("/api")` records g → /api).
    let mut group_prefixes: HashMap<String, String> = HashMap::new();

    while let Some(node) = stack.pop() {
        // Echo routes are selector_expression calls: e.GET("/path", handler)
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "selector_expression" {
                    // selector_expression: <operand>.<field> — e.g. e.GET
                    let mut sel_cursor = func.walk();
                    let mut method = String::new();
                    let mut operand = String::new();
                    for c in func.children(&mut sel_cursor) {
                        match c.kind() {
                            "field_identifier" => {
                                method = c.utf8_text(source.as_bytes()).unwrap_or("").to_string()
                            }
                            "identifier" if operand.is_empty() => {
                                operand = c.utf8_text(source.as_bytes()).unwrap_or("").to_string()
                            }
                            _ => {}
                        }
                    }

                    if method == "Group" {
                        // Group emits no route of its own — only the prefix mapping
                        record_group_prefix(&node, source, &mut group_prefixes);
                    } else if http_methods.contains(method.as_str()) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            if let Some((m, path, handler)) = extract_echo_route(&args, &method, source) {
                                let prefix = group_prefixes.get(&operand).cloned().unwrap_or_default();
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

/// `g := e.Group("/api")` or `var g = e.Group("/api")` — when the Group call
/// sits on the right-hand side of a var declaration, record the declared
/// variable's prefix. Known heuristic limitation: same-name variables in
/// different functions share one prefix entry (no scoping).
fn record_group_prefix(
    node: &tree_sitter::Node,
    source: &str,
    group_prefixes: &mut HashMap<String, String>,
) {
    // call_expression → expression_list (right) → short_var_declaration
    // (`g := ...`) or var_spec (`var g = ...`).
    let right = match node.parent() {
        Some(p) if p.kind() == "expression_list" => p,
        _ => return,
    };
    let var = match right.parent() {
        Some(d) if d.kind() == "short_var_declaration" => {
            match d.child_by_field_name("left") {
                Some(left) => first_identifier_text(&left, source),
                None => None,
            }
        }
        Some(d) if d.kind() == "var_spec" => {
            match d.child_by_field_name("name") {
                Some(name) => first_identifier_text(&name, source),
                None => None,
            }
        }
        _ => None,
    };
    let Some(var) = var else {
        return;
    };
    if var.is_empty() {
        return;
    }
    if let Some(args) = node.child_by_field_name("arguments") {
        if let Some(prefix) = first_string_arg(&args, source) {
            group_prefixes.insert(var, prefix);
        }
    }
}

/// Text of the first identifier in the subtree (the declared variable).
fn first_identifier_text(node: &tree_sitter::Node, source: &str) -> Option<String> {
    if node.kind() == "identifier" {
        return Some(node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
    }
    let mut c = node.walk();
    let found = node
        .children(&mut c)
        .find(|ch| ch.kind() == "identifier");
    found.map(|v| v.utf8_text(source.as_bytes()).unwrap_or("").to_string())
}

/// path = first string literal arg; handler = first non-punctuation arg after it.
fn extract_echo_route(
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
        Some((method.to_string(), path, handler))
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
