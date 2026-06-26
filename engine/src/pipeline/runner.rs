// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rayon::prelude::*;
use tracing::info;

use crate::graph::merge::GraphMerger;
use crate::graph::Graph;
use crate::path_utils::normalize_path;
use crate::pipeline::discovery::discover_files;
use crate::pipeline::parser::ParallelParser;

/// Analysis pipeline result.
pub struct PipelineResult {
    pub graph: Graph,
    pub files_parsed: usize,
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
    let files = discover_files(root, &[
        "py","pyi","pyx","js","jsx","ts","tsx","mjs","cjs","mts","cts",
        "go","rs","java","c","h","cpp","hpp","cc","hh","cxx","hxx","rb","lua",
        "cs","swift","dart","scala","sc","hs","html","htm","css",
    ]);
    info!("[pipeline] discovered {} source files", files.len());

    // Step 2: Parallel parse + stream-merge (no intermediate Vec<FileData>).
    // ponytail: FileData Vec peaked at ~4.4 GB for 64K files (nodes + edges + source + trees).
    // Streaming through rayon par_iter + Mutex cuts peak RSS by 2-3 GB.
    let parser = ParallelParser::new();
    let file_count = files.len();
    let files_parsed = AtomicUsize::new(0);
    let merger = Mutex::new(GraphMerger::new());
    let parse_cache = Mutex::new(HashMap::with_capacity(file_count));
    let trees_to_drop = Mutex::new(Vec::with_capacity(file_count));

    files
        .par_iter()
        .filter_map(|path| parser.parse_one(path))
        .for_each(|result| {
            files_parsed.fetch_add(1, Ordering::Relaxed);
            let file_graph = build_file_graph(&result);
            merger.lock().unwrap().merge(file_graph);
            let abs_path = normalize_path(&result.path.to_string_lossy());
            parse_cache.lock().unwrap().insert(abs_path, (result.source, None)); // source only — LSP re-parses
            if let Some(tree) = result.tree {
                trees_to_drop.lock().unwrap().push(tree);
            }
        });

    let files_parsed = files_parsed.load(Ordering::Relaxed);
    let merger = merger.into_inner().unwrap();
    let parse_cache = parse_cache.into_inner().unwrap();
    let trees_to_drop = trees_to_drop.into_inner().unwrap();

    // Step 3: Drop trees on background thread — frees 2-3 GB while LSP runs concurrently.
    // Tree::drop() calls ts_tree_delete which is O(nodes) and adds ~300s
    // to Core Parse if done synchronously (64K files × 5ms avg).
    if !trees_to_drop.is_empty() {
        std::thread::spawn(move || drop(trees_to_drop));
    }

    let graph = merger.into_graph();
    let nodes_total = graph.node_count();
    let edges_total = graph.edge_count();
    let elapsed = start.elapsed();

    let result = PipelineResult {
        graph,
        files_parsed,
        nodes_total,
        edges_total,
        elapsed_secs: elapsed.as_secs_f64(),
        parse_cache,
        discovered_files: files,
    };

    info!(
        "[pipeline] done: {} files → {} nodes, {} edges in {:.2}s",
        result.files_parsed, result.nodes_total, result.edges_total, result.elapsed_secs
    );

    result
}

/// Build a temporary Graph from a single file's parse result.
fn build_file_graph(result: &crate::pipeline::parser::FileData) -> Graph {
    let mut g = Graph::new();
    for node in &result.nodes {
        g.add_node(node.clone());
    }
    for edge in &result.edges {
        g.add_edge(edge.clone());
    }
    g
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
