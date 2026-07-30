// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::{HashMap, HashSet};
use super::super::DetectedRoute;

pub(crate) fn is_echo_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".go")
}

/// Echo 检测的内容门控。Echo 与 Gin 共享 `.GET()/.POST()/.Group()`
/// selector-call 形式——而 gin.rs 的门控（`.GET(` 等）会吞掉 Echo
/// 文件——因此调度器在认领文件之前需确认 Echo 标记。
pub(crate) fn has_echo_content(source: &str) -> bool {
    source.contains("echo.New") || source.contains("labstack/echo")
}

/// 检测 Echo 路由（labstack/echo）。与 gin.rs 一致。
/// 模式：
///   e.GET("/path", handler) —— selector 调用，方法名保持原样
///   g := e.Group("/api")（或 `var g = e.Group("/api")`）—— 单层
///       前缀传播：组的前缀按变量记录，并添加到同文件中后续
///       在该变量上注册的路由前。嵌套组和链式
///       `e.Group("/api").GET(...)` 接收者不做解析（单层）。
pub(crate) fn detect_echo_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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
        "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // 组变量 → 前缀（例如 `g := e.Group("/api")` 记录 g → /api）。
    let mut group_prefixes: HashMap<String, String> = HashMap::new();

    while let Some(node) = stack.pop() {
        // Echo 路由是 selector_expression 调用：e.GET("/path", handler)
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "selector_expression" {
                    // selector_expression：<operand>.<field> —— 例如 e.GET
                    let mut sel_cursor = func.walk();
                    let mut method = String::new();
                    let mut operand = String::new();
                    for c in func.children(&mut sel_cursor) {
                        match c.kind() {
                            "field_identifier" => {
                                method = c.utf8_text(source.as_bytes()).unwrap_or("").to_string()
                            }
                            "identifier" if operand.is_empty() => {
                                operand = c.utf8_text(source.as_bytes()).unwrap_or("").to_string()
                            }
                            _ => {}
                        }
                    }

                    if method == "Group" {
                        // Group 本身不发出路由——仅记录前缀映射
                        record_group_prefix(&node, source, &mut group_prefixes);
                    } else if http_methods.contains(method.as_str()) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let line = node.start_position().row + 1;
                            if let Some((m, path, handler)) = extract_echo_route(&args, &method, source) {
                                let prefix = group_prefixes.get(&operand).cloned().unwrap_or_default();
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

/// `g := e.Group("/api")` 或 `var g = e.Group("/api")` —— 当 Group 调用
/// 位于变量声明的右侧时，记录所声明变量的前缀。已知启发式限制：
/// 不同函数中的同名变量共享一个前缀条目（无作用域区分）。
fn record_group_prefix(
    node: &tree_sitter::Node,
    source: &str,
    group_prefixes: &mut HashMap<String, String>,
) {
    // call_expression → expression_list（右侧）→ short_var_declaration
    // （`g := ...`）或 var_spec（`var g = ...`）。
    let right = match node.parent() {
        Some(p) if p.kind() == "expression_list" => p,
        _ => return,
    };
    let var = match right.parent() {
        Some(d) if d.kind() == "short_var_declaration" => {
            match d.child_by_field_name("left") {
                Some(left) => first_identifier_text(&left, source),
                None => None,
            }
        }
        Some(d) if d.kind() == "var_spec" => {
            match d.child_by_field_name("name") {
                Some(name) => first_identifier_text(&name, source),
                None => None,
            }
        }
        _ => None,
    };
    let Some(var) = var else {
        return;
    };
    if var.is_empty() {
        return;
    }
    if let Some(args) = node.child_by_field_name("arguments") {
        if let Some(prefix) = first_string_arg(&args, source) {
            group_prefixes.insert(var, prefix);
        }
    }
}

/// 子树中第一个标识符的文本（即声明的变量）。
fn first_identifier_text(node: &tree_sitter::Node, source: &str) -> Option<String> {
    if node.kind() == "identifier" {
        return Some(node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
    }
    let mut c = node.walk();
    let found = node
        .children(&mut c)
        .find(|ch| ch.kind() == "identifier");
    found.map(|v| v.utf8_text(source.as_bytes()).unwrap_or("").to_string())
}

/// path = 第一个字符串字面量参数；handler = 其后第一个非标点参数。
fn extract_echo_route(
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
