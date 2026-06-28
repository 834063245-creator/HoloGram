// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 共享文件系统权限 helper (spec §4.7)
// check_read_permission / check_write_permission — 被 ReadTool/EditTool 调用
use std::path::Path;

use crate::permissions::rule::PermissionRules;
use crate::permissions::safety;
use crate::permissions::PermissionResult;
use crate::sandbox::{Sandbox, SandboxResult};

/// Read permission check — shared by ReadFile/Glob/Grep/ListDir/SearchContent.
/// Path resolution → deny rules → safety → ask rules → allow rules.
pub fn check_read_permission(
    raw_path: &str,
    sandbox: &Sandbox,
    rules: &PermissionRules,
) -> PermissionResult {
    let path = Path::new(raw_path);

    // 1. Resolve path via sandbox
    let resolved = match sandbox.resolve_read(path) {
        SandboxResult::Allowed(p) => p,
        SandboxResult::Denied(reason) => {
            return PermissionResult::Deny {
                reason: format!("读取被拒绝: {}", reason),
            };
        }
    };

    // 2. Content-level Deny rules (path glob matching)
    if let Some(rule) = rules.find_deny("Read", Some(&path_to_match_str(&resolved))) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 3. Safety check (bypass-immune) — only for sensitive paths
    let safety = safety::check_path_safety(&resolved);
    if !safety.safe {
        return PermissionResult::Ask {
            reason: format!("安全警告: {}", safety.message),
            suggestions: vec![],
        };
    }

    // 4. Content-level Ask rules
    if let Some(rule) = rules.find_ask("Read", Some(&path_to_match_str(&resolved))) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![],
        };
    }

    // 5. Within project root → Allow (read is default-allow in project)
    // ponytail: sandbox.resolve_read already returns Denied for out-of-project paths,
    // so reaching here means the path is within project root.
    // Check allow rules for explicit overrides
    if rules
        .find_allow("Read", Some(&path_to_match_str(&resolved)))
        .is_some()
    {
        return PermissionResult::Allow;
    }

    // 6. Passthrough — file is within project, no specific rules → allow
    PermissionResult::Allow
}

/// Write permission check — shared by WriteFile/EditFile/Delete/CreateDir/Rename.
/// Path resolution → deny rules → safety → ask rules → allow rules.
pub fn check_write_permission(
    raw_path: &str,
    sandbox: &Sandbox,
    rules: &PermissionRules,
) -> PermissionResult {
    let path = Path::new(raw_path);

    // 1. Resolve path via sandbox (may canonicalize or find nearest ancestor)
    let resolved = match sandbox.resolve_write(path) {
        SandboxResult::Allowed(p) => p,
        SandboxResult::Denied(reason) => {
            return PermissionResult::Deny {
                reason: format!("写入被拒绝: {}", reason),
            };
        }
    };

    // 2. Content-level Deny rules (path glob matching)
    if let Some(rule) = rules.find_deny("Edit", Some(&path_to_match_str(&resolved))) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 3. Safety check (bypass-immune) — .git, .hologram, .ssh, etc.
    let safety = safety::check_path_safety(&resolved);
    if !safety.safe {
        return PermissionResult::Ask {
            reason: format!("安全警告: {}", safety.message),
            suggestions: vec![],
        };
    }

    // 4. Content-level Ask rules
    if let Some(rule) = rules.find_ask("Edit", Some(&path_to_match_str(&resolved))) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![],
        };
    }

    // 5. Content-level Allow rules
    if rules
        .find_allow("Edit", Some(&path_to_match_str(&resolved)))
        .is_some()
    {
        return PermissionResult::Allow;
    }

    // 6. Within project root → Allow (write after safety check passed)
    PermissionResult::Allow
}

/// Convert a PathBuf to a normalized string for rule matching.
/// Uses POSIX-style separators for cross-platform consistency.
fn path_to_match_str(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sandbox_in_temp() -> (Sandbox, PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let tmp = std::env::temp_dir().join(format!("holo_fs_test_{id}"));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src")).unwrap();
        std::fs::write(tmp.join("src/main.rs"), "fn main() {}").unwrap();
        (Sandbox::new(&tmp), tmp)
    }

    #[test]
    fn test_read_inside_project_allowed() {
        let (s, root) = sandbox_in_temp();
        let rules = PermissionRules::new();
        let r = check_read_permission(
            &root.join("src/main.rs").to_string_lossy(),
            &s,
            &rules,
        );
        assert!(matches!(r, PermissionResult::Allow), "expected Allow, got: {:?}", r);
    }

    #[test]
    fn test_read_outside_project_denied() {
        let (s, _) = sandbox_in_temp();
        let rules = PermissionRules::new();
        let r = check_read_permission("C:\\Windows\\System32\\notepad.exe", &s, &rules);
        assert!(matches!(r, PermissionResult::Deny { .. }), "expected Deny, got: {:?}", r);
    }

    #[test]
    fn test_write_inside_project_allowed() {
        let (s, root) = sandbox_in_temp();
        let rules = PermissionRules::new();
        let r = check_write_permission(
            &root.join("src/new_file.txt").to_string_lossy(),
            &s,
            &rules,
        );
        assert!(matches!(r, PermissionResult::Allow), "expected Allow, got: {:?}", r);
    }

    #[test]
    fn test_write_dangerous_path_ask() {
        let (s, root) = sandbox_in_temp();
        let rules = PermissionRules::new();
        // .bashrc is dangerous
        let r = check_write_permission(
            &root.join(".bashrc").to_string_lossy(),
            &s,
            &rules,
        );
        assert!(matches!(r, PermissionResult::Ask { .. }));
    }

    #[test]
    fn test_write_system_deny_rule() {
        let (s, root) = sandbox_in_temp();
        let mut rules = PermissionRules::new();
        use crate::permissions::rule::{parse_rule_value, Behavior, PermissionRule, RuleSource};
        rules.add_rule(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("Edit(.hologram/**)"),
        });
        let r = check_write_permission(
            &root.join(".hologram/settings.json").to_string_lossy(),
            &s,
            &rules,
        );
        assert!(matches!(r, PermissionResult::Deny { .. }));
    }
}
