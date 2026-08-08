// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 搜索与 glob — 编码 agent 工具。

use hologram_engine::pipeline::discovery::is_ignored_path;

/// 展开 glob 模式中的花括号表达式。
/// "**/*.{ts,rs}" → ["**/*.ts", "**/*.rs"]
/// 支持嵌套花括号："a/{b,c}/{d,e}" 可正确展开。
fn expand_braces(pattern: &str) -> Vec<String> {
    if let Some(start) = pattern.find('{') {
        if let Some(end) = pattern[start..].find('}') {
            let end = start + end;
            let prefix = &pattern[..start];
            let suffix = &pattern[end + 1..];
            let alternatives: Vec<&str> = pattern[start + 1..end].split(',').collect();
            let mut result = Vec::new();
            for alt in &alternatives {
                let expanded = format!("{}{}{}", prefix, alt, suffix);
                result.extend(expand_braces(&expanded));
            }
            return result;
        }
    }
    vec![pattern.to_string()]
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_code(
    directory: String,
    pattern: String,
    file_types: Option<String>,
    max_results: Option<usize>,
    use_regex: Option<bool>,
    context_lines: Option<usize>,
    output_mode: Option<String>,
    show_line_numbers: Option<bool>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    glob_filter: Option<String>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let root = crate::utils::resolve_read_dispatch(&directory, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let is_regex = use_regex.unwrap_or(false);
    let regex = if is_regex {
        Some(regex::RegexBuilder::new(&pattern)
            .case_insensitive(true)
            .multi_line(true)
            .build()
            .map_err(|e| format!("正则表达式无效: {}", e))?)
    } else {
        None
    };
    let sub_patterns: Vec<String> = if is_regex {
        Vec::new()
    } else {
        pattern.to_lowercase().split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    };
    let extensions: Vec<String> = file_types
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let max = max_results.unwrap_or(50).min(200);
    let ctx = context_lines.unwrap_or(0).min(10);
    let mode = output_mode.unwrap_or_else(|| "content".into());
    let show_ln = show_line_numbers.unwrap_or(true);
    let head = head_limit.unwrap_or(250);
    let skip = offset.unwrap_or(0);
    let gfilter = glob_filter.clone();

    let pat = pattern.clone();
    tokio::task::spawn_blocking(move || {
        let mut results: Vec<serde_json::Value> = Vec::new();
        let mut file_sets: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut file_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let skip_extensions: Vec<&str> = vec![
            "exe", "dll", "so", "dylib", "bin", "o", "a",
            "png", "jpg", "jpeg", "gif", "ico", "svg",
            "woff", "woff2", "ttf", "eot",
            "zip", "tar", "gz", "bz2", "7z", "rar",
            "mp3", "mp4", "avi", "mov", "wav",
            "pdf", "doc", "docx", "xls", "xlsx",
            "pyc", "pyo", "class", "wasm",
            "lock", "map", "min.js", "min.css",
        ];

        // glob_filter 是相对于搜索根的路径模式。转成正则，
        // * 不跨目录（[^/]*），** 跨目录（.*），**/ 可选前缀。
        let glob_re: Option<regex::Regex> = gfilter.and_then(|gf| {
            let gf = gf.replace('\\', "/");
            let mut re = String::from("^");
            let chars: Vec<char> = gf.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                match chars[i] {
                    '*' => {
                        if i + 1 < chars.len() && chars[i + 1] == '*' {
                            if i + 2 < chars.len() && chars[i + 2] == '/' {
                                re.push_str("(?:.*/)?");
                                i += 3;
                            } else {
                                re.push_str(".*");
                                i += 2;
                            }
                        } else {
                            re.push_str("[^/]*");
                            i += 1;
                        }
                    }
                    '?' => { re.push_str("[^/]"); i += 1; }
                    '.' => { re.push_str("\\."); i += 1; }
                    '\\' => { re.push_str("\\\\"); i += 1; }
                    '+' => { re.push_str("\\+"); i += 1; }
                    '(' => { re.push_str("\\("); i += 1; }
                    ')' => { re.push_str("\\)"); i += 1; }
                    '[' => { re.push_str("\\["); i += 1; }
                    ']' => { re.push_str("\\]"); i += 1; }
                    '{' => { re.push_str("\\{"); i += 1; }
                    '}' => { re.push_str("\\}"); i += 1; }
                    '^' => { re.push_str("\\^"); i += 1; }
                    '$' => { re.push_str("\\$"); i += 1; }
                    '|' => { re.push_str("\\|"); i += 1; }
                    c => { re.push(c); i += 1; }
                }
            }
            re.push('$');
            regex::Regex::new(&re).ok()
        });

        // ── 扫描预算：防止在巨大目录树中无限遍历 ──
        const MAX_SCAN_FILES: usize = 20_000;
        const TIME_BUDGET_SECS: u64 = 60;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(TIME_BUDGET_SECS);
        let mut scanned_files: usize = 0;
        let mut truncated_by_budget = false;

        // 相对路径匹配用：去掉 root 前缀
        let root_str = root.to_string_lossy().replace('\\', "/");
        let root_str = root_str.trim_end_matches('/').to_string();

        for entry in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_entry(|e| {
                !e.file_type().is_dir() || !is_ignored_path(
                    &e.path().to_string_lossy().replace('\\', "/"),
                )
            })
        {
            // ── 预算检查 ──
            if scanned_files >= MAX_SCAN_FILES || std::time::Instant::now() > deadline {
                truncated_by_budget = true;
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            scanned_files += 1;

            let fp = entry.path();
            let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let name = fp.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if skip_extensions.iter().any(|skip| ext == *skip || name.ends_with(skip)) {
                continue;
            }
            if !extensions.is_empty() && !extensions.contains(&ext) {
                continue;
            }
            let fp_str = fp.to_string_lossy().to_string();
            if let Some(ref re) = &glob_re {
                // glob_filter 是相对模式 → 对 strip 掉 root 的相对路径匹配
                let rel = fp_str.replace('\\', "/");
                let rel = rel.strip_prefix(&root_str).unwrap_or(&rel);
                let rel = rel.trim_start_matches('/');
                if !re.is_match(rel) { continue; }
            }

            let content = match std::fs::read_to_string(fp) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let lines: Vec<&str> = content.lines().collect();

            let mut file_has_match = false;
            for (line_no, line) in lines.iter().enumerate() {
                let matched = if let Some(ref re) = regex {
                    re.is_match(line)
                } else {
                    let line_lower = line.to_lowercase();
                    sub_patterns.iter().any(|p| line_lower.contains(p))
                };
                if matched {
                    file_has_match = true;
                    *file_counts.entry(fp_str.clone()).or_insert(0) += 1;

                    if mode == "content" {
                        let start = line_no.saturating_sub(ctx);
                        let end = (line_no + ctx + 1).min(lines.len());
                        let context_block: Vec<serde_json::Value> = lines[start..end].iter().enumerate().map(|(i, l)| {
                            let ln = start + i + 1;
                            serde_json::json!({
                                "line": if show_ln { Some(ln) } else { None },
                                "content": l,
                                "is_match": ln == line_no + 1,
                            })
                        }).collect();
                        results.push(serde_json::json!({
                            "file": fp_str,
                            "match_line": line_no + 1,
                            "match_content": line,
                            "context": ctx,
                            "context_block": context_block,
                        }));
                    }
                    if results.len() >= max { break; }
                }
            }
            if file_has_match { file_sets.insert(fp_str.clone()); }
            // 在 files_with_matches/count 模式下找到足够匹配时提前退出
            if mode != "content" && file_sets.len() >= max {
                truncated_by_budget = true;
                break;
            }
            if results.len() >= max { break; }
        }

        let output = match mode.as_str() {
            "files_with_matches" => {
                let mut files: Vec<&String> = file_sets.iter().collect();
                files.sort();
                let total = files.len();
                let files = if head > 0 { files.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { files };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": (head > 0 && skip + head < total) || truncated_by_budget,
                    "scanned_files": scanned_files,
                    "budget_truncated": truncated_by_budget,
                    "files": files,
                })
            }
            "count" => {
                let mut counts: Vec<(&String, &usize)> = file_counts.iter().collect();
                counts.sort_by(|a, b| b.1.cmp(a.1));
                let total = counts.len();
                let counts = if head > 0 { counts.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { counts };
                serde_json::json!({
                    "pattern": pat,
                    "total_matches": file_counts.values().sum::<usize>(),
                    "file_count": total,
                    "truncated": (head > 0 && skip + head < total) || truncated_by_budget,
                    "scanned_files": scanned_files,
                    "budget_truncated": truncated_by_budget,
                    "files": counts.into_iter().map(|(f, c)| serde_json::json!({"file": f, "matches": c})).collect::<Vec<_>>(),
                })
            }
            _ => {
                let total = results.len();
                let results = if head > 0 { results.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { results };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": (head > 0 && skip + head < total) || truncated_by_budget,
                    "scanned_files": scanned_files,
                    "budget_truncated": truncated_by_budget,
                    "context_lines": ctx,
                    "results": results,
                })
            }
        };

        let mut output_val = output;
        if !is_regex {
            append_vector_hits(&mut output_val, &root, &pattern);
        }

        Ok(output_val.to_string())
    }).await.map_err(|e| format!("搜索任务失败: {e}"))?
}

/// 将向量（语义）搜索命中附加到输出。
/// 走引擎的进程级缓存索引（mtime 失效自动重载），不再每次从磁盘全量加载 8.8MB。
/// 与引擎 search_symbols 同一套过滤策略：低于后端阈值丢弃、最多 5 条。
fn append_vector_hits(output_val: &mut serde_json::Value, root: &std::path::Path, pattern: &str) {
    use hologram_engine::vector;
    let (index, slots) = match vector::get_or_load_index(root) {
        Ok(pair) => pair,
        Err(_) => return,
    };
    let idx = crate::utils::read_or_recover(&index);
    let idx = match idx.as_ref() {
        Some(i) => i,
        None => return,
    };
    let slot_data = crate::utils::read_or_recover(&slots);
    if slot_data.is_empty() { return; }

    let q_vec = vector::embed(pattern);
    let results = match idx.search(&q_vec, 20) {
        Ok(r) => r,
        Err(_) => return,
    };

    let threshold = vector::score_threshold();
    // usearch 按距离升序返回 → 相似度降序
    let raw: Vec<(String, f32)> = results.keys.iter().zip(results.distances.iter())
        .filter_map(|(slot_key, distance)| {
            let slot = *slot_key as usize;
            if slot >= slot_data.len() { return None; }
            let similarity = 1.0 - (*distance).min(2.0).max(0.0);
            Some((slot_data[slot].clone(), similarity))
        })
        .collect();
    // grep 结果与向量命中不同 id 空间，existing 传空集
    let hits = vector::filter_hits(&raw, threshold, 5, &std::collections::HashSet::new());
    if hits.is_empty() { return; }

    let vec_results: Vec<serde_json::Value> = hits.into_iter()
        .map(|(id, score)| serde_json::json!({"node_id": id, "score": (score * 100.0).round() as u32}))
        .collect();
    output_val["vector_hits"] = serde_json::json!(vec_results);
    output_val["vector_backend"] = serde_json::json!(vector::backend_id());
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
/// search_code 的别名 — 实现相同，作为独立的 Tauri 命令
/// 用于工具名兼容（Agent 工具：search_content、search_code）。
/// 如果 search_code 的行为变化，此命令自动继承。
pub(crate) async fn search_content(
    directory: String, pattern: String, file_types: Option<String>,
    max_results: Option<usize>, use_regex: Option<bool>,
    context_lines: Option<usize>, output_mode: Option<String>,
    show_line_numbers: Option<bool>, head_limit: Option<usize>,
    offset: Option<usize>, glob_filter: Option<String>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    search_code(
        directory, pattern, file_types, max_results, use_regex,
        context_lines, output_mode, show_line_numbers, head_limit,
        offset, glob_filter, is_agent, _agent_id, state, app,
    ).await
}

#[tauri::command]
pub(crate) async fn glob(
    pattern: String,
    path: Option<String>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // 默认搜索目录 = 当前工作区根（而非应用安装目录 project_root()），理由同 exec_command。
    let dir = match path {
        Some(p) => p,
        None => crate::utils::workspace_path(&state)?,
    };
    let root = crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;

    // 展开花括号表达式 ({a,b,c}) — glob crate 不支持它们。
    let expanded = expand_braces(&pattern);
    let glob_patterns: Vec<glob::Pattern> = expanded.iter()
        .map(|p| glob::Pattern::new(p).map_err(|e| format!("无效的 glob 模式 '{}': {}", p, e)))
        .collect::<Result<Vec<_>, _>>()?;
    let pat = pattern.clone();

    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", dir));
        }
        let mut results: Vec<crate::utils::GlobEntry> = Vec::new();
        let max = 200;

        for entry in walkdir::WalkDir::new(&root)
            .max_depth(12)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() { continue; }
            let entry_path = entry.path();
            let eps = entry_path.to_string_lossy();
            if eps.contains("/.git/") || eps.contains("\\.git\\")
                || eps.contains("/node_modules/") || eps.contains("\\node_modules\\")
                || eps.contains("/target/") || eps.contains("\\target\\")
                || eps.contains("/dist/") || eps.contains("\\dist\\")
                || eps.contains("/build/") || eps.contains("\\build\\")
                || eps.contains("/.hologram/") || eps.contains("\\.hologram\\")
            { continue; }

            let rel = entry_path.strip_prefix(&root).unwrap_or(entry_path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");

            if glob_patterns.iter().any(|gp| gp.matches(&rel_str)) {
                results.push(crate::utils::GlobEntry {
                    path: entry_path.to_string_lossy().to_string(),
                    name: rel.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| rel_str.clone()),
                });
            }
            if results.len() >= max { break; }
        }

        Ok(serde_json::json!({
            "pattern": pat,
            "count": results.len(),
            "truncated": results.len() >= max,
            "results": results,
        }).to_string())
    }).await.map_err(|e| format!("glob 任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_braces_simple() {
        let result = expand_braces("**/*.{ts,rs}");
        assert_eq!(result, vec!["**/*.ts", "**/*.rs"]);
    }

    #[test]
    fn test_expand_braces_no_brace() {
        let result = expand_braces("**/*.ts");
        assert_eq!(result, vec!["**/*.ts"]);
    }

    #[test]
    fn test_expand_braces_many_extensions() {
        let result = expand_braces("**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}");
        assert_eq!(result.len(), 13);
        assert!(result.contains(&"**/*.ts".to_string()));
        assert!(result.contains(&"**/*.json".to_string()));
        assert!(result.contains(&"**/*.yaml".to_string()));
    }

    #[test]
    fn test_expand_braces_nested() {
        let result = expand_braces("a/{b,c}/{d,e}");
        assert_eq!(result, vec!["a/b/d", "a/b/e", "a/c/d", "a/c/e"]);
    }

    #[test]
    fn test_expand_braces_single_alternative() {
        let result = expand_braces("src/{x}");
        assert_eq!(result, vec!["src/x"]);
    }

    #[test]
    fn test_expand_braces_empty_braces() {
        let result = expand_braces("src/{}");
        assert_eq!(result, vec!["src/"]);
    }

    #[test]
    fn test_expand_braces_at_start() {
        let result = expand_braces("{a,b}.ts");
        assert_eq!(result, vec!["a.ts", "b.ts"]);
    }

    /// 测试 glob→regex 转换函数（独立于 search_code，不依赖文件系统）。
    fn glob_to_regex(gf: &str) -> Option<regex::Regex> {
        let gf = gf.replace('\\', "/");
        let mut re = String::from("^");
        let chars: Vec<char> = gf.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '*' => {
                    if i + 1 < chars.len() && chars[i + 1] == '*' {
                        if i + 2 < chars.len() && chars[i + 2] == '/' {
                            re.push_str("(?:.*/)?");
                            i += 3;
                        } else {
                            re.push_str(".*");
                            i += 2;
                        }
                    } else {
                        re.push_str("[^/]*");
                        i += 1;
                    }
                }
                '?' => { re.push_str("[^/]"); i += 1; }
                '.' => { re.push_str("\\."); i += 1; }
                '\\' => { re.push_str("\\\\"); i += 1; }
                '+' => { re.push_str("\\+"); i += 1; }
                '(' => { re.push_str("\\("); i += 1; }
                ')' => { re.push_str("\\)"); i += 1; }
                '[' => { re.push_str("\\["); i += 1; }
                ']' => { re.push_str("\\]"); i += 1; }
                '{' => { re.push_str("\\{"); i += 1; }
                '}' => { re.push_str("\\}"); i += 1; }
                '^' => { re.push_str("\\^"); i += 1; }
                '$' => { re.push_str("\\$"); i += 1; }
                '|' => { re.push_str("\\|"); i += 1; }
                c => { re.push(c); i += 1; }
            }
        }
        re.push('$');
        regex::Regex::new(&re).ok()
    }

    #[test]
    fn test_glob_to_regex_simple_filename() {
        let re = glob_to_regex("config.py").expect("glob_to_regex failed");
        // 匹配搜索根下的 config.py
        assert!(re.is_match("config.py"));
        // 不匹配子目录中的同名文件（要用 **/config.py 才跨目录）
        assert!(!re.is_match("src/config.py"));
        // 不应匹配旧行为的完整绝对路径
        assert!(!re.is_match("D:/x/config.py"));
    }

    #[test]
    fn test_glob_to_regex_wildcard() {
        let re = glob_to_regex("core/*.py").expect("glob_to_regex failed");
        assert!(re.is_match("core/main.py"));
        assert!(re.is_match("core/utils.py"));
        // * 不跨目录
        assert!(!re.is_match("core/sub/main.py"));
    }

    #[test]
    fn test_glob_to_regex_double_star() {
        let re = glob_to_regex("**/*.rs").expect("glob_to_regex failed");
        assert!(re.is_match("main.rs"));
        assert!(re.is_match("src/main.rs"));
        assert!(re.is_match("src/engine/core/mod.rs"));
    }

    #[test]
    fn test_glob_to_regex_double_star_slash_prefix() {
        let re = glob_to_regex("**/test_*.py").expect("glob_to_regex failed");
        assert!(re.is_match("test_foo.py"));
        assert!(re.is_match("tests/test_foo.py"));
        assert!(re.is_match("a/b/tests/test_foo.py"));
    }

    #[test]
    fn test_glob_to_regex_question_mark() {
        let re = glob_to_regex("file?.txt").expect("glob_to_regex failed");
        assert!(re.is_match("file1.txt"));
        assert!(re.is_match("fileA.txt"));
        assert!(!re.is_match("file10.txt")); // ? 只匹配一个字符
        assert!(!re.is_match("file.txt"));   // 至少要一个字符
    }

    #[test]
    fn test_glob_to_regex_special_chars_escaped() {
        // + ( ) [ ] { } ^ $ | 都应被转义为字面字符
        let re = glob_to_regex("a+b(c)[d]{e}^f$g|h.txt").expect("glob_to_regex failed");
        // 如果转义正确，正则不会 panic，且能字面匹配
        assert!(re.is_match("a+b(c)[d]{e}^f$g|h.txt"));
        assert!(!re.is_match("aXb(c)[d]{e}^f$g|h.txt")); // 加号不是量词
    }
}