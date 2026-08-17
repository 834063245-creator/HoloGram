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

pub struct DesktopTool {
    pub action: String,
    pub agent_id: Option<String>,
}

impl Tool for DesktopTool {
    fn name(&self) -> &'static str {
        "Desktop"
    }

    fn get_path(&self) -> Option<PathBuf> {
        None // 桌面快照/UIA 不针对单个文件
    }

    fn is_read_only(&self) -> bool {
        // 观察类: probe(进程/窗口快照) + screen/窗口截图 + UIA 读树/查找
        matches!(
            self.action.as_str(),
            "probe" | "screenshot" | "uia_tree" | "uia_find" | "uia_window_shot"
        )
    }

    fn is_destructive(&self) -> bool {
        // 写动作(点击/输入/滚动)会改变目标应用状态
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
        // 3. 观察类动作放行（probe / 截图 / UIA 读树/查找 — 不改变桌面状态）
        if self.is_read_only() {
            return PermissionResult::Passthrough;
        }
        // 4. 写动作 → Ask（真实点击/输入/滚动到目标应用，可能触发保存/发送/删除等副作用）
        let reason = match self.action.as_str() {
            "uia_click" | "uia_right_click" => {
                "Agent 请求向一个桌面应用界面注入真实鼠标点击。\
                 点击可能触发保存、发送、删除、提交等不可逆操作，请确认目标应用与动作安全。".into()
            }
            "uia_type" => {
                "Agent 请求向一个桌面应用的输入框注入文字。\
                 输入内容会真实写入目标应用，可能被保存或发送，请确认目标输入框与内容安全。".into()
            }
            "uia_scroll" => {
                "Agent 请求滚动一个桌面应用内的滚动区域。滚动本身无破坏性，但可能让敏感内容进入视野。".into()
            }
            _ => "Agent 请求控制桌面应用（动作: {}）".replace("{}", &self.action),
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
