// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Dataflow synthesis — produces Reads/Writes/Shares/Triggers/Awaits/Sequences edges
//! from tree-sitter AST data.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeKind};

/// Parsed source held in the pipeline parse cache.
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

// Thread-local name→node_id index. Populated once before dataflow synthesis
// so `node_id_for` / `medium_id_for` can do O(1) lookups instead of O(N) scans.
thread_local! {
    static NAME_IDX: RefCell<Option<HashMap<String, String>>> = RefCell::new(None);
}

pub fn synthesize_dataflow_edges(
    graph: &mut Graph,
    project_root: &Path,
    parse_cache: &ParseCache,
    discovered_files: &[std::path::PathBuf],
) -> usize {
    let mut files: HashSet<String> = HashSet::new();
    for p in discovered_files {
        let s = p.to_string_lossy().replace('\\', "/");
        let lower = s.to_lowercase();
        if lower.ends_with(".js")||lower.ends_with(".ts")||lower.ends_with(".tsx")||lower.ends_with(".py") {
            files.insert(s);
        }
    }
    // Guard: dataflow synthesis creates nodes for every Read/Write/Trigger/Await
    // target. On large projects (>300 JS/TS/Python files) this floods the graph
    // with 100K+ synthesized nodes and takes minutes. Skip — it's an enhancement,
    // not core analysis. Framework routes + dynamic dispatch + communities still run.
    if files.len() > 300 {
        tracing::info!(files = files.len(), "[dataflow] skipping — project too large");
        return 0;
    }
    // Pre-build name → node_id index for O(1) lookups (was O(N) per node_id_for call).
    let mut name_to_id: HashMap<String, String> = HashMap::new();
    for (id, node) in graph.nodes.iter() {
        name_to_id.entry(node.name.clone()).or_insert_with(|| id.clone());
    }
    NAME_IDX.with(|cell| *cell.borrow_mut() = Some(name_to_id));

    let mut added = 0usize;
    for file in &files {
        let abs_key = if file.contains(':') {
            file.clone()
        } else {
            project_root.join(file).to_string_lossy().replace('\\', "/")
        };
        if let Some((source, Some(tree))) = parse_cache.get(&abs_key) {
            if file.to_lowercase().ends_with(".py") {
                added += walk_py_dataflow_tree(graph, file, tree, source);
            } else {
                added += walk_js_dataflow_tree(graph, file, tree, source);
            }
        } else {
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                if file.to_lowercase().ends_with(".py") {
                    added += synthesize_py_fallback(graph, file, &source);
                } else {
                    added += synthesize_js_ts_fallback(graph, file, &source);
                }
            }
        }
    }

    NAME_IDX.with(|cell| *cell.borrow_mut() = None);
    added
}

// ── helpers ──

fn node_id_for(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    // O(1) lookup via pre-built name index.
    if let Some(id) = NAME_IDX.with(|cell| cell.borrow().as_ref().and_then(|idx| idx.get(name).cloned())) {
        return id;
    }
    // Only create new nodes for variables that don't already exist in the graph.
    // This prevents dataflow from flooding the graph with 100K+ synthesized nodes
    // (one per variable per file) on large projects like Django.
    // The node will still get edges if referenced by synthesis later.
    let nid = format!("df_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut n = Node::new(&nid, name, NodeKind::Symbol);
    n.location = Some(format!("{}:{}", file, line));
    n.properties = serde_json::json!({"kind":"synthesized","provenance":"dataflow"});
    graph.add_node(n);
    // Also register in the index so subsequent calls find it in O(1)
    NAME_IDX.with(|cell| {
        if let Some(ref mut idx) = *cell.borrow_mut() {
            idx.insert(name.to_string(), nid.clone());
        }
    });
    nid
}

fn medium_id_for(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    // O(1) lookup
    if let Some(id) = NAME_IDX.with(|cell| cell.borrow().as_ref().and_then(|idx| idx.get(name).cloned())) {
        if let Some(node) = graph.nodes.get(&id) {
            if matches!(node.kind, NodeKind::Medium) { return id; }
        }
    }
    // Fallback: O(N) scan + insert
    for (id, node) in &graph.nodes {
        if node.name == name && matches!(node.kind, NodeKind::Medium) { return id.clone(); }
    }
    let nid = format!("med_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut n = Node::new(&nid, name, NodeKind::Medium);
    n.location = Some(format!("{}:{}", file, line));
    n.properties = serde_json::json!({"kind":"shared_state","provenance":"dataflow"});
    graph.add_node(n);
    nid
}

fn insert_edge(g: &mut Graph, eid: &str, src: &str, tgt: &str, kind: EdgeKind, depth: u8, delay: Option<f64>) -> usize {
    if g.get_edge(eid).is_none() && src != tgt {
        g.add_edge(Edge{id:eid.into(),source:src.into(),target:tgt.into(),kind,coupling_depth:depth,cross_file:false,direction:"synthesized".into(),temporal_delay_sec:delay,medium_node_id:None,lsp_resolved:false});
        1
    } else { 0 }
}

fn fid(file: &str) -> String { file.replace(['.', '/', '\\'], "_") }

/// Walk a function body in source order and add Sequences edges between consecutive calls.
fn synthesize_sequences(
    graph: &mut Graph, body: &tree_sitter::Node, source: &str,
    fn_id: &str, file: &str, ff: &str, added: &mut usize,
) {
    let call_kinds: HashSet<&str> = ["call", "call_expression"].iter().cloned().collect();
    let mut calls: Vec<(String, usize)> = Vec::new(); // (target_name, line)
    let mut stack: Vec<tree_sitter::Node<'_>> = body.children(&mut body.walk()).collect();
    stack.reverse(); // process in source order
    while let Some(node) = stack.pop() {
        if call_kinds.contains(node.kind()) {
            let target = if let Some(f) = node.child_by_field_name("function") {
                f.utf8_text(source.as_bytes()).unwrap_or("?").to_string()
            } else {
                node.utf8_text(source.as_bytes()).unwrap_or("?").to_string()
            };
            if target.len() > 1 && target != "?" {
                calls.push((target, node.start_position().row + 1));
            }
        }
        let children: Vec<_> = node.children(&mut node.walk()).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }
    // Link consecutive calls
    for i in 1..calls.len() {
        let (prev, _) = &calls[i - 1];
        let (next, line) = &calls[i];
        let pid = node_id_for(graph, prev, file, *line);
        let nid = node_id_for(graph, next, file, *line);
        let eid = format!("seq_{}_{}_{}_{}", ff, fn_id, i - 1, i);
        *added += insert_edge(graph, &eid, &pid, &nid, EdgeKind::Sequences, 3, None);
    }
}

// ═══════════════════════════ Python ═══════════════════════════

fn synthesize_py_fallback(graph: &mut Graph, file: &str, source: &str) -> usize {
    let mut p = tree_sitter::Parser::new();
    if p.set_language(&tree_sitter_python::LANGUAGE.into()).is_err() { return 0; }
    let tree = match p.parse(source, None) { Some(t) => t, None => return 0 };
    walk_py_dataflow_tree(graph, file, &tree, source)
}

fn walk_py_dataflow_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    let mut added = 0usize;
    let ff = fid(file);
    let root = tree.root_node();

    // Module-level assignments → Shares candidates
    let mut module_vars: HashSet<String> = HashSet::new();
    for child in root.children(&mut root.walk()) {
        if child.kind() == "expression_statement" {
            for gc in child.children(&mut child.walk()) {
                if gc.kind() == "assignment" { py_collect_lhs(&gc, source, &mut module_vars); }
            }
        }
    }

    let mut cur = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];
    while let Some(node) = stack.pop() {
        match node.kind() {
            "function_definition" => { // tree-sitter-python: async def is function_definition + "async" child
                let fn_name = node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("<fn@{}>", node.start_position().row + 1));
                let fn_id = node_id_for(graph, &fn_name, file, node.start_position().row + 1);
                let mut body_vars = HashSet::new();
                py_walk_body(&node, source, &mut body_vars, &fn_id, file, &ff, graph, &mut added);
                // Sequences: consecutive calls within this function
                synthesize_sequences(graph, &node, source, &fn_id, file, &ff, &mut added);
                // Shares from module vars accessed in this function
                for mv in &module_vars {
                    if body_vars.contains(mv) {
                        let mid = medium_id_for(graph, mv, file, node.start_position().row + 1);
                        let eid = format!("shr_{}_{}_{}", ff, fn_name, mv);
                        added += insert_edge(graph, &eid, &fn_id, &mid, EdgeKind::Shares, 3, None);
                    }
                }
            }
            "class_definition" => {
                let class_name = node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok()).unwrap_or_default();
                if class_name.is_empty() { continue; }
                let body = {
                    let mut cc = node.walk();
                    node.child_by_field_name("body")
                        .or_else(|| node.children(&mut cc).find(|c| c.kind() == "block"))
                };
                if let Some(body) = body {
                    for child in body.children(&mut body.walk()) {
                        if child.kind() == "expression_statement" {
                            for gc_node in child.children(&mut child.walk()) {
                                if gc_node.kind() == "assignment" {
                                    let mut lhs = HashSet::new();
                                    py_collect_lhs(&gc_node, source, &mut lhs);
                                    for n in &lhs {
                                        let mid = medium_id_for(graph, n, file, gc_node.start_position().row + 1);
                                        let eid = format!("shr_cls_{}_{}_{}", ff, class_name, n);
                                        added += insert_edge(graph, &eid, &format!("{}.{}", ff, class_name), &mid, EdgeKind::Shares, 3, None);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "await" => {
                // tree-sitter-python < 0.24: `await` may appear as a node kind.
                // For 0.24+ it's a keyword child (handled by expression_statement below).
                if let Some(fn_name) = py_find_async_fn(&node, source) {
                    if let Some(target) = py_await_target(&node, source) {
                        let fn_id = node_id_for(graph, &fn_name, file, node.start_position().row + 1);
                        let tgt_id = node_id_for(graph, &target, file, node.start_position().row + 1);
                        let eid = format!("trg_{}_{}_{}", ff, fn_name, target);
                        added += insert_edge(graph, &eid, &fn_id, &tgt_id, EdgeKind::Triggers, 3, Some(0.0));
                    }
                }
            }
            "expression_statement" => {
                // Detect `await` keyword in expression statements
                let has_await = node.children(&mut node.walk()).any(|c| c.kind() == "await");
                if has_await {
                    if let Some(fn_name) = py_find_async_fn(&node, source) {
                        if let Some(target) = py_await_target_expr(&node, source) {
                            let fn_id = node_id_for(graph, &fn_name, file, node.start_position().row + 1);
                            let tgt_id = node_id_for(graph, &target, file, node.start_position().row + 1);
                            let eid = format!("trg_{}_{}_{}", ff, fn_name, target);
                            added += insert_edge(graph, &eid, &fn_id, &tgt_id, EdgeKind::Triggers, 3, Some(0.0));
                        }
                    }
                }
            }
            _ => {}
        }
        let children: Vec<_> = node.children(&mut cur).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }
    added
}

fn py_collect_lhs(assign: &tree_sitter::Node, source: &str, out: &mut HashSet<String>) {
    if let Some(lhs) = assign.child_by_field_name("left") {
        if lhs.kind() == "identifier" {
            if let Ok(n) = lhs.utf8_text(source.as_bytes()) { out.insert(n.to_string()); }
        } else if lhs.kind() == "pattern_list" || lhs.kind() == "tuple" {
            for child in lhs.children(&mut lhs.walk()) {
                if child.kind() == "identifier" {
                    if let Ok(n) = child.utf8_text(source.as_bytes()) { out.insert(n.to_string()); }
                }
            }
        }
    }
}

fn py_walk_body(func: &tree_sitter::Node, source: &str, body_vars: &mut HashSet<String>,
    fn_id: &str, file: &str, ff: &str, graph: &mut Graph, added: &mut usize,
) {
    let mut stack: Vec<tree_sitter::Node<'_>> = func.children(&mut func.walk()).collect();
    stack.reverse();
    while let Some(node) = stack.pop() {
        match node.kind() {
            "assignment" | "augmented_assignment" => {
                let mut lhs = HashSet::new();
                py_collect_lhs(&node, source, &mut lhs);
                for n in &lhs {
                    let tgt = node_id_for(graph, n, file, node.start_position().row + 1);
                    let eid = format!("wrt_{}_{}_{}", ff, fn_id, n);
                    *added += insert_edge(graph, &eid, fn_id, &tgt, EdgeKind::Writes, 3, None);
                    body_vars.insert(n.clone());
                }
            }
            "identifier" => {
                if py_is_lhs(&node) { continue; }
                if let Ok(name) = node.utf8_text(source.as_bytes()) {
                    if name.chars().next().map_or(false, |c| c.is_lowercase()) && name != "self" {
                        let tgt = node_id_for(graph, name, file, node.start_position().row + 1);
                        let eid = format!("rd_{}_{}_{}", ff, fn_id, name);
                        if *added < 10000 {
                            *added += insert_edge(graph, &eid, fn_id, &tgt, EdgeKind::Reads, 3, None);
                        }
                        body_vars.insert(name.to_string());
                    }
                }
            }
            _ => {}
        }
        let children: Vec<_> = node.children(&mut node.walk()).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }
}

fn py_is_lhs(node: &tree_sitter::Node) -> bool {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "assignment"|"augmented_assignment" => return p.child_by_field_name("left").map_or(false, |l| l.id()==node.id()),
            "pattern_list"|"tuple" => return true,
            "function_definition"|"class_definition" => return false,
            _ => {}
        }
        cur = p.parent();
    }
    false
}

fn py_find_async_fn(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        // tree-sitter-python: async def → function_definition node with "async" child keyword
        if p.kind() == "function_definition" {
            let is_async = p.children(&mut p.walk()).any(|c| c.kind() == "async");
            if is_async {
                return p.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok()).map(|s| s.to_string());
            }
        }
        cur = p.parent();
    }
    None
}

fn py_await_target(node: &tree_sitter::Node, source: &str) -> Option<String> {
    for child in node.children(&mut node.walk()) {
        if child.kind() == "call" {
            if let Some(f) = child.child_by_field_name("function") {
                return Some(f.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string());
            }
        }
        if child.kind() == "identifier" {
            return Some(child.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string());
        }
    }
    None
}

fn py_await_target_expr(node: &tree_sitter::Node, source: &str) -> Option<String> {
    // The expression_statement containing await has children like: [await, call_expr]
    for child in node.children(&mut node.walk()) {
        if child.kind() == "await" {
            // The next sibling after 'await' is typically the call/expression
            continue;
        }
        if child.kind() == "call" {
            if let Some(f) = child.child_by_field_name("function") {
                return Some(f.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string());
            }
            // fallback: return the whole call text
            return Some(child.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string());
        }
        if child.kind() == "identifier" {
            return Some(child.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string());
        }
    }
    None
}

// ═══════════════════════════ JS/TS ═══════════════════════════

fn synthesize_js_ts_fallback(graph: &mut Graph, file: &str, source: &str) -> usize {
    let is_ts = file.ends_with(".ts") || file.ends_with(".tsx");
    let lang: tree_sitter::Language = if is_ts { tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into() }
        else { tree_sitter_javascript::LANGUAGE.into() };
    let mut p = tree_sitter::Parser::new();
    if p.set_language(&lang).is_err() { return 0; }
    let tree = match p.parse(source, None) { Some(t) => t, None => return 0 };
    walk_js_dataflow_tree(graph, file, &tree, source)
}

fn walk_js_dataflow_tree(graph: &mut Graph, file: &str, tree: &tree_sitter::Tree, source: &str) -> usize {
    let mut added = 0usize;
    let ff = fid(file);
    let root = tree.root_node();

    // Module-level declarations
    let mut module_vars: HashSet<String> = HashSet::new();
    for child in root.children(&mut root.walk()) { js_collect_decls(&child, source, &mut module_vars); }
    // Class-level fields → (class_name, field_name)
    let mut class_fields: HashMap<String, HashSet<String>> = HashMap::new();

    let mut cur = root.walk();
    let mut stack: Vec<tree_sitter::Node<'_>> = vec![root];
    while let Some(node) = stack.pop() {
        match node.kind() {
            "function_declaration"|"function_expression"|"arrow_function"|"method_definition"|"generator_function_declaration" => {
                let fn_name = node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok())
                    .map(|s| s.to_string())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("<fn@{}>", node.start_position().row + 1));
                let fn_id = node_id_for(graph, &fn_name, file, node.start_position().row + 1);
                let mut body_vars = HashSet::new();
                js_walk_body(&node, source, &mut body_vars, &fn_id, file, &ff, graph, &mut added);
                synthesize_sequences(graph, &node, source, &fn_id, file, &ff, &mut added);
                for mv in &module_vars {
                    if body_vars.contains(mv) {
                        let mid = medium_id_for(graph, mv, file, node.start_position().row + 1);
                        let eid = format!("shr_{}_{}_{}", ff, fn_name, mv);
                        added += insert_edge(graph, &eid, &fn_id, &mid, EdgeKind::Shares, 3, None);
                    }
                }
            }
            "class_declaration" => {
                let cname = node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source.as_bytes()).ok()).unwrap_or_default();
                if !cname.is_empty() {
                    if let Some(body) = node.child_by_field_name("body") {
                        for child in body.children(&mut body.walk()) {
                            if child.kind() == "public_field_definition" {
                                if let Some(nn) = child.child_by_field_name("name") {
                                    if let Ok(fname) = nn.utf8_text(source.as_bytes()) {
                                        class_fields.entry(cname.to_string()).or_default().insert(fname.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "await_expression" => {
                if let Some(fn_name) = js_containing_fn(&node, source) {
                    let fn_id = node_id_for(graph, &fn_name, file, node.start_position().row + 1);
                    let target = js_await_target(&node, source);
                    let tgt_id = node_id_for(graph, &target, file, node.start_position().row + 1);
                    let eid = format!("trg_{}_{}_{}", ff, fn_name, target);
                    added += insert_edge(graph, &eid, &fn_id, &tgt_id, EdgeKind::Triggers, 3, Some(0.0));
                }
            }
            _ => {}
        }
        let children: Vec<_> = node.children(&mut cur).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }

    // Class fields → Shares
    for (cname, fields) in &class_fields {
        for f in fields {
            let mid = medium_id_for(graph, f, file, 0);
            let eid = format!("shr_cls_{}_{}_{}", ff, cname, f);
            added += insert_edge(graph, &eid, &format!("{}.{}", ff, cname), &mid, EdgeKind::Shares, 3, None);
        }
    }

    // Awaits: .then(cb) chains
    let mut ac = root.walk();
    let mut await_stack: Vec<tree_sitter::Node<'_>> = vec![root];
    while let Some(node) = await_stack.pop() {
        if node.kind() == "call_expression" {
            if let Some((cb_name, line)) = js_then_cb(&node, source) {
                let fn_name = js_containing_fn(&node, source).unwrap_or_else(|| format!("<fn@{}>", line));
                let fn_id = node_id_for(graph, &fn_name, file, line);
                let cb_id = node_id_for(graph, &cb_name, file, line);
                let eid = format!("awt_{}_{}_{}", ff, fn_name, cb_name);
                added += insert_edge(graph, &eid, &fn_id, &cb_id, EdgeKind::Awaits, 3, Some(0.0));
            }
        }
        let children: Vec<_> = node.children(&mut ac).collect();
        for child in children.into_iter().rev() { await_stack.push(child); }
    }

    added
}

fn js_collect_decls(node: &tree_sitter::Node, source: &str, out: &mut HashSet<String>) {
    match node.kind() {
        "variable_declaration"|"lexical_declaration" => {
            for child in node.children(&mut node.walk()) {
                if child.kind() == "variable_declarator" {
                    if let Some(nn) = child.child_by_field_name("name") {
                        if let Ok(n) = nn.utf8_text(source.as_bytes()) { out.insert(n.to_string()); }
                    }
                }
            }
        }
        "export_statement" => { for child in node.children(&mut node.walk()) { js_collect_decls(&child, source, out); } }
        _ => {}
    }
}

fn js_walk_body(func: &tree_sitter::Node, source: &str, body_vars: &mut HashSet<String>,
    fn_id: &str, file: &str, ff: &str, graph: &mut Graph, added: &mut usize,
) {
    let mut stack: Vec<tree_sitter::Node<'_>> = func.children(&mut func.walk()).collect();
    stack.reverse();
    while let Some(node) = stack.pop() {
        match node.kind() {
            "assignment_expression"|"augmented_assignment_expression" => {
                if let Some(lhs) = node.child_by_field_name("left") {
                    if let Ok(name) = lhs.utf8_text(source.as_bytes()) {
                        if name.chars().next().map_or(false, |c| c.is_alphabetic()) {
                            let tgt = node_id_for(graph, name, file, node.start_position().row + 1);
                            let eid = format!("wrt_{}_{}_{}", ff, fn_id, name);
                            *added += insert_edge(graph, &eid, fn_id, &tgt, EdgeKind::Writes, 3, None);
                            body_vars.insert(name.to_string());
                        }
                    }
                }
            }
            "variable_declaration"|"lexical_declaration" => {
                for child in node.children(&mut node.walk()) {
                    if child.kind() == "variable_declarator" {
                        if let Some(nn) = child.child_by_field_name("name") {
                            if let Ok(n) = nn.utf8_text(source.as_bytes()) {
                                let tgt = node_id_for(graph, n, file, node.start_position().row + 1);
                                let eid = format!("wrt_{}_{}_{}", ff, fn_id, n);
                                *added += insert_edge(graph, &eid, fn_id, &tgt, EdgeKind::Writes, 3, None);
                                body_vars.insert(n.to_string());
                            }
                        }
                    }
                }
            }
            "identifier" => {
                if js_is_lhs(&node) { continue; }
                if let Ok(name) = node.utf8_text(source.as_bytes()) {
                    if name.chars().next().map_or(false, |c| c.is_lowercase())
                        && name != "this" && name != "super" && name != "undefined" && name != "null"
                        && name != "console" && name != "window" && name != "document"
                    {
                        let tgt = node_id_for(graph, name, file, node.start_position().row + 1);
                        let eid = format!("rd_{}_{}_{}", ff, fn_id, name);
                        *added += insert_edge(graph, &eid, fn_id, &tgt, EdgeKind::Reads, 3, None);
                        body_vars.insert(name.to_string());
                    }
                }
            }
            _ => {}
        }
        let children: Vec<_> = node.children(&mut node.walk()).collect();
        for child in children.into_iter().rev() { stack.push(child); }
    }
}

fn js_is_lhs(node: &tree_sitter::Node) -> bool {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "assignment_expression"|"augmented_assignment_expression" => return p.child_by_field_name("left").map_or(false, |l| l.id()==node.id()),
            "variable_declarator" => return p.child_by_field_name("name").map_or(false, |n| n.id()==node.id()),
            "function_declaration"|"class_declaration"|"method_definition"|"arrow_function" => return false,
            _ => {}
        }
        cur = p.parent();
    }
    false
}

fn js_containing_fn(node: &tree_sitter::Node, source: &str) -> Option<String> {
    let mut cur = node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "function_declaration"|"function_expression"|"method_definition"|"arrow_function"|"generator_function_declaration" => {
                if let Some(nn) = p.child_by_field_name("name") {
                    return Some(nn.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                }
                return Some(format!("<fn@{}>", p.start_position().row + 1));
            }
            _ => {}
        }
        cur = p.parent();
    }
    None
}

fn js_await_target(node: &tree_sitter::Node, source: &str) -> String {
    for child in node.children(&mut node.walk()) {
        if child.kind() == "call_expression" {
            if let Some(f) = child.child_by_field_name("function") {
                return f.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string();
            }
        }
        if child.kind() == "identifier" {
            return child.utf8_text(source.as_bytes()).unwrap_or("await_target").to_string();
        }
    }
    "await_target".into()
}

fn js_then_cb(call: &tree_sitter::Node, source: &str) -> Option<(String, usize)> {
    let func = call.child_by_field_name("function")?;
    if func.kind() != "member_expression" { return None; }
    let prop = func.children(&mut func.walk())
        .filter(|c| c.kind()=="property_identifier").last()
        .map(|c| c.utf8_text(source.as_bytes()).unwrap_or("").to_string())?;
    if prop != "then" && prop != "catch" && prop != "finally" { return None; }
    let args = call.child_by_field_name("arguments")?;
    for arg in args.children(&mut args.walk()) {
        match arg.kind() {
            "identifier" => {
                let name = arg.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                if !name.is_empty() && name != "undefined" { return Some((name, arg.start_position().row+1)); }
            }
            "arrow_function"|"function_expression" => {
                let line = arg.start_position().row+1;
                if let Some(nn) = arg.child_by_field_name("name") {
                    let name = nn.utf8_text(source.as_bytes()).unwrap_or("").to_string();
                    if !name.is_empty() { return Some((name, line)); }
                }
                return Some((format!("<cb@{}>", line), line));
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df0");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("x.py"), "").unwrap();
        assert_eq!(synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[]), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_py_reads_writes() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df1");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.py"), "counter = 0\ndef inc():\n    x = counter + 1\n    return x\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("a.py")]);
        assert!(n > 0, "got {}", n);
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Reads)), "no Reads");
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Writes)), "no Writes");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_py_shares() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df2");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("m.py"), "db = None\ndef conn():\n    global db\n    db = 'x'\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("m.py")]);
        assert!(n > 0, "got {}", n);
        assert!(g.nodes.values().any(|n| matches!(n.kind, NodeKind::Medium)), "no Medium");
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Shares)), "no Shares");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_py_triggers() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df3");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("async_m.py"), "async def fetch():\n    data = await get_data()\n    return data\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("async_m.py")]);
        assert!(n > 0, "got {}", n);
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Triggers)), "no Triggers");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_js_reads_writes() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df4");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("app.js"), "let count = 0;\nfunction inc() {\n    const x = count + 1;\n    count = x;\n}\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("app.js")]);
        assert!(n > 0, "got {}", n);
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Reads)), "no JS Reads");
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Writes)), "no JS Writes");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_js_awaits() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df5");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("chain.js"), "function go() {\n    fetch('/api').then(handleData);\n}\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("chain.js")]);
        assert!(n > 0, "got {}", n);
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Awaits)), "no Awaits");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_sequences() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df6");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("pipe.py"), "def run():\n    load()\n    transform()\n    save()\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("pipe.py")]);
        assert!(n > 0, "got {}", n);
        let has_seq = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Sequences));
        assert!(has_seq, "should have Sequences edges between consecutive calls");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
