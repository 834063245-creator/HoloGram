// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_rocket_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".rs")
}

pub(crate) fn detect_rocket_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let route_attrs: HashSet<&str> = ["get", "post", "put", "delete", "patch", "head", "options"]
        .iter().cloned().collect();
    let mut pending: Option<(String, String)> = None;
    for (li, line) in source.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("#[") && t.contains('(') {
            let inner = t.trim_start_matches("#[").trim_end_matches(']');
            if let Some(p) = inner.find('(') {
                let attr = inner[..p].trim();
                if route_attrs.contains(attr) {
                    let path = inner[p..].trim_matches(|c| c == '(' || c == ')' || c == '"' || c == '\'');
                    pending = Some((attr.to_uppercase(), path.to_string()));
                }
            }
        }
        if t.starts_with("fn ") || t.starts_with("pub fn ") || t.starts_with("async fn ") {
            if let Some((m, p)) = pending.take() {
                let handler = t.trim_start_matches("pub ").trim_start_matches("async ").trim_start_matches("fn ")
                    .split(['(', '<', ' ']).next().unwrap_or("<handler>").to_string();
                if !handler.is_empty() {
                    result.push((m, format!("/{}", p.trim_matches('/')), handler, file.to_string(), li + 1));
                }
            }
        }
    }
    result
}