// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WebFetch 权限检查 — 域名规则 + SSRF 防护 (spec §4.2: WebFetchTool)
use crate::permissions::rule::PermissionRules;
use crate::permissions::PermissionResult;

/// Check web_fetch URL permission against rules.
/// Called by WebFetchTool.check_permissions().
pub fn check(url: &str, rules: &PermissionRules) -> PermissionResult {
    // 1. Content-level Deny rules
    if let Some(rule) = rules.find_deny("WebFetch", Some(url)) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 2. Content-level Allow rules — user/session/project rules override system Ask
    if rules.find_allow("WebFetch", Some(url)).is_some() {
        return PermissionResult::Allow;
    }

    // 3. Content-level Ask rules — only reached if no Allow rule matched
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

    // 4. Passthrough — engine's default SSRF check handles the rest
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

    // ── E2: Additional web permission tests ──

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
        // Deny wins over Allow
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
        // IPv4 loopback
        assert!(matches!(check("http://127.0.0.1:8080", &rules), PermissionResult::Deny { .. }));
        // localhost hostname
        assert!(matches!(check("http://localhost:3000/api", &rules), PermissionResult::Deny { .. }));
        // Non-loopback URL is unaffected
        assert!(matches!(check("https://example.com", &rules), PermissionResult::Passthrough));
    }
}