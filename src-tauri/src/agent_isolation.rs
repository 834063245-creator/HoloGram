// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 隔离 — 沙箱化 agent 运行的 git worktree 生命周期管理 (spec §5)
// - create_worktree: git worktree add --detach .hologram/worktrees/agent-{id}
// - map_path: 双向映射（正向用于文件操作，反向用于权限规则）
// - cleanup: diff 检查 → 移除或保留

use std::path::{Path, PathBuf};

/// 创建一个带 CREATE_NO_WINDOW 标志的 git Command（Windows 上防止控制台闪烁）。
pub(crate) fn git_cmd() -> std::process::Command {
    let mut c = std::process::Command::new("git");
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(crate::utils::NO_WINDOW); }
    c
}

/// agent 操作的隔离级别。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IsolationKind {
    None,
    Worktree,
}

/// 工作树清理结果。
#[derive(Debug)]
pub enum CleanupResult {
    /// 工作树无变更，已移除。
    NoChanges,
    /// 工作树有待处理变更 — 向用户展示 diff。
    HasChanges { diff: String, worktree_path: PathBuf },
}

/// Agent 隔离状态 — worktree 生命周期 + 路径映射。
#[derive(Debug, Clone)]
pub struct AgentIsolation {
    pub kind: IsolationKind,
    pub worktree_path: Option<PathBuf>,
    pub original_head: String,
    pub main_repo_path: PathBuf,
}

impl AgentIsolation {
    /// 创建无隔离实例（agent 直接在主仓库中工作）。
    #[allow(dead_code)] // 尚未接入 agent 隔离 UI 流程
    pub fn none(main_repo_path: &Path) -> Self {
        Self {
            kind: IsolationKind::None,
            worktree_path: None,
            original_head: String::new(),
            main_repo_path: main_repo_path.to_path_buf(),
        }
    }

    /// 为 agent 隔离创建一个 git worktree。
    /// 使用 `agent-{id}` 作为 `.hologram/worktrees/` 下的 worktree 名称。
    /// 验证 id 以防止路径穿越 (spec §5.5)。
    pub fn create_worktree(main_repo_path: &Path, agent_id: &str) -> Result<Self, String> {
        validate_agent_id(agent_id)?;

        let slug = format!("agent-{}", agent_id);
        let worktree_dir = main_repo_path
            .join(".hologram")
            .join("worktrees")
            .join(&slug);

        // 如有需要则创建父目录
        if let Some(parent) = worktree_dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建工作树目录: {e}"))?;
        }

        // 获取当前 HEAD
        let head = git_rev_parse(main_repo_path, "HEAD")?;

        // git worktree add --detach <path>
        let output = git_cmd()
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

    /// 反向映射：worktree 物理路径 → 主仓库逻辑路径。
    /// 用于权限规则匹配，使用户规则如 `Edit("src/**")` 能匹配
    /// worktree 路径如 `.hologram/worktrees/agent-abc/src/main.rs` (spec §5.6)。
    pub fn reverse_map(&self, path: &Path) -> PathBuf {
        if self.kind == IsolationKind::None {
            return path.to_path_buf();
        }
        if let Some(ref wt) = self.worktree_path {
            if let Ok(rel) = path.strip_prefix(wt) {
                return self.main_repo_path.join(rel);
            }
        }
        // 路径不在 worktree 下 — 原样返回（如 /tmp 路径、外部读取）
        path.to_path_buf()
    }

    /// 正向映射：主仓库逻辑路径 → worktree 物理路径。
    /// 用于 agent 提供逻辑路径而 Rust 后端需要将其解析为
    /// worktree 物理位置的实际文件操作 (spec §5.6)。
    /// - worktree 绝对路径 → 原样返回
    /// - 主仓库绝对路径 → 映射到 worktree 等价路径
    /// - 相对路径 → 相对 worktree 根目录解析
    pub fn forward_map(&self, path: &Path) -> PathBuf {
        if self.kind == IsolationKind::None {
            return path.to_path_buf();
        }
        if let Some(ref wt) = self.worktree_path {
            // 已在 worktree 中 → 原样返回（幂等）
            if path.starts_with(wt) {
                return path.to_path_buf();
            }
            // 主仓库绝对路径 → 映射到 worktree
            if path.is_absolute() {
                if let Ok(rel) = path.strip_prefix(&self.main_repo_path) {
                    return wt.join(rel);
                }
            }
            // 相对路径 → 相对 worktree 根目录解析
            if path.is_relative() {
                return wt.join(path);
            }
        }
        path.to_path_buf()
    }

    /// 清理工作树。若有变更则返回 diff，否则移除工作树。
    pub fn cleanup(&self) -> Result<CleanupResult, String> {
        if self.kind == IsolationKind::None {
            return Ok(CleanupResult::NoChanges);
        }
        let wt = self.worktree_path.as_ref().ok_or("工作树路径不存在")?;

        if !wt.exists() {
            return Ok(CleanupResult::NoChanges);
        }

        // git diff --stat HEAD
        let stat = run_git(wt, &["diff", "--stat", "HEAD"])?;;
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

    /// 通过 cherry-pick 将 worktree 变更合并回主仓库。
    /// 成功后移除 worktree。
    pub fn merge_to_main(&self) -> Result<String, String> {
        if self.kind == IsolationKind::None {
            return Err("非工作树模式".into());
        }
        let wt = self.worktree_path.as_ref().ok_or("工作树路径不存在")?;

        // 检查 worktree 目录是否存在，在访问 git 之前
        if !wt.exists() {
            return Err("工作树目录不存在，无法合并。请检查 TaskBoard 上的 diff 备份。".into());
        }

        let head = match git_rev_parse(wt, "HEAD") {
            Ok(h) => h,
            Err(_) => {
                // HEAD 解析失败 — 降级：尝试 git diff 抢救变更
                let diff = run_git(wt, &["diff"]).unwrap_or_default();
                let stat = run_git(wt, &["diff", "--stat"]).unwrap_or_default();
                if diff.trim().is_empty() {
                    // 无变更可抢救 — 清理
                    let _ = remove_worktree(&self.main_repo_path, wt);
                    return Ok("没有变更需要合并".into());
                }
                // 有 diff 但无法 cherry-pick — 返回降级结果
                return Err(format!(
                    "DEGRADED: worktree git 元数据损坏，无法 cherry-pick。已降级提取 diff:\n{}\n{}",
                    stat, diff
                ));
            }
        };

        if head == self.original_head {
            // 无提交 — 但可能有未暂存的变更。尝试提交它们。
            let diff_stat = run_git(wt, &["diff", "--stat", "HEAD"])?;
            if diff_stat.trim().is_empty() {
                remove_worktree(&self.main_repo_path, wt)?;
                return Ok("没有变更需要合并".into());
            }
            // cherry-pick 前自动提交未暂存的变更
            run_git(wt, &["add", "-A"])?;
            run_git(wt, &["commit", "-m", "Agent worktree changes"])?;
            let head = git_rev_parse(wt, "HEAD")?;
            return self.cherry_pick_and_clean(&head, wt);
        }

        self.cherry_pick_and_clean(&head, wt)
    }

    fn cherry_pick_and_clean(&self, commit: &str, wt: &Path) -> Result<String, String> {
        let main = normalize(&self.main_repo_path);
        let output = git_cmd()
            .args(["-C", &main, "cherry-pick", commit])
            .output()
            .map_err(|e| format!("git cherry-pick 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // 中止 cherry-pick 以保持主仓库干净
            match git_cmd().args(["-C", &main, "cherry-pick", "--abort"]).output() {
                Err(e) => return Err(format!("merge 失败且 cherry-pick --abort 失败: {e}。请手动 git cherry-pick --abort")),
                Ok(abort) if !abort.status.success() => {
                    let abort_stderr = String::from_utf8_lossy(&abort.stderr);
                    return Err(format!("merge 失败且 cherry-pick --abort 失败: {abort_stderr}。请手动 git cherry-pick --abort"));
                }
                Ok(_) => {}
            }
            return Err(format!("合并失败 (cherry-pick 已中止): {stderr}"));
        }

        remove_worktree(&self.main_repo_path, wt)?;
        let short = &commit[..8.min(commit.len())];
        Ok(format!("已合并变更 (commit: {short})"))
    }

    /// 丢弃 worktree 变更并移除它。
    pub fn discard(&self) -> Result<(), String> {
        if self.kind == IsolationKind::None {
            return Ok(());
        }
        let wt = self.worktree_path.as_ref().ok_or("工作树路径不存在")?;

        // 目录已不存在 — 清理 git 元数据并返回 Ok
        if !wt.exists() {
            let _ = git_cmd()
                .args(["-C", &normalize(&self.main_repo_path), "worktree", "prune"])
                .output();
            return Ok(());
        }

        remove_worktree(&self.main_repo_path, wt)
    }
}

// ── 辅助函数 ──────────────────────────────────────────────────────

/// 验证 agent id slug — 防止路径穿越 (spec §5.5)。
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
    let output = git_cmd()
        .args(["-C", &normalize(repo_path), "rev-parse", refname])
        .output()
        .map_err(|e| format!("git rev-parse 失败: {e}"))?;

    if !output.status.success() {
        return Err("无法获取 HEAD commit".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_cmd()
        .args(["-C", &normalize(repo_path)])
        .args(args)
        .output()
        .map_err(|e| format!("git 命令失败: {e}"))?;
    // git diff 在有差异时退出码为 1 — 这不是错误。
    // 退出码 >= 2 才表示真正的 git 失败。
    if !output.status.success() && output.status.code().unwrap_or(-1) > 1 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {:?} 失败: {}", args, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn remove_worktree(main_repo_path: &Path, worktree_path: &Path) -> Result<(), String> {
    let output = git_cmd()
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
        // 回退：手动清理
        if worktree_path.exists() {
            let _ = std::fs::remove_dir_all(worktree_path);
        }
        let _ = git_cmd()
            .args(["-C", &normalize(main_repo_path), "worktree", "prune"])
            .output();
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("工作树清理失败: {stderr}"));
    }
    Ok(())
}

/// 将路径标准化为字符串，用于传递给 git 命令。
fn normalize(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 清理超过 `ttl_minutes` 且无活跃 agent 的 worktree。
/// 返回已清理的 worktree 数量。
pub fn prune_stale_worktrees(main_repo_path: &Path, ttl_minutes: u64) -> Result<usize, String> {
    let worktrees_dir = main_repo_path.join(".hologram").join("worktrees");
    if !worktrees_dir.exists() {
        return Ok(0);
    }
    let cutoff = std::time::SystemTime::now()
        - std::time::Duration::from_secs(ttl_minutes * 60);
    let mut pruned = 0;
    for entry in std::fs::read_dir(&worktrees_dir)
        .map_err(|e| format!("读取 worktrees 目录失败: {e}"))?
    {
        let entry = entry.map_err(|e| format!("目录遍历失败: {e}"))?;
        let meta = entry.metadata().ok();
        if let Some(meta) = meta {
            if let Ok(modified) = meta.modified() {
                if modified < cutoff {
                    remove_worktree(main_repo_path, &entry.path()).ok();
                    pruned += 1;
                }
            }
        }
    }
    Ok(pruned)
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
        assert_eq!(result, input); // 已在 worktree 中，不变
    }

    #[test]
    fn test_run_git_errors_on_non_repo() {
        // git status 在非仓库目录退出码为 128 → run_git 应返回 Err
        let tmp = std::env::temp_dir().join("hologram_test_nonrepo");
        let _ = std::fs::create_dir_all(&tmp);
        let result = run_git(&tmp, &["status"]);
        assert!(result.is_err(), "git status on non-repo should error");
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn test_run_git_succeeds_on_exit_code_0() {
        // 创建真实 git 仓库，提交，然后运行 `git log --oneline`（退出码 0）
        let tmp = std::env::temp_dir().join("hologram_test_git_ok");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["init", "--quiet"])
            .status().unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["config", "user.email", "test@test.com"])
            .status().unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["config", "user.name", "Test"])
            .status().unwrap();
        std::fs::write(tmp.join("file.txt"), "hello").unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["add", "-A"])
            .status().unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["commit", "-m", "init", "--quiet"])
            .status().unwrap();

        let result = run_git(&tmp, &["log", "--oneline"]);
        assert!(result.is_ok(), "git log (exit 0) should succeed: {:?}", result);
        assert!(result.unwrap().contains("init"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_run_git_succeeds_on_exit_code_1() {
        // git diff --stat HEAD 在有未提交变更时退出码为 1 — 这不是错误。
        let tmp = std::env::temp_dir().join("hologram_test_git_diff");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["init", "--quiet"])
            .status().unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["config", "user.email", "test@test.com"])
            .status().unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["config", "user.name", "Test"])
            .status().unwrap();
        std::fs::write(tmp.join("file.txt"), "v1").unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["add", "-A"])
            .status().unwrap();
        std::process::Command::new("git")
            .args(["-C"]).arg(&tmp)
            .args(["commit", "-m", "init", "--quiet"])
            .status().unwrap();
        // 引入未提交变更 → git diff 退出码为 1
        std::fs::write(tmp.join("file.txt"), "v2").unwrap();

        let result = run_git(&tmp, &["diff", "--stat", "HEAD"]);
        assert!(result.is_ok(), "git diff (exit 1 with changes) should NOT be an error: {:?}", result);
        assert!(!result.unwrap().is_empty(), "should have diff output");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_discard_missing_directory_returns_ok() {
        // discard() 在不存在的 worktree 目录上应返回 Ok
        let tmp = std::env::temp_dir().join("hologram_test_discard_missing");
        let wt = tmp.join("nonexistent_worktree");
        let iso = AgentIsolation {
            kind: IsolationKind::Worktree,
            worktree_path: Some(wt.clone()),
            original_head: "abc123".into(),
            main_repo_path: tmp.clone(),
        };
        assert!(!wt.exists(), "sanity: worktree dir should not exist");
        let result = iso.discard();
        assert!(result.is_ok(), "discard() on missing dir should return Ok, got: {:?}", result);
    }

    #[test]
    fn test_merge_to_main_missing_directory_returns_error() {
        // merge_to_main() 在不存在的 worktree 目录上应返回 Err
        let tmp = std::env::temp_dir().join("hologram_test_merge_missing");
        let wt = tmp.join("nonexistent_worktree");
        let iso = AgentIsolation {
            kind: IsolationKind::Worktree,
            worktree_path: Some(wt.clone()),
            original_head: "abc123".into(),
            main_repo_path: tmp.clone(),
        };
        assert!(!wt.exists(), "sanity: worktree dir should not exist");
        let result = iso.merge_to_main();
        assert!(result.is_err(), "merge_to_main() on missing dir should return Err");
        let err = result.unwrap_err();
        assert!(
            err.contains("工作树目录不存在"),
            "error should mention directory not existing, got: {}",
            err
        );
    }
}
