// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 发现项目目录中的源文件。
/// 遵循 .gitignore 模式 + 硬编码的通用排除规则。
pub fn discover_files(root: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    // 预扫描：从所有 .gitignore 文件中收集要排除的目录名。
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

/// 从项目树中所有 .gitignore 文件收集要排除的目录名。
/// ponytail: 单次 walkdir 扫描，仅解析 .gitignore 文件。
/// 跳过 glob 模式和取反规则 — 覆盖 95%+ 的实际排除场景。
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
                    // 取反：如果某项被显式取消忽略，则不添加
                    if trimmed.starts_with('!') {
                        continue;
                    }
                    // glob 模式：跳过（目录中少见，匹配复杂）
                    if trimmed.contains('*') || trimmed.contains('?') || trimmed.contains('[') {
                        continue;
                    }
                    // 去掉前导 /（锚定路径）和尾部 /（目录标记），
                    // 然后取最后一个路径分量。
                    let name = trimmed.trim_start_matches('/').trim_end_matches('/');
                    if let Some(last) = name.rsplit('/').next() {
                        if !last.is_empty() && !last.contains('.') {
                            // 跳过文件模式（带扩展名的名称如 "*.exe" 已被
                            // glob 检查过滤；"Thumbs.db" 是单个文件，不是目录）
                            dirs.insert(last.to_string());
                        }
                    }
                }
            }
        }
    }
    dirs
}

/// 硬编码的通用排除规则（工具链、VCS、构建产物、HoloGram 运行时）。
/// 由文件发现、watcher 和简报（preflight）共享，确保
/// 所有子系统中的过滤行为一致。
pub const IGNORED_DIRS: &[&str] = &[
    ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
    ".tox", ".mypy_cache", ".pytest_cache", ".hg", ".svn",
    "dist", "build", "target", ".eggs", "*.egg-info",
    ".hologram", "htmlcov", ".reasonix", ".codegraph", ".ruff_cache",
    ".next", ".nuxt", "out", ".angular", ".cache", "coverage",
    "vendored", "generated", "tests",
    ".vscode", ".idea", ".fleet", ".cursor",  // 编辑器
];

/// 检查目录条目是否应从遍历中排除。
fn is_excluded(entry: &walkdir::DirEntry, gitignore_dirs: &HashSet<String>) -> bool {
    let name = entry.file_name().to_str().unwrap_or("");
    if !entry.file_type().is_dir() {
        return false;
    }
    IGNORED_DIRS.contains(&name) || gitignore_dirs.contains(name)
}

/// 检查文件路径是否位于任何被忽略的目录中。
/// 供简报系统（preflight）使用，用于过滤 `.hologram/`、`.git/`、
/// `node_modules/` 等目录中文件的变更 — 这些是工具/运行时
/// 产物，而非用户源代码，不应产生约束违规。
///
/// 同时处理 `/` 和 `\` 路径分隔符，以实现跨平台兼容。
pub fn is_ignored_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    for component in normalized.split('/') {
        if IGNORED_DIRS.contains(&component) {
            return true;
        }
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

        // 创建测试文件
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

    #[test]
    fn test_is_ignored_path_hologram() {
        assert!(is_ignored_path("D:/projects/myapp/.hologram/baseline.json"));
        assert!(is_ignored_path("D:/projects/myapp/.hologram/memory/ctx.json"));
        assert!(is_ignored_path(".hologram/cache/graph.json"));
    }

    #[test]
    fn test_is_ignored_path_git() {
        assert!(is_ignored_path("D:/projects/myapp/.git/HEAD"));
        assert!(is_ignored_path("D:/projects/myapp/.git/config"));
    }

    #[test]
    fn test_is_ignored_path_node_modules() {
        assert!(is_ignored_path("D:/projects/myapp/node_modules/express/index.js"));
        assert!(is_ignored_path("node_modules/react/index.js"));
    }

    #[test]
    fn test_is_ignored_path_source_files() {
        assert!(!is_ignored_path("D:/projects/myapp/src/main.rs"));
        assert!(!is_ignored_path("src/handler.py"));
        assert!(!is_ignored_path("app/config/settings.yaml"));
    }

    #[test]
    fn test_is_ignored_path_windows_backslash() {
        assert!(is_ignored_path("D:\\projects\\myapp\\.hologram\\baseline.json"));
        assert!(is_ignored_path("D:\\projects\\myapp\\node_modules\\express\\index.js"));
        assert!(!is_ignored_path("D:\\projects\\myapp\\src\\main.rs"));
    }
}