// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_express_file(file: &str) -> bool {
    let lower = file.to_lowercase();
    if !lower.ends_with(".js") && !lower.ends_with(".ts") && !lower.ends_with(".mjs") {
        return false;
    }
    lower.contains("route") || lower.contains("router") || lower.contains("app")
}

/// D7：Express 检测的内容门控。没有此检查，Koa/Fastify 文件
/// （同样使用 `.get()`、`.post()` 等）会被误判为 Express，
/// 因为 `is_express_file` 仅基于文件名匹配。此函数检查源码中
/// Express 特有的 import/require 模式。
pub(crate) fn has_express_content(source: &str) -> bool {
    source.contains("require('express')")
        || source.contains("require(\"express\")")
        || source.contains("from 'express'")
        || source.contains("from \"express\"")
        || source.contains("import express")
        || source.contains("express()")
}

/// 检测 Express 风格的路由注册。
/// 模式：
///   app.get('/path', handler)
///   router.post('/path', middleware, handler)  —— 最后一个参数为处理函数
///   app.use('/prefix', subRouter)
pub(crate) fn detect_express_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    // 确定使用哪种 tree-sitter 语言
    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang = match GRAMMAR_LOADER.get(ext) { Some(l) => l, None => return result };

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
                    // 例如 app.get() 或 router.post()
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
                            let mut handler: String;
                            let mut found_route = false;
                            let mut last_identifier = String::new();

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

                                // 跟踪最后一个非标点参数作为处理函数
                                // Express 约定：app.get('/path', middleware, handler)
                                // 处理函数是最后一个函数参数，而非第一个。
                                if found_route && kind != "," && kind != "(" && kind != ")" {
                                    last_identifier = text.to_string();
                                }
                            }
                            handler = last_identifier;

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
