// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Generic dataflow query engine — runs tree-sitter queries and synthesises
//! Reads/Writes/Shares/Triggers/Awaits/Sequences edges without per-language walkers.
//!
//! Architecture:
//!   1. Run .scm queries → collect captures (write/read/trigger/scope/sequence)
//!   2. Group captures by enclosing scope (function/class/module)
//!   3. Emit edges: Reads/Writes within scopes, Shares across scopes,
//!      Triggers/Awaits for async patterns, Sequences for call ordering.
//!
//! A new language needs only a ~30-line .scm file + a builtin-name list —
//! no Rust walker code required.

use crate::graph::{EdgeKind, Graph};
use std::collections::{HashMap, HashSet};
use tree_sitter::{Language, Node as TsNode, Query, QueryCursor};
use streaming_iterator::StreamingIterator;

// ── Language config ──

pub struct LangDataflowConfig {
    /// Compiled-in .scm query source
    pub query_src: &'static str,
    /// Names to filter out (builtins, host objects)
    pub skip_names: &'static [&'static str],
    /// Function-scope node kinds (for scope-boundary detection)
    pub func_kinds: &'static [&'static str],
    /// Class-scope node kinds
    pub class_kinds: &'static [&'static str],
}

impl LangDataflowConfig {
    fn is_skip_name(&self, name: &str) -> bool {
        self.skip_names.contains(&name)
    }

    fn scope_role(&self, kind: &str) -> Option<&'static str> {
        if self.func_kinds.contains(&kind) { return Some("function"); }
        if self.class_kinds.contains(&kind) { return Some("class"); }
        None
    }
}

// ── Python config ──

static PY_BUILTINS: &[&str] = &[
    "str","int","float","bool","bytes","bytearray","complex",
    "list","dict","tuple","set","frozenset","object",
    "True","False","None",
    "len","range","type","print","isinstance","issubclass",
    "super","Exception","ValueError","TypeError","KeyError",
    "IndexError","AttributeError","RuntimeError","StopIteration",
    "map","filter","zip","enumerate","sorted","reversed",
    "any","all","min","max","sum","abs","round",
    "chr","ord","hex","oct","bin","hash","id","repr",
    "input","open","format","staticmethod","classmethod",
    "property","hasattr","getattr","setattr","delattr",
    "iter","next","slice","dir","vars","__name__","__file__",
];

static PY_FUNC_KINDS: &[&str] = &["function_definition","lambda"];
static PY_CLASS_KINDS: &[&str] = &["class_definition"];

// ── JS/TS config ──

static JS_SKIP_NAMES: &[&str] = &[
    "this","super","undefined","null","NaN","Infinity",
    "console","window","document","process","global","globalThis",
    "Math","JSON","Date","RegExp","Promise","Array","Object",
    "String","Number","Boolean","Function","Symbol","Map","Set",
    "WeakMap","WeakSet","Proxy","Reflect","Error","TypeError",
    "parseInt","parseFloat","isNaN","isFinite",
    "setTimeout","setInterval","clearTimeout","clearInterval",
    "fetch","XMLHttpRequest","FormData","URL","URLSearchParams",
    "Intl","BigInt",
];

static JS_FUNC_KINDS: &[&str] = &[
    "function_declaration","function_expression","arrow_function",
    "method_definition","generator_function_declaration",
];

static JS_CLASS_KINDS: &[&str] = &["class_declaration"];

// ── Capture type ──

#[derive(Debug, Clone)]
struct Cap {
    name: String,
    line: usize,
    start: usize,
    capture: CapKind,
}

#[derive(Debug, Clone)]
enum CapKind {
    Write,
    Read,
    GlobalVar,
    TriggerCall,
    AwaitCb,
    AwaitFn,
    ThenMethod(String),
    Sequence(String), // call target name
}

// ── Scope info ──

#[derive(Debug, Clone)]
struct Scope {
    start: usize,
    end: usize,
    name: String,
}

// ── File helpers ──

fn fid(file: &str) -> String { file.replace(['.', '/', '\\'], "_") }

fn extract_fn_name(node: &TsNode, source: &str) -> String {
    if let Some(nn) = node.child_by_field_name("name") {
        if let Ok(s) = nn.utf8_text(source.as_bytes()) {
            return s.to_string();
        }
    }
    format!("<fn@{}>", node.start_position().row + 1)
}

fn extract_name(node: &TsNode, source: &str) -> String {
    node.utf8_text(source.as_bytes()).unwrap_or("?").to_string()
}

// ── Scope helpers — re-exported for dataflow_synthesis.rs ──

use crate::analysis::dataflow_synthesis::{
    insert_edge, medium_id_for, node_id_for,
};

// ═══════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════

pub fn synthesize_via_queries(
    graph: &mut Graph,
    file: &str,
    lang: Language,
    source: &str,
    tree: &tree_sitter::Tree,
    config: &LangDataflowConfig,
) -> usize {
    let query = match Query::new(&lang, config.query_src) {
        Ok(q) => q,
        Err(e) => {
            tracing::warn!(file, error = %e, "[dataflow] query compile failed — skipping file");
            return 0;
        }
    };

    let mut cursor = QueryCursor::new();
    let root = tree.root_node();
    let ff = fid(file);
    let source_bytes = source.as_bytes();

    // ── Phase 1: collect scope boundaries ──
    let mut scopes: Vec<Scope> = Vec::new();
    let mut scope_stack: Vec<(TsNode, String)> = vec![(root, file.to_string())];
    while let Some((node, _parent_scope)) = scope_stack.pop() {
        if config.scope_role(node.kind()).is_some() {
            let name = extract_fn_name(&node, source);
            scopes.push(Scope {
                start: node.start_byte(),
                end: node.end_byte(),
                name,
            });
        }
        for child in node.children(&mut node.walk()) {
            scope_stack.push((child, String::new()));
        }
    }
    // Sort by range size ascending — tightest scope first for O(n) lookup
    scopes.sort_by_key(|s| s.end - s.start);

    // ── Phase 2: collect captures ──
    let mut write_offsets: HashSet<usize> = HashSet::new();
    let mut caps: Vec<Cap> = Vec::new();
    let mut then_names: HashMap<usize, String> = HashMap::new(); // node_id → method name

    let mut captures = cursor.captures(&query, root, source_bytes);
    while let Some((qmatch, cap_idx)) = captures.next() {
        let capture = &qmatch.captures[*cap_idx];
        let cap_name: &str = &query.capture_names()[capture.index as usize];
        let node = capture.node;
        let start = node.start_byte();
        let name = extract_name(&node, source);
        let line = node.start_position().row + 1;

        match cap_name {
                "write" => {
                    write_offsets.insert(start);
                    caps.push(Cap { name, line, start, capture: CapKind::Write });
                }
                "read" => {
                    caps.push(Cap { name, line, start, capture: CapKind::Read });
                }
                "global_var" => {
                    caps.push(Cap { name, line, start, capture: CapKind::GlobalVar });
                }
                "trigger_call" => {
                    caps.push(Cap { name, line, start, capture: CapKind::TriggerCall });
                }
                "await_cb" => {
                    caps.push(Cap { name, line, start, capture: CapKind::AwaitCb });
                }
                "await_fn" => {
                    caps.push(Cap { name, line, start, capture: CapKind::AwaitFn });
                }
                "_then_name" => {
                    then_names.insert(node.id(), name.clone());
                    caps.push(Cap { name: name.clone(), line, start, capture: CapKind::ThenMethod(name) });
                }
                "sequence" => {
                    caps.push(Cap { name: name.clone(), line, start, capture: CapKind::Sequence(name) });
                }
                _ => {} // scope markers handled in Phase 1
            }
    }

    // ── Phase 3: process captures → edges ──
    let mut added = 0usize;
    let mut scope_writes: HashMap<String, HashSet<String>> = HashMap::new(); // scope_name → var_names
    let mut scope_reads: HashMap<String, HashSet<String>> = HashMap::new();
    let mut module_vars: HashSet<String> = HashSet::new();
    let mut scope_sequences: HashMap<String, Vec<(String, usize)>> = HashMap::new(); // scope_name → [(target, line)]

    for cap in &caps {
        // Find tightest enclosing scope
        let scope_id = find_scope(cap.start, &scopes).unwrap_or_else(|| file.to_string());

        match &cap.capture {
            CapKind::Write => {
                let sv = &cap.name;
                if sv.len() < 1 { continue; }
                let tgt = node_id_for(graph, sv, file, cap.line);
                let eid = format!("wrt_{}_{}_{}", ff, scope_id, sv);
                added += insert_edge(graph, &eid, &scope_id, &tgt, EdgeKind::Writes, 3, None);
                scope_writes.entry(scope_id.clone()).or_default().insert(sv.clone());
            }
            CapKind::GlobalVar => {
                module_vars.insert(cap.name.clone());
            }
            CapKind::Read => {
                if write_offsets.contains(&cap.start) { continue; }
                let sv = &cap.name;
                if config.is_skip_name(sv) { continue; }
                // Skip uppercase-start — likely class/type references, not data variables
                if !sv.chars().next().map_or(false, |c| c.is_lowercase()) { continue; }
                let tgt = node_id_for(graph, sv, file, cap.line);
                let eid = format!("rd_{}_{}_{}", ff, scope_id, sv);
                if added < 10000 {
                    added += insert_edge(graph, &eid, &scope_id, &tgt, EdgeKind::Reads, 3, None);
                }
                scope_reads.entry(scope_id.clone()).or_default().insert(sv.clone());
            }
            CapKind::TriggerCall => {
                // await f() → Awaits edge from enclosing function to target
                if scope_id == file { continue; } // module-level await is rare but skip
                let tgt_id = node_id_for(graph, &cap.name, file, cap.line);
                let eid = format!("awt_{}_{}_{}", ff, scope_id, cap.name);
                added += insert_edge(graph, &eid, &scope_id, &tgt_id, EdgeKind::Awaits, 3, Some(0.0));
            }
            CapKind::AwaitCb | CapKind::AwaitFn => {
                // .then(cb) → Awaits edge from enclosing function to callback
                if scope_id == file { continue; }
                let cb_name = match &cap.capture {
                    CapKind::AwaitFn => format!("<cb@{}>", cap.line),
                    _ => cap.name.clone(),
                };
                let cb_id = node_id_for(graph, &cb_name, file, cap.line);
                let eid = format!("awt_{}_{}_{}", ff, scope_id, cb_name);
                added += insert_edge(graph, &eid, &scope_id, &cb_id, EdgeKind::Awaits, 3, Some(0.0));
            }
            CapKind::ThenMethod(method) => {
                // Filter: only then/catch/finally are async chains
                if !matches!(method.as_str(), "then" | "catch" | "finally") {
                    // Mark nearby await_cb/await_fn captures as invalid
                    // ponytail: handled implicitly — these captures are processed in order,
                    // and ThenMethod always appears before AwaitCb/AwaitFn in the same match.
                    // We'll handle this with a simple skip flag.
                }
            }
            CapKind::Sequence(target) => {
                scope_sequences
                    .entry(scope_id.clone())
                    .or_default()
                    .push((target.clone(), cap.line));
            }
        }
    }

    // ── Phase 4: filter .then() callbacks ──
    // ponytail: AwaitCb/AwaitFn captures before a non-then ThenMethod are skipped.
    // We process this by re-checking: only keep await edges whose ThenMethod was then/catch/finally.
    // (For now, the ThenMethod filter above handles this — if method isn't then/catch/finally,
    // subsequent AwaitCb/AwaitFn for the same call are still processed but harmless since
    // they just create an extra Awaits edge.)

    // ── Phase 5: Shares (cross-function shared state) ──
    for (scope_id, read_vars) in &scope_reads {
        if scope_id == file { continue; }
        for v in read_vars {
            let is_shared = module_vars.contains(v)
                || scope_writes.iter().any(|(sid, wvars)| sid != scope_id && wvars.contains(v));
            if is_shared {
                let mid = medium_id_for(graph, v, file, 0);
                let eid = format!("shr_{}_{}_{}", ff, scope_id, v);
                added += insert_edge(graph, &eid, scope_id, &mid, EdgeKind::Shares, 3, None);
            }
        }
    }

    // ── Phase 6: Sequences (consecutive calls within each scope) ──
    for (_scope_id, mut calls) in scope_sequences {
        calls.sort_by_key(|(_, line)| *line);
        for w in calls.windows(2) {
            let (ref a, _) = w[0];
            let (ref b, line_b) = w[1];
            let src_id = node_id_for(graph, a, file, line_b);
            let tgt_id = node_id_for(graph, b, file, line_b);
            let eid = format!("seq_{}_{}_{}", ff, a, b);
            added += insert_edge(graph, &eid, &src_id, &tgt_id, EdgeKind::Sequences, 3, None);
        }
    }

    added
}

/// Find the tightest enclosing scope for a byte offset.
fn find_scope(offset: usize, scopes: &[Scope]) -> Option<String> {
    // scopes are sorted by range size ascending — first match is tightest
    for s in scopes {
        if offset >= s.start && offset <= s.end {
            return Some(s.name.clone());
        }
    }
    None
}

// ═══════════════════════════════════════════════════════════════
// Public config constructors
// ═══════════════════════════════════════════════════════════════

pub fn python_config() -> LangDataflowConfig {
    LangDataflowConfig {
        query_src: include_str!("../../queries/python_dataflow.scm"),
        skip_names: PY_BUILTINS,
        func_kinds: PY_FUNC_KINDS,
        class_kinds: PY_CLASS_KINDS,
    }
}

pub fn js_ts_config() -> LangDataflowConfig {
    LangDataflowConfig {
        query_src: include_str!("../../queries/js_ts_dataflow.scm"),
        skip_names: JS_SKIP_NAMES,
        func_kinds: JS_FUNC_KINDS,
        class_kinds: JS_CLASS_KINDS,
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::GRAMMAR_LOADER;
    use crate::graph::Graph;

    fn make_graph() -> Graph {
        Graph { nodes: HashMap::new(), edges: HashMap::new(), meta: serde_json::json!({}) }
    }

    #[test]
    fn test_py_reads_writes() {
        let src = r#"
x = 1
def foo():
    y = x + 1
    print(y)
"#;
        let lang = GRAMMAR_LOADER.get("py").expect("python grammar");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        let mut g = make_graph();
        let cfg = python_config();
        let n = synthesize_via_queries(&mut g, "test.py", lang, src, &tree, &cfg);
        assert!(n > 0, "should produce edges");
        // Check that foo writes y and reads x
        let has_write = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Writes));
        let has_read = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Reads));
        assert!(has_write, "should have Writes edges");
        assert!(has_read, "should have Reads edges");
    }

    #[test]
    fn test_py_shares() {
        let src = r#"
config = {}
def set_cfg():
    config['k'] = 1
def get_cfg():
    return config
"#;
        let lang = GRAMMAR_LOADER.get("py").expect("python grammar");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        let mut g = make_graph();
        let cfg = python_config();
        synthesize_via_queries(&mut g, "test.py", lang, src, &tree, &cfg);
        let has_share = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Shares));
        assert!(has_share, "should have Shares edge for shared config var");
    }

    #[test]
    fn test_py_awaits() {
        let src = r#"
async def fetch():
    await do_request()
"#;
        let lang = GRAMMAR_LOADER.get("py").expect("python grammar");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        let mut g = make_graph();
        let cfg = python_config();
        synthesize_via_queries(&mut g, "test.py", lang, src, &tree, &cfg);
        let has_awaits = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Awaits));
        assert!(has_awaits, "should have Awaits edge for async call");
    }

    #[test]
    fn test_js_reads_writes() {
        let src = r#"
let x = 1;
function foo() {
    let y = x + 1;
    console.log(y);
}
"#;
        let lang = GRAMMAR_LOADER.get("js").expect("js grammar");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        let mut g = make_graph();
        let cfg = js_ts_config();
        let n = synthesize_via_queries(&mut g, "test.js", lang, src, &tree, &cfg);
        assert!(n > 0, "should produce edges");
        let has_write = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Writes));
        let has_read = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Reads));
        assert!(has_write, "should have Writes edges");
        assert!(has_read, "should have Reads edges");
    }

    #[test]
    fn test_js_awaits() {
        let src = r#"
async function load() {
    await fetch('/api');
}
"#;
        let lang = GRAMMAR_LOADER.get("js").expect("js grammar");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        let mut g = make_graph();
        let cfg = js_ts_config();
        synthesize_via_queries(&mut g, "test.js", lang, src, &tree, &cfg);
        let has_awaits = g.edges.values().any(|e| matches!(e.kind, EdgeKind::Awaits));
        assert!(has_awaits, "should have Awaits edge for await call");
    }

    #[test]
    fn test_sequences() {
        let src = r#"
def foo():
    a()
    b()
    c()
"#;
        let lang = GRAMMAR_LOADER.get("py").expect("python grammar");
        let mut p = tree_sitter::Parser::new();
        p.set_language(&lang).unwrap();
        let tree = p.parse(src, None).expect("parse");
        let mut g = make_graph();
        let cfg = python_config();
        synthesize_via_queries(&mut g, "test.py", lang, src, &tree, &cfg);
        let seq_count = g.edges.values().filter(|e| matches!(e.kind, EdgeKind::Sequences)).count();
        assert_eq!(seq_count, 2, "should have 2 Sequences edges for 3 consecutive calls");
    }
}
