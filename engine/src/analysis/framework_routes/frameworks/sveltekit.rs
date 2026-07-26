// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! SvelteKit — filesystem routing detector (Phase 2).
//! Routes come from file PATHS under `src/routes/`, not from source call
//! patterns: `+page.svelte` is a page, `+server.{ts,js}` is an API endpoint.
//! Load/layout files (+layout*, +error, +page.ts, +page.server.ts, ...) are
//! NOT routes and never match.

use super::super::DetectedRoute;
use super::nextjs::extract_exported_http_methods;

/// Matches `src/routes/**/+page.svelte` and `src/routes/**/+server.{ts,js}`.
pub(crate) fn is_sveltekit_candidate(rel_path: &str) -> bool {
    sveltekit_route_for_path(rel_path).is_some()
}

/// Map a candidate path to (url, is_api); anything but +page.svelte /
/// +server.* → None.
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

/// Map one directory segment to its URL form; None = segment omitted.
fn map_svelte_segment(seg: &str) -> Option<String> {
    if seg.is_empty() {
        return None;
    }
    // Route groups (group) organize files without affecting the URL.
    if seg.starts_with('(') && seg.ends_with(')') {
        return None;
    }
    // Optional param [[lang]] → :lang (DIFFERENT from Next's [[...slug]],
    // which is an optional catch-all mapping to *).
    if seg.starts_with("[[") && seg.ends_with("]]") {
        return Some(format!(":{}", &seg[2..seg.len() - 2]));
    }
    // Rest param [...rest] → *
    if seg.starts_with("[...") && seg.ends_with(']') {
        return Some("*".to_string());
    }
    // Param [id] → :id; matcher form [id=integer] strips the `=...` suffix (F4).
    if seg.starts_with('[') && seg.ends_with(']') {
        let inner = &seg[1..seg.len() - 1];
        let name = inner.split('=').next().unwrap_or(inner);
        return Some(format!(":{}", name));
    }
    Some(seg.to_string())
}

/// Detect routes for one SvelteKit file. Same semantics as Next.js: pages
/// need no source (one GET route); +server files yield one route per
/// exported HTTP method and emit nothing when no method is found.
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
