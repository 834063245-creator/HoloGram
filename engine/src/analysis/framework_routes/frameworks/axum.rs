// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use super::super::DetectedRoute;

pub(crate) fn is_axum_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rs")
}

/// Axum 检测的内容门控。所有 .rs 文件都是候选（Actix 和
/// Rocket 共享该扩展名），因此调度器在认领文件之前需确认
/// Axum 特有的标记。
pub(crate) fn has_axum_content(source: &str) -> bool {
    source.contains("axum::") || source.contains("Router::new")
}

/// Axum 方法路由器：`axum::routing::{get, post, ...}` 函数及链式
/// `MethodRouter` 方法（`get(a).post(b)`）。`any` 被有意排除——
/// 它不是特定的 HTTP 方法。
const METHOD_ROUTERS: [&str; 8] = [
    "get", "post", "put", "delete", "patch", "head", "options", "trace",
];

/// 检测 Axum 路由。Axum 通过链式构建器调用注册路由：
///   Router::new().route("/path", get(handler).post(other))
///   .route_with_tsr("/path", get(handler)) —— 与 .route() 形式相同
///   .nest("/api", Router::new().route(...)) —— 单层前缀传播：
///       内联路由器参数中的路由获取 nest 前缀。
/// 限制：`.nest("/api", sub_router)` 使用裸标识符参数时无法
/// 静态解析 → 不输出；`.merge(...)` 不输出任何内容；
/// nest 中的 nest 仅将最外层前缀赋予内部路由。
pub(crate) fn detect_axum_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let mut parser = tree_sitter::Parser::new();
    let lang = match GRAMMAR_LOADER.get("rs") { Some(l) => l, None => return result };
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

/// 链式调用的方法名，例如 `route` 对应 `<expr>.route(...)`。
fn call_field_name(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let func = node.child_by_field_name("function")?;
    if func.kind() != "field_expression" {
        return None;
    }
    let field = func.child_by_field_name("field")?;
    Some(field.utf8_text(source.as_bytes()).unwrap_or("").to_string())
}

/// 当 `node` 位于 `.nest(...)` 调用的参数内时返回 true——这些
/// 路由由 nest 处理器发出（带前缀），因此主遍历跳过它们。
/// 接收者链祖先（`Router::new().route(..).nest(..)`）
/// 不计入：从节点到 nest 调用的路径必须穿过 nest 调用的
/// `arguments` 节点。
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

/// `.route("/path", <method router>)` → 方法路由器链中找到的每个
/// HTTP 方法对应一条路由。
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

/// `.nest("/prefix", inline_router)` → 内联路由器参数中的路由
/// 获取 nest 前缀（单层）。裸标识符参数
/// （`.nest("/api", sub_router)`）无法静态解析 → 不输出。
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

/// 将 `.route("/path", router)` / `.nest("/prefix", router)` 的参数分割为
/// （第一个字符串字面量，其后第一个非标点参数）。
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

/// 展开方法路由器链（`get(a).post(b)`、`routing::get(a)`）为
/// 按源码顺序的 (METHOD, handler) 对。
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
        // get(handler) 或 routing::get(handler)
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
        // get(a).post(b) —— 先递归接收者，以便按源码顺序输出。
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

/// 处理函数 = 方法路由器调用的第一个参数文本。空参数或闭包无法
/// 静态命名 → `<inline@LINE>`（express.rs 约定）。
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
