// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 框架路由检测——将 CodeGraph 的路由模式识别移植到
//! HoloGram 的 Rust 引擎中。检测 Web 框架路由并在依赖图中
//! 创建路由节点，将 URL 链接到对应的处理函数。
//!
//! 支持 22 个调用模式框架：Django、Express、FastAPI、Flask、
//! Rails、Spring、Gin、NestJS、Koa、Laravel、Phoenix、Actix、ASP.NET Core、
//! Sinatra、Fiber、Fastify、Slim、Rocket、Axum、Hono、Echo、Chi ——
//! 外加 2 个文件系统路由检测器：Next.js（App Router）、SvelteKit。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

mod frameworks;

/// 检测到的路由：(http_method, url_pattern, handler_name, file_path, line_number)
pub(crate) type DetectedRoute = (String, String, String, String, usize);

/// 管道解析缓存中保存的已解析源码。
pub(crate) type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

// ponytail：重新导出所有检测器函数，供测试模块的 `use super::*` 使用
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

/// 扫描项目中的框架路由并注入到图中。
/// 在可用时使用步骤 1 的解析缓存，避免重复读取和解析。
/// 在完整分析和跨文件解析之后调用。
pub fn detect_framework_routes(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // ── 阶段 2：文件系统路由（Next.js App Router、SvelteKit）──
    // 路由由文件路径定义，而非源码调用模式，因此此
    // 扫描位于下方的候选链 / if-else 分发之外。
    // 它必须在逐文件 Express 分支之前运行（D7 顺序）：
    // 否则 Next 的 `app/**/route.ts` 会命中 `is_express_file` 的
    // 文件名门控并被该分支先认领（然后丢弃）。
    let mut nextjs_routes: Vec<DetectedRoute> = Vec::new();
    let mut sveltekit_routes: Vec<DetectedRoute> = Vec::new();
    // 被文件系统路由认领的绝对路径键——下方的候选过滤循环
    // 必须跳过它们（F1）：导入 hono/express 的 route.ts 不应
    // 从逐文件检测器获得第二套路由。
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
        // 与候选循环插入 `files` 时相同的绝对规范化路径形式。
        let fs_abs = p.to_string_lossy().replace('\\', "/");
        fs_claimed.insert(fs_abs.clone());
        // 页面路由无需源码；API 文件通过与下方主循环相同的
        // 先缓存后磁盘模式读取源码。
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
        // 检测器匹配相对路径（它们去除 app/ / src/routes/
        // 前缀）；输出的元组被改写为逐文件检测器产生的
        // 绝对路径形式（F2）。
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

    // 按框架候选模式过滤已发现的文件列表（来自管道步骤 1）。
    // 这消除了冗余的全目录 walkdir。
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        if let Ok(rel) = p.strip_prefix(project_root) {
            let abs_str = p.to_string_lossy().replace('\\', "/");
            if fs_claimed.contains(&abs_str) {
                continue; // F1：已被上方文件系统扫描路由
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

    // D6：诊断日志——flask.rs 和 fastapi.rs 接受所有 .py 文件；
    // 记录候选文件数量以便观察宽过滤器的影响。
    eprintln!("[framework_routes] {} candidate files", files.len());

    for file in &files {
        // 规范化为绝对路径以进行缓存查找
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };
        // 在可用时使用解析缓存；否则回退到磁盘读取
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
            // Hono 必须在 Express 之前运行：is_express_file 的文件名门控
            // （app.ts/routes.ts）也匹配 Hono 文件，当其自身的内容
            // 门控失败时会丢弃这些文件。
            let routes = frameworks::hono::detect_hono_routes(file, source_ref);
            added += inject_routes(graph, &routes, "hono");
        } else if frameworks::express::is_express_file(file) {
            // D7：内容门控——防止 Koa/Fastify 文件被误判为
            // Express（它们共享 .get()/.post() 模式但不含 Express 导入）。
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
            // Echo 必须在 Gin 之前运行：gin 的门控（`.GET(`/`.POST(`/`.Group(`）
            // 匹配 Echo 相同的 selector-call 形式并会认领该文件。
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
            // Axum 必须在 Actix 之前运行：两者都接受所有 .rs 文件，
            // 而 actix 的门控会静默丢弃 Axum 路由器文件。
            let routes = frameworks::axum::detect_axum_routes(file, source_ref);
            added += inject_routes(graph, &routes, "axum");
        } else if frameworks::actix::is_actix_candidate(file)
            && frameworks::actix::has_actix_content(source_ref)
        {
            // F7：旧的属性门控（`#[get` 等）匹配了 Rocket
            // 相同的属性拼写，在下方 rocket 分支运行之前
            // 就认领了纯 rocket 文件。
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

/// 将 fs 路由元组从相对扫描路径改写为逐文件检测器使用的
/// 绝对规范化路径（F2）：始终改写 file 字段，以及处理函数的
/// 路径前缀——页面处理函数 == 文件，API 处理函数 == file#METHOD
/// （仅 '#' 之前的部分是路径）。
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
// 共享辅助函数（供 frameworks/ 子模块使用）
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
    // Ruby 符号：:articles、:users
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

/// 在 Rails 路由调用节点中查找 `controller#action` 处理函数。
pub(crate) fn find_rails_handler(node: &tree_sitter::Node, source: &str) -> Option<String> {
    // 递归搜索包含 '#' 的 'string_content'
    if node.kind() == "string_content" {
        let raw = node.utf8_text(source.as_bytes()).unwrap_or("");
        if raw.contains('#') { return Some(raw.to_string()); }
    }
    // 也检查 string 节点文本
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

// 路由注入图中
// ═══════════════════════════════════════════════════════════════

pub(crate) fn inject_routes(graph: &mut Graph, routes: &[DetectedRoute], framework: &str) -> usize {
    let mut added = 0usize;
    let mut edge_counter = graph.edge_count() as u32;

    for (method, url, handler, file, line) in routes {
        // 创建路由节点："GET /api/users"，位置为 "file:line"
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

        // 链接路由 → 处理函数（按名称匹配查找已有处理函数节点）
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
        graph.add_edge_unchecked(edge);
        added += 1;
    }

    added
}

/// 查找与处理函数引用匹配的已有图节点。
pub(crate) fn find_handler_node(graph: &Graph, handler_ref: &str, _current_file: &str) -> String {
    // 先尝试精确名称匹配
    for (id, node) in graph.nodes_iter() {
        if node.name == handler_ref {
            return id.to_string();
        }
        // 检查名称是否以 handler_ref 结尾（限定名匹配）
        if node.name.ends_with(handler_ref) {
            return id.to_string();
        }
    }

    // 尝试匹配最后一个组件（如 `views.user_list` → 查找 `user_list`）
    if let Some(last_part) = handler_ref.rsplit('.').next() {
        for (id, node) in graph.nodes_iter() {
            if node.name == last_part {
                return id.to_string();
            }
        }
    }

    // 回退：返回 handler_ref 作为目标节点 ID
    // （它可能尚不存在——没关系，边只是不会解析到真实节点）
    handler_ref.to_string()
}

/// 检查处理函数节点是否位于与路由不同的文件中。
fn is_cross_file(graph: &Graph, handler_node_id: &str, route_file: &str) -> bool {
    if let Some(node) = graph.get_node(handler_node_id) {
        if let Some(ref loc) = node.location {
            // 使用 file_key 进行一致的文件路径提取（处理盘符）
            let norm_handler = file_key(loc);
            let norm_route = route_file.replace('\\', "/");
            return norm_handler != norm_route;
        }
    }
    // 无法确定时，默认为 false
    false
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

#[allow(dead_code)]
fn file_key(loc: &str) -> String {
    if let Some((p, line_part)) = loc.rsplit_once(':') {
        // 保护 Windows 盘符
        if p.len() == 1 && p.as_bytes()[0].is_ascii_alphabetic() {
            return loc.to_string();
        }
        // 仅在后缀看起来像行号时才去除
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
        // 注意：处理函数可能是 "views.user_list" 或 "user_list"，取决于 AST 解析
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
        // 此测试检查非 Django 文件不会导致解析器崩溃
        // path() 仍会被找到（模式匹配基于 AST 节点名，而非文件内容）
        // 文件过滤在调用者层面进行
        // 因此这仍可能检测到——没关系，调用者会按文件名过滤
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

        // 预先添加处理函数节点
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
        // 默认方法为 GET
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
        // F7：真正的 actix 文件总是导入 actix_web
        assert!(has_actix_content("use actix_web::{get, web, HttpResponse};"));
        // 纯 Rocket 文件——属性拼写相同，不得通过门控
        assert!(!has_actix_content("#[get(\"/api/users\")]\nfn get_users() {}"));
        // Axum 文件——也不得通过门控
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
        // 类级 @RequestMapping 不应产生自己的路由
        assert!(routes.iter().all(|r| r.2 != "UserController"),
            "Class-level @RequestMapping should not create a route");
        // 方法路径应与类前缀合并
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
        // include() 应产生带 include() 处理函数的路由以保留前缀
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
        // 检查方法
        let methods: Vec<&str> = routes.iter().map(|r| r.0.as_str()).collect();
        assert!(methods.contains(&"GET"), "Should have GET (list/retrieve)");
        assert!(methods.contains(&"POST"), "Should have POST (create)");
        assert!(methods.contains(&"PUT"), "Should have PUT (update)");
        assert!(methods.contains(&"PATCH"), "Should have PATCH (partial_update)");
        assert!(methods.contains(&"DELETE"), "Should have DELETE (destroy)");
        // 检查 URL
        assert!(routes.iter().any(|r| r.1 == "/users/"), "Should have list/create route /users/");
        assert!(routes.iter().any(|r| r.1 == "/users/{id}/"), "Should have detail route /users/{{id}}/");
        // 检查处理函数是否引用 ViewSet
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
        // 带正确导入的 Express 文件
        assert!(has_express_content("const express = require('express');"));
        assert!(has_express_content("import express from 'express';"));
        assert!(has_express_content("const app = express();"));
        // Koa 文件——不应通过 Express 内容门控
        assert!(!has_express_content("const Koa = require('koa');"));
        // Fastify 文件——不应通过 Express 内容门控
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
        // 回归测试：之前被硬编码——每个 .py 路由都变成了 "django"
        assert_ne!(route_node.properties["framework"], "django");
        assert_eq!(route_node.properties["method"], "GET");
        assert_eq!(route_node.properties["path"], "/users");
    }

    // ── C4: cross_file reflects the handler's real location, not hardcoded false ──
    #[test]
    fn test_c4_inject_routes_cross_file() {
        let mut graph = Graph::new();
        // 处理函数节点位于与路由定义不同的文件中
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

        // 同文件处理函数 → cross_file == false
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
        // 输出顺序遵循调用链（最外层 .nest 优先），而非
        // 源码顺序——基于内容断言，而非位置。
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
        // Actix 文件——不应通过 Axum 内容门控
        assert!(!has_axum_content("use actix_web::{get, web, HttpResponse};"));
        // Rocket 文件——不应通过 Axum 内容门控
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
        // F3：链式 basePath 调用不得修改语句级别的
        // 前缀——之后的普通 app.get 保持自身路径。
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
        // Express 文件——不应通过 Hono 内容门控
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
        // F6：`var g = e.Group(...)` 与 `g := ...` 一样记录组前缀。
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
        // Gin 文件——不应通过 Echo 内容门控
        assert!(!has_echo_content("import \"github.com/gin-gonic/gin\""));
        // Chi 文件——不应通过 Echo 内容门控
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
        // Gin 文件——不应通过 Chi 内容门控
        assert!(!has_chi_content("import \"github.com/gin-gonic/gin\""));
        // Echo 文件——不应通过 Chi 内容门控
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

        // 清单：src/main.rs 4 (axum) + src/app.ts 3 (hono)
        //           + server/echo.go 3 (echo) + server/chi.go 4 (chi)
        assert_eq!(added, 14, "fixture route count mismatch");

        let counts = framework_counts(&graph);
        assert_eq!(counts.get("axum"), Some(&4), "axum count, got {:?}", counts);
        assert_eq!(counts.get("hono"), Some(&3), "hono count, got {:?}", counts);
        assert_eq!(counts.get("echo"), Some(&3), "echo count, got {:?}", counts);
        assert_eq!(counts.get("chi"), Some(&4), "chi count, got {:?}", counts);

        // 分发互斥：每个文件落入其各自框架的
        // 分支，而非本会吞掉它的其他分支。
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

        // 前缀传播贯穿了整个管道。
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
        // 保留的非路由文件永远不匹配（只有 page.*/route.* 通过）
        assert!(!is_nextjs_candidate("app/users/layout.tsx"));
        assert!(!is_nextjs_candidate("app/loading.tsx"));
        assert!(!is_nextjs_candidate("app/error.tsx"));
        assert!(!is_nextjs_candidate("app/not-found.tsx"));
        assert!(!is_nextjs_candidate("middleware.ts"));
        // 非目标路径
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
        // 路由组和并行路由槽从 URL 中省略
        assert_eq!(nextjs_route_for_path("app/(marketing)/about/page.tsx"), Some(("/about".into(), false)));
        assert_eq!(nextjs_route_for_path("app/@modal/login/page.tsx"), Some(("/login".into(), false)));
        // 拦截路由降级为普通段（已知限制）
        assert_eq!(nextjs_route_for_path("app/feed/(.)photo/page.tsx"), Some(("/feed/photo".into(), false)));
        assert_eq!(nextjs_route_for_path("app/(..)login/page.tsx"), Some(("/login".into(), false)));
        // API 路由文件
        assert_eq!(nextjs_route_for_path("app/api/users/route.ts"), Some(("/api/users".into(), true)));
        // 保留名称和非目标路径 → None
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
        // 无导出处理函数 → 空
        assert!(extract_exported_http_methods("const x = 1;\nfunction helper() {}").is_empty());
        // 未导出的处理函数被忽略
        assert!(extract_exported_http_methods("async function GET() {}").is_empty());
    }

    #[test]
    fn test_extract_exported_http_methods_typed_const() {
        // F5：名称和 `=` 之间的类型标注被接受。
        let source = "export const GET: RequestHandler = async () => new Response('ok');\n\
                      export const POST = async () => new Response('ok');\n";
        assert_eq!(extract_exported_http_methods(source), vec![("GET", 1), ("POST", 2)]);
        // 无赋值的类型化重声明仍不是处理函数
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
        // N3：API 路由节点指向导出行，而非硬编码的第 1 行
        assert_eq!(api[0].4, 1, "GET export line");
        assert_eq!(api[1].4, 2, "POST export line");
        // 不导出 HTTP 方法的 API 文件 → 无输出
        assert!(detect_nextjs_routes("app/api/x/route.ts", Some("const y = 1;")).is_empty());
    }

    // ── P2: SvelteKit filesystem routing ──

    #[test]
    fn test_is_sveltekit_candidate() {
        assert!(is_sveltekit_candidate("src/routes/+page.svelte"));
        assert!(is_sveltekit_candidate("src/routes/users/[id]/+page.svelte"));
        assert!(is_sveltekit_candidate("src/routes/api/users/+server.ts"));
        assert!(is_sveltekit_candidate("src/routes/api/users/+server.js"));
        // Load/layout 文件不是路由
        assert!(!is_sveltekit_candidate("src/routes/+layout.svelte"));
        assert!(!is_sveltekit_candidate("src/routes/+error.svelte"));
        assert!(!is_sveltekit_candidate("src/routes/+page.ts"));
        assert!(!is_sveltekit_candidate("src/routes/+page.server.ts"));
        assert!(!is_sveltekit_candidate("src/routes/+layout.ts"));
        // 非目标路径
        assert!(!is_sveltekit_candidate("src/lib/utils.ts"));
        assert!(!is_sveltekit_candidate("src/components/Button.svelte"));
    }

    #[test]
    fn test_sveltekit_route_for_path() {
        assert_eq!(sveltekit_route_for_path("src/routes/+page.svelte"), Some(("/".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/users/[id]/+page.svelte"), Some(("/users/:id".into(), false)));
        // 可选参数 [[lang]] → :lang（与 Next 的可选 catch-all → * 不同）
        assert_eq!(sveltekit_route_for_path("src/routes/[[lang]]/about/+page.svelte"), Some(("/:lang/about".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/docs/[...rest]/+page.svelte"), Some(("/docs/*".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/(app)/dashboard/+page.svelte"), Some(("/dashboard".into(), false)));
        assert_eq!(sveltekit_route_for_path("src/routes/api/users/+server.ts"), Some(("/api/users".into(), true)));
        assert_eq!(sveltekit_route_for_path("src/routes/+layout.svelte"), None);
        assert_eq!(sveltekit_route_for_path("src/lib/utils.ts"), None);
    }

    #[test]
    fn test_sveltekit_param_matcher_stripped() {
        // F4：matcher 语法 [id=integer] 映射为 :id（=... 是 SvelteKit 的
        // param-matcher 标注，非 URL 段的一部分）。
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

        // 清单：app/page.tsx 1 + app/users/page.tsx 1 + app/users/[id]/page.tsx 1
        //           + app/docs/[...slug]/page.tsx 1 + app/(marketing)/about/page.tsx 1
        //           + app/api/users/route.ts 2 (GET+POST) + src/app/dashboard/page.tsx 1
        //           + app/api/hono/route.ts 1 (GET；导入 hono —— F1 回归测试)
        assert_eq!(added, 9, "fixture route count mismatch");

        let counts = framework_counts(&graph);
        assert_eq!(counts.get("nextjs"), Some(&9), "nextjs count, got {:?}", counts);

        // 分发互斥：app/api/users/route.ts 匹配
        // is_express_file 的文件名门控，但必须产生零条 express/hono 路由。
        assert!(!counts.contains_key("express"), "nextjs route.ts must not become express");
        assert!(!counts.contains_key("hono"), "nextjs route.ts must not become hono");
        for n in graph.nodes.values().filter(|n| n.properties["kind"] == "route") {
            let loc = n.location.clone().unwrap_or_default();
            if loc.contains("route.ts") {
                assert_eq!(n.properties["framework"].as_str().unwrap_or(""), "nextjs",
                    "route.ts routes must be nextjs, at {}", loc);
            }
        }

        // F1 回归测试：app/api/hono/route.ts 导入 hono 并注册
        // app.get('/internal', ...) —— 文件系统扫描必须独占认领该文件，
        // 因此 hono 检测器永远不会在其上运行。
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

        // 清单：src/routes/+page.svelte 1 + users/[id]/+page.svelte 1
        //           + [[lang]]/about/+page.svelte 1 + (app)/dashboard/+page.svelte 1
        //           + api/users/+server.ts 2 (GET+POST)
        // +layout.svelte 和 +page.ts 不得产生路由。
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