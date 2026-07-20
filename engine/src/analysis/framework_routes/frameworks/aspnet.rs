// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_aspnet_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".cs") && (lower.contains("controller") || lower.contains("api"))
}

pub(crate) fn detect_aspnet_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let http_attrs: HashSet<&str> = ["HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch", "Route"]
        .iter().cloned().collect();
    let mut pending: Option<(String, String)> = None;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.starts_with('[') && t.contains('(') {
            let inner = t.trim_matches(|c| c == '[' || c == ']');
            if let Some(p) = inner.find('(') {
                let attr = inner[..p].trim();
                if http_attrs.contains(attr) {
                    let path = inner[p..].trim_matches(|c| c == '(' || c == ')' || c == '"' || c == '\'');
                    let method = if attr == "Route" { "ALL" } else {
                        &attr.trim_start_matches("Http").to_uppercase()
                    };
                    pending = Some((if method == "ALL" { "ALL".into() } else { method.to_string() }, path.to_string()));
                }
            }
        }
        if t.contains("IActionResult") || t.contains("ActionResult") {
            if let Some((m, p)) = pending.take() {
                let handler = t.split_whitespace().nth(1).unwrap_or("<handler>").to_string();
                if !handler.is_empty() {
                    result.push((m, format!("/{}", p.trim_matches('/')), handler, file.to_string(), li + 1));
                }
            }
        }
    }
    result
}
