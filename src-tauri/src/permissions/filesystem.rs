// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 共享文件系统权限 helper (spec §4.7)
// check_read_permission / check_write_permission — 被 ReadTool/EditTool 调用
use std::path::Path;

use crate::permissions::rule::PermissionRules;
use crate::permissions::safety;
use crate::permissions::PermissionResult;
use crate::sandbox::{Sandbox, SandboxResult};

/// 读权限检查 — 被 ReadFile/Glob/Grep/ListDir/SearchContent 共用。
/// 路径解析 → deny 规则 → 安全检查 → ask 规则 → allow 规则。
/// sandbox 边界对读取不是硬拒绝：用户 Allow 规则可授予
/// 跨项目访问权限 (spec Phase 2 跨目录读取需求)。
///
/// `match_path_override`：当 worktree 隔离激活时，此参数是
/// 用于规则匹配的反向映射逻辑路径 (spec §5.6)。
/// 物理路径解析仍使用 `raw_path`。
pub fn check_read_permission(
    raw_path: &str,
    sandbox: &Sandbox,
    rules: &PermissionRules,
    match_path_override: Option<&str>,
) -> PermissionResult {
    let path = Path::new(raw_path);

    // 1. 通过 sandbox 解析路径（规范化，不强制边界检查）
    let resolved = match sandbox.resolve_read(path) {
        SandboxResult::Allowed(p) => Some(p),
        SandboxResult::Denied(_) => None,
    };

    // 如提供则使用 override（反向映射路径）进行规则匹配
    let match_str: String = match match_path_override {
        Some(override_path) => override_path.replace('\\', "/"),
        None => path_to_match_str(resolved.as_deref().unwrap_or(path)),
    };

    // 2. 内容级 Deny 规则（路径 glob 匹配）
    if let Some(rule) = rules.find_deny("Read", Some(&match_str)) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 3. 安全检查（不可绕过）— 仅对项目边界内的路径。
    // 读取 .hologram/ 文件不做安全检查 — 它们是 HoloGram 自身的
    // 数据（记忆、会话、日志）。拦截它们会破坏记忆系统和
    // 日志器。对于写入，下方的共享安全检查会保护 .hologram/。
    if let Some(ref resolved_path) = resolved {
        let safety = safety::check_path_safety_read(resolved_path);
        if !safety.safe {
            let path_str = path_to_match_str(resolved_path);
            return PermissionResult::Ask {
                reason: format!("安全警告: {}", safety.message),
                suggestions: vec![
                    crate::permissions::PermissionUpdate {
                        rule: format!("Read({})", path_str),
                        behavior: "allow".into(),
                    },
                ],
                danger: None,
            };
        }
    }

    // 4. 内容级 Allow 规则 — 用户/会话/项目规则覆盖系统 Ask
    if rules.find_allow("Read", Some(&match_str)).is_some() {
        return PermissionResult::Allow;
    }

    // 5. 内容级 Ask 规则 — 仅在无 Allow 规则匹配时到达
    if let Some(rule) = rules.find_ask("Read", Some(&match_str)) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Read({})", match_str),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        };
    }

    // 6. 项目内 → Allow；项目外 → Ask 用户（不静默 Deny）。
    // 用户可能有合理的理由读取项目外的文件
    // （例如读取系统头文件、配置或另一个项目的源码）。
    // 让用户通过对话框决定，而非静默拦截。
    if resolved.is_some() {
        PermissionResult::Allow
    } else {
        PermissionResult::Ask {
            reason: format!("读取项目外的路径: {}（需要用户确认）", raw_path),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Read({})", raw_path.replace('\\', "/")),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        }
    }
}

/// 写权限检查 — 被 WriteFile/EditFile/Delete/CreateDir/Rename 共用。
/// 路径解析 → deny 规则 → 安全检查 → ask 规则 → allow 规则。
///
/// `match_path_override`：当 worktree 隔离激活时，此参数是
/// 用于规则匹配的反向映射逻辑路径 (spec §5.6)。
/// 物理路径解析和安全检查仍使用 `raw_path`。
pub fn check_write_permission(
    raw_path: &str,
    sandbox: &Sandbox,
    rules: &PermissionRules,
    match_path_override: Option<&str>,
) -> PermissionResult {
    let path = Path::new(raw_path);

    // 1. 通过 sandbox 解析路径（可能规范化或查找最近的祖先目录）。
    // 项目外写入升级为 Ask（用户对话框），不静默拒绝 —
    // 用户可能有合理的理由（例如写入共享配置目录或
    // 跨项目工具操作时写入另一个项目）。
    let resolved = match sandbox.resolve_write(path) {
        SandboxResult::Allowed(p) => p,
        SandboxResult::Denied(reason) => {
            return PermissionResult::Ask {
                reason: format!("写入项目外的路径: {} ({})，需要用户确认", raw_path, reason),
                suggestions: vec![
                    crate::permissions::PermissionUpdate {
                        rule: format!("Edit({})", raw_path.replace('\\', "/")),
                        behavior: "allow".into(),
                    },
                ],
                danger: None,
            };
        }
    };

    // 如提供则使用 override（反向映射路径）进行规则匹配
    let match_str: String = match match_path_override {
        Some(p) => p.replace('\\', "/"),
        None => path_to_match_str(&resolved),
    };

    // 2. 内容级 Deny 规则（路径 glob 匹配）
    if let Some(rule) = rules.find_deny("Edit", Some(&match_str)) {
        return PermissionResult::Deny {
            reason: rule.explain(),
        };
    }

    // 3. 安全检查（不可绕过）— .git、.hologram、.ssh 等
    let safety = safety::check_path_safety(&resolved);
    if !safety.safe {
        let path_str = path_to_match_str(&resolved);
        return PermissionResult::Ask {
            reason: format!("安全警告: {}", safety.message),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Edit({})", path_str),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        };
    }

    // 4. 内容级 Allow 规则 — 用户/会话/项目规则覆盖系统 Ask
    if rules.find_allow("Edit", Some(&match_str)).is_some() {
        return PermissionResult::Allow;
    }

    // 5. 内容级 Ask 规则 — 仅在无 Allow 规则匹配时到达
    if let Some(rule) = rules.find_ask("Edit", Some(&match_str)) {
        return PermissionResult::Ask {
            reason: rule.explain(),
            suggestions: vec![
                crate::permissions::PermissionUpdate {
                    rule: format!("Edit({})", match_str),
                    behavior: "allow".into(),
                },
            ],
            danger: None,
        };
    }

    // 6. 项目根目录内 → Allow（安全检查通过后写入）
    PermissionResult::Allow
}

/// 将 PathBuf 转换为用于规则匹配的标准化字符串。
/// 使用 POSIX 风格的分隔符以保持跨平台一致性。
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
            None,
        );
        assert!(matches!(r, PermissionResult::Allow), "expected Allow, got: {:?}", r);
    }

    #[test]
    fn test_read_outside_project_ask() {
        let (s, _) = sandbox_in_temp();
        let rules = PermissionRules::new();
        // 项目外读取升级为 Ask（用户对话框），不静默 Deny
        let r = check_read_permission("C:\\Windows\\System32\\notepad.exe", &s, &rules, None);
        assert!(matches!(r, PermissionResult::Ask { .. }), "expected Ask, got: {:?}", r);
    }

    #[test]
    fn test_read_outside_project_allowed_by_rule() {
        let (s, _) = sandbox_in_temp();
        let mut rules = PermissionRules::new();
        use crate::permissions::rule::{parse_rule_value, Behavior, PermissionRule, RuleSource};
        rules.add_rule(PermissionRule {
            source: RuleSource::Project,
            behavior: Behavior::Allow,
            value: parse_rule_value("Read(C:/Windows/System32/**)"),
            danger: None,
        });
        let r = check_read_permission("C:\\Windows\\System32\\notepad.exe", &s, &rules, None);
        assert!(
            matches!(r, PermissionResult::Allow),
            "expected Allow (rule granted cross-project read), got: {:?}",
            r
        );
    }

    #[test]
    fn test_write_inside_project_allowed() {
        let (s, root) = sandbox_in_temp();
        let rules = PermissionRules::new();
        let r = check_write_permission(
            &root.join("src/new_file.txt").to_string_lossy(),
            &s,
            &rules,
            None,
        );
        assert!(matches!(r, PermissionResult::Allow), "expected Allow, got: {:?}", r);
    }

    #[test]
    fn test_write_dangerous_path_ask() {
        let (s, root) = sandbox_in_temp();
        let rules = PermissionRules::new();
        // .bashrc 是危险文件
        let r = check_write_permission(
            &root.join(".bashrc").to_string_lossy(),
            &s,
            &rules,
            None,
        );
        match r {
            PermissionResult::Ask { suggestions, .. } => {
                assert!(!suggestions.is_empty(), "safety Ask must include a suggestion");
                assert!(suggestions[0].rule.starts_with("Edit("), "suggestion should be Edit(path)");
            }
            other => panic!("expected Ask, got: {:?}", other),
        }
    }

    #[test]
    fn test_read_safety_ask_has_suggestion() {
        let (s, _root) = sandbox_in_temp();
        let rules = PermissionRules::new();
        // 任意位置的 .bashrc 都会触发 check_path_safety_read 中的 is_dangerous_file
        let test_path = format!("{}/.bashrc",
            std::env::var("USERPROFILE").unwrap_or_default().replace('\\', "/"));
        let r = check_read_permission(&test_path, &s, &rules, None);
        match r {
            PermissionResult::Ask { suggestions, .. } => {
                assert!(!suggestions.is_empty(), "read safety Ask must include a suggestion");
            }
            // 若路径不存在则可能为 Allow（sandbox 规范化失败 → resolved=None → 项目外 → Ask）
            // 若路径存在且安全检查拦截则为 Ask
            PermissionResult::Allow => {
                // 正常 — 此系统上该路径不存在
            }
            other => panic!("expected Ask or Allow, got: {:?}", other),
        }
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
            danger: None,
        });
        let r = check_write_permission(
            &root.join(".hologram/settings.json").to_string_lossy(),
            &s,
            &rules,
            None,
        );
        assert!(matches!(r, PermissionResult::Deny { .. }));
    }
}