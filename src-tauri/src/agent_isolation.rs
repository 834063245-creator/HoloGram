// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent Isolation — git worktree lifecycle for sandboxed agent runs (spec §5)
// - create_worktree: git worktree add --detach .hologram/worktrees/agent-{id}
// - map_path: bidirectional (forward for file ops, reverse for permission rules)
// - cleanup: diff check → remove or preserve

use std::path::{Path, PathBuf};

/// Isolation level for agent operations.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IsolationKind {
    None,
    Worktree,
}

/// Result of worktree cleanup.
#[derive(Debug)]
pub enum CleanupResult {
    /// Worktree had no changes and was removed.
    NoChanges,
    /// Worktree has pending changes — diff shown to user.
    HasChanges { diff: String, worktree_path: PathBuf },
}

/// Agent isolation state — worktree lifecycle + path mapping.
#[derive(Debug, Clone)]
pub struct AgentIsolation {
    pub kind: IsolationKind,
    pub worktree_path: Option<PathBuf>,
    pub original_head: String,
    pub main_repo_path: PathBuf,
}

impl AgentIsolation {
    /// Create a no-isolation instance (agent works directly in main repo).
    pub fn none(main_repo_path: &Path) -> Self {
        Self {
            kind: IsolationKind::None,
            worktree_path: None,
            original_head: String::new(),
            main_repo_path: main_repo_path.to_path_buf(),
        }
    }

    /// Create a git worktree for agent isolation.
    /// Uses `agent-{id}` as the worktree name under `.hologram/worktrees/`.
    /// Validates the id to prevent path traversal (spec §5.5).
    pub fn create_worktree(main_repo_path: &Path, agent_id: &str) -> Result<Self, String> {
        validate_agent_id(agent_id)?;

        let slug = format!("agent-{}", agent_id);
        let worktree_dir = main_repo_path
            .join(".hologram")
            .join("worktrees")
            .join(&slug);

        // Create parent dir if needed
        if let Some(parent) = worktree_dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建工作树目录: {e}"))?;
        }

        // Get current HEAD
        let head = git_rev_parse(main_repo_path, "HEAD")?;

        // git worktree add --detach <path>
        let output = std::process::Command::new("git")
            .args(["-C"])
            .arg(normalize(main_repo_path))
            .args(["worktree", "add", "--detach"])
            .arg(normalize(&worktree_dir))
            .output()
            .map_err(|e| format!("git worktree add 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add 失败: {stderr}"));
        }

        Ok(Self {
            kind: IsolationKind::Worktree,
            worktree_path: Some(worktree_dir),
            original_head: head,
            main_repo_path: main_repo_path.to_path_buf(),
        })
    }

    /// Reverse map: worktree physical path → main repo logical path.
    /// Used for permission rule matching so user rules like `Edit("src/**")` match
    /// worktree paths like `.hologram/worktrees/agent-abc/src/main.rs` (spec §5.6).
    pub fn reverse_map(&self, path: &Path) -> PathBuf {
        if self.kind == IsolationKind::None {
            return path.to_path_buf();
        }
        if let Some(ref wt) = self.worktree_path {
            if let Ok(rel) = path.strip_prefix(wt) {
                return self.main_repo_path.join(rel);
            }
        }
        // Path not under worktree — return as-is (e.g. /tmp paths, external reads)
        path.to_path_buf()
    }

    /// Forward map: main repo logical path → worktree physical path.
    /// Used for actual file operations when the agent provides logical paths and the
    /// Rust backend needs to resolve them to worktree physical locations (spec §5.6).
    /// - Absolute worktree paths → return as-is
    /// - Absolute main-repo paths → map to worktree equivalent
    /// - Relative paths → resolve against worktree root
    pub fn forward_map(&self, path: &Path) -> PathBuf {
        if self.kind == IsolationKind::None {
            return path.to_path_buf();
        }
        if let Some(ref wt) = self.worktree_path {
            // Already in worktree → return as-is (idempotent)
            if path.starts_with(wt) {
                return path.to_path_buf();
            }
            // Absolute path in main repo → map to worktree
            if path.is_absolute() {
                if let Ok(rel) = path.strip_prefix(&self.main_repo_path) {
                    return wt.join(rel);
                }
            }
            // Relative path → resolve against worktree root
            if path.is_relative() {
                return wt.join(path);
            }
        }
        path.to_path_buf()
    }

    /// Clean up the worktree. Returns diff if changes exist, removes it otherwise.
    pub fn cleanup(&self) -> Result<CleanupResult, String> {
        if self.kind == IsolationKind::None {
            return Ok(CleanupResult::NoChanges);
        }
        let wt = self.worktree_path.as_ref().ok_or("工作树路径不存在")?;

        if !wt.exists() {
            return Ok(CleanupResult::NoChanges);
        }

        // git diff --stat HEAD
        let stat = run_git(wt, &["diff", "--stat", "HEAD"])?;
        let full = run_git(wt, &["diff", "HEAD"])?;

        if stat.trim().is_empty() {
            remove_worktree(&self.main_repo_path, wt)?;
            Ok(CleanupResult::NoChanges)
        } else {
            Ok(CleanupResult::HasChanges {
                diff: format!("{stat}\n\n{full}"),
                worktree_path: wt.clone(),
            })
        }
    }

    /// Merge worktree changes back to main repo via cherry-pick.
    /// Removes the worktree on success.
    pub fn merge_to_main(&self) -> Result<String, String> {
        if self.kind == IsolationKind::None {
            return Err("非工作树模式".into());
        }
        let wt = self.worktree_path.as_ref().ok_or("工作树路径不存在")?;

        let head = git_rev_parse(wt, "HEAD")?;
        if head == self.original_head {
            // No commits — but there might be unstaged changes. Try to commit them.
            let diff_stat = run_git(wt, &["diff", "--stat", "HEAD"])?;
            if diff_stat.trim().is_empty() {
                remove_worktree(&self.main_repo_path, wt)?;
                return Ok("没有变更需要合并".into());
            }
            // Auto-commit unstaged changes before cherry-pick
            run_git(wt, &["add", "-A"])?;
            run_git(wt, &["commit", "-m", "Agent worktree changes"])?;
            let head = git_rev_parse(wt, "HEAD")?;
            return self.cherry_pick_and_clean(&head, wt);
        }

        self.cherry_pick_and_clean(&head, wt)
    }

    fn cherry_pick_and_clean(&self, commit: &str, wt: &Path) -> Result<String, String> {
        let main = normalize(&self.main_repo_path);
        let output = std::process::Command::new("git")
            .args(["-C", &main, "cherry-pick", commit])
            .output()
            .map_err(|e| format!("git cherry-pick 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Abort cherry-pick if it failed
            let _ = std::process::Command::new("git")
                .args(["-C", &main, "cherry-pick", "--abort"])
                .output();
            return Err(format!("合并失败: {stderr}"));
        }

        remove_worktree(&self.main_repo_path, wt)?;
        let short = &commit[..8.min(commit.len())];
        Ok(format!("已合并变更 (commit: {short})"))
    }

    /// Discard worktree changes and remove it.
    pub fn discard(&self) -> Result<(), String> {
        if self.kind == IsolationKind::None {
            return Ok(());
        }
        let wt = self.worktree_path.as_ref().ok_or("工作树路径不存在")?;
        remove_worktree(&self.main_repo_path, wt)
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Validate agent id slug — prevents path traversal (spec §5.5).
fn validate_agent_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("agent id 不能为空".into());
    }
    if id.len() > 64 {
        return Err("agent id 过长 (最大 64 字符)".into());
    }
    for seg in id.split('/') {
        if seg == "." || seg == ".." {
            return Err("agent id 不允许路径穿越".into());
        }
        if !seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return Err(format!("agent id 含无效字符: '{seg}'"));
        }
    }
    Ok(())
}

fn git_rev_parse(repo_path: &Path, refname: &str) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["-C", &normalize(repo_path), "rev-parse", refname])
        .output()
        .map_err(|e| format!("git rev-parse 失败: {e}"))?;

    if !output.status.success() {
        return Err("无法获取 HEAD commit".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["-C", &normalize(repo_path)])
        .args(args)
        .output()
        .map_err(|e| format!("git 命令失败: {e}"))?;
    // git diff may exit 0 with empty output or 1 with diff output
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn remove_worktree(main_repo_path: &Path, worktree_path: &Path) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args([
            "-C",
            &normalize(main_repo_path),
            "worktree",
            "remove",
            "--force",
            &normalize(worktree_path),
        ])
        .output()
        .map_err(|e| format!("git worktree remove 失败: {e}"))?;

    if !output.status.success() {
        // Fallback: manual cleanup
        if worktree_path.exists() {
            let _ = std::fs::remove_dir_all(worktree_path);
        }
        let _ = std::process::Command::new("git")
            .args(["-C", &normalize(main_repo_path), "worktree", "prune"])
            .output();
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("工作树清理失败: {stderr}"));
    }
    Ok(())
}

/// Normalize a path to a string for passing to git commands.
fn normalize(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_agent_id_valid() {
        assert!(validate_agent_id("abc123").is_ok());
        assert!(validate_agent_id("agent_42.test-x").is_ok());
    }

    #[test]
    fn test_validate_agent_id_traversal() {
        assert!(validate_agent_id("..").is_err());
        assert!(validate_agent_id("foo/../bar").is_err());
        assert!(validate_agent_id(".").is_err());
    }

    #[test]
    fn test_validate_agent_id_too_long() {
        let long = "a".repeat(65);
        assert!(validate_agent_id(&long).is_err());
    }

    #[test]
    fn test_validate_agent_id_empty() {
        assert!(validate_agent_id("").is_err());
    }

    #[test]
    fn test_reverse_map_worktree() {
        let main = PathBuf::from("D:/project");
        let wt = main.join(".hologram/worktrees/agent-abc");
        let iso = AgentIsolation {
            kind: IsolationKind::Worktree,
            worktree_path: Some(wt),
            original_head: "abc123".into(),
            main_repo_path: main.clone(),
        };
        let result = iso.reverse_map(Path::new(
            "D:/project/.hologram/worktrees/agent-abc/src/main.rs",
        ));
        assert_eq!(result, PathBuf::from("D:/project/src/main.rs"));
    }

    #[test]
    fn test_reverse_map_none_isolation() {
        let iso = AgentIsolation::none(Path::new("D:/project"));
        let result = iso.reverse_map(Path::new("D:/project/src/main.rs"));
        assert_eq!(result, PathBuf::from("D:/project/src/main.rs"));
    }

    #[test]
    fn test_forward_map_worktree() {
        let main = PathBuf::from("D:/project");
        let wt = main.join(".hologram/worktrees/agent-abc");
        let iso = AgentIsolation {
            kind: IsolationKind::Worktree,
            worktree_path: Some(wt.clone()),
            original_head: "abc123".into(),
            main_repo_path: main,
        };
        let result = iso.forward_map(Path::new("D:/project/src/main.rs"));
        assert_eq!(result, wt.join("src/main.rs"));
    }

    #[test]
    fn test_forward_map_relative_path() {
        let main = PathBuf::from("D:/project");
        let wt = main.join(".hologram/worktrees/agent-abc");
        let iso = AgentIsolation {
            kind: IsolationKind::Worktree,
            worktree_path: Some(wt.clone()),
            original_head: "abc123".into(),
            main_repo_path: main,
        };
        let result = iso.forward_map(Path::new("src/main.rs"));
        assert_eq!(result, wt.join("src/main.rs"));
    }

    #[test]
    fn test_forward_map_worktree_idempotent() {
        let main = PathBuf::from("D:/project");
        let wt = main.join(".hologram/worktrees/agent-abc");
        let iso = AgentIsolation {
            kind: IsolationKind::Worktree,
            worktree_path: Some(wt.clone()),
            original_head: "abc123".into(),
            main_repo_path: main,
        };
        let input = wt.join("src/main.rs");
        let result = iso.forward_map(&input);
        assert_eq!(result, input); // already in worktree, unchanged
    }
}
