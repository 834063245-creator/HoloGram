// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Per-language DI/reflection/eval/cross-lang detectors.

use std::collections::HashSet;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{Edge, EdgeKind, Graph};
use super::find_or_create_di_node;
use super::find_js_enclosing_func;
use super::is_first_arg_string_literal;

pub(crate) fn detect_python_reflection(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&GRAMMAR_LOADER.get("py").expect("python grammar"))
        .is_err()
    {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_name = func.utf8_text(source.as_bytes()).unwrap_or("");
                let is_reflective = func_name == "getattr" || func_name == "setattr";

                if is_reflective {
                    if let Some(args) = node.child_by_field_name("arguments") {
                        let line = node.start_position().row + 1;
                        if let Some((obj_ref, attr_ref, is_resolved)) =
                            extract_py_reflection_args(&args, source)
                        {
                            if is_resolved {
                                // String literal attribute → create concrete edge
                                let parent_func = find_py_enclosing_func(&node, source, file);
                                let src_id = find_or_create_di_node(
                                    graph,
                                    &parent_func,
                                    file,
                                    line,
                                );
                                let tgt_name = format!("{}.{}", obj_ref, attr_ref);
                                let tgt_id = find_or_create_di_node(
                                    graph,
                                    &tgt_name,
                                    file,
                                    line,
                                );

                                let edge_id = format!(
                                    "di_{}_{}_{}",
                                    file.replace(['.', '/', '\\'], "_"),
                                    added,
                                    line
                                );
                                if graph.get_edge(&edge_id).is_none() {
                                    let edge = Edge {
                                        id: edge_id,
                                        source: src_id,
                                        target: tgt_id,
                                        kind: EdgeKind::Calls,
                                        coupling_depth: 3, // L3: hidden data coupling
                                        cross_file: false,
                                        temporal_delay_sec: None,
                                        lsp_resolved: false,
                                        is_synthesized: false,
                                        metadata: None,
                                    };
                                    graph.add_edge(edge);
                                    added += 1;
                                }
                            } else {
                                // Variable attribute name → unresolvable, create marker
                                let marker_name =
                                    format!("<reflection:{}()>", func_name);
                                let marker_id = find_or_create_di_node(
                                    graph,
                                    &marker_name,
                                    file,
                                    line,
                                );
                                let parent_func = find_py_enclosing_func(&node, source, file);
                                let src_id = find_or_create_di_node(
                                    graph,
                                    &parent_func,
                                    file,
                                    line,
                                );

                                let edge_id = format!(
                                    "di_unresolved_{}_{}_{}",
                                    file.replace(['.', '/', '\\'], "_"),
                                    added,
                                    line
                                );
                                if graph.get_edge(&edge_id).is_none() {
                                    let edge = Edge {
                                        id: edge_id,
                                        source: src_id,
                                        target: marker_id,
                                        kind: EdgeKind::Calls,
                                        coupling_depth: 4, // L4: unresolvable hidden coupling
                                        cross_file: false,
                                        temporal_delay_sec: None,
                                        lsp_resolved: false,
                                        is_synthesized: false,
                                        metadata: None,
                                    };
                                    graph.add_edge(edge);
                                    added += 1;
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

    added
}

/// Extract (object_ref, attribute_ref, is_resolved) from getattr/setattr args.
/// is_resolved=false when the attribute name is a variable (not a string literal).
pub(crate) fn extract_py_reflection_args(
    args: &tree_sitter::Node,
    source: &str,
) -> Option<(String, String, bool)> {
    let mut ac = args.walk();
    let children: Vec<_> = args.children(&mut ac).collect();

    let mut obj_ref = String::new();
    let mut attr_ref = String::new();
    let mut is_resolved = false;
    let mut seen_first = false;

    for child in &children {
        let kind = child.kind();
        let text = child.utf8_text(source.as_bytes()).unwrap_or("");

        match kind {
            "identifier" | "attribute" => {
                if !seen_first {
                    obj_ref = text.to_string();
                    seen_first = true;
                }
                // If we see a second identifier, it's the variable attr name
            }
            "string" => {
                if seen_first {
                    // String literal attribute → resolvable!
                    attr_ref = text
                        .trim_matches(&['\'', '"', 'r', 'b', 'f'][..])
                        .to_string();
                    is_resolved = true;
                    break;
                }
            }
            "(" | ")" | "," => continue,
            _ => continue,
        }
    }

    if obj_ref.is_empty() {
        return None;
    }

    if !is_resolved {
        attr_ref = "<dynamic>".to_string();
    }

    Some((obj_ref, attr_ref, is_resolved))
}

pub(crate) fn find_py_enclosing_func(node: &tree_sitter::Node, source: &str, default_file: &str) -> String {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_definition" | "async_function_definition" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return name_node
                        .utf8_text(source.as_bytes())
                        .unwrap_or(default_file)
                        .to_string();
                }
                let line = p.start_position().row + 1;
                return format!("<fn@{}:{}>", default_file, line);
            }
            _ => {}
        }
        cur = p.parent();
    }
    format!("<module:{}>", default_file)
}

// ═══════════════════════════════════════════════════════════════
// Java: @Autowired / @Inject / @Resource DI annotations
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_java_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&GRAMMAR_LOADER.get("java").expect("java grammar"))
        .is_err()
    {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };

    let di_annotations: HashSet<&str> = ["Autowired", "Inject", "Resource"]
        .iter()
        .cloned()
        .collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // Track class context for field injection
    let mut current_class: Option<String> = None;

    while let Some(node) = stack.pop() {
        match node.kind() {
            "class_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    current_class =
                        Some(name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                }
            }
            "field_declaration" => {
                // Check for @Autowired / @Inject / @Resource on field
                if let Some(_annotation_name) =
                    find_di_annotation(&node, source, &di_annotations)
                {
                    let field_type = extract_java_field_type(&node, source);
                    let _field_name = extract_java_field_name(&node, source);
                    if !field_type.is_empty() {
                        let line = node.start_position().row + 1;
                        let class_name = current_class.as_deref().unwrap_or("<unknown>");
                        let src_id =
                            find_or_create_di_node(graph, class_name, file, line);
                        let tgt_id =
                            find_or_create_di_node(graph, &field_type, file, line);

                        let edge_id = format!(
                            "di_java_{}_{}_{}",
                            file.replace(['.', '/', '\\'], "_"),
                            added,
                            line
                        );
                        if graph.get_edge(&edge_id).is_none() {
                            let edge = Edge {
                                id: edge_id,
                                source: src_id,
                                target: tgt_id,
                                kind: EdgeKind::Calls,
                                coupling_depth: 3,
                                cross_file: true,
                                temporal_delay_sec: None,
                                lsp_resolved: false,
                                is_synthesized: false,
                                metadata: None,
                            };
                            graph.add_edge(edge);
                            added += 1;
                        }
                    }
                }
            }
            "constructor_declaration" => {
                // Check constructor parameters for @Autowired
                if let Some(params) = node.child_by_field_name("parameters") {
                    let mut pc = params.walk();
                    for param in params.children(&mut pc) {
                        if param.kind() == "formal_parameter" {
                            if let Some(_ann) =
                                find_di_annotation(&param, source, &di_annotations)
                            {
                                let param_type = extract_java_param_type(&param, source);
                                if !param_type.is_empty() {
                                    let line = param.start_position().row + 1;
                                    let class_name =
                                        current_class.as_deref().unwrap_or("<unknown>");
                                    let src_id = find_or_create_di_node(
                                        graph, class_name, file, line,
                                    );
                                    let tgt_id = find_or_create_di_node(
                                        graph, &param_type, file, line,
                                    );

                                    let edge_id = format!(
                                        "di_java_ctor_{}_{}_{}",
                                        file.replace(['.', '/', '\\'], "_"),
                                        added,
                                        line
                                    );
                                    if graph.get_edge(&edge_id).is_none() {
                                        let edge = Edge {
                                            id: edge_id,
                                            source: src_id,
                                            target: tgt_id,
                                            kind: EdgeKind::Calls,
                                            coupling_depth: 3,
                                            cross_file: true,
                                            temporal_delay_sec: None,
                                            lsp_resolved: false,
                                            is_synthesized: false,
                                            metadata: None,
                                        };
                                        graph.add_edge(edge);
                                        added += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    added
}

/// Check if a node has a DI annotation (@Autowired, @Inject, @Resource).
pub(crate) fn find_di_annotation(
    node: &tree_sitter::Node,
    source: &str,
    annotations: &HashSet<&str>,
) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "modifiers" {
            let mut mc = child.walk();
            for mod_child in child.children(&mut mc) {
                if mod_child.kind() == "marker_annotation" {
                    if let Some(name_node) = mod_child.child_by_field_name("name") {
                        let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                        if annotations.contains(name) {
                            return Some(name.to_string());
                        }
                    }
                }
            }
        }
        // Also check annotation directly on node (tree-sitter Java grammar
        // puts annotations before modifiers in some cases)
        if child.kind() == "marker_annotation" {
            if let Some(name_node) = child.child_by_field_name("name") {
                let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                if annotations.contains(name) {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

pub(crate) fn extract_java_field_type(node: &tree_sitter::Node, source: &str) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "type_identifier" | "generic_type" | "array_type" => {
                return child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }
            _ => {}
        }
    }
    String::new()
}

pub(crate) fn extract_java_field_name(node: &tree_sitter::Node, source: &str) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declarator" {
            if let Some(name_node) = child.child_by_field_name("name") {
                return name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }
        }
    }
    String::new()
}

pub(crate) fn extract_java_param_type(node: &tree_sitter::Node, source: &str) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "type_identifier" | "generic_type" => {
                return child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            }
            _ => {}
        }
    }
    String::new()
}

// ═══════════════════════════════════════════════════════════════
// TypeScript: @Injectable() / @Inject() decorators
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_ts_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang: tree_sitter::Language = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();

    // Walk program-level children: decorator and class_declaration are siblings
    // under export_statement (or directly under program for non-exported classes).
    let mut stack: Vec<tree_sitter::Node<'_>> = root.children(&mut cursor).collect();
    stack.reverse();

    while let Some(node) = stack.pop() {
        match node.kind() {
            "export_statement" => {
                // Walk children of export_statement looking for decorator + class pairs
                let mut ec = node.walk();
                let export_children: Vec<_> = node.children(&mut ec).collect();
                let mut deco_injectable = false;
                for ec_node in &export_children {
                    if ec_node.kind() == "decorator" {
                        let dec_text = ec_node.utf8_text(source.as_bytes()).unwrap_or("");
                        if dec_text.contains("Injectable") {
                            deco_injectable = true;
                        }
                    }
                    if ec_node.kind() == "class_declaration" {
                        if let Some(name_node) = ec_node.child_by_field_name("name") {
                            let class_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                            let line = ec_node.start_position().row + 1;

                            if deco_injectable {
                                // Mark the class as injectable
                                let marker_name = format!("<Injectable:{}>", class_name);
                                let src_id = find_or_create_di_node(graph, &class_name, file, line);
                                let tgt_id = find_or_create_di_node(graph, &marker_name, file, line);
                                let edge_id = format!("di_ts_injectable_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
                                if graph.get_edge(&edge_id).is_none() {
                                    graph.add_edge(Edge {
                                        id: edge_id,
                                        source: src_id,
                                        target: tgt_id,
                                        kind: EdgeKind::Calls,
                                        coupling_depth: 3,
                                        cross_file: false,
                                        temporal_delay_sec: None,
                                        lsp_resolved: false,
                                        is_synthesized: false,
                                        metadata: None,
                                    });
                                    added += 1;
                                }
                            }

                            // Extract constructor dependencies
                            added += extract_ts_constructor_deps_v2(
                                ec_node, source, &class_name, file, graph, added,
                            );
                        }
                    }
                }
            }
            "class_declaration" => {
                // Non-exported class with possible sibling decorator
                // Walk backwards through siblings to find decorator
                if let Some(name_node) = node.child_by_field_name("name") {
                    let class_name = name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();

                    added += extract_ts_constructor_deps_v2(
                        &node, source, &class_name, file, graph, added,
                    );
                }
            }
            _ => {}
        }
    }

    added
}

/// Extract constructor parameter dependencies from a class_declaration node.
/// Returns the number of new edges added.
pub(crate) fn extract_ts_constructor_deps_v2(
    class_node: &tree_sitter::Node,
    source: &str,
    class_name: &str,
    file: &str,
    graph: &mut Graph,
    mut added: usize,
) -> usize {
    let mut cursor = class_node.walk();
    for child in class_node.children(&mut cursor) {
        if child.kind() == "class_body" {
            let mut bc = child.walk();
            for member in child.children(&mut bc) {
                // Constructor is a method_definition with property_identifier "constructor"
                if member.kind() == "method_definition" {
                    let is_constructor = member.children(&mut member.walk()).any(|c| {
                        c.kind() == "property_identifier"
                            && c.utf8_text(source.as_bytes()).unwrap_or("") == "constructor"
                    });
                    if is_constructor {
                        if let Some(params) = member.child_by_field_name("parameters") {
                            let mut pc = params.walk();
                            for param in params.children(&mut pc) {
                                if param.kind() == "required_parameter"
                                    || param.kind() == "optional_parameter"
                                {
                                    // Get type from type_annotation child
                                    let param_type = extract_ts_param_type_v2(&param, source);
                                    if !param_type.is_empty() {
                                        let line = param.start_position().row + 1;
                                        let src_id = find_or_create_di_node(graph, class_name, file, line);
                                        let tgt_id = find_or_create_di_node(graph, &param_type, file, line);

                                        let edge_id = format!(
                                            "di_ts_param_{}_{}_{}",
                                            file.replace(['.', '/', '\\'], "_"),
                                            added,
                                            line
                                        );
                                        if graph.get_edge(&edge_id).is_none() {
                                            graph.add_edge(Edge {
                                                id: edge_id,
                                                source: src_id,
                                                target: tgt_id,
                                                kind: EdgeKind::Calls,
                                                coupling_depth: 3,
                                                cross_file: true,
                                                temporal_delay_sec: None,
                                                lsp_resolved: false,
                                                is_synthesized: false,
                                                metadata: None,
                                            });
                                            added += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    added
}

pub(crate) fn extract_ts_param_type_v2(node: &tree_sitter::Node, source: &str) -> String {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "type_annotation" {
            let mut tc = child.walk();
            for tc_child in child.children(&mut tc) {
                if tc_child.kind() == "type_identifier" || tc_child.kind() == "generic_type" {
                    return tc_child.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                }
            }
        }
    }
    String::new()
}

// ═══════════════════════════════════════════════════════════════
pub(crate) fn detect_python_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("py").expect("python grammar")).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_name = func.utf8_text(source.as_bytes()).unwrap_or("");
                // __import__(name) — built-in dynamic import
                // importlib.import_module(name) / import_module(name) — stdlib dynamic import
                let is_dyn_import = func_name == "__import__"
                    || func_name.ends_with(".import_module")
                    || func_name == "import_module";

                if is_dyn_import {
                    let line = node.start_position().row + 1;
                    let enclosing = find_py_enclosing_func(&node, source, file);

                    // Find the module name argument (first string or variable)
                    let module_arg = if let Some(args) = node.child_by_field_name("arguments") {
                        let mut ac = args.walk();
                        let children: Vec<_> = args.children(&mut ac).collect();
                        children.iter()
                            .find(|c| c.kind() == "string" || c.kind() == "identifier")
                            .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("<unknown>").to_string())
                            .unwrap_or_else(|| "<unknown>".to_string())
                    } else { "<unknown>".to_string() };

                    let marker = format!("<dynamic-import:{}>", module_arg.trim_matches(&['\'', '"'][..]));
                    let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                    let tgt_id = find_or_create_di_node(graph, &marker, file, line);

                    let edge_id = format!("di_dynimp_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        graph.add_edge(Edge {
                            id: edge_id, source: src_id, target: tgt_id,
                            kind: EdgeKind::Calls, coupling_depth: 4,
                            cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                        });
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

pub(crate) fn detect_js_ts_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang: tree_sitter::Language = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() { return 0; }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_text = func.utf8_text(source.as_bytes()).unwrap_or("");

                // import(variable) — the function node is the "import" keyword
                let is_dyn_import_keyword = func_text == "import";

                // require(expr) where expr is NOT a string literal
                let is_dyn_require = func_text == "require"
                    && !is_first_arg_string_literal(&node, source);

                if is_dyn_import_keyword || is_dyn_require {
                    let line = node.start_position().row + 1;
                    let enclosing = find_js_enclosing_func(&node, source, file);
                    let desc = if is_dyn_import_keyword { "import()" } else { "require()" };
                    let marker = format!("<dynamic-import:{}>", desc);

                    let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                    let tgt_id = find_or_create_di_node(graph, &marker, file, line);

                    let edge_id = format!("di_dynimp_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        graph.add_edge(Edge {
                            id: edge_id, source: src_id, target: tgt_id,
                            kind: EdgeKind::Calls, coupling_depth: 4,
                            cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                        });
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

/// Check if a call_expression's first argument is a string literal.
pub(crate) fn detect_python_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("py").expect("python grammar")).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let eval_funcs: HashSet<&str> = ["eval", "exec", "compile", "execfile"]
        .iter().cloned().collect();

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_name = func.utf8_text(source.as_bytes()).unwrap_or("");
                if eval_funcs.contains(func_name) {
                    let line = node.start_position().row + 1;
                    let enclosing = find_py_enclosing_func(&node, source, file);
                    let marker = format!("<{}>", func_name);

                    let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                    let tgt_id = find_or_create_di_node(graph, &marker, file, line);

                    let edge_id = format!("di_eval_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        graph.add_edge(Edge {
                            id: edge_id, source: src_id, target: tgt_id,
                            kind: EdgeKind::Calls, coupling_depth: 4,
                            cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                        });
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

pub(crate) fn detect_js_ts_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang: tree_sitter::Language = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() { return 0; }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "call_expression" => {
                if let Some(func) = node.child_by_field_name("function") {
                    let func_text = func.utf8_text(source.as_bytes()).unwrap_or("");
                    // eval(code) — direct eval
                    if func_text == "eval" {
                        let line = node.start_position().row + 1;
                        let enclosing = find_js_enclosing_func(&node, source, file);
                        let marker = "<eval>".to_string();

                        let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                        let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                        let edge_id = format!("di_eval_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                        if graph.get_edge(&edge_id).is_none() {
                            graph.add_edge(Edge {
                                id: edge_id, source: src_id, target: tgt_id,
                                kind: EdgeKind::Calls, coupling_depth: 4,
                                cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                            });
                            added += 1;
                        }
                    }
                }
            }
            "new_expression" => {
                // new Function(body) — dynamic code generation
                if let Some(ctor) = node.child_by_field_name("constructor") {
                    let ctor_text = ctor.utf8_text(source.as_bytes()).unwrap_or("");
                    if ctor_text == "Function" {
                        let line = node.start_position().row + 1;
                        let enclosing = find_js_enclosing_func(&node, source, file);
                        let marker = "<eval:new-Function>".to_string();

                        let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                        let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                        let edge_id = format!("di_eval_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                        if graph.get_edge(&edge_id).is_none() {
                            graph.add_edge(Edge {
                                id: edge_id, source: src_id, target: tgt_id,
                                kind: EdgeKind::Calls, coupling_depth: 4,
                                cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                            });
                            added += 1;
                        }
                    }
                }
            }
            _ => {}
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}


// ═══════════════════════════════════════════════════════════════
pub(crate) fn detect_cs_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    // C# DI patterns are primarily [FromServices] / constructor injection.
    // Static tree-sitter resolution is limited; we do a line-based scan
    // for Assembly.Load / Type.GetType / Activator.CreateInstance.
    let mut added = 0usize;
    for (line_idx, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("Assembly.Load") || t.contains("Type.GetType")
            || t.contains("Activator.CreateInstance")
        {
            let fname = format!("<fn@{}:{}>", file, line_idx + 1);
            let marker = format!("<reflection:C#:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &fname, file, line_idx + 1);
            let tid = find_or_create_di_node(graph, &marker, file, line_idx + 1);
            let eid = format!("di_cs_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_cs_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("Assembly.LoadFile") || t.contains("Assembly.LoadFrom")
            || (t.contains("Assembly.Load(") && !t.contains("Assembly.Load(\""))
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = "<dynamic-import:C#:Assembly>".to_string();
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_csdyn_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_cs_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("CSharpCodeProvider") || t.contains("CodeDomProvider")
            || t.contains("Microsoft.CodeAnalysis.CSharp.Scripting")
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = "<eval:C#:CodeDom>".to_string();
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_csev_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_cs_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("Process.Start") {
            let m = "<cross-lang:subprocess:Process.Start>".to_string();
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_cs_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
        if t.contains("HttpClient") || t.contains("GetAsync") || t.contains("PostAsync") {
            let m = format!("<cross-lang:http:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_cs_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Ruby: send, method_missing, eval, autoload, system
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_ruby_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains(".send(") || t.contains(".public_send(")
            || t.contains("method_missing") || t.contains("define_method")
            || t.contains("respond_to?")
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = format!("<reflection:Ruby:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_rb_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_ruby_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if (t.contains("autoload ") || t.contains("require ") || t.contains("load "))
            && (t.contains('$') || t.contains("var"))
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = "<dynamic-import:Ruby>".to_string();
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_rbdyn_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_ruby_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        let marker = if t.contains("eval(") || t.contains("instance_eval") || t.contains("class_eval") {
            Some(format!("<eval:Ruby:{}>", t.chars().take(30).collect::<String>()))
        } else { None };
        if let Some(m) = marker {
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_rbev_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_ruby_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        let marker = if t.contains("Open3.") || t.contains("system(") || t.contains("`") || t.contains("spawn(") || t.contains("Process.spawn") {
            Some("<cross-lang:subprocess:Ruby>".to_string())
        } else if t.contains("Net::HTTP") || t.contains("Faraday") || t.contains("RestClient") || t.contains("HTTParty") {
            Some(format!("<cross-lang:http:{}>", t.chars().take(40).collect::<String>()))
        } else { None };
        if let Some(m) = marker {
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_rb_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// PHP: ReflectionClass, eval, require_once(expr), exec
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_php_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("ReflectionClass") || t.contains("ReflectionMethod")
            || t.contains("new $class") || t.contains("->$method")
            || t.contains("call_user_func")
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = format!("<reflection:PHP:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_php_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_php_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if (t.contains("require_once") || t.contains("require ") || t.contains("include_once") || t.contains("include "))
            && (t.contains('$') || t.contains("__DIR__"))
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = "<dynamic-import:PHP>".to_string();
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_phpdyn_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_php_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("eval(") || t.contains("create_function") || t.contains("assert(") {
            let m = format!("<eval:PHP:{}>", t.chars().take(30).collect::<String>());
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_phpev_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_php_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        let marker = if t.contains("exec(") || t.contains("shell_exec") || t.contains("system(") || t.contains("passthru") || t.contains("popen(") || t.contains("proc_open") {
            Some("<cross-lang:subprocess:PHP>".to_string())
        } else if t.contains("curl_exec") || t.contains("file_get_contents") || t.contains("GuzzleHttp") || t.contains("HttpClient") {
            Some("<cross-lang:http:PHP>".to_string())
        } else { None };
        if let Some(m) = marker {
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_php_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Go: reflect
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_go_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("reflect.ValueOf") || t.contains("reflect.TypeOf")
            || t.contains("reflect.New")
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = format!("<reflection:Go:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_go_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Kotlin: @Inject, Koin, ProcessBuilder
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_kotlin_di(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("@Inject") || t.contains("by inject()") || t.contains("Koin")
            || t.contains("dagger") || t.contains("koin")
        {
            let fname = format!("<fn@{}:{}>", file, li + 1);
            let marker = format!("<DI:Kotlin:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &fname, file, li + 1);
            let tid = find_or_create_di_node(graph, &marker, file, li + 1);
            let eid = format!("di_kt_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

pub(crate) fn detect_kotlin_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("ProcessBuilder") || t.contains("Runtime.getRuntime().exec") {
            let m = "<cross-lang:subprocess:Kotlin>".to_string();
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_kt_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Rust: dynamic-code eval (proc macros)
// ═══════════════════════════════════════════════════════════════

pub(crate) fn detect_rust_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("proc_macro") || t.contains("include_str!")
            || t.contains("include_bytes!")
        {
            let m = format!("<eval:Rust:{}>", t.chars().take(30).collect::<String>());
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_rsev_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
pub(crate) fn detect_py_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("py").expect("python grammar")).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    // FFI loaders → <cross-lang:ffi>
    let ffi_loaders: HashSet<&str> = [
        "CDLL", "cdll", "WinDLL", "windll", "dlopen",
    ].iter().cloned().collect();

    // HTTP clients → <cross-lang:http>
    let http_methods: HashSet<&str> = [
        "get", "post", "put", "delete", "patch", "head", "options", "request",
    ].iter().cloned().collect();

    while let Some(node) = stack.pop() {
        if node.kind() == "call" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_name = func.utf8_text(source.as_bytes()).unwrap_or("");
                let line = node.start_position().row + 1;
                let enclosing = find_py_enclosing_func(&node, source, file);
                let mut marker = String::new();
                let mut is_cross = false;

                // subprocess.Popen / os.system / etc.
                if func_name.ends_with(".Popen") || func_name.ends_with(".run")
                    || func_name.ends_with(".call") || func_name.ends_with(".check_output")
                {
                    marker = format!("<cross-lang:subprocess:{}>", func_name);
                    is_cross = true;
                } else if func_name == "system" || func_name == "popen" || func_name == "exec_command" {
                    // os.system / os.popen / etc. — need attribute check
                    if func.kind() == "attribute" {
                        marker = format!("<cross-lang:subprocess:{}>", func_name);
                        is_cross = true;
                    }
                }
                // ctypes.CDLL / cffi.dlopen / requests.get / httpx.post
                else if func.kind() == "attribute" {
                    let last = func_name.rsplit('.').next().unwrap_or("");
                    if ffi_loaders.contains(last) {
                        marker = format!("<cross-lang:ffi:{}>", func_name);
                        is_cross = true;
                    } else {
                        // Check for HTTP client: requests.get, httpx.post, etc.
                        let parts: Vec<&str> = func_name.rsplitn(2, '.').collect();
                        if parts.len() == 2 {
                            let module = parts[1];
                            let method = parts[0];
                            let is_http_module = module == "requests" || module == "httpx"
                                || module.contains("urllib") || module == "aiohttp"
                                || module.contains("session");
                            let is_http_method = http_methods.contains(method);
                            if is_http_module && is_http_method {
                                marker = format!("<cross-lang:http:{}>", func_name);
                                is_cross = true;
                            }
                        }
                    }
                }

                if is_cross {
                    let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                    let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                    let edge_id = format!("di_xlang_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        graph.add_edge(Edge {
                            id: edge_id, source: src_id, target: tgt_id,
                            kind: EdgeKind::Calls, coupling_depth: 4, // L4: cross-lang boundary
                            cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                        });
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

// ── JS/TS: child_process.exec/spawn, fetch, axios ──

pub(crate) fn detect_js_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let ext = if is_ts { "ts" } else { "js" };
    let lang: tree_sitter::Language = GRAMMAR_LOADER.get(ext).expect("ts/js grammar");

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&lang).is_err() { return 0; }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_text = func.utf8_text(source.as_bytes()).unwrap_or("");
                let line = node.start_position().row + 1;
                let enclosing = find_js_enclosing_func(&node, source, file);
                let mut marker = String::new();

                // fetch() — global HTTP bridge (identifier, not member_expression)
                if func_text == "fetch" {
                    marker = "<cross-lang:http:fetch>".to_string();
                }
                // exec() / spawn() — may be destructured from child_process
                else if func_text == "exec" || func_text == "spawn"
                    || func_text == "execSync" || func_text == "fork"
                {
                    marker = format!("<cross-lang:subprocess:{}>", func_text);
                }
                // member_expression patterns: child_process.exec, axios.get, etc.
                else if func.kind() == "member_expression" {
                    if func_text.ends_with(".exec") || func_text.ends_with(".spawn")
                        || func_text.ends_with(".execSync") || func_text.ends_with(".fork")
                    {
                        marker = format!("<cross-lang:subprocess:{}>", func_text);
                    }
                    else if func_text.ends_with(".fetch") {
                        marker = format!("<cross-lang:http:{}>", func_text);
                    }
                    // axios.get / axios.post / got.get
                    else if func_text.ends_with(".get") || func_text.ends_with(".post")
                        || func_text.ends_with(".put") || func_text.ends_with(".delete")
                        || func_text.ends_with(".patch")
                    {
                        let obj = func_text.rsplit_once('.').map(|x| x.0).unwrap_or("");
                        if obj == "axios" || obj == "got" || obj == "superagent" {
                            marker = format!("<cross-lang:http:{}>", func_text);
                        }
                    }
                }

                if !marker.is_empty() {
                    let src_id = find_or_create_di_node(graph, &enclosing, file, line);
                    let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                    let edge_id = format!("di_xlang_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        graph.add_edge(Edge {
                            id: edge_id, source: src_id, target: tgt_id,
                            kind: EdgeKind::Calls, coupling_depth: 4,
                            cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                        });
                        added += 1;
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

// ── Java: Runtime.exec, ProcessBuilder, HttpClient ──

pub(crate) fn detect_java_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("java").expect("java grammar")).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "method_invocation" {
            let text = node.utf8_text(source.as_bytes()).unwrap_or("");
            let line = node.start_position().row + 1;
            let src_id = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, line), file, line);

            // Runtime.getRuntime().exec(cmd) / ProcessBuilder.start()
            if text.contains(".exec(") || text.contains("ProcessBuilder") {
                let marker = if text.contains("ProcessBuilder") {
                    "<cross-lang:subprocess:ProcessBuilder>".to_string()
                } else {
                    "<cross-lang:subprocess:Runtime.exec>".to_string()
                };
                let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                let edge_id = format!("di_xlang_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                if graph.get_edge(&edge_id).is_none() {
                    graph.add_edge(Edge {
                        id: edge_id, source: src_id, target: tgt_id,
                        kind: EdgeKind::Calls, coupling_depth: 4,
                        cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                    });
                    added += 1;
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

// ── Go: exec.Command, os/exec, net/http ──

pub(crate) fn detect_go_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;

    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&GRAMMAR_LOADER.get("go").expect("go grammar")).is_err() {
        return 0;
    }
    let tree = match parser.parse(source, None) {
        Some(t) => t, None => return 0,
    };

    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];

    while let Some(node) = stack.pop() {
        if node.kind() == "call_expression" {
            if let Some(func) = node.child_by_field_name("function") {
                let func_text = func.utf8_text(source.as_bytes()).unwrap_or("");
                let line = node.start_position().row + 1;
                let src_id = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, line), file, line);

                // exec.Command / exec.CommandContext → subprocess
                let is_exec = func_text == "exec.Command" || func_text == "exec.CommandContext"
                    || func_text.ends_with(".Command") || func_text.ends_with(".CommandContext");
                if is_exec {
                    let marker = format!("<cross-lang:subprocess:{}>", func_text);
                    let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                    let edge_id = format!("di_xlang_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                    if graph.get_edge(&edge_id).is_none() {
                        graph.add_edge(Edge {
                            id: edge_id, source: src_id, target: tgt_id,
                            kind: EdgeKind::Calls, coupling_depth: 4,
                            cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                        });
                        added += 1;
                    }
                }

                // http.Get / http.Post / http.NewRequest — HTTP bridge
                if func.kind() == "selector_expression"
                    && (func_text.ends_with(".Get") || func_text.ends_with(".Post")
                        || func_text.ends_with(".Do") || func_text.ends_with(".NewRequest"))
                    {
                        let marker = format!("<cross-lang:http:{}>", func_text);
                        let src_id = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, line), file, line);
                        let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                        let edge_id = format!("di_xlang_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                        if graph.get_edge(&edge_id).is_none() {
                            graph.add_edge(Edge {
                                id: edge_id, source: src_id, target: tgt_id,
                                kind: EdgeKind::Calls, coupling_depth: 4,
                                cross_file: true, temporal_delay_sec: None, lsp_resolved: false, is_synthesized: false, metadata: None,
                            });
                            added += 1;
                        }
                    }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}