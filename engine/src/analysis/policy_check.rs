// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Policy check — boundary rule engine.
// Users define rules (source_pattern, target_pattern, edge_kinds) and the engine
// checks the dependency graph for violations. Unlike generic graph queries, this
// incorporates project-specific "thou shalt not" boundary rules.
//
// Example rule:
//   { "name": "no-cross-module-import", "source": "modules/foo/**",
//     "target": "modules/bar/**", "edge_kinds": ["imports"],
//     "message": "禁止跨模块直接import" }
//
// Patterns are regex. Simple globs (*, **, ?) are auto-converted.

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde::Serialize;

use crate::graph::EdgeKind;
use crate::storage::MemoryIndex;

// ── output types ──

#[derive(Debug, Clone, Serialize)]
pub struct PolicyViolation {
    pub rule: String,
    pub message: String,
    pub source_file: String,
    pub target_file: String,
    pub edge_kind: String,
    pub source_node_id: String,
    pub target_node_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuleDetail {
    pub name: String,
    pub passed: bool,
    pub violation_count: usize,
}

// ── internal rule representation ──

struct PolicyRule {
    name: String,
    source_re: Regex,
    target_re: Regex,
    edge_kinds: Vec<EdgeKind>,
    message: String,
}

// ── helpers ──

/// Extract the file path from a node location string.
/// Handles both "path/to/file.rs:42" (line number suffix) and
/// "C:\\path\\to\\file.rs:42" (Windows drive letter + line number).
fn extract_file(location: &str) -> &str {
    // Find the last ':' — if everything after it is digits, it's a line number.
    if let Some(pos) = location.rfind(':') {
        let after = &location[pos + 1..];
        if !after.is_empty() && after.chars().all(|c| c.is_ascii_digit()) {
            return &location[..pos];
        }
    }
    location
}

/// Convert a pattern string to a compiled regex.
/// If the pattern contains explicit regex metacharacters (^ $ [ ( \ + {),
/// it's treated as a regex directly. Otherwise, glob wildcards are converted:
///   ** → .*  (matches path separators)
///   *  → [^/\\]* (single path segment)
///   ?  → [^/\\]
fn compile_pattern(pattern: &str) -> Result<Regex, String> {
    let looks_like_regex = pattern.contains('^')
        || pattern.contains('$')
        || pattern.contains('[')
        || pattern.contains('(')
        || pattern.contains('\\')
        || pattern.contains('+')
        || pattern.contains('{');

    if looks_like_regex {
        return Regex::new(pattern)
            .map_err(|e| format!("Invalid regex '{}': {}", pattern, e));
    }

    // Glob → regex conversion
    let mut re_str = String::with_capacity(pattern.len() + 4);
    re_str.push('^');

    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                re_str.push_str(".*"); // ** matches everything
                i += 2;
                continue;
            }
            re_str.push_str("[^/\\\\]*"); // * matches within a path segment
            i += 1;
            continue;
        }
        if chars[i] == '?' {
            re_str.push_str("[^/\\\\]");
            i += 1;
            continue;
        }
        // Escape regex metacharacters
        if ".+()[]{}^$|\\".contains(chars[i]) {
            re_str.push('\\');
        }
        re_str.push(chars[i]);
        i += 1;
    }

    re_str.push('$');
    Regex::new(&re_str).map_err(|e| format!("Invalid glob pattern '{}': {}", pattern, e))
}

/// Parse rule definitions from JSON. Accepts either a single object or an array.
fn parse_rules(rules_json: &serde_json::Value) -> Result<Vec<PolicyRule>, String> {
    let arr = if rules_json.is_array() {
        rules_json.as_array().unwrap()
    } else if rules_json.is_object() {
        // Single rule object → wrap in vec
        // This can't actually be a &Vec from as_array, so we handle via raw pointer cast
        // Actually the simplest way: just return a vec with one element parsed below
        // But we need a slice. Let's handle the single-object case differently.
        return parse_rules(&serde_json::json!([rules_json]));
    } else {
        return Err("rules must be a JSON array or object".to_string());
    };

    let mut rules = Vec::with_capacity(arr.len());
    for rule in arr {
        let name = rule
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unnamed")
            .to_string();

        let source_pattern = rule
            .get("source")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Rule '{}': missing 'source' pattern", name))?;

        let target_pattern = rule
            .get("target")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Rule '{}': missing 'target' pattern", name))?;

        let source_re = compile_pattern(source_pattern)?;
        let target_re = compile_pattern(target_pattern)?;

        let edge_kinds: Vec<EdgeKind> = if let Some(kinds) =
            rule.get("edge_kinds").and_then(|v| v.as_array())
        {
            kinds
                .iter()
                .filter_map(|k| k.as_str())
                .filter_map(|k| EdgeKind::from_str(k))
                .collect()
        } else {
            vec![EdgeKind::Imports] // default: check imports only
        };

        if edge_kinds.is_empty() {
            return Err(format!(
                "Rule '{}': no valid edge_kinds (check spelling)",
                name
            ));
        }

        let message = rule
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("边界规则违规")
            .to_string();

        rules.push(PolicyRule {
            name,
            source_re,
            target_re,
            edge_kinds,
            message,
        });
    }

    Ok(rules)
}

// ── main entry point ──

pub fn policy_check_from_index(
    idx: &MemoryIndex,
    rules_json: &serde_json::Value,
) -> serde_json::Value {
    let rules = match parse_rules(rules_json) {
        Ok(r) => r,
        Err(e) => return serde_json::json!({"error": e}),
    };

    // Build node_id → file_path lookup (one pass over all nodes).
    // Skips nodes without locations (Medium, Temporal, etc.).
    let node_file: HashMap<String, String> = {
        let mut map = HashMap::new();
        for node in idx.nodes_iter() {
            if let Some(ref loc) = node.location {
                map.insert(node.id.clone(), extract_file(loc).to_string());
            }
        }
        map
    };

    // Pre-group source nodes by file for efficient lookup.
    // file_path → Vec<node_id>
    let mut file_nodes: HashMap<String, Vec<String>> = HashMap::new();
    for (nid, file) in &node_file {
        file_nodes
            .entry(file.clone())
            .or_default()
            .push(nid.clone());
    }

    let mut all_violations: Vec<PolicyViolation> = Vec::new();
    let mut rules_detail: Vec<RuleDetail> = Vec::new();

    for rule in &rules {
        let mut rule_violations: Vec<PolicyViolation> = Vec::new();
        let mut seen_pairs: HashSet<(String, String)> = HashSet::new();

        // Find all files whose path matches source_pattern
        for (src_file, src_node_ids) in &file_nodes {
            if !rule.source_re.is_match(src_file) {
                continue;
            }

            // Check outgoing edges from every node in this file
            for src_id in src_node_ids {
                let outgoing = idx.outgoing(src_id, Some(&rule.edge_kinds));
                for (tgt_id, kind, _, _) in outgoing {
                    let tgt_file = match node_file.get(tgt_id.as_str()) {
                        Some(f) => f,
                        None => continue,
                    };

                    if !rule.target_re.is_match(tgt_file) {
                        continue;
                    }

                    // Dedup: one violation per (source_file, target_file) pair per rule
                    let pair = (src_file.clone(), tgt_file.clone());
                    if !seen_pairs.insert(pair) {
                        continue;
                    }

                    rule_violations.push(PolicyViolation {
                        rule: rule.name.clone(),
                        message: rule.message.clone(),
                        source_file: src_file.clone(),
                        target_file: tgt_file.clone(),
                        edge_kind: kind.as_str().to_string(),
                        source_node_id: src_id.clone(),
                        target_node_id: tgt_id.clone(),
                    });
                }
            }
        }

        let passed = rule_violations.is_empty();
        rules_detail.push(RuleDetail {
            name: rule.name.clone(),
            passed,
            violation_count: rule_violations.len(),
        });
        all_violations.extend(rule_violations);
    }

    let total_passed = rules_detail.iter().all(|r| r.passed);
    let total_violations = all_violations.len();
    let failed_count = rules_detail.iter().filter(|r| !r.passed).count();

    serde_json::json!({
        "rules_checked": rules.len(),
        "passed": total_passed,
        "violations": all_violations,
        "summary": if total_passed {
            format!("全部 {} 条规则通过，未发现违规", rules.len())
        } else {
            format!("{} / {} 条规则发现 {} 处违规",
                failed_count, rules.len(), total_violations)
        },
        "rules_detail": rules_detail,
    })
}

// ── tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{EdgeKind, Node, NodeKind};

    fn make_node(id: &str, name: &str, kind: NodeKind, location: &str) -> Node {
        let mut n = Node::new(id, name, kind);
        n.location = Some(location.to_string());
        n
    }

    #[test]
    fn test_extract_file_unix() {
        assert_eq!(extract_file("src/main.rs"), "src/main.rs");
        assert_eq!(extract_file("src/main.rs:42"), "src/main.rs");
        assert_eq!(extract_file("a/b/c.ts:100"), "a/b/c.ts");
    }

    #[test]
    fn test_extract_file_windows() {
        assert_eq!(extract_file("C:\\src\\main.rs:42"), "C:\\src\\main.rs");
        assert_eq!(extract_file("D:\\project\\foo.rs"), "D:\\project\\foo.rs");
        assert_eq!(
            extract_file("C:\\a\\b.py:999"),
            "C:\\a\\b.py"
        );
    }

    #[test]
    fn test_extract_file_no_line() {
        assert_eq!(extract_file("foo/bar.ts"), "foo/bar.ts");
    }

    #[test]
    fn test_compile_pattern_glob_double_star() {
        let re = compile_pattern("modules/*/backend/**").unwrap();
        assert!(re.is_match("modules/foo/backend/router.py"));
        assert!(re.is_match("modules/foo/backend/sub/deep/file.py"));
        assert!(!re.is_match("frontend/src/app.ts"));
    }

    #[test]
    fn test_compile_pattern_glob_single_star() {
        let re = compile_pattern("modules/*/**.ts").unwrap();
        assert!(re.is_match("modules/foo/index.ts"));
        assert!(re.is_match("modules/foo/sub/deep.ts"));
        assert!(!re.is_match("modules/foo/backend.py"));
    }

    #[test]
    fn test_compile_pattern_exact() {
        let re = compile_pattern("backend/app/router.py").unwrap();
        assert!(re.is_match("backend/app/router.py"));
        assert!(!re.is_match("backend/app/other.py"));
    }

    #[test]
    fn test_compile_pattern_regex() {
        let re = compile_pattern(r"^modules/(foo|bar)/.*\.py$").unwrap();
        assert!(re.is_match("modules/foo/api.py"));
        assert!(re.is_match("modules/bar/utils.py"));
        assert!(!re.is_match("modules/baz/api.py"));
    }

    #[test]
    fn test_policy_check_all_pass() {
        let mut idx = MemoryIndex::new();

        // Two files in same module — no cross-module edges
        idx.insert_node(make_node("n1", "fn_a", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n2", "fn_b", NodeKind::Function, "modules/foo/utils.py"));
        idx.upsert_edge("n1", "n2", EdgeKind::Imports, 1, None);

        let rules = serde_json::json!([{
            "name": "no-cross-module-import",
            "source": "modules/foo/**",
            "target": "modules/bar/**",
            "edge_kinds": ["imports"],
            "message": "禁止跨模块import"
        }]);

        let result = policy_check_from_index(&idx, &rules);
        assert_eq!(result["passed"], true);
        assert_eq!(result["rules_checked"], 1);
        assert_eq!(result["violations"].as_array().unwrap().len(), 0);
        assert_eq!(result["rules_detail"][0]["passed"], true);
    }

    #[test]
    fn test_policy_check_violation_found() {
        let mut idx = MemoryIndex::new();

        idx.insert_node(make_node("n1", "fn_a", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n2", "fn_b", NodeKind::Function, "modules/bar/internal.py"));
        idx.upsert_edge("n1", "n2", EdgeKind::Imports, 1, None);

        let rules = serde_json::json!([{
            "name": "no-cross-module-import",
            "source": "modules/foo/**",
            "target": "modules/bar/**",
            "edge_kinds": ["imports"],
            "message": "禁止跨模块import"
        }]);

        let result = policy_check_from_index(&idx, &rules);
        assert_eq!(result["passed"], false);
        let vs = result["violations"].as_array().unwrap();
        assert_eq!(vs.len(), 1);
        assert_eq!(vs[0]["rule"], "no-cross-module-import");
        assert_eq!(vs[0]["source_file"], "modules/foo/api.py");
        assert_eq!(vs[0]["target_file"], "modules/bar/internal.py");
        assert_eq!(vs[0]["edge_kind"], "imports");
    }

    #[test]
    fn test_policy_check_dedup_file_pairs() {
        let mut idx = MemoryIndex::new();

        // Multiple nodes in same source file
        idx.insert_node(make_node("n1a", "fn_a", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n1b", "fn_b", NodeKind::Function, "modules/foo/api.py"));
        // Multiple nodes in same target file
        idx.insert_node(make_node("n2a", "fn_x", NodeKind::Function, "modules/bar/lib.py"));
        idx.insert_node(make_node("n2b", "fn_y", NodeKind::Function, "modules/bar/lib.py"));

        // Multiple edges between same file pair → should collapse to 1 violation
        idx.upsert_edge("n1a", "n2a", EdgeKind::Imports, 1, None);
        idx.upsert_edge("n1b", "n2b", EdgeKind::Imports, 1, None);

        let rules = serde_json::json!([{
            "name": "no-cross-module-import",
            "source": "modules/foo/**",
            "target": "modules/bar/**",
            "edge_kinds": ["imports"],
            "message": "禁止跨模块import"
        }]);

        let result = policy_check_from_index(&idx, &rules);
        let vs = result["violations"].as_array().unwrap();
        assert_eq!(vs.len(), 1, "should dedup to 1 violation per file pair, got {:?}", vs);
    }

    #[test]
    fn test_policy_check_multiple_edge_kinds() {
        let mut idx = MemoryIndex::new();

        idx.insert_node(make_node("n1", "fn_a", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n2", "fn_b", NodeKind::Function, "modules/bar/internal.py"));
        // Imports edge
        idx.upsert_edge("n1", "n2", EdgeKind::Imports, 1, None);

        let rules = serde_json::json!([{
            "name": "no-cross-module-access",
            "source": "modules/foo/**",
            "target": "modules/bar/**",
            "edge_kinds": ["imports", "calls", "reads", "writes"],
            "message": "禁止跨模块任何形式的直接依赖"
        }]);

        let result = policy_check_from_index(&idx, &rules);
        assert_eq!(result["passed"], false);
        let vs = result["violations"].as_array().unwrap();
        assert_eq!(vs.len(), 1);
    }

    #[test]
    fn test_policy_check_ignores_wrong_edge_kind() {
        let mut idx = MemoryIndex::new();

        idx.insert_node(make_node("n1", "fn_a", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n2", "fn_b", NodeKind::Function, "modules/bar/internal.py"));
        // Calls edge, but rule only checks imports
        idx.upsert_edge("n1", "n2", EdgeKind::Calls, 1, None);

        let rules = serde_json::json!([{
            "name": "no-cross-module-import",
            "source": "modules/foo/**",
            "target": "modules/bar/**",
            "edge_kinds": ["imports"],
            "message": "禁止跨模块import"
        }]);

        let result = policy_check_from_index(&idx, &rules);
        assert_eq!(result["passed"], true, "calls edge should not trigger imports-only rule");
    }

    #[test]
    fn test_policy_check_multiple_rules() {
        let mut idx = MemoryIndex::new();

        // Rule 1 violation: foo/backend → bar/backend (cross-module)
        idx.insert_node(make_node("n1", "fn_a", NodeKind::Function, "modules/foo/backend/api.py"));
        idx.insert_node(make_node("n2", "fn_b", NodeKind::Function, "modules/bar/backend/internal.py"));
        idx.upsert_edge("n1", "n2", EdgeKind::Imports, 1, None);

        // Rule 2 should pass: n3→n4 is same-module, not touching framework
        idx.insert_node(make_node("n3", "fn_c", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n4", "fn_d", NodeKind::Function, "modules/foo/utils.py"));
        idx.upsert_edge("n3", "n4", EdgeKind::Imports, 1, None);

        let rules = serde_json::json!([
            {
                "name": "no-cross-module-import",
                "source": "modules/*/backend/**",
                "target": "modules/*/backend/**",
                "edge_kinds": ["imports"],
                "message": "禁止跨模块import"
            },
            {
                "name": "no-import-framework-internals",
                "source": "modules/**",
                "target": "backend/app/services/**",
                "edge_kinds": ["imports"],
                "message": "模块不能import框架内部实现"
            }
        ]);

        let result = policy_check_from_index(&idx, &rules);
        assert_eq!(result["rules_checked"], 2);
        assert_eq!(result["passed"], false); // Rule 1 has a violation

        // Rule 1: should have violation (foo→bar)
        assert_eq!(result["rules_detail"][0]["name"], "no-cross-module-import");
        assert_eq!(result["rules_detail"][0]["passed"], false);
        assert_eq!(result["rules_detail"][0]["violation_count"], 1);

        // Rule 2: should pass (no module→framework edge)
        assert_eq!(result["rules_detail"][1]["passed"], true);
    }

    #[test]
    fn test_policy_check_empty_rules() {
        let idx = MemoryIndex::new();
        let rules = serde_json::json!([]);
        let result = policy_check_from_index(&idx, &rules);
        assert_eq!(result["rules_checked"], 0);
        assert_eq!(result["passed"], true);
    }

    #[test]
    fn test_policy_check_invalid_pattern() {
        let idx = MemoryIndex::new();
        let rules = serde_json::json!([{
            "name": "bad-rule",
            "source": "[invalid(regex",
            "target": "**",
            "message": "bad"
        }]);
        let result = policy_check_from_index(&idx, &rules);
        assert!(result["error"].as_str().is_some(), "should return error for invalid pattern");
    }
}
