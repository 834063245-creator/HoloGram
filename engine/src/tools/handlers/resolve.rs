use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use crate::engine;
use crate::tools::{get_str, get_usize, project_root};
use crate::tools::ToolResponse;

/// LSP 引用检查结果。
pub(crate) enum LspCheck {
    /// 有真实引用（应移出死代码列表）
    HasReference,
    /// 无引用（确认死代码）
    NoReference,
    /// LSP 不可用 / 无法定位（保持原判断）
    Unavailable,
}

/// 用 LSP references 验证符号是否有真实引用（非定义点）。
/// 无法定位位置 / 无 LSP 可用 / LSP 查询失败时返回 Unavailable。
pub(crate) fn lsp_has_real_reference(location: &str, name: &str) -> LspCheck {
    if location.is_empty() || name.is_empty() {
        return LspCheck::Unavailable;
    }
    // location 格式: "D:/path/to/file.ts:153"（路径 + :行号）。
    // rsplit_once(':') 只拆最后一个冒号，drive letter（D:）不受影响。
    let (path, line_str) = match location.rsplit_once(':') {
        Some(pair) => pair,
        None => return LspCheck::Unavailable,
    };
    // Node.location 行号是 1-based；LSP 需要 0-based。
    let line: u32 = match line_str.parse::<u32>() {
        Ok(l) if l > 0 => l - 1,
        _ => return LspCheck::Unavailable,
    };
    let ext = path.rsplit('.').next().unwrap_or("");
    if ext.is_empty() {
        return LspCheck::Unavailable;
    }
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return LspCheck::Unavailable,
    };
    // 定位符号名在该行的列（LSP 需要精确位置）。
    // 用行内首次出现；若该行无符号名则无法定位，跳过验证。
    let line_text = match source.lines().nth(line as usize) {
        Some(l) => l,
        None => return LspCheck::Unavailable,
    };
    let column = match line_text.find(name) {
        Some(c) => c as u32,
        None => return LspCheck::Unavailable,
    };
    // find_references 内部 includeDeclaration=false（不含定义本身），
    // 非空结果 = 有真实使用点。
    match crate::lsp_manager::LspManager::find_references(path, &source, line, column, ext) {
        Ok(locs) if !locs.is_empty() => LspCheck::HasReference,
        Ok(_) => LspCheck::NoReference,
        Err(_) => LspCheck::Unavailable,
    }
}

/// 通过原生 LSP 按需进行类型感知的调用解析。
/// LSP 服务器未安装时优雅降级。
pub(crate) fn handler_resolve_call(args: &Value) -> ToolResponse {
    let file_path = args.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let func_name = args.get("function").and_then(|v| v.as_str()).unwrap_or("");
    let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let column = args.get("column").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if file_path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "file is required".into(),
            fallback: "Provide the file path to resolve calls in".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    let abs_path = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        root.join(file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();

    // 读取源码
    let source = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) => return ToolResponse::Degraded {
            guidance: format!("cannot read file: {}", e),
            fallback: "Check the file path and permissions".into(),
            details: json!({}),
        },
    };

    // 尝试原生 LSP（如果池已预热）──
    let lsp_result = if line > 0 || column > 0 {
        crate::lsp_manager::LspManager::resolve_definition(
            &path_str, &source, line, column, &ext,
        )
        .ok()
        .map(|locs| {
            locs.iter()
                .map(|loc| json!({
                    "file": crate::lsp_manager::uri_to_path(&loc.uri),
                    "line": loc.range_start_line,
                    "column": loc.range_start_char,
                    "backend": "native_lsp",
                }))
                .collect::<Vec<_>>()
        })
    } else {
        None
    };

    if let Some(ref locs) = lsp_result {
        if !locs.is_empty() {
            return ToolResponse::Success(json!({
                "file": path_str,
                "function": func_name,
                "backend": "native_lsp",
                "definitions": locs,
                "note": "resolved via real LSP server",
            }));
        }
    }

    // ── 路径 2：无原生 LSP 可用 → 降级 ──
    ToolResponse::Degraded {
        guidance: format!("Native LSP unavailable for .{} — call resolution skipped.", ext),
        fallback: format!("Install an LSP server for .{} to enable precise call resolution. Check engine_status for details.", ext),
        details: json!({
            "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
            "note": "Handwritten adapters removed in v8. Use real LSP servers (pyright, gopls, rust-analyzer, etc.)"
        }),
    }
}

/// 解析指定位置符号的类型。
pub(crate) fn handler_resolve_type(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // 尝试原生 LSP
    match crate::lsp_manager::LspManager::resolve_type(&path_str, &source, line, column, &ext) {
        Ok(hover) if !hover.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "type_info": hover,
            }));
        }
        _ => {}
    }

    // ── 路径 2：无原生 LSP 可用 → 降级 ──
    ToolResponse::Degraded {
        guidance: format!("Native LSP unavailable for .{} — type resolution skipped.", ext),
        fallback: format!("Install an LSP server for .{} to enable precise type resolution. Check engine_status for details.", ext),
        details: json!({
            "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
            "note": "Handwritten adapters removed in v8. Use real LSP servers."
        }),
    }
}

/// 查找指定位置接口/trait/抽象类的所有实现。
pub(crate) fn handler_find_implementations(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // 尝试原生 LSP
    match crate::lsp_manager::LspManager::find_implementations(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "implementations": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            }));
        }
        _ => {}
    }

    // 回退：无原生 LSP → 降级
    ToolResponse::Degraded {
        guidance: format!("Native LSP unavailable for .{} — implementation search skipped.", ext),
        fallback: format!("Install an LSP server for .{} to enable interface implementation search.", ext),
        details: json!({
            "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
            "note": "Handwritten adapters removed in v8. Use real LSP servers."
        }),
    }
}

/// 查找指定位置符号的所有引用。
pub(crate) fn handler_find_references(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;
    let _include_decl = args.get("includeDeclaration").and_then(|v| v.as_bool()).unwrap_or(false);

    // 尝试原生 LSP
    let lsp_err: Option<String> = match crate::lsp_manager::LspManager::find_references(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "references": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            }));
        }
        Ok(_) => None, // 无引用 — 正常
        Err(e) => Some(e), // 记录错误供诊断
    };

    // 回退：使用图查找入边引用
    match engine::engine_read_graph(|g| {
        let _node_ids: Vec<String> = g.node_ids().map(|s| s.to_string()).collect();
        let refs: Vec<Value> = g.edges_iter()
            .take(100)
            .map(|(_, e)| json!({
                "source": e.source,
                "target": e.target,
                "kind": format!("{:?}", e.kind),
            }))
            .collect();
        let mut out = json!({
            "file": path_str, "line": line, "column": column,
            "backend": "graph",
            "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
            "note": "Graph-based fallback — use native LSP for precise symbol references. Provide line+column for precise resolution.",
            "references": refs,
            "count": refs.len(),
        });
        if let Some(e) = &lsp_err {
            out["lsp_error"] = json!(e);
        }
        out
    }) {
        Ok(v) => ToolResponse::Success(v),
        Err(e) => ToolResponse::Degraded {
            guidance: format!("cannot access graph: {}", e),
            fallback: "Ensure the project has been analyzed first".into(),
            details: json!({}),
        },
    }
}

/// resolve_* 工具的共享准备：读取文件、获取扩展名，返回 (path, source, ext)。
pub(crate) fn resolve_tool_prepare(args: &Value) -> Result<(String, String, String), Value> {
    let file_path = get_str(args, &["file"]);
    if file_path.is_empty() {
        return Err(json!({"error": "file is required"}));
    }
    let root = project_root();
    let abs_path = if Path::new(&file_path).is_absolute() {
        PathBuf::from(&file_path)
    } else {
        root.join(&file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();
    let source = std::fs::read_to_string(&abs_path)
        .map_err(|e| json!({"error": format!("cannot read file: {}", e)}))?;
    Ok((path_str, source, ext))
}

pub(crate) fn handler_dataflow(args: &Value) -> ToolResponse {
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return ToolResponse::Degraded {
            guidance: "files is required and must be a non-empty array".into(),
            fallback: "Provide an array of file paths to trace dataflow".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    let paths: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            let p = Path::new(f);
            if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
        })
        .collect();
    let results = crate::analysis::dataflow_engine::query_dataflow_files(&paths);
    let json_results: Vec<Value> = results
        .iter()
        .map(|r| match &r.result {
            Ok(df) => json!({
                "file": r.file,
                "scopes": df.scopes.iter().map(|s| json!({
                    "name": s.name,
                    "reads": s.reads,
                    "writes": s.writes,
                    "triggers": s.triggers,
                    "awaits_callbacks": s.awaits_callbacks,
                    "sequence_calls": s.sequence_calls,
                })).collect::<Vec<_>>(),
                "shared": df.shared.iter().map(|sh| json!({
                    "var": sh.var,
                    "readers": sh.readers,
                    "writers": sh.writers,
                })).collect::<Vec<_>>(),
            }),
            Err(e) => json!({"file": r.file, "error": e}),
        })
        .collect();
    ToolResponse::Success(json!({"results": json_results}))
}
