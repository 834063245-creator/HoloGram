// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_aspnet_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".cs") && (lower.contains("controller") || lower.contains("api"))
}

/// 从 C# 方法签名行中提取方法名。
/// 例如 "public async Task<IActionResult> GetUser(int id)" → "GetUser"
/// 例如 "public IActionResult Delete(int id)" → "Delete"
fn extract_method_name(line: &str) -> String {
    // 查找左括号——方法名是紧邻其前的 token
    if let Some(paren_idx) = line.find('(') {
        let before_paren = &line[..paren_idx];
        // 按空白分割并取最后一个 token（方法名）
        if let Some(name) = before_paren.split_whitespace().next_back() {
            // 去除泛型，如 "GetUser<T>" → "GetUser"
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
                // 解析方法签名："public async Task<IActionResult> GetUser(int id)"
                // 提取方法名——它是左括号前的标识符
                let handler = extract_method_name(t);
                if !handler.is_empty() {
                    result.push((m, format!("/{}", p.trim_matches('/')), handler, file.to_string(), li + 1));
                }
            }
        }
    }
    result
}
