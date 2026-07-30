// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_phoenix_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".ex") && (lower.contains("router") || lower.contains("route"))
}

pub(crate) fn detect_phoenix_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let http_verbs: HashSet<&str> = ["get", "post", "put", "delete", "patch", "head", "options"]
        .iter().cloned().collect();

    // D2：通过块栈跟踪 scope 前缀。
    // Phoenix 使用 `do ... end` 块。`scope "/path" do` 打开一个 scope 块；
    // 其他 `do` 块（defmodule、pipeline 等）作为非 scope 块跟踪。
    enum Block { Scope(String), Other }
    let mut block_stack: Vec<Block> = Vec::new();

    // Phoenix 使用宏：`get "/path", Controller, :action`
    // 也可用关键字形式：`get("/path", Controller, :action)`
    // 基于行的回退——Elixir tree-sitter 对宏调用的特殊行为
    for (line_idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        // 在路由检测之前跟踪块开头，以便 scope 在同一行生效。
        // `scope "/api" do` → push Scope("/api")；其他 `... do` → push Other。
        if trimmed.starts_with("scope ") {
            // 提取 scope 路径（第一个引号字符串）
            let scope_path = extract_phoenix_string(trimmed).unwrap_or_default();
            block_stack.push(Block::Scope(scope_path));
        } else if trimmed.ends_with(" do") {
            block_stack.push(Block::Other);
        }

        // 路由检测（跳过结构关键字）
        if trimmed.starts_with("defmodule") || trimmed.starts_with("use ")
            || trimmed.starts_with("pipeline") || trimmed.starts_with("plug ")
        {
            // 这些行如果以 `do` 结尾，已经在上面触发了块跟踪。
            // 这里仅跳过它们的路由检测。
            continue;
        }

        // 检查 `end` —— 在路由检测之后弹出最内层块，
        // 因此与 `end` 同行的路由在实践中不太可能出现。
        let is_end = trimmed == "end";

        if !is_end {
            // 模式：`verb "/path", Controller, :action` 或 `verb("/path", Controller, :action)`
            let first_space = trimmed.find(' ');
            let first_paren = trimmed.find('(');
            let verb_end = match (first_space, first_paren) {
                (Some(s), Some(p)) => s.min(p),
                (Some(s), None) => s,
                (None, Some(p)) => p,
                (None, None) => {
                    if is_end { block_stack.pop(); }
                    continue;
                }
            };
            let verb = trimmed[..verb_end].trim().to_lowercase();
            if http_verbs.contains(verb.as_str()) {
                let rest = &trimmed[verb_end..].trim();
                // 提取路径（第一个字符串）
                let path_start = rest.find('"').or_else(|| rest.find('\''));
                let path = match path_start {
                    Some(s) => {
                        let delim = rest.as_bytes()[s];
                        match rest[s+1..].find(delim as char) {
                            Some(e) => rest[s+1..s+1+e].to_string(),
                            None => { continue; }
                        }
                    }
                    None => { continue; }
                };

                // 提取处理函数：路径后面的 atom（以 : 开头）
                let handler = if let Some(atom_pos) = rest.rfind(':') {
                    rest[atom_pos..].split([',', ' ', ')'])
                        .next().unwrap_or("").trim_matches(':').to_string()
                } else { continue };

                if !path.is_empty() && !handler.is_empty() {
                    // D2：添加块栈中所有 scope 前缀
                    let scope_prefix: String = block_stack.iter()
                        .filter_map(|b| match b { Block::Scope(p) => Some(p.as_str()), _ => None })
                        .collect::<Vec<_>>()
                        .iter()
                        .filter(|p| !p.is_empty())
                        .map(|p| p.trim_matches('/'))
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                        .join("/");
                    let full_path = if scope_prefix.is_empty() {
                        format!("/{}", path.trim_matches('/'))
                    } else {
                        format!("/{}/{}", scope_prefix, path.trim_matches('/'))
                    };
                    result.push((verb.to_uppercase(), full_path, handler, file.to_string(), line_idx + 1));
                }
            }
        }

        // 在 `end` 上弹出块
        if is_end {
            block_stack.pop();
        }
    }
    result
}

/// 从一行中提取第一个引号字符串（用于 scope 路径提取）。
fn extract_phoenix_string(line: &str) -> Option<String> {
    let start = line.find('"').or_else(|| line.find('\''))?;
    let delim = line.as_bytes()[start];
    let rest = &line[start + 1..];
    let end = rest.find(delim as char)?;
    Some(rest[..end].to_string())
}
