// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 数据流合成 — 从 tree-sitter AST 数据生成 Reads/Writes/Shares/Triggers/Awaits/Sequences 边

use std::collections::HashMap;
use std::path::Path;

use crate::graph::Graph;

/// 管道解析缓存中保存的已解析源码。
type ParseCache = HashMap<String, (String, Option<tree_sitter::Tree>)>;

/// 数据流合成已改为按需方式，通过 dataflow_engine.rs 中的
/// `query_file_dataflow()` 调用。管道不再在 Graph 构建期间
/// 预计算数据流边 — Agent 工具在追踪特定变量或函数时
/// 直接调用查询引擎。
///
/// 此函数为 API 兼容性而保留；始终返回 0。
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
