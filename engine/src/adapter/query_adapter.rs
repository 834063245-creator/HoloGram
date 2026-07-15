// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Query-based structure adapter — replaces hand-written tree walkers.
//! Uses tree-sitter .scm query files to find symbols and create Node/Edge.
//! ponytail: one adapter per language family via per-language .scm files.
//! Adding a new language = one .scm file + one new_xx() constructor.
//! No hand-written match arms needed.

use crate::adapter::traits::LanguageAdapter;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{Edge, EdgeKind, Node, NodeKind};
use crate::path_utils::normalize_path;
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Query, QueryCursor};

thread_local! {
    static TL_PARSER: RefCell<Option<(Parser, Language, String)>> = RefCell::new(None);
}

// ── Scope boundary (Phase 1) ──

struct Scope {
    name: String,
    start: usize,
    end: usize,
}

fn find_scope<'a>(pos: usize, scopes: &'a [Scope]) -> Option<&'a str> {
    scopes
        .iter()
        .rev() // last-declared scope wins (innermost)
        .find(|s| s.start <= pos && pos < s.end)
        .map(|s| s.name.as_str())
}

// ── Import path resolution ──

fn resolve_import_path(import_path: &str, current_file: &str) -> String {
    let trimmed = import_path.trim_matches(|c| c == '\'' || c == '"' || c == '`');
    if trimmed.starts_with("./") || trimmed.starts_with("../") {
        let current_dir = Path::new(current_file).parent().unwrap_or(Path::new("."));
        let resolved = current_dir.join(trimmed);
        // ponytail: Path::join does NOT normalize "..". Resolve segments manually.
        let s = normalize_path(&resolved.to_string_lossy());
        // Split by '/', resolve "." and ".." segments
        let mut parts: Vec<&str> = Vec::new();
        for seg in s.split('/') {
            match seg {
                "." | "" => {}
                ".." => { parts.pop(); }
                _ => parts.push(seg),
            }
        }
        parts.join(".")
    } else {
        trimmed.to_string()
    }
}

// ── Inheritance name extraction ──

// ── Adapter ──

pub struct QueryStructureAdapter {
    extensions: Vec<String>,
    /// Query source: Some for single-query languages (Rust), None for JS/TS (picked at runtime).
    query_src: Option<&'static str>,
    /// TS query (for .ts/.tsx/.mts/.cts)
    ts_query_src: &'static str,
    /// JS query (for .js/.jsx/.mjs/.cjs)
    js_query_src: &'static str,
    func_kinds: &'static [&'static str],
    class_kinds: &'static [&'static str],
}

impl QueryStructureAdapter {
    pub fn new_js_ts() -> Self {
        Self {
            extensions: vec![
                "ts".into(), "tsx".into(), "mts".into(), "cts".into(),
                "js".into(), "jsx".into(), "mjs".into(), "cjs".into(),
            ],
            query_src: None, // picked at runtime based on extension
            ts_query_src: include_str!("../../queries/ts_structure.scm"),
            js_query_src: include_str!("../../queries/js_structure.scm"),
            func_kinds: &[
                "function_declaration", "generator_function_declaration",
                "function_expression", "method_definition", "arrow_function",
            ],
            class_kinds: &["class_declaration"],
        }
    }

    pub fn new_rust() -> Self {
        Self {
            extensions: vec!["rs".into()],
            query_src: Some(include_str!("../../queries/rust_structure.scm")),
            ts_query_src: "",
            js_query_src: "",
            func_kinds: &["function_item", "closure_expression"],
            class_kinds: &["impl_item", "struct_item", "enum_item", "trait_item"],
        }
    }

    /// Generic constructor for single-query languages.
    /// ponytail: one line per language in registry.rs — no per-language adapter file needed.
    pub fn new_generic(
        extensions: Vec<String>,
        query_src: &'static str,
        func_kinds: &'static [&'static str],
        class_kinds: &'static [&'static str],
    ) -> Self {
        Self {
            extensions,
            query_src: Some(query_src),
            ts_query_src: "",
            js_query_src: "",
            func_kinds,
            class_kinds,
        }
    }

    fn resolve_query_src(&self, ext: &str) -> &str {
        self.query_src.unwrap_or_else(|| {
            // ponytail: TSX uses a separate grammar (LANGUAGE_TSX) with JSX support.
            // The TSX query file includes JSX patterns that won't compile against
            // the plain TypeScript grammar.
            if ext == "tsx" {
                include_str!("../../queries/tsx_structure.scm")
            } else if matches!(ext, "ts" | "mts" | "cts") {
                self.ts_query_src
            } else {
                self.js_query_src
            }
        })
    }

    fn lang_for_ext(ext: &str) -> Option<Language> {
        GRAMMAR_LOADER.get(ext)
    }
}

impl LanguageAdapter for QueryStructureAdapter {
    fn extensions(&self) -> Vec<String> {
        self.extensions.clone()
    }

    fn analyze(
        &self,
        file_path: &str,
        source: &str,
    ) -> (Vec<Node>, Vec<Edge>, Option<tree_sitter::Tree>) {
        let ext = file_path.rsplit('.').next().unwrap_or("");
        let lang = match Self::lang_for_ext(ext) {
            Some(l) => l,
            None => return (vec![], vec![], None),
        };
        // ponytail: Language is Clone. Keep a copy for the query after
        // the original is moved into TL_PARSER.
        let lang_for_query = lang.clone();

        TL_PARSER.with(|cell| {
            let mut borrow = cell.borrow_mut();
            let reuse = borrow
                .as_ref()
                .map_or(false, |(_, _, cached_ext)| cached_ext == ext);
            if !reuse {
                let mut p = Parser::new();
                if p.set_language(&lang).is_err() {
                    return (vec![], vec![], None);
                }
                *borrow = Some((p, lang, ext.to_string()));
            }
            let (ref mut parser, _, _) = borrow.as_mut().unwrap();

            let tree = match parser.parse(source, None) {
                Some(t) => t,
                None => return (vec![], vec![], None),
            };

            let query_src = self.resolve_query_src(ext);
            let (nodes, edges) = process_query(
                &tree, source, file_path, query_src,
                &lang_for_query, self.func_kinds, self.class_kinds,
            );
            (nodes, edges, Some(tree))
        })
    }
}

// ── Query processor ──

fn process_query(
    tree: &tree_sitter::Tree,
    source: &str,
    file_path: &str,
    query_src: &str,
    lang: &Language,
    func_kinds: &[&str],
    class_kinds: &[&str],
) -> (Vec<Node>, Vec<Edge>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut counter = 0u32;
    // Per-scope dedup for USAGE edges — skip repeat references to same name
    let mut usage_seen: HashSet<String> = HashSet::new();

    let file_id = normalize_path(file_path);
    // ponytail: include extension in module_id so CrossFileResolver can match
    // import targets to module nodes. Match the format used by the old adapters.
    let module_id = file_id.replace('/', ".").replace('\\', ".");

    // Module node
    let mut file_node = Node::new(&module_id, &file_id, NodeKind::File);
    file_node.location = Some(file_path.to_string());
    nodes.push(file_node);

    let root = tree.root_node();
    let source_bytes = source.as_bytes();

    // ── Phase 1: collect scope boundaries ──
    let mut scopes: Vec<Scope> = Vec::new();
    {
        let mut stack: Vec<tree_sitter::Node> = vec![root];
        while let Some(node) = stack.pop() {
            let kind = node.kind();
            let is_func = func_kinds.contains(&kind);
            let is_class = class_kinds.contains(&kind);
            if is_func || is_class {
                let name = node
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("<anon@{}>", node.start_position().row + 1));
                scopes.push(Scope {
                    name: format!("{}.{}", module_id, name),
                    start: node.start_byte(),
                    end: node.end_byte(),
                });
            }
            for child in node.children(&mut node.walk()) {
                stack.push(child);
            }
        }
    }
    scopes.sort_by_key(|s| s.start);

    // ── Phase 2: run structure query ──
    let query = match Query::new(lang, query_src) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("[query_adapter] query compile failed: {e}");
            return (nodes, edges);
        }
    };

    let mut cursor = QueryCursor::new();
    let mut created_ids: HashSet<String> = HashSet::new();
    let mut matches = cursor.matches(&query, root, source_bytes);

    while let Some(qmatch) = matches.next() {
        // Find the primary capture (@fn, @class, @interface, @call, @import, @inherit)
        let mut primary_cap: Option<(&str, tree_sitter::Node)> = None;
        let mut trait_name: Option<String> = None;
        let mut type_name: Option<String> = None;
        for capture in qmatch.captures {
            let cn: &str = &query.capture_names()[capture.index as usize];
            match cn {
                "fn" | "class" | "interface" | "call" | "import" | "inherit"
                | "var" | "write" | "throws" | "usage" => {
                    primary_cap = Some((cn, capture.node));
                }
                "trait_name" => {
                    trait_name = capture.node.utf8_text(source_bytes).ok().map(|s| s.to_string());
                }
                "type_name" => {
                    type_name = capture.node.utf8_text(source_bytes).ok().map(|s| s.to_string());
                }
                _ => {}
            }
        }
        let (cap_name, node) = match primary_cap {
            Some(c) => c,
            None => continue,
        };

        match cap_name {
            "fn" => {
                // function_declaration, generator_function_declaration, function_expression,
                // method_definition, arrow_function, or variable_declarator
                let (name, scope_end) = resolve_fn(&node, source_bytes, func_kinds);
                let name = match name {
                    Some(n) => n,
                    None => continue, // anonymous callback — skip
                };
                let nid = format!("{}.{}", module_id, name);
                if created_ids.contains(&nid) {
                    continue;
                }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    &module_id,
                    &nid,
                    EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Function);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
                // Scope boundary — Phase 1 already found scope-defining nodes,
                // but variable_declarator-wrapped fns need explicit scope for call attribution
                let end = scope_end.unwrap_or(node.end_byte());
                scopes.push(Scope { name: nid.clone(), start: node.start_byte(), end });
                scopes.sort_by_key(|s| s.start);
            }

            "class" => {
                let name = match node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                    .map(|s| s.to_string())
                {
                    Some(n) => n,
                    None => continue,
                };
                let nid = format!("{}.{}", module_id, name);
                if created_ids.contains(&nid) {
                    continue;
                }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    &module_id,
                    &nid,
                    EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Class);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
                // Scope
                scopes.push(Scope { name: nid.clone(), start: node.start_byte(), end: node.end_byte() });
                scopes.sort_by_key(|s| s.start);
                // Inheritance: walk children for extends_clause / implements_clause
                emit_class_inherits(&node, source_bytes, &nid, &module_id, &file_id, &mut counter, &mut edges);
            }

            "interface" => {
                let name = match node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                    .map(|s| s.to_string())
                {
                    Some(n) => n,
                    None => continue,
                };
                let nid = format!("{}.{}", module_id, name);
                if created_ids.contains(&nid) {
                    continue;
                }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    &module_id,
                    &nid,
                    EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Interface);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
            }

            "call" => {
                let name = match extract_call_target(&node, source_bytes) {
                    Some(n) => n,
                    None => continue,
                };
                // require() → import edge
                if name == "require" {
                    if let Some(target) = extract_first_string_arg(&node, source_bytes) {
                        let target = target.trim_matches(|c| c == '\'' || c == '"' || c == '`');
                        if !target.is_empty() {
                            counter += 1;
                            let mut e = Edge::new(
                                format!("imp_{}_{}", file_id, counter),
                                &module_id, target, EdgeKind::Imports,
                            );
                            e.cross_file = true;
                            edges.push(e);
                        }
                    }
                    continue;
                }
                // dynamic import() → import edge
                if name == "import" {
                    if let Some(target) = extract_first_string_arg(&node, source_bytes) {
                        let target = target.trim_matches(|c| c == '\'' || c == '"' || c == '`');
                        if !target.is_empty() {
                            let resolved = resolve_import_path(target, file_path);
                            counter += 1;
                            let mut e = Edge::new(
                                format!("imp_{}_{}", file_id, counter),
                                &module_id, &resolved, EdgeKind::Imports,
                            );
                            e.cross_file = true;
                            edges.push(e);
                        }
                    }
                    continue;
                }
                // Skip builtins
                if is_skip_name(&name) {
                    continue;
                }
                let call_pos = node.start_byte();
                let scope_id = find_scope(call_pos, &scopes).unwrap_or(&module_id);
                counter += 1;
                let mut e = Edge::new(
                    format!("call_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Calls,
                );
                e.cross_file = true;
                edges.push(e);
            }

            "import" => {
                // ponytail: handler for @import captures.
                // JS/TS: node has "source" field ("import x from 'y'")
                // Python import_from_statement: "module_name" field ("from X import Y")
                // Python import_statement: children contain dotted_name ("import X")
                // Rust: use_declaration text (e.g. "use std::collections::HashMap")
                let raw_target = match node.child_by_field_name("source")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                {
                    Some(s) => s.to_string(),
                    None => {
                        let kind = node.kind();
                        if kind == "export_statement" {
                            continue; // named export, not a re-export — skip
                        }
                        // Python: from X import Y
                        if kind == "import_from_statement" {
                            match node.child_by_field_name("module_name")
                                .and_then(|n| n.utf8_text(source_bytes).ok())
                            {
                                Some(name) => name.to_string(),
                                None => continue,
                            }
                        } else if kind == "import_statement" {
                            // Python: import X → one edge per dotted_name child
                            let mut cursor = node.walk();
                            for child in node.children(&mut cursor) {
                                if child.kind() == "dotted_name" {
                                    if let Ok(name) = child.utf8_text(source_bytes) {
                                        counter += 1;
                                        let mut e = Edge::new(
                                            format!("imp_{}_{}", file_id, counter),
                                            &module_id, name, EdgeKind::Imports,
                                        );
                                        e.cross_file = true;
                                        edges.push(e);
                                    }
                                }
                            }
                            continue; // already emitted edges
                        } else {
                            // Rust use_declaration or other import-like node: use full text
                            node.utf8_text(source_bytes).ok()
                                .map(|s| s.to_string())
                                .unwrap_or_default()
                        }
                    }
                };
                if raw_target.is_empty() {
                    continue;
                }
                let target = resolve_import_path(&raw_target, file_path);
                counter += 1;
                let mut e = Edge::new(
                    format!("imp_{}_{}", file_id, counter),
                    &module_id, &target, EdgeKind::Imports,
                );
                e.cross_file = true;
                edges.push(e);
            }

            "inherit" => {
                // Rust: impl Trait for Type — names come from capture loop
                if let (Some(tn), Some(tyn)) = (trait_name.as_ref(), type_name.as_ref()) {
                    let type_nid = format!("{}.{}", module_id, tyn);
                    let trait_nid = format!("{}.{}", module_id, tn);
                    counter += 1;
                    edges.push(Edge::new(
                        format!("inh_{}_{}", file_id, counter),
                        &type_nid, &trait_nid, EdgeKind::Inherits,
                    ));
                }
            }

            "var" => {
                // Module-level variable/constant → Variable node
                let name = match node
                    .child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source_bytes).ok())
                {
                    Some(n) => n.to_string(),
                    None => {
                        // No name field — try left-hand side of assignment
                        let left = node.child_by_field_name("left")
                            .and_then(|l| l.utf8_text(source_bytes).ok())
                            .map(|s| s.to_string());
                        match left {
                            Some(s) => s,
                            None => continue,
                        }
                    }
                };
                if name.is_empty() { continue; }
                let nid = format!("{}.{}", module_id, name);
                if created_ids.contains(&nid) { continue; }
                created_ids.insert(nid.clone());
                counter += 1;
                edges.push(Edge::new(
                    format!("def_{}_{}", file_id, counter),
                    &module_id, &nid, EdgeKind::Defines,
                ));
                let mut n = Node::new(&nid, &name, NodeKind::Variable);
                n.location = Some(format!("{}:{}", file_path, node.start_position().row + 1));
                nodes.push(n);
            }

            "write" => {
                // Assignment → WRITES edge from enclosing scope to target
                let left = node.child_by_field_name("left");
                let target = match left {
                    Some(l) => l.utf8_text(source_bytes).ok().map(|s| s.to_string()),
                    None => node
                        .child_by_field_name("name")
                        .and_then(|n| n.utf8_text(source_bytes).ok())
                        .map(|s| s.to_string()),
                };
                let name = match target {
                    Some(n) => n,
                    None => continue,
                };
                if name.is_empty() { continue; }
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                counter += 1;
                edges.push(Edge::new(
                    format!("write_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Writes,
                ));
            }

            "throws" => {
                // raise/throw → THROWS edge from enclosing scope to exception type
                let exc_name = extract_throw_target(&node, source_bytes);
                let name = match exc_name {
                    Some(n) => n,
                    None => continue,
                };
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                counter += 1;
                edges.push(Edge::new(
                    format!("throw_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Throws,
                ));
            }

            "usage" => {
                // identifier/attribute reference → USAGE edge from enclosing scope
                let name = node.utf8_text(source_bytes).ok().map(|s| s.to_string());
                let name = match name {
                    Some(n) => n,
                    None => continue,
                };
                let lang_ext = file_path.rsplit('.').next().unwrap_or("");
                // Skip single-char, builtins, definition sites, parameter declarations
                if name.len() <= 1 || is_skip_name(&name) || is_builtin_for_ext(&name, lang_ext)
                    || is_definition_site(&node, source_bytes) || is_param_decl(&node, source_bytes)
                {
                    continue;
                }
                let scope_id = find_scope(node.start_byte(), &scopes).unwrap_or(&module_id);
                let dedup_key = format!("{}:{}", scope_id, name);
                if !usage_seen.insert(dedup_key) { continue; }
                counter += 1;
                edges.push(Edge::new(
                    format!("use_{}_{}", file_id, counter),
                    scope_id, &name, EdgeKind::Usage,
                ));
            }

            _ => {}
        }
    }

    (nodes, edges)
}

// ── Name extraction helpers ──

/// Resolve a function-like node: returns (name, scope_end_byte).
/// For variable_declarators, checks if the value is a function.
fn resolve_fn(
    node: &tree_sitter::Node,
    source: &[u8],
    func_kinds: &[&str],
) -> (Option<String>, Option<usize>) {
    let kind = node.kind();
    if func_kinds.contains(&kind) {
        // Direct function node: function_declaration, arrow_function, etc.
        let name = node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string());
        if name.is_some() {
            return (name, Some(node.end_byte()));
        }
        // Anonymous arrow/function — skip (callback, not a named symbol)
        return (None, None);
    }
    if kind == "variable_declarator" {
        let name = node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string());
        let value = node.child_by_field_name("value");
        let is_fn = value.map_or(false, |v| {
            let vk = v.kind();
            func_kinds.contains(&vk) || vk == "function_expression" || vk == "generator_function_expression"
        });
        if is_fn {
            let end = value.map(|v| v.end_byte());
            return (name, end);
        }
        return (None, None);
    }
    (None, None)
}

/// Extract the call target name from a call/new/JSX node.
/// Extract the function/method name from a function field child node.
/// Handles member_expression (a.b.c → "c"), field_expression (v.len → "len"),
/// attribute (obj.method → "method"), and plain identifiers.
fn extract_func_field_name(func: tree_sitter::Node, source: &[u8]) -> Option<String> {
    match func.kind() {
        "member_expression" => func
            .child_by_field_name("property")
            .and_then(|p| p.utf8_text(source).ok())
            .map(|s| s.to_string()),
        "field_expression" => func
            .child_by_field_name("field")
            .and_then(|f| f.utf8_text(source).ok())
            .map(|s| s.to_string()),
        "attribute" => {
            // Python: obj.method() → extract "method" from attribute.object.method
            let attr = func
                .child_by_field_name("attribute")
                .and_then(|a| a.utf8_text(source).ok())
                .map(|s| s.to_string());
            let obj = func
                .child_by_field_name("object")
                .and_then(|o| o.utf8_text(source).ok());
            match (obj, attr) {
                (Some(o), Some(a)) if !o.is_empty() => Some(format!("{}.{}", o, a)),
                (_, Some(a)) => Some(a),
                _ => func.utf8_text(source).ok().map(|s| s.to_string()),
            }
        }
        "selector_expression" => {
            // Dart: a.b.c() → walk chain to leaf
            let mut cur = func;
            loop {
                let field = cur.child_by_field_name("field");
                let obj = cur.child_by_field_name("object");
                if let (Some(f), Some(o)) = (field, obj) {
                    if o.kind() == "selector_expression" {
                        cur = o;
                        continue;
                    }
                    return f.utf8_text(source).ok().map(|s| s.to_string());
                }
                return cur.utf8_text(source).ok().map(|s| s.to_string());
            }
        }
        "identifier" | "simple_identifier" => func.utf8_text(source).ok().map(|s| s.to_string()),
        "import" => Some("import".to_string()),
        "dot" => {
            // Elixir: Mod.func() → extract rightmost
            func.child_by_field_name("right")
                .and_then(|r| r.utf8_text(source).ok())
                .map(|s| s.to_string())
                .or_else(|| func.utf8_text(source).ok().map(|s| s.to_string()))
        }
        _ => func.utf8_text(source).ok().map(|s| s.to_string()),
    }
}

fn extract_call_target(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    // ── Nodes with a "function" field ──
    const FUNC_FIELD_NODES: &[&str] = &[
        "call_expression", "call", "function_call",
        "invocation_expression", "method_invocation",
        "selector", "command_call", "builtin_function",
        "constructor_expression", "generic_function",
        "navigation_expression", "with_statement",
    ];
    let nk = node.kind();
    if FUNC_FIELD_NODES.iter().any(|&s| s == nk) {
        // ponytail: Ruby "call" nodes have "method" field, not "function".
        // Don't early-return None — fall through to the Ruby handler below.
        if let Some(result) = node
            .child_by_field_name("function")
            .and_then(|f| extract_func_field_name(f, source))
        {
            return Some(result);
        }
        // Fall through for Ruby "call" (no "function" field)
    }

    // ── Nodes with a "name" or "constructor" field ──
    if nk == "object_creation_expression" || nk == "new_expression" {
        let ctor = node.child_by_field_name("constructor")
            .or_else(|| node.child_by_field_name("name"))?;
        if ctor.kind() == "member_expression" {
            return ctor
                .child_by_field_name("property")
                .and_then(|p| p.utf8_text(source).ok())
                .map(|s| s.to_string());
        }
        return ctor.utf8_text(source).ok().map(|s| s.to_string());
    }

    // ── Ruby: "method" + optional "receiver" fields ──
    if nk == "call" {
        if let Some(method) = node.child_by_field_name("method") {
            let m = method.utf8_text(source).ok()?.to_string();
            if let Some(recv) = node.child_by_field_name("receiver") {
                if let Ok(r) = recv.utf8_text(source) {
                    if !r.is_empty() {
                        return Some(format!("{}.{}", r, m));
                    }
                }
            }
            return Some(m);
        }
    }

    // ── Rust macro_invocation ──
    if nk == "macro_invocation" {
        return node
            .child_by_field_name("macro")
            .and_then(|m| m.utf8_text(source).ok())
            .map(|s| s.to_string());
    }

    // ── JSX ──
    if matches!(nk, "jsx_self_closing_element" | "jsx_opening_element" | "jsx_opening_tag") {
        return node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source).ok())
            .map(|s| s.to_string());
    }

    // ── Bash: command — first named child is the command name ──
    if nk == "command" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.is_named() {
                return child.utf8_text(source).ok().map(|s| s.to_string());
            }
        }
    }

    // ── Elixir: dot → rightmost, binary_operator → operator text ──
    if nk == "dot" {
        return node
            .child_by_field_name("right")
            .and_then(|r| r.utf8_text(source).ok())
            .map(|s| s.to_string());
    }
    if nk == "binary_operator" {
        return node
            .child_by_field_name("operator")
            .and_then(|op| op.utf8_text(source).ok())
            .map(|s| s.to_string());
    }

    // ── Functional families: first child is the callee ──
    if matches!(nk, "apply" | "application_expression" | "exp_apply" | "list" | "list_lit" | "applicative") {
        let first = node.child(0)?;
        return extract_func_field_name(first, source);
    }

    None
}

/// Extract the first string argument from a call expression (for require/import).
fn extract_first_string_arg(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    let args = node.child_by_field_name("arguments")?;
    let mut cursor = args.walk();
    for child in args.children(&mut cursor) {
        let ck = child.kind();
        if ck == "string" || ck == "string_fragment" {
            return child.utf8_text(source).ok().map(|s| s.to_string());
        }
    }
    None
}

/// Extract exception class name from throw/raise node.
fn extract_throw_target(node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
    // Named children after the throw/raise keyword are the exception type
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.is_named() && child.kind() != "throw" && child.kind() != "raise" {
            return child.utf8_text(source).ok().map(|s| s.to_string());
        }
    }
    None
}

/// Check if identifier is at a definition site (should NOT create USAGE edge).
/// ponytail: only skip (a) name-field definitions, (b) identifiers inside import/export
/// statements (bindings, not usage references). Everything else — including function
/// arguments and non-callee identifiers inside call expressions — gets a USAGE edge.
fn is_definition_site(node: &tree_sitter::Node, _source: &[u8]) -> bool {
    if let Some(parent) = node.parent() {
        // Case 1: identifier IS the "name" field of its parent → definition site
        if let Some(name_field) = parent.child_by_field_name("name") {
            if name_field.id() == node.id() {
                return true;
            }
        }
        // Case 2: identifier is inside an import/export statement → binding, not usage
        // Walk up but stop at scope boundaries; ONLY check for import/export ancestors.
        let mut cur = Some(parent);
        while let Some(p) = cur {
            let k = p.kind();
            if k.contains("import") || k.contains("export") {
                return true;
            }
            // Stop at scope boundary — don't walk past function/class/module
            if k.contains("function") || k.contains("class") || k.contains("method")
                || k == "lambda" || k == "arrow_function" || k == "module"
                || k == "block" || k == "statement_block" || k == "source_file"
                || k == "program" || k == "module" || k == "translation_unit"
            {
                break;
            }
            cur = p.parent();
        }
    }
    false
}

/// Check if identifier is inside a parameter declaration (function signature).
fn is_param_decl(node: &tree_sitter::Node, _source: &[u8]) -> bool {
    let mut cur = Some(node.clone());
    while let Some(p) = cur.and_then(|n| n.parent()) {
        let k = p.kind();
        if k.contains("parameter") || k.contains("param") { return true; }
        // Stop at function/class boundary
        if k.contains("function") || k.contains("class") || k.contains("method")
            || k == "lambda" || k == "arrow_function" || k == "module"
        {
            break;
        }
        cur = Some(p);
    }
    false
}

/// Per-language builtin/common name blacklist for USAGE edge filtering.
fn is_builtin_for_ext(name: &str, ext: &str) -> bool {
    match ext {
        "py" | "pyi" => matches!(
            name,
            "True" | "False" | "None" | "self" | "cls"
                | "print" | "len" | "range" | "str" | "int" | "float" | "bool"
                | "list" | "dict" | "tuple" | "set" | "frozenset"
                | "type" | "isinstance" | "issubclass" | "super"
                | "Exception" | "ValueError" | "TypeError" | "KeyError"
                | "IndexError" | "AttributeError" | "RuntimeError" | "StopIteration"
                | "map" | "filter" | "zip" | "enumerate" | "sorted" | "reversed"
                | "any" | "all" | "min" | "max" | "sum" | "abs" | "round"
                | "open" | "iter" | "next" | "hasattr" | "getattr" | "setattr"
                | "staticmethod" | "classmethod" | "property"
                | "os" | "sys" | "re" | "json" | "datetime" | "logging"
                | "__name__" | "__file__" | "__init__" | "__str__" | "__repr__"
        ),
        "js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" => matches!(
            name,
            "console" | "window" | "document" | "globalThis" | "undefined" | "null"
                | "true" | "false" | "this" | "super" | "arguments"
                | "parseInt" | "parseFloat" | "isNaN" | "isFinite"
                | "JSON" | "Math" | "Object" | "Array" | "String" | "Number" | "Boolean"
                | "Map" | "Set" | "Date" | "RegExp" | "Promise" | "Symbol"
                | "Error" | "TypeError" | "SyntaxError" | "ReferenceError"
                | "Buffer" | "process" | "module" | "exports" | "require"
                | "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"
                | "fetch" | "async" | "await" | "yield"
        ),
        "rs" => matches!(
            name,
            "true" | "false" | "self" | "Self" | "None" | "Ok" | "Err" | "Some"
                | "println" | "print" | "format" | "dbg" | "panic" | "todo" | "unimplemented"
                | "vec" | "Vec" | "String" | "str" | "Option" | "Result" | "Box"
                | "HashMap" | "HashSet" | "Iterator" | "Clone" | "Copy" | "Debug"
                | "Drop" | "Default" | "std" | "core" | "alloc"
                | "i32" | "i64" | "u32" | "u64" | "f32" | "f64" | "bool" | "usize" | "isize"
        ),
        "go" => matches!(
            name,
            "true" | "false" | "nil" | "iota"
                | "fmt" | "Println" | "Printf" | "Sprintf" | "Errorf"
                | "string" | "int" | "int32" | "int64" | "float32" | "float64"
                | "bool" | "byte" | "rune" | "error"
                | "make" | "new" | "len" | "cap" | "append" | "copy" | "delete"
                | "panic" | "recover" | "defer" | "close"
                | "context" | "os" | "io" | "http" | "json"
        ),
        "java" => matches!(
            name,
            "true" | "false" | "null" | "this" | "super"
                | "System" | "out" | "err" | "in"
                | "String" | "Integer" | "Long" | "Double" | "Float" | "Boolean"
                | "List" | "Map" | "Set" | "ArrayList" | "HashMap" | "HashSet"
                | "Optional" | "Stream" | "Collectors" | "Objects"
                | "Override" | "Deprecated" | "SuppressWarnings"
        ),
        "rb" => matches!(
            name,
            "true" | "false" | "nil" | "self"
                | "puts" | "print" | "p" | "pp" | "gets" | "raise" | "require"
                | "Array" | "Hash" | "String" | "Symbol" | "Integer" | "Float"
                | "Enumerable" | "each" | "map" | "select" | "reduce" | "inject"
                | "attr_accessor" | "attr_reader" | "attr_writer" | "include" | "extend"
        ),
        "php" => matches!(
            name,
            "true" | "false" | "null" | "this" | "self" | "static" | "parent"
                | "echo" | "print" | "isset" | "empty" | "unset" | "array" | "list"
                | "count" | "strlen" | "sprintf" | "explode" | "implode"
                | "array_map" | "array_filter" | "array_merge" | "array_keys"
                | "json_encode" | "json_decode" | "file_get_contents" | "file_put_contents"
        ),
        // Single-char identifiers are always noise
        _ => name.len() <= 1,
    }
}

/// Noise names to skip in call edges.
fn is_skip_name(name: &str) -> bool {
    matches!(
        name,
        "console" | "Error" | "TypeError" | "SyntaxError" | "ReferenceError"
            | "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"
            | "fetch" | "JSON" | "Math" | "Object" | "Array" | "Promise"
            | "Map" | "Set" | "Date" | "RegExp" | "parseInt" | "parseFloat"
            | "require" | "import"
    )
}

/// Walk class children for extends_clause / implements_clause and emit Inherits edges.
fn emit_class_inherits(
    class_node: &tree_sitter::Node,
    source: &[u8],
    nid: &str,
    module_id: &str,
    file_id: &str,
    counter: &mut u32,
    edges: &mut Vec<Edge>,
) {
    let mut found = false;

    // Try field access first (works in some grammar versions)
    if let Some(ext) = class_node.child_by_field_name("extends") {
        emit_inherits_from_clause(&ext, source, nid, module_id, file_id, counter, edges);
        found = true;
    }
    if let Some(imp) = class_node.child_by_field_name("implements") {
        emit_inherits_from_clause(&imp, source, nid, module_id, file_id, counter, edges);
        found = true;
    }

    // Walk children for extends_clause / implements_clause / class_heritage / argument_list
    let mut cursor = class_node.walk();
    for child in class_node.children(&mut cursor) {
        match child.kind() {
            "extends_clause" | "implements_clause" => {
                emit_inherits_from_clause(&child, source, nid, module_id, file_id, counter, edges);
                found = true;
            }
            "class_heritage" => {
                let mut hc = child.walk();
                for gc in child.children(&mut hc) {
                    if gc.kind() == "extends_clause" || gc.kind() == "implements_clause" {
                        emit_inherits_from_clause(&gc, source, nid, module_id, file_id, counter, edges);
                        found = true;
                    }
                }
            }
            // Python: class Foo(Bar) → argument_list contains base class identifiers
            "argument_list" => {
                let mut ac = child.walk();
                for gc in child.children(&mut ac) {
                    if gc.kind() == "identifier" {
                        if let Ok(name) = gc.utf8_text(source) {
                            *counter += 1;
                            let target = format!("{}.{}", module_id, name);
                            edges.push(Edge::new(
                                format!("inh_{}_{}", file_id, counter),
                                nid, &target, EdgeKind::Inherits,
                            ));
                            found = true;
                        }
                    }
                }
            }
            // ponytail: some grammar versions embed implements types directly as children
            // without an implements_clause wrapper. Scan for type/identifier children
            // that appear after "implements" in the source text.
            _ => {}
        }
    }

    // Last resort: scan class source text for extends/implements patterns
    if !found {
        if let Ok(text) = class_node.utf8_text(source) {
            for keyword in &["extends", "implements"] {
                if let Some(pos) = text.find(keyword) {
                    let after = &text[pos + keyword.len()..];
                    // Extract up to '{' or end
                    let clause = after.split('{').next().unwrap_or(after);
                    for part in clause.split(',') {
                        let name = part.trim().split_whitespace().next().unwrap_or("").trim();
                        if !name.is_empty() && name != "{" && name != "}" {
                            let target_nid = format!("{}.{}", module_id, name);
                            *counter += 1;
                            let mut e = Edge::new(
                                format!("inh_{}_{}", file_id, *counter),
                                nid, &target_nid, EdgeKind::Inherits,
                            );
                            e.cross_file = true;
                            edges.push(e);
                        }
                    }
                }
            }
        }
    }
}

fn emit_inherits_from_clause(
    clause: &tree_sitter::Node,
    source: &[u8],
    nid: &str,
    module_id: &str,
    file_id: &str,
    counter: &mut u32,
    edges: &mut Vec<Edge>,
) {
    for name in extract_base_names_from_source(clause, source) {
        let target_nid = format!("{}.{}", module_id, name);
        *counter += 1;
        let mut e = Edge::new(
            format!("inh_{}_{}", file_id, *counter),
            nid,
            &target_nid,
            EdgeKind::Inherits,
        );
        e.cross_file = true;
        edges.push(e);
    }
}

/// Extract base type names from an inheritance clause node (using source text).
/// ponytail: simpler than extract_base_names — just reads text from "type_identifier"
/// and "identifier" children. Used for extends/implements clauses.
fn extract_base_names_from_source(clause: &tree_sitter::Node, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    let mut to_visit: Vec<tree_sitter::Node> = vec![*clause];
    while let Some(node) = to_visit.pop() {
        let ck = node.kind();
        if ck == "identifier" || ck == "type_identifier" || ck == "property_identifier"
            || ck == "nested_type_identifier" || ck == "member_expression"
        {
            if let Ok(t) = node.utf8_text(source) {
                let t = t.trim().to_string();
                if !t.is_empty() && !names.contains(&t) {
                    names.push(t);
                }
            }
            continue;
        }
        // Recurse into container nodes
        if node.is_named() {
            let mut cursor = node.walk();
            let children: Vec<_> = node.children(&mut cursor).collect();
            to_visit.extend(children.into_iter().rev());
        }
    }
    // Fallback: raw text split
    if names.is_empty() {
        if let Ok(text) = clause.utf8_text(source) {
            let text = text.trim();
            let text = text
                .trim_start_matches("extends ")
                .trim_start_matches("implements ")
                .trim_start_matches(':');
            for p in text.split(',') {
                let t = p.trim().split_whitespace().next().unwrap_or("").trim();
                if !t.is_empty() {
                    names.push(t.to_string());
                }
            }
        }
    }
    names
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    // ── JS/TS tests ──

    #[test]
    fn test_ts_function_declaration() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function hello() {}";
        let (nodes, _edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"), "should find hello function, got {:?}", names);
    }

    #[test]
    fn test_ts_variable_assigned_arrow() {
        // ponytail: this was a critical gap — const f = () => {} was invisible
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const fetchData = async () => { return 42; };";
        let (nodes, edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"fetchData"), "var-assigned arrow should be found, got {:?}", names);
        let defs: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Defines) && e.target.contains("fetchData")).collect();
        assert!(!defs.is_empty(), "should have Defines edge for fetchData");
    }

    #[test]
    fn test_ts_variable_assigned_function_expr() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const handler = function onEvent(ev) { return ev; };";
        let (nodes, _edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"handler"), "var-assigned fn expr should be found, got {:?}", names);
    }

    #[test]
    fn test_ts_call_expression() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function foo() {}\nfunction bar() { foo(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "foo").collect();
        assert!(!calls.is_empty(), "should have call to foo");
    }

    #[test]
    fn test_ts_member_expression_call() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function bar() { obj.method(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "method").collect();
        assert!(!calls.is_empty(), "member expression call should extract property name, got {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls)).map(|e| &e.target).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_jsx_component() {
        // ponytail: JSX requires LANGUAGE_TSX grammar (not LANGUAGE_TYPESCRIPT).
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function App() { return <div><Header /><Footer>text</Footer></div>; }";
        let (_nodes, edges, _) = a.analyze("test.tsx", src);
        let jsx_calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls)).collect();
        let targets: Vec<&str> = jsx_calls.iter().map(|e| e.target.as_str()).collect();
        assert!(targets.contains(&"Header"), "should find <Header /> call, got {:?}", targets);
        assert!(targets.contains(&"Footer"), "should find <Footer> call, got {:?}", targets);
        assert!(targets.contains(&"div"), "should find <div> call, got {:?}", targets);
    }

    /// Diagnostic: dump TSX AST to find JSX node type names in tree-sitter-typescript 0.23.
    #[test]
    fn test_tsx_ast_dump() {
        use crate::engine::GRAMMAR_LOADER;
        use tree_sitter::Parser;
        let lang = GRAMMAR_LOADER.get("tsx").expect("TSX grammar not loaded");
        let mut p = Parser::new();
        p.set_language(&lang).unwrap();
        let src = "<div><span>hello</span></div>";
        let tree = p.parse(src, None).unwrap();
        let root = tree.root_node();
        // Walk all nodes and print kinds containing "jsx" or "element"
        let mut stack = vec![root];
        let mut jsx_nodes: Vec<String> = Vec::new();
        while let Some(node) = stack.pop() {
            let k = node.kind();
            if k.contains("jsx") || k.contains("element") || k.contains("JSX") {
                let text = node.utf8_text(src.as_bytes()).unwrap_or("?");
                jsx_nodes.push(format!("kind={} text='{}'", k, text));
            }
            for child in node.children(&mut node.walk()) {
                stack.push(child);
            }
        }
        // Also dump ALL node kinds in the tree
        let mut kinds: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            kinds.push(node.kind().to_string());
            for child in node.children(&mut node.walk()) {
                stack.push(child);
            }
        }
        kinds.sort();
        kinds.dedup();
        eprintln!("JSX nodes: {:?}", jsx_nodes);
        eprintln!("ALL node kinds: {:?}", kinds);
    }

    #[test]
    fn test_ts_import() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "import { stuff } from './module';";
        let (_nodes, edges, _) = a.analyze("src/test.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert!(!imports.is_empty(), "should have import edge");
    }

    #[test]
    fn test_ts_export_reexport() {
        // ponytail: barrel file exports were invisible
        let a = QueryStructureAdapter::new_js_ts();
        let src = "export { foo } from './bar';";
        let (_nodes, edges, _) = a.analyze("src/index.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert!(!imports.is_empty(), "re-export should create import edge, got {:?}",
            edges.iter().map(|e| format!("{} kind={}", e.target, e.kind.as_str())).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_class_extends() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class Dog extends Animal {}";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let inh: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Inherits)).collect();
        assert!(!inh.is_empty(), "extends should create Inherits edge, got {:?}",
            edges.iter().map(|e| format!("{} -> {}", e.source, e.target)).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_class_implements() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class UserRepo implements IUserRepo {}";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        // ponytail: implements_clause extraction depends on grammar structure.
        // Verify that the class node and its children are accessible.
        // Fallback text parsing in extract_base_names_from_source handles
        // cases where structured walking misses names.
        let inh: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Inherits)).collect();
        if inh.is_empty() {
            // If structured extraction missed it, the fallback text parser should catch it.
            // Print edges for debugging grammar differences.
            eprintln!("DEBUG implements: all edges = {:?}",
                edges.iter().map(|e| format!("{} -> {} ({})", e.source, e.target, e.kind.as_str())).collect::<Vec<_>>());
        }
        assert!(!inh.is_empty(), "implements should create Inherits edge, got {:?}",
            edges.iter().map(|e| format!("{} -> {}", e.source, e.target)).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_require_import() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const fs = require('fs');";
        let (_nodes, edges, _) = a.analyze("test.js", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports) && e.target.contains("fs")).collect();
        assert!(!imports.is_empty(), "require('fs') should create import edge, got imports: {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).map(|e| &e.target).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_dynamic_import() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "const mod = await import('./lazy');";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports) && e.target.contains("lazy")).collect();
        assert!(!imports.is_empty(), "dynamic import() should create import edge, got imports: {:?}",
            edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).map(|e| &e.target).collect::<Vec<_>>());
    }

    #[test]
    fn test_ts_call_scope_attribution() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function outer() {\n  function inner() {\n    foo();\n  }\n}";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "foo");
        assert!(call.is_some(), "should have call to foo");
        let call = call.unwrap();
        assert!(call.source.contains("inner"), "call inside inner should be attributed to inner, got '{}'", call.source);
    }

    #[test]
    fn test_ts_enum() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "enum Status { Active, Inactive }";
        let (nodes, _edges, _) = a.analyze("test.ts", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Status"), "enum should be found, got {:?}", names);
    }

    #[test]
    fn test_ts_new_expression() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "class Foo {}\nfunction bar() { new Foo(); }";
        let (_nodes, edges, _) = a.analyze("test.ts", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "Foo").collect();
        assert!(!calls.is_empty(), "new Foo() should create call edge");
    }

    // ── Rust tests ──

    #[test]
    fn test_rust_function() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn hello() {}\npub fn add(a: i32, b: i32) -> i32 { a + b }";
        let (nodes, _edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello"), "should find hello, got {:?}", names);
        assert!(names.contains(&"add"), "should find add, got {:?}", names);
    }

    #[test]
    fn test_rust_struct() {
        let a = QueryStructureAdapter::new_rust();
        let src = "struct Point { x: f64, y: f64 }";
        let (nodes, _edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Point"), "struct should be found, got {:?}", names);
    }

    #[test]
    fn test_rust_trait_and_impl() {
        let a = QueryStructureAdapter::new_rust();
        let src = "trait Draw { fn draw(&self); }\nstruct Circle;\nimpl Draw for Circle { fn draw(&self) {} }";
        let (nodes, edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Draw"), "trait should be found");
        assert!(names.contains(&"Circle"), "struct should be found");
        let inh: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Inherits)).collect();
        assert!(!inh.is_empty(), "impl Draw for Circle should produce Inherits edge, got {:?}",
            edges.iter().map(|e| format!("{} -> {}", e.source, e.target)).collect::<Vec<_>>());
    }

    #[test]
    fn test_rust_call() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn helper() {}\nfn outer() { helper(); }";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "helper").collect();
        assert!(!calls.is_empty(), "should have call to helper");
    }

    #[test]
    fn test_rust_call_scope_attribution() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn outer() { fn inner() { foo(); } }";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let call = edges.iter().find(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "foo");
        assert!(call.is_some(), "should have call to foo");
        let call = call.unwrap();
        assert!(call.source.contains("inner"), "call inside inner should be attributed to inner, got '{}'", call.source);
    }

    #[test]
    fn test_rust_macro_call() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn main() { println!(\"hello\"); }";
        let (_nodes, edges, _) = a.analyze("main.rs", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "println").collect();
        assert!(!calls.is_empty(), "macro invocation should create call edge");
    }

    #[test]
    fn test_rust_method_call() {
        let a = QueryStructureAdapter::new_rust();
        let src = "fn process(v: Vec<i32>) { let n = v.len(); }";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let calls: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Calls) && e.target == "len").collect();
        assert!(!calls.is_empty(), "field expression call should extract method name");
    }

    #[test]
    fn test_rust_use_declaration() {
        let a = QueryStructureAdapter::new_rust();
        let src = "use std::collections::HashMap;";
        let (_nodes, edges, _) = a.analyze("lib.rs", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        assert!(!imports.is_empty(), "use declaration should create import edge");
    }

    #[test]
    fn test_rust_type_alias() {
        let a = QueryStructureAdapter::new_rust();
        let src = "type Meters = f64;";
        let (nodes, _edges, _) = a.analyze("lib.rs", src);
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Meters"), "type alias should be found, got {:?}", names);
    }

    #[test]
    fn test_ts_multiple_imports() {
        // Verify that all import variants create edges
        let a = QueryStructureAdapter::new_js_ts();
        let src = "import { bus } from './events';\nimport type { AgentEvent } from '../agent/types';\nexport function foo() {}";
        let (_nodes, edges, _) = a.analyze("src/ui/chat.ts", src);
        let imports: Vec<_> = edges.iter().filter(|e| matches!(e.kind, EdgeKind::Imports)).collect();
        let targets: Vec<&str> = imports.iter().map(|e| e.target.as_str()).collect();
        assert!(!imports.is_empty(), "should have import edges, got edges: {:?}",
            edges.iter().map(|e| format!("{}->{} ({})", e.source, e.target, e.kind.as_str())).collect::<Vec<_>>());
        eprintln!("DEBUG import targets: {:?}", targets);
    }

    #[test]
    fn test_ts_file_id_preserves_directory() {
        let a = QueryStructureAdapter::new_js_ts();
        let src = "function hello() {}";
        let (nodes, _, _) = a.analyze("src/ui/graph.ts", src);
        let file_node = nodes.iter().find(|n| matches!(n.kind, NodeKind::File));
        assert!(file_node.is_some());
        let fid = &file_node.unwrap().id;
        assert!(fid.contains("src"), "file_id should contain dir, got '{}'", fid);
        assert!(fid.contains("ui"), "file_id should contain subdir, got '{}'", fid);
    }
}
