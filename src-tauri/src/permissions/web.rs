// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WebFetch 权限检查 — 域名规则 + SSRF 防护 (spec §4.2: WebFetchTool)
use crate::permissions::rule::PermissionRules;
use crate::permissions::PermissionResult;

/// 检查 web_fetch URL 的权限规则。
/// 由 WebFetchTool.check_permissions() 调用。
pub fn check(url: &str, rules: &PermissionRules) -> PermissionResult {
    // 1. 内容级 Deny 规则
    if let Some(rule) = rules.find_deny("WebFetch", Some(url)) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 2. 内容级 Allow 规则 — 用户/会话/项目规则覆盖系统 Ask
    if rules.find_allow("WebFetch", Some(url)).is_some() {
        return PermissionResult::Allow;
    }

    // 3. 内容级 Ask 规则 — 仅在没有 Allow 规则匹配时到达
    if let Some(rule) = rules.find_ask("WebFetch", Some(url)) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("WebFetch({})", url),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        };
    }

    // 4. Passthrough — 引擎的默认 SSRF 检查处理其余部分
    PermissionResult::Passthrough
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::rule::{parse_rule_value, Behavior, PermissionRule, RuleSource};

    #[test]
    fn test_web_fetch_localhost_deny() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("WebFetch(0.0.0.0:*)"),
            danger: None,
        });
        let r = check("http://0.0.0.0:8080/status", &rules);
        assert!(matches!(r, PermissionResult::Deny { .. }));
    }

    #[test]
    fn test_web_fetch_passthrough() {
        let rules = PermissionRules::new();
        let r = check("https://example.com", &rules);
        assert!(matches!(r, PermissionResult::Passthrough));
    }

    // ── E2: 额外的 web 权限测试 ──

    #[test]
    fn test_web_fetch_allow_rule() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::Project,
            behavior: Behavior::Allow,
            value: parse_rule_value("WebFetch(https://api.github.com/*)"),
            danger: None,
        });
        let r = check("https://api.github.com/repos/rust-lang/rust", &rules);
        assert!(
            matches!(r, PermissionResult::Allow),
            "Allow rule should permit matching URL, got: {:?}", r
        );
    }

    #[test]
    fn test_web_fetch_ask_rule() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::Session,
            behavior: Behavior::Ask,
            value: parse_rule_value("WebFetch(http://internal.corp/*)"),
            danger: None,
        });
        let r = check("http://internal.corp/dashboard", &rules);
        match r {
            PermissionResult::Ask { suggestions, .. } => {
                assert!(!suggestions.is_empty(), "Ask must include a suggestion");
                assert!(
                    suggestions[0].rule.starts_with("WebFetch("),
                    "suggestion should be WebFetch(url)"
                );
            }
            other => panic!("expected Ask, got: {:?}", other),
        }
    }

    #[test]
    fn test_web_fetch_deny_overrides_allow() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::Project,
            behavior: Behavior::Allow,
            value: parse_rule_value("WebFetch(*://*:*)"),
            danger: None,
        });
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("WebFetch(127.0.0.1:*)"),
            danger: None,
        });
        // Deny 优先于 Allow
        let r = check("http://127.0.0.1:3000/admin", &rules);
        assert!(
            matches!(r, PermissionResult::Deny { .. }),
            "Deny rule must take priority over Allow, got: {:?}", r
        );
    }

    #[test]
    fn test_web_fetch_localhost_variants_deny() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("WebFetch(127.0.0.1:*)"),
            danger: None,
        });
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("WebFetch(localhost:*)"),
            danger: None,
        });
        // IPv4 回环地址
        assert!(matches!(check("http://127.0.0.1:8080", &rules), PermissionResult::Deny { .. }));
        // localhost 主机名
        assert!(matches!(check("http://localhost:3000/api", &rules), PermissionResult::Deny { .. }));
        // 非回环 URL 不受影响
        assert!(matches!(check("https://example.com", &rules), PermissionResult::Passthrough));
    }
}