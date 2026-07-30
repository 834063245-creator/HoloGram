// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_hono_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".ts") || lower.ends_with(".js") || lower.ends_with(".mjs")
}

/// Hono 检测的内容门控。Hono 与 Express 共享 `.get()/.post()/.use()`
/// 调用形式，且 `is_hono_candidate` 匹配所有 .ts/.js/.mjs 文件，因此
/// 调度器在认领文件之前必须确认 Hono 特有的标记。
pub(crate) fn has_hono_content(source: &str) -> bool {
    source.contains("from 'hono'")
        || source.contains("from \"hono\"")
        || source.contains("require('hono')")
        || source.contains("require(\"hono\")")
        || source.contains("new Hono(")
}

/// 检测 Hono 路由。与 express.rs 一致（处理函数 = 最后一个非标点参数）。
/// 模式：
///   app.get('/path', handler) —— 也包括 post/put/delete/patch/options/all
///   app.use('/prefix', ...) → 方法为 USE
///   app.basePath('/api') —— 单层前缀传播：按语句顺序记录，
///       并添加到同文件中后续检测到的路由前；链式形式
///       app.basePath('/api').get(...) 从其自身的接收者链获取前缀。
///   app.route('/sub', subApp) 中标识符参数被跳过（不在方法集合中）——
///       子应用的路由在此无法静态解析。
pub(crate) fn detect_hono_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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
        "get", "post", "put", "delete", "patch", "options", "all",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // basePath 前缀——应用于在 basePath 语句之后看到的路由
    // （此遍历为先序遍历 = 语句顺序）。
    let mut current_prefix = String::new();

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "member_expression" {
                    // 例如 app.get() 或 app.basePath()
                    let mut prop_cursor = func.walk();
                    let func_children: Vec<_> = func.children(&mut prop_cursor).collect();

                    let mut method_name = String::new();

                    for fc in &func_children {
                        if fc.kind() == "property_identifier" {
                            method_name = fc.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                        }
                    }

                    let method_lower = method_name.to_lowercase();

                    if method_lower == "basepath" {
                        // app.basePath('/api') —— 记录前缀，不发出路由。
                        // 链式形式 app.basePath('/api').get(...)：此调用是
                        // 外层 member 调用的接收者——其前缀通过
                        // chain_basepath_prefix 逐路由应用，因此不得
                        // 修改语句级别的 current_prefix（F3）。
                        let is_chain_receiver = match node.parent() {
                            Some(p) if p.kind() == "member_expression" => {
                                matches!(p.child_by_field_name("object"), Some(o) if o.id() == node.id())
                            }
                            _ => false,
                        };
                        if !is_chain_receiver {
                            if let Some(args) = node.child_by_field_name("arguments") {
                                if let Some(p) = first_string_arg(&args, source) {
                                    current_prefix = p;
                                }
                            }
                        }
                    } else {
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
                                    // （Hono 约定，与 Express 相同：
                                    // app.get('/path', middleware, handler)）
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
                                    // 链式 app.basePath('/api').get(...) 从其自身的
                                    // 接收者链获取前缀；否则使用已记录的前缀。
                                    let prefix = chain_basepath_prefix(&func, source)
                                        .unwrap_or_else(|| current_prefix.clone());
                                    result.push((method, join_paths(&prefix, &route_str), handler, file.to_string(), line));
                                }
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

/// 遍历 member 调用的接收者链以查找 `basePath('/prefix')`，
/// 例如 `app.basePath('/api').get(...)` 中的 `app.basePath('/api')`。
fn chain_basepath_prefix(func: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut obj = func.child_by_field_name("object")?;
    loop {
        if obj.kind() != "call_expression" {
            return None;
        }
        let f = obj.child_by_field_name("function")?;
        if f.kind() != "member_expression" {
            return None;
        }
        let mut is_basepath = false;
        let mut c = f.walk();
        for fc in f.children(&mut c) {
            if fc.kind() == "property_identifier" {
                is_basepath = fc
                    .utf8_text(source.as_bytes())
                    .unwrap_or("")
                    .eq_ignore_ascii_case("basepath");
            }
        }
        if is_basepath {
            let args = obj.child_by_field_name("arguments")?;
            return first_string_arg(&args, source);
        }
        obj = f.child_by_field_name("object")?;
    }
}

/// 第一个字符串/模板字面量参数，去除引号。
fn first_string_arg(args: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut c = args.walk();
    for ac in args.children(&mut c) {
        if ac.kind() == "string" || ac.kind() == "template_string" {
            let text = ac.utf8_text(source.as_bytes()).unwrap_or("");
            return Some(text.trim_matches(&['\'', '"', '`'][..]).to_string());
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
