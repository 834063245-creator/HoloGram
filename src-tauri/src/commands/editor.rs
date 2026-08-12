// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Code editor: edit_file + 真实行级 diff（build_line_diff）.

use hologram_engine::engine as engine_api;
use hologram_engine::pipeline::discovery::is_ignored_path;

#[tauri::command]
pub(crate) async fn edit_file(
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let is_agent = is_agent.unwrap_or(false);
    let (_, content) = crate::confined_fs::read_text(&file_path, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let resolved = crate::utils::resolve_write_dispatch(&file_path, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let file_path = resolved.to_string_lossy().to_string();

    let replace_all = replace_all.unwrap_or(false);
    if old_string.is_empty() {
        return Err("old_string 不能为空".to_string());
    }

    // 容错模式的替换执行（写回 out 后返回 diff 快照）
    let fallback = |start: usize, old_lines: &[&str], new_ls: &[&str], file_lines: &[&str]| -> String {
        let mut out = String::new();
        for l in &file_lines[..start] { out.push_str(l); out.push('\n'); }
        for nl in new_ls { out.push_str(nl); out.push('\n'); }
        for l in &file_lines[start + old_lines.len()..] {
            out.push_str(l); out.push('\n');
        }
        out
    };

    let count = if replace_all {
        content.matches(&old_string).count()
    } else {
        let c = content.matches(&old_string).count();
        if c == 0 {
            // Whitespace-tolerant: match line-by-line after trimming each line.
            let old_lines: Vec<&str> = old_string.lines().collect();
            if !old_lines.is_empty() {
                let file_lines: Vec<&str> = content.lines().collect();
                let first_trimmed = old_lines[0].trim();
                for start in 0..file_lines.len() {
                    if file_lines[start].trim() != first_trimmed { continue; }
                    let mut matched = true;
                    for k in 1..old_lines.len() {
                        if start + k >= file_lines.len()
                            || file_lines[start + k].trim() != old_lines[k].trim()
                        { matched = false; break; }
                    }
                    if matched && start + old_lines.len() <= file_lines.len() {
                        // 写回时 new_string 按调用者原样（每行保留自身缩进），
                        // 不再做「首行补 prefix、后续行 trim」的不可预测改写。
                        let new_ls: Vec<&str> = new_string.lines().collect();
                        let mut out = fallback(start, &old_lines, &new_ls, &file_lines);
                        // 保持原文件的末尾换行状态：原文件无末尾换行则不补。
                        // （此前 trim_end_matches('\n') 会删掉所有末尾换行，
                        //   导致每次容错编辑后文件变成 no-newline-at-EOF。）
                        if !content.ends_with('\n') && out.ends_with('\n') {
                            out.pop();
                        }
                        // 写前乐观并发检查 — 读取后被并发修改则拒绝写入
                        // （read-modify-write 竞态：两个并发 edit 基于同一旧内容
                        //  各自替换，后写者会覆盖先写者的改动）。
                        if let Ok(current) = std::fs::read_to_string(&file_path) {
                            if current != content {
                                return Err(format!(
                                    "文件在编辑过程中被并发修改，请重试（old_string 基于旧内容）: {}",
                                    file_path
                                ));
                            }
                        }
                        crate::utils::write_atomic(&file_path, &out)?;
                        if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
                            if !is_ignored_path(&file_path) {
                                let short = file_path.rsplit(['/', '\\']).next().unwrap_or(&file_path);
                                let _ = engine_api::engine_record_timeline("agent_edit", Some(file_path.as_str()), &format!("Agent 编辑: {}", short));
                                if let Ok(mut changed) = handle.changed_files.lock() {
                                    if !changed.contains(&file_path) { changed.push(file_path.clone()); }
                                }
                            }
                        }
                        let match_line = start + 1;
                        let ds = build_line_diff(&content, &out);
                        return Ok(format!(
                            "已替换 1 处匹配（容错模式：逐行对齐）— {} (第 {} 行附近)\n```diff\n{}\n```",
                            file_path, match_line, ds
                        ));
                    }
                    break;
                }
            }
            let first_line = old_string.lines().next().unwrap_or("(empty)");
            let best = crate::utils::fuzzy_find(&content, first_line);
            let hint = match best {
                Some((ln, ctx)) => format!("line {}: {}", ln, ctx),
                None => format!("file starts: {}",
                    content.lines().take(3).collect::<Vec<_>>().join(" | ")),
            };
            let key = if first_line.len() > 60 { &first_line[..60] } else { first_line };
            return Err(format!("not found: \"{}\" | {}", key, hint));
        }
        if c > 1 {
            return Err(format!(
                "old_string 在文件中出现了 {} 次，不是唯一的。请添加更多上下文使其唯一，或设置 replace_all: true。",
                c
            ));
        }
        c
    };

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    // 写前乐观并发检查 — 读取后被并发修改则拒绝写入
    if let Ok(current) = std::fs::read_to_string(&file_path) {
        if current != content {
            return Err(format!(
                "文件在编辑过程中被并发修改，请重试（old_string 基于旧内容）: {}",
                file_path
            ));
        }
    }

    crate::utils::write_atomic(&file_path, &new_content)?;

    if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        if !is_ignored_path(&file_path) {
            let short = file_path.rsplit(['/', '\\']).next().unwrap_or(&file_path);
            let _ = engine_api::engine_record_timeline("agent_edit", Some(file_path.as_str()), &format!("Agent 编辑: {}", short));
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&file_path) { changed.push(file_path.clone()); }
            }
        }
    }

    let first_match_line = content.lines()
        .enumerate()
        .find(|(_, l)| l.contains(old_string.lines().next().unwrap_or("")))
        .map(|(i, _)| i + 1)
        .unwrap_or(0);
    let line_info = if first_match_line > 0 {
        format!(" (第 {} 行附近)", first_match_line)
    } else {
        String::new()
    };

    // 真实 before/after 行级 diff — 模型看到的就是文件里实际发生的变化
    // （此前按 old_string 伪造的 snippet 在行内替换/replace_all 时会误导）。
    let diff_snippet = build_line_diff(&content, &new_content);

    Ok(if replace_all {
        format!(
            "已替换 {} 处匹配 — {}{}\n```diff\n{}\n```",
            count, file_path, line_info, diff_snippet
        )
    } else {
        format!(
            "已替换 1 处匹配 — {}{}\n```diff\n{}\n```",
            file_path, line_info, diff_snippet
        )
    })
}

// ═══════════════════════════════════════════════════════════
// 真实行级 diff（2026-08：替代伪造 snippet，防止模型误解改动范围）
// ═══════════════════════════════════════════════════════════
// 对替换前/后内容做行级 LCS diff，输出标准 unified diff 格式：
// @@ 头在上下文之前、每个 hunk 独立头、间隔 ≤ 2*CTX 的变化合并
// （git 行为）。行内子串替换只显示那一行的 - / +（真实差异）；
// replace_all 显示全部 hunk；容错模式显示实际写入前后的差异。
// 模型看到的永远是文件里真实发生的变化。

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiffOp {
    Keep,
    Del,
    Ins,
}

/// 行级 diff — O(n*m) DP + 回溯。编辑场景文件通常在几百行内，足够快。
fn line_diff(a: &[&str], b: &[&str]) -> Vec<DiffOp> {
    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut ops = Vec::with_capacity(n + m);
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push(DiffOp::Keep);
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(DiffOp::Del);
            i += 1;
        } else {
            ops.push(DiffOp::Ins);
            j += 1;
        }
    }
    while i < n {
        ops.push(DiffOp::Del);
        i += 1;
    }
    while j < m {
        ops.push(DiffOp::Ins);
        j += 1;
    }
    ops
}

/// 渲染标准 unified diff：每个 hunk 以 @@ 头开始，前后各 3 行上下文；
/// 间隔 ≤ 2*CTX 的变化区间合并为一个 hunk（git 行为）；超长截断保护。
fn build_line_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let n = a.len();
    let m = b.len();
    if a == b {
        return String::new();
    }

    // 公共前缀/后缀夹逼 — 缩小 DP 区间：大文件的一次编辑只对比中间变化段。
    let mut pre = 0;
    while pre < n && pre < m && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf] {
        suf += 1;
    }
    let mid_a = &a[pre..n - suf];
    let mid_b = &b[pre..m - suf];
    let mid_ops = if mid_a.len() * mid_b.len() > 4_000_000 {
        // 超大中间段：整体视为变化（避免 O(n*m) 内存爆炸）
        let mut v = Vec::with_capacity(mid_a.len() + mid_b.len());
        v.resize(mid_a.len(), DiffOp::Del);
        v.resize(mid_a.len() + mid_b.len(), DiffOp::Ins);
        v
    } else {
        line_diff(mid_a, mid_b)
    };
    let mut ops = Vec::with_capacity(n + m);
    ops.resize(pre, DiffOp::Keep);
    let mid_len = mid_ops.len();
    ops.extend(mid_ops);
    ops.resize(pre + mid_len + suf, DiffOp::Keep);

    // 每个 op 位置两侧的 0-based 行游标（= 该 op 之前已消费的行数）。
    // Keep/Del 的行文本 = a[a_pos[idx]]；Keep/Ins 的行文本 = b[b_pos[idx]]。
    let mut a_pos = vec![0usize; ops.len()];
    let mut b_pos = vec![0usize; ops.len()];
    {
        let (mut ai, mut bi) = (0usize, 0usize);
        for (idx, op) in ops.iter().enumerate() {
            a_pos[idx] = ai;
            b_pos[idx] = bi;
            match op {
                DiffOp::Keep => {
                    ai += 1;
                    bi += 1;
                }
                DiffOp::Del => ai += 1,
                DiffOp::Ins => bi += 1,
            }
        }
    }

    const CTX: usize = 3;
    const MAX_LINES: usize = 400;

    // 变化区间（ops 下标，半开）；间隔 ≤ 2*CTX 的相邻区间合并为一个 hunk。
    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < ops.len() {
        if ops[i] == DiffOp::Keep {
            i += 1;
            continue;
        }
        let s = i;
        while i < ops.len() && ops[i] != DiffOp::Keep {
            i += 1;
        }
        match regions.last_mut() {
            Some(last) if s - last.1 <= 2 * CTX => last.1 = i,
            _ => regions.push((s, i)),
        }
    }
    if regions.is_empty() {
        return String::new();
    }

    let mut out = String::new();
    let mut emitted = 0usize;
    let mut truncated = false;
    let mut prev_end = 0usize;
    'hunks: for (hidx, &(rs, re)) in regions.iter().enumerate() {
        // 上下文：首 hunk 之前/末 hunk 之后按文件边界收敛；hunk 间距 > 2*CTX
        // 保证相邻 hunk 的上下文不重叠。
        let lead = CTX.min(rs - prev_end);
        let trail = if hidx + 1 < regions.len() {
            CTX
        } else {
            CTX.min(ops.len() - re)
        };
        let s0 = rs - lead;
        let e0 = (re + trail).min(ops.len());
        prev_end = re;

        let a_count = ops[s0..e0].iter().filter(|o| **o != DiffOp::Ins).count();
        let b_count = ops[s0..e0].iter().filter(|o| **o != DiffOp::Del).count();
        // 起点行号（1-based，含上下文行）：锚定区间内首条本侧行；纯插入/纯删除
        // （count = 0）时锚点为插入点前的行数（git 约定的 -k,0 / +k,0）。
        let a_start = ops[s0..e0]
            .iter()
            .position(|o| *o != DiffOp::Ins)
            .map(|p| a_pos[s0 + p] + 1)
            .unwrap_or(a_pos[s0]);
        let b_start = ops[s0..e0]
            .iter()
            .position(|o| *o != DiffOp::Del)
            .map(|p| b_pos[s0 + p] + 1)
            .unwrap_or(b_pos[s0]);
        out.push_str(&format!("@@ -{},{} +{},{} @@\n", a_start, a_count, b_start, b_count));
        emitted += 1;

        for (idx, op) in ops.iter().enumerate().take(e0).skip(s0) {
            if emitted >= MAX_LINES {
                truncated = true;
                break 'hunks;
            }
            let (prefix, text) = match op {
                DiffOp::Keep => ("  ", a[a_pos[idx]]),
                DiffOp::Del => ("- ", a[a_pos[idx]]),
                DiffOp::Ins => ("+ ", b[b_pos[idx]]),
            };
            out.push_str(prefix);
            out.push_str(text);
            out.push('\n');
            emitted += 1;
        }
    }
    if truncated {
        out.push_str(&format!("...(diff 过长已截断，仅显示前 {} 行)", MAX_LINES));
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff_of(before: &str, after: &str) -> String {
        build_line_diff(before, after)
    }

    #[test]
    fn diff_no_change_is_empty() {
        assert_eq!(diff_of("a\nb\nc\n", "a\nb\nc\n"), "");
    }

    #[test]
    fn diff_inline_substring_replacement_shows_only_that_line() {
        // 行内替换 — 旧实现会把整行标 - / + 之外还伪造上下文；现在只显示真实变化。
        let d = diff_of("line one\nfoo bar baz\nline three\n", "line one\nfoo QUX baz\nline three\n");
        assert!(d.contains("- foo bar baz"), "unexpected diff: {d}");
        assert!(d.contains("+ foo QUX baz"), "unexpected diff: {d}");
        assert!(!d.contains("- line one"), "unchanged line must not be removed: {d}");
        assert!(!d.contains("- line three"), "unchanged line must not be removed: {d}");
        // 尾部上下文行按标准 unified diff 正常显示（hunk 紧邻行）
        assert!(d.contains("  line three"), "tail context missing: {d}");
    }

    #[test]
    fn diff_multiline_replacement() {
        let d = diff_of("a\nold1\nold2\nz\n", "a\nnew1\nnew2\nnew3\nz\n");
        assert!(d.contains("- old1"), "unexpected diff: {d}");
        assert!(d.contains("- old2"), "unexpected diff: {d}");
        assert!(d.contains("+ new1"), "unexpected diff: {d}");
        assert!(d.contains("+ new2"), "unexpected diff: {d}");
        assert!(d.contains("+ new3"), "unexpected diff: {d}");
    }

    #[test]
    fn diff_multiple_hunks_all_shown() {
        // replace_all 场景：两处相距 > 2*CTX 行的修改必须是两个独立 hunk，
        // 各自带 @@ 头（回归：旧渲染器 off-by-one 导致第二个 hunk 起丢头，
        // 无头变化直接拼接在上一 hunk 尾部，严重误导模型）。
        let mids = (0..10).map(|i| format!("mid{i}")).collect::<Vec<_>>().join("\n");
        let before = format!("x1\n{mids}\nx2\n");
        let after = before.replacen("x1", "y1", 1).replacen("x2", "y2", 1);
        let d = diff_of(&before, &after);
        assert!(d.contains("- x1"), "hunk 1 missing: {d}");
        assert!(d.contains("+ y1"), "hunk 1 missing: {d}");
        assert!(d.contains("- x2"), "hunk 2 missing: {d}");
        assert!(d.contains("+ y2"), "hunk 2 missing: {d}");
        assert_eq!(d.matches("@@ -").count(), 2, "expected 2 hunk headers: {d}");
        assert!(d.contains("@@ -1,4 +1,4 @@"), "hunk 1 header: {d}");
        assert!(d.contains("@@ -9,4 +9,4 @@"), "hunk 2 header: {d}");
    }

    #[test]
    fn diff_close_changes_merge_into_one_hunk() {
        // 间隔 ≤ 2*CTX 的变化合并为一个 hunk（git 行为），不得出现无头变化段。
        let d = diff_of("a\nx1\nb\nx2\nc\n", "a\ny1\nb\ny2\nc\n");
        assert_eq!(d.matches("@@ -").count(), 1, "expected 1 merged hunk: {d}");
        assert!(d.contains("- x1"), "unexpected diff: {d}");
        assert!(d.contains("+ y2"), "unexpected diff: {d}");
    }

    #[test]
    fn diff_header_line_numbers() {
        // 标准 unified diff：@@ 头在最前，行号含上下文行。
        // 文件头插入（全文仅 2 行，全部成为上下文）→ @@ -1,2 +1,3 @@
        let d = diff_of("a\nb\n", "new\na\nb\n");
        assert!(d.starts_with("@@ -1,2 +1,3 @@\n+ new\n  a\n  b"), "unexpected diff: {d}");
        // 第 2 行替换（3 行文件全上下文）→ @@ -1,3 +1,3 @@
        let d2 = diff_of("a\nold\nc\n", "a\nnew\nc\n");
        assert!(d2.starts_with("@@ -1,3 +1,3 @@\n  a\n- old\n+ new\n  c"), "unexpected diff: {d2}");
        // 纯插入且前方无上下文 → git 约定锚点 -k,0
        let d3 = diff_of("", "x\n");
        assert!(d3.starts_with("@@ -0,0 +1,1 @@"), "unexpected diff: {d3}");
    }

    #[test]
    fn diff_whitespace_preserved() {
        // 容错模式：缩进差异必须原样显示（trim 会误导模型）。
        let d = diff_of("fn a() {\n    let x = 1;\n}\n", "fn a() {\n  let x = 1;\n}\n");
        assert!(d.contains("-     let x = 1;"), "indentation lost: {d}");
        assert!(d.contains("+   let x = 1;"), "indentation lost: {d}");
    }

    #[test]
    fn diff_truncation_guard() {
        // 全量变化（500 Del + 500 Ins）远超 400 行上限 → 必须截断并注明。
        let before = (0..500).map(|i| format!("old line {i}")).collect::<Vec<_>>().join("\n");
        let after = (0..500).map(|i| format!("new line {i}")).collect::<Vec<_>>().join("\n");
        let d = diff_of(&before, &after);
        assert!(d.contains("已截断"), "expected truncation note: {d:?}");
    }
}