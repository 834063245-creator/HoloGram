//! Framework route detection — ports CodeGraph's routing pattern recognition
//! into HoloGram's Rust engine. Detects web framework routes and creates
//! route nodes in the dependency graph, linking URLs to their handlers.
//!
//! Currently supports: Django, Express
//! Planned: FastAPI, Rails, Spring, Flask

use std::collections::HashSet;
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

/// A detected route: (http_method, url_pattern, handler_name, file_path, line_number)
type DetectedRoute = (String, String, String, String, usize);

/// Scan the project for framework routes and inject them into the graph.
/// Called after full analysis + cross-file resolution.
pub fn detect_framework_routes(graph: &mut Graph, project_root: &Path) -> usize {
    let mut added = 0usize;

    // Collect file paths from graph nodes AND by walking the project directory.
    // Walking the disk is essential for files that produced 0 nodes (e.g. Express
    // router files with only bare calls and imports).
    let mut files: HashSet<String> = HashSet::new();
    for node in graph.nodes.values() {
        if let Some(ref loc) = node.location {
            files.insert(file_key(loc));
        }
    }

    // Also discover candidate framework files from disk (recursive)
    for entry in walkdir::WalkDir::new(project_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        if let Ok(rel) = entry.path().strip_prefix(project_root) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if is_django_url_file(&rel_str) || is_express_file(&rel_str) {
                files.insert(rel_str);
            }
        }
    }

    for file in &files {
        let full_path = project_root.join(file);
        if let Ok(source) = std::fs::read_to_string(&full_path) {
            if is_django_url_file(file) {
                let routes = detect_django_routes(file, &source);
                added += inject_routes(graph, &routes);
            } else if is_express_file(file) {
                let routes = detect_express_routes(file, &source);
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
    if parser.set_language(&tree_sitter_python::LANGUAGE.into()).is_err() {
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
    let lang: tree_sitter::Language = if is_ts {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    } else {
        tree_sitter_javascript::LANGUAGE.into()
    };

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
        let (method, url, handler, file, _line) = &routes[0];
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
        let routes = detect_django_routes("models.py", source);
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
        let (method, url, _handler, _file, _line) = &routes[0];
        assert_eq!(method, "POST");
    }

    #[test]
    fn test_detect_express_use() {
        let source = r#"
app.use('/api/v2', v2Router);
"#;
        let routes = detect_express_routes("app.js", source);
        assert!(!routes.is_empty(), "Should detect app.use()");
        let (method, url, _handler, _file, _line) = &routes[0];
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
}
