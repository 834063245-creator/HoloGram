// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// v4 Phase 2 — 降级为纯路径解析层：canonicalize + symlink/junction 检测
// 裁决逻辑已移至 permissions/ 模块。Sandbox 现被 permissions/filesystem.rs 调用，
// 不再独立裁决。
use std::path::{Path, PathBuf};

/// Result of a sandbox path resolution check.
#[derive(Debug)]
pub enum SandboxResult {
    Allowed(PathBuf), // canonicalized, verified path
    Denied(String),   // reason for denial
}

/// Path verification — canonicalize, check symlinks, verify prefix.
pub struct Sandbox {
    project_root: PathBuf, // canonicalized
}

impl Sandbox {
    pub fn new(project_root: &Path) -> Self {
        let root =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        Self {
            project_root: root,
        }
    }

    /// Validate a read operation against `path`.
    pub fn resolve_read(&self, path: &Path) -> SandboxResult {
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

        // Reject symlinks / junctions
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        // Check project root prefix
        if real.starts_with(&self.project_root) {
            return SandboxResult::Allowed(real);
        }

        SandboxResult::Denied(format!(
            "path {:?} is outside project directory {:?}",
            real, self.project_root
        ))
    }

    /// Validate a write operation. Dead-locked to project directory.
    pub fn resolve_write(&self, path: &Path) -> SandboxResult {
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

        // Verify within project_root
        if !real.starts_with(&self.project_root) {
            return SandboxResult::Denied(format!(
                "write to {:?} denied: outside project root {:?}",
                real, self.project_root
            ));
        }

        // Reject symlinks / junctions
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        SandboxResult::Allowed(real)
    }
}

// ═══════════════════════════════════════════════════════════════
// Helpers: path traversal
// ═══════════════════════════════════════════════════════════════

/// Walk up the directory tree to find the nearest existing ancestor.
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

/// Detect NTFS symlinks and junctions on Windows.
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

/// Expand ~ to the user's home directory.
/// Used by permissions/bash.rs for path extraction from shell commands.
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
