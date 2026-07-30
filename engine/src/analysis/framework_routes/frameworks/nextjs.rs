// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Next.js App Router —— 文件系统路由检测器（阶段 2）。
//! 路由来自 `app/`（或 `src/app/`）下的文件路径，而非源码
//! 调用模式，因此不需要 AST：路径映射是纯字符串操作，
//! API 方法提取是行级扫描。

use super::super::DetectedRoute;

/// 匹配 `app/**/page.{tsx,ts,jsx,js}` 和 `app/**/route.{ts,js,mts,cts}`，
/// 也包括 `src/app/**` 下的文件（主流布局，有意纳入）。
pub(crate) fn is_nextjs_candidate(rel_path: &str) -> bool {
    nextjs_route_for_path(rel_path).is_some()
}

/// 将候选路径映射为 (url, is_api)。`page.*` 文件是页面，
/// `route.*` 文件是 API 处理函数；其他 → None（保留名称
/// 如 layout/loading/error 永远不匹配，因为只有 page.*/route.* 通过）。
pub(crate) fn nextjs_route_for_path(rel_path: &str) -> Option<(String, bool)> {
    let rest = rel_path
        .strip_prefix("app/")
        .or_else(|| rel_path.strip_prefix("src/app/"))?;
    let (dir, fname) = match rest.rsplit_once('/') {
        Some((d, f)) => (d, f),
        None => ("", rest),
    };
    let is_api = match fname {
        "page.tsx" | "page.ts" | "page.jsx" | "page.js" => false,
        "route.ts" | "route.js" | "route.mts" | "route.cts" => true,
        _ => return None,
    };
    let mut segments: Vec<String> = Vec::new();
    for seg in dir.split('/') {
        if let Some(mapped) = map_next_segment(seg) {
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
fn map_next_segment(seg: &str) -> Option<String> {
    if seg.is_empty() {
        return None;
    }
    // 并行路由槽（@slot）不出现在 URL 中。
    if seg.starts_with('@') {
        return None;
    }
    // 拦截路由 (.)x / (..)x / (...)x —— 降级处理：去除标记
    // 并保留普通段名。精确的拦截语义（同布局导航时的
    // 模态渲染）是已知限制。
    for marker in ["(...)", "(..)", "(.)"] {
        if let Some(rest) = seg.strip_prefix(marker) {
            return map_next_segment(rest);
        }
    }
    // 路由组 (group) 组织文件但不影响 URL。
    if seg.starts_with('(') && seg.ends_with(')') {
        return None;
    }
    // 可选 catch-all [[...slug]] → *
    if seg.starts_with("[[...") && seg.ends_with("]]") {
        return Some("*".to_string());
    }
    // Catch-all [...slug] → *
    if seg.starts_with("[...") && seg.ends_with(']') {
        return Some("*".to_string());
    }
    // 动态 [id] → :id
    if seg.starts_with('[') && seg.ends_with(']') {
        return Some(format!(":{}", &seg[1..seg.len() - 1]));
    }
    Some(seg.to_string())
}

/// 扫描 API 路由文件（`route.ts` / `+server.ts`）中导出的 HTTP
/// 方法处理函数：`export (async )?function METHOD` 或
/// `export const METHOD (: Type)? =`。返回 (方法, 1-based 行号) 对，
/// 去重后按源码顺序排列。
/// 已知缺口：重导出（`export { GET } from ...`）不被跟踪。
/// 与 SvelteKit 检测器共享。
pub(crate) fn extract_exported_http_methods(source: &str) -> Vec<(&'static str, usize)> {
    const METHODS: [&str; 7] = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
    let mut found: Vec<(&'static str, usize)> = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let t = line.trim_start();
        let Some(rest) = t.strip_prefix("export ") else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest.strip_prefix("async ").map(str::trim_start).unwrap_or(rest);
        let decl = rest
            .strip_prefix("function ")
            .or_else(|| rest.strip_prefix("const "));
        let Some(sig) = decl else {
            continue;
        };
        let name_end = sig
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$')
            .unwrap_or(sig.len());
        let name = &sig[..name_end];
        // `export const GET` 必须是赋值（`export const GET =`），
        // 可选带类型标注（`export const GET: RequestHandler =`），
        // 而非例如其他内容的类型化重声明。
        if rest.starts_with("const ") {
            let after_name = sig[name_end..].trim_start();
            let is_assignment = if after_name.starts_with('=') {
                true
            } else if let Some(ty) = after_name.strip_prefix(':') {
                ty.contains('=')
            } else {
                false
            };
            if !is_assignment {
                continue;
            }
        }
        if let Some(m) = METHODS.iter().find(|m| **m == name) {
            if !found.iter().any(|(f, _)| f == m) {
                found.push((m, idx + 1));
            }
        }
    }
    found
}

/// 检测单个 Next.js 文件的路由。页面无需源码（一条 GET 路由，
/// 处理函数 = 模块文件）；API 文件为每个导出的 HTTP 方法生成一条
/// 路由（处理函数 = file#METHOD），未找到方法时不输出。
pub(crate) fn detect_nextjs_routes(file: &str, source: Option<&str>) -> Vec<DetectedRoute> {
    let mut result = Vec::new();
    let Some((url, is_api)) = nextjs_route_for_path(file) else {
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
