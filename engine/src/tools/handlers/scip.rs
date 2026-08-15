// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::tools::{project_root, ToolResponse};

/// P1-1：导入 SCIP 索引（scip-* indexer 的 index.scip），
/// 把编译器级精确的符号引用边合并进图并落库。
pub(crate) fn handler_import_scip(args: &Value) -> ToolResponse {
    let path_str = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path_str.is_empty() {
        return ToolResponse::Degraded {
            guidance: "path is required (path to index.scip)".into(),
            fallback: "Generate an index with a scip-* indexer (e.g. scip-typescript index) and pass its index.scip path".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    let abs = if Path::new(path_str).is_absolute() {
        PathBuf::from(path_str)
    } else {
        root.join(path_str)
    };
    match crate::engine::with_engine(|eng| eng.import_scip_index(&abs)) {
        Some(Ok(stats)) => ToolResponse::Success(json!({
            "imported": abs.to_string_lossy(),
            "documents": stats.documents,
            "occurrences": stats.occurrences,
            "definitions_added": stats.definitions_added,
            "definitions_reused": stats.definitions_reused,
            "external_nodes_added": stats.external_nodes_added,
            "document_nodes_added": stats.document_nodes_added,
            "edges_added": stats.edges_added,
            "skipped_no_enclosing": stats.skipped_no_enclosing,
            "skipped_missing_target": stats.skipped_missing_target,
            "note": "SCIP 边带 provenance=scip 元数据（lsp_resolved 语义的精确解析，非合成边）；引用源近似为同文档内最近的包围定义；跳过的引用已如实计数"
        })),
        Some(Err(e)) => ToolResponse::Degraded {
            guidance: format!("import failed: {}", e),
            fallback: "Verify the path points to a valid index.scip file".into(),
            details: json!({}),
        },
        None => ToolResponse::Degraded {
            guidance: "Engine not initialized".into(),
            fallback: "Run analyze_project first".into(),
            details: json!({}),
        },
    }
}
