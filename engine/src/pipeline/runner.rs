use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use tracing::info;

use crate::graph::merge::GraphMerger;
use crate::graph::Graph;
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

    // Step 2: Parallel parse
    let parser = ParallelParser::new();
    let file_results = parser.parse_files(&files);

    // Step 3: Merge with incremental index (O(n) per file, not O(n²))
    let mut merger = GraphMerger::new();

    // Build parse cache while merging (take ownership of source + tree in one pass)
    let files_parsed = file_results.len();
    let mut parse_cache: HashMap<String, (String, Option<tree_sitter::Tree>)> = HashMap::with_capacity(files_parsed);

    for result in file_results.into_iter() {
        let file_graph = build_file_graph(&result);
        merger.merge(file_graph);

        // Cache source + tree for synthesis passes (Steps 4-6).
        // Use absolute path (normalized) — synthesis functions look up by abs path.
        let abs_path = result.path.to_string_lossy().replace('\\', "/");
        parse_cache.insert(abs_path, (result.source, result.tree));
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
