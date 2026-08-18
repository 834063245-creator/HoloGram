// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool 实现 — 每个 Tauri command 对应一个 Tool (spec §4.2 映射表)
// 实现 crate::permissions::Tool trait，委托给 permissions/* 辅助函数。

use std::path::PathBuf;

use crate::permissions::{
    bash, filesystem, git, web, PermissionContext, PermissionResult, Tool,
};

// ═══════════════════════════════════════════════════════════════
// ReadTool — read_file_content, read_file_base64, list_directory,
//           glob, search_content 及只读 git 命令
// ═══════════════════════════════════════════════════════════════

pub struct ReadTool {
    pub path: String,
    pub agent_id: Option<String>,
}

impl Tool for ReadTool {
    fn name(&self) -> &'static str {
        "Read"
    }

    fn get_path(&self) -> Option<PathBuf> {
        Some(PathBuf::from(&self.path))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // Phase 3: 反向映射 worktree 路径 → 主仓库路径以进行规则匹配 (spec §5.6)
        let logical = ctx.reverse_map_path(std::path::Path::new(&self.path), self.agent_id.as_deref());
        let logical_str = logical.to_string_lossy().replace('\\', "/");
        filesystem::check_read_permission(&self.path, &ctx.sandbox, &rules, Some(&logical_str))
    }
}

// ═══════════════════════════════════════════════════════════════
// EditTool — write_file_content, edit_file, delete_file_or_dir,
//           create_directory, rename_file_or_dir, log_append, move_file
// ═══════════════════════════════════════════════════════════════

pub struct EditTool {
    pub path: String,
    pub agent_id: Option<String>,
}

impl Tool for EditTool {
    fn name(&self) -> &'static str {
        "Edit"
    }

    fn get_path(&self) -> Option<PathBuf> {
        Some(PathBuf::from(&self.path))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // Phase 3: 反向映射 worktree 路径 → 主仓库路径以进行规则匹配 (spec §5.6)
        let logical = ctx.reverse_map_path(std::path::Path::new(&self.path), self.agent_id.as_deref());
        let logical_str = logical.to_string_lossy().replace('\\', "/");
        filesystem::check_write_permission(&self.path, &ctx.sandbox, &rules, Some(&logical_str))
    }
}

// ═══════════════════════════════════════════════════════════════
// BashTool — exec_command
// ═══════════════════════════════════════════════════════════════

pub struct BashTool {
    pub command: String,
}

impl Tool for BashTool {
    fn name(&self) -> &'static str {
        "Bash"
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // bash 命令操作多个路径，而非单个文件
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        bash::check(&self.command, &ctx.sandbox, &rules)
    }
}

// ═══════════════════════════════════════════════════════════════
// GitTool — git_stage, git_unstage, git_stage_all, git_commit,
//          git_push, git_pull, git_init, git_checkout,
//          git_create_branch, git_stash_push, git_stash_pop, git_discard
// ═══════════════════════════════════════════════════════════════

pub struct GitTool {
    pub repo_path: String,
    pub subcommand: String,
}

impl Tool for GitTool {
    fn name(&self) -> &'static str {
        "Git"
    }

    fn get_path(&self) -> Option<PathBuf> {
        Some(PathBuf::from(&self.repo_path))
    }

    fn is_read_only(&self) -> bool {
        false
    }

    fn is_destructive(&self) -> bool {
        // push/commit/stash_pop/checkout 可能修改工作区
        true
    }

    fn requires_user_interaction(&self) -> bool {
        // ponytail: git 破坏性操作始终需要用户交互
        matches!(
            self.subcommand.as_str(),
            "push" | "commit" | "checkout" | "discard" | "stash_pop"
        )
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        // 首先检查仓库路径是否可读
        let rules = ctx.read_rules();
        let path_check = filesystem::check_read_permission(&self.repo_path, &ctx.sandbox, &rules, None);
        if let PermissionResult::Deny { .. } = path_check { return path_check }
        // 然后检查 git 子命令
        git::check(&self.subcommand, &rules)
    }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// BrowserTool — browser_launch / browser_kill / browser_attach / browser_eval 等
// ═══════════════════════════════════════════════════════════════

pub struct BrowserTool {
    pub action: String,
    pub agent_id: Option<String>,
}

impl Tool for BrowserTool {
    fn name(&self) -> &'static str {
        "Browser"
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // 浏览器控制不针对单个文件
    }

    fn is_read_only(&self) -> bool {
        matches!(
            self.action.as_str(),
            "targets" | "discover" | "inspect" | "report" | "status" | "snapshot" | "console" | "network" | "network_detail" | "network_har" | "screenshot" | "audit" | "content" | "wait" | "dialog_query" | "sessions" | "cookies_list"
        )
    }

    fn is_destructive(&self) -> bool {
        !self.is_read_only()
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        use crate::permissions::PermissionUpdate;
        let rules = ctx.read_rules();
        // 1. 工具级 Deny — 最高优先级
        if let Some(rule) = rules.find_deny("Browser", None) {
            return PermissionResult::Deny {
                reason: rule.explain(),
            };
        }
        // 2. 工具级 Allow — 用户已批准"始终允许"
        if rules.find_allow("Browser", None).is_some() {
            return PermissionResult::Allow;
        }
        // 3. 只读动作放行（targets/inspect/content/wait/status — 不改变任何状态）
        if self.is_read_only() {
            return PermissionResult::Passthrough;
        }
        // 4. L2 普通页面动作放行：attach 已批过一次，页面内 navigate/back/forward/
        //    reload/click/type/press/scroll/select 不再重复弹窗；敏感目标与高危动作除外。
        if matches!(
            self.action.as_str(),
            "navigate" | "back" | "forward" | "reload" | "click" | "type" | "press" | "scroll" | "select" | "hover" | "dialog" | "upload" | "viewport" | "new_tab" | "close_tab" | "switch_session"
        ) {
            return PermissionResult::Passthrough;
        }
        // 5. 高危动作：launch/kill（受控浏览器进程）/ attach（接管外部页面）/
        //    eval（任意 JS）/ click_sensitive·type_sensitive（敏感目标，L3）→ Ask。
        //    文案写实：attach 批准意味着该页面内的普通点击/输入不再二次确认
        //    （click/type 依赖 attach 时的授权；敏感目标仍每次单独确认）。
        let reason = match self.action.as_str() {
            "attach" => "Agent 请求接管一个浏览器页面。批准后 Agent 可在该页面上执行点击、输入等操作，\
                 普通操作不会再次确认（敏感目标如提交按钮/已填值输入框仍会单独询问）——建议只对无敏感信息的页面批准。"
                .into(),
            "connect" => "Agent 请求连接你自己启动的浏览器实例（调试端口）。批准后 Agent 可操作\
                 该浏览器的全部页面——包括你的登录态、Cookie 和真实数据。\
                 kill 只会断开连接、不会终止该浏览器。建议只连接无敏感登录态的实例。"
                .into(),
            "eval" => "Agent 请求在该页面执行任意 JS（受基础白名单限制）".into(),
            "kill" => "Agent 请求终止其启动的受控浏览器（若为外部连接则仅断开）".into(),
            "cookies_set" => "Agent 请求写入浏览器 cookie（登录态/会话标识），可能改变当前登录身份".into(),
            "cookies_delete" => "Agent 请求删除浏览器 cookie（可能使当前账号登出）".into(),
            "click_sensitive" => "Agent 请求点击一个敏感目标（提交按钮 / 下载 / 含确认、支付、删除或 Pay now、Delete、Confirm、Unsubscribe 等文本的元素）".into(),
            "type_sensitive" => "Agent 请求向已填值的输入框（或密码框）输入文字".into(),
            _ => format!("Agent 请求控制浏览器（动作: {}）", self.action),
        };
        PermissionResult::Ask {
            reason,
            suggestions: vec![PermissionUpdate {
                rule: "Browser".into(),
                behavior: "allow".into(),
            }],
            danger: Some("browser 控制".into()),
        }
    }
}

// DesktopTool — desktop_probe / desktop_screenshot / desktop_uia_*
// ═══════════════════════════════════════════════════════════════
// 权限分层（2026-08 computer-use 改造，对齐 BrowserTool 的 attach 模式）：
//   1. 工具级 Deny（最高优先）
//   2. 工具级 Allow
//   3. 只读动作（probe/tree/find/read/wait/window_shot/audit）→ Passthrough
//   4. uia_pattern（已有窗口级授权 DesktopGrant 的 pattern 动作）→ Passthrough
//   5. uia_grant（首次接管某窗口）→ Ask 一次，批准后 rpc 层记录 grant
//   6. uia_click_sensitive / uia_type_sensitive（敏感目标）→ 每次单独 Ask
//   7. uia_physical（物理输入路径：坐标点击/SendKeys/滚轮）→ 每次单独 Ask + 输入租约
//   8. screenshot（高隐私面）→ 每次单独 Ask（已从 read-only 移除）
// 分类所需信息（name/patterns/hwnd）由 rpc 层先做只读 resolve 再构造本 Tool。
// 物理输入的串行化（DesktopInputLease）在 rpc 层执行时获取。

pub struct DesktopTool {
    pub action: String,
    pub agent_id: Option<String>,
    /// 目标窗口句柄（写动作分类后携带；grant 记录用）
    pub hwnd: Option<u64>,
    /// 目标窗口标题（Ask 文案展示用）
    pub window_title: Option<String>,
}

impl Tool for DesktopTool {
    fn name(&self) -> &'static str {
        "Desktop"
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // 桌面快照/UIA 不针对单个文件
    }

    fn is_read_only(&self) -> bool {
        // 观察类: probe + UIA 读树/查找/读值/等待 + 窗口截图 + 审计查询。
        // screenshot 刻意不在列：高隐私面，走 Ask（第 8 层）。
        matches!(
            self.action.as_str(),
            "probe" | "uia_tree" | "uia_find" | "uia_read" | "uia_wait" | "uia_window_shot" | "audit"
        )
    }

    fn is_destructive(&self) -> bool {
        // 写动作(点击/输入/滚动/热键/激活)会改变目标应用状态。
        // uia_pattern 虽已获窗口级授权（check_permissions 放行），
        // 但它仍是真实写操作 —— is_destructive 保持 true（并发调度侧保守）。
        !self.is_read_only()
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        use crate::permissions::PermissionUpdate;
        let rules = ctx.read_rules();
        // 1. 工具级 Deny — 最高优先级
        if let Some(rule) = rules.find_deny("Desktop", None) {
            return PermissionResult::Deny { reason: rule.explain() };
        }
        // 2. 工具级 Allow
        if rules.find_allow("Desktop", None).is_some() {
            return PermissionResult::Allow;
        }
        // 3. 只读动作放行（不改变桌面状态）
        if self.is_read_only() {
            return PermissionResult::Passthrough;
        }
        // 4. 已授权窗口上的 pattern 动作放行（DesktopGrant 在 rpc 层记录/校验，
        //    check_permissions 保持纯函数 — 沿 BrowserTool「attach 后页内动作放行」语义）
        if self.action == "uia_pattern" {
            return PermissionResult::Passthrough;
        }
        // 5-8. Ask 类：接管授权 / 敏感目标 / 物理输入 / 截图
        let title = self.window_title.as_deref().unwrap_or("未知窗口");
        let hwnd_note = self.hwnd.map(|h| format!("（hwnd={h}）")).unwrap_or_default();
        let reason = match self.action.as_str() {
            "uia_grant" => format!(
                "Agent 请求接管桌面窗口「{title}」{hwnd_note}。批准后该窗口上的标准控件操作（点击/输入/\
                 选择/展开/滚动）不再逐次确认（敏感目标与坐标级物理输入仍会单独询问）——\
                 建议只对无敏感内容的窗口批准。"
            ),
            "uia_click_sensitive" => format!(
                "Agent 请求点击窗口「{title}」中一个敏感控件（提交/支付/删除/确认/退订类文本）。\
                 点击可能触发不可逆操作，请确认目标与后果。"
            ),
            "uia_type_sensitive" => format!(
                "Agent 请求向窗口「{title}」中一个已填值（或密码）输入框写入文字，会覆盖现有内容。"
            ),
            "uia_physical" => format!(
                "Agent 请求对窗口「{title}」执行物理输入（坐标鼠标/键盘注入/滚轮）{hwnd_note}。\
                 真实输入会落进当前屏幕焦点，可能触发保存、发送、删除等副作用；\
                 若目标控件不支持标准 pattern，这是唯一可用路径。"
            ),
            "screenshot" => "Agent 请求截取全屏。截图可能包含任意屏幕内容（高隐私面），请确认。".into(),
            "uia_keys" => "Agent 请求向目标窗口注入键盘热键（SendInput）。真实按键会落进焦点窗口，请确认目标与键位安全。".into(),
            "uia_activate" => "Agent 请求把目标窗口带到前台（会切换当前焦点窗口）。".into(),
            _ => format!("Agent 请求控制桌面应用（动作: {}）", self.action),
        };
        PermissionResult::Ask {
            reason,
            suggestions: vec![PermissionUpdate {
                rule: "Desktop".into(),
                behavior: "allow".into(),
            }],
            danger: Some("桌面自动化操作".into()),
        }
    }
}

/// UIA 写动作分类的输入：目标控件能力（来自只读 resolve）。
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct UiaTargetCaps {
    pub has_invoke: bool,
    pub has_toggle: bool,
    pub has_select: bool,
    pub has_value: bool,
    pub has_scroll: bool,
}

/// 分类：敏感目标 > 物理路径 > 已授权 pattern > 首次接管（优先级即安全收紧序）。
/// 输出是 DesktopTool 的 action 名（check_permissions 的分层输入）。
pub(crate) fn classify_uia_action(
    kind: &str,
    target_name: &str,
    password: bool,
    cur_value: &str,
    caps: &UiaTargetCaps,
    granted: bool,
) -> &'static str {
    let sensitive = match kind {
        "click" | "right_click" => crate::sensitive::is_sensitive_click_text(target_name),
        "type" => password || !cur_value.is_empty(),
        _ => false,
    };
    if sensitive {
        if kind == "type" { "uia_type_sensitive" } else { "uia_click_sensitive" }
    } else if uia_action_needs_physical(kind, caps) {
        "uia_physical"
    } else if granted {
        "uia_pattern"
    } else {
        "uia_grant"
    }
}

/// 该动作在该控件上是否只能走物理输入路径（无可用 pattern）。
/// rpc 层据此决定执行前是否获取全局输入租约。
pub(crate) fn uia_action_needs_physical(kind: &str, caps: &UiaTargetCaps) -> bool {
    match kind {
        "click" => !(caps.has_invoke || caps.has_toggle || caps.has_select),
        "right_click" => true,
        "type" => !caps.has_value,
        "scroll" => !caps.has_scroll,
        _ => false,
    }
}

#[cfg(test)]
mod desktop_permission_tests {
    use super::*;
    use crate::permissions::PermissionContext;

    /// 构造无规则上下文（空项目目录）——分类矩阵只测 Tool 自身分层。
    fn ctx_empty() -> PermissionContext {
        PermissionContext::new(std::path::Path::new(""))
    }

    fn desktop(action: &str) -> DesktopTool {
        DesktopTool {
            action: action.into(),
            agent_id: None,
            hwnd: Some(1234),
            window_title: Some("测试窗口".into()),
        }
    }

    fn kind(r: &PermissionResult) -> &'static str {
        match r {
            PermissionResult::Allow => "allow",
            PermissionResult::Deny { .. } => "deny",
            PermissionResult::Ask { .. } => "ask",
            PermissionResult::Passthrough => "passthrough",
        }
    }

    /// 六层矩阵：只读放行 / pattern 放行 / 接管与敏感与物理 Ask / screenshot Ask。
    #[test]
    fn desktop_permission_matrix() {
        let ctx = ctx_empty();
        // 只读 → Passthrough（引擎兜底放行）
        for a in ["probe", "uia_tree", "uia_find", "uia_read", "uia_wait", "uia_window_shot", "audit"] {
            assert_eq!(kind(&desktop(a).check_permissions(&ctx)), "passthrough", "{a} 应只读放行");
        }
        // 已授权窗口 pattern 动作 → Passthrough
        assert_eq!(kind(&desktop("uia_pattern").check_permissions(&ctx)), "passthrough");
        // 首次接管 → Ask（文案含窗口标题）
        match desktop("uia_grant").check_permissions(&ctx) {
            PermissionResult::Ask { reason, .. } => {
                assert!(reason.contains("测试窗口"), "接管文案应含窗口标题: {reason}");
            }
            other => panic!("uia_grant 应 Ask，实际 {}", kind(&other)),
        }
        // 敏感目标 → Ask（文案区分 click/type）
        for a in ["uia_click_sensitive", "uia_type_sensitive"] {
            assert_eq!(kind(&desktop(a).check_permissions(&ctx)), "ask", "{a} 应 Ask");
        }
        // 物理输入 → Ask（含 hwnd）
        match desktop("uia_physical").check_permissions(&ctx) {
            PermissionResult::Ask { reason, .. } => {
                assert!(reason.contains("hwnd=1234"), "物理输入文案应含 hwnd: {reason}");
            }
            other => panic!("uia_physical 应 Ask，实际 {}", kind(&other)),
        }
        // 全屏截图 → Ask（从 read-only 移除后的高隐私面收口）
        assert_eq!(kind(&desktop("screenshot").check_permissions(&ctx)), "ask");
        // keys/activate → Ask
        assert_eq!(kind(&desktop("uia_keys").check_permissions(&ctx)), "ask");
        assert_eq!(kind(&desktop("uia_activate").check_permissions(&ctx)), "ask");
        // 旧名兜底 → Ask
        assert_eq!(kind(&desktop("whatever").check_permissions(&ctx)), "ask");
        // is_read_only：screenshot 不在列
        assert!(!desktop("screenshot").is_read_only());
        assert!(desktop("uia_tree").is_read_only());
        // uia_pattern 已授权但仍属真实写操作 —— is_destructive 保持 true（调度保守）
        assert!(desktop("uia_pattern").is_destructive());
    }

    /// 分类矩阵：敏感 > 物理 > 已授权 pattern > 首次接管。
    /// 与 desktop_uia_write 的编排逻辑共享此纯函数，矩阵锁住优先级序。
    #[test]
    fn classify_uia_action_matrix() {
        let full = UiaTargetCaps { has_invoke: true, has_toggle: true, has_select: true, has_value: true, has_scroll: true };
        let bare = UiaTargetCaps::default();

        // 普通控件 + 已授权 → pattern 放行
        assert_eq!(classify_uia_action("click", "OK", false, "", &full, true), "uia_pattern");
        // 普通控件 + 未授权 → 首次接管
        assert_eq!(classify_uia_action("click", "OK", false, "", &full, false), "uia_grant");
        // 敏感词点击：即使已授权也每次单独 Ask（优先级最高）
        for name in ["确认支付", "Pay now", "Delete account"] {
            assert_eq!(classify_uia_action("click", name, false, "", &full, true), "uia_click_sensitive", "{name}");
        }
        // 右键命中敏感词 → click_sensitive（物理性被敏感性覆盖）
        assert_eq!(classify_uia_action("right_click", "删除", false, "", &bare, true), "uia_click_sensitive");
        // type：密码框 / 已填值 → sensitive（优先于 has_value 判定）
        assert_eq!(classify_uia_action("type", "Password", true, "", &full, true), "uia_type_sensitive");
        assert_eq!(classify_uia_action("type", "搜索", false, "旧值", &full, true), "uia_type_sensitive");
        // type：普通空输入框 + 已授权 → pattern
        assert_eq!(classify_uia_action("type", "搜索", false, "", &full, true), "uia_pattern");
        // 无 pattern 可用 → 物理（已授权也拦不住，执行前要租约）
        assert_eq!(classify_uia_action("click", "OK", false, "", &bare, true), "uia_physical");
        assert_eq!(classify_uia_action("right_click", "图标", false, "", &full, true), "uia_physical");
        assert_eq!(classify_uia_action("type", "画布输入", false, "", &bare, true), "uia_physical");
        assert_eq!(classify_uia_action("scroll", "列表", false, "", &bare, true), "uia_physical");
        // select/expand：pattern-only，永不物理
        assert_eq!(classify_uia_action("select", "列表项", false, "", &bare, true), "uia_pattern");
        assert_eq!(classify_uia_action("expand", "组合框", false, "", &bare, false), "uia_grant");
        assert!(!uia_action_needs_physical("select", &bare));
        assert!(!uia_action_needs_physical("expand", &bare));
    }
}

// WebFetchTool — web_fetch
// ═══════════════════════════════════════════════════════════════

pub struct WebFetchTool {
    pub url: String,
    pub agent_id: Option<String>,
}

impl Tool for WebFetchTool {
    fn name(&self) -> &'static str {
        "WebFetch"
    }

    fn get_path(&self) -> Option<PathBuf> {
        None
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        web::check(&self.url, &rules)
    }
}
