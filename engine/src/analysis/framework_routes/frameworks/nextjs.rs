// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Next.js App Router — filesystem routing detector (Phase 2).
//! Routes come from file PATHS under `app/` (or `src/app/`), not from source
//! call patterns, so no AST is needed: path mapping is pure string work and
//! API-method extraction is a line-level scan.

use super::super::DetectedRoute;

/// Matches `app/**/page.{tsx,ts,jsx,js}` and `app/**/route.{ts,js,mts,cts}`,
/// also under `src/app/**` (mainstream layout, deliberate inclusion).
pub(crate) fn is_nextjs_candidate(rel_path: &str) -> bool {
    nextjs_route_for_path(rel_path).is_some()
}

/// Map a candidate path to (url, is_api). `page.*` files are pages,
/// `route.*` files are API handlers; anything else → None (reserved names
/// like layout/loading/error never match because only page.*/route.* pass).
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

/// Map one directory segment to its URL form; None = segment omitted.
fn map_next_segment(seg: &str) -> Option<String> {
    if seg.is_empty() {
        return None;
    }
    // Parallel-route slots (@slot) never appear in the URL.
    if seg.starts_with('@') {
        return None;
    }
    // Intercepting routes (.)x / (..)x / (...)x — DEGRADED: strip the marker
    // and keep the plain segment name. Precise intercepting semantics (modal
    // rendering on same-layout navigation) are a known limitation.
    for marker in ["(...)", "(..)", "(.)"] {
        if let Some(rest) = seg.strip_prefix(marker) {
            return map_next_segment(rest);
        }
    }
    // Route groups (group) organize files without affecting the URL.
    if seg.starts_with('(') && seg.ends_with(')') {
        return None;
    }
    // Optional catch-all [[...slug]] → *
    if seg.starts_with("[[...") && seg.ends_with("]]") {
        return Some("*".to_string());
    }
    // Catch-all [...slug] → *
    if seg.starts_with("[...") && seg.ends_with(']') {
        return Some("*".to_string());
    }
    // Dynamic [id] → :id
    if seg.starts_with('[') && seg.ends_with(']') {
        return Some(format!(":{}", &seg[1..seg.len() - 1]));
    }
    Some(seg.to_string())
}

/// Scan an API route file (`route.ts` / `+server.ts`) for exported HTTP
/// method handlers: `export (async )?function METHOD` or
/// `export const METHOD (: Type)? =`. Returns (method, 1-based line) pairs,
/// deduped, in source order.
/// Known gap: re-exports (`export { GET } from ...`) are not followed.
/// Shared with the SvelteKit detector.
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
        // `export const GET` must be an assignment (`export const GET =`),
        // optionally with a type annotation (`export const GET: RequestHandler =`),
        // not e.g. a typed re-declaration of something else.
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

/// Detect routes for one Next.js file. Pages need no source (one GET route,
/// handler = the module file); API files yield one route per exported HTTP
/// method (handler = file#METHOD) and emit nothing when no method is found.
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
