// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 权限规则模型 — Rule parsing, matching, loading
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleSource {
    System,
    Project,
    #[allow(dead_code)] // ponytail: for user-level rules in future
    User,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Behavior {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleValue {
    pub tool_name: String,       // PascalCase: "Bash", "Read", "Edit", "Git", "WebFetch"
    pub content: Option<String>, // e.g. "npm test:*", "src/**"
}

#[derive(Debug, Clone)]
pub struct PermissionRule {
    pub source: RuleSource,
    pub behavior: Behavior,
    pub value: RuleValue,
}

#[derive(Debug, Clone, Default)]
pub struct PermissionRules {
    deny: Vec<PermissionRule>,
    ask: Vec<PermissionRule>,
    allow: Vec<PermissionRule>,
}

/// Parse a rule string like "Bash(npm test:*)" or "Bash" into a RuleValue.
pub fn parse_rule_value(raw: &str) -> RuleValue {
    let raw = raw.trim();
    if let Some(open) = raw.find('(') {
        if raw.ends_with(')') {
            let tool_name = raw[..open].to_string();
            let content = raw[open + 1..raw.len() - 1].to_string();
            return RuleValue {
                tool_name,
                content: Some(content),
            };
        }
    }
    RuleValue {
        tool_name: raw.to_string(),
        content: None,
    }
}

/// Load built-in system rules (spec §4.9).
pub fn load_system_rules() -> Vec<PermissionRule> {
    let deny_patterns = &[
        // Protect config files, not runtime data — HoloGram UI writes to
        // memory/, sessions/, logs/ for normal operation.
        "Edit(.hologram/permissions.json)",
        "Edit(.hologram/baseline.json)",
        "Edit(.hologram/settings.json)",
        "Edit(.git/config)",
        "Edit(.git/hooks/**)",
        "Edit(~/.ssh/authorized_keys)",
        "Edit(~/.bashrc)",
        "Edit(~/.zshrc)",
        "Edit(~/.profile)",
        "Bash(rm -rf /*)",
        "Bash(curl * | sh)",
        "Bash(curl * | bash)",
        "Bash(wget * | sh)",
        "Bash(wget * | bash)",
        "Bash(> /dev/*)",
        "Bash(dd of=/dev/*)",
        "Bash(mkfs*)",
        "Bash(shutdown*)",
        "Bash(reboot*)",
        "Bash(halt*)",
        "WebFetch(0.0.0.0:*)",
    ];
    let ask_patterns = &[
        "Bash(git push --force main)",
        "Bash(git push --force master)",
        "Git(push)",
        "Git(pull)",
        "Git(checkout:*)",
        "Git(commit)",
        "Git(stage:*)",
        "Git(create_branch:*)",
        "WebFetch(localhost:*)",
        "WebFetch(127.0.0.1:*)",
    ];

    let mut rules = Vec::new();
    for p in deny_patterns {
        rules.push(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value(p),
        });
    }
    for p in ask_patterns {
        rules.push(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Ask,
            value: parse_rule_value(p),
        });
    }
    rules
}

/// Load project-specific rules from .hologram/permissions.json.
/// Returns empty vec if file doesn't exist or can't be parsed.
pub fn load_project_rules(project_root: &Path) -> Vec<PermissionRule> {
    let path = project_root.join(".hologram").join("permissions.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut rules = Vec::new();
    let sections: &[(&str, Behavior)] = &[
        ("deny", Behavior::Deny),
        ("ask", Behavior::Ask),
        ("allow", Behavior::Allow),
    ];
    for (key, behavior) in sections {
        if let Some(arr) = json.get(*key).and_then(|v| v.as_array()) {
            for entry in arr {
                if let Some(s) = entry.as_str() {
                    rules.push(PermissionRule {
                        source: RuleSource::Project,
                        behavior: behavior.clone(),
                        value: parse_rule_value(s),
                    });
                }
            }
        }
    }
    rules
}

impl PermissionRule {
    /// Check if this rule matches a tool name and optional content.
    pub fn matches(&self, tool_name: &str, command_or_path: Option<&str>) -> bool {
        if self.value.tool_name != tool_name {
            return false;
        }
        match (&self.value.content, command_or_path) {
            (None, _) => true, // tool-level rule, matches all operations
            (Some(pattern), Some(actual)) => content_matches(pattern, actual),
            (Some(_), None) => false,
        }
    }

    pub fn explain(&self) -> String {
        let source_name = match self.source {
            RuleSource::System => "系统",
            RuleSource::Project => "项目",
            RuleSource::User => "用户",
            RuleSource::Session => "会话",
        };
        let behavior_name = match self.behavior {
            Behavior::Allow => "允许",
            Behavior::Deny => "禁止",
            Behavior::Ask => "询问",
        };
        match &self.value.content {
            Some(content) => format!(
                "[{}] {}: {}({})",
                source_name, behavior_name, self.value.tool_name, content
            ),
            None => format!(
                "[{}] {}: {}",
                source_name, behavior_name, self.value.tool_name
            ),
        }
    }
}

impl PermissionRules {
    pub fn new() -> Self {
        Self {
            deny: Vec::new(),
            ask: Vec::new(),
            allow: Vec::new(),
        }
    }

    pub fn add_rules(&mut self, rules: Vec<PermissionRule>) {
        for rule in rules {
            self.add_rule(rule);
        }
    }

    pub fn add_rule(&mut self, rule: PermissionRule) {
        match rule.behavior {
            Behavior::Deny => self.deny.push(rule),
            Behavior::Ask => self.ask.push(rule),
            Behavior::Allow => self.allow.push(rule),
        }
    }

    /// Find first matching deny rule. Deny always takes priority — check this first.
    pub fn find_deny(
        &self,
        tool_name: &str,
        command_or_path: Option<&str>,
    ) -> Option<&PermissionRule> {
        self.deny
            .iter()
            .find(|r| r.matches(tool_name, command_or_path))
    }

    pub fn find_ask(
        &self,
        tool_name: &str,
        command_or_path: Option<&str>,
    ) -> Option<&PermissionRule> {
        self.ask
            .iter()
            .find(|r| r.matches(tool_name, command_or_path))
    }

    pub fn find_allow(
        &self,
        tool_name: &str,
        command_or_path: Option<&str>,
    ) -> Option<&PermissionRule> {
        self.allow
            .iter()
            .find(|r| r.matches(tool_name, command_or_path))
    }
}

// ═══════════════════════════════════════════════════════════════
// Content pattern matching
// ═══════════════════════════════════════════════════════════════

/// Match content pattern against actual content.
/// - "npm test:*" prefix-matches "npm test --filter=foo"
/// - "src/**" glob-matches "src/main.rs"
/// - "push" substring-matches git subcommand
fn content_matches(pattern: &str, actual: &str) -> bool {
    // ":*" suffix: prefix match (spec §4.3 — "npm test:*" matches "npm test --filter=foo")
    // Also handles URL patterns like "0.0.0.0:*" matching "http://0.0.0.0:8080/"
    if let Some(prefix) = pattern.strip_suffix(":*") {
        return actual.starts_with(prefix) || actual.contains(&format!("://{prefix}"));
    }
    // Contains glob — convert to regex
    if pattern.contains('*') || pattern.contains('?') {
        let regex_str = glob_to_regex(pattern);
        if let Ok(re) = regex::Regex::new(&regex_str) {
            let normalized = actual.replace('\\', "/");
            return re.is_match(&normalized);
        }
        return false;
    }
    // Substring match (case-insensitive)
    actual
        .to_lowercase()
        .contains(&pattern.to_lowercase())
}

/// Convert a simple glob pattern to regex.
/// "src/**" → "src/.*"
/// "*.lock" → "[^/]*\.lock"
/// "**/foo" → "(.*/)?foo"
fn glob_to_regex(pattern: &str) -> String {
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        out.push_str("(.*/)?");
                    } else {
                        out.push_str(".*");
                    }
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push('.'),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rule_value_bare() {
        let v = parse_rule_value("Bash");
        assert_eq!(v.tool_name, "Bash");
        assert_eq!(v.content, None);
    }

    #[test]
    fn test_parse_rule_value_with_content() {
        let v = parse_rule_value("Bash(npm test:*)");
        assert_eq!(v.tool_name, "Bash");
        assert_eq!(v.content.as_deref(), Some("npm test:*"));
    }

    #[test]
    fn test_content_matches_prefix() {
        assert!(content_matches("npm test:*", "npm test --filter=foo"));
        assert!(!content_matches("npm test:*", "npm run build"));
    }

    #[test]
    fn test_content_matches_glob() {
        assert!(content_matches("src/**", "src/main.rs"));
        assert!(content_matches("src/**", "src/deep/nested/file.ts"));
        assert!(!content_matches("src/**", "tests/main.rs"));
    }

    #[test]
    fn test_content_matches_substring() {
        assert!(content_matches("push", "git push origin main"));
        assert!(!content_matches("push", "git pull"));
    }

    #[test]
    fn test_rule_matches_tool_level() {
        let rule = PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value("Bash"),
        };
        assert!(rule.matches("Bash", None));
        assert!(rule.matches("Bash", Some("anything")));
        assert!(!rule.matches("Read", None));
    }

    #[test]
    fn test_rule_matches_content_level() {
        let rule = PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Allow,
            value: parse_rule_value("Bash(npm test:*)"),
        };
        assert!(rule.matches("Bash", Some("npm test --filter=foo")));
        assert!(!rule.matches("Bash", Some("cargo build")));
        assert!(!rule.matches("Read", Some("npm test")));
    }
}
