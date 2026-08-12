// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_slim_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".php") && (lower.contains("route") || lower.contains("app"))
}

pub(crate) fn detect_slim_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let methods: HashSet<&str> = ["get", "post", "put", "delete", "patch", "options", "any"]
        .iter().cloned().collect();
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if !t.starts_with("$app->") && !t.starts_with("$this->") { continue; }
        for m in &methods {
            let pat = format!("->{}(", m);
            if let Some(pos) = t.find(&pat) {
                let rest = &t[pos + pat.len()..];
                let path = if rest.starts_with('\'') || rest.starts_with('"') {
                    let d = rest.chars().next().expect("引号开头必有首字符（starts_with 已保证）");
                    rest[1..].split(d).next().unwrap_or("").to_string()
                } else { continue };
                if !path.is_empty() {
                    let handler = format!("<slim@{}>", li + 1);
                    result.push((m.to_uppercase(), format!("/{}", path.trim_matches('/')), handler, file.to_string(), li + 1));
                }
            }
        }
    }
    result
}
