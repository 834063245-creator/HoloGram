// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Search & glob — coding agent tools.

use hologram_engine::pipeline::discovery::is_ignored_path;

/// Expand brace expressions in a glob pattern.
/// "**/*.{ts,rs}" → ["**/*.ts", "**/*.rs"]
/// Supports nested braces: "a/{b,c}/{d,e}" expands correctly.
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
    if let Some(id) = &_agent_id {
        crate::permissions::set_active_agent_id(id);
    }
    let root = crate::utils::resolve_read_dispatch(&directory, is_agent.unwrap_or(false), &state, &app).await?;
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

        let glob_re: Option<regex::Regex> = gfilter.and_then(|gf| {
            let pat = gf.replace(".", "\\.").replace("*", ".*").replace("?", ".");
            regex::Regex::new(&format!("^{}$", pat)).ok()
        });

        for entry in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_entry(|e| {
                !e.file_type().is_dir() || !is_ignored_path(
                    &e.path().to_string_lossy().replace('\\', "/"),
                )
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let fp = entry.path();
            let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let name = fp.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if skip_extensions.iter().any(|skip| ext == *skip || name.ends_with(skip)) {
                continue;
            }
            if !extensions.is_empty() && !extensions.iter().any(|e| ext == *e) {
                continue;
            }
            let fp_str = fp.to_string_lossy().to_string();
            if let Some(ref re) = &glob_re {
                if !re.is_match(&fp_str) { continue; }
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
                    "truncated": head > 0 && skip + head < total,
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
                    "truncated": head > 0 && skip + head < total,
                    "files": counts.into_iter().map(|(f, c)| serde_json::json!({"file": f, "matches": c})).collect::<Vec<_>>(),
                })
            }
            _ => {
                let total = results.len();
                let results = if head > 0 { results.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { results };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": head > 0 && skip + head < total,
                    "context_lines": ctx,
                    "results": results,
                })
            }
        };

        let mut output_val = output;
        if !is_regex {
            let vector_path = std::path::Path::new(&root).join(".hologram").join("vectors.usearch");
            let vi = hologram_engine::vector::CodeVectorIndex::new(&vector_path);
            if vi.exists_on_disk() {
                if let Ok(n) = vi.load() {
                    if n > 0 {
                        if let Ok(hits) = vi.search(&pattern, 10) {
                            if !hits.is_empty() {
                                let vec_results: Vec<serde_json::Value> = hits.into_iter()
                                    .map(|(id, score)| serde_json::json!({"node_id": id, "score": (score * 100.0).round() as u32}))
                                    .collect();
                                output_val["vector_hits"] = serde_json::json!(vec_results);
                            }
                        }
                    }
                }
            }
        }

        Ok(output_val.to_string())
    }).await.map_err(|e| format!("搜索任务失败: {e}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
/// Alias for search_code — identical implementation, separate Tauri command
/// for tool name compatibility (Agent tools: search_content, search_code).
/// If search_code's behavior changes, this inherits it automatically.
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
    if let Some(id) = &_agent_id {
        crate::permissions::set_active_agent_id(id);
    }
    let dir = path.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());
    let root = crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), &state, &app).await?;

    // Expand brace expressions ({a,b,c}) — the glob crate doesn't support them.
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
}