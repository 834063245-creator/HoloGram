// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

pub trait LanguageAdapter: Send + Sync {
    fn extensions(&self) -> Vec<String>;
    /// Parse a source file and extract nodes + edges + the raw tree-sitter tree.
    /// The tree is returned for downstream synthesis passes (Steps 4-6) so they
    /// can re-walk the AST without re-reading + re-parsing.
    fn analyze(&self, file_path: &str, source: &str) -> (Vec<crate::graph::Node>, Vec<crate::graph::Edge>, Option<tree_sitter::Tree>);
}
