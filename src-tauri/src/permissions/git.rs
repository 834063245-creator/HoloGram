// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Git 子命令权限检查 (spec §4.2: GitTool)
use crate::permissions::rule::PermissionRules;
use crate::permissions::PermissionResult;

/// Check git subcommand permission against rules.
/// Called by GitTool.check_permissions().
pub fn check(subcommand: &str, rules: &PermissionRules) -> PermissionResult {
    // 1. Content-level Deny rules
    if let Some(rule) = rules.find_deny("Git", Some(subcommand)) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 2. Content-level Allow rules — user/session/project rules override system Ask
    if rules.find_allow("Git", Some(subcommand)).is_some() {
        return PermissionResult::Allow;
    }

    // 3. Content-level Ask rules — only reached if no Allow rule matched
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

    // 4. Safe read-only subcommands → Passthrough (central engine will allow)
    match subcommand {
        "log" | "status" | "diff_unstaged" | "diff_staged" | "blame"
        | "show" | "file_at_head" | "list_branches" | "stash_list"
        | "pull" | "fetch" | "stage" | "unstage" | "stage_all" | "init"
        | "create_branch" | "stash_push" => {
            PermissionResult::Passthrough
        }
        // Destructive subcommands → Ask by default
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

    // ── E2: Additional git permission tests ──

    #[test]
    fn test_git_all_safe_commands_passthrough() {
        let rules = PermissionRules::new();
        // Exhaustive safe-read / safe-write subcommands
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
        // Other commands are not affected by the deny rule
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
        // commit is destructive by default (Ask), but Allow rule overrides
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
        // fetch is safe by default (Passthrough), but Ask rule overrides
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
        // Deny always wins over Allow
        assert!(
            matches!(check("push", &rules), PermissionResult::Deny { .. }),
            "Deny rule must take priority over Allow"
        );
    }
}