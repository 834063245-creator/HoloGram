// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_fastify_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    if !lower.ends_with(".js") && !lower.ends_with(".ts") && !lower.ends_with(".mjs") { return false; }
    lower.contains("fastify") || lower.contains("route") || lower.contains("plugin")
}

pub(crate) fn detect_fastify_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let is_ts = file.ends_with(".ts");
    let ext = if is_ts { "ts" } else { "js" };
    let lang = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() { return result; }
    let tree = match parser.parse(source, None) { Some(t) => t, None => return result };
    let methods: HashSet<&str> = ["get", "post", "put", "delete", "patch", "head", "options", "all"]
        .iter().cloned().collect();
    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                if func.kind() == "member_expression" {
                    let method = func.children(&mut func.walk())
                        .filter(|c| c.kind() == "property_identifier")
                        .last().map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())
                        .unwrap_or_default();
                    if methods.contains(&method.to_lowercase().as_str()) {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            let mut ac = args.walk();
                            let acs: Vec<_> = args.children(&mut ac).collect();
                            let path = acs.iter().filter(|c| c.kind() == "string" || c.kind() == "template_string")
                                .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").trim_matches(&['\'', '"', '`'][..]).to_string()).next().unwrap_or_default();
                            let handler = acs.iter().filter(|c| c.kind() == "identifier")
                                .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string()).next().unwrap_or_default();
                            if !path.is_empty() && !handler.is_empty() {
                                result.push((method.to_uppercase(), format!("/{}", path.trim_matches('/')), handler, file.to_string(), node.start_position().row + 1));
                            }
                        }
                    }
                }
            }
        }
        let cs: Vec<_> = node.children(&mut cursor).collect();
        for c in cs.into_iter().rev() { stack.push(c); }
    }
    result
}
