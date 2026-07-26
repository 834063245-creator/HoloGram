// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use super::super::DetectedRoute;

pub(crate) fn is_axum_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rs")
}

/// Content gate for Axum detection. All .rs files are candidates (Actix and
/// Rocket share the extension), so the dispatcher confirms Axum-specific
/// markers before claiming the file.
pub(crate) fn has_axum_content(source: &str) -> bool {
    source.contains("axum::") || source.contains("Router::new")
}

/// Axum method routers: `axum::routing::{get, post, ...}` fns and the chained
/// `MethodRouter` methods (`get(a).post(b)`). `any` is deliberately excluded —
/// it is not a specific HTTP method.
const METHOD_ROUTERS: [&str; 8] = [
    "get", "post", "put", "delete", "patch", "head", "options", "trace",
];

/// Detect Axum routes. Axum registers routes via chained builder calls:
///   Router::new().route("/path", get(handler).post(other))
///   .route_with_tsr("/path", get(handler)) — same shape as .route()
///   .nest("/api", Router::new().route(...)) — single-level prefix propagation:
///       routes in the INLINE router argument get the nest prefix.
/// Limits: `.nest("/api", sub_router)` with a bare identifier arg is not
/// statically resolvable → no emission; `.merge(...)` emits nothing; a nest
/// inside a nest gives inner routes only the outermost prefix.
pub(crate) fn detect_axum_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("rs").expect("rust grammar")).is_err() {
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
        if node.kind() == "call_expression" && !inside_nest_arg(&node, source) {
            match call_field_name(&node, source).as_deref() {
                Some("route") | Some("route_with_tsr") => {
                    handle_route_call(&node, "", file, source, &mut result)
                }
                Some("nest") => handle_nest_call(&node, file, source, &mut result),
                _ => {}
            }
        }
        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    result
}

/// The method name of a chained call, e.g. `route` for `<expr>.route(...)`.
fn call_field_name(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let func = node.child_by_field_name("function")?;
    if func.kind() != "field_expression" {
        return None;
    }
    let field = func.child_by_field_name("field")?;
    Some(field.utf8_text(source.as_bytes()).unwrap_or("").to_string())
}

/// True when `node` sits inside the ARGUMENTS of a `.nest(...)` call — those
/// routes are emitted (with prefix) by the nest handler, so the main walk
/// skips them. Receiver-chain ancestors (`Router::new().route(..).nest(..)`)
/// don't count: the path from the node up to the nest call must cross the
/// nest call's `arguments` node.
fn inside_nest_arg(node: &tree_sitter::Node, source: &str) -> bool {
    let mut cur = *node;
    while let Some(parent) = cur.parent() {
        if parent.kind() == "arguments" {
            if let Some(call) = parent.parent() {
                if call.kind() == "call_expression"
                    && call_field_name(&call, source).as_deref() == Some("nest")
                {
                    return true;
                }
            }
        }
        cur = parent;
    }
    false
}

/// `.route("/path", <method router>)` → one route per HTTP method found in
/// the method-router chain.
fn handle_route_call(
    node: &tree_sitter::Node,
    prefix: &str,
    file: &str,
    source: &str,
    result: &mut Vec<DetectedRoute>,
) {
    let (path, router_arg) = match split_path_and_router(node, source) {
        Some(v) => v,
        None => return,
    };
    let line = node.start_position().row + 1;
    let mut pairs: Vec<(String, String)> = Vec::new();
    extract_method_routers(&router_arg, source, line, &mut pairs);
    for (method, handler) in pairs {
        result.push((method, join_paths(prefix, &path), handler, file.to_string(), line));
    }
}

/// `.nest("/prefix", inline_router)` → routes in the inline router argument
/// get the nest prefix (single level). A bare identifier arg
/// (`.nest("/api", sub_router)`) is not statically resolvable → no emission.
fn handle_nest_call(
    node: &tree_sitter::Node,
    file: &str,
    source: &str,
    result: &mut Vec<DetectedRoute>,
) {
    let (prefix, router_arg) = match split_path_and_router(node, source) {
        Some(v) => v,
        None => return,
    };
    if router_arg.kind() != "call_expression" {
        return;
    }
    let mut cursor = router_arg.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![router_arg];
    while let Some(n) = stack.pop() {
        if n.kind() == "call_expression" {
            if let Some("route") | Some("route_with_tsr") =
                call_field_name(&n, source).as_deref()
            {
                handle_route_call(&n, &prefix, file, source, result);
            }
        }
        let children: Vec<_> = n.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
}

/// Split `.route("/path", router)` / `.nest("/prefix", router)` args into
/// (first string literal, first non-punctuation arg after it).
fn split_path_and_router<'a>(
    node: &tree_sitter::Node<'a>,
    source: &str,
) -> Option<(String, tree_sitter::Node<'a>)> {
    let args = node.child_by_field_name("arguments")?;
    let mut path: Option<String> = None;
    let mut router_arg: Option<tree_sitter::Node<'a>> = None;
    let mut c = args.walk();
    for ac in args.children(&mut c) {
        match ac.kind() {
            "(" | ")" | "," => continue,
            "string_literal" => {
                if path.is_none() {
                    path = Some(
                        ac.utf8_text(source.as_bytes())
                            .unwrap_or("")
                            .trim_matches('"')
                            .to_string(),
                    );
                }
            }
            _ => {
                if path.is_some() {
                    router_arg = Some(ac);
                    break;
                }
            }
        }
    }
    match (path, router_arg) {
        (Some(p), Some(r)) if !p.is_empty() => Some((p, r)),
        _ => None,
    }
}

/// Unroll a method-router chain (`get(a).post(b)`, `routing::get(a)`) into
/// (METHOD, handler) pairs in source order.
fn extract_method_routers(
    node: &tree_sitter::Node,
    source: &str,
    line: usize,
    out: &mut Vec<(String, String)>,
) {
    if node.kind() != "call_expression" {
        return;
    }
    let func = match node.child_by_field_name("function") {
        Some(f) => f,
        None => return,
    };
    match func.kind() {
        // get(handler) or routing::get(handler)
        "identifier" | "scoped_identifier" => {
            let name = if func.kind() == "scoped_identifier" {
                match func.child_by_field_name("name") {
                    Some(n) => n.utf8_text(source.as_bytes()).unwrap_or(""),
                    None => "",
                }
            } else {
                func.utf8_text(source.as_bytes()).unwrap_or("")
            };
            if METHOD_ROUTERS.contains(&name) {
                out.push((name.to_uppercase(), first_handler_arg(node, source, line)));
            }
        }
        // get(a).post(b) — recurse into the receiver first so pairs come out
        // in source order.
        "field_expression" => {
            if let Some(value) = func.child_by_field_name("value") {
                extract_method_routers(&value, source, line, out);
            }
            if let Some(field) = func.child_by_field_name("field") {
                let name = field.utf8_text(source.as_bytes()).unwrap_or("");
                if METHOD_ROUTERS.contains(&name) {
                    out.push((name.to_uppercase(), first_handler_arg(node, source, line)));
                }
            }
        }
        _ => {}
    }
}

/// Handler = first argument text of the method-router call. Empty args or a
/// closure can't be named statically → `<inline@LINE>` (express.rs convention).
fn first_handler_arg(call: &tree_sitter::Node, source: &str, line: usize) -> String {
    if let Some(args) = call.child_by_field_name("arguments") {
        let mut c = args.walk();
        for ac in args.children(&mut c) {
            match ac.kind() {
                "(" | ")" | "," => continue,
                "closure_expression" => return format!("<inline@{}>", line),
                _ => return ac.utf8_text(source.as_bytes()).unwrap_or("").to_string(),
            }
        }
    }
    format!("<inline@{}>", line)
}

fn join_paths(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        return path.to_string();
    }
    format!("{}{}", prefix.trim_end_matches('/'), path)
}
