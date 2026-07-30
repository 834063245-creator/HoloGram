// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

pub trait LanguageAdapter: Send + Sync {
    fn extensions(&self) -> Vec<String>;
    /// 解析源文件并提取 nodes + edges + 原始 tree-sitter tree。
    /// 返回 tree 供后续合成步骤（Steps 4-6）使用，以便
    /// 无需重新读取和重新解析即可重新遍历 AST。
    fn analyze(&self, file_path: &str, source: &str) -> (Vec<crate::graph::Node>, Vec<crate::graph::Edge>, Option<tree_sitter::Tree>);
}
