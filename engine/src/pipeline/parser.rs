// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use rayon::prelude::*;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use tracing::info;

use crate::adapter::registry::AdapterRegistry;
use crate::graph::{Edge, Node};

/// Parse result for a single file.
pub struct FileData {
    pub path: PathBuf,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub source_len: usize,
    /// Raw source text — carried forward for synthesis passes (Steps 4-6)
    /// so they don't re-read from disk.
    pub source: String,
    /// Parsed tree-sitter tree — carried forward for synthesis passes.
    /// Steps 4-6 walk this tree instead of re-parsing.
    pub tree: Option<tree_sitter::Tree>,
}

/// Parallel file parser.
/// Discovers files, dispatches to language adapters, collects results.
pub struct ParallelParser {
    registry: AdapterRegistry,
}

impl ParallelParser {
    pub fn new() -> Self {
        Self {
            registry: AdapterRegistry::new(),
        }
    }

    /// Parse a batch of files in parallel using rayon.
    /// Returns file-level results. Caller merges them via GraphMerger.
    pub fn parse_files(&self, files: &[PathBuf]) -> Vec<FileData> {
        let start = Instant::now();

        let results: Vec<FileData> = files
            .par_iter()
            .filter_map(|path| self.parse_one(path))
            .collect();

        let elapsed = start.elapsed();
        let total_lines: usize = results.iter().map(|r| r.source_len).sum();
        info!(
            "[parser] {} files, {} lines in {:.2}s ({:.0} files/s)",
            results.len(),
            total_lines,
            elapsed.as_secs_f64(),
            results.len() as f64 / elapsed.as_secs_f64().max(0.001)
        );

        results
    }

    pub fn parse_one(&self, path: &PathBuf) -> Option<FileData> {
        // ponytail: skip oversized files — typically vendored/generated blobs
        // (sqlite3.c = 9.3 MB, auto-generated parser.c files = 0.5-1 MB).
        // tree-sitter parse is O(file_size), generic_walk is O(AST_nodes).
        // 512 KB catches all known offenders; hand-written source is never this large.
        const MAX_FILE_SIZE: u64 = 512 * 1024;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > MAX_FILE_SIZE {
                tracing::warn!(path = %path.display(), size_bytes = meta.len(), "[parser] skipping oversized file");
                return None;
            }
        }

        let ext = path.extension().and_then(|e| e.to_str())?;
        let adapter = self.registry.get(ext);
        if adapter.is_none() {
            tracing::warn!(ext, path = %path.display(), "[parser] no adapter for extension, skipping file");
            return None;
        }
        let adapter = adapter.unwrap();

        let source = fs::read_to_string(path).ok()?;
        let source_len = source.lines().count();

        let (mut nodes, edges, tree) = adapter.analyze(
            &path.to_string_lossy(),
            &source,
        );

        // Tag nodes with file location
        let location = path.to_string_lossy().to_string();
        for node in &mut nodes {
            node.location = Some(location.clone());
        }

        Some(FileData {
            path: path.clone(),
            nodes,
            edges,
            source_len,
            source,
            tree,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_parse_python_files() {
        let tmp = std::env::temp_dir().join("hologram_test_parse");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        fs::write(tmp.join("a.py"), "def foo(): pass\nclass Bar: pass\n").unwrap();
        fs::write(tmp.join("b.py"), "x = 1\n").unwrap();

        let files = vec![tmp.join("a.py"), tmp.join("b.py")];
        let parser = ParallelParser::new();
        let results = parser.parse_files(&files);

        assert_eq!(results.len(), 2);
        // a.py should have 2 nodes (foo, Bar)
        let a = results.iter().find(|r| r.path.ends_with("a.py")).unwrap();
        assert!(a.nodes.len() >= 1, "should extract at least 1 symbol from a.py");

        let _ = fs::remove_dir_all(&tmp);
    }
}
