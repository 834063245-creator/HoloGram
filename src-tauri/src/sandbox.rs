// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// v4 Phase 2 — 降级为纯路径解析层：canonicalize + symlink/junction 检测
// 裁决逻辑已移至 permissions/ 模块。Sandbox 现被 permissions/filesystem.rs 调用，
// 不再独立裁决。
use std::path::{Path, PathBuf};

/// 沙箱路径解析检查的结果。
#[derive(Debug)]
pub enum SandboxResult {
    Allowed(PathBuf), // 已规范化、已验证的路径
    Denied(String),   // 拒绝原因
}

/// 路径验证 — 规范化、检查符号链接、验证前缀。
pub struct Sandbox {
    project_root: PathBuf, // 已规范化
}

impl Sandbox {
    pub fn new(project_root: &Path) -> Self {
        let root =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        Self {
            project_root: root,
        }
    }

    /// 验证对 `path` 的读取操作。
    /// 全局记忆路径绕过项目沙箱（与写入相同）。
    pub fn resolve_read(&self, path: &Path) -> SandboxResult {
        // 全局记忆绕过
        if Self::is_global_memory_path(path) {
            let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            if is_symlink_or_junction(path) {
                return SandboxResult::Denied("global memory symlinks are not allowed".into());
            }
            return SandboxResult::Allowed(real);
        }

        let real = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                if let Some(parent) = path.parent() {
                    match std::fs::canonicalize(parent) {
                        Ok(p) => p.join(path.file_name().unwrap_or_default()),
                        Err(_) => return SandboxResult::Denied("parent directory not found".into()),
                    }
                } else {
                    return SandboxResult::Denied("invalid path".into());
                }
            }
        };

        // 拒绝符号链接 / junction
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        // 检查项目根目录前缀
        if real.starts_with(&self.project_root) {
            return SandboxResult::Allowed(real);
        }

        SandboxResult::Denied(format!(
            "path {:?} is outside project directory {:?}",
            real, self.project_root
        ))
    }

    /// 检查此路径是否在全局记忆目录下。
    /// Agent 管理的记忆设计上位于项目沙箱之外。
    fn is_global_memory_path(path: &Path) -> bool {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() { return false; }
        let gm = PathBuf::from(&home).join(".hologram").join("global_memory");
        // 检查原始路径和规范化版本
        path.starts_with(&gm) || {
            std::fs::canonicalize(path)
                .map(|p| p.starts_with(&gm))
                .unwrap_or(false)
        }
    }

    /// 验证写入操作。锁定到项目目录，
    /// 全局记忆目录除外（agent 管理）。
    pub fn resolve_write(&self, path: &Path) -> SandboxResult {
        // 全局记忆绕过：agent 写入 ~/.hologram/global_memory/
        // 无论项目沙箱边界如何都始终允许。
        if Self::is_global_memory_path(path) {
            let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            // 安全检查仍然适用 — 记忆路径不允许符号链接
            if is_symlink_or_junction(path) {
                return SandboxResult::Denied("global memory symlinks are not allowed".into());
            }
            return SandboxResult::Allowed(real);
        }

        let real = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                if let Some(parent) = path.parent() {
                    match std::fs::canonicalize(parent) {
                        Ok(p) => p.join(path.file_name().unwrap_or_default()),
                        Err(_) => {
                            match find_existing_ancestor(path) {
                                Some((canon_ancestor, orig_ancestor)) => {
                                    if !canon_ancestor.starts_with(&self.project_root) {
                                        return SandboxResult::Denied(format!(
                                            "write outside project root {:?}",
                                            self.project_root
                                        ));
                                    }
                                    let relative =
                                        path.strip_prefix(&orig_ancestor).unwrap_or(path);
                                    canon_ancestor.join(relative)
                                }
                                None => {
                                    return SandboxResult::Denied(
                                        "parent directory not found".into(),
                                    )
                                }
                            }
                        }
                    }
                } else {
                    return SandboxResult::Denied("invalid path".into());
                }
            }
        };

        // 验证在 project_root 内
        if !real.starts_with(&self.project_root) {
            return SandboxResult::Denied(format!(
                "write to {:?} denied: outside project root {:?}",
                real, self.project_root
            ));
        }

        // 拒绝符号链接 / junction
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        SandboxResult::Allowed(real)
    }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数：路径穿越
// ═══════════════════════════════════════════════════════════════

/// 向上遍历目录树，查找最近的已存在祖先。
fn find_existing_ancestor(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = path.to_path_buf();
    while let Some(parent) = current.parent() {
        if parent.as_os_str().is_empty() {
            break;
        }
        current = parent.to_path_buf();
        if current.exists() {
            if let Ok(canon) = std::fs::canonicalize(&current) {
                return Some((canon, current));
            }
        }
    }
    None
}

/// 检测 Windows 上的 NTFS 符号链接和 junction。
#[cfg(windows)]
fn is_symlink_or_junction(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    if let Ok(meta) = path.symlink_metadata() {
        // FILE_ATTRIBUTE_REPARSE_POINT = 0x400
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

#[cfg(not(windows))]
fn is_symlink_or_junction(path: &Path) -> bool {
    path.is_symlink()
}

/// 将 ~ 展开为用户 home 目录。
/// 被 permissions/bash.rs 用于从 shell 命令中提取路径。
pub fn expand_home(raw: &str) -> PathBuf {
    if raw.starts_with("~/") {
        #[cfg(windows)]
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        #[cfg(not(windows))]
        let home = std::env::var("HOME").unwrap_or_default();
        if !home.is_empty() {
            return PathBuf::from(home).join(&raw[2..]);
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── resolve_read ──

    #[test]
    fn test_read_inside_project() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("test.txt"), "hello").unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_read(&tmp.join("test.txt"));
        assert!(matches!(result, SandboxResult::Allowed(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_read_outside_project_denied() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test2");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_read(Path::new("C:\\Windows\\System32\\notepad.exe"));
        assert!(matches!(result, SandboxResult::Denied(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── resolve_write ──

    #[test]
    fn test_write_locked_to_project() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test3");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_write(&tmp.join("new_file.txt"));
        assert!(matches!(result, SandboxResult::Allowed(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
