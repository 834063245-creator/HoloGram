// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 权限规则模型 — 规则解析、匹配、加载
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
    pub content: Option<String>, // 例如 "npm test:*", "src/**"
}

#[derive(Debug, Clone)]
pub struct PermissionRule {
    pub source: RuleSource,
    pub behavior: Behavior,
    pub value: RuleValue,
    /// 如果设置，前端会渲染带有此标签的红色危险卡片（例如 "ForceRecursiveRoot"）。
    /// 仅对 Ask 规则有意义。工具级 Ask（bash.rs::check）原生提供此值；
    /// 系统规则可以携带此值，以避免在步骤 ② 以 danger: None 短路。
    pub danger: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PermissionRules {
    deny: Vec<PermissionRule>,
    ask: Vec<PermissionRule>,
    allow: Vec<PermissionRule>,
}

/// 将类似 "Bash(npm test:*)" 或 "Bash" 的规则字符串解析为 RuleValue。
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

/// 加载内置系统规则 (spec §4.9)。
pub fn load_system_rules() -> Vec<PermissionRule> {
    let deny_patterns = &[
        // 保护配置文件，而非运行时数据 — HoloGram UI 在正常运行时
        // 写入 memory/、sessions/、logs/。
        "Edit(.hologram/permissions.json)",
        "Edit(.hologram/baseline.json)",
        "Edit(.hologram/settings.json)",
        "Edit(.git/config)",
        "Edit(.git/hooks/**)",
        "Edit(~/.ssh/authorized_keys)",
        "Edit(~/.bashrc)",
        "Edit(~/.zshrc)",
        "Edit(~/.profile)",
        "WebFetch(0.0.0.0:*)",
    ];
    let ask_patterns = &[
        // 高风险操作 — 不需要 danger 标签（普通询问卡片）。
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
    // 关键 bash 命令 — 携带 danger 标签用于红色 ASK 卡片。
    // 当系统 ask 规则（步骤 ②）匹配这些命令时，danger 会直接传播，
    // 无需在步骤 ③ 调用 bash.rs::check()。
    let danger_ask_patterns: &[(&str, &str)] = &[
        ("Bash(rm -rf /*)", "ForceRecursiveRoot"),
        ("Bash(curl * | sh)", "PipeToShell"),
        ("Bash(curl * | bash)", "PipeToShell"),
        ("Bash(wget * | sh)", "PipeToShell"),
        ("Bash(wget * | bash)", "PipeToShell"),
        ("Bash(> /dev/*)", "WriteDev"),
        ("Bash(dd of=/dev/*)", "WriteDev"),
        ("Bash(mkfs*)", "DiskFormat"),
        ("Bash(shutdown*)", "SystemPower"),
        ("Bash(reboot*)", "SystemPower"),
        ("Bash(halt*)", "SystemPower"),
    ];

    let mut rules = Vec::new();
    for p in deny_patterns {
        rules.push(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Deny,
            value: parse_rule_value(p),
            danger: None,
        });
    }
    for p in ask_patterns {
        rules.push(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Ask,
            value: parse_rule_value(p),
            danger: None,
        });
    }
    for (p, danger) in danger_ask_patterns {
        rules.push(PermissionRule {
            source: RuleSource::System,
            behavior: Behavior::Ask,
            value: parse_rule_value(p),
            danger: Some(danger.to_string()),
        });
    }
    rules
}

/// 从 .hologram/permissions.json 加载项目专属规则。
/// 文件不存在 = 无规则（正常）；读取/解析失败 = 按无规则运行但必须告警——
/// 否则用户自定义 deny 规则静默丢失即成安全 fail-open（雷区地图 P0-5）。
pub fn load_project_rules(project_root: &Path) -> Vec<PermissionRule> {
    let path = project_root.join(".hologram").join("permissions.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            eprintln!("[permissions] permissions.json 读取失败（{e}）——项目规则（含 deny）未生效！");
            return Vec::new();
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[permissions] permissions.json 解析失败（{e}）——项目规则（含 deny）未生效！");
            return Vec::new();
        }
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
                        danger: None,
                    });
                }
            }
        }
    }
    rules
}

/// 向项目 permissions.json 追加单条规则。
/// 如果文件和目录不存在则创建。
/// 去重：同一 section 中相同的规则字符串不会被重复添加。
#[allow(dead_code)] // API ready, not yet called from UI
pub fn append_project_rule(project_root: &Path, rule_str: &str, behavior: &str) {
    let path = project_root.join(".hologram").join("permissions.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 既有文件损坏时拒绝继续：unwrap_or({}) 会把用户规则整份清空（雷区地图 P0-5）
    let mut json: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[permissions] permissions.json 损坏（{e}）——拒绝追加，以免清空既有规则");
                return;
            }
        },
        _ => serde_json::json!({}),
    };
    let section = match behavior {
        "allow" => "allow",
        "deny" => "deny",
        _ => "ask",
    };
    // ponytail: 确保数组存在后再取 &mut 引用（避免 NLL 借用冲突）
    if !json[section].is_array() {
        json[section] = serde_json::json!([]);
    }
    if let Some(arr) = json[section].as_array_mut() {
        let rule_str = rule_str.to_string();
        if !arr.iter().any(|v| v.as_str() == Some(&rule_str)) {
            arr.push(serde_json::json!(rule_str));
        }
    }
    // 原子写：落盘途中崩溃不得留下截断的规则文件（fail-open 是安全事故）
    if let Err(e) = crate::utils::write_atomic(
        &path.to_string_lossy(),
        &serde_json::to_string_pretty(&json).unwrap_or_default(),
    ) {
        eprintln!("[permissions] permissions.json 落盘失败: {e}");
    }
}

impl PermissionRule {
    /// 检查此规则是否匹配工具名和可选内容。
    pub fn matches(&self, tool_name: &str, command_or_path: Option<&str>) -> bool {
        if self.value.tool_name != tool_name {
            return false;
        }
        match (&self.value.content, command_or_path) {
            (None, _) => true, // 工具级规则，匹配所有操作
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

    /// 查找第一个匹配的 deny 规则。Deny 始终优先 — 请先检查此项。
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
// 内容模式匹配
// ═══════════════════════════════════════════════════════════════

/// 将内容模式与实际内容进行匹配。
/// - "npm test:*" 前缀匹配 "npm test --filter=foo"
/// - "src/**" glob 匹配 "src/main.rs"
/// - "push" 子串匹配 git 子命令
fn content_matches(pattern: &str, actual: &str) -> bool {
    // ":*" 后缀：前缀匹配 (spec §4.3 — "npm test:*" 匹配 "npm test --filter=foo")
    // 也处理 URL 模式，如 "0.0.0.0:*" 匹配 "http://0.0.0.0:8080/"
    if let Some(prefix) = pattern.strip_suffix(":*") {
        return actual.starts_with(prefix) || actual.contains(&format!("://{prefix}"));
    }
    // 包含 glob — 转换为正则
    if pattern.contains('*') || pattern.contains('?') {
        let regex_str = glob_to_regex(pattern);
        if let Ok(re) = regex::Regex::new(&regex_str) {
            let normalized = actual.replace('\\', "/");
            // 在每个路径边界检查 — 按 / 分割并从每个组件起始处尝试匹配。
            // 这样可以处理 `src/**` 匹配
            // `mysrc/src/x`（匹配从第二个 / 之后开始）。
            // find_iter 是非重叠的，因此从非边界位置开始的长匹配
            // 可能会消耗掉有效的子匹配。
            for i in 0..=normalized.len() {
                if i == 0 || normalized.as_bytes().get(i - 1) == Some(&b'/') {
                    if let Some(m) = re.find(&normalized[i..]) {
                        if m.start() == 0 {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
        return false;
    }
    // 子串匹配（不区分大小写）
    actual
        .to_lowercase()
        .contains(&pattern.to_lowercase())
}

/// 将简单的 glob 模式转换为正则表达式。
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
                    } else if chars.peek().is_none() {
                        // ** 在模式末尾 — 递归匹配（标准 glob）
                        out.push_str(".*");
                    } else {
                        // ** 在组件中间（例如 foo**bar）—
                        // 当作单个 * 处理（不跨越目录分隔符）
                        out.push_str("[^/]*");
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
    fn test_r3_glob_matches_nested_path() {
        // R3: `src/**` 应匹配 `mysrc/src/x`（src 从 / 之后的路径边界开始）
        assert!(content_matches("src/**", "mysrc/src/x"));
        assert!(content_matches("src/**", "proj/src/main.rs"));
        // 但当 src 是更长名称的一部分时不匹配（无边界）
        assert!(!content_matches("src/**", "mysrc/x"));
        assert!(!content_matches("src/**", "mysource/file.ts"));
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
            danger: None,
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
            danger: None,
        };
        assert!(rule.matches("Bash", Some("npm test --filter=foo")));
        assert!(!rule.matches("Bash", Some("cargo build")));
        assert!(!rule.matches("Read", Some("npm test")));
    }

    // ── P0-5：permissions.json 落盘与损坏防护 ──

    #[test]
    fn append_project_rule_creates_file_atomically() {
        let dir = std::env::temp_dir().join("hologram_test_perm_append");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        append_project_rule(&dir, "Bash(npm test:*)", "allow");
        let content = std::fs::read_to_string(dir.join(".hologram").join("permissions.json")).unwrap();
        assert!(content.contains("npm test:*"));
        // 原子写不得留下 tmp/bak 残渣
        assert!(!dir.join(".hologram").join("permissions.json.tmp").exists());
        assert!(!dir.join(".hologram").join("permissions.json.bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_project_rule_refuses_to_clobber_corrupt_file() {
        let dir = std::env::temp_dir().join("hologram_test_perm_corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".hologram")).unwrap();
        let f = dir.join(".hologram").join("permissions.json");
        std::fs::write(&f, "not json{{").unwrap();
        append_project_rule(&dir, "Bash(npm test:*)", "allow");
        // 损坏文件必须原样保留，等人工处理——而不是被静默清空
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "not json{{");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_project_rules_corrupt_returns_empty_but_does_not_panic() {
        let dir = std::env::temp_dir().join("hologram_test_perm_load_corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".hologram")).unwrap();
        std::fs::write(dir.join(".hologram").join("permissions.json"), "{{bad").unwrap();
        assert!(load_project_rules(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}