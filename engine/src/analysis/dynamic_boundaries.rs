// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 动态边界检测 — 在流断点处扫描源码，
//! 查找静态分析无法解析的动态分派模式。
//!
//! 当 explore_deps 的 BFS 无法在命名符号之间找到完整路径时，
//! 此模块扫描断点符号的源码，查找已知模式
//!（计算调用、反射、事件分派等）并列出候选目标。

use std::collections::HashSet;

/// 流断点处检测到的动态边界。
#[derive(Debug, Clone)]
pub struct BoundaryMatch {
    /// 模式标识符（如 "computed-call"、"reflection"）
    pub form: String,
    /// 人类可读的标签
    pub label: String,
    /// 分派点处的一行源码
    pub snippet: String,
    /// 绝对行号（从 1 开始，文件内）
    pub line: usize,
    /// 静态可见的键/名称（如可提取）
    pub key: Option<String>,
    /// 该键是否为类型名
    pub key_is_type: bool,
    /// 同一模式的额外分派点数量
    pub more_sites: usize,
}

/// 每种语言的模式定义。
struct FormDef {
    id: &'static str,
    label: &'static str,
    langs: &'static [&'static str], // empty = ALL
    regex: &'static str,
}

const FORMS: &[FormDef] = &[
    // computed-call：obj[key](...)
    FormDef {
        id: "computed-call", label: "computed member call",
        langs: &[], regex: r#"[\w$)\]]\s*\[([^\[\]\n]{1,80})\]\s*\("#,
    },
    // reflection：.invoke / .getMethod / MethodByName / Class.forName
    FormDef {
        id: "reflection", label: "reflective dispatch",
        langs: &["java", "go", "csharp", "kt"],
        regex: r#"\.(?:invoke|get(?:Declared)?Method|GetMethod|MethodByName|Activator\.CreateInstance|Class\.forName)"#,
    },
    // proxy-reflect：JS 中的 Proxy/Reflect
    FormDef {
        id: "proxy-reflect", label: "Proxy/Reflect",
        langs: &["javascript", "typescript", "tsx", "jsx"],
        regex: r#"\bnew\s+Proxy\s*\(|\bReflect\.(?:get|apply|construct)\s*\("#,
    },
    // typed-bus：带类型参数的 .Send/.Publish/.Dispatch/.Execute/.Emit
    FormDef {
        id: "typed-bus", label: "typed message dispatch",
        langs: &[],
        regex: r#"\.(?:[Ss]end|[Pp]ublish|[Dd]ispatch|[Ee]xecute|[Ee]mit)(?:Async)?\s*\(\s*new\s+([A-Z]\w*)"#,
    },
    // var-key-dispatch：带变量键的 .emit/.dispatch/.trigger/.fire/.publish/.broadcast
    FormDef {
        id: "var-key-dispatch", label: "string-keyed dispatch",
        langs: &[],
        regex: r#"\.(?:emit|dispatch|trigger|fire|publish|broadcast)\s*\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+){0,3}\s*[,)]"#,
    },
    // getattr-call：Python getattr 直接调用
    FormDef {
        id: "getattr-call", label: "getattr dispatch",
        langs: &["python"],
        regex: r#"getattr\s*\(\s*\w+\s*,\s*['\"][^'\"]+['\"]\s*\)\s*\("#,
    },
    // getattr-assign：Python getattr 赋值后调用
    FormDef {
        id: "getattr-assign", label: "getattr dispatch (assigned)",
        langs: &["python"],
        regex: r#"\w+\s*=\s*getattr\s*\(\s*\w+\s*,\s*['\"]([^'\"]+)['\"]"#,
    },
    // dynamic-import：JS import() / Python importlib
    FormDef {
        id: "dynamic-import", label: "dynamic import",
        langs: &[],
        regex: r#"\b(?:import|require)\s*\(\s*(?![\s'\"`])|importlib\.import_module\s*\(|\b__import__\s*\("#,
    },
];

/// 扫描源码中的动态分派模式。
/// `language` 是语言标识符（小写，如 "python"、"javascript"）。
/// `file_start_line` 是 `body` 中第一行的绝对行号（从 1 开始）。
/// 返回最多 3 个边界匹配（按 form + key 去重）。
pub fn scan_dynamic_boundaries(
    body: &str,
    language: &str,
    file_start_line: usize,
) -> Vec<BoundaryMatch> {
    let lang_lower = language.to_lowercase();
    let mut results: Vec<BoundaryMatch> = Vec::new();
    // 跟踪 (form, key) 去重 — 每个唯一对最多 1 个匹配
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for form_def in FORMS {
        // 语言门控：空 = 全部，否则必须包含此语言
        if !form_def.langs.is_empty() && !form_def.langs.contains(&lang_lower.as_str()) {
            continue;
        }

        let Ok(re) = regex::Regex::new(form_def.regex) else { continue; };

        let mut sites_in_form = 0usize;
        let mut best_match: Option<BoundaryMatch> = None;

        for (line_idx, line) in body.lines().enumerate() {
            if let Some(caps) = re.captures(line) {
                sites_in_form += 1;
                if sites_in_form > 10 { break; } // 限制每种模式的扫描数量

                let key = caps.get(1).map(|m| m.as_str().to_string());

                if best_match.is_none() {
                    // 优先选择有可提取键的匹配
                    best_match = Some(BoundaryMatch {
                        form: form_def.id.to_string(),
                        label: form_def.label.to_string(),
                        snippet: line.trim().to_string(),
                        line: file_start_line + line_idx,
                        key_is_type: form_def.id == "typed-bus",
                        more_sites: 0, // 稍后填充
                        key,
                    });
                }
            }
        }

        if let Some(mut m) = best_match {
            m.more_sites = sites_in_form.saturating_sub(1);
            let dedup_key = m.key.clone().unwrap_or_default();
            if seen.insert((m.form.clone(), dedup_key)) {
                results.push(m);
            }
            if results.len() >= 3 { break; }
        }
    }

    results
}

/// 根据从边界匹配中提取的键，在 Graph 中搜索候选目标。
/// 返回候选节点名称（最多 10 个），按名称包含度评分排序。
pub fn boundary_candidates(
    graph: &crate::graph::Graph,
    key: &str,
    key_is_type: bool,
) -> Vec<String> {
    use crate::graph::query;

    if key.is_empty() {
        return Vec::new();
    }

    let candidates = query::search_nodes(graph, key);
    let mut scored: Vec<(usize, String)> = candidates.iter()
        .filter(|n| {
            // 如果键是类型，优先精确匹配
            if key_is_type {
                n.name == key || n.name.ends_with(&format!(".{}", key)) || n.name.ends_with(&format!("::{}", key))
            } else {
                true
            }
        })
        .map(|n| {
            // 评分：优先名称中包含该键作为单词的
            let score = if n.name == key { 100 }
                else if n.name.contains(key) { 50 }
                else { 10 };
            (score, n.name.clone())
        })
        .collect();

    scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
    scored.truncate(10);
    scored.into_iter().map(|(_, name)| name).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_computed_call() {
        let body = "const handler = this.listeners[eventName](data);";
        let matches = scan_dynamic_boundaries(body, "javascript", 1);
        assert!(!matches.is_empty());
        assert_eq!(matches[0].form, "computed-call");
    }

    #[test]
    fn test_scan_reflection_java() {
        let body = "Method m = clazz.getDeclaredMethod(name, paramTypes);\nm.invoke(instance, args);";
        let matches = scan_dynamic_boundaries(body, "java", 1);
        assert!(!matches.is_empty());
        assert_eq!(matches[0].form, "reflection");
    }

    #[test]
    fn test_scan_getattr_python() {
        let body = "handler = getattr(obj, 'handle_event', None)";
        let matches = scan_dynamic_boundaries(body, "python", 1);
        assert!(!matches.is_empty());
        assert_eq!(matches[0].form, "getattr-assign");
    }

    #[test]
    fn test_empty_body() {
        let matches = scan_dynamic_boundaries("", "javascript", 1);
        assert!(matches.is_empty());
    }

    #[test]
    fn test_max_three_results() {
        let body = "obj[key1]();\nobj[key2]();\nobj[key3]();\nobj[key4]();\nthis.listeners[e](d);";
        let matches = scan_dynamic_boundaries(body, "javascript", 1);
        assert!(matches.len() <= 3);
    }
}
