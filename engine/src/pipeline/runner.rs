use std::path::Path;
use std::time::Instant;

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
}

/// Run the full analysis pipeline on a project directory.
/// 1. Discover Python files
/// 2. Parse in parallel with rayon
/// 3. Merge into single graph (incremental index)
pub fn analyze_project(root: &Path) -> PipelineResult {
    let start = Instant::now();

    // Step 1: Discovery
    let files = discover_files(root, &["py","pyi","pyx","js","jsx","ts","tsx","mjs","cjs","mts","cts"]);
    println!("[pipeline] discovered {} Python files", files.len());

    // Step 2: Parallel parse
    let parser = ParallelParser::new();
    let file_results = parser.parse_files(&files);

    // Step 3: Merge with incremental index (O(n) per file, not O(n²))
    let mut merger = GraphMerger::new();
    let mut nodes_total = 0usize;
    let mut edges_total = 0usize;

    for result in &file_results {
        let file_graph = build_file_graph(result);
        nodes_total += file_graph.node_count();
        edges_total += file_graph.edge_count();
        merger.merge(file_graph);
    }

    let graph = merger.into_graph();
    let elapsed = start.elapsed();

    let result = PipelineResult {
        graph,
        files_parsed: file_results.len(),
        nodes_total,
        edges_total,
        elapsed_secs: elapsed.as_secs_f64(),
    };

    println!(
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
}
