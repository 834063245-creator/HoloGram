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
                        if is_router_register {
                            // D4: Expand DRF register() into 6 CRUD routes
                            result.extend(expand_drf_register(args, source, file, line));
                        } else if let Some((method, url, handler)) = extract_django_route(args, source, func_name, false) {
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
    _is_register: bool,
) -> Option<(String, String, String)> {
    let mut cursor = args.walk();
    let children: Vec<tree_sitter::Node> = args.children(&mut cursor).collect();

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
            route_str = strip_py_string_prefix(text).to_string();
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
                    // D3: Check if this is an include() call — emit as include route
                    // so the prefix is preserved for potential cross-file resolution
                    if let Some(func) = child.child_by_field_name("function") {
                        let func_name = func.utf8_text(source.as_bytes()).unwrap_or("");
                        if func_name == "include" {
                            // Extract the included module path (first string argument)
                            let include_target = child
                                .child_by_field_name("arguments")
                                .and_then(|include_args| {
                                    let mut ac = include_args.walk();
                                    for inc_child in include_args.children(&mut ac) {
                                        if inc_child.kind() == "string" {
                                            let t = inc_child.utf8_text(source.as_bytes()).unwrap_or("");
                                            return Some(strip_py_string_prefix(t).to_string());
                                        }
                                    }
                                    None
                                })
                                .unwrap_or_default();
                            if !route_str.is_empty() {
                                // Return with handler = "include:target" to preserve prefix info
                                handler = format!("include({})", include_target);
                                return Some((http_method.clone(), route_str.clone(), handler));
                            }
                            return None;
                        }
                    }
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

/// D4: Expand a DRF `router.register(r'prefix', ViewSet)` call into 6 CRUD routes.
/// Generates: list, create, retrieve, update, partial_update, destroy.
fn expand_drf_register(
    args: tree_sitter::Node,
    source: &str,
    file: &str,
    line: usize,
) -> Vec<DetectedRoute> {
    let mut cursor = args.walk();
    let children: Vec<tree_sitter::Node> = args.children(&mut cursor).collect();

    let mut route_prefix = String::new();
    let mut viewset_name = String::new();
    let mut in_route = false;

    for child in &children {
        match child.kind() {
            "string" if !in_route => {
                let raw = child.utf8_text(source.as_bytes()).unwrap_or("");
                route_prefix = strip_py_string_prefix(raw).to_string();
                in_route = true;
            }
            "identifier" if in_route && viewset_name.is_empty() => {
                viewset_name = child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }
            "attribute" if in_route && viewset_name.is_empty() => {
                viewset_name = child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }
            _ => {}
        }
    }

    if route_prefix.is_empty() || viewset_name.is_empty() {
        return Vec::new();
    }

    // DRF DefaultRouter generates these standard routes:
    //   GET    /prefix/       → list
    //   POST   /prefix/       → create
    //   GET    /prefix/{id}/  → retrieve
    //   PUT    /prefix/{id}/  → update
    //   PATCH  /prefix/{id}/  → partial_update
    //   DELETE /prefix/{id}/  → destroy
    let base = format!("/{}", route_prefix.trim_matches('/'));
    let detail = format!("/{}/{{id}}/", route_prefix.trim_matches('/'));

    vec![
        ("GET".into(),    format!("{}/", base),    format!("{}.list", viewset_name),           file.to_string(), line),
        ("POST".into(),   format!("{}/", base),    format!("{}.create", viewset_name),         file.to_string(), line),
        ("GET".into(),    detail.clone(),          format!("{}.retrieve", viewset_name),       file.to_string(), line),
        ("PUT".into(),    detail.clone(),          format!("{}.update", viewset_name),         file.to_string(), line),
        ("PATCH".into(),  detail.clone(),          format!("{}.partial_update", viewset_name), file.to_string(), line),
        ("DELETE".into(), detail,                  format!("{}.destroy", viewset_name),        file.to_string(), line),
    ]
}

/// Strip Python string prefixes (r, b, f, rb, u) and surrounding quotes.
/// `r'users'` → `users`, `"path"` → `path`, `b"data"` → `data`
fn strip_py_string_prefix(s: &str) -> &str {
    let s = s.trim();
    // Strip known Python string prefixes: r, b, f, u, rb, br, fr, rf (case-insensitive)
    let mut rest = s;
    loop {
        let lower = rest.to_ascii_lowercase();
        if lower.starts_with("rb") || lower.starts_with("br") || lower.starts_with("fr") || lower.starts_with("rf") {
            rest = &rest[2..];
        } else if lower.starts_with('r') || lower.starts_with('b') || lower.starts_with('f') || lower.starts_with('u') {
            // Only strip if followed by a quote
            let after = rest[1..].trim_start();
            if after.starts_with('\'') || after.starts_with('"') {
                rest = &rest[1..];
            } else {
                break;
            }
        } else {
            break;
        }
    }
    rest.trim_matches(&['\'', '"'][..])
}
