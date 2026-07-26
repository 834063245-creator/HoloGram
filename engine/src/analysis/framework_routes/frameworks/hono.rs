// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_hono_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".ts") || lower.ends_with(".js") || lower.ends_with(".mjs")
}

/// Content gate for Hono detection. Hono shares Express's `.get()/.post()/.use()`
/// call shape and `is_hono_candidate` matches every .ts/.js/.mjs file, so the
/// dispatcher must confirm Hono-specific markers before claiming the file.
pub(crate) fn has_hono_content(source: &str) -> bool {
    source.contains("from 'hono'")
        || source.contains("from \"hono\"")
        || source.contains("require('hono')")
        || source.contains("require(\"hono\")")
        || source.contains("new Hono(")
}

/// Detect Hono routes. Mirrors express.rs (handler = LAST non-punctuation arg).
/// Patterns:
///   app.get('/path', handler) — also post/put/delete/patch/options/all
///   app.use('/prefix', ...) → method USE
///   app.basePath('/api') — single-level prefix propagation: recorded in
///       statement order and prepended to subsequently detected routes in the
///       same file; the chained form app.basePath('/api').get(...) takes the
///       prefix from its own receiver chain.
///   app.route('/sub', subApp) with an identifier arg is skipped (not in the
///       method set) — the sub-app's routes are not statically resolvable here.
pub(crate) fn detect_hono_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
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
        "get", "post", "put", "delete", "patch", "options", "all",
    ]
    .iter()
    .cloned()
    .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // basePath prefix — applies to routes seen AFTER the basePath statement
    // (this walk is preorder = statement order).
    let mut current_prefix = String::new();

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "member_expression" {
                    // e.g. app.get() or app.basePath()
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
                        // app.basePath('/api') — record the prefix, emit no route.
                        // Chained form app.basePath('/api').get(...): this call is
                        // the RECEIVER of an enclosing member call — its prefix is
                        // applied per-route via chain_basepath_prefix, so it must
                        // NOT mutate the statement-level current_prefix (F3).
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

                                    // Track the last non-punctuation argument as the handler
                                    // (Hono convention, same as Express:
                                    // app.get('/path', middleware, handler))
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
                                    // Chained app.basePath('/api').get(...) takes the prefix
                                    // from its own receiver chain; otherwise the recorded one.
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

/// Walk the receiver chain of a member call looking for `basePath('/prefix')`,
/// e.g. the `app.basePath('/api')` inside `app.basePath('/api').get(...)`.
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

/// First string/template-literal argument, quotes stripped.
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
