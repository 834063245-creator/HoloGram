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
// BrowserTool — browser_launch / browser_attach / browser_eval 等
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
        matches!(self.action.as_str(), "targets" | "inspect" | "report" | "status")
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
        // 4. 高危动作：launch（启动受控浏览器）/ attach（接管外部页面）/ eval（任意 JS）→ Ask
        PermissionResult::Ask {
            reason: format!("Agent 请求控制浏览器（动作: {}）", self.action),
            suggestions: vec![PermissionUpdate {
                rule: "Browser".into(),
                behavior: "allow".into(),
            }],
            danger: Some("browser 控制".into()),
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
