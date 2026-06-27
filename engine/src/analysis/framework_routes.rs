// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Framework route detection — ports CodeGraph's routing pattern recognition
//! into HoloGram's Rust engine. Detects web framework routes and creates
//! route nodes in the dependency graph, linking URLs to their handlers.
//!
//! Currently supports: Django, Express, FastAPI, Flask, Rails, Spring, Gin, NestJS

use crate::engine::GRAMMAR_LOADER;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

/// A detected route: (http_method, url_pattern, handler_name, file_path, line_number)
type DetectedRoute = (String, String, String, String, usize);

/// Parsed source held in the pipeline parse cache.
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// Scan the project for framework routes and inject them into the graph.
/// Uses the parse cache from Step 1 when available to avoid re-reading + re-parsing.
/// Called after full analysis + cross-file resolution.
pub fn detect_framework_routes(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // Filter the already-discovered file list (from pipeline Step 1) by framework
    // candidate patterns. This eliminates a redundant full-directory walkdir.
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        if let Ok(rel) = p.strip_prefix(project_root) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if is_django_url_file(&rel_str) || is_express_file(&rel_str)
                || is_fastapi_candidate(&rel_str) || is_flask_candidate(&rel_str)
                || is_rails_file(&rel_str) || is_spring_candidate(&rel_str)
                || is_gin_candidate(&rel_str) || is_nestjs_candidate(&rel_str)
            {
                files.insert(p.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    for file in &files {
        // Normalize to absolute path for cache lookup
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };
        // Use parse cache when available; fall back to disk read
        let source_opt = parse_cache.get(&abs_key).map(|(s, _)| s.clone());
        let source: String;
        let source_ref: &str;
        if let Some(cached) = source_opt {
            source = cached;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => source = s,
                Err(_) => continue,
            }
        }
        source_ref = &source;
        if is_django_url_file(file) {
            let routes = detect_django_routes(file, source_ref);
            added += inject_routes(graph, &routes);
        } else if is_express_file(file) {
            let routes = detect_express_routes(file, source_ref);
            added += inject_routes(graph, &routes);
        } else if is_fastapi_candidate(file) {
            if source_ref.contains("@app.") || source_ref.contains("@router.") {
                let routes = detect_fastapi_routes(file, source_ref);
                added += inject_routes(graph, &routes);
            }
        } else if is_flask_candidate(file) {
            if source_ref.contains("@app.route") || source_ref.contains("@bp.route") {
                let routes = detect_flask_routes(file, source_ref);
                added += inject_routes(graph, &routes);
            }
        } else if is_rails_file(file) {
            let routes = detect_rails_routes(file, source_ref);
            added += inject_routes(graph, &routes);
        } else if is_spring_candidate(file) {
            if source_ref.contains("@GetMapping") || source_ref.contains("@RequestMapping")
                || source_ref.contains("@PostMapping")
            {
                let routes = detect_spring_routes(file, source_ref);
                added += inject_routes(graph, &routes);
            }
        } else if is_gin_candidate(file) {
            if source_ref.contains(".GET(") || source_ref.contains(".POST(")
                || source_ref.contains(".Use(") || source_ref.contains(".Group(")
            {
                let routes = detect_gin_routes(file, source_ref);
                added += inject_routes(graph, &routes);
            }
        } else if is_nestjs_candidate(file) {
            if source_ref.contains("@Controller") || source_ref.contains("@Get")
                || source_ref.contains("@Post")
            {
                let routes = detect_nestjs_routes(file, source_ref);
                added += inject_routes(graph, &routes);
            }
        }
    }

    added
}

// ═══════════════════════════════════════════════════════════════
// Django
// ═══════════════════════════════════════════════════════════════

fn is_django_url_file(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py") && (lower.contains("urls") || lower.contains("urlpatterns"))
}

/// Detect Django `path()` / `re_path()` / `url()` calls.
/// Pattern: `path('<route>', <view_ref>, ...)`
/// View ref can be: `views.func`, `ModuleView.as_view()`, lambda
fn detect_django_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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

// ═══════════════════════════════════════════════════════════════
// Express
// ═══════════════════════════════════════════════════════════════

fn is_express_file(file: &str) -> bool {
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
fn detect_express_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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

// ═══════════════════════════════════════════════════════════════
// FastAPI — decorator-based routes
// ═══════════════════════════════════════════════════════════════

fn is_fastapi_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py")
}

/// Detect FastAPI `@app.get("/path")` and `@router.post("/path")` decorators.
/// Pattern: decorator is a call on an attribute of app/router with an HTTP method name.
fn detect_fastapi_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("py").expect("python grammar")).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "get", "post", "put", "delete", "patch", "head", "options", "trace",
        "websocket", "api_route", "add_api_route",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "decorated_definition" {
            let mut handler_name = String::new();
            let mut decorators = Vec::new();

            // Collect children: decorator nodes vs definition node
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

            // Try each decorator for HTTP method pattern
            for deco in &decorators {
                if let Some((method, path)) = extract_fastapi_decorator(deco, source, &http_methods) {
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

/// Extract (HTTP_METHOD, route_path) from a FastAPI decorator node.
/// tree-sitter-python decorator: `@` call
/// where call has an attribute function (app.get, router.post) and argument_list.
fn extract_fastapi_decorator(
    decorator: &tree_sitter::Node,
    source: &str,
    http_methods: &HashSet<&str>,
) -> Option<(String, String)> {
    // decorator children: ['@', call]
    let mut dec_cursor = decorator.walk();
    let children: Vec<_> = decorator.children(&mut dec_cursor).collect();

    // Find the call node
    let call_node = children.iter().find(|c| c.kind() == "call")?;

    // Get the function (must be attribute: app.get, router.post)
    let func = call_node.child_by_field_name("function")?;
    if func.kind() != "attribute" {
        return None;
    }

    // Extract method name (last identifier in the attribute)
    let mut attr_cursor = func.walk();
    let method = func.children(&mut attr_cursor)
        .filter(|c| c.kind() == "identifier")
        .last()
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_uppercase())?;

    if !http_methods.contains(method.to_lowercase().as_str()) {
        return None;
    }

    // Extract route path from first string in argument_list
    let args = call_node.child_by_field_name("arguments")?;
    let mut args_cursor = args.walk();
    for child in args.children(&mut args_cursor) {
        if child.kind() == "string" {
            let path = child.utf8_text(source.as_bytes()).unwrap_or("");
            let path = path
                .trim_matches(&['\'', '"', 'r', 'b'][..])
                .split('"')
                .next()
                .unwrap_or("")
                .to_string();
            if !path.is_empty() {
                return Some((method, path));
            }
        }
    }

    None
}

// ═══════════════════════════════════════════════════════════════
// Flask — @app.route("/path", methods=["GET"])
// ═══════════════════════════════════════════════════════════════

fn is_flask_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".py")
}

/// Detect Flask `@app.route("/path", methods=["GET"])` decorator.
/// Same tree-sitter pattern as FastAPI but decorator name is `route` (not an HTTP method).
fn detect_flask_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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

// ═══════════════════════════════════════════════════════════════
// Rails — config/routes.rb DSL
// ═══════════════════════════════════════════════════════════════

fn is_rails_file(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rb") && (lower.contains("routes") || lower.contains("route"))
}

/// Detect Rails routes.rb DSL: `get '/path', to: 'controller#action'`
/// Also: `resources :users`, `namespace :admin do ... end`
fn detect_rails_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("rb").expect("ruby grammar")).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    let http_methods: HashSet<&str> = [
        "get", "post", "put", "patch", "delete", "head", "options",
        "match", "resources", "resource", "root", "namespace", "scope",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        // Rails routes are call nodes: `get '/path'` or `get '/path', to: 'controller#action'`
        if node.kind() == "call" || node.kind() == "method_call" {
            if let Some((method, path, handler)) = extract_rails_route(&node, source, &http_methods) {
                let line = node.start_position().row + 1;
                result.push((method, path, handler, file.to_string(), line));
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    result
}

fn extract_rails_route(
    node: &tree_sitter::Node,
    source: &str,
    http_methods: &HashSet<&str>,
) -> Option<(String, String, String)> {
    // Get the first identifier (HTTP method)
    let mut node_cursor = node.walk();
    let method = node.children(&mut node_cursor)
        .find(|c| c.kind() == "identifier")
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_lowercase())?;

    if !http_methods.contains(method.as_str()) {
        return None;
    }

    // Find first string (route path) — recursively search children
    let path = find_first_string(node, source)?;

    // Find handler (to: 'controller#action')
    let handler = if method == "resources" || method == "resource" {
        format!("{}Controller", capitalize_first(&path))
    } else if method == "namespace" || method == "scope" {
        String::new()
    } else {
        find_rails_handler(node, source).unwrap_or_default()
    };

    let method_upper = method.to_uppercase();
    if handler.is_empty() {
        Some((method_upper, path, String::new()))
    } else {
        Some((method_upper, path, handler))
    }
}

/// Find first string-or-symbol content recursively in a node tree.
fn find_first_string(node: &tree_sitter::Node, source: &str) -> Option<String> {
    if node.kind() == "string_content" {
        let raw = node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
        if !raw.is_empty() { return Some(raw); }
    }
    if node.kind() == "string" {
        let mut c = node.walk();
        for child in node.children(&mut c) {
            if child.kind() == "string_content" {
                let raw = child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                if !raw.is_empty() { return Some(raw); }
            }
        }
        let raw = node.utf8_text(source.as_bytes()).unwrap_or("");
        let cleaned = raw.trim_matches(&['\'', '"'][..]).to_string();
        if !cleaned.is_empty() { return Some(cleaned); }
    }
    // Ruby symbols: :articles, :users
    if node.kind() == "simple_symbol" || node.kind() == "symbol" {
        let raw = node.utf8_text(source.as_bytes()).unwrap_or("");
        let cleaned = raw.trim_start_matches(':').to_string();
        if !cleaned.is_empty() { return Some(cleaned); }
    }
    let mut c = node.walk();
    for child in node.children(&mut c) {
        if let Some(s) = find_first_string(&child, source) {
            return Some(s);
        }
    }
    None
}

/// Find `controller#action` handler in a Rails route call node.
fn find_rails_handler(node: &tree_sitter::Node, source: &str) -> Option<String> {
    // Recursively search for 'string_content' containing '#'
    if node.kind() == "string_content" {
        let raw = node.utf8_text(source.as_bytes()).unwrap_or("");
        if raw.contains('#') { return Some(raw.to_string()); }
    }
    // Also check string node text
    if node.kind() == "string" {
        let raw = node.utf8_text(source.as_bytes()).unwrap_or("");
        let cleaned = raw.trim_matches(&['\'', '"'][..]);
        if cleaned.contains('#') { return Some(cleaned.to_string()); }
    }
    let mut c = node.walk();
    for child in node.children(&mut c) {
        if let Some(h) = find_rails_handler(&child, source) {
            return Some(h);
        }
    }
    None
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// ═══════════════════════════════════════════════════════════════
// Spring — @GetMapping, @PostMapping, @RequestMapping annotations
// ═══════════════════════════════════════════════════════════════

fn is_spring_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".java") || lower.ends_with(".kt")
}

/// Detect Spring `@GetMapping("/path")`, `@PostMapping`, `@RequestMapping(...)` annotations.
fn detect_spring_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    // Determine language
    let is_kotlin = file.ends_with(".kt") || file.ends_with(".kts");
    let lang: tree_sitter::Language = if is_kotlin {
        // Kotlin tree-sitter isn't wired yet, skip
        return result;
    } else {
        GRAMMAR_LOADER.get("java").expect("java grammar")
    };

    let mut parser = tree_sitter::Parser::new();
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
        // Spring annotations sit on method_declaration or class_declaration
        if node.kind() == "method_declaration" || node.kind() == "class_declaration" {
            let mut handler_name = String::new();
            if let Some(name_node) = node.child_by_field_name("name") {
                handler_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }

            // Check for Spring annotations among modifiers/annotations
            let mut node_cursor = node.walk();
            for child in node.children(&mut node_cursor) {
                if child.kind() == "modifiers" || child.kind() == "annotation" {
                    // Scan for @RequestMapping, @GetMapping, etc.
                    find_spring_annotations(&child, source, &mut result, &handler_name, file);
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

fn find_spring_annotations(
    node: &tree_sitter::Node,
    source: &str,
    result: &mut Vec<DetectedRoute>,
    handler_name: &str,
    file: &str,
) {
    let spring_annotations: HashSet<&str> = [
        "RequestMapping", "GetMapping", "PostMapping", "PutMapping",
        "DeleteMapping", "PatchMapping",
    ]
    .iter()
    .cloned()
    .collect();

    let mut cursor = node.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = node.children(&mut cursor).collect();

    while let Some(child) = stack.pop() {
        if child.kind() == "annotation" || child.kind() == "marker_annotation" {
            // Extract annotation name
            let mut ac = child.walk();
            for ac_child in child.children(&mut ac) {
                if ac_child.kind() == "identifier" {
                    let name = ac_child.utf8_text(source.as_bytes()).unwrap_or("");
                    if spring_annotations.contains(name) {
                        // Map annotation name to HTTP method
                        let method = match name {
                            "GetMapping" => "GET",
                            "PostMapping" => "POST",
                            "PutMapping" => "PUT",
                            "DeleteMapping" => "DELETE",
                            "PatchMapping" => "PATCH",
                            _ => "ALL",
                        };
                        // Find path string in annotation arguments
                        let path = extract_spring_path(&child, source)
                            .unwrap_or_else(|| "/".to_string());
                        let line = child.start_position().row + 1;
                        result.push((
                            method.to_string(),
                            path,
                            handler_name.to_string(),
                            file.to_string(),
                            line,
                        ));
                    }
                }
            }
        }
        let mut cc = child.walk();
        let children: Vec<_> = child.children(&mut cc).collect();
        for c in children.into_iter().rev() {
            stack.push(c);
        }
    }
}

fn extract_spring_path(annotation: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cursor = annotation.walk();
    for child in annotation.children(&mut cursor) {
        if child.kind() == "annotation_argument_list" || child.kind() == "argument_list" {
            let mut ac = child.walk();
            for arg in child.children(&mut ac) {
                if arg.kind() == "string_literal" || arg.kind() == "string" {
                    return Some(arg.utf8_text(source.as_bytes()).unwrap_or("")
                        .trim_matches(&['\'', '"'][..]).to_string());
                }
                // annotation_member: value = "/path"
                if arg.kind() == "annotation_member" || arg.kind() == "element_value_pair" {
                    let mut mc = arg.walk();
                    for mchild in arg.children(&mut mc) {
                        if mchild.kind() == "string_literal" || mchild.kind() == "string" {
                            return Some(mchild.utf8_text(source.as_bytes()).unwrap_or("")
                                .trim_matches(&['\'', '"'][..]).to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Gin — Go web framework: r.GET("/path", handler)
// ═══════════════════════════════════════════════════════════════

fn is_gin_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".go")
}

fn detect_gin_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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
        "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
        "Use", "Group", "Handle",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        // Gin routes are selector_expression calls: r.GET("/path", handler)
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "selector_expression" {
                    // selector_expression: r.GET → field "GET"
                    let mut sel_cursor = func.walk();
                    let method = match func.children(&mut sel_cursor)
                        .find(|c| c.kind() == "field_identifier")
                        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string()) {
                            Some(m) => m,
                            None => continue,
                        };

                    if http_methods.contains(method.as_str()) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            if let Some((m, path, handler)) = extract_gin_route(&args, &method, source) {
                                result.push((m, path, handler, file.to_string(), line));
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

fn extract_gin_route(
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

// ═══════════════════════════════════════════════════════════════
// NestJS — @Controller('prefix') + @Get('path') decorators
// ═══════════════════════════════════════════════════════════════

fn is_nestjs_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".ts") || lower.ends_with(".tsx")
}

fn detect_nestjs_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("ts").expect("typescript grammar")).is_err() {
        return result;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return result,
    };

    // NestJS decorators and their decorated members are SIBLINGS inside class_body,
    // unlike Python where decorator+definition form a single node.
    // Strategy: walk class_body children sequentially, pairing decorator → method_definition.

    let mut controller_prefixes: HashMap<usize, String> = HashMap::new();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        // Capture @Controller prefix per class
        if node.kind() == "class_declaration" {
            let start = node.start_byte();
            let mut class_prefix = String::new();
            let mut nc = node.walk();
            for child in node.children(&mut nc) {
                if child.kind() == "decorator" {
                    if let Some(prefix) = extract_nestjs_controller_prefix(&child, source) {
                        class_prefix = prefix;
                    }
                }
            }
            controller_prefixes.insert(start, class_prefix);
        }

        // class_body: decorator + method_definition are siblings — pair them
        if node.kind() == "class_body" {
            let parent_prefix = find_parent_controller_prefix(&node, &controller_prefixes);

            let mut nc = node.walk();
            let siblings: Vec<_> = node.children(&mut nc).collect();
            let mut pending_decorator: Option<(String, String)> = None; // (method, sub_path)

            for sib in &siblings {
                if sib.kind() == "decorator" {
                    pending_decorator = extract_nestjs_method_decorator(sib, source);
                } else if sib.kind() == "method_definition" || sib.kind() == "public_field_definition" {
                    let handler_name = sib.child_by_field_name("name")
                        .map(|n| n.utf8_text(source.as_bytes()).unwrap_or("").to_string())
                        .unwrap_or_default();

                    if let Some((method, sub_path)) = pending_decorator.take() {
                        let full_path = format!("{}/{}", parent_prefix.trim_matches('/'), sub_path.trim_matches('/'));
                        let full_path = full_path.trim_matches('/').to_string();
                        let line = sib.start_position().row + 1;
                        result.push((method, format!("/{}", full_path), handler_name, file.to_string(), line));
                    }
                }
            }
            continue; // class_body children are already processed
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    result
}

fn find_parent_controller_prefix(
    node: &tree_sitter::Node,
    prefixes: &HashMap<usize, String>,
) -> String {
    let mut cur = node.parent();
    while let Some(p) = cur {
        if p.kind() == "class_declaration" {
            if let Some(prefix) = prefixes.get(&p.start_byte()) {
                return prefix.clone();
            }
        }
        cur = p.parent();
    }
    String::new()
}

fn extract_nestjs_controller_prefix(decorator: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut dc = decorator.walk();
    for child in decorator.children(&mut dc) {
        if child.kind() == "call_expression" {
            // @Controller('prefix') — identifier is a direct child, not a field
            let name = find_callee_name(&child, source);
            if name == Some("Controller".to_string()) {
                if let Some(args) = child.child_by_field_name("arguments") {
                    let mut ac = args.walk();
                    for arg in args.children(&mut ac) {
                        if arg.kind() == "string" {
                            return Some(arg.utf8_text(source.as_bytes()).unwrap_or("")
                                .trim_matches(&['\'', '"', '`'][..]).to_string());
                        }
                    }
                }
                return Some(String::new()); // @Controller() without prefix
            }
        }
    }
    None
}

/// Find the callee name in a call_expression — looks for identifier child (TS) or
/// `function` field (Python/Java).
fn find_callee_name(call: &tree_sitter::Node, source: &str) -> Option<String> {
    // Try field name first
    if let Some(func) = call.child_by_field_name("function") {
        if func.kind() == "identifier" || func.kind() == "property_identifier" {
            return Some(func.utf8_text(source.as_bytes()).unwrap_or("").to_string());
        }
    }
    // Fallback: find identifier among direct children
    let mut cc = call.walk();
    for child in call.children(&mut cc) {
        if child.kind() == "identifier" || child.kind() == "property_identifier" {
            return Some(child.utf8_text(source.as_bytes()).unwrap_or("").to_string());
        }
    }
    None
}

fn extract_nestjs_method_decorator(decorator: &tree_sitter::Node, source: &str) -> Option<(String, String)> {
    let methods: HashMap<&str, &str> = [
        ("Get", "GET"), ("Post", "POST"), ("Put", "PUT"), ("Delete", "DELETE"),
        ("Patch", "PATCH"), ("Head", "HEAD"), ("Options", "OPTIONS"), ("All", "ALL"),
    ]
    .iter()
    .cloned()
    .collect();

    let mut dc = decorator.walk();
    for child in decorator.children(&mut dc) {
        if child.kind() == "call_expression" {
            let name = find_callee_name(&child, source)?;
            if let Some(http_method) = methods.get(name.as_str()) {
                let sub_path = if let Some(args) = child.child_by_field_name("arguments") {
                    let mut ac = args.walk();
                    let arg_children: Vec<_> = args.children(&mut ac).collect();
                    arg_children.iter()
                        .find(|a| a.kind() == "string")
                        .map(|a| a.utf8_text(source.as_bytes()).unwrap_or("")
                            .trim_matches(&['\'', '"', '`'][..]).to_string())
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                return Some((http_method.to_string(), sub_path));
            }
        }
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Route injection into graph
// ═══════════════════════════════════════════════════════════════

fn inject_routes(graph: &mut Graph, routes: &[DetectedRoute]) -> usize {
    let mut added = 0usize;
    let mut edge_counter = graph.edge_count() as u32;

    for (method, url, handler, file, line) in routes {
        // Create route node: "GET /api/users" with location "file:line"
        let route_name = format!("{} {}", method, url);
        let route_id = format!("route_{}_{}", file.replace(['/', '\\', '.'], "_"), added);
        let mut route_node = Node::new(&route_id, &route_name, NodeKind::Symbol);
        route_node.location = Some(format!("{}:{}", file, line));
        route_node.properties = serde_json::json!({
            "kind": "route",
            "framework": if file.ends_with(".py") { "django" } else { "express" },
            "method": method,
            "path": url,
        });

        // Link route → handler (find existing handler node by name match)
        let handler_node_id = find_handler_node(graph, handler, file);

        edge_counter += 1;
        let edge = Edge {
            id: format!("route_edge_{}", edge_counter),
            source: route_id.clone(),
            target: handler_node_id.clone(),
            kind: EdgeKind::Calls,
            coupling_depth: 1,
            cross_file: false,
            direction: "forward".into(),
            temporal_delay_sec: None,
            medium_node_id: None,
            lsp_resolved: false,
        };

        graph.add_node(route_node);
        graph.add_edge(edge);
        added += 1;
    }

    added
}

/// Find an existing graph node matching a handler reference.
fn find_handler_node(graph: &Graph, handler_ref: &str, _current_file: &str) -> String {
    // Try exact name match first
    for (id, node) in &graph.nodes {
        if node.name == handler_ref {
            return id.clone();
        }
        // Check if name ends with handler_ref (qualified name match)
        if node.name.ends_with(handler_ref) {
            return id.clone();
        }
    }

    // Try matching the last component (for `views.user_list` → find `user_list`)
    if let Some(last_part) = handler_ref.rsplit('.').next() {
        for (id, node) in &graph.nodes {
            if node.name == last_part {
                return id.clone();
            }
        }
    }

    // Fallback: return handler_ref as the target node ID
    // (it may not exist yet — that's ok, the edge just won't resolve to a real node)
    handler_ref.to_string()
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

#[allow(dead_code)]
fn file_key(loc: &str) -> String {
    if let Some((p, line_part)) = loc.rsplit_once(':') {
        // Guard Windows drive letter
        if p.len() == 1 && p.as_bytes()[0].is_ascii_alphabetic() {
            return loc.to_string();
        }
        // Only strip if the suffix looks like a line number
        if line_part.chars().all(|c| c.is_ascii_digit()) {
            return p.replace('\\', "/");
        }
    }
    loc.replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_django_path_basic() {
        let source = r#"
from django.urls import path
from . import views

urlpatterns = [
    path('api/users/', views.user_list, name='user-list'),
]
"#;
        let routes = detect_django_routes("api/urls.py", source);
        assert!(!routes.is_empty(), "Should detect path() call");
        let (_method, url, handler, _file, _line) = &routes[0];
        assert_eq!(url, "api/users/");
        assert!(handler.contains("user_list"), "Handler should reference user_list, got: {}", handler);
        // Note: handler might be "views.user_list" or "user_list" depending on AST parsing
        assert!(handler.contains("user_list") || handler == "user_list",
            "Expected handler to contain 'user_list', got '{}'", handler);
    }

    #[test]
    fn test_detect_django_path_class_view() {
        let source = r#"
from django.urls import path
from .views import OrderView

urlpatterns = [
    path('orders/', OrderView.as_view(), name='orders'),
]
"#;
        let routes = detect_django_routes("urls.py", source);
        assert!(!routes.is_empty(), "Should detect path() with as_view()");
    }

    #[test]
    fn test_detect_django_re_path() {
        let source = r#"
from django.urls import re_path
from . import views

urlpatterns = [
    re_path(r'^articles/(?P<slug>[-\w]+)/$', views.article_detail),
]
"#;
        let routes = detect_django_routes("urls.py", source);
        assert!(!routes.is_empty(), "Should detect re_path()");
    }

    #[test]
    fn test_detect_django_not_url_file() {
        // This test checks that non-Django files don't crash the parser
        let source = r#"
def hello():
    path("not/a/route", some_func)
"#;
        let _routes = detect_django_routes("models.py", source);
        // path() is still found (pattern match is on AST node names, not file content)
        // The file filter happens at the caller level
        // So this might still detect it — that's fine, callers filter by file name
    }

    #[test]
    fn test_detect_express_get() {
        let source = r#"
const express = require('express');
const app = express();

app.get('/api/users', (req, res) => {
    res.json({ users: [] });
});
"#;
        let routes = detect_express_routes("app.js", source);
        assert!(!routes.is_empty(), "Should detect app.get()");
        let (method, url, _handler, _file, _line) = &routes[0];
        assert_eq!(method, "GET");
        assert_eq!(url, "/api/users");
    }

    #[test]
    fn test_detect_express_post() {
        let source = r#"
const router = require('express').Router();

router.post('/api/orders', createOrder);
"#;
        let routes = detect_express_routes("routes.js", source);
        assert!(!routes.is_empty(), "Should detect router.post()");
        let (method, _url, _handler, _file, _line) = &routes[0];
        assert_eq!(method, "POST");
    }

    #[test]
    fn test_detect_express_use() {
        let source = r#"
app.use('/api/v2', v2Router);
"#;
        let routes = detect_express_routes("app.js", source);
        assert!(!routes.is_empty(), "Should detect app.use()");
        let (method, _url, _handler, _file, _line) = &routes[0];
        assert_eq!(method, "USE");
    }

    #[test]
    fn test_inject_routes_into_graph() {
        let mut g = Graph::new();

        // Pre-add a handler node
        let mut handler = Node::new("views.user_list", "user_list", NodeKind::Symbol);
        handler.location = Some("views.py:10".into());
        g.add_node(handler);

        let routes = vec![
            ("GET".into(), "/api/users".into(), "views.user_list".into(), "urls.py".into(), 5),
        ];

        let added = inject_routes(&mut g, &routes);
        assert_eq!(added, 1, "Should add 1 route node");
        assert!(g.node_count() >= 2, "Should have handler + route node");
    }

    #[test]
    fn test_file_key_strips_line_numbers() {
        assert_eq!(file_key("src/urls.py:42"), "src/urls.py");
        assert_eq!(file_key("src/urls.py"), "src/urls.py");
        assert_eq!(file_key("src/sub/dir/views.py:100"), "src/sub/dir/views.py");
    }

    #[test]
    fn test_find_handler_node_partial_match() {
        let mut g = Graph::new();
        let mut n = Node::new("myapp.views.user_list", "user_list", NodeKind::Symbol);
        n.location = Some("myapp/views.py:42".into());
        g.add_node(n);

        let found = find_handler_node(&g, "views.user_list", "myapp/urls.py");
        assert_eq!(found, "myapp.views.user_list", "Should match by last component");
    }

    // ── FastAPI tests ──

    #[test]
    fn test_detect_fastapi_get() {
        let source = r#"
from fastapi import FastAPI
app = FastAPI()

@app.get("/api/users")
async def get_users():
    return {"users": []}
"#;
        let routes = detect_fastapi_routes("main.py", source);
        assert!(!routes.is_empty(), "Should detect @app.get decorator");
        let (method, url, handler, _file, _line) = &routes[0];
        assert_eq!(method, "GET");
        assert_eq!(url, "/api/users");
        assert_eq!(handler, "get_users");
    }

    #[test]
    fn test_detect_fastapi_post() {
        let source = r#"
from fastapi import APIRouter
router = APIRouter()

@router.post("/api/orders")
def create_order():
    pass
"#;
        let routes = detect_fastapi_routes("routers/orders.py", source);
        assert!(!routes.is_empty(), "Should detect @router.post decorator");
        let (method, url, handler, _file, _line) = &routes[0];
        assert_eq!(method, "POST");
        assert_eq!(url, "/api/orders");
        assert_eq!(handler, "create_order");
    }

    #[test]
    fn test_detect_fastapi_put() {
        let source = r#"
@app.put("/api/users/{user_id}")
def update_user(user_id: int):
    pass
"#;
        let routes = detect_fastapi_routes("main.py", source);
        assert!(!routes.is_empty(), "Should detect @app.put decorator");
        let (method, url, _handler, _file, _line) = &routes[0];
        assert_eq!(method, "PUT");
        assert_eq!(url, "/api/users/{user_id}");
    }

    #[test]
    fn test_detect_fastapi_multiple_routes() {
        let source = r#"
from fastapi import FastAPI
app = FastAPI()

@app.get("/items")
def list_items(): pass

@app.post("/items")
def create_item(): pass

@app.delete("/items/{item_id}")
def delete_item(item_id: int): pass
"#;
        let routes = detect_fastapi_routes("main.py", source);
        assert_eq!(routes.len(), 3, "Should detect 3 routes");
    }

    #[test]
    fn test_fastapi_no_decorators_returns_empty() {
        let source = r#"
def plain_function():
    pass
"#;
        let routes = detect_fastapi_routes("utils.py", source);
        assert!(routes.is_empty(), "No decorators → no routes");
    }

    #[test]
    fn test_is_fastapi_candidate() {
        assert!(is_fastapi_candidate("main.py"));
        assert!(is_fastapi_candidate("routers/users.py"));
        assert!(!is_fastapi_candidate("main.js"));
        assert!(!is_fastapi_candidate("urls.ts"));
    }

    // ── Flask tests ──

    #[test]
    fn test_detect_flask_route() {
        let source = r#"
from flask import Flask
app = Flask(__name__)

@app.route("/api/users", methods=["GET", "POST"])
def users():
    return {"users": []}
"#;
        let routes = detect_flask_routes("app.py", source);
        assert!(!routes.is_empty(), "Should detect @app.route decorator");
        assert_eq!(routes[0].1, "/api/users");
        assert_eq!(routes[0].2, "users");
    }

    #[test]
    fn test_detect_flask_simple_route() {
        let source = r#"
@app.route("/health")
def health():
    return "ok"
"#;
        let routes = detect_flask_routes("app.py", source);
        assert!(!routes.is_empty(), "Should detect simple @app.route");
        assert_eq!(routes[0].1, "/health");
        // Default method is GET
        assert!(routes[0].0.contains("GET"));
    }

    // ── Rails tests ──

    #[test]
    fn test_detect_rails_get() {
        let source = r#"
Rails.application.routes.draw do
  get '/users', to: 'users#index'
  post '/users', to: 'users#create'
end
"#;
        let routes = detect_rails_routes("config/routes.rb", source);
        assert!(!routes.is_empty(), "Should detect Rails routes");
    }

    #[test]
    fn test_detect_rails_resources() {
        let source = r#"
Rails.application.routes.draw do
  resources :articles
end
"#;
        let routes = detect_rails_routes("routes.rb", source);
        assert!(!routes.is_empty(), "Should detect resources");
    }

    #[test]
    fn test_is_rails_file() {
        assert!(is_rails_file("config/routes.rb"));
        assert!(is_rails_file("routes.rb"));
        assert!(!is_rails_file("app/models/user.rb"));
    }

    // ── Spring tests ──

    #[test]
    fn test_detect_spring_get_mapping() {
        let source = r#"
@RestController
public class UserController {
    @GetMapping("/api/users")
    public List<User> getUsers() {
        return List.of();
    }
}
"#;
        let routes = detect_spring_routes("UserController.java", source);
        assert!(!routes.is_empty(), "Should detect @GetMapping");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
    }

    #[test]
    fn test_detect_spring_request_mapping() {
        let source = r#"
@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @PostMapping("/create")
    public Order create() { return null; }
}
"#;
        let routes = detect_spring_routes("OrderController.java", source);
        assert!(!routes.is_empty(), "Should detect Spring annotations");
    }

    #[test]
    fn test_is_spring_candidate() {
        assert!(is_spring_candidate("UserController.java"));
        assert!(is_spring_candidate("Service.kt"));
        assert!(!is_spring_candidate("main.py"));
    }

    // ── Gin tests ──

    #[test]
    fn test_detect_gin_get() {
        let source = r#"
package main
import "github.com/gin-gonic/gin"

func main() {
    r := gin.Default()
    r.GET("/api/users", getUsers)
}
"#;
        let routes = detect_gin_routes("main.go", source);
        assert!(!routes.is_empty(), "Should detect Gin GET route");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
    }

    #[test]
    fn test_detect_gin_post() {
        let source = r#"
r.POST("/api/orders", createOrder)
"#;
        let routes = detect_gin_routes("router.go", source);
        assert!(!routes.is_empty());
        assert_eq!(routes[0].0, "POST");
    }

    #[test]
    fn test_is_gin_candidate() {
        assert!(is_gin_candidate("main.go"));
        assert!(is_gin_candidate("router.go"));
        assert!(!is_gin_candidate("main.py"));
    }

    // ── NestJS tests ──

    #[test]
    fn test_detect_nestjs_controller() {
        let source = r#"
@Controller('users')
export class UsersController {
    @Get()
    findAll() { return []; }
}
"#;
        let routes = detect_nestjs_routes("users.controller.ts", source);
        assert!(!routes.is_empty(), "Should detect NestJS @Get route");
    }

    #[test]
    fn test_detect_nestjs_post() {
        let source = r#"
@Controller('orders')
export class OrdersController {
    @Post('create')
    create() { return {}; }
}
"#;
        let routes = detect_nestjs_routes("orders.controller.ts", source);
        assert!(!routes.is_empty());
        assert_eq!(routes[0].0, "POST");
    }

    #[test]
    fn test_is_nestjs_candidate() {
        assert!(is_nestjs_candidate("users.controller.ts"));
        assert!(is_nestjs_candidate("app.module.tsx"));
        assert!(!is_nestjs_candidate("main.py"));
    }

}
