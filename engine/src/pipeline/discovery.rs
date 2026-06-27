// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Discover source files in a project directory.
/// Respects .gitignore-like exclusions.
pub fn discover_files(root: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut skipped_entries = 0u64;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e))
    {
        match entry {
            Ok(entry) => {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_str().unwrap_or("");
                    if extensions.contains(&ext_str) {
                        files.push(path.to_path_buf());
                    }
                }
            }
            Err(e) => {
                skipped_entries += 1;
                if skipped_entries <= 5 {
                    tracing::warn!("[discovery] cannot access entry: {} (further errors suppressed)", e);
                }
            }
        }
    }

    if skipped_entries > 0 {
        tracing::warn!("[discovery] {} directory entries skipped (permission errors / broken links)", skipped_entries);
    }

    files
}

/// Directories/file patterns to skip during discovery.
fn is_excluded(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_str().unwrap_or("");
    // Common exclusions
    let excluded_dirs = [
        ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
        ".tox", ".mypy_cache", ".pytest_cache", ".hg", ".svn",
        "dist", "build", "target", ".eggs", "*.egg-info",
        ".hologram", "htmlcov", ".reasonix", ".codegraph", ".ruff_cache",
        ".next", ".nuxt", "out", ".angular", ".cache", "coverage",
    ];
    if entry.file_type().is_dir() {
        return excluded_dirs.contains(&name);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    

    #[test]
    fn test_discover_python_files() {
        let tmp = std::env::temp_dir().join("hologram_test_discovery");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::create_dir_all(tmp.join("__pycache__")).unwrap();

        // Create test files
        fs::write(tmp.join("main.py"), "x=1").unwrap();
        fs::write(tmp.join("sub").join("util.py"), "y=2").unwrap();
        fs::write(tmp.join("__pycache__").join("cache.pyc"), "zzz").unwrap();
        fs::write(tmp.join("README.md"), "doc").unwrap();

        let files = discover_files(&tmp, &["py"]);
        let names: Vec<String> = files.iter().map(|p| p.file_name().unwrap().to_str().unwrap().to_string()).collect();

        assert!(names.contains(&"main.py".to_string()));
        assert!(names.contains(&"util.py".to_string()));
        assert!(!names.contains(&"cache.pyc".to_string()), "__pycache__ should be excluded");
        assert!(!names.contains(&"README.md".to_string()), "non-py files should be excluded");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_discover_empty_dir() {
        let tmp = std::env::temp_dir().join("hologram_test_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let files = discover_files(&tmp, &["py"]);
        assert_eq!(files.len(), 0);

        let _ = fs::remove_dir_all(&tmp);
    }
}
