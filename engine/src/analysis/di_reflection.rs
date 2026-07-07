// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Runtime-hidden dependency synthesis — fills graph edges that static
//! analysis misses due to runtime dispatch, dynamic code, and reflection.
//!
//! ========================================
//! Blind spots covered (README §已知局限)
//! ========================================
//! 1. DI / Reflection (Phase 2 — 10 languages):
//!    - Python: `getattr`/`setattr` · Java: `@Autowired`/`@Inject`
//!    - TypeScript: `@Injectable`/`@Inject` · C#: `Assembly.Load`/`Type.GetType`
//!    - Ruby: `send`/`method_missing` · PHP: `ReflectionClass`/`call_user_func`
//!    - Go: `reflect.ValueOf` · Kotlin: `@Inject`/`Koin`
//! 2. Dynamic import:
//!    - JS/TS, Python, C# (Assembly.Load), Ruby (autoload/require), PHP (require_once)
//! 3. Eval / dynamic code (marked as unresolvable):
//!    - JS/TS, Python, C# (CodeDom), Ruby (eval/instance_eval), PHP (eval/create_function), Rust (proc_macro)
//! 4. Cross-language call boundaries:
//!    - Subprocess: Py/JS/Java/Go/C#/Ruby/PHP/Kotlin
//!    - HTTP client: Py/JS/Go/C#/Ruby/PHP
//!    - FFI: Python (ctypes)
//!
//! Synthesized edges use coupling_depth=3 (L3 — hidden coupling) or
//! coupling_depth=4 (L4 — unresolvable). All edge IDs use the `di_`
//! prefix for tooling to filter/identify reflection edges.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::engine::GRAMMAR_LOADER;
use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

/// Parsed source held in the pipeline parse cache.
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// Run DI/reflection detection on the graph for all supported languages.
/// Uses the parse cache from Step 1 to avoid re-reading + re-parsing files.
/// Returns the number of synthesized edges added.
pub fn detect_di_reflection(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    // Filter pipeline-discovered files to JS/TS/Python/Java only
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts")
            || lower.ends_with(".tsx") || lower.ends_with(".java") || lower.ends_with(".cs")
            || lower.ends_with(".rb") || lower.ends_with(".php") || lower.ends_with(".go")
            || lower.ends_with(".kt")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') { file.clone() }
            else { project_root.join(file).to_string_lossy().replace('\\', "/") };

        if let Some((source, _tree_opt)) = parse_cache.get(&abs_key) {
            let source = source.clone();
            if lower.ends_with(".py") { added += detect_python_reflection(graph, file, &source); }
            else if lower.ends_with(".java") { added += detect_java_di(graph, file, &source); }
            else if lower.ends_with(".cs") { added += detect_cs_di(graph, file, &source); }
            else if lower.ends_with(".rb") { added += detect_ruby_di(graph, file, &source); }
            else if lower.ends_with(".php") { added += detect_php_di(graph, file, &source); }
            else if lower.ends_with(".go") { added += detect_go_di(graph, file, &source); }
            else if lower.ends_with(".kt") { added += detect_kotlin_di(graph, file, &source); }
            else { added += detect_ts_di(graph, file, &source); }
        } else {
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if lower.ends_with(".py") { added += detect_python_reflection(graph, file, &source); }
                else if lower.ends_with(".java") { added += detect_java_di(graph, file, &source); }
                else if lower.ends_with(".cs") { added += detect_cs_di(graph, file, &source); }
                else if lower.ends_with(".rb") { added += detect_ruby_di(graph, file, &source); }
                else if lower.ends_with(".php") { added += detect_php_di(graph, file, &source); }
                else if lower.ends_with(".go") { added += detect_go_di(graph, file, &source); }
                else if lower.ends_with(".kt") { added += detect_kotlin_di(graph, file, &source); }
                else { added += detect_ts_di(graph, file, &source); }
            }
        }
    }

    added
}

// ═══════════════════════════════════════════════════════════════
// Python: getattr / setattr reflection
// ═══════════════════════════════════════════════════════════════

fn detect_python_reflection(graph: &mut Graph, file: &str, source: &str) -> usize {
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
fn extract_py_reflection_args(
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

fn find_py_enclosing_func(node: &tree_sitter::Node, source: &str, default_file: &str) -> String {
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

fn detect_java_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
fn find_di_annotation(
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

fn extract_java_field_type(node: &tree_sitter::Node, source: &str) -> String {
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

fn extract_java_field_name(node: &tree_sitter::Node, source: &str) -> String {
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

fn extract_java_param_type(node: &tree_sitter::Node, source: &str) -> String {
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

fn detect_ts_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
fn extract_ts_constructor_deps_v2(
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

fn extract_ts_param_type_v2(node: &tree_sitter::Node, source: &str) -> String {
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
// Dynamic import detection — `import(variable)` / `require(expr)`
// ═══════════════════════════════════════════════════════════════

/// Detect dynamic imports — `import(variable)`, `require(expr)`, `__import__(name)`.
/// Creates `<dynamic-import>` marker nodes: these warn the Agent that the module
/// graph is incomplete at this call site.
pub fn detect_dynamic_imports(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".mjs")
            || lower.ends_with(".cs") || lower.ends_with(".rb") || lower.ends_with(".php")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source: String;
        let source_ref: &str;
        if let Some((cached_src, _)) = parse_cache.get(&abs_key) {
            source = cached_src.clone();
            source_ref = &source;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => { source = s; source_ref = &source; }
                Err(_) => continue,
            }
        }

        if lower.ends_with(".py") {
            added += detect_python_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += detect_cs_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += detect_ruby_dynamic_import(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += detect_php_dynamic_import(graph, file, source_ref);
        } else {
            added += detect_js_ts_dynamic_import(graph, file, source_ref);
        }
    }

    added
}

fn detect_python_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                            cross_file: false, temporal_delay_sec: None, lsp_resolved: false,
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

fn detect_js_ts_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                            cross_file: false, temporal_delay_sec: None, lsp_resolved: false,
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
fn is_first_arg_string_literal(call: &tree_sitter::Node, _source: &str) -> bool {
    if let Some(args) = call.child_by_field_name("arguments") {
        let mut ac = args.walk();
        for arg in args.children(&mut ac) {
            let kind = arg.kind();
            if kind == "(" || kind == ")" || kind == "," { continue; }
            return kind == "string" || kind == "template_string";
        }
    }
    false
}

fn find_js_enclosing_func(node: &tree_sitter::Node, source: &str, default_file: &str) -> String {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_declaration" | "function_expression"
            | "method_definition" | "arrow_function" => {
                if let Some(name_node) = p.child_by_field_name("name") {
                    return name_node.utf8_text(source.as_bytes()).unwrap_or(default_file).to_string();
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
// Eval / dynamic code detection
// ═══════════════════════════════════════════════════════════════

/// Detect `eval()` / `exec()` / `new Function()` — code that is fundamentally
/// unresolvable by static analysis. Creates `<eval>` / `<exec>` marker nodes.
pub fn detect_eval(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".mjs")
            || lower.ends_with(".cs") || lower.ends_with(".rb") || lower.ends_with(".php") || lower.ends_with(".rs")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source: String;
        let source_ref: &str;
        if let Some((cached_src, _)) = parse_cache.get(&abs_key) {
            source = cached_src.clone();
            source_ref = &source;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => { source = s; source_ref = &source; }
                Err(_) => continue,
            }
        }

        if lower.ends_with(".py") {
            added += detect_python_eval(graph, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += detect_cs_eval(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += detect_ruby_eval(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += detect_php_eval(graph, file, source_ref);
        } else if lower.ends_with(".rs") {
            added += detect_rust_eval(graph, file, source_ref);
        } else {
            added += detect_js_ts_eval(graph, file, source_ref);
        }
    }

    added
}

fn detect_python_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                            cross_file: false, temporal_delay_sec: None, lsp_resolved: false,
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

fn detect_js_ts_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                                cross_file: false, temporal_delay_sec: None, lsp_resolved: false,
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
                                cross_file: false, temporal_delay_sec: None, lsp_resolved: false,
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
// C# / .NET: reflection, eval, cross-lang, dynamic import
// ═══════════════════════════════════════════════════════════════

fn detect_cs_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_cs_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_cs_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_cs_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("Process.Start") {
            let m = "<cross-lang:subprocess:Process.Start>".to_string();
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_cs_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
        if t.contains("HttpClient") || t.contains("GetAsync") || t.contains("PostAsync") {
            let m = format!("<cross-lang:http:{}>", t.chars().take(40).collect::<String>());
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_cs_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Ruby: send, method_missing, eval, autoload, system
// ═══════════════════════════════════════════════════════════════

fn detect_ruby_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_ruby_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_ruby_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_ruby_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// PHP: ReflectionClass, eval, require_once(expr), exec
// ═══════════════════════════════════════════════════════════════

fn detect_php_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_php_dynamic_import(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_php_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("eval(") || t.contains("create_function") || t.contains("assert(") {
            let m = format!("<eval:PHP:{}>", t.chars().take(30).collect::<String>());
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_phpev_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_php_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Go: reflect
// ═══════════════════════════════════════════════════════════════

fn detect_go_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Kotlin: @Inject, Koin, ProcessBuilder
// ═══════════════════════════════════════════════════════════════

fn detect_kotlin_di(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 3, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

fn detect_kotlin_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut added = 0usize;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.contains("ProcessBuilder") || t.contains("Runtime.getRuntime().exec") {
            let m = "<cross-lang:subprocess:Kotlin>".to_string();
            let sid = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, li + 1), file, li + 1);
            let tid = find_or_create_di_node(graph, &m, file, li + 1);
            let eid = format!("di_xlang_kt_{}_{}", file.replace(['.', '/', '\\'], "_"), added);
            if graph.get_edge(&eid).is_none() {
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: true, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Rust: dynamic-code eval (proc macros)
// ═══════════════════════════════════════════════════════════════

fn detect_rust_eval(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                graph.add_edge(Edge { id: eid, source: sid, target: tid, kind: EdgeKind::Calls, coupling_depth: 4, cross_file: false, temporal_delay_sec: None, lsp_resolved: false });
                added += 1;
            }
        }
    }
    added
}

// ═══════════════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════════════

/// Find or create a graph node for the given name.
fn find_or_create_di_node(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    // Try exact match first
    for (id, node) in &graph.nodes {
        if node.name == name {
            return id.clone();
        }
    }
    // Try last-component match (for qualified names)
    if let Some(last_part) = name.rsplit('.').next() {
        if last_part != name {
            for (id, node) in &graph.nodes {
                if node.name == last_part {
                    return id.clone();
                }
            }
        }
    }
    // Create placeholder
    let node_id = format!("di_syn_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut node = Node::new(&node_id, name, NodeKind::Symbol);
    node.location = Some(format!("{}:{}", file, line));
    node.properties = serde_json::json!({
        "kind": "synthesized_target",
        "provenance": "di_reflection"
    });
    graph.add_node(node);
    node_id
}

// ═══════════════════════════════════════════════════════════════
// Cross-language call detection — subprocess / FFI / HTTP
// ═══════════════════════════════════════════════════════════════

/// Detect cross-language call boundaries: subprocess exec, FFI loading,
/// and HTTP client calls. These are runtime bridges that static analysis
/// fundamentally cannot trace past. Creates `<cross-lang:*>` marker nodes.
pub fn detect_cross_lang_calls(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut added = 0usize;

    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy();
        let lower = s.to_lowercase();
        if lower.ends_with(".py") || lower.ends_with(".js") || lower.ends_with(".ts")
            || lower.ends_with(".tsx") || lower.ends_with(".mjs") || lower.ends_with(".java")
            || lower.ends_with(".go") || lower.ends_with(".rs") || lower.ends_with(".rb")
            || lower.ends_with(".cs") || lower.ends_with(".kt") || lower.ends_with(".php")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };

        let source: String;
        let source_ref: &str;
        if let Some((cached_src, _)) = parse_cache.get(&abs_key) {
            source = cached_src.clone();
            source_ref = &source;
        } else {
            let full_path = project_root.join(file);
            match std::fs::read_to_string(&full_path) {
                Ok(s) => { source = s; source_ref = &source; }
                Err(_) => continue,
            }
        }

        if lower.ends_with(".py") {
            added += detect_py_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".js") || lower.ends_with(".ts") || lower.ends_with(".tsx") || lower.ends_with(".mjs") {
            added += detect_js_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".java") {
            added += detect_java_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".go") {
            added += detect_go_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".rb") {
            added += detect_ruby_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".cs") {
            added += detect_cs_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".kt") {
            added += detect_kotlin_cross_lang(graph, file, source_ref);
        } else if lower.ends_with(".php") {
            added += detect_php_cross_lang(graph, file, source_ref);
        }
    }

    added
}

// ── Python: subprocess, os.system, ctypes, requests ──

fn detect_py_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                            cross_file: true, temporal_delay_sec: None, lsp_resolved: false,
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

fn detect_js_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                        let obj = func_text.rsplitn(2, '.').nth(1).unwrap_or("");
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
                            cross_file: true, temporal_delay_sec: None, lsp_resolved: false,
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

fn detect_java_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                        cross_file: true, temporal_delay_sec: None, lsp_resolved: false,
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

fn detect_go_cross_lang(graph: &mut Graph, file: &str, source: &str) -> usize {
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
                            cross_file: true, temporal_delay_sec: None, lsp_resolved: false,
                        });
                        added += 1;
                    }
                }

                // http.Get / http.Post / http.NewRequest — HTTP bridge
                if func.kind() == "selector_expression" {
                    if func_text.ends_with(".Get") || func_text.ends_with(".Post")
                        || func_text.ends_with(".Do") || func_text.ends_with(".NewRequest")
                    {
                        let marker = format!("<cross-lang:http:{}>", func_text);
                        let src_id = find_or_create_di_node(graph, &format!("<fn@{}:{}>", file, line), file, line);
                        let tgt_id = find_or_create_di_node(graph, &marker, file, line);
                        let edge_id = format!("di_xlang_{}_{}_{}", file.replace(['.', '/', '\\'], "_"), added, line);
                        if graph.get_edge(&edge_id).is_none() {
                            graph.add_edge(Edge {
                                id: edge_id, source: src_id, target: tgt_id,
                                kind: EdgeKind::Calls, coupling_depth: 4,
                                cross_file: true, temporal_delay_sec: None, lsp_resolved: false,
                            });
                            added += 1;
                        }
                    }
                }
            }
        }

        let children: Vec<_> = node.children(&mut cursor).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    added
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Python tests ──

    #[test]
    fn test_detect_getattr_string_literal() {
        let mut g = Graph::new();
        let source = r#"
def connect():
    db = getattr(settings, 'DATABASE_URL')
"#;
        let added = detect_python_reflection(&mut g, "config.py", source);
        assert!(added >= 1, "Should detect getattr with string literal, got {}", added);
    }

    #[test]
    fn test_detect_setattr_string_literal() {
        let mut g = Graph::new();
        let source = r#"
def configure():
    setattr(obj, 'timeout', 30)
"#;
        let added = detect_python_reflection(&mut g, "setup.py", source);
        assert!(added >= 1, "Should detect setattr with string literal, got {}", added);
    }

    #[test]
    fn test_detect_getattr_variable_unresolvable() {
        let mut g = Graph::new();
        let source = r#"
def dynamic_access(obj, attr_name):
    return getattr(obj, attr_name)
"#;
        let added = detect_python_reflection(&mut g, "reflect.py", source);
        // Variable attribute → unresolvable marker edge
        assert!(added >= 1, "Should create unresolvable marker for variable attr, got {}", added);
    }

    #[test]
    fn test_no_reflection_returns_zero() {
        let mut g = Graph::new();
        let source = "def hello():\n    return 42\n";
        let added = detect_python_reflection(&mut g, "plain.py", source);
        assert_eq!(added, 0, "No reflection patterns → 0 edges");
    }

    // ── Java tests ──

    #[test]
    fn test_detect_autowired_field() {
        let mut g = Graph::new();
        let source = r#"
public class UserService {
    @Autowired
    private UserRepository userRepo;
}
"#;
        let added = detect_java_di(&mut g, "UserService.java", source);
        assert!(added >= 1, "Should detect @Autowired field, got {}", added);
    }

    #[test]
    fn test_detect_inject_field() {
        let mut g = Graph::new();
        let source = r#"
public class OrderService {
    @Inject
    private PaymentGateway payment;
}
"#;
        let added = detect_java_di(&mut g, "OrderService.java", source);
        assert!(added >= 1, "Should detect @Inject field, got {}", added);
    }

    #[test]
    fn test_no_java_di_returns_zero() {
        let mut g = Graph::new();
        let source = "public class Plain { private int x; }\n";
        let added = detect_java_di(&mut g, "Plain.java", source);
        assert_eq!(added, 0, "No DI annotations → 0 edges");
    }

    // ── TypeScript tests ──

    #[test]
    fn test_detect_injectable_class() {
        let mut g = Graph::new();
        let source = r#"
@Injectable()
export class UserService {
    constructor(private repo: UserRepository) {}
}
"#;
        let added = detect_ts_di(&mut g, "user.service.ts", source);
        // Should detect: Injectable marker + constructor param
        assert!(added >= 1, "Should detect @Injectable + constructor DI, got {}", added);
    }

    #[test]
    fn test_detect_inject_decorator_param() {
        let mut g = Graph::new();
        let source = r#"
@Injectable()
export class Worker {
    constructor(@Inject('CONFIG') private config: AppConfig) {}
}
"#;
        let added = detect_ts_di(&mut g, "worker.ts", source);
        assert!(added >= 1, "Should detect @Inject decorated param, got {}", added);
    }

    #[test]
    fn test_no_ts_di_returns_zero() {
        let mut g = Graph::new();
        let source = "class Plain { doStuff() {} }\n";
        let added = detect_ts_di(&mut g, "plain.ts", source);
        assert_eq!(added, 0, "No decorators → 0 edges");
    }

    // ── Integration test ──

    #[test]
    fn test_full_di_detection_multi_language() {
        let mut g = Graph::new();
        let py_src = "def init():\n    db = getattr(config, 'DB_HOST')\n";
        let java_src = "public class Svc { @Autowired private Repo r; }\n";
        let ts_src = "@Injectable() export class Svc { constructor(private r: Repo) {} }\n";

        let a1 = detect_python_reflection(&mut g, "app.py", py_src);
        let a2 = detect_java_di(&mut g, "Svc.java", java_src);
        let a3 = detect_ts_di(&mut g, "svc.ts", ts_src);

        assert!(a1 >= 1);
        assert!(a2 >= 1);
        assert!(a3 >= 1);
        assert!(g.node_count() >= 5, "Should have multiple synthesized nodes, got {}", g.node_count());
    }

    // ── Dynamic import tests ──

    #[test]
    fn test_detect_js_import_variable() {
        let mut g = Graph::new();
        let source = r#"
async function loadModule(name) {
    const mod = await import(name);
}
"#;
        let added = detect_js_ts_dynamic_import(&mut g, "loader.js", source);
        assert!(added >= 1, "Should detect import(variable), got {}", added);
    }

    #[test]
    fn test_detect_require_variable() {
        let mut g = Graph::new();
        let source = r#"
function loadPlugin(path) {
    const plugin = require(path);
}
"#;
        let added = detect_js_ts_dynamic_import(&mut g, "plugins.js", source);
        assert!(added >= 1, "Should detect require(variable), got {}", added);
    }

    #[test]
    fn test_require_string_literal_not_flagged() {
        let mut g = Graph::new();
        let source = r#"const fs = require('fs');"#;
        let added = detect_js_ts_dynamic_import(&mut g, "app.js", source);
        assert_eq!(added, 0, "require('string') should NOT be flagged — static import");
    }

    #[test]
    fn test_detect_py_import_module() {
        let mut g = Graph::new();
        let source = r#"
def load_plugin(name):
    mod = importlib.import_module(name)
"#;
        let added = detect_python_dynamic_import(&mut g, "loader.py", source);
        assert!(added >= 1, "Should detect importlib.import_module, got {}", added);
    }

    #[test]
    fn test_detect_py_dunder_import() {
        let mut g = Graph::new();
        let source = r#"
def dynamic_load(name):
    return __import__(name)
"#;
        let added = detect_python_dynamic_import(&mut g, "dyn.py", source);
        assert!(added >= 1, "Should detect __import__, got {}", added);
    }

    // ── Eval tests ──

    #[test]
    fn test_detect_js_eval() {
        let mut g = Graph::new();
        let source = r#"
function runCode(code) {
    eval(code);
}
"#;
        let added = detect_js_ts_eval(&mut g, "runner.js", source);
        assert!(added >= 1, "Should detect eval(), got {}", added);
    }

    #[test]
    fn test_detect_js_new_function() {
        let mut g = Graph::new();
        let source = r#"
function makeFn(body) {
    return new Function(body);
}
"#;
        let added = detect_js_ts_eval(&mut g, "factory.js", source);
        assert!(added >= 1, "Should detect new Function(), got {}", added);
    }

    #[test]
    fn test_detect_py_eval() {
        let mut g = Graph::new();
        let source = r#"
def run(code):
    eval(code)
"#;
        let added = detect_python_eval(&mut g, "run.py", source);
        assert!(added >= 1, "Should detect eval(), got {}", added);
    }

    #[test]
    fn test_detect_py_exec() {
        let mut g = Graph::new();
        let source = r#"
def execute(code):
    exec(code)
"#;
        let added = detect_python_eval(&mut g, "exec.py", source);
        assert!(added >= 1, "Should detect exec(), got {}", added);
    }

    #[test]
    fn test_no_eval_returns_zero() {
        let mut g = Graph::new();
        let source = "function add(a, b) { return a + b; }\n";
        let added = detect_js_ts_eval(&mut g, "math.js", source);
        assert_eq!(added, 0, "No eval → 0 edges");
    }

    // ── Cross-language tests ──

    #[test]
    fn test_detect_py_subprocess_popen() {
        let mut g = Graph::new();
        let source = r#"
def run_shell():
    import subprocess
    proc = subprocess.Popen(['ls', '-la'])
"#;
        let added = detect_py_cross_lang(&mut g, "runner.py", source);
        assert!(added >= 1, "Should detect subprocess.Popen, got {}", added);
    }

    #[test]
    fn test_detect_py_requests_get() {
        let mut g = Graph::new();
        let source = r#"
def fetch_data():
    import requests
    resp = requests.get('https://api.example.com/data')
"#;
        let added = detect_py_cross_lang(&mut g, "api.py", source);
        assert!(added >= 1, "Should detect requests.get, got {}", added);
    }

    #[test]
    fn test_detect_py_ctypes_cdll() {
        let mut g = Graph::new();
        let source = r#"
def load_native():
    import ctypes
    lib = ctypes.CDLL('./mylib.so')
"#;
        let added = detect_py_cross_lang(&mut g, "ffi.py", source);
        assert!(added >= 1, "Should detect ctypes.CDLL, got {}", added);
    }

    #[test]
    fn test_detect_js_child_process_exec() {
        let mut g = Graph::new();
        let source = r#"
function run(cmd) {
    const { exec } = require('child_process');
    exec(cmd);
}
"#;
        let added = detect_js_cross_lang(&mut g, "process.js", source);
        assert!(added >= 1, "Should detect child_process.exec, got {}", added);
    }

    #[test]
    fn test_detect_js_fetch() {
        let mut g = Graph::new();
        let source = r#"
async function getData() {
    const resp = await fetch('https://api.example.com');
    return resp.json();
}
"#;
        let added = detect_js_cross_lang(&mut g, "fetch.js", source);
        assert!(added >= 1, "Should detect fetch(), got {}", added);
    }

    #[test]
    fn test_detect_java_runtime_exec() {
        let mut g = Graph::new();
        let source = r#"
public class Runner {
    public void run(String cmd) {
        Runtime.getRuntime().exec(cmd);
    }
}
"#;
        let added = detect_java_cross_lang(&mut g, "Runner.java", source);
        assert!(added >= 1, "Should detect Runtime.exec, got {}", added);
    }

    #[test]
    fn test_detect_go_exec_command() {
        let mut g = Graph::new();
        let source = r#"
package main
import "os/exec"
func main() {
    cmd := exec.Command("ls", "-la")
    cmd.Run()
}
"#;
        let added = detect_go_cross_lang(&mut g, "main.go", source);
        assert!(added >= 1, "Should detect exec.Command, got {}", added);
    }

    #[test]
    fn test_no_cross_lang_returns_zero() {
        let mut g = Graph::new();
        let source = "def add(a, b):\n    return a + b\n";
        let added = detect_py_cross_lang(&mut g, "math.py", source);
        assert_eq!(added, 0, "No cross-lang calls → 0 edges");
    }
}
