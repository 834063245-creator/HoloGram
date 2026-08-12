// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use rayon::prelude::*;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use tracing::info;

use crate::adapter::registry::AdapterRegistry;
use crate::graph::{Edge, Node};

/// 单个文件的解析结果。
pub struct FileData {
    pub path: PathBuf,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub source_len: usize,
    /// 原始源码文本 — 传递给后续合成阶段（步骤 4-6），
    /// 以避免重复从磁盘读取。
    pub source: String,
    /// 解析后的 tree-sitter 树 — 传递给后续合成阶段。
    /// 步骤 4-6 遍历此树而非重新解析。
    pub tree: Option<tree_sitter::Tree>,
}

/// 并行文件解析器。
/// 发现文件，分发给语言适配器，收集结果。
pub struct ParallelParser {
    registry: AdapterRegistry,
}

impl Default for ParallelParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ParallelParser {
    pub fn new() -> Self {
        Self {
            registry: AdapterRegistry::new(),
        }
    }

    /// 使用 rayon 并行解析一批文件。
    /// 返回文件级别的结果。调用方通过 GraphMerger 合并它们。
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
        // ponytail: 跳过超大文件 — 混过 L0-L2 过滤器的第三方/生成文件。
        // tree-sitter 解析为 O(file_size)，
        // generic_walk 为 O(AST_nodes)。1 MB 已很宽裕：手写
        // 源码不会超过此大小（相当于单文件约 25,000 行）。
        const MAX_FILE_SIZE: u64 = 1_048_576; // 1 MB
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > MAX_FILE_SIZE {
                tracing::warn!(path = %path.display(), size_bytes = meta.len(), "[parser] skipping oversized file");
                return None;
            }
        }

        let ext = path.extension().and_then(|e| e.to_str())?;
        let Some(adapter) = self.registry.get(ext) else {
            tracing::warn!(ext, path = %path.display(), "[parser] no adapter for extension, skipping file");
            return None;
        };

        let source = fs::read_to_string(path).ok()?;
        let source_len = source.lines().count();

        let (mut nodes, edges, tree) = adapter.analyze(
            &path.to_string_lossy(),
            &source,
        );

        // 将 location 归一化为正斜杠格式，以便 file_index 查找匹配。
        // 适配器已设置 `file:line`；仅为缺少 location 的节点填充。
        let norm_path = path.to_string_lossy().replace('\\', "/");
        for node in &mut nodes {
            if node.location.is_none() {
                node.location = Some(norm_path.clone());
            } else {
                // 替换适配器设置的 location 中的反斜杠
                if let Some(ref loc) = node.location {
                    node.location = Some(loc.replace('\\', "/"));
                }
            }
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
        // a.py 应有 2 个节点（foo, Bar）
        let a = results.iter().find(|r| r.path.ends_with("a.py")).unwrap();
        assert!(!a.nodes.is_empty(), "should extract at least 1 symbol from a.py");

        let _ = fs::remove_dir_all(&tmp);
    }
}