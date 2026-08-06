// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Policy check — 边界规则引擎。
// 用户定义规则（source_pattern, target_pattern, edge_kinds），引擎
// 检查依赖图中是否存在违规。与通用 Graph 查询不同，此处
// 融合了项目特定的"禁止"边界规则。
//
// 规则示例：
//   { "name": "no-cross-module-import", "source": "modules/foo/**",
//     "target": "modules/bar/**", "edge_kinds": ["imports"],
//     "message": "禁止跨模块直接import" }
//
// Pattern 为正则表达式。简单 glob（*、**、?）会自动转换。

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde::Serialize;

use crate::graph::EdgeKind;
use crate::storage::MemoryIndex;

// ── 输出类型 ──

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

// ── 内部规则表示 ──

struct PolicyRule {
    name: String,
    source_re: Regex,
    target_re: Regex,
    edge_kinds: Vec<EdgeKind>,
    message: String,
}

// ── 辅助函数 ──

/// 从节点位置字符串中提取文件路径。
/// 同时处理 "path/to/file.rs:42"（行号后缀）和
/// "C:\\path\\to\\file.rs:42"（Windows 驱动器号 + 行号）两种格式。
fn extract_file(location: &str) -> &str {
    // 查找最后一个 ':' — 如果其后全为数字，则为行号。
    if let Some(pos) = location.rfind(':') {
        let after = &location[pos + 1..];
        if !after.is_empty() && after.chars().all(|c| c.is_ascii_digit()) {
            return &location[..pos];
        }
    }
    location
}

/// 将模式字符串转换为编译后的正则表达式。
/// 如果模式包含显式的正则元字符（^ $ [ ( \ + {），
/// 则直接作为正则表达式处理。否则，将 glob 通配符转换：
///   ** → .*  （匹配路径分隔符）
///   *  → [^/\\]* （单个路径段）
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

    // Glob → 正则转换
    let mut re_str = String::with_capacity(pattern.len() + 4);
    re_str.push('^');

    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                re_str.push_str(".*"); // ** 匹配所有内容
                i += 2;
                continue;
            }
            re_str.push_str("[^/\\\\]*"); // * 匹配单个路径段内的内容
            i += 1;
            continue;
        }
        if chars[i] == '?' {
            re_str.push_str("[^/\\\\]");
            i += 1;
            continue;
        }
        // 转义正则元字符
        if ".+()[]{}^$|\\".contains(chars[i]) {
            re_str.push('\\');
        }
        re_str.push(chars[i]);
        i += 1;
    }

    re_str.push('$');
    Regex::new(&re_str).map_err(|e| format!("Invalid glob pattern '{}': {}", pattern, e))
}

/// 从 JSON 解析规则定义。接受单个对象或数组。
fn parse_rules(rules_json: &serde_json::Value) -> Result<Vec<PolicyRule>, String> {
    let arr = if rules_json.is_array() {
        rules_json.as_array().unwrap()
    } else if rules_json.is_object() {
        // 单个规则对象 → 包装为 vec
        // 无法通过 as_array 获取 &Vec，因此通过原始指针转换处理
        // 最简单的方式：返回包含一个元素的 vec，在下方解析
        // 但需要切片。改为单独处理单对象情况。
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
                .filter_map(EdgeKind::from_str)
                .collect()
        } else {
            vec![EdgeKind::Imports] // 默认：仅检查 imports
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

// ── 主入口点 ──

pub fn policy_check_from_index(
    idx: &MemoryIndex,
    rules_json: &serde_json::Value,
) -> serde_json::Value {
    let rules = match parse_rules(rules_json) {
        Ok(r) => r,
        Err(e) => return serde_json::json!({"error": e}),
    };

    // 构建 node_id → file_path 查找表（遍历所有节点一次）。
    // 跳过无位置的节点（Medium、Temporal 等）。
    let node_file: HashMap<String, String> = {
        let mut map = HashMap::new();
        for node in idx.nodes_iter() {
            if let Some(ref loc) = node.location {
                map.insert(node.id.as_str().to_owned(), extract_file(loc).to_string());
            }
        }
        map
    };

    // 按文件预分组源节点以便高效查找。
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

        // 查找路径匹配 source_pattern 的所有文件
        for (src_file, src_node_ids) in &file_nodes {
            if !rule.source_re.is_match(src_file) {
                continue;
            }

            // 检查此文件中每个节点的出边
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

                    // 去重：每条规则每个 (source_file, target_file) 对仅报告一次违规
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

// ── 测试 ──

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

        // 同一模块内的两个文件 — 无跨模块边
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

        // 同一源文件中的多个节点
        idx.insert_node(make_node("n1a", "fn_a", NodeKind::Function, "modules/foo/api.py"));
        idx.insert_node(make_node("n1b", "fn_b", NodeKind::Function, "modules/foo/api.py"));
        // 同一目标文件中的多个节点
        idx.insert_node(make_node("n2a", "fn_x", NodeKind::Function, "modules/bar/lib.py"));
        idx.insert_node(make_node("n2b", "fn_y", NodeKind::Function, "modules/bar/lib.py"));

        // 同一文件对间的多条边 → 应合并为 1 条违规
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
        // Imports 边
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
        // Calls 边，但规则仅检查 imports
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

        // 规则 1 违规：foo/backend → bar/backend（跨模块）
        idx.insert_node(make_node("n1", "fn_a", NodeKind::Function, "modules/foo/backend/api.py"));
        idx.insert_node(make_node("n2", "fn_b", NodeKind::Function, "modules/bar/backend/internal.py"));
        idx.upsert_edge("n1", "n2", EdgeKind::Imports, 1, None);

        // 规则 2 应通过：n3→n4 为同模块，不触及框架
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
        assert_eq!(result["passed"], false); // 规则 1 有违规

        // 规则 1：应有违规（foo→bar）
        assert_eq!(result["rules_detail"][0]["name"], "no-cross-module-import");
        assert_eq!(result["rules_detail"][0]["passed"], false);
        assert_eq!(result["rules_detail"][0]["violation_count"], 1);

        // 规则 2：应通过（无 module→framework 边）
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
