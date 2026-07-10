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

    // Phoenix uses macros: `get "/path", Controller, :action`
    // Also works as keyword: `get("/path", Controller, :action)`
    // Line-based fallback — Elixir tree-sitter quirk with macro calls
    for (line_idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("defmodule") || trimmed.starts_with("use ") || trimmed.starts_with("pipeline") || trimmed.starts_with("plug ") || trimmed.starts_with("scope ") || trimmed.starts_with("end") { continue; }

        // Pattern: `verb "/path", Controller, :action` or `verb("/path", Controller, :action)`
        let first_space = trimmed.find(' ');
        let first_paren = trimmed.find('(');
        let verb_end = match (first_space, first_paren) {
            (Some(s), Some(p)) => s.min(p),
            (Some(s), None) => s,
            (None, Some(p)) => p,
            (None, None) => continue,
        };
        let verb = trimmed[..verb_end].trim().to_lowercase();
        if !http_verbs.contains(verb.as_str()) { continue; }

        let rest = &trimmed[verb_end..].trim();
        // Extract path (first string)
        let path_start = rest.find('"').or_else(|| rest.find('\''));
        let path = match path_start {
            Some(s) => {
                let delim = rest.as_bytes()[s];
                match rest[s+1..].find(delim as char) {
                    Some(e) => rest[s+1..s+1+e].to_string(),
                    None => continue,
                }
            }
            None => continue,
        };

        // Extract handler: the atom after the path (starts with :)
        let handler = if let Some(atom_pos) = rest.rfind(':') {
            rest[atom_pos..].split(|c: char| c == ',' || c == ' ' || c == ')')
                .next().unwrap_or("").trim_matches(':').to_string()
        } else { continue };

        if !path.is_empty() && !handler.is_empty() {
            result.push((verb.to_uppercase(), format!("/{}", path.trim_matches('/')), handler, file.to_string(), line_idx + 1));
        }
    }
    result
}
