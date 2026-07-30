// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 迁移工具：JSON → SQLite 迁移。
// 实际的 timeline.db 合并在 SqliteDb::open() → migrate_timeline() 中处理。
// 本模块提供 JSON → MemoryIndex → SQLite 的流水线，用于首次初始化。

use std::path::Path;

use tracing::info;

use crate::graph::Graph;
use crate::storage::memory::MemoryIndex;
use crate::storage::sqlite::SqliteDb;

/// 尝试从 JSON 加载图并持久化到 SQLite。
/// 成功返回 MemoryIndex，失败返回错误字符串。
pub fn migrate_json_to_sqlite(json_path: &Path, db: &SqliteDb) -> Result<MemoryIndex, String> {
    let path_str = json_path.to_string_lossy();
    info!("[migration] loading JSON: {}", path_str);
    let graph = Graph::from_json_file(&path_str)
        .map_err(|e| format!("JSON parse error: {}", e))?;
    let idx = MemoryIndex::from_existing_graph(graph.nodes, graph.edges);
    info!(
        "[migration] JSON parsed: {} nodes, {} edges",
        idx.node_count(),
        idx.edge_count()
    );
    idx.to_sqlite(db)?;
    info!("[migration] JSON → SQLite done");
    Ok(idx)
}
