// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_aspnet_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".cs") && (lower.contains("controller") || lower.contains("api"))
}

/// Extract the method name from a C# method signature line.
/// e.g. "public async Task<IActionResult> GetUser(int id)" → "GetUser"
/// e.g. "public IActionResult Delete(int id)" → "Delete"
fn extract_method_name(line: &str) -> String {
    // Find the opening paren — method name is the token just before it
    if let Some(paren_idx) = line.find('(') {
        let before_paren = &line[..paren_idx];
        // Split by whitespace and take the last token (the method name)
        if let Some(name) = before_paren.split_whitespace().next_back() {
            // Strip generics like "GetUser<T>" → "GetUser"
            let name = name.split('<').next().unwrap_or(name);
            if !name.is_empty() && name != "IActionResult" && name != "ActionResult" {
                return name.to_string();
            }
        }
    }
    String::new()
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
                // Parse method signature: "public async Task<IActionResult> GetUser(int id)"
                // Extract the method name — it's the identifier before the opening paren
                let handler = extract_method_name(t);
                if !handler.is_empty() {
                    result.push((m, format!("/{}", p.trim_matches('/')), handler, file.to_string(), li + 1));
                }
            }
        }
    }
    result
}
