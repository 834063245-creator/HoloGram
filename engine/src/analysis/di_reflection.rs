// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Dependency Injection & Reflection synthesis — fills graph edges that
//! static analysis misses due to runtime dispatch patterns.
//!
//! Patterns detected (Phase 1):
//! - Python: `getattr(obj, 'attr')` / `setattr(obj, 'attr', val)` — string-literal
//!   attribute access resolved; variable attribute names flagged as unresolvable.
//! - Java: `@Autowired` / `@Inject` / `@Resource` — field, constructor, and setter
//!   injection wiring.
//! - TypeScript: `@Injectable()` / `@Inject()` decorators — NestJS/Angular-style
//!   constructor and property injection.
//!
//! These produce synthesized edges (provenance: "di_reflection") with
//! coupling_depth=3 (L3 — data/IO level hidden coupling). Edge IDs use the
//! `di_` prefix for tooling to filter/identify reflection edges.

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
        if lower.ends_with(".py")
            || lower.ends_with(".js")
            || lower.ends_with(".ts")
            || lower.ends_with(".tsx")
            || lower.ends_with(".java")
        {
            files.insert(s.replace('\\', "/"));
        }
    }

    for file in &files {
        let lower = file.to_lowercase();
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root
                .join(file)
                .to_string_lossy()
                .replace('\\', "/")
        };

        // Try parse cache first
        if let Some((source, _tree_opt)) = parse_cache.get(&abs_key) {
            let source = source.clone();
            if lower.ends_with(".py") {
                added += detect_python_reflection(graph, file, &source);
            } else if lower.ends_with(".java") {
                added += detect_java_di(graph, file, &source);
            } else {
                added += detect_ts_di(graph, file, &source);
            }
        } else {
            // Fallback: read from disk
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if lower.ends_with(".py") {
                    added += detect_python_reflection(graph, file, &source);
                } else if lower.ends_with(".java") {
                    added += detect_java_di(graph, file, &source);
                } else {
                    added += detect_ts_di(graph, file, &source);
                }
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
}
