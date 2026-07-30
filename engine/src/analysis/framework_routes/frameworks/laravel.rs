// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use super::super::DetectedRoute;

pub(crate) fn is_laravel_candidate(file: &str) -> bool {
    let lower = file.to_lowercase();
    lower.ends_with(".php") && (lower.contains("route") || lower.contains("web") || lower.contains("api"))
}

pub(crate) fn detect_laravel_routes(file: &str, source: &str) -> Vec<DetectedRoute> {
    let mut result = Vec::new();

    let http_methods: HashSet<&str> = ["get", "post", "put", "delete", "patch", "any", "match"]
        .iter().cloned().collect();

    // 基于字符串的扫描——PHP tree-sitter 的 call expression 节点较为复杂，
    // 因此使用逐行的类正则匹配
    for (line_idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.starts_with("Route::") { continue; }
        // Route::get('/path', [Controller::class, 'method'])  或  Route::get('/path', 'Controller@method')
        if let Some(rest) = trimmed.strip_prefix("Route::") {
            let paren_pos = rest.find('(');
            let method_part = paren_pos.map(|p| &rest[..p]).unwrap_or(rest);
            let method_lower = method_part.trim().to_lowercase();
            if !http_methods.contains(method_lower.as_str()) { continue; }

            // 提取路径（两个单引号之间的第一个字符串参数）
            let path = extract_php_first_string(rest);

            // 提取处理函数：[X::class, 'method'] 或 'X@method'
            let handler = if let Some(at_idx) = rest.rfind('@') {
                // 'X@method' 风格
                rest[at_idx+1..].split('\'').next().unwrap_or("").to_string()
            } else if rest.contains("::class") {
                // [X::class, 'method'] 风格——查找最后一个引号字符串
                extract_php_last_string(rest)
            } else { continue };

            if !path.is_empty() && !handler.is_empty() {
                result.push((method_lower.to_uppercase(), format!("/{}", path.trim_matches('/')), handler, file.to_string(), line_idx + 1));
            }
        }
    }
    result
}

fn extract_php_first_string(s: &str) -> String {
    match s.find('\'') {
        Some(start) => match s[start+1..].find('\'') {
            Some(end) => s[start+1..start+1+end].to_string(),
            None => String::new(),
        },
        None => String::new(),
    }
}

fn extract_php_last_string(s: &str) -> String {
    match s.rfind('\'') {
        Some(start) => match s[..start].rfind('\'') {
            Some(end) => s[end+1..start].to_string(),
            None => String::new(),
        },
        None => String::new(),
    }
}
