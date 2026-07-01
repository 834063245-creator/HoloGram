// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Dataflow synthesis — produces Reads/Writes/Shares/Triggers/Awaits/Sequences edges
//! from tree-sitter AST data.

use crate::engine::GRAMMAR_LOADER;
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

// ── Fix 1 helper: file-scoped key for node_id_for dedup ──
// Prevents cross-file name collisions from producing giant artificial SCCs.
fn scoped_key(file: &str, name: &str) -> String {
    format!("{}::{}", file, name)
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
        let is_py = file.to_lowercase().ends_with(".py");
        let ext = if is_py { "py" } else { "ts" };

        // Try parse cache first
        if let Some((source, Some(tree))) = parse_cache.get(&abs_key) {
            let lang = match GRAMMAR_LOADER.get(ext) {
                Some(l) => l,
                None => continue,
            };
            let cfg = if is_py { crate::analysis::dataflow_engine::python_config() }
                      else { crate::analysis::dataflow_engine::js_ts_config() };
            added += crate::analysis::dataflow_engine::synthesize_via_queries(
                graph, file, lang, source, tree, &cfg,
            );
        } else {
            // Fallback: read from disk, parse, run queries
            let full_path = project_root.join(file);
            if let Ok(source) = std::fs::read_to_string(&full_path) {
                let lang = match GRAMMAR_LOADER.get(ext) {
                    Some(l) => l,
                    None => continue,
                };
                let mut p = tree_sitter::Parser::new();
                if p.set_language(&lang).is_err() { continue; }
                if let Some(tree) = p.parse(&source, None) {
                    let cfg = if is_py { crate::analysis::dataflow_engine::python_config() }
                              else { crate::analysis::dataflow_engine::js_ts_config() };
                    added += crate::analysis::dataflow_engine::synthesize_via_queries(
                        graph, file, lang, &source, &tree, &cfg,
                    );
                }
            }
        }
    }

    NAME_IDX.with(|cell| *cell.borrow_mut() = None);
    added
}

// ── helpers (pub(crate) for dataflow_engine) ──

pub(crate) fn node_id_for(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
    // O(1) lookup — file-scoped key prevents cross-file name collisions
    // from producing giant artificial SCCs (e.g. db.execute in 100 files).
    let key = scoped_key(file, name);
    if let Some(id) = NAME_IDX.with(|cell| cell.borrow().as_ref().and_then(|idx| idx.get(&key).cloned())) {
        return id;
    }
    let nid = format!("df_{}_{}", file.replace(['.', '/', '\\'], "_"), name);
    let mut n = Node::new(&nid, name, NodeKind::Symbol);
    n.location = Some(format!("{}:{}", file, line));
    n.properties = serde_json::json!({"kind":"synthesized","provenance":"dataflow"});
    graph.add_node(n);
    // Register with file-scoped key so subsequent calls in the same file find it in O(1)
    NAME_IDX.with(|cell| {
        if let Some(ref mut idx) = *cell.borrow_mut() {
            idx.insert(key, nid.clone());
        }
    });
    nid
}

pub(crate) fn medium_id_for(graph: &mut Graph, name: &str, file: &str, line: usize) -> String {
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

pub(crate) fn insert_edge(g: &mut Graph, eid: &str, src: &str, tgt: &str, kind: EdgeKind, depth: u8, delay: Option<f64>) -> usize {
    if g.get_edge(eid).is_none() && src != tgt {
        g.add_edge(Edge{id:eid.into(),source:src.into(),target:tgt.into(),kind,coupling_depth:depth,cross_file:false,temporal_delay_sec:delay,lsp_resolved:false});
        1
    } else { 0 }
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
    fn test_py_awaits() {
        let mut g = Graph::new();
        let tmp = std::env::temp_dir().join("_df3");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("async_m.py"), "async def fetch():\n    data = await get_data()\n    return data\n").unwrap();
        let n = synthesize_dataflow_edges(&mut g, &tmp, &Default::default(), &[tmp.join("async_m.py")]);
        assert!(n > 0, "got {}", n);
        assert!(g.edges.values().any(|e| matches!(e.kind, EdgeKind::Awaits)), "no Awaits from Python await");
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
