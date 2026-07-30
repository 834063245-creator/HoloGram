// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 过期警告横幅 —— 当工具响应引用了自上次索引同步后已编辑的文件时，
//! 向 Agent 发出警告。

use serde_json::Value;

use crate::engine;

/// 检查结果是否引用了待同步文件，并渲染警告横幅。
pub fn check_staleness(result: &Value) -> Option<String> {
    let pending = engine::with_engine(|eng| eng.get_pending_files()).unwrap_or_default();
    if pending.is_empty() {
        return None;
    }

    // 收集结果中引用的文件路径（启发式：sourceCode 部分）
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
        let status = if *indexing { "索引中" } else { "待同步" };
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
            "⚠️ 以下引用的文件自上次索引同步后已被编辑：\n{}\n\
             如需准确内容，请直接读取这些文件。\n",
            referenced_pending.join("\n")
        ));
    }
    if other_count > 0 {
        banner.push_str(&format!(
            "（另有 {} 个其他文件也待同步，但未在此处引用。）",
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
