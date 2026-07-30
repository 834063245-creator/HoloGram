// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! SvelteKit —— 文件系统路由检测器（阶段 2）。
//! 路由来自 `src/routes/` 下的文件路径，而非源码
//! 调用模式：`+page.svelte` 是页面，`+server.{ts,js}` 是 API 端点。
//! Load/layout 文件（+layout*、+error、+page.ts、+page.server.ts 等）
//! 不是路由，永远不匹配。

use super::super::DetectedRoute;
use super::nextjs::extract_exported_http_methods;

/// 匹配 `src/routes/**/+page.svelte` 和 `src/routes/**/+server.{ts,js}`。
pub(crate) fn is_sveltekit_candidate(rel_path: &str) -> bool {
    sveltekit_route_for_path(rel_path).is_some()
}

/// 将候选路径映射为 (url, is_api)；除 +page.svelte /
/// +server.* 外均 → None。
pub(crate) fn sveltekit_route_for_path(rel_path: &str) -> Option<(String, bool)> {
    let rest = rel_path.strip_prefix("src/routes/")?;
    let (dir, fname) = match rest.rsplit_once('/') {
        Some((d, f)) => (d, f),
        None => ("", rest),
    };
    let is_api = match fname {
        "+page.svelte" => false,
        "+server.ts" | "+server.js" => true,
        _ => return None,
    };
    let mut segments: Vec<String> = Vec::new();
    for seg in dir.split('/') {
        if let Some(mapped) = map_svelte_segment(seg) {
            segments.push(mapped);
        }
    }
    let url = if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    };
    Some((url, is_api))
}

/// 将一个目录段映射为其 URL 形式；None = 该段被省略。
fn map_svelte_segment(seg: &str) -> Option<String> {
    if seg.is_empty() {
        return None;
    }
    // 路由组 (group) 组织文件但不影响 URL。
    if seg.starts_with('(') && seg.ends_with(')') {
        return None;
    }
    // 可选参数 [[lang]] → :lang（与 Next 的 [[...slug]] 不同，
    // 后者是可选 catch-all 映射为 *）。
    if seg.starts_with("[[") && seg.ends_with("]]") {
        return Some(format!(":{}", &seg[2..seg.len() - 2]));
    }
    // Rest 参数 [...rest] → *
    if seg.starts_with("[...") && seg.ends_with(']') {
        return Some("*".to_string());
    }
    // 参数 [id] → :id；matcher 形式 [id=integer] 去除 `=...` 后缀（F4）。
    if seg.starts_with('[') && seg.ends_with(']') {
        let inner = &seg[1..seg.len() - 1];
        let name = inner.split('=').next().unwrap_or(inner);
        return Some(format!(":{}", name));
    }
    Some(seg.to_string())
}

/// 检测单个 SvelteKit 文件的路由。与 Next.js 语义相同：页面
/// 无需源码（一条 GET 路由）；+server 文件为每个导出的 HTTP
/// 方法生成一条路由，未找到方法时不输出。
pub(crate) fn detect_sveltekit_routes(file: &str, source: Option<&str>) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let Some((url, is_api)) = sveltekit_route_for_path(file) else {
        return result;
    };
    if !is_api {
        result.push(("GET".into(), url, file.to_string(), file.to_string(), 1));
        return result;
    }
    let Some(src) = source else {
        return result;
    };
    for (m, line) in extract_exported_http_methods(src) {
        result.push((m.to_string(), url.clone(), format!("{}#{}", file, m), file.to_string(), line));
    }
    result
}
