use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use crate::engine;
use crate::tools::project_root;
use crate::tools::ToolResponse;

// ═══════════════════════════════════════════════════════════════
// 重命名 —— 两阶段预览/应用，带过期 + 统一 diff
// ═══════════════════════════════════════════════════════════════

const RENAME_EXPIRY_SECS: u64 = 600; // 10 minutes

static REFACTOR_COUNTER: AtomicU64 = AtomicU64::new(0);

struct RenamePlan {
    old_name: String,
    new_name: String,
    matched_ids: Vec<String>,
    affected_files: Vec<String>,
    file_snapshots: HashMap<String, String>, // file_path → original content
}

static PENDING_RENAMES: std::sync::LazyLock<Mutex<HashMap<String, (Instant, RenamePlan)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn refactor_id() -> String {
    let seq = REFACTOR_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 原子计数器 + 时间戳：并发调用下无冲突。
    format!("ref_{:012x}_{:04x}", nanos, seq & 0xFFFF)
}

fn cleanup_expired_renames(lock: &mut HashMap<String, (Instant, RenamePlan)>) {
    let now = Instant::now();
    let expired: Vec<String> = lock
        .iter()
        .filter(|(_, (ts, _))| now.duration_since(*ts) >= Duration::from_secs(RENAME_EXPIRY_SECS))
        .map(|(k, _)| k.clone())
        .collect();
    for k in expired {
        lock.remove(&k);
    }
}

/// 生成跨受影响文件的重命名 unified-diff 预览。
fn generate_rename_diff(plan: &RenamePlan) -> String {
    let mut output = String::new();
    let old = &plan.old_name;
    let new = &plan.new_name;

    for file_path in &plan.affected_files {
        let original = match plan.file_snapshots.get(file_path) {
            Some(s) => s,
            None => continue,
        };
        let renamed = original.replace(old, new);
        if *original == renamed {
            continue;
        }

        let orig_lines: Vec<&str> = original.lines().collect();
        let new_lines: Vec<&str> = renamed.lines().collect();

        output.push_str(&format!("--- a/{}\n", file_path));
        output.push_str(&format!("+++ b/{}\n", file_path));

        // 收集 hunk —— 简单扫描变更行，带 3 行上下文
        let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new(); // (old_start, old_len, new_start, new_len)
        let max_len = orig_lines.len().max(new_lines.len());
        let mut i = 0usize;
        while i < max_len {
            let old_line = orig_lines.get(i).copied().unwrap_or("");
            let new_line = new_lines.get(i).copied().unwrap_or("");
            if old_line != new_line {
                let hunk_start = i.saturating_sub(3);
                let mut hunk_end = i + 1;
                // 向前扩展以捕获 3 行上下文内的相邻变更
                let mut j = i + 1;
                while j < max_len && j <= i + 6 {
                    let ol = orig_lines.get(j).copied().unwrap_or("");
                    let nl = new_lines.get(j).copied().unwrap_or("");
                    if ol != nl {
                        hunk_end = j + 1;
                    }
                    j += 1;
                }
                hunk_end = (hunk_end + 3).min(max_len);
                // Ponytail：与前一个 hunk 合并（如果重叠）
                if let Some(last) = hunks.last_mut() {
                    if hunk_start <= last.3 + 3 {
                        last.3 = hunk_end;
                        i = hunk_end;
                        continue;
                    }
                }
                let old_len = (hunk_end - hunk_start).min(orig_lines.len() - hunk_start);
                let new_len = (hunk_end - hunk_start).min(new_lines.len() - hunk_start);
                hunks.push((hunk_start + 1, old_len, hunk_start + 1, new_len));
                i = hunk_end;
            } else {
                i += 1;
            }
        }

        for (old_start, old_len, new_start, new_len) in &hunks {
            output.push_str(&format!(
                "@@ -{},{} +{},{} @@\n",
                old_start, old_len, new_start, new_len
            ));
            let ctx_start = old_start.saturating_sub(1);
            let ctx_end = (old_start + old_len - 1).min(orig_lines.len());
            // 显示前导上下文
            for li in ctx_start..(*old_start - 1) {
                if let Some(l) = orig_lines.get(li) {
                    output.push_str(&format!(" {}\n", l));
                }
            }
            // 显示变更行
            for li in (*old_start - 1)..ctx_end {
                let orig = orig_lines.get(li).copied().unwrap_or("");
                let renamed_line = new_lines.get(li).copied().unwrap_or("");
                if orig != renamed_line {
                    if !orig.is_empty() || !renamed_line.is_empty() {
                        output.push_str(&format!("-{}\n", orig));
                    }
                    if !renamed_line.is_empty() || !orig.is_empty() {
                        output.push_str(&format!("+{}\n", renamed_line));
                    }
                } else {
                    output.push_str(&format!(" {}\n", orig));
                }
            }
            // 显示后续上下文
            for li in ctx_end..(ctx_end + 3).min(orig_lines.len()) {
                if let Some(l) = orig_lines.get(li) {
                    output.push_str(&format!(" {}\n", l));
                }
            }
        }
    }
    output
}

pub(crate) fn handler_rename(args: &Value) -> ToolResponse {
    let old_name = args.get("old_name").or_else(|| args.get("oldName")).and_then(|v| v.as_str()).unwrap_or("");
    let new_name = args.get("new_name").or_else(|| args.get("newName")).and_then(|v| v.as_str()).unwrap_or("");
    let dry_run = args.get("dry_run").or_else(|| args.get("dryRun")).and_then(|v| v.as_bool()).unwrap_or(true);
    let ref_id = args.get("refactor_id").or_else(|| args.get("refactorId")).and_then(|v| v.as_str());

    // ── 阶段 2：通过 refactor_id 应用 ──
    if let Some(rid) = ref_id {
        let mut lock = PENDING_RENAMES.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_expired_renames(&mut lock);
        let plan = match lock.remove(rid) {
            Some((_, plan)) => plan,
            None => {
                return ToolResponse::Degraded {
                    guidance: format!("Refactor ID '{}' not found or expired ({}s TTL)", rid, RENAME_EXPIRY_SECS),
                    fallback: "Run rename with dry_run=true to create a new preview".into(),
                    details: json!({}),
                };
            }
        };
        // 执行实际重命名
        let count = plan.matched_ids.len();
        let matched_ids = plan.matched_ids;
        if let Err(e) = engine::engine_write(|idx| {
            for nid in &matched_ids {
                idx.rename_node_name(nid, &plan.new_name);
            }
        }) {
            return ToolResponse::Degraded {
                guidance: e,
                fallback: "Engine write failed, retry once".into(),
                details: json!({}),
            };
        }
        if let Err(e) = engine::engine_save() {
            tracing::warn!("engine_save failed after rename: {e}");
            return ToolResponse::Degraded {
                guidance: format!("Rename succeeded in memory but failed to persist: {e}"),
                fallback: "Retry the operation or save manually".into(),
                details: json!({"renamed_count": count, "renamed_ids": matched_ids}),
            };
        }
        return ToolResponse::Success(json!({
            "phase": "applied",
            "old_name": plan.old_name,
            "new_name": plan.new_name,
            "renamed_count": count,
            "renamed_ids": matched_ids,
            "note": "Rename applied to graph and persisted to storage.",
        }));
    }

    // ── 阶段 1：dry_run 预览（默认）──
    if old_name.is_empty() || new_name.is_empty() {
        return ToolResponse::Degraded {
            guidance: "old_name and new_name are required for preview".into(),
            fallback: "Provide both the old and new symbol names".into(),
            details: json!({}),
        };
    }

    if !dry_run && ref_id.is_none() {
        return ToolResponse::Degraded {
            guidance: "To apply a rename, first run with dry_run=true (or omit dry_run) to preview, then pass the returned refactor_id with dry_run=false.".into(),
            fallback: "Run rename_symbol(old_name, new_name, dry_run=true) first".into(),
            details: json!({}),
        };
    }

    // dry_run：使用统一 diff 预览
    let (matched_ids, matched_locations): (Vec<String>, Vec<String>) = {
        match engine::engine_read(|idx| {
            let ids: Vec<String> = idx.nodes_iter().filter(|n| n.name == old_name).map(|n| n.id.as_str().to_owned()).collect();
            let locs: Vec<String> = idx.nodes_iter()
                .filter(|n| n.name == old_name)
                .filter_map(|n| n.location.clone())
                .collect();
            (ids, locs)
        }) {
            Ok((ids, locs)) => (ids, locs),
            Err(e) => return ToolResponse::Degraded {
                guidance: e,
                fallback: "Engine read failed, retry once".into(),
                details: json!({}),
            },
        }
    };

    if matched_ids.is_empty() {
        return ToolResponse::Degraded {
            guidance: format!("No nodes match '{}'", old_name),
            fallback: "Use search_symbols to find the correct symbol name".into(),
            details: json!({}),
        };
    }

    // 为 diff 生成快照受影响文件
    let mut file_snapshots: HashMap<String, String> = HashMap::new();
    let mut seen_files: Vec<String> = Vec::new();
    for loc in &matched_locations {
        let file_path = if let Some(pos) = loc.rfind(':') {
            let maybe_line = &loc[pos + 1..];
            if maybe_line.chars().all(|c| c.is_ascii_digit()) {
                &loc[..pos]
            } else {
                loc.as_str()
            }
        } else {
            loc.as_str()
        };
        if !seen_files.iter().any(|f| f == file_path) {
            seen_files.push(file_path.to_string());
            // 从磁盘读取文件内容
            let full_path = project_root().join(file_path);
            if let Ok(content) = std::fs::read_to_string(&full_path) {
                file_snapshots.insert(file_path.to_string(), content);
            }
        }
    }

    let rid = refactor_id();
    let plan = RenamePlan {
        old_name: old_name.to_string(),
        new_name: new_name.to_string(),
        matched_ids: matched_ids.clone(),
        affected_files: seen_files.clone(),
        file_snapshots,
    };
    let diff = generate_rename_diff(&plan);

    // 存储计划供后续应用
    {
        let mut lock = PENDING_RENAMES.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_expired_renames(&mut lock);
        lock.insert(rid.clone(), (Instant::now(), plan));
    }

    ToolResponse::Success(json!({
        "phase": "preview",
        "refactor_id": rid,
        "old_name": old_name,
        "new_name": new_name,
        "matched_count": matched_ids.len(),
        "matched_ids": matched_ids,
        "affected_files": seen_files,
        "diff": diff,
        "expires_in_secs": RENAME_EXPIRY_SECS,
        "message": format!(
            "Preview: {} nodes in {} files would be renamed. Apply with rename_symbol(refactor_id=\"{}\", dry_run=false). Preview expires in {}s.",
            matched_ids.len(), seen_files.len(), rid, RENAME_EXPIRY_SECS,
        ),
    }))
}


