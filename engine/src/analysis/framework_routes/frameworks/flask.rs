// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use super::super::DetectedRoute;

pub(crate) fn is_flask_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py")
}

/// Detect Flask `@app.route("/path", methods=["GET"])` decorator.
/// Same tree-sitter pattern as FastAPI but decorator name is `route` (not an HTTP method).
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

/// Extract (HTTP_METHOD, route_path) from Flask @app.route decorator.
/// Pattern: @app.route("/path", methods=["GET", "POST"]) or just @app.route("/path")
fn extract_flask_decorator(
    decorator: &tree_sitter::Node,
    source: &str,
) -> Option<(String, String)> {
    let mut dec_cursor = decorator.walk();
    let children: Vec<_> = decorator.children(&mut dec_cursor).collect();

    // Find the call node
    let call_node = children.iter().find(|c| c.kind() == "call")?;

    // Check that function is an attribute ending with "route"
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

    // Extract path from first string argument
    let args = call_node.child_by_field_name("arguments")?;
    let mut args_cursor = args.walk();
    let mut path = String::new();
    let mut methods: Vec<String> = vec!["GET".into()]; // default Flask method

    for child in args.children(&mut args_cursor) {
        if child.kind() == "string" && path.is_empty() {
            path = child.utf8_text(source.as_bytes()).unwrap_or("")
                .trim_matches(&['\'', '"', 'r', 'b'][..]).to_string();
        }
        // Look for methods=["GET", "POST"] keyword
        if child.kind() == "keyword_argument" {
            let kw_text = child.utf8_text(source.as_bytes()).unwrap_or("");
            if kw_text.starts_with("methods=") {
                // Extract method names from the list
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
