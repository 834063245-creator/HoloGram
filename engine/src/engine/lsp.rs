// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LSP Type-Aware Call Resolution — extracted from engine/mod.rs.
// Language-specific adapters resolve polymorphic calls at graph-build time.

use std::collections::HashMap as StHashMap;
use std::path::Path;

use tracing::info;

use crate::adapter::c_lsp::run_c_lsp;
use crate::adapter::cs_lsp::run_cs_lsp;
use crate::adapter::go_lsp::run_go_lsp;
use crate::adapter::java_lsp::run_java_lsp;
use crate::adapter::kotlin_lsp::run_kotlin_lsp;
use crate::adapter::php_lsp::run_php_lsp;
use crate::adapter::python_lsp::run_py_lsp;
use crate::adapter::ts_lsp::run_ts_lsp;
use crate::adapter::type_registry::TypeRegistry;
use crate::engine::GRAMMAR_LOADER;
use crate::graph::{EdgeKind, Graph};

/// Map file extension to tree-sitter Language for LSP re-parsing.
/// ponytail: re-parse from source instead of caching CSTs — saves 3+ GB on large projects.
fn language_for_lsp(ext: &str) -> Option<tree_sitter::Language> {
    GRAMMAR_LOADER.get(ext)
}

// Thread-local LSP parser cache — reuses parser across files of the same language.
// ponytail: avoids Parser::new() + set_language() overhead for 64K files.
// Each rayon worker thread gets its own cached parser via thread_local.
thread_local! {
    static TL_LSP_PARSER: std::cell::RefCell<Option<(tree_sitter::Parser, String)>> = std::cell::RefCell::new(None);
}

/// Re-parse source to a tree-sitter Tree. Returns None if language not supported or parse fails.
/// Public for on-demand LSP tool usage.
pub fn reparse_source_lsp(source: &str, ext: &str) -> Option<tree_sitter::Tree> {
    reparse_for_lsp(source, ext)
}

/// Internal re-parse — used by resolve_calls_lsp and by tests.
pub(crate) fn reparse_for_lsp(source: &str, ext: &str) -> Option<tree_sitter::Tree> {
    TL_LSP_PARSER.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let reuse = borrow.as_ref().map_or(false, |(_, cached)| cached == ext);
        if !reuse {
            let lang = language_for_lsp(ext)?; // ponytail: inside cache check — RwLock once per ext per thread
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(&lang).ok()?;
            *borrow = Some((parser, ext.to_string()));
        }
        let (ref mut parser, _) = borrow.as_mut().unwrap();
        parser.parse(source, None)
    })
}

/// Run LSP type-aware call resolution on all source files in the project.
/// Rewrites CALLS edges in the graph with resolved target QNs.
#[allow(dead_code)]
pub(super) fn resolve_calls_lsp(
    graph: &mut Graph,
    parse_cache: &std::collections::HashMap<String, (String, Option<tree_sitter::Tree>)>,
    discovered_files: &[std::path::PathBuf],
    _project_root: &Path,
) -> usize {
    // Build TypeRegistry from graph nodes (Tier 2: once for whole project)
    let registry = TypeRegistry::from_graph(graph);
    info!("[engine] LSP registry built");

    // Run LSP per-file. Parallel for large projects (≥2000 files), sequential for small.
    // TypeRegistry and parse_cache are read-only; each file's AST walk is independent.
    // ponytail: rayon threshold=2000. Below this, thread overhead > parallelism gain.
    let per_file_lsp = |file_path: &std::path::PathBuf, perf: &std::sync::Mutex<crate::adapter::ts_lsp::TsLspPerf>|
        -> Vec<(String, String)>
    {
        let path_str = file_path.to_string_lossy().replace('\\', "/");
        let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();
        if !matches!(
            ext.as_str(),
            "py" | "pyi" | "go" | "java" | "cs" | "ts" | "tsx" | "js" | "jsx"
            | "mjs" | "cjs" | "mts" | "cts" | "c" | "h" | "cpp" | "hpp" | "cc"
            | "hh" | "cxx" | "hxx" | "php" | "kt" | "kts"
        ) {
            return vec![];
        }
        let abs_path = crate::path_utils::normalize_path(&path_str);
        let Some((source, _)) = parse_cache.get(&abs_path) else {
            return vec![];
        };
        // ponytail: re-parse for LSP — CST not cached (saves 3+ GB on 64K-file projects)
        let Some(tree) = reparse_for_lsp(source, &ext) else {
            return vec![];
        };
        let module_qn = abs_path
            .trim_end_matches(".py").trim_end_matches(".pyi")
            .replace(['/', '\\'], ".");
        let calls = match ext.as_str() {
            "py" | "pyi" => run_py_lsp(source, &tree, &module_qn, &registry),
            "go" => run_go_lsp(source, &tree, &module_qn, &registry),
            "java" => run_java_lsp(source, &tree, &module_qn, &registry),
            "cs" => run_cs_lsp(source, &tree, &module_qn, &registry),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" => {
                let (calls, p) = run_ts_lsp(source, &tree, &module_qn, &registry);
                if let Ok(mut total) = perf.lock() {
                    total.nodes += p.nodes; total.emit += p.emit;
                    total.dedup_scan += p.dedup_scan; total.dedup_hit += p.dedup_hit;
                    total.eval_member += p.eval_member; total.scope_push += p.scope_push;
                    total.cache_hits += p.cache_hits; total.calls_out += p.calls_out;
                }
                calls
            }
            "c" | "h" => run_c_lsp(source, &tree, &module_qn, &registry),
            "cpp" | "hpp" | "cc" | "hh" | "cxx" | "hxx" => {
                run_c_lsp(source, &tree, &module_qn, &registry)
            }
            "php" => run_php_lsp(source, &tree, &module_qn, &registry),
            "kt" | "kts" => run_kotlin_lsp(source, &tree, &module_qn, &registry),
            _ => return vec![],
        };
        calls.into_iter().map(|rc| (rc.caller_qn, rc.callee_qn)).collect()
    };

    let lsp_perf_total = std::sync::Mutex::new(crate::adapter::ts_lsp::TsLspPerf { nodes:0,emit:0,dedup_scan:0,dedup_hit:0,eval_member:0,scope_push:0,cache_hits:0,calls_out:0 });
    let all_resolved: Vec<(String, String)> = if discovered_files.len() < 2000 {
        let mut results = Vec::new();
        for file_path in discovered_files {
            results.extend(per_file_lsp(file_path, &lsp_perf_total));
        }
        results
    } else {
        use rayon::prelude::*;
        discovered_files
            .par_iter()
            .with_min_len(256)
            .flat_map(|fp| per_file_lsp(fp, &lsp_perf_total))
            .collect()
    };

    // Build caller edge index for O(1) lookup during rewriting.
    let mut caller_index: StHashMap<String, Vec<(String, String)>> = StHashMap::new();
    for (eid, edge) in &graph.edges {
        if edge.kind != EdgeKind::Calls {
            continue;
        }
        let target_short = edge.target.rsplit('.').next().unwrap_or(&edge.target).to_string();
        caller_index
            .entry(edge.source.clone())
            .or_default()
            .push((eid.clone(), target_short));
    }

    // Rewrite edges in the main-thread graph.
    let mut total_resolved = 0usize;
    for (caller_qn, callee_qn) in &all_resolved {
        let callee_short = callee_qn.rsplit('.').next().unwrap_or(callee_qn);
        let Some(candidates) = caller_index.get(caller_qn) else {
            continue;
        };
        for (eid, short_name) in candidates {
            if short_name != callee_short {
                continue;
            }
            if let Some(edge) = graph.edges.get_mut(eid) {
                edge.target = callee_qn.clone();
                edge.lsp_resolved = true;
                total_resolved += 1;
                break;
            }
        }
    }

    let lsp_perf_total = lsp_perf_total.into_inner().unwrap();
    eprintln!("[engine] LSP perf TOTAL: nodes={:.1}M emit={:.1}K dedup_scan={:.1}M dedup_hit={:.1}K eval_member={:.1}K scope_push={:.1}K cache_hits={:.1}K calls_out={:.1}K",
        lsp_perf_total.nodes as f64 / 1_000_000.0,
        lsp_perf_total.emit as f64 / 1_000.0,
        lsp_perf_total.dedup_scan as f64 / 1_000_000.0,
        lsp_perf_total.dedup_hit as f64 / 1_000.0,
        lsp_perf_total.eval_member as f64 / 1_000.0,
        lsp_perf_total.scope_push as f64 / 1_000.0,
        lsp_perf_total.cache_hits as f64 / 1_000.0,
        lsp_perf_total.calls_out as f64 / 1_000.0);

    total_resolved
}
