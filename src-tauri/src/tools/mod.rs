// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool implementations — each Tauri command gets a Tool (spec §4.2 mapping table)
// Implements crate::permissions::Tool trait, delegates to permissions/* helpers.

use std::path::PathBuf;

use crate::permissions::{
    bash, filesystem, git, web, PermissionContext, PermissionResult, Tool,
};

// ═══════════════════════════════════════════════════════════════
// ReadTool — read_file_content, read_file_base64, list_directory,
//           glob, search_content, and read-only git commands
// ═══════════════════════════════════════════════════════════════

pub struct ReadTool {
    pub path: String,
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

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // Phase 3: reverse-map worktree path → main repo path for rule matching (spec §5.6)
        let logical = ctx.reverse_map_path(std::path::Path::new(&self.path));
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

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        // Phase 3: reverse-map worktree path → main repo path for rule matching (spec §5.6)
        let logical = ctx.reverse_map_path(std::path::Path::new(&self.path));
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
        None // bash commands operate on multiple paths, not a single file
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
        // push/commit/stash_pop/checkout can modify working tree
        true
    }

    fn requires_user_interaction(&self) -> bool {
        // ponytail: git destructive ops always need user interaction
        matches!(
            self.subcommand.as_str(),
            "push" | "commit" | "checkout" | "discard" | "stash_pop"
        )
    }

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        // First check the repo path is readable
        let rules = ctx.read_rules();
        let path_check = filesystem::check_read_permission(&self.repo_path, &ctx.sandbox, &rules, None);
        match path_check {
            PermissionResult::Deny { .. } => return path_check,
            _ => {}
        }
        // Then check the git subcommand
        git::check(&self.subcommand, &rules)
    }
}

// ═══════════════════════════════════════════════════════════════
// WebFetchTool — web_fetch
// ═══════════════════════════════════════════════════════════════

pub struct WebFetchTool {
    pub url: String,
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

    fn check_permissions(&self, ctx: &PermissionContext) -> PermissionResult {
        let rules = ctx.read_rules();
        web::check(&self.url, &rules)
    }
}
