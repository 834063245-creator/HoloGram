// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// desktop 逐动作审计 — 镜像 cdp/session.rs 的 audit 姿势：
// 内存环形（500 条）+ temp 目录日轮转 jsonl（hologram-desktop-audit-YYYYMMDD.jsonl，
// 默认保留 7 天，HOLOGRAM_DESKTOP_AUDIT_RETAIN_DAYS 可调）。
// 查询经 desktop_audit 工具（对齐 browser_audit）。

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use serde_json::json;

const AUDIT_MAX: usize = 500;
const AUDIT_FILE_PREFIX: &str = "hologram-desktop-audit";

static AUDIT: LazyLock<Mutex<VecDeque<String>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

fn retain_days() -> u64 {
    std::env::var("HOLOGRAM_DESKTOP_AUDIT_RETAIN_DAYS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&d| d >= 1)
        .unwrap_or(7)
}

fn is_expired(modified: std::time::SystemTime, now: std::time::SystemTime, days: u64) -> bool {
    now.duration_since(modified)
        .map(|age| age.as_secs() > days.saturating_mul(24 * 60 * 60))
        .unwrap_or(false)
}

fn cleanup_old_files(dir: &std::path::Path, prefix: &str, days: u64, now: std::time::SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(prefix) {
            continue;
        }
        let expired = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| is_expired(m, now, days))
            .unwrap_or(false);
        if expired {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn audit_file_path() -> std::path::PathBuf {
    let day = chrono::Local::now().format("%Y%m%d").to_string();
    std::env::temp_dir().join(format!("{AUDIT_FILE_PREFIX}-{day}.jsonl"))
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// 记一条审计（agent/action/target/summary）。落盘失败静默（尽力而为）。
pub(crate) fn audit_log(agent_id: Option<&str>, action: &str, target: &str, summary: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = json!({
        "ts": ts,
        "agent": agent_id.filter(|s| !s.trim().is_empty()).unwrap_or("default"),
        "action": action,
        "target": truncate_str(target, 120),
        "summary": truncate_str(summary, 200),
    })
    .to_string();
    {
        let mut buf = crate::utils::lock_or_recover(&AUDIT);
        if buf.len() >= AUDIT_MAX {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
    }
    cleanup_old_files(
        &std::env::temp_dir(),
        AUDIT_FILE_PREFIX,
        retain_days(),
        std::time::SystemTime::now(),
    );
    use std::io::Write;
    let path = audit_file_path();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{entry}");
    }
}

/// 查询审计（最新 N 条，按 agent 过滤）。
pub(crate) fn audit_query(agent: Option<&str>, limit: Option<usize>) -> String {
    let n = limit.unwrap_or(50).min(AUDIT_MAX);
    let buf = crate::utils::lock_or_recover(&AUDIT);
    let mut entries: Vec<String> = Vec::new();
    for e in buf.iter().rev() {
        let matches = match agent {
            None => true,
            Some(a) => serde_json::from_str::<serde_json::Value>(e)
                .map(|v| v["agent"].as_str() == Some(a))
                .unwrap_or(true), // 脏条目不过滤（宁可显示不可藏）
        };
        if matches {
            entries.push(e.clone());
            if entries.len() >= n {
                break;
            }
        }
    }
    entries.reverse();
    json!({ "count": entries.len(), "entries": entries }).to_string()
}

// ═══════════════════════════════════════════════════════════
// 测试 — 纯逻辑，不依赖 COM
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_roundtrip_and_agent_filter() {
        let marker = format!("audit-test-{}", std::process::id());
        audit_log(Some(&marker), "uia_click", "[Button] \"OK\" @ hwnd=1", "done method=invoke");
        let out = audit_query(Some(&marker), Some(50));
        assert!(out.contains("uia_click"), "审计查询应包含刚写入的条目: {out}");
        let out2 = audit_query(Some("no-such-agent-x"), Some(50));
        assert!(!out2.contains(&marker), "agent 过滤应排除他人条目: {out2}");
    }

    #[test]
    fn truncation_keeps_marker() {
        let long = "x".repeat(500);
        audit_log(Some("trunc-test"), "uia_type", &long, &long);
        let out = audit_query(Some("trunc-test"), Some(10));
        assert!(out.contains("trunc-test"), "截断不应破坏 JSON 条目: {out}");
    }
}
