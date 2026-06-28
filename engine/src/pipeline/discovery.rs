// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Discover source files in a project directory.
/// Respects .gitignore patterns + hardcoded common exclusions.
pub fn discover_files(root: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    // Pre-scan: collect directory names to exclude from all .gitignore files.
    let gitignore_dirs = collect_gitignore_dirs(root);

    let mut files = Vec::new();
    let mut skipped_entries = 0u64;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e, &gitignore_dirs))
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

/// Collect directory names to exclude from all .gitignore files in the project tree.
/// ponytail: single-pass walkdir scan, parses only .gitignore files.
/// Skips glob patterns and negations — covers 95%+ of real-world exclusions.
fn collect_gitignore_dirs(root: &Path) -> HashSet<String> {
    let mut dirs = HashSet::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_name() == ".gitignore" {
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    // Negation: if something is explicitly un-ignored, don't add it
                    if trimmed.starts_with('!') {
                        continue;
                    }
                    // Glob patterns: skip (rare for directories, complex to match)
                    if trimmed.contains('*') || trimmed.contains('?') || trimmed.contains('[') {
                        continue;
                    }
                    // Strip leading / (anchored), trailing / (directory marker),
                    // then take the last path component.
                    let name = trimmed.trim_start_matches('/').trim_end_matches('/');
                    if let Some(last) = name.rsplit('/').next() {
                        if !last.is_empty() && !last.contains('.') {
                            // Skip file patterns (names with extensions like "*.exe" already
                            // filtered by glob check; "Thumbs.db" is a single file, not a dir)
                            dirs.insert(last.to_string());
                        }
                    }
                }
            }
        }
    }
    dirs
}

/// Check if a directory entry should be excluded from traversal.
fn is_excluded(entry: &walkdir::DirEntry, gitignore_dirs: &HashSet<String>) -> bool {
    let name = entry.file_name().to_str().unwrap_or("");
    if !entry.file_type().is_dir() {
        return false;
    }
    // Hardcoded common exclusions (tooling, VCS, build artifacts)
    const HARDCODED: &[&str] = &[
        ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
        ".tox", ".mypy_cache", ".pytest_cache", ".hg", ".svn",
        "dist", "build", "target", ".eggs", "*.egg-info",
        ".hologram", "htmlcov", ".reasonix", ".codegraph", ".ruff_cache",
        ".next", ".nuxt", "out", ".angular", ".cache", "coverage",
        "vendored", "generated", "tests",
    ];
    HARDCODED.contains(&name) || gitignore_dirs.contains(name)
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

    #[test]
    fn test_gitignore_respected() {
        let tmp = std::env::temp_dir().join("hologram_test_gitignore");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("my_build")).unwrap();
        fs::create_dir_all(tmp.join("src")).unwrap();

        fs::write(tmp.join(".gitignore"), "my_build/\n").unwrap();
        fs::write(tmp.join("src").join("main.py"), "x=1").unwrap();
        fs::write(tmp.join("my_build").join("gen.py"), "y=2").unwrap();

        let files = discover_files(&tmp, &["py"]);
        let names: Vec<String> = files.iter().map(|p| p.file_name().unwrap().to_str().unwrap().to_string()).collect();

        assert!(names.contains(&"main.py".to_string()), "src/main.py should be found");
        assert!(!names.contains(&"gen.py".to_string()), "my_build/ should be excluded by .gitignore");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_gitignore_nested() {
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_nested");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("frontend").join("dist")).unwrap();
        fs::create_dir_all(tmp.join("frontend").join("src")).unwrap();

        fs::write(tmp.join("frontend").join(".gitignore"), "dist/\n").unwrap();
        fs::write(tmp.join("frontend").join("src").join("app.ts"), "// ts").unwrap();
        fs::write(tmp.join("frontend").join("dist").join("bundle.js"), "// built").unwrap();

        let files = discover_files(&tmp, &["ts", "js"]);
        let names: Vec<String> = files.iter().map(|p| p.file_name().unwrap().to_str().unwrap().to_string()).collect();

        assert!(names.contains(&"app.ts".to_string()), "src/app.ts should be found");
        assert!(!names.contains(&"bundle.js".to_string()), "dist/ should be excluded by nested .gitignore");

        let _ = fs::remove_dir_all(&tmp);
    }
}
