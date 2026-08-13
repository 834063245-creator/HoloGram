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
            "targets" | "discover" | "inspect" | "report" | "status" | "snapshot" | "console" | "network" | "screenshot" | "audit"
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
        // 3. 只读动作放行（targets/inspect/report/status — 不改变任何状态）
        if self.is_read_only() {
            return PermissionResult::Passthrough;
        }
        // 4. 高危动作：launch/kill（受控浏览器进程）/ attach（接管外部页面）/
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
            "click_sensitive" => "Agent 请求点击一个敏感目标（提交按钮 / 下载 / 含确认、支付、删除等文本的元素）".into(),
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

// DesktopTool — desktop_probe / desktop_screenshot
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
        None // 桌面快照不针对单个文件
    }

    fn is_read_only(&self) -> bool {
        true // probe / screenshot 均为观察, 不改变状态
    }

    fn is_destructive(&self) -> bool {
        false
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
        // 3. probe = 进程表/窗口/控制台可见性快照(只读) → 放行
        if self.action == "probe" {
            return PermissionResult::Passthrough;
        }
        // 4. screenshot = 截进整个桌面(高隐私面) → Ask
        PermissionResult::Ask {
            reason: "Agent 请求截取整个屏幕(全屏截图)。截图中可能包含任意窗口的敏感内容                 (邮件/聊天/密码/其他应用界面)。请确认当前屏幕没有敏感信息后再批准。".into(),
            suggestions: vec![PermissionUpdate {
                rule: "Desktop".into(),
                behavior: "allow".into(),
            }],
            danger: Some("桌面截图".into()),
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
