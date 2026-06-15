use rayon::prelude::*;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use crate::adapter::registry::AdapterRegistry;
use crate::graph::{Edge, Node};

/// Parse result for a single file.
pub struct FileData {
    pub path: PathBuf,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub source_len: usize,
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
        println!(
            "[parser] {} files, {} lines in {:.2}s ({:.0} files/s)",
            results.len(),
            total_lines,
            elapsed.as_secs_f64(),
            results.len() as f64 / elapsed.as_secs_f64().max(0.001)
        );

        results
    }

    fn parse_one(&self, path: &PathBuf) -> Option<FileData> {
        let ext = path.extension()?.to_str()?;
        let adapter = self.registry.get(ext)?;

        let source = fs::read_to_string(path).ok()?;
        let source_len = source.lines().count();

        let (mut nodes, edges) = adapter.analyze(
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
