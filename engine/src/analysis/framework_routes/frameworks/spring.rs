// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use crate::engine::GRAMMAR_LOADER;
use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_spring_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".java") || lower.ends_with(".kt")
}

/// Detect Spring `@GetMapping("/path")`, `@PostMapping`, `@RequestMapping(...)` annotations.
pub(crate) fn detect_spring_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    // Determine language
    let is_kotlin = file.ends_with(".kt") || file.ends_with(".kts");
    let lang: tree_sitter::Language = if is_kotlin {
        // Kotlin tree-sitter isn't wired yet, skip
        return result;
    } else {
        GRAMMAR_LOADER.get("java").expect("java grammar")
    };

    let mut parser = tree_sitter::Parser::new();
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
        // Spring annotations sit on method_declaration or class_declaration
        if node.kind() == "method_declaration" || node.kind() == "class_declaration" {
            let mut handler_name = String::new();
            if let Some(name_node) = node.child_by_field_name("name") {
                handler_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }

            // Check for Spring annotations among modifiers/annotations
            let mut node_cursor = node.walk();
            for child in node.children(&mut node_cursor) {
                if child.kind() == "modifiers" || child.kind() == "annotation" {
                    // Scan for @RequestMapping, @GetMapping, etc.
                    find_spring_annotations(&child, source, &mut result, &handler_name, file);
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

fn find_spring_annotations(
    node: &tree_sitter::Node,
    source: &str,
    result: &mut Vec<DetectedRoute>,
    handler_name: &str,
    file: &str,
) {
    let spring_annotations: HashSet<&str> = [
        "RequestMapping", "GetMapping", "PostMapping", "PutMapping",
        "DeleteMapping", "PatchMapping",
    ]
    .iter()
    .cloned()
    .collect();

    let mut cursor = node.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = node.children(&mut cursor).collect();

    while let Some(child) = stack.pop() {
        if child.kind() == "annotation" || child.kind() == "marker_annotation" {
            // Extract annotation name
            let mut ac = child.walk();
            for ac_child in child.children(&mut ac) {
                if ac_child.kind() == "identifier" {
                    let name = ac_child.utf8_text(source.as_bytes()).unwrap_or("");
                    if spring_annotations.contains(name) {
                        // Map annotation name to HTTP method
                        let method = match name {
                            "GetMapping" => "GET",
                            "PostMapping" => "POST",
                            "PutMapping" => "PUT",
                            "DeleteMapping" => "DELETE",
                            "PatchMapping" => "PATCH",
                            _ => "ALL",
                        };
                        // Find path string in annotation arguments
                        let path = extract_spring_path(&child, source)
                            .unwrap_or_else(|| "/".to_string());
                        let line = child.start_position().row + 1;
                        result.push((
                            method.to_string(),
                            path,
                            handler_name.to_string(),
                            file.to_string(),
                            line,
                        ));
                    }
                }
            }
        }
        let mut cc = child.walk();
        let children: Vec<_> = child.children(&mut cc).collect();
        for c in children.into_iter().rev() {
            stack.push(c);
        }
    }
}

fn extract_spring_path(annotation: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cursor = annotation.walk();
    for child in annotation.children(&mut cursor) {
        if child.kind() == "annotation_argument_list" || child.kind() == "argument_list" {
            let mut ac = child.walk();
            for arg in child.children(&mut ac) {
                if arg.kind() == "string_literal" || arg.kind() == "string" {
                    return Some(arg.utf8_text(source.as_bytes()).unwrap_or("")
                        .trim_matches(&['\'', '"'][..]).to_string());
                }
                // annotation_member: value = "/path"
                if arg.kind() == "annotation_member" || arg.kind() == "element_value_pair" {
                    let mut mc = arg.walk();
                    for mchild in arg.children(&mut mc) {
                        if mchild.kind() == "string_literal" || mchild.kind() == "string" {
                            return Some(mchild.utf8_text(source.as_bytes()).unwrap_or("")
                                .trim_matches(&['\'', '"'][..]).to_string());
                        }
                    }
                }
            }
        }
    }
    None
}
