// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use super::super::DetectedRoute;

pub(crate) fn is_django_url_file(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py") && (lower.contains("urls") || lower.contains("urlpatterns"))
}

/// Detect Django `path()` / `re_path()` / `url()` calls.
/// Pattern: `path('<route>', <view_ref>, ...)`
/// View ref can be: `views.func`, `ModuleView.as_view()`, lambda
pub(crate) fn detect_django_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("py").expect("python grammar")).is_err() {
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
        if node.kind() == "call" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_name = func.utf8_text(source.as_bytes()).unwrap_or("");
                let is_url_func = matches!(func_name, "path" | "re_path" | "url");
                let is_router_register = func.kind() == "attribute"
                    && (func_name.ends_with(".register") || func_name == "register");

                if is_url_func || is_router_register {
                    if let Some(args) = node.child_by_field_name("arguments") {
                        let line = node.start_position().row + 1;
                        if let Some((method, url, handler)) = extract_django_route(args, source, func_name, is_router_register) {
                            result.push((method, url, handler, file.to_string(), line));
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

/// Extract (http_method, url_pattern, handler_ref) from Django path() arguments.
fn extract_django_route(
    args: tree_sitter::Node,
    source: &str,
    _func_name: &str,
    is_register: bool,
) -> Option<(String, String, String)> {
    let mut cursor = args.walk();
    let children: Vec<tree_sitter::Node> = args.children(&mut cursor).collect();

    if is_register {
        // router.register(r'users', UserViewSet, basename='user')
        // children: ( ) string identifier ...
        let mut route_str = String::new();
        let mut handler = String::new();
        let mut in_route = false;
        for child in &children {
            match child.kind() {
                "string" if !in_route => {
                    route_str = child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                    route_str = route_str.trim_matches(&['\'', '"', 'r'][..]).to_string();
                    in_route = true;
                }
                "identifier" if in_route => {
                    handler = child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                    break;
                }
                "attribute" if in_route => {
                    handler = child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                    break;
                }
                _ => {}
            }
        }
        if !route_str.is_empty() && !handler.is_empty() {
            return Some(("ALL".into(), format!("/{}", route_str), handler));
        }
        return None;
    }

    // path('route/', view_func, ...)
    let mut route_str = String::new();
    let mut handler = String::new();
    let http_method = "ALL".to_string();
    let mut next_is_handler = false;
    let mut found_route = false;

    for child in &children {
        let kind = child.kind();
        let text = child.utf8_text(source.as_bytes()).unwrap_or("");

        // First string argument = route
        if kind == "string" && !found_route {
            route_str = text.trim_matches(&['\'', '"', 'r', 'b'][..]).to_string();
            found_route = true;
            next_is_handler = true;
            continue;
        }

        if next_is_handler {
            match kind {
                "identifier" => {
                    handler = text.to_string();
                    break;
                }
                "attribute" => {
                    handler = text.to_string();
                    break;
                }
                "call" => {
                    // e.g. views.OrderView.as_view()
                    handler = text.to_string();
                    break;
                }
                "lambda" => {
                    handler = format!("<lambda@{}>", args.start_position().row + 1);
                    break;
                }
                "keyword_argument" => {
                    // name='x' — not the handler, skip
                    next_is_handler = false;
                    continue;
                }
                "(" | ")" | "," => continue,
                _ => {
                    // Unknown — might be a variable reference
                    handler = text.to_string();
                    break;
                }
            }
        }

        // Check for `name=` keyword (HTTP method hint)
        if kind == "keyword_argument" {
            let kw_text = text.to_string();
            if kw_text.starts_with("name=") {
                // Extract name, could hint at HTTP method
            }
        }
    }

    if !route_str.is_empty() && !handler.is_empty() {
        Some((http_method, route_str, handler))
    } else {
        None
    }
}
