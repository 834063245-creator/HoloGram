// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_chi_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".go")
}

/// Chi 检测的内容门控。Chi 与 Gin/Echo/Fiber 共享 Go 的
/// selector-call 形式，因此调度器在认领文件之前需确认 Chi 标记
/// （import 路径或构造函数）。
pub(crate) fn has_chi_content(source: &str) -> bool {
    source.contains("chi.NewRouter") || source.contains("go-chi/chi")
}

/// 检测 Chi 路由（go-chi/chi）。与 gin.rs 一致；`{id}` 路径参数保持
/// 原样（不做 `:id` 规范化——引擎不规范化框架参数风格）。
/// 模式：
///   r.Get("/path", handler) —— 首字母大写的方法名 → 转为大写
///   r.Route("/api", func(r chi.Router) { ... }) —— 单层前缀
///       传播：闭包体内的路由获取前缀（通过闭包的字节范围跟踪）。
///       超过一层的嵌套 Route 闭包不在处理范围内——
///       最内层前缀生效，不做组合。
pub(crate) fn detect_chi_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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
        "Get", "Post", "Put", "Delete", "Patch", "Head", "Options",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // Route 闭包体的字节范围 → 其前缀。按文档顺序记录
    // （最外层在前）；路由调用取最内层范围的前缀。
    let mut route_scopes: Vec<(usize, usize, String)> = Vec::new();

    while let Some(node) = stack.pop() {
        // Chi 路由是 selector_expression 调用：r.Get("/path", handler)
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "selector_expression" {
                    // selector_expression：r.Get → field "Get"
                    let mut sel_cursor = func.walk();
                    let method = match func.children(&mut sel_cursor)
                        .find(|c| c.kind() == "field_identifier")
                        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string()) {
                            Some(m) => m,
                            None => continue,
                        };

                    if method == "Route" {
                        // r.Route("/api", func(r chi.Router) { ... }) —— 记录
                        // 闭包的字节范围；Route 本身不发出路由
                        if let Some(args) = node.child_by_field_name("arguments") {
                            if let Some(prefix) = first_string_arg(&args, source) {
                                let mut c = args.walk();
                                for ac in args.children(&mut c) {
                                    if ac.kind() == "func_literal" {
                                        route_scopes.push((ac.start_byte(), ac.end_byte(), prefix.clone()));
                                    }
                                }
                            }
                        }
                    } else if http_methods.contains(method.as_str()) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            if let Some((m, path, handler)) = extract_chi_route(&args, &method, source) {
                                // 包含此调用的最内层记录范围生效。
                                let mut prefix = String::new();
                                for (start, end, p) in &route_scopes {
                                    if node.start_byte() >= *start && node.end_byte() <= *end {
                                        prefix = p.clone();
                                    }
                                }
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

/// path = 第一个字符串字面量参数；handler = 其后第一个非标点参数。
/// 方法名转为大写（Chi 中写为首字母大写：Get/Post/...）。
fn extract_chi_route(
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
        Some((method.to_uppercase(), path, handler))
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
