// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Dataflow synthesis — produces Reads/Writes/Shares/Triggers/Awaits/Sequences edges
//! from tree-sitter AST data.

use std::collections::HashMap;
use std::path::Path;

use crate::graph::Graph;

/// Parsed source held in the pipeline parse cache.
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// Dataflow synthesis is on-demand via `query_file_dataflow()` in
/// dataflow_engine.rs. The pipeline no longer precomputes dataflow edges
/// during graph construction — Agent tools call the query engine directly
/// when tracing specific variables or functions.
///
/// This function exists for API compatibility; it always returns 0.
pub fn synthesize_dataflow_edges(
    _graph: &mut Graph,
    _project_root: &Path,
    _parse_cache: &ParseCache,
    _discovered_files: &[std::path::PathBuf],
) -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_noop() {
        let mut g = Graph::new();
        assert_eq!(synthesize_dataflow_edges(&mut g, Path::new(""), &Default::default(), &[]), 0);
    }
}
