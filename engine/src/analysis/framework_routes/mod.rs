// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Framework route detection — ports CodeGraph's routing pattern recognition
//! into HoloGram's Rust engine. Detects web framework routes and creates
//! route nodes in the dependency graph, linking URLs to their handlers.
//!
//! Supports 22 call-pattern frameworks: Django, Express, FastAPI, Flask,
//! Rails, Spring, Gin, NestJS, Koa, Laravel, Phoenix, Actix, ASP.NET Core,
//! Sinatra, Fiber, Fastify, Slim, Rocket, Axum, Hono, Echo, Chi —
//! plus 2 filesystem-routing detectors: Next.js (App Router), SvelteKit.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

mod frameworks;

/// A detected route: (http_method, url_pattern, handler_name, file_path, line_number)
pub(crate) type DetectedRoute = (String, String, String, String, usize);

/// Parsed source held in the pipeline parse cache.
pub(crate) type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

// ponytail: re-export all detector fns for test module's `use super::*`
#[cfg(test)]
use frameworks::django::*;
#[cfg(test)]
use frameworks::express::*;
#[cfg(test)]
use frameworks::fastapi::*;
#[cfg(test)]
use frameworks::flask::*;
#[cfg(test)]
use frameworks::rails::*;
#[cfg(test)]
use frameworks::spring::*;
#[cfg(test)]
use frameworks::gin::*;
#[cfg(test)]
use frameworks::nestjs::*;
#[cfg(test)]
use frameworks::koa::*;
#[cfg(test)]
use frameworks::laravel::*;
#[cfg(test)]
use frameworks::phoenix::*;
#[cfg(test)]
use frameworks::actix::*;
#[cfg(test)]
use frameworks::aspnet::*;
#[cfg(test)]
use frameworks::sinatra::*;
#[cfg(test)]
use frameworks::fiber::*;
#[cfg(test)]
use frameworks::fastify::*;
#[cfg(test)]
use frameworks::slim::*;
#[cfg(test)]
use frameworks::rocket::*;
#[cfg(test)]
use frameworks::axum::*;
#[cfg(test)]
use frameworks::hono::*;
#[cfg(test)]
use frameworks::echo::*;
#[cfg(test)]
use frameworks::chi::*;
#[cfg(test)]
use frameworks::nextjs::*;
#[cfg(test)]
use frameworks::sveltekit::*;

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

    // ── Phase 2: filesystem routing (Next.js App Router, SvelteKit) ──
    // Routes are defined by file PATHS, not source call patterns, so this
    // scan lives outside the candidate chain / if-else dispatch below.
    // It must run ahead of the per-file Express branch (D7 ordering):
    // Next's `app/**/route.ts` would otherwise hit `is_express_file`'s
    // filename gate and be claimed (then dropped) by that branch first.
    let mut nextjs_routes: Vec<DetectedRoute> = Vec::new();
    let mut sveltekit_routes: Vec<DetectedRoute> = Vec::new();
    // Absolute path keys claimed by fs routing — the candidate-filter loop
    // below must skip them (F1): a route.ts importing hono/express must not
    // get a second route set from the per-file detectors.
    let mut fs_claimed: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let Ok(rel) = p.strip_prefix(project_root) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let is_next = frameworks::nextjs::is_nextjs_candidate(&rel_str);
        let is_svelte = !is_next && frameworks::sveltekit::is_sveltekit_candidate(&rel_str);
        if !is_next && !is_svelte {
            continue;
        }
        // Same absolute normalized form the candidate loop inserts into `files`.
        let fs_abs = p.to_string_lossy().replace('\\', "/");
        fs_claimed.insert(fs_abs.clone());
        // Page routes need no source; API files read source via the same
        // cache-then-disk pattern as the main loop below.
        let is_api = if is_next {
            frameworks::nextjs::nextjs_route_for_path(&rel_str).map(|m| m.1)
        } else {
            frameworks::sveltekit::sveltekit_route_for_path(&rel_str).map(|m| m.1)
        }
        .unwrap_or(false);
        let source: String;
        let mut source_opt: Option<&str> = None;
        if is_api {
            let abs_key = if rel_str.contains(':') {
                rel_str.clone()
            } else {
                project_root.join(&rel_str).to_string_lossy().replace('\\', "/")
            };
            if let Some((s, _)) = parse_cache.get(&abs_key) {
                source = s.clone();
            } else {
                match std::fs::read_to_string(project_root.join(&rel_str)) {
                    Ok(s) => source = s,
                    Err(_) => continue,
                }
            }
            source_opt = Some(&source);
        }
        // Detectors match on the RELATIVE path (they strip app/ / src/routes/
        // prefixes); the emitted tuples are rewritten to the absolute path
        // form the per-file detectors produce (F2).
        if is_next {
            nextjs_routes.extend(
                frameworks::nextjs::detect_nextjs_routes(&rel_str, source_opt)
                    .into_iter()
                    .map(|r| rewrite_fs_route_path(r, &rel_str, &fs_abs)),
            );
        } else {
            sveltekit_routes.extend(
                frameworks::sveltekit::detect_sveltekit_routes(&rel_str, source_opt)
                    .into_iter()
                    .map(|r| rewrite_fs_route_path(r, &rel_str, &fs_abs)),
            );
        }
    }
    added += inject_routes(graph, &nextjs_routes, "nextjs");
    added += inject_routes(graph, &sveltekit_routes, "sveltekit");

    // Filter the already-discovered file list (from pipeline Step 1) by framework
    // candidate patterns. This eliminates a redundant full-directory walkdir.
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        if let Ok(rel) = p.strip_prefix(project_root) {
            let abs_str = p.to_string_lossy().replace('\\', "/");
            if fs_claimed.contains(&abs_str) {
                continue; // F1: already routed by the fs scan above
            }
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if frameworks::django::is_django_url_file(&rel_str) || frameworks::express::is_express_file(&rel_str)
                || frameworks::fastapi::is_fastapi_candidate(&rel_str) || frameworks::flask::is_flask_candidate(&rel_str)
                || frameworks::rails::is_rails_file(&rel_str) || frameworks::spring::is_spring_candidate(&rel_str)
                || frameworks::gin::is_gin_candidate(&rel_str) || frameworks::nestjs::is_nestjs_candidate(&rel_str)
                || frameworks::koa::is_koa_candidate(&rel_str) || frameworks::laravel::is_laravel_candidate(&rel_str)
                || frameworks::phoenix::is_phoenix_candidate(&rel_str) || frameworks::actix::is_actix_candidate(&rel_str)
                || frameworks::aspnet::is_aspnet_candidate(&rel_str) || frameworks::sinatra::is_sinatra_candidate(&rel_str)
                || frameworks::fiber::is_fiber_candidate(&rel_str) || frameworks::fastify::is_fastify_candidate(&rel_str)
                || frameworks::slim::is_slim_candidate(&rel_str) || frameworks::rocket::is_rocket_candidate(&rel_str)
                || frameworks::axum::is_axum_candidate(&rel_str) || frameworks::hono::is_hono_candidate(&rel_str)
                || frameworks::echo::is_echo_candidate(&rel_str) || frameworks::chi::is_chi_candidate(&rel_str)
            {
                files.insert(abs_str);
            }
        }
    }

    // D6: Diagnostic log — flask.rs and fastapi.rs accept all .py files;
    // log the candidate count so broad-filter impact is observable.
    eprintln!("[framework_routes] {} candidate files", files.len());

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
        
        if let Some(cached) = source_opt {
            source = cached;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => source = s,
                Err(_) => continue,
            }
        }
        let source_ref: &str = &source;
        if frameworks::django::is_django_url_file(file) {
            let routes = frameworks::django::detect_django_routes(file, source_ref);
            added += inject_routes(graph, &routes, "django");
        } else if frameworks::hono::is_hono_candidate(file)
            && frameworks::hono::has_hono_content(source_ref)
        {
            // Hono must run BEFORE Express: is_express_file's filename gate
            // (app.ts/routes.ts) matches Hono files too and would drop them
            // when its own content gate fails.
            let routes = frameworks::hono::detect_hono_routes(file, source_ref);
            added += inject_routes(graph, &routes, "hono");
        } else if frameworks::express::is_express_file(file) {
            // D7: Content gate — prevent Koa/Fastify files from being misidentified
            // as Express (they share .get()/.post() patterns but not Express imports).
            if frameworks::express::has_express_content(source_ref) {
                let routes = frameworks::express::detect_express_routes(file, source_ref);
                added += inject_routes(graph, &routes, "express");
            }
        } else if frameworks::fastapi::is_fastapi_candidate(file) {
            if source_ref.contains("@app.") || source_ref.contains("@router.") {
                let routes = frameworks::fastapi::detect_fastapi_routes(file, source_ref);
                added += inject_routes(graph, &routes, "fastapi");
            }
        } else if frameworks::flask::is_flask_candidate(file) {
            if source_ref.contains("@app.route") || source_ref.contains("@bp.route") {
                let routes = frameworks::flask::detect_flask_routes(file, source_ref);
                added += inject_routes(graph, &routes, "flask");
            }
        } else if frameworks::rails::is_rails_file(file) {
            let routes = frameworks::rails::detect_rails_routes(file, source_ref);
            added += inject_routes(graph, &routes, "rails");
        } else if frameworks::spring::is_spring_candidate(file) {
            if source_ref.contains("@GetMapping") || source_ref.contains("@RequestMapping")
                || source_ref.contains("@PostMapping")
            {
                let routes = frameworks::spring::detect_spring_routes(file, source_ref);
                added += inject_routes(graph, &routes, "spring");
            }
        } else if frameworks::echo::is_echo_candidate(file)
            && frameworks::echo::has_echo_content(source_ref)
        {
            // Echo must run BEFORE Gin: gin's gate (`.GET(`/`.POST(`/`.Group(`)
            // matches Echo's identical selector-call shape and would claim the file.
            let routes = frameworks::echo::detect_echo_routes(file, source_ref);
            added += inject_routes(graph, &routes, "echo");
        } else if frameworks::chi::is_chi_candidate(file)
            && frameworks::chi::has_chi_content(source_ref)
        {
            let routes = frameworks::chi::detect_chi_routes(file, source_ref);
            added += inject_routes(graph, &routes, "chi");
        } else if frameworks::gin::is_gin_candidate(file) {
            if source_ref.contains(".GET(") || source_ref.contains(".POST(")
                || source_ref.contains(".Use(") || source_ref.contains(".Group(")
            {
                let routes = frameworks::gin::detect_gin_routes(file, source_ref);
                added += inject_routes(graph, &routes, "gin");
            }
        } else if frameworks::nestjs::is_nestjs_candidate(file) {
            if source_ref.contains("@Controller") || source_ref.contains("@Get")
                || source_ref.contains("@Post")
            {
                let routes = frameworks::nestjs::detect_nestjs_routes(file, source_ref);
                added += inject_routes(graph, &routes, "nestjs");
            }
        } else if frameworks::koa::is_koa_candidate(file) {
            if frameworks::koa::has_koa_content(source_ref)
                && (source_ref.contains(".get(") || source_ref.contains(".post(")
                || source_ref.contains(".use("))
            {
                let routes = frameworks::koa::detect_koa_routes(file, source_ref);
                added += inject_routes(graph, &routes, "koa");
            }
        } else if frameworks::laravel::is_laravel_candidate(file) {
            if source_ref.contains("Route::") {
                let routes = frameworks::laravel::detect_laravel_routes(file, source_ref);
                added += inject_routes(graph, &routes, "laravel");
            }
        } else if frameworks::phoenix::is_phoenix_candidate(file) {
            let routes = frameworks::phoenix::detect_phoenix_routes(file, source_ref);
            added += inject_routes(graph, &routes, "phoenix");
        } else if frameworks::axum::is_axum_candidate(file)
            && frameworks::axum::has_axum_content(source_ref)
        {
            // Axum must run BEFORE Actix: both accept every .rs file, and
            // actix's gate would silently drop Axum router files.
            let routes = frameworks::axum::detect_axum_routes(file, source_ref);
            added += inject_routes(graph, &routes, "axum");
        } else if frameworks::actix::is_actix_candidate(file)
            && frameworks::actix::has_actix_content(source_ref)
        {
            // F7: the old attribute gate (`#[get` etc.) matched Rocket's
            // identical attribute spelling, claiming pure-rocket files
            // before the rocket branch below could run.
            let routes = frameworks::actix::detect_actix_routes(file, source_ref);
            added += inject_routes(graph, &routes, "actix");
        } else if frameworks::aspnet::is_aspnet_candidate(file) {
            if source_ref.contains("[HttpGet") || source_ref.contains("[HttpPost")
                || source_ref.contains("[HttpPut") || source_ref.contains("[HttpDelete")
            {
                let routes = frameworks::aspnet::detect_aspnet_routes(file, source_ref);
                added += inject_routes(graph, &routes, "aspnet");
            }
        } else if frameworks::sinatra::is_sinatra_candidate(file) {
            if source_ref.contains("get '") || source_ref.contains("get \"")
                || source_ref.contains("post '") || source_ref.contains("post \"")
            {
                let routes = frameworks::sinatra::detect_sinatra_routes(file, source_ref);
                added += inject_routes(graph, &routes, "sinatra");
            }
        } else if frameworks::fiber::is_fiber_candidate(file) {
            if source_ref.contains(".Get(") || source_ref.contains(".Post(")
                || source_ref.contains(".Put(") || source_ref.contains(".Delete(")
            {
                let routes = frameworks::fiber::detect_fiber_routes(file, source_ref);
                added += inject_routes(graph, &routes, "fiber");
            }
        } else if frameworks::fastify::is_fastify_candidate(file) {
            if source_ref.contains(".get(") || source_ref.contains(".post(")
                || source_ref.contains(".put(") || source_ref.contains(".delete(")
            {
                let routes = frameworks::fastify::detect_fastify_routes(file, source_ref);
                added += inject_routes(graph, &routes, "fastify");
            }
        } else if frameworks::slim::is_slim_candidate(file) {
            if source_ref.contains("$app->get") || source_ref.contains("$app->post")
                || source_ref.contains("$app->put") || source_ref.contains("$app->delete")
            {
                let routes = frameworks::slim::detect_slim_routes(file, source_ref);
                added += inject_routes(graph, &routes, "slim");
            }
        } else if frameworks::rocket::is_rocket_candidate(file)
            && (source_ref.contains("#[get(") || source_ref.contains("#[post(")
                || source_ref.contains("#[put(") || source_ref.contains("#[delete("))
            {
                let routes = frameworks::rocket::detect_rocket_routes(file, source_ref);
                added += inject_routes(graph, &routes, "rocket");
            }
    }

    added
}

/// Rewrite an fs-route tuple from the relative scan path to the absolute
/// normalized path used by the per-file detectors (F2): the file field
/// always, and the handler's path prefix — page handler == file, API
/// handler == file#METHOD (only the part before '#' is a path).
fn rewrite_fs_route_path(route: DetectedRoute, rel: &str, abs: &str) -> DetectedRoute {
    let (method, url, handler, _file, line) = route;
    let handler = if handler == rel {
        abs.to_string()
    } else if let Some(rest) = handler.strip_prefix(rel) {
        if rest.starts_with('#') {
            format!("{}{}", abs, rest)
        } else {
            handler
        }
    } else {
        handler
    };
    (method, url, handler, abs.to_string(), line)
}

// ═══════════════════════════════════════════════════════════════

// ==============================================================
// Shared helpers (used by frameworks/ sub-modules)
// ==============================================================

pub(crate) fn find_first_string(node: &tree_sitter::Node, source: &str) -> Option<String> {
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
pub(crate) fn find_rails_handler(node: &tree_sitter::Node, source: &str) -> Option<String> {
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

pub(crate) fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

// Route injection into graph
// ═══════════════════════════════════════════════════════════════

pub(crate) fn inject_routes(graph: &mut Graph, routes: &[DetectedRoute], framework: &str) -> usize {
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
            "framework": framework,
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
            cross_file: is_cross_file(graph, &handler_node_id, file),
                        temporal_delay_sec: None,
            lsp_resolved: false,
            is_synthesized: false,
            metadata: None,
        };

        graph.add_node(route_node);
        graph.add_edge(edge);
        added += 1;
    }

    added
}

/// Find an existing graph node matching a handler reference.
pub(crate) fn find_handler_node(graph: &Graph, handler_ref: &str, _current_file: &str) -> String {
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

/// Check if the handler node is in a different file than the route.
fn is_cross_file(graph: &Graph, handler_node_id: &str, route_file: &str) -> bool {
    if let Some(node) = graph.nodes.get(handler_node_id) {
        if let Some(ref loc) = node.location {
            // Use file_key for consistent file-path extraction (handles drive letters)
            let norm_handler = file_key(loc);
            let norm_route = route_file.replace('\\', "/");
            return norm_handler != norm_route;
        }
    }
    // If we can't determine, default to false
    false
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

        let added = inject_routes(&mut g, &routes, "test");
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

    // ── Koa tests ──

    #[test]
    fn test_detect_koa_get() {
        let source = r#"
const Koa = require('koa');
const Router = require('koa-router');
const router = new Router();

router.get('/api/users', async (ctx) => {
    ctx.body = { users: [] };
});
"#;
        let routes = detect_koa_routes("routes.js", source);
        assert!(!routes.is_empty(), "Should detect koa-router .get()");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
    }

    #[test]
    fn test_detect_koa_post() {
        let source = r#"router.post('/api/orders', createOrder);"#;
        let routes = detect_koa_routes("router.js", source);
        assert!(!routes.is_empty(), "Should detect koa-router .post()");
        assert_eq!(routes[0].0, "POST");
    }

    #[test]
    fn test_is_koa_candidate() {
        assert!(is_koa_candidate("routes.js"));
        assert!(is_koa_candidate("koa-app.ts"));
        assert!(is_koa_candidate("middleware/index.js"));
        assert!(!is_koa_candidate("main.py"));
    }

    // ── Laravel tests ──

    #[test]
    fn test_detect_laravel_route() {
        let source = r#"<?php
use Illuminate\Support\Facades\Route;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
"#;
        let routes = detect_laravel_routes("web.php", source);
        assert_eq!(routes.len(), 2, "Should detect 2 Laravel routes");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[1].0, "POST");
    }

    #[test]
    fn test_is_laravel_candidate() {
        assert!(is_laravel_candidate("routes/web.php"));
        assert!(is_laravel_candidate("api.php"));
        assert!(!is_laravel_candidate("UserController.php"));
    }

    // ── Phoenix tests ──

    #[test]
    fn test_detect_phoenix_get() {
        let source = r#"
defmodule MyApp.Router do
  use Phoenix.Router
  pipeline :api do
    plug :accepts, ["json"]
  end
  scope "/api" do
    get "/users", UserController, :index
    post "/users", UserController, :create
  end
end
"#;
        let routes = detect_phoenix_routes("router.ex", source);
        assert!(routes.len() >= 2, "Should detect Phoenix routes, got {}", routes.len());
    }

    #[test]
    fn test_is_phoenix_candidate() {
        assert!(is_phoenix_candidate("router.ex"));
        assert!(is_phoenix_candidate("routes.ex"));
        assert!(!is_phoenix_candidate("user_controller.ex"));
    }

    // ── Actix tests ──

    #[test]
    fn test_detect_actix_get() {
        let source = r#"
use actix_web::{get, web, HttpResponse};

#[get("/users")]
async fn list_users() -> HttpResponse {
    HttpResponse::Ok().json(vec![])
}

#[post("/users")]
async fn create_user() -> HttpResponse {
    HttpResponse::Created().finish()
}
"#;
        let routes = detect_actix_routes("handlers.rs", source);
        assert_eq!(routes.len(), 2, "Should detect 2 Actix routes, got {}", routes.len());
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[1].0, "POST");
    }

    #[test]
    fn test_detect_actix_web_prefix() {
        let source = r#"
#[web::get("/health")]
async fn health() -> &'static str {
    "ok"
}
"#;
        let routes = detect_actix_routes("health.rs", source);
        assert!(!routes.is_empty(), "Should detect #[web::get]");
        assert_eq!(routes[0].1, "/health");
    }

    #[test]
    fn test_is_actix_candidate() {
        assert!(is_actix_candidate("main.rs"));
        assert!(is_actix_candidate("handlers.rs"));
        assert!(!is_actix_candidate("main.py"));
    }

    #[test]
    fn test_actix_content_gate() {
        // F7: real actix files always import actix_web
        assert!(has_actix_content("use actix_web::{get, web, HttpResponse};"));
        // Pure Rocket file — identical attribute spelling, must NOT pass the gate
        assert!(!has_actix_content("#[get(\"/api/users\")]\nfn get_users() {}"));
        // Axum file — must NOT pass the gate either
        assert!(!has_actix_content("use axum::{routing::get, Router};"));
    }

    // ── D1: Spring class-level prefix merge ──

    #[test]
    fn test_spring_class_prefix_merge() {
        let source = r#"
@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() { return List.of(); }

    @PostMapping("/users")
    public User create() { return null; }
}
"#;
        let routes = detect_spring_routes("UserController.java", source);
        assert_eq!(routes.len(), 2, "Should detect 2 method-level routes, got {}", routes.len());
        // Class-level @RequestMapping should NOT produce its own route
        assert!(routes.iter().all(|r| r.2 != "UserController"),
            "Class-level @RequestMapping should not create a route");
        // Method paths should be merged with class prefix
        assert!(routes.iter().any(|r| r.1 == "/api/users"),
            "GET path should be /api/users, got: {:?}", routes.iter().map(|r| &r.1).collect::<Vec<_>>());
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[1].0, "POST");
    }

    #[test]
    fn test_spring_no_class_prefix() {
        let source = r#"
@RestController
public class HealthController {
    @GetMapping("/health")
    public String health() { return "ok"; }
}
"#;
        let routes = detect_spring_routes("HealthController.java", source);
        assert_eq!(routes.len(), 1, "Should detect 1 route");
        assert_eq!(routes[0].1, "/health", "Path should not have a prefix when no class-level @RequestMapping");
    }

    // ── D2: Phoenix scope prefix (strengthened) ──

    #[test]
    fn test_phoenix_scope_prefix() {
        let source = r#"
defmodule MyApp.Router do
  use Phoenix.Router
  scope "/api" do
    get "/users", UserController, :index
    post "/users", UserController, :create
  end
end
"#;
        let routes = detect_phoenix_routes("router.ex", source);
        assert_eq!(routes.len(), 2, "Should detect 2 routes, got {}", routes.len());
        assert!(routes.iter().any(|r| r.1 == "/api/users"),
            "Scope prefix /api should be prepended, got: {:?}",
            routes.iter().map(|r| &r.1).collect::<Vec<_>>());
        assert!(routes.iter().all(|r| r.1.starts_with("/api/")),
            "All routes should have /api/ prefix");
    }

    #[test]
    fn test_phoenix_no_scope() {
        let source = r#"
defmodule MyApp.Router do
  use Phoenix.Router
  get "/health", HealthController, :show
end
"#;
        let routes = detect_phoenix_routes("router.ex", source);
        assert_eq!(routes.len(), 1, "Should detect 1 route");
        assert_eq!(routes[0].1, "/health", "No scope prefix should be applied");
    }

    // ── D3: Django include() preserves prefix ──

    #[test]
    fn test_django_include_not_handler() {
        let source = r#"
from django.urls import path, include

urlpatterns = [
    path('api/', include('other.urls')),
    path('users/', views.user_list, name='user-list'),
]
"#;
        let routes = detect_django_routes("urls.py", source);
        // include() should produce a route with include() handler so prefix is preserved
        let include_routes: Vec<_> = routes.iter().filter(|r| r.2.starts_with("include(")).collect();
        assert!(!include_routes.is_empty(), "include() should preserve prefix as include() route, got: {:?}", routes);
        assert!(include_routes.iter().all(|r| r.1 == "api/"), "include() route should preserve prefix 'api/'");
        assert!(routes.iter().any(|r| r.2.contains("user_list")), "Should still detect the real handler");
    }

    // ── D4: DRF register() CRUD expansion ──

    #[test]
    fn test_drf_register_crud_expansion() {
        let source = r#"
from rest_framework.routers import DefaultRouter

router = DefaultRouter()
router.register(r'users', UserViewSet)
"#;
        let routes = detect_django_routes("urls.py", source);
        assert_eq!(routes.len(), 6, "register() should expand to 6 CRUD routes, got {}", routes.len());
        // Check methods
        let methods: Vec<&str> = routes.iter().map(|r| r.0.as_str()).collect();
        assert!(methods.contains(&"GET"), "Should have GET (list/retrieve)");
        assert!(methods.contains(&"POST"), "Should have POST (create)");
        assert!(methods.contains(&"PUT"), "Should have PUT (update)");
        assert!(methods.contains(&"PATCH"), "Should have PATCH (partial_update)");
        assert!(methods.contains(&"DELETE"), "Should have DELETE (destroy)");
        // Check URLs
        assert!(routes.iter().any(|r| r.1 == "/users/"), "Should have list/create route /users/");
        assert!(routes.iter().any(|r| r.1 == "/users/{id}/"), "Should have detail route /users/{{id}}/");
        // Check handlers reference the ViewSet
        assert!(routes.iter().all(|r| r.2.starts_with("UserViewSet.")), "Handlers should be ViewSet.action");
    }

    // ── D5: ASP.NET Core tests ──

    #[test]
    fn test_detect_aspnet_route() {
        let source = r#"
[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase {
    [HttpGet("users")]
    public IActionResult GetUsers() { return Ok(); }

    [HttpPost("users")]
    public IActionResult CreateUser() { return Ok(); }
}
"#;
        let routes = detect_aspnet_routes("UsersController.cs", source);
        assert!(!routes.is_empty(), "Should detect ASP.NET routes");
        assert_eq!(routes[0].0, "GET");
        assert!(routes.iter().any(|r| r.0 == "POST"), "Should detect POST route");
    }

    #[test]
    fn test_is_aspnet_candidate() {
        assert!(is_aspnet_candidate("UsersController.cs"));
        assert!(is_aspnet_candidate("api.cs"));
        assert!(!is_aspnet_candidate("main.py"));
        assert!(!is_aspnet_candidate("app.js"));
    }

    // ── D5: Sinatra tests ──

    #[test]
    fn test_detect_sinatra_route() {
        let source = r#"
get '/api/users' do
  content_type :json
  { users: [] }.to_json
end

post '/api/users' do
  # create user
end
"#;
        let routes = detect_sinatra_routes("app.rb", source);
        assert!(!routes.is_empty(), "Should detect Sinatra routes");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
        assert!(routes.iter().any(|r| r.0 == "POST"), "Should detect POST route");
    }

    #[test]
    fn test_is_sinatra_candidate() {
        assert!(is_sinatra_candidate("app.rb"));
        assert!(is_sinatra_candidate("routes.rb"));
        assert!(!is_sinatra_candidate("main.py"));
        assert!(!is_sinatra_candidate("app.js"));
    }

    // ── D5: Fiber tests ──

    #[test]
    fn test_detect_fiber_route() {
        let source = r#"
package main
import "github.com/gofiber/fiber/v2"

func main() {
    app := fiber.New()
    app.Get("/api/users", getUsers)
    app.Post("/api/orders", createOrder)
}
"#;
        let routes = detect_fiber_routes("main.go", source);
        assert!(!routes.is_empty(), "Should detect Fiber routes");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
        assert!(routes.iter().any(|r| r.0 == "POST"), "Should detect POST route");
    }

    #[test]
    fn test_is_fiber_candidate() {
        assert!(is_fiber_candidate("main.go"));
        assert!(is_fiber_candidate("routes.go"));
        assert!(!is_fiber_candidate("main.py"));
        assert!(!is_fiber_candidate("main.js"));
    }

    // ── D5: Fastify tests ──

    #[test]
    fn test_detect_fastify_route() {
        let source = r#"
const fastify = require('fastify');
const app = fastify();

app.get('/api/users', getUsers);
app.post('/api/orders', createOrder);
"#;
        let routes = detect_fastify_routes("routes.js", source);
        assert!(!routes.is_empty(), "Should detect Fastify routes");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
        assert!(routes.iter().any(|r| r.0 == "POST"), "Should detect POST route");
    }

    #[test]
    fn test_is_fastify_candidate() {
        assert!(is_fastify_candidate("fastify-app.js"));
        assert!(is_fastify_candidate("routes.js"));
        assert!(is_fastify_candidate("plugin.ts"));
        assert!(!is_fastify_candidate("main.py"));
        assert!(!is_fastify_candidate("main.go"));
    }

    // ── D5: Slim tests ──

    #[test]
    fn test_detect_slim_route() {
        let source = r#"<?php
$app->get('/api/users', function ($req, $res) {
    return $res->withJson(['users' => []]);
});
$app->post('/api/orders', function ($req, $res) {
    return $res->withJson(['created' => true]);
});
"#;
        let routes = detect_slim_routes("routes.php", source);
        assert!(!routes.is_empty(), "Should detect Slim routes");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
        assert!(routes.iter().any(|r| r.0 == "POST"), "Should detect POST route");
    }

    #[test]
    fn test_is_slim_candidate() {
        assert!(is_slim_candidate("routes.php"));
        assert!(is_slim_candidate("app.php"));
        assert!(!is_slim_candidate("main.py"));
        assert!(!is_slim_candidate("main.js"));
    }

    // ── D5: Rocket tests ──

    #[test]
    fn test_detect_rocket_route() {
        let source = r#"
#[get("/api/users")]
fn get_users() -> &'static str {
    "users"
}

#[post("/api/orders")]
fn create_order() -> &'static str {
    "created"
}
"#;
        let routes = detect_rocket_routes("main.rs", source);
        assert!(!routes.is_empty(), "Should detect Rocket routes");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/api/users");
        assert!(routes.iter().any(|r| r.0 == "POST"), "Should detect POST route");
    }

    #[test]
    fn test_is_rocket_candidate() {
        assert!(is_rocket_candidate("main.rs"));
        assert!(is_rocket_candidate("routes.rs"));
        assert!(!is_rocket_candidate("main.py"));
        assert!(!is_rocket_candidate("main.go"));
    }

    // ── D7: Express content gate ──

    #[test]
    fn test_express_content_gate() {
        // Express file with proper imports
        assert!(has_express_content("const express = require('express');"));
        assert!(has_express_content("import express from 'express';"));
        assert!(has_express_content("const app = express();"));
        // Koa file — should NOT pass Express content gate
        assert!(!has_express_content("const Koa = require('koa');"));
        // Fastify file — should NOT pass Express content gate
        assert!(!has_express_content("const fastify = require('fastify');"));
    }

    // ── C3: framework property reflects the actual framework, not a hardcoded guess ──
    #[test]
    fn test_c3_inject_routes_framework_property() {
        let mut graph = Graph::new();
        let routes: Vec<DetectedRoute> = vec![
            ("GET".to_string(), "/users".to_string(), "index".to_string(), "app.py".to_string(), 3usize),
        ];
        let added = inject_routes(&mut graph, &routes, "flask");
        assert_eq!(added, 1);
        let route_node = graph
            .nodes
            .values()
            .find(|n| n.properties["kind"] == "route")
            .expect("route node should exist");
        assert_eq!(route_node.properties["framework"], "flask");
        // Regression: was hardcoded — every .py route became "django"
        assert_ne!(route_node.properties["framework"], "django");
        assert_eq!(route_node.properties["method"], "GET");
        assert_eq!(route_node.properties["path"], "/users");
    }

    // ── C4: cross_file reflects the handler's real location, not hardcoded false ──
    #[test]
    fn test_c4_inject_routes_cross_file() {
        let mut graph = Graph::new();
        // Handler node living in a DIFFERENT file than the route definition
        let mut handler = Node::new("handler_views_index", "index", NodeKind::Symbol);
        handler.location = Some("views.py:10".to_string());
        graph.add_node(handler);

        let routes: Vec<DetectedRoute> = vec![
            ("GET".to_string(), "/users".to_string(), "index".to_string(), "urls.py".to_string(), 3usize),
        ];
        inject_routes(&mut graph, &routes, "flask");
        let edge = graph.edges.values().next().expect("route edge should exist");
        assert_eq!(edge.target, "handler_views_index");
        assert!(edge.cross_file, "handler in views.py vs route in urls.py must be cross_file");

        // Same-file handler → cross_file == false
        let mut graph2 = Graph::new();
        let mut handler2 = Node::new("handler_urls_index", "index", NodeKind::Symbol);
        handler2.location = Some("urls.py:20".to_string());
        graph2.add_node(handler2);
        inject_routes(&mut graph2, &routes, "flask");
        let edge2 = graph2.edges.values().next().expect("route edge should exist");
        assert!(!edge2.cross_file, "handler and route both in urls.py must not be cross_file");
    }

    // ── P1: Axum tests ──

    #[test]
    fn test_detect_axum_route_multi_method() {
        let source = r#"
use axum::{routing::get, Router};

fn app() -> Router {
    Router::new().route("/users/:id", get(get_user).post(update_user))
}
"#;
        let routes = detect_axum_routes("main.rs", source);
        assert_eq!(routes.len(), 2, "one route() with two method routers → 2 routes, got {:?}", routes);
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/users/:id", "axum :id segment preserved as-is");
        assert_eq!(routes[0].2, "get_user");
        assert_eq!(routes[1].0, "POST");
        assert_eq!(routes[1].1, "/users/:id");
        assert_eq!(routes[1].2, "update_user");
    }

    #[test]
    fn test_detect_axum_inline_closure_handler() {
        let source = r#"
Router::new().route("/health", get(|| async { "ok" }))
"#;
        let routes = detect_axum_routes("main.rs", source);
        assert_eq!(routes.len(), 1, "got {:?}", routes);
        assert_eq!(routes[0].0, "GET");
        assert!(routes[0].2.starts_with("<inline@"), "closure handler should be <inline@LINE>, got {}", routes[0].2);
    }

    #[test]
    fn test_detect_axum_nest_prefix() {
        let source = r#"
Router::new()
    .route("/health", get(health))
    .nest("/api", Router::new()
        .route("/users", get(list_users))
        .route("/users/:id", get(get_user)))
"#;
        let routes = detect_axum_routes("main.rs", source);
        assert_eq!(routes.len(), 3, "inline nest router routes get the prefix, got {:?}", routes);
        // Emission order follows the call chain (outermost .nest first), not
        // source order — assert on content, not position.
        assert!(routes.iter().any(|r| r.1 == "/health"), "route outside nest keeps its path, got {:?}", routes);
        assert!(routes.iter().any(|r| r.1 == "/api/users"));
        assert!(routes.iter().any(|r| r.1 == "/api/users/:id"));
        assert_eq!(routes.iter().filter(|r| r.1.starts_with("/api/")).count(), 2);
    }

    #[test]
    fn test_detect_axum_nest_identifier_and_merge_skipped() {
        let source = r#"
Router::new()
    .nest("/api", sub_router)
    .merge(other_router)
"#;
        let routes = detect_axum_routes("main.rs", source);
        assert!(routes.is_empty(), "identifier nest + merge are not statically resolvable, got {:?}", routes);
    }

    #[test]
    fn test_detect_axum_route_with_tsr() {
        let source = r#"
Router::new().route_with_tsr("/users", get(list_users))
"#;
        let routes = detect_axum_routes("main.rs", source);
        assert_eq!(routes.len(), 1, "route_with_tsr should be detected, got {:?}", routes);
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/users");
    }

    #[test]
    fn test_axum_content_gate() {
        assert!(has_axum_content("use axum::{routing::get, Router};"));
        assert!(has_axum_content("let app = Router::new();"));
        // Actix file — should NOT pass the Axum content gate
        assert!(!has_axum_content("use actix_web::{get, web, HttpResponse};"));
        // Rocket file — should NOT pass the Axum content gate
        assert!(!has_axum_content("#[get(\"/api/users\")]\nfn get_users() {}"));
        assert!(is_axum_candidate("main.rs"));
        assert!(is_axum_candidate("src/routes.rs"));
        assert!(!is_axum_candidate("main.go"));
        assert!(!is_axum_candidate("app.ts"));
    }

    #[test]
    fn test_detect_axum_empty_source() {
        assert!(detect_axum_routes("main.rs", "").is_empty());
    }

    // ── P1: Hono tests ──

    #[test]
    fn test_detect_hono_get_post() {
        let source = r#"
import { Hono } from 'hono'
const app = new Hono()

app.get('/users', listUsers)
app.post('/users', createUser)
app.get('/users/:id', getUser)
"#;
        let routes = detect_hono_routes("app.ts", source);
        assert_eq!(routes.len(), 3, "got {:?}", routes);
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/users");
        assert_eq!(routes[0].2, "listUsers");
        assert_eq!(routes[1].0, "POST");
        assert_eq!(routes[2].1, "/users/:id", "hono :id segment preserved as-is");
    }

    #[test]
    fn test_detect_hono_use_and_all() {
        let source = r#"
import { Hono } from 'hono'
const app = new Hono()

app.use('/api/*', logger)
app.all('/fallback', fallback)
"#;
        let routes = detect_hono_routes("app.ts", source);
        assert_eq!(routes.len(), 2, "got {:?}", routes);
        assert_eq!(routes[0].0, "USE");
        assert_eq!(routes[1].0, "ALL");
    }

    #[test]
    fn test_detect_hono_basepath_prefix() {
        let source = r#"
import { Hono } from 'hono'
const app = new Hono()

app.get('/health', health)
app.basePath('/api')
app.get('/users', listUsers)
"#;
        let routes = detect_hono_routes("app.ts", source);
        assert_eq!(routes.len(), 2, "got {:?}", routes);
        assert_eq!(routes[0].1, "/health", "route before basePath keeps its path");
        assert_eq!(routes[1].1, "/api/users", "route after basePath gets the prefix");
    }

    #[test]
    fn test_detect_hono_basepath_chained() {
        let source = r#"
import { Hono } from 'hono'
const app = new Hono()

app.basePath('/api').get('/users', listUsers)
"#;
        let routes = detect_hono_routes("app.ts", source);
        assert_eq!(routes.len(), 1, "got {:?}", routes);
        assert_eq!(routes[0].1, "/api/users", "chained basePath receiver gives the prefix");
    }

    #[test]
    fn test_detect_hono_basepath_chained_no_prefix_leak() {
        // F3: the chained basePath call must not mutate the statement-level
        // prefix — a plain app.get after it keeps its own path.
        let source = r#"
import { Hono } from 'hono'
const app = new Hono()

app.basePath('/api').get('/users', listUsers)
app.get('/health', health)
"#;
        let routes = detect_hono_routes("app.ts", source);
        assert_eq!(routes.len(), 2, "got {:?}", routes);
        assert_eq!(routes[0].1, "/api/users");
        assert_eq!(routes[1].1, "/health", "chained basePath must not leak its prefix");
    }

    #[test]
    fn test_hono_content_gate() {
        assert!(has_hono_content("import { Hono } from 'hono'"));
        assert!(has_hono_content("import { Hono } from \"hono\""));
        assert!(has_hono_content("const { Hono } = require('hono')"));
        assert!(has_hono_content("const app = new Hono()"));
        // Express file — should NOT pass the Hono content gate
        assert!(!has_hono_content("const express = require('express');"));
        assert!(!has_hono_content("import express from 'express';"));
        assert!(is_hono_candidate("app.ts"));
        assert!(is_hono_candidate("server.js"));
        assert!(is_hono_candidate("index.mjs"));
        assert!(!is_hono_candidate("main.py"));
        assert!(!is_hono_candidate("main.go"));
    }

    #[test]
    fn test_detect_hono_empty_source() {
        assert!(detect_hono_routes("app.ts", "").is_empty());
    }

    // ── P1: Echo tests ──

    #[test]
    fn test_detect_echo_get() {
        let source = r#"
package main

import "github.com/labstack/echo/v4"

func main() {
    e := echo.New()
    e.GET("/users", listUsers)
}
"#;
        let routes = detect_echo_routes("main.go", source);
        assert_eq!(routes.len(), 1, "got {:?}", routes);
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[0].1, "/users");
        assert_eq!(routes[0].2, "listUsers");
    }

    #[test]
    fn test_detect_echo_methods_and_param() {
        let source = r#"
e.POST("/users", createUser)
e.PUT("/users/:id", updateUser)
e.DELETE("/users/:id", deleteUser)
"#;
        let routes = detect_echo_routes("routes.go", source);
        assert_eq!(routes.len(), 3, "got {:?}", routes);
        assert_eq!(routes[0].0, "POST");
        assert_eq!(routes[1].0, "PUT");
        assert_eq!(routes[1].1, "/users/:id", "echo :id segment preserved as-is");
        assert_eq!(routes[2].0, "DELETE");
    }

    #[test]
    fn test_detect_echo_group_prefix() {
        let source = r#"
package main

import "github.com/labstack/echo/v4"

func main() {
    e := echo.New()
    g := e.Group("/api")
    g.GET("/users", listUsers)
    g.POST("/users", createUser)
    e.GET("/health", healthCheck)
}
"#;
        let routes = detect_echo_routes("main.go", source);
        assert_eq!(routes.len(), 3, "Group itself emits no route, got {:?}", routes);
        assert_eq!(routes[0].1, "/api/users");
        assert_eq!(routes[0].0, "GET");
        assert_eq!(routes[1].1, "/api/users");
        assert_eq!(routes[1].0, "POST");
        assert_eq!(routes[2].1, "/health", "routes on e get no group prefix");
    }

    #[test]
    fn test_detect_echo_group_var_declaration() {
        // F6: `var g = e.Group(...)` records the group prefix just like `g := ...`.
        let source = r#"
package main

import "github.com/labstack/echo/v4"

func main() {
    e := echo.New()
    var g = e.Group("/api")
    g.GET("/users", listUsers)
    e.GET("/health", healthCheck)
}
"#;
        let routes = detect_echo_routes("main.go", source);
        assert_eq!(routes.len(), 2, "got {:?}", routes);
        assert_eq!(routes[0].1, "/api/users");
        assert_eq!(routes[1].1, "/health", "routes on e get no group prefix");
    }

    #[test]
    fn test_echo_content_gate() {
        assert!(has_echo_content("import \"github.com/labstack/echo/v4\""));
        assert!(has_echo_content("e := echo.New()"));
        // Gin file — should NOT pass the Echo content gate
        assert!(!has_echo_content("import \"github.com/gin-gonic/gin\""));
        // Chi file — should NOT pass the Echo content gate
        assert!(!has_echo_content("r := chi.NewRouter()"));
        assert!(is_echo_candidate("main.go"));
        assert!(is_echo_candidate("server/routes.go"));
        assert!(!is_echo_candidate("main.rs"));
        assert!(!is_echo_candidate("app.ts"));
    }

    #[test]
    fn test_detect_echo_empty_source() {
        assert!(detect_echo_routes("main.go", "").is_empty());
    }

    // ── P1: Chi tests ──

    #[test]
    fn test_detect_chi_get() {
        let source = r#"
package main

import "github.com/go-chi/chi/v5"

func main() {
    r := chi.NewRouter()
    r.Get("/users", listUsers)
}
"#;
        let routes = detect_chi_routes("main.go", source);
        assert_eq!(routes.len(), 1, "got {:?}", routes);
        assert_eq!(routes[0].0, "GET", "chi method names are uppercased");
        assert_eq!(routes[0].1, "/users");
        assert_eq!(routes[0].2, "listUsers");
    }

    #[test]
    fn test_detect_chi_param_braces_preserved() {
        let source = r#"
r.Get("/users/{id}", getUser)
"#;
        let routes = detect_chi_routes("routes.go", source);
        assert_eq!(routes.len(), 1, "got {:?}", routes);
        assert_eq!(routes[0].1, "/users/{id}", "chi {{id}} style kept as-is — no :id normalization");
    }

    #[test]
    fn test_detect_chi_route_closure_prefix() {
        let source = r#"
package main

import "github.com/go-chi/chi/v5"

func main() {
    r := chi.NewRouter()
    r.Get("/health", healthCheck)
    r.Route("/api", func(r chi.Router) {
        r.Get("/users", listUsers)
        r.Post("/users", createUser)
    })
}
"#;
        let routes = detect_chi_routes("main.go", source);
        assert_eq!(routes.len(), 3, "Route itself emits no route, got {:?}", routes);
        assert_eq!(routes[0].1, "/health", "route outside the closure gets no prefix");
        assert_eq!(routes[1].1, "/api/users");
        assert_eq!(routes[1].0, "GET");
        assert_eq!(routes[2].1, "/api/users");
        assert_eq!(routes[2].0, "POST");
    }

    #[test]
    fn test_chi_content_gate() {
        assert!(has_chi_content("import \"github.com/go-chi/chi/v5\""));
        assert!(has_chi_content("r := chi.NewRouter()"));
        // Gin file — should NOT pass the Chi content gate
        assert!(!has_chi_content("import \"github.com/gin-gonic/gin\""));
        // Echo file — should NOT pass the Chi content gate
        assert!(!has_chi_content("e := echo.New()"));
        assert!(is_chi_candidate("main.go"));
        assert!(is_chi_candidate("server/routes.go"));
        assert!(!is_chi_candidate("main.rs"));
        assert!(!is_chi_candidate("app.ts"));
    }

    #[test]
    fn test_detect_chi_empty_source() {
        assert!(detect_chi_routes("main.go", "").is_empty());
    }

    // ── P1: fixture integration — Axum + Hono + Echo + Chi through the dispatcher ──

    #[test]
    fn test_fixture_framework_routes_p1() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/framework_routes_p1");
        let discovered = walk_fixture(&fixture_root);

        let mut graph = Graph::new();
        let cache: ParseCache = HashMap::new();
        let added = detect_framework_routes(&mut graph, &fixture_root, &cache, &discovered);

        // Manifest: src/main.rs 4 (axum) + src/app.ts 3 (hono)
        //           + server/echo.go 3 (echo) + server/chi.go 4 (chi)
        assert_eq!(added, 14, "fixture route count mismatch");

        let counts = framework_counts(&graph);
        assert_eq!(counts.get("axum"), Some(&4), "axum count, got {:?}", counts);
        assert_eq!(counts.get("hono"), Some(&3), "hono count, got {:?}", counts);
        assert_eq!(counts.get("echo"), Some(&3), "echo count, got {:?}", counts);
        assert_eq!(counts.get("chi"), Some(&4), "chi count, got {:?}", counts);

        // Dispatch mutual exclusion: each file landed in its own framework's
        // branch, not in the branch that would otherwise swallow it.
        assert!(!counts.contains_key("express"), "hono app.ts must not become express");
        assert!(!counts.contains_key("gin"), "echo/chi files must not become gin");
        for n in graph.nodes.values().filter(|n| n.properties["kind"] == "route") {
            let loc = n.location.clone().unwrap_or_default();
            let fw = n.properties["framework"].as_str().unwrap_or("");
            if loc.contains("app.ts") {
                assert_eq!(fw, "hono", "app.ts routes must be hono, got {} at {}", fw, loc);
            } else if loc.contains("echo.go") {
                assert_eq!(fw, "echo", "echo.go routes must be echo, got {} at {}", fw, loc);
            } else if loc.contains("chi.go") {
                assert_eq!(fw, "chi", "chi.go routes must be chi, got {} at {}", fw, loc);
            } else if loc.contains("main.rs") {
                assert_eq!(fw, "axum", "main.rs routes must be axum, got {} at {}", fw, loc);
            }
        }

        // Prefix propagation made it through the full pipeline.
        let paths: Vec<&str> = graph.nodes.values()
            .filter(|n| n.properties["kind"] == "route")
            .filter_map(|n| n.properties["path"].as_str())
            .collect();
        assert!(paths.contains(&"/api/users/:id"), "axum nest prefix + :id, got {:?}", paths);
        assert!(paths.contains(&"/api/users/{id}"), "chi Route prefix + {{id}}, got {:?}", paths);
    }

    // ── P2: Next.js (App Router) filesystem routing ──

    #[test]
    fn test_is_nextjs_candidate() {
        assert!(is_nextjs_candidate("app/page.tsx"));
        assert!(is_nextjs_candidate("app/users/page.ts"));
        assert!(is_nextjs_candidate("app/blog/page.jsx"));
        assert!(is_nextjs_candidate("app/api/users/route.ts"));
        assert!(is_nextjs_candidate("app/api/users/route.js"));
        assert!(is_nextjs_candidate("app/api/users/route.mts"));
        assert!(is_nextjs_candidate("app/api/users/route.cts"));
        assert!(is_nextjs_candidate("src/app/dashboard/page.tsx"));
        // Reserved non-route files never match (only page.*/route.* pass)
        assert!(!is_nextjs_candidate("app/users/layout.tsx"));
        assert!(!is_nextjs_candidate("app/loading.tsx"));
        assert!(!is_nextjs_candidate("app/error.tsx"));
        assert!(!is_nextjs_candidate("app/not-found.tsx"));
        assert!(!is_nextjs_candidate("middleware.ts"));
        // Non-target paths
        assert!(!is_nextjs_candidate("components/Button.tsx"));
        assert!(!is_nextjs_candidate("src/lib/utils.ts"));
        assert!(!is_nextjs_candidate("pages/index.tsx")); // Pages Router unsupported
    }

    #[test]
    fn test_nextjs_route_for_path() {
        assert_eq!(nextjs_route_for_path("app/page.tsx"), Some(("/".into(), false)));
        assert_eq!(nextjs_route_for_path("app/users/page.tsx"), Some(("/users".into(), false)));
        assert_eq!(nextjs_route_for_path("app/users/[id]/page.tsx"), Some(("/users/:id".into(), false)));
        assert_eq!(nextjs_route_for_path("app/docs/[...slug]/page.tsx"), Some(("/docs/*".into(), false)));
        assert_eq!(nextjs_route_for_path("app/docs/[[...slug]]/page.tsx"), Some(("/docs/*".into(), false)));
        // Route groups and parallel-route slots are omitted from the URL
        assert_eq!(nextjs_route_for_path("app/(marketing)/about/page.tsx"), Some(("/about".into(), false)));
        assert_eq!(nextjs_route_for_path("app/@modal/login/page.tsx"), Some(("/login".into(), false)));
        // Intercepting routes degrade to the plain segment (known limitation)
        assert_eq!(nextjs_route_for_path("app/feed/(.)photo/page.tsx"), Some(("/feed/photo".into(), false)));
        assert_eq!(nextjs_route_for_path("app/(..)login/page.tsx"), Some(("/login".into(), false)));
        // API route files
        assert_eq!(nextjs_route_for_path("app/api/users/route.ts"), Some(("/api/users".into(), true)));
        // Reserved names and non-target paths → None
        assert_eq!(nextjs_route_for_path("app/users/layout.tsx"), None);
        assert_eq!(nextjs_route_for_path("components/Button.tsx"), None);
        assert_eq!(nextjs_route_for_path("src/lib/utils.ts"), None);
    }

    #[test]
    fn test_extract_exported_http_methods() {
        let source = r#"
import type { Request } from './types';

export async function GET() {
    return Response.json([]);
}

export function POST(request: Request) {
    return Response.json({});
}

export const PUT = async () => new Response('ok');
"#;
        assert_eq!(
            extract_exported_http_methods(source),
            vec![("GET", 4), ("POST", 8), ("PUT", 12)],
            "method + 1-based export line"
        );
        // No exported handlers → empty
        assert!(extract_exported_http_methods("const x = 1;\nfunction helper() {}").is_empty());
        // Non-exported handlers are ignored
        assert!(extract_exported_http_methods("async function GET() {}").is_empty());
    }

    #[test]
    fn test_extract_exported_http_methods_typed_const() {
        // F5: a type annotation between name and `=` is accepted.
        let source = "export const GET: RequestHandler = async () => new Response('ok');\n\
                      export const POST = async () => new Response('ok');\n";
        assert_eq!(extract_exported_http_methods(source), vec![("GET", 1), ("POST", 2)]);
        // Typed re-declaration without assignment is still not a handler
        assert!(extract_exported_http_methods("export const GET: RequestHandler;").is_empty());
    }

    #[test]
    fn test_detect_nextjs_routes_page_and_api() {
        let page = detect_nextjs_routes("app/users/page.tsx", None);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].0, "GET");
        assert_eq!(page[0].1, "/users");
        assert_eq!(page[0].2, "app/users/page.tsx", "page handler is the module file");

        let api_src = "export async function GET() {}\nexport async function POST() {}\n";
        let api = detect_nextjs_routes("app/api/users/route.ts", Some(api_src));
        assert_eq!(api.len(), 2);
        assert_eq!(api[0].0, "GET");
        assert_eq!(api[1].0, "POST");
        assert_eq!(api[0].2, "app/api/users/route.ts#GET");
        // N3: API route nodes point at the export line, not hardcoded line 1
        assert_eq!(api[0].4, 1, "GET export line");
        assert_eq!(api[1].4, 2, "POST export line");
        // API file exporting no HTTP methods → nothing
        assert!(detect_nextjs_routes("app/api/x/route.ts", Some("const y = 1;")).is_empty());
    }

    // ── P2: SvelteKit filesystem routing ──

    #[test]
    fn test_is_sveltekit_candidate() {
        assert!(is_sveltekit_candidate("src/routes/+page.svelte"));
        assert!(is_sveltekit_candidate("src/routes/users/[id]/+page.svelte"));
        assert!(is_sveltekit_candidate("src/routes/api/users/+server.ts"));
        assert!(is_sveltekit_candidate("src/routes/api/users/+server.js"));
        // Load/layout files are NOT routes
        assert!(!is_sveltekit_candidate("src/routes/+layout.svelte"));
        assert!(!is_sveltekit_candidate("src/routes/+error.svelte"));
        assert!(!is_sveltekit_candidate("src/routes/+page.ts"));
        assert!(!is_sveltekit_candidate("src/routes/+page.server.ts"));
        assert!(!is_sveltekit_candidate("src/routes/+layout.ts"));
        // Non-target paths
        assert!(!is_sveltekit_candidate("src/lib/utils.ts"));
        assert!(!is_sveltekit_candidate("src/components/Button.svelte"));
    }

    #[test]
    fn test_sveltekit_route_for_path() {
        assert_eq!(sveltekit_route_for_path("src/routes/+page.svelte"), Some(("/".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/users/[id]/+page.svelte"), Some(("/users/:id".into(), false)));
        // Optional param [[lang]] → :lang (unlike Next's optional catch-all → *)
        assert_eq!(sveltekit_route_for_path("src/routes/[[lang]]/about/+page.svelte"), Some(("/:lang/about".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/docs/[...rest]/+page.svelte"), Some(("/docs/*".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/(app)/dashboard/+page.svelte"), Some(("/dashboard".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/api/users/+server.ts"), Some(("/api/users".into(), true)));
        assert_eq!(sveltekit_route_for_path("src/routes/+layout.svelte"), None);
        assert_eq!(sveltekit_route_for_path("src/lib/utils.ts"), None);
    }

    #[test]
    fn test_sveltekit_param_matcher_stripped() {
        // F4: matcher syntax [id=integer] maps to :id (the =... is SvelteKit's
        // param-matcher annotation, not part of the URL segment).
        assert_eq!(
            sveltekit_route_for_path("src/routes/users/[id=integer]/+page.svelte"),
            Some(("/users/:id".into(), false))
        );
    }

    #[test]
    fn test_detect_sveltekit_routes_page_and_server() {
        let page = detect_sveltekit_routes("src/routes/users/[id]/+page.svelte", None);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].0, "GET");
        assert_eq!(page[0].1, "/users/:id");

        let server_src = "export async function GET() {}\nexport const POST = async () => {};\n";
        let api = detect_sveltekit_routes("src/routes/api/users/+server.ts", Some(server_src));
        assert_eq!(api.len(), 2);
        assert_eq!(api[0].0, "GET");
        assert_eq!(api[1].0, "POST");
        assert!(detect_sveltekit_routes("src/routes/api/x/+server.ts", Some("const y = 1;")).is_empty());
    }

    // ── P2: fixture integration — Next.js + SvelteKit through the dispatcher ──

    fn walk_fixture(fixture_root: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut discovered: Vec<std::path::PathBuf> = Vec::new();
        let mut dirs = vec![fixture_root.to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).expect("fixture dir readable") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    dirs.push(path);
                } else {
                    discovered.push(path);
                }
            }
        }
        discovered.sort();
        discovered
    }

    fn framework_counts(graph: &Graph) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for n in graph.nodes.values() {
            if n.properties["kind"] == "route" {
                let fw = n.properties["framework"].as_str().unwrap_or("").to_string();
                *counts.entry(fw).or_insert(0) += 1;
            }
        }
        counts
    }

    #[test]
    fn test_fixture_framework_routes_nextjs() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/framework_routes_nextjs");
        let discovered = walk_fixture(&fixture_root);

        let mut graph = Graph::new();
        let cache: ParseCache = HashMap::new();
        let added = detect_framework_routes(&mut graph, &fixture_root, &cache, &discovered);

        // Manifest: app/page.tsx 1 + app/users/page.tsx 1 + app/users/[id]/page.tsx 1
        //           + app/docs/[...slug]/page.tsx 1 + app/(marketing)/about/page.tsx 1
        //           + app/api/users/route.ts 2 (GET+POST) + src/app/dashboard/page.tsx 1
        //           + app/api/hono/route.ts 1 (GET; imports hono — F1 regression)
        assert_eq!(added, 9, "fixture route count mismatch");

        let counts = framework_counts(&graph);
        assert_eq!(counts.get("nextjs"), Some(&9), "nextjs count, got {:?}", counts);

        // Dispatch mutual exclusion: app/api/users/route.ts matches
        // is_express_file's filename gate but must yield ZERO express/hono routes.
        assert!(!counts.contains_key("express"), "nextjs route.ts must not become express");
        assert!(!counts.contains_key("hono"), "nextjs route.ts must not become hono");
        for n in graph.nodes.values().filter(|n| n.properties["kind"] == "route") {
            let loc = n.location.clone().unwrap_or_default();
            if loc.contains("route.ts") {
                assert_eq!(n.properties["framework"].as_str().unwrap_or(""), "nextjs",
                    "route.ts routes must be nextjs, at {}", loc);
            }
        }

        // F1 regression: app/api/hono/route.ts imports hono AND registers
        // app.get('/internal', ...) — the fs scan must claim the file
        // exclusively, so the hono detector never runs on it.
        let hono_file_routes: Vec<_> = graph.nodes.values()
            .filter(|n| n.properties["kind"] == "route")
            .filter(|n| n.location.as_deref().unwrap_or("").contains("api/hono/route.ts"))
            .collect();
        assert_eq!(hono_file_routes.len(), 1,
            "exactly the one exported GET, no hono detector routes");
        assert!(hono_file_routes.iter().all(|n| n.properties["framework"] == "nextjs"),
            "every route in the hono-importing file must be nextjs");
        assert_eq!(hono_file_routes[0].properties["path"], "/api/hono");
        assert!(!hono_file_routes.iter().any(|n| n.properties["path"] == "/internal"),
            "the hono-internal app.get must not leak into the graph");

        let paths: Vec<&str> = graph.nodes.values()
            .filter(|n| n.properties["kind"] == "route")
            .filter_map(|n| n.properties["path"].as_str())
            .collect();
        assert!(paths.contains(&"/"), "root page, got {:?}", paths);
        assert!(paths.contains(&"/users/:id"), "[id] page, got {:?}", paths);
        assert!(paths.contains(&"/docs/*"), "[...slug] page, got {:?}", paths);
        assert!(paths.contains(&"/about"), "(marketing) group omitted, got {:?}", paths);
        assert!(paths.contains(&"/dashboard"), "src/app page, got {:?}", paths);
        assert!(paths.contains(&"/api/users"), "api route, got {:?}", paths);
    }

    #[test]
    fn test_fixture_framework_routes_sveltekit() {
        let fixture_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/framework_routes_sveltekit");
        let discovered = walk_fixture(&fixture_root);

        let mut graph = Graph::new();
        let cache: ParseCache = HashMap::new();
        let added = detect_framework_routes(&mut graph, &fixture_root, &cache, &discovered);

        // Manifest: src/routes/+page.svelte 1 + users/[id]/+page.svelte 1
        //           + [[lang]]/about/+page.svelte 1 + (app)/dashboard/+page.svelte 1
        //           + api/users/+server.ts 2 (GET+POST)
        // +layout.svelte and +page.ts must NOT produce routes.
        assert_eq!(added, 6, "fixture route count mismatch");

        let counts = framework_counts(&graph);
        assert_eq!(counts.get("sveltekit"), Some(&6), "sveltekit count, got {:?}", counts);
        assert!(!counts.contains_key("express"), "+server.ts must not become express");
        assert!(!counts.contains_key("hono"), "+server.ts must not become hono");
        for n in graph.nodes.values().filter(|n| n.properties["kind"] == "route") {
            let loc = n.location.clone().unwrap_or_default();
            assert!(!loc.contains("+layout"), "layout produced a route: {}", loc);
            assert!(!loc.contains("+page.ts"), "load file produced a route: {}", loc);
        }

        let paths: Vec<&str> = graph.nodes.values()
            .filter(|n| n.properties["kind"] == "route")
            .filter_map(|n| n.properties["path"].as_str())
            .collect();
        assert!(paths.contains(&"/"), "root page, got {:?}", paths);
        assert!(paths.contains(&"/users/:id"), "[id] page, got {:?}", paths);
        assert!(paths.contains(&"/:lang/about"), "[[lang]] optional param, got {:?}", paths);
        assert!(paths.contains(&"/dashboard"), "(app) group omitted, got {:?}", paths);
        assert!(paths.contains(&"/api/users"), "+server endpoint, got {:?}", paths);
    }

}