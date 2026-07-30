// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Git 子命令权限检查 (spec §4.2: GitTool)
use crate::permissions::rule::PermissionRules;
use crate::permissions::PermissionResult;

/// 检查 git 子命令的权限规则。
/// 由 GitTool.check_permissions() 调用。
pub fn check(subcommand: &str, rules: &PermissionRules) -> PermissionResult {
    // 1. 内容级 Deny 规则
    if let Some(rule) = rules.find_deny("Git", Some(subcommand)) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 2. 内容级 Allow 规则 — 用户/会话/项目规则覆盖系统 Ask
    if rules.find_allow("Git", Some(subcommand)).is_some() {
        return PermissionResult::Allow;
    }

    // 3. 内容级 Ask 规则 — 仅在没有 Allow 规则匹配时到达
    if let Some(rule) = rules.find_ask("Git", Some(subcommand)) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Git({})", subcommand),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        };
    }

    // 4. 安全的只读子命令 → Passthrough（中央引擎将放行）
    match subcommand {
        "log" | "status" | "diff_unstaged" | "diff_staged" | "blame"
        | "show" | "file_at_head" | "list_branches" | "stash_list"
        | "pull" | "fetch" | "stage" | "unstage" | "stage_all" | "init"
        | "create_branch" | "stash_push" => {
            PermissionResult::Passthrough
        }
        // 破坏性子命令 → 默认 Ask
        _ => PermissionResult::Ask {
            reason: format!("Git {} 需要用户确认", subcommand),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Git({})", subcommand),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::rule::{parse_rule_value, Behavior, PermissionRule, RuleSource};

    #[test]
    fn test_git_safe_read_commands() {
        let rules = PermissionRules::new();
        assert!(matches!(check("log", &rules), PermissionResult::Passthrough));
        assert!(matches!(check("status", &rules), PermissionResult::Passthrough));
        assert!(matches!(check("blame", &rules), PermissionResult::Passthrough));
    }

    #[test]
    fn test_git_destructive_commands_default_ask() {
        let rules = PermissionRules::new();
        assert!(matches!(check("push", &rules), PermissionResult::Ask { .. }));
        assert!(matches!(check("commit", &rules), PermissionResult::Ask { .. }));
        assert!(matches!(check("checkout", &rules), PermissionResult::Ask { .. }));
    }

    // ── E2: 额外的 git 权限测试 ──

    #[test]
    fn test_git_all_safe_commands_passthrough() {
        let rules = PermissionRules::new();
        // 穷举安全只读 / 安全写入子命令
        for cmd in &[
            "log", "status", "diff_unstaged", "diff_staged", "blame", "show",
            "file_at_head", "list_branches", "stash_list", "pull", "fetch",
            "stage", "unstage", "stage_all", "init", "create_branch", "stash_push",
        ] {
            assert!(
                matches!(check(cmd, &rules), PermissionResult::Passthrough),
                "git subcommand '{}' should Passthrough, got: {:?}",
                cmd,
                check(cmd, &rules)
            );
        }
    }

    #[test]
    fn test_git_all_destructive_commands_ask() {
        let rules = PermissionRules::new();
        for cmd in &[
            "push", "commit", "checkout", "stash_pop", "discard", "reset",
            "rebase", "merge", "cherry_pick", "revert",
        ] {
            assert!(
                matches!(check(cmd, &rules), PermissionResult::Ask { .. }),
                "git subcommand '{}' should Ask, got: {:?}",
                cmd,
                check(cmd, &rules)
            );
        }
    }

    #[test]
    fn test_git_deny_rule() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("Git(push)"),
            danger: None,
        });
        assert!(matches!(check("push", &rules), PermissionResult::Deny { .. }));
        // 其他命令不受 deny 规则影响
        assert!(matches!(check("log", &rules), PermissionResult::Passthrough));
    }

    #[test]
    fn test_git_allow_rule_overrides_ask() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::Project,
            behavior: Behavior::Allow,
            value: parse_rule_value("Git(commit)"),
            danger: None,
        });
        // commit 默认是破坏性的（Ask），但 Allow 规则覆盖了它
        assert!(
            matches!(check("commit", &rules), PermissionResult::Allow),
            "Allow rule should override default Ask for git commit"
        );
    }

    #[test]
    fn test_git_ask_rule() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::Session,
            behavior: Behavior::Ask,
            value: parse_rule_value("Git(fetch)"),
            danger: None,
        });
        // fetch 默认是安全的（Passthrough），但 Ask 规则覆盖了它
        let r = check("fetch", &rules);
        match r {
            PermissionResult::Ask { suggestions, .. } => {
                assert!(!suggestions.is_empty(), "Ask must include a suggestion");
                assert!(suggestions[0].rule.starts_with("Git("), "suggestion should be Git(subcommand)");
            }
            other => panic!("expected Ask, got: {:?}", other),
        }
    }

    #[test]
    fn test_git_deny_takes_priority_over_allow() {
        let mut rules = PermissionRules::new();
        rules.add_rule(PermissionRule {
            source: RuleSource::Project,
            behavior: Behavior::Allow,
            value: parse_rule_value("Git(push)"),
            danger: None,
        });
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("Git(push)"),
            danger: None,
        });
        // Deny 始终优先于 Allow
        assert!(
            matches!(check("push", &rules), PermissionResult::Deny { .. }),
            "Deny rule must take priority over Allow"
        );
    }
}