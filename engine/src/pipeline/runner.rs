// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use rayon::prelude::*;
use tracing::info;

use crate::graph::merge::GraphMerger;
use crate::graph::Graph;
use crate::path_utils::normalize_path;
use crate::engine::GRAMMAR_LOADER;
use crate::pipeline::discovery::discover_files;
use crate::pipeline::parser::{FileData, ParallelParser};

/// Analysis pipeline result.
pub struct PipelineResult {
    pub graph: Graph,
    pub files_discovered: usize,
    pub files_parsed: usize,
    pub files_failed: usize,
    pub nodes_total: usize,
    pub edges_total: usize,
    pub elapsed_secs: f64,
    /// Parse cache: file_path → (source_code, parsed_tree).
    /// Carried forward so synthesis passes (Steps 4-6) can re-walk the same
    /// ASTs without re-reading + re-parsing files from disk.
    pub parse_cache: HashMap<String, (String, Option<tree_sitter::Tree>)>,
    /// Discovered source files (absolute paths).
    /// Carried forward so synthesis passes can iterate this list instead of
    /// re-walking the entire project directory tree (3× walkdir eliminated).
    pub discovered_files: Vec<std::path::PathBuf>,
}

/// Run the full analysis pipeline on a project directory.
/// 1. Discover Python files
/// 2. Parse in parallel with rayon
/// 3. Merge into single graph (incremental index)
/// 4. Build parse cache for downstream synthesis
pub fn analyze_project(root: &Path) -> PipelineResult {
    let start = Instant::now();

    // Step 1: Discovery
    let exts: Vec<String> = GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    let files = discover_files(root, &ext_strs);
    info!("[pipeline] discovered {} source files", files.len());

    // Step 2: Batched parallel parse + serial merge.
    // ponytail: v1 collected all parses into Vec (memory explosion: 4.4 GB for 64K files).
    // v2 streamed through par_iter+filter_map+for_each with merger.lock() (mutex contention
    // → superlinear slowdown). v3 batches: parse N files in parallel, merge serially,
    // drop batch memory, repeat. No locks, bounded memory, linear merge.
    const BATCH: usize = 200;
    let parser = ParallelParser::new();
    let file_count = files.len();
    let parse_start = std::time::Instant::now();

    eprintln!(
        "[pipeline] parsing {} files in batches of {} with {} rayon threads…",
        file_count, BATCH, rayon::current_num_threads()
    );

    let mut merger = GraphMerger::with_capacity(file_count * 40, file_count * 150);
    let mut parse_cache = HashMap::with_capacity(file_count);
    let mut files_parsed = 0usize;
    let mut files_failed = 0usize;

    for batch in files.chunks(BATCH) {
        // ── Parse batch in parallel (no locks) ──
        let t0 = Instant::now();
        let batch_results: Vec<(std::path::PathBuf, Option<FileData>)> = batch
            .par_iter()
            .map(|path| (path.clone(), parser.parse_one(path)))
            .collect();
        let parse_ms = t0.elapsed().as_millis();

        // ── Merge batch serially (single thread, no lock) ──
        let t1 = Instant::now();
        let mut batch_trees: Vec<tree_sitter::Tree> = Vec::with_capacity(BATCH);
        for (path, result) in batch_results {
            let result = match result {
                Some(r) => r,
                None => {
                    files_failed += 1;
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("?");
                    tracing::warn!(ext, path = %path.display(), "[pipeline] parse failed — no adapter, I/O error, or unsupported language");
                    continue;
                }
            };
            files_parsed += 1;
            merger.merge_slices(&result.nodes, &result.edges);
            let abs_path = normalize_path(&result.path.to_string_lossy());
            parse_cache.insert(abs_path, (result.source, None));
            // ponytail: collect CST trees per-batch, drop on background thread.
            // ts_tree_delete() is O(tree.nodes) — synchronous drop of 200 large-file
            // trees blocks the merge loop for 10s+. Background drop frees memory
            // without blocking, at cost of ~2×BATCH trees in flight at worst.
            if let Some(t) = result.tree {
                batch_trees.push(t);
            }
        }
        let merge_ms = t1.elapsed().as_millis();
        // batch_results dropped here → batch memory fully released (nodes, edges, source)

        // Drop CST trees on background thread — ts_tree_delete is O(nodes) and
        // can take 100-500ms per large file. This runs while next batch parses.
        if !batch_trees.is_empty() {
            std::thread::spawn(move || drop(batch_trees));
        }

        eprintln!(
            "[pipeline] batch {}/{} files — parse {}ms, merge {}ms | total {} nodes, {} edges",
            files_parsed + files_failed, file_count,
            parse_ms, merge_ms,
            merger.node_count(), merger.graph().edge_count()
        );
    }

    let parse_elapsed = parse_start.elapsed().as_secs_f64();
    eprintln!(
        "[pipeline] parse+merge done in {:.2}s — {} parsed, {} failed, {} nodes, {} edges",
        parse_elapsed, files_parsed, files_failed, merger.node_count(), merger.graph().edge_count()
    );

    let graph = merger.into_graph();
    let nodes_total = graph.node_count();
    let edges_total = graph.edge_count();
    let elapsed = start.elapsed();

    // Health assertion: if >5% of discovered files failed, warn loudly.
    if files_failed > 0 && files_failed > file_count / 20 {
        tracing::warn!(
            "[pipeline] HEALTH: {}/{} files failed to parse ({:.1}%) — analysis may be incomplete. \
             Check logs above for [parser] warnings (missing adapters, I/O errors).",
            files_failed, file_count, files_failed as f64 / file_count as f64 * 100.0
        );
    }

    let result = PipelineResult {
        graph,
        files_discovered: file_count,
        files_parsed,
        files_failed,
        nodes_total,
        edges_total,
        elapsed_secs: elapsed.as_secs_f64(),
        parse_cache,
        discovered_files: files,
    };

    info!(
        "[pipeline] done: {}/{} files parsed ({} failed) → {} nodes, {} edges in {:.2}s",
        result.files_parsed, result.files_discovered, result.files_failed,
        result.nodes_total, result.edges_total, result.elapsed_secs
    );

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_analyze_small_project() {
        let tmp = std::env::temp_dir().join("hologram_test_project");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("app")).unwrap();

        fs::write(tmp.join("app").join("models.py"),
            "from django.db import models\n\nclass User(models.Model):\n    name = models.CharField()\n"
        ).unwrap();
        fs::write(tmp.join("app").join("views.py"),
            "from .models import User\n\ndef index():\n    return User.objects.all()\n"
        ).unwrap();

        let result = analyze_project(&tmp);
        assert!(result.files_parsed >= 2);
        assert!(result.nodes_total >= 2, "should find User class + index fn, got {}", result.nodes_total);
        assert!(result.elapsed_secs < 10.0, "small project should parse in <10s, took {:.2}s", result.elapsed_secs);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_empty_project() {
        let tmp = std::env::temp_dir().join("hologram_test_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let result = analyze_project(&tmp);
        assert_eq!(result.files_parsed, 0);
        assert_eq!(result.nodes_total, 0);
        assert_eq!(result.edges_total, 0);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_rust_project() {
        let tmp = std::env::temp_dir().join("hologram_test_rust");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src")).unwrap();

        fs::write(tmp.join("src").join("main.rs"),
            "fn main() {\n    println!(\"hello\");\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n"
        ).unwrap();

        let result = analyze_project(&tmp);
        assert!(result.files_parsed >= 1);
        // Rust tree-sitter should find at least main + add
        assert!(result.nodes_total >= 2, "should find main + add in Rust file");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_go_project() {
        let tmp = std::env::temp_dir().join("hologram_test_go");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        fs::write(tmp.join("main.go"),
            "package main\n\nimport \"fmt\"\n\nfunc main() {\n    fmt.Println(\"hello\")\n}\n"
        ).unwrap();

        let result = analyze_project(&tmp);
        assert!(result.files_parsed >= 1);
        assert!(result.nodes_total >= 1);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_nested_directories() {
        let tmp = std::env::temp_dir().join("hologram_test_nested");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("src").join("utils")).unwrap();

        fs::write(tmp.join("src").join("main.py"), "def main(): pass\n").unwrap();
        fs::write(tmp.join("src").join("utils").join("helpers.py"), "def helper(): pass\n").unwrap();

        let result = analyze_project(&tmp);
        assert_eq!(result.files_parsed, 2);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_analyze_syntax_error_tolerant() {
        let tmp = std::env::temp_dir().join("hologram_test_err");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        fs::write(tmp.join("broken.py"), "def foo(:\n    pass\n").unwrap();
        fs::write(tmp.join("ok.py"), "def bar():\n    pass\n").unwrap();

        let result = analyze_project(&tmp);
        // Should not crash; should parse at least the valid file
        assert!(result.files_parsed >= 1);

        let _ = fs::remove_dir_all(&tmp);
    }
}
