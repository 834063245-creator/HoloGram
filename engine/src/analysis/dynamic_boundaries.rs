// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Dynamic boundary detection — scans source code at flow breakpoints
//! for dynamic dispatch patterns that static analysis cannot resolve.
//!
//! When explore_deps' BFS cannot find a complete path between named symbols,
//! this module scans the breakpoint symbol's source for known patterns
//! (computed calls, reflection, event dispatch, etc.) and lists candidate targets.

use std::collections::HashSet;

/// A detected dynamic boundary at a flow breakpoint.
#[derive(Debug, Clone)]
pub struct BoundaryMatch {
    /// Pattern form identifier (e.g. "computed-call", "reflection")
    pub form: String,
    /// Human-readable label
    pub label: String,
    /// One line of source code at the dispatch site
    pub snippet: String,
    /// Absolute line number (1-based, within file)
    pub line: usize,
    /// Statically visible key/name, if extractable
    pub key: Option<String>,
    /// Whether the key is a type name
    pub key_is_type: bool,
    /// Count of additional dispatch sites of the same form
    pub more_sites: usize,
}

/// Pattern definitions for each language.
struct FormDef {
    id: &'static str,
    label: &'static str,
    langs: &'static [&'static str], // empty = ALL
    regex: &'static str,
}

const FORMS: &[FormDef] = &[
    // computed-call: obj[key](...)
    FormDef {
        id: "computed-call", label: "computed member call",
        langs: &[], regex: r#"[\w$)\]]\s*\[([^\[\]\n]{1,80})\]\s*\("#,
    },
    // reflection: .invoke / .getMethod / MethodByName / Class.forName
    FormDef {
        id: "reflection", label: "reflective dispatch",
        langs: &["java", "go", "csharp", "kt"],
        regex: r#"\.(?:invoke|get(?:Declared)?Method|GetMethod|MethodByName|Activator\.CreateInstance|Class\.forName)"#,
    },
    // proxy-reflect: Proxy/Reflect in JS
    FormDef {
        id: "proxy-reflect", label: "Proxy/Reflect",
        langs: &["javascript", "typescript", "tsx", "jsx"],
        regex: r#"\bnew\s+Proxy\s*\(|\bReflect\.(?:get|apply|construct)\s*\("#,
    },
    // typed-bus: .Send/.Publish/.Dispatch/.Execute/.Emit with typed arg
    FormDef {
        id: "typed-bus", label: "typed message dispatch",
        langs: &[],
        regex: r#"\.(?:[Ss]end|[Pp]ublish|[Dd]ispatch|[Ee]xecute|[Ee]mit)(?:Async)?\s*\(\s*new\s+([A-Z]\w*)"#,
    },
    // var-key-dispatch: .emit/.dispatch/.trigger/.fire/.publish/.broadcast with var key
    FormDef {
        id: "var-key-dispatch", label: "string-keyed dispatch",
        langs: &[],
        regex: r#"\.(?:emit|dispatch|trigger|fire|publish|broadcast)\s*\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+){0,3}\s*[,)]"#,
    },
    // getattr-call: Python getattr immediate call
    FormDef {
        id: "getattr-call", label: "getattr dispatch",
        langs: &["python"],
        regex: r#"getattr\s*\(\s*\w+\s*,\s*['\"][^'\"]+['\"]\s*\)\s*\("#,
    },
    // getattr-assign: Python getattr assigned then called
    FormDef {
        id: "getattr-assign", label: "getattr dispatch (assigned)",
        langs: &["python"],
        regex: r#"\w+\s*=\s*getattr\s*\(\s*\w+\s*,\s*['\"]([^'\"]+)['\"]"#,
    },
    // dynamic-import: JS import() / Python importlib
    FormDef {
        id: "dynamic-import", label: "dynamic import",
        langs: &[],
        regex: r#"\b(?:import|require)\s*\(\s*(?![\s'\"`])|importlib\.import_module\s*\(|\b__import__\s*\("#,
    },
];

/// Scan source code for dynamic dispatch patterns.
/// `language` is the language identifier (lowercase, e.g. "python", "javascript").
/// `file_start_line` is the absolute line number of the first line in `body` (1-based).
/// Returns up to 3 boundary matches (deduped by form + key).
pub fn scan_dynamic_boundaries(
    body: &str,
    language: &str,
    file_start_line: usize,
) -> Vec<BoundaryMatch> {
    let lang_lower = language.to_lowercase();
    let mut results: Vec<BoundaryMatch> = Vec::new();
    // Track (form, key) dedup — max 1 match per unique pair
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for form_def in FORMS {
        // Language gate: empty = ALL, else must contain this language
        if !form_def.langs.is_empty() && !form_def.langs.contains(&lang_lower.as_str()) {
            continue;
        }

        let Ok(re) = regex::Regex::new(form_def.regex) else { continue; };

        let mut sites_in_form = 0usize;
        let mut best_match: Option<BoundaryMatch> = None;

        for (line_idx, line) in body.lines().enumerate() {
            if let Some(caps) = re.captures(line) {
                sites_in_form += 1;
                if sites_in_form > 10 { break; } // cap per-form scanning

                let key = caps.get(1).map(|m| m.as_str().to_string());

                if best_match.is_none() {
                    // Prefer matches with extractable keys
                    best_match = Some(BoundaryMatch {
                        form: form_def.id.to_string(),
                        label: form_def.label.to_string(),
                        snippet: line.trim().to_string(),
                        line: file_start_line + line_idx,
                        key_is_type: form_def.id == "typed-bus",
                        more_sites: 0, // will fill later
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

/// Given a key extracted from a boundary match, search the graph for candidate targets.
/// Returns candidate node names (up to 10), sorted by name containment score.
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
            // If key is a type, prefer exact matches
            if key_is_type {
                n.name == key || n.name.ends_with(&format!(".{}", key)) || n.name.ends_with(&format!("::{}", key))
            } else {
                true
            }
        })
        .map(|n| {
            // Score: prefer names containing the key as a word
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
