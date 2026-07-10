// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Staleness banner — warns the Agent when tool responses reference files
//! that were edited since the last index sync.

use serde_json::Value;

use crate::engine;

/// Check whether the result references files pending sync, and render a banner.
pub fn check_staleness(result: &Value) -> Option<String> {
    let pending = engine::with_engine(|eng| eng.get_pending_files()).unwrap_or_default();
    if pending.is_empty() {
        return None;
    }

    // Collect file paths referenced in the result (heuristic: sourceCode sections)
    let mut referenced: Vec<String> = Vec::new();
    collect_file_paths(result, &mut referenced);

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut referenced_pending: Vec<String> = Vec::new();
    let mut other_count = 0usize;

    for (path, ts_ms, indexing) in &pending {
        let age = now_ms.saturating_sub(*ts_ms);
        let status = if *indexing { "indexing in progress" } else { "pending sync" };
        let matched = referenced.iter().any(|r| path.contains(r.as_str()) || r.contains(path.as_str()));
        if matched {
            referenced_pending.push(format!("  - {} (edited {}ms ago, {})", path, age, status));
        } else {
            other_count += 1;
        }
    }

    if referenced_pending.is_empty() && other_count == 0 {
        return None;
    }

    let mut banner = String::new();
    if !referenced_pending.is_empty() {
        banner.push_str(&format!(
            "⚠️ Some files referenced below were edited since the last index sync:\n{}\n\
             For accurate content, Read those specific files directly.\n",
            referenced_pending.join("\n")
        ));
    }
    if other_count > 0 {
        banner.push_str(&format!(
            "({} other file(s) elsewhere are also pending sync but not referenced here.)",
            other_count
        ));
    }

    Some(banner)
}

fn collect_file_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Object(obj) => {
            for (k, v) in obj {
                if k == "file" || k == "location" {
                    if let Some(s) = v.as_str() {
                        paths.push(s.to_string());
                    }
                }
                collect_file_paths(v, paths);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_file_paths(v, paths);
            }
        }
        _ => {}
    }
}
