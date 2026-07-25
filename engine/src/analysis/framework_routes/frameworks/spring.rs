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
///
/// D1: Class-level `@RequestMapping` prefix is merged with method-level paths.
/// e.g. class `@RequestMapping("/api")` + method `@GetMapping("/users")` → `/api/users`.
/// The class-level annotation itself does NOT produce a route — it's a prefix only.
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
    // Stack carries (node, class_prefix) — class_prefix is the @RequestMapping path
    // from the enclosing class declaration (empty if none).
    let mut stack: Vec<(tree_sitter::Node<'_>, String)> = vec![(root, String::new())];

    while let Some((node, class_prefix)) = stack.pop() {
        if node.kind() == "class_declaration" {
            // Extract class-level @RequestMapping prefix — does NOT create a route.
            let prefix = extract_class_request_mapping_prefix(&node, source);
            let children: Vec<_> = node.children(&mut cursor).collect();
            for child in children.into_iter().rev() {
                stack.push((child, prefix.clone()));
            }
            continue;
        }

        if node.kind() == "method_declaration" {
            let mut handler_name = String::new();
            if let Some(name_node) = node.child_by_field_name("name") {
                handler_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }

            // Check for Spring annotations among modifiers/annotations
            let mut node_cursor = node.walk();
            for child in node.children(&mut node_cursor) {
                if child.kind() == "modifiers" || child.kind() == "annotation" {
                    // Scan for @GetMapping, @PostMapping, etc. (method-level annotations only)
                    find_spring_annotations(&child, source, &mut result, &handler_name, file, &class_prefix);
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push((child, class_prefix.clone()));
        }
    }

    result
}

/// Extract the class-level `@RequestMapping` path prefix from a class_declaration node.
/// Returns empty string if no class-level `@RequestMapping` is found.
fn extract_class_request_mapping_prefix(class_node: &tree_sitter::Node, source: &str) -> String {
    let mut node_cursor = class_node.walk();
    for child in class_node.children(&mut node_cursor) {
        if child.kind() == "modifiers" || child.kind() == "annotation" {
            let prefix = find_request_mapping_in_node(&child, source);
            if !prefix.is_empty() {
                return prefix;
            }
        }
    }
    String::new()
}

/// Search a modifiers/annotation subtree for a `@RequestMapping` annotation and return its path.
fn find_request_mapping_in_node(node: &tree_sitter::Node, source: &str) -> String {
    let mut cursor = node.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = node.children(&mut cursor).collect();

    while let Some(child) = stack.pop() {
        if child.kind() == "annotation" || child.kind() == "marker_annotation" {
            let mut ac = child.walk();
            for ac_child in child.children(&mut ac) {
                if ac_child.kind() == "identifier" {
                    let name = ac_child.utf8_text(source.as_bytes()).unwrap_or("");
                    if name == "RequestMapping" {
                        if let Some(path) = extract_spring_path(&child, source) {
                            return path;
                        }
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
    String::new()
}

/// Merge a class-level prefix with a method-level path.
/// e.g. ("/api", "/users") → "/api/users"; ("", "/users") → "/users"
fn merge_spring_paths(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        return path.to_string();
    }
    let p = prefix.trim_matches('/');
    let m = path.trim_matches('/');
    if m.is_empty() {
        format!("/{}", p)
    } else {
        format!("/{}/{}", p, m)
    }
}

fn find_spring_annotations(
    node: &tree_sitter::Node,
    source: &str,
    result: &mut Vec<DetectedRoute>,
    handler_name: &str,
    file: &str,
    class_prefix: &str,
) {
    // D1: Method-level annotations only — RequestMapping at method level is valid,
    // but class-level @RequestMapping is handled separately as a prefix.
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
                        // D1: Merge class-level prefix with method-level path
                        let merged_path = merge_spring_paths(class_prefix, &path);
                        let line = child.start_position().row + 1;
                        result.push((
                            method.to_string(),
                            merged_path,
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
