// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_sinatra_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rb")
}

pub(crate) fn detect_sinatra_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let verbs: HashSet<&str> = ["get", "post", "put", "delete", "patch", "head", "options"]
        .iter().cloned().collect();
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        for verb in &verbs {
            // Pattern: `get '/path'` or `get "/path"`
            if t.starts_with(&format!("{} ", verb)) {
                let rest = &t[verb.len()..].trim();
                let delim = rest.chars().next().unwrap_or(' ');
                if delim == '\'' || delim == '"' {
                    let path = rest[1..].split(delim).next().unwrap_or("").to_string();
                    if !path.is_empty() {
                        let handler = format!("<sinatra@{}>", li + 1);
                        result.push((verb.to_uppercase(), format!("/{}", path.trim_matches('/')), handler, file.to_string(), li + 1));
                    }
                }
            }
        }
    }
    result
}
