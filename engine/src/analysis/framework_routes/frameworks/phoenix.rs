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

    // D2: Track scope prefixes via a block stack.
    // Phoenix uses `do ... end` blocks. `scope "/path" do` opens a scope block;
    // other `do` blocks (defmodule, pipeline, etc.) are tracked as non-scope blocks.
    enum Block { Scope(String), Other }
    let mut block_stack: Vec<Block> = Vec::new();

    // Phoenix uses macros: `get "/path", Controller, :action`
    // Also works as keyword: `get("/path", Controller, :action)`
    // Line-based fallback — Elixir tree-sitter quirk with macro calls
    for (line_idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        // Track block openings BEFORE route detection so scope is active on the same line.
        // `scope "/api" do` → push Scope("/api"); other `... do` → push Other.
        if trimmed.starts_with("scope ") {
            // Extract the scope path (first quoted string)
            let scope_path = extract_phoenix_string(trimmed).unwrap_or_default();
            block_stack.push(Block::Scope(scope_path));
        } else if trimmed.ends_with(" do") {
            block_stack.push(Block::Other);
        }

        // Route detection (skip structural keywords)
        if trimmed.starts_with("defmodule") || trimmed.starts_with("use ")
            || trimmed.starts_with("pipeline") || trimmed.starts_with("plug ")
        {
            // These lines already triggered block tracking above if they end with `do`.
            // Just skip route detection for them.
            continue;
        }

        // Check for `end` — pop the innermost block AFTER route detection
        // so routes on the same line as `end` are unlikely in practice.
        let is_end = trimmed == "end";

        if !is_end {
            // Pattern: `verb "/path", Controller, :action` or `verb("/path", Controller, :action)`
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
                // Extract path (first string)
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

                // Extract handler: the atom after the path (starts with :)
                let handler = if let Some(atom_pos) = rest.rfind(':') {
                    rest[atom_pos..].split([',', ' ', ')'])
                        .next().unwrap_or("").trim_matches(':').to_string()
                } else { continue };

                if !path.is_empty() && !handler.is_empty() {
                    // D2: Prepend all scope prefixes from the block stack
                    let scope_prefix: String = block_stack.iter()
                        .filter_map(|b| match b { Block::Scope(p) => Some(p.as_str()), _ => None })
                        .collect::<Vec<_>>()
                        .join("/");
                    let full_path = if scope_prefix.is_empty() {
                        format!("/{}", path.trim_matches('/'))
                    } else {
                        format!("/{}/{}", scope_prefix.trim_matches('/'), path.trim_matches('/'))
                    };
                    result.push((verb.to_uppercase(), full_path, handler, file.to_string(), line_idx + 1));
                }
            }
        }

        // Pop block on `end`
        if is_end {
            block_stack.pop();
        }
    }
    result
}

/// Extract the first quoted string from a line (for scope path extraction).
fn extract_phoenix_string(line: &str) -> Option<String> {
    let start = line.find('"').or_else(|| line.find('\''))?;
    let delim = line.as_bytes()[start];
    let rest = &line[start + 1..];
    let end = rest.find(delim as char)?;
    Some(rest[..end].to_string())
}
