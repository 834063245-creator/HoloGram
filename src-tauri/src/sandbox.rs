// v4 Phase 5 — 安全沙箱：目录监禁 + 读写分级 + 符号链接拒绝
use std::path::{Path, PathBuf};

/// Result of a sandbox check.
#[derive(Debug)]
pub enum SandboxResult {
    Allowed(PathBuf),   // canonicalized, verified path
    Denied(String),     // reason for denial
}

/// Path sandbox — all file operations go through this.
pub struct Sandbox {
    project_root: PathBuf,       // canonicalized
    read_whitelist: Vec<PathBuf>, // additional readable dirs
    write_root: PathBuf,         // write operations locked here
}

impl Sandbox {
    pub fn new(project_root: &Path) -> Self {
        // Canonicalize the project root for prefix comparisons
        let root = std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        Self {
            write_root: root.clone(),
            project_root: root,
            read_whitelist: Vec::new(),
        }
    }

    /// Add a directory to the read whitelist.
    #[allow(dead_code)]
    pub fn allow_read(&mut self, dir: &Path) {
        if let Ok(canon) = std::fs::canonicalize(dir) {
            self.read_whitelist.push(canon);
        }
    }

    /// Validate a read operation against `path`.
    pub fn resolve_read(&self, path: &Path) -> SandboxResult {
        // Resolve canonical path
        let real = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                // File doesn't exist yet (e.g. write of new file) — check parent
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

        // Check read whitelist
        for whitelist_dir in &self.read_whitelist {
            if real.starts_with(whitelist_dir) {
                return SandboxResult::Allowed(real);
            }
        }

        SandboxResult::Denied(format!(
            "path {:?} is outside project directory {:?}",
            real, self.project_root
        ))
    }

    /// Validate a write operation. Dead-locked to project directory.
    /// Unlike resolve_read, allows paths where the parent directory doesn't exist yet —
    /// write_file_content has its own create_dir_all to create missing parents.
    pub fn resolve_write(&self, path: &Path) -> SandboxResult {
        // Try normal resolution first (handles existing files and new files in existing dirs)
        let real = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                if let Some(parent) = path.parent() {
                    match std::fs::canonicalize(parent) {
                        Ok(p) => p.join(path.file_name().unwrap_or_default()),
                        Err(_) => {
                            // Parent doesn't exist — find nearest existing ancestor
                            match find_existing_ancestor(path) {
                                Some((canon_ancestor, orig_ancestor)) => {
                                    if !canon_ancestor.starts_with(&self.write_root) {
                                        return SandboxResult::Denied(format!(
                                            "write outside write root {:?}", self.write_root
                                        ));
                                    }
                                    // Preserve intermediate path components
                                    let relative = path.strip_prefix(&orig_ancestor).unwrap_or(path);
                                    canon_ancestor.join(relative)
                                }
                                None => return SandboxResult::Denied("parent directory not found".into()),
                            }
                        }
                    }
                } else {
                    return SandboxResult::Denied("invalid path".into());
                }
            }
        };

        // Verify within write_root
        if !real.starts_with(&self.write_root) {
            return SandboxResult::Denied(format!(
                "write to {:?} denied: outside write root {:?}",
                real, self.write_root
            ));
        }

        // Reject symlinks / junctions
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        SandboxResult::Allowed(real)
    }

    /// Validate a delete operation. Same as write + confirmation required at UI layer.
    #[allow(dead_code)]
    pub fn resolve_delete(&self, path: &Path) -> SandboxResult {
        // Deleting is the most dangerous — strict write root check
        self.resolve_write(path)
    }
}

/// Walk up the directory tree to find the nearest existing ancestor.
/// Returns (canonical_ancestor, original_ancestor), or None if no ancestor exists.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn test_read_inside_project() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("test.txt"), "hello").unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_read(&tmp.join("test.txt"));
        assert!(matches!(result, SandboxResult::Allowed(_)));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_read_outside_project_denied() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test2");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_read(Path::new("C:\\Windows\\System32\\notepad.exe"));
        assert!(matches!(result, SandboxResult::Denied(_)));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_write_locked_to_project() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test3");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_write(&tmp.join("new_file.txt"));
        assert!(matches!(result, SandboxResult::Allowed(_)));
        let _ = fs::remove_dir_all(&tmp);
    }
}
