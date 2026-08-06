// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 超大文件过滤阈值 — 5MB(≈5 万行)。
/// 真实源码几乎不可能达到(llama.cpp 级 2-3 万行单文件才 ~2MB);
/// 达此量级的基本是生成物(如 AMD 寄存器位掩码头文件 7-23MB,纯宏定义,
/// 对依赖图零价值)。跳过它们:省 tree-sitter 解析时间 + 图不被宏名污染。
const MAX_SOURCE_FILE_BYTES: u64 = 5 * 1024 * 1024;

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
                        // 超大生成物文件跳过(阈值见 MAX_SOURCE_FILE_BYTES)
                        if let Ok(meta) = entry.metadata() {
                            if meta.len() > MAX_SOURCE_FILE_BYTES {
                                tracing::info!(
                                    "[discovery] skip oversized file >5MB: {}",
                                    path.display()
                                );
                                continue;
                            }
                        }
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
                    // 去掉前导 /（锚定路径），识别尾部 /（目录标记），
                    // 然后取最后一个路径分量。
                    let name = trimmed.trim_start_matches('/');
                    let is_dir_marker = name.ends_with('/');   // 尾部 / = 明确目录标记
                    let name = name.trim_end_matches('/');
                    if let Some(last) = name.rsplit('/').next() {
                        if !last.is_empty() && (!last.contains('.') || is_dir_marker) {
                            // 跳过文件模式（带扩展名的名称如 "*.exe" 已被
                            // glob 检查过滤；"Thumbs.db" 是单个文件，不是目录；
                            // 但 "llama.cpp/" 以 / 结尾，名字含点也是目录）
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
    #[ignore]
    fn debug_kernel_discovery_amd() {
        // 临时诊断：验证 kernel 的 discover_files 是否收集 asic_reg 大文件
        let root = std::path::Path::new(r"D:/linux-7.1.0");
        let exts = ["c", "h", "rs", "py", "S", "cpp", "hpp"];
        let files = discover_files(root, &exts);
        let amd: Vec<_> = files
            .iter()
            .filter(|p| p.to_string_lossy().contains("asic_reg"))
            .collect();
        eprintln!("[debug] total={} amd_asic_reg={}", files.len(), amd.len());
        let gi = collect_gitignore_dirs(&root);
        for key in ["amd", "asic_reg", "include", "generated", "drm"] {
            eprintln!("[debug] gitignore_dirs contains {}? {}", key, gi.contains(key));
        }
        let big: Vec<_> = files
            .iter()
            .filter(|p| p.metadata().map(|m| m.len() > 1_048_576).unwrap_or(false))
            .collect();
        eprintln!("[debug] >1MB in discovery={}", big.len());
        for f in big.iter().take(5) {
            eprintln!("  >1MB: {}", f.display());
        }
        assert!(true);
    }

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
    fn test_gitignore_dir_with_dot_in_name() {
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_dots");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("llama.cpp")).unwrap();
        fs::create_dir_all(tmp.join("my.app")).unwrap();
        fs::create_dir_all(tmp.join("src")).unwrap();
        // "Thumbs.db" 无尾部 /、含点 — 视为文件模式，不应排除同名目录
        fs::create_dir_all(tmp.join("Thumbs.db")).unwrap();

        fs::write(tmp.join(".gitignore"), "llama.cpp/\nmy.app/\nThumbs.db\n").unwrap();
        fs::write(tmp.join("src").join("main.py"), "x=1").unwrap();
        fs::write(tmp.join("llama.cpp").join("sub.py"), "y=2").unwrap();
        fs::write(tmp.join("my.app").join("gui.py"), "z=3").unwrap();
        fs::write(tmp.join("Thumbs.db").join("data.py"), "w=4").unwrap();

        let files = discover_files(&tmp, &["py"]);
        let names: Vec<String> = files.iter().map(|p| p.file_name().unwrap().to_str().unwrap().to_string()).collect();

        assert!(names.contains(&"main.py".to_string()), "src/main.py should be found");
        assert!(!names.contains(&"sub.py".to_string()), "llama.cpp/ 应被 .gitignore 排除（名字含点但有尾部 /）");
        assert!(!names.contains(&"gui.py".to_string()), "my.app/ 应被 .gitignore 排除（名字含点但有尾部 /）");
        assert!(names.contains(&"data.py".to_string()), "Thumbs.db 无尾部 / 视为文件模式，同名目录不应被排除");

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