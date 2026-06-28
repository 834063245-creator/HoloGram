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

    // 2. Content-level Ask rules
    if let Some(rule) = rules.find_ask("Git", Some(subcommand)) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Git({})", subcommand),
                    behavior: "allow".into(),
                },
            ],
        };
    }

    // 3. Content-level Allow rules
    if rules.find_allow("Git", Some(subcommand)).is_some() {
        return PermissionResult::Allow;
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
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
