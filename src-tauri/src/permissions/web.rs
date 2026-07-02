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

    // 2. Content-level Ask rules
    if let Some(rule) = rules.find_ask("WebFetch", Some(url)) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("WebFetch({})", url),
                    behavior: "allow".into(),
                },
            ],
        };
    }

    // 3. Content-level Allow rules
    if rules.find_allow("WebFetch", Some(url)).is_some() {
        return PermissionResult::Allow;
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
}
