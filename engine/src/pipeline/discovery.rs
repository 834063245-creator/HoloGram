// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
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
    // 预扫描：从所有 .gitignore 文件中收集排除规则。
    let gitignore_rules = collect_gitignore_rules(root);

    let mut files = Vec::new();
    let mut skipped_entries = 0u64;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e, &gitignore_rules, root))
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

/// gitignore 排除规则集，保留路径语义。
///
/// 旧实现把每条规则取「最后一个路径分量」作全局 basename 排除，导致路径型/
/// 锚定型规则被错误放大（如 `tools/power/acpi/.gitignore` 的 `/include/` 会
/// 全局排除所有名为 include 的目录）；无斜杠规则也被全局化（`arch/x86/boot/
/// .gitignore` 的 `tools/` 全局排除所有 tools 目录，94 个真实内核源码目录
/// 因此丢失）。两者都是把 sub .gitignore 的规则放大到全树的正确性 bug。
struct GitignoreRules {
    /// 无斜杠规则（如 `my_build`、`tools`）→ basename 匹配，按 .gitignore
    /// 所在目录作用域（git 语义）：root 规则（base=""）任意层级生效，
    /// sub 规则仅其目录之下任意层级生效。
    names: HashMap<String, Vec<String>>,
    /// 含斜杠规则（前导 / 或中间 /）→ 相对 root 的路径，按首分量分桶，
    /// 匹配时只查对应桶（平均 <10 条）。
    anchored: HashMap<String, Vec<String>>,
}

impl Default for GitignoreRules {
    fn default() -> Self {
        GitignoreRules {
            names: HashMap::new(),
            anchored: HashMap::new(),
        }
    }
}

impl GitignoreRules {
    /// 判断相对路径 rel（`/` 分隔）的目录 entry 是否被规则排除。
    /// name 是最后路径分量，用于无斜杠规则匹配。
    fn is_excluded(&self, name: &str, rel: &str) -> bool {
        if let Some(bases) = self.names.get(name) {
            for base in bases {
                if base.is_empty()
                    || rel == base
                    || rel
                        .strip_prefix(base.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
                {
                    return true;
                }
            }
        }
        let key = rel.split('/').next().unwrap_or("");
        if let Some(rules) = self.anchored.get(key) {
            for rule in rules {
                if rel == rule
                    || rel
                        .strip_prefix(rule.as_str())
                        .is_some_and(|rest| rest.starts_with('/'))
                {
                    return true;
                }
            }
        }
        false
    }
}

/// 计算 path 相对 root 的 `/` 分隔路径（Windows 下 `\` 归一化）。
fn rel_path_str(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy();
    if s.is_empty() {
        return Some(String::new());
    }
    Some(s.replace('\\', "/"))
}

/// 从项目树中所有 .gitignore 文件收集排除规则。
/// ponytail: 单次 walkdir 扫描，仅解析 .gitignore 文件。
/// 跳过 glob 模式和取反规则 — 覆盖 95%+ 的实际排除场景。
fn collect_gitignore_rules(root: &Path) -> GitignoreRules {
    let mut rules = GitignoreRules::default();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_name() != ".gitignore" {
            continue;
        }
        // 规则基目录（相对 root，根 = 空串）。
        let base = rel_path_str(entry.path().parent().unwrap_or(root), root).unwrap_or_default();
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
                let is_dir_marker = trimmed.ends_with('/'); // 尾部 / = 明确目录标记
                let name = trimmed.trim_end_matches('/');
                if name.is_empty() {
                    continue;
                }
                let last = name.rsplit('/').next().unwrap_or("");
                // 跳过文件模式（带扩展名的名称如 "Thumbs.db" 是单个文件；
                // 但 "llama.cpp/" 以 / 结尾，名字含点也是目录）
                if last.contains('.') && !is_dir_marker {
                    continue;
                }
                if name.contains('/') {
                    // 含前导 / 或中间 / → 锚定到 .gitignore 所在目录 → 相对 root 全路径
                    let rel = name.trim_start_matches('/');
                    let full = if base.is_empty() {
                        rel.to_string()
                    } else {
                        format!("{base}/{rel}")
                    };
                    let key = full.split('/').next().unwrap_or_default().to_string();
                    rules.anchored.entry(key).or_default().push(full);
                } else {
                    // 无斜杠规则 → basename 匹配，作用域 = .gitignore 所在目录
                    // （root 规则 base="" 表示任意层级）
                    rules.names.entry(name.to_string()).or_default().push(base.clone());
                }
            }
        }
    }
    rules
}

/// 硬编码的通用排除规则（工具链、VCS、构建产物、HoloGram 运行时）。
/// 由文件发现、watcher 和简报（preflight）共享，确保
/// 所有子系统中的过滤行为一致。
///
/// 注意：不收录 `vendor`（Go/PHP 依赖树）与 `bin`（.NET 输出）——kernel
/// 实证存在同名的真实源码目录（arch/riscv/include/uapi/asm/vendor、
/// tools/perf/scripts/*/bin），全局 basename 排除会误伤；这些场景应
/// 由项目自己的 .gitignore（已按 git 语义生效）处理。
pub const IGNORED_DIRS: &[&str] = &[
    ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
    ".tox", ".mypy_cache", ".pytest_cache", ".hg", ".svn",
    "dist", "build", "target", ".eggs", "*.egg-info",
    ".hologram", "htmlcov", ".reasonix", ".codegraph", ".ruff_cache",
    ".next", ".nuxt", "out", ".angular", ".cache", "coverage",
    "vendored", "generated", "tests",
    ".vscode", ".idea", ".fleet", ".cursor",  // 编辑器
    "Pods", ".gradle",  // CocoaPods 依赖 / Gradle 缓存 — 语义铁定的依赖目录
];

/// 目录名是否应被排除（精确名单 + 虚拟环境前缀规则）。
/// `.venv*` / `venv-` / `venv_` 前缀覆盖带后缀命名的 Python 虚拟环境
/// （`.venv-lme`、`.venv2`、`venv-lme`…）——精确名单匹配不上时，整棵
/// site-packages 依赖树会漏进图（d:\newexperience 实证：1,891 个第三方
/// py → 9 万节点 / 280MB graph JSON / 447MB sqlite）。虚拟环境目录
/// 无源码语义，前缀匹配不会误伤真实源码（区别于 vendor/bin 的教训）。
pub fn is_ignored_dir_name(name: &str) -> bool {
    if IGNORED_DIRS.contains(&name) {
        return true;
    }
    name.starts_with(".venv") || name.starts_with("venv-") || name.starts_with("venv_")
}

/// 检查目录条目是否应从遍历中排除。
/// global_names 按 basename 匹配（兼容旧行为），anchored 按相对 root 路径匹配。
fn is_excluded(entry: &walkdir::DirEntry, rules: &GitignoreRules, root: &Path) -> bool {
    let name = entry.file_name().to_str().unwrap_or("");
    if !entry.file_type().is_dir() {
        return false;
    }
    if is_ignored_dir_name(name) {
        return true;
    }
    let rel = rel_path_str(entry.path(), root).unwrap_or_default();
    rules.is_excluded(name, &rel)
}

/// 检查文件路径是否位于任何被忽略的目录中。
/// 供简报系统（preflight）使用，用于过滤 `.hologram/`、`.git/`、
/// `node_modules/` 等目录中文件的变更 — 这些是工具/运行时
/// 产物，而非用户源代码，不应产生约束违规。
///
/// 同时处理 `/` 和 `\` 路径分隔符，以实现跨平台兼容。
pub fn is_ignored_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let mut components = normalized.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_some() {
            // 目录分量：精确名单 + 虚拟环境前缀规则（`.venv-lme` 等）
            if is_ignored_dir_name(component) {
                return true;
            }
        } else if IGNORED_DIRS.contains(&component) {
            // 末位分量（文件名）：仅精确名单——前缀规则是目录语义，
            // 套到文件名会误伤 `venv_helper.py` 这类真实文件。
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
    fn test_gitignore_anchored_path_semantics() {
        // 锚定规则只排对应路径，同名目录保留（旧实现把最后分量全局化，误伤全树）
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_anchored");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("include").join("config")).unwrap();
        fs::create_dir_all(tmp.join("arch").join("x86").join("include")).unwrap();
        fs::create_dir_all(tmp.join("somewhere").join("config")).unwrap();

        fs::write(tmp.join(".gitignore"), "/include/\n/include/config/\n").unwrap();
        fs::write(tmp.join("include").join("gen.h"), "// gen").unwrap();
        fs::write(tmp.join("include").join("config").join("auto.h"), "// auto").unwrap();
        fs::write(tmp.join("arch").join("x86").join("include").join("core.h"), "// core").unwrap();
        fs::write(tmp.join("somewhere").join("config").join("keep.c"), "int x;").unwrap();
        fs::write(tmp.join("main.c"), "int main;").unwrap();

        let files = discover_files(&tmp, &["c", "h"]);
        let names: Vec<String> = files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();

        assert!(names.iter().any(|p| p.ends_with("main.c")), "root main.c should be found");
        assert!(!names.iter().any(|p| p.ends_with("gen.h")), "/include/ should exclude only root include/");
        assert!(!names.iter().any(|p| p.ends_with("auto.h")), "/include/config/ should exclude root include/config");
        assert!(names.iter().any(|p| p.ends_with("core.h")), "arch/x86/include/ 同名目录应保留（修复回归点）");
        assert!(names.iter().any(|p| p.ends_with("keep.c")), "somewhere/config 同名目录应保留");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_gitignore_subdir_anchored_recovers_include() {
        // 模拟 kernel 结构：tools/power/acpi/.gitignore 的 /include/ 只排该目录，
        // 根 include/ 头文件体系必须被收集；>5MB 大文件被阈值跳过。
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_kernel_include");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("include").join("linux")).unwrap();
        fs::create_dir_all(tmp.join("tools").join("power").join("acpi").join("include")).unwrap();

        fs::write(
            tmp.join("tools").join("power").join("acpi").join(".gitignore"),
            "/include/\n",
        )
        .unwrap();
        fs::write(tmp.join("include").join("linux").join("main.h"), "#define X 1").unwrap();
        fs::write(
            tmp.join("tools").join("power").join("acpi").join("include").join("generated.h"),
            "// gen",
        )
        .unwrap();
        fs::write(
            tmp.join("include").join("linux").join("big_regs.h"),
            "x".repeat(5 * 1024 * 1024 + 1),
        )
        .unwrap();

        let files = discover_files(&tmp, &["h"]);
        let names: Vec<String> = files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();

        assert!(names.iter().any(|p| p.ends_with("main.h")), "根 include/ 头文件应被收集（修复核心回归点）");
        assert!(!names.iter().any(|p| p.ends_with("generated.h")), "tools/power/acpi/include 应被锚定规则排除");
        assert!(!names.iter().any(|p| p.ends_with("big_regs.h")), ">5MB 大文件应被阈值跳过");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_gitignore_subdir_relative_path_rule() {
        // sub/.gitignore 的 out/gen/ 只排 sub/out/gen，不排其它层级的同名路径
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_subdir_path");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub").join("intermediate").join("gen")).unwrap();
        fs::create_dir_all(tmp.join("intermediate").join("gen")).unwrap();

        fs::write(tmp.join("sub").join(".gitignore"), "intermediate/gen/\n").unwrap();
        fs::write(tmp.join("sub").join("intermediate").join("gen").join("drop.c"), "int a;").unwrap();
        fs::write(tmp.join("intermediate").join("gen").join("keep.c"), "int b;").unwrap();

        let files = discover_files(&tmp, &["c"]);
        let names: Vec<String> = files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();

        assert!(!names.iter().any(|p| p.ends_with("drop.c")), "sub/intermediate/gen 应被 sub/.gitignore 排除");
        assert!(names.iter().any(|p| p.ends_with("keep.c")), "根 intermediate/gen 与 sub 无关，应保留");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_gitignore_global_rule_unchanged() {
        // root .gitignore 的无斜杠规则 → 任意层级生效（git 语义，行为不变）
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_global");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("my_build")).unwrap();
        fs::create_dir_all(tmp.join("nested").join("my_build")).unwrap();
        fs::create_dir_all(tmp.join("src")).unwrap();

        fs::write(tmp.join(".gitignore"), "my_build/\n").unwrap();
        fs::write(tmp.join("src").join("main.py"), "x=1").unwrap();
        fs::write(tmp.join("my_build").join("gen.py"), "y=2").unwrap();
        fs::write(tmp.join("nested").join("my_build").join("gen.py"), "z=3").unwrap();

        let files = discover_files(&tmp, &["py"]);
        let names: Vec<String> = files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();

        assert!(names.iter().any(|p| p.ends_with("main.py")), "src/main.py should be found");
        assert!(names.iter().filter(|p| p.ends_with("gen.py")).count() == 0, "root 规则任意层级 my_build 都应被排除");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_gitignore_sub_rule_scoped_to_base() {
        // sub/.gitignore 的无斜杠规则只排 sub 之下（git 语义），
        // 同名真实目录在他处必须保留（kernel tools/purgatory 同型回归点）
        let tmp = std::env::temp_dir().join("hologram_test_gitignore_scope");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub").join("gen")).unwrap();
        fs::create_dir_all(tmp.join("sub").join("src")).unwrap();
        fs::create_dir_all(tmp.join("other").join("gen")).unwrap();
        fs::create_dir_all(tmp.join("gen")).unwrap();

        fs::write(tmp.join("sub").join(".gitignore"), "gen/\n").unwrap();
        fs::write(tmp.join("sub").join("gen").join("drop.py"), "a=1").unwrap();
        fs::write(tmp.join("sub").join("src").join("keep.py"), "b=2").unwrap();
        fs::write(tmp.join("other").join("gen").join("keep2.py"), "c=3").unwrap();
        fs::write(tmp.join("gen").join("keep3.py"), "d=4").unwrap();

        let files = discover_files(&tmp, &["py"]);
        let names: Vec<String> = files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();

        assert!(!names.iter().any(|p| p.ends_with("drop.py")), "sub/gen 应被 sub/.gitignore 排除");
        assert!(names.iter().any(|p| p.ends_with("keep.py")), "sub/src should be found");
        assert!(names.iter().any(|p| p.ends_with("keep2.py")), "other/gen 与 sub 无关，应保留（修复回归点）");
        assert!(names.iter().any(|p| p.ends_with("keep3.py")), "根 gen 与 sub 无关，应保留（修复回归点）");

        let _ = fs::remove_dir_all(&tmp);
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
    fn test_venv_suffix_variants_excluded() {
        // d:\newexperience 回归点：嵌套 venv 带后缀命名（.venv-lme）漏过
        // 精确名单（.venv/venv），整棵 site-packages 依赖树进图 → 9 万节点。
        for name in [".venv-lme", ".venv2", ".venv_backup", "venv-lme", "venv_foo"] {
            assert!(is_ignored_dir_name(name), "{name} should be ignored");
            assert!(
                is_ignored_path(&format!("D:/proj/{name}/Lib/site-packages/pip/_internal/x.py")),
                "{name} path should be ignored"
            );
        }
        // 精确名单语义保持（旧行为回归）
        assert!(is_ignored_dir_name(".venv"));
        assert!(is_ignored_dir_name("venv"));
        // 前缀规则不误伤真实源码目录
        assert!(!is_ignored_dir_name("src"));
        assert!(!is_ignored_dir_name("vendor"));
        assert!(!is_ignored_path("D:/proj/src/venv_helper.py"));
    }

    #[test]
    fn test_discover_skips_suffixed_venv() {
        // 端到端：.venv-lme 下的 py 不应被 discover_files 收集
        let tmp = std::env::temp_dir().join("hologram_test_suffixed_venv");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join(".venv-lme").join("Lib").join("site-packages")).unwrap();
        fs::create_dir_all(tmp.join("src")).unwrap();

        fs::write(
            tmp.join(".venv-lme").join("Lib").join("site-packages").join("pip.py"),
            "import os\n",
        )
        .unwrap();
        fs::write(tmp.join("src").join("main.py"), "x=1\n").unwrap();

        let files = discover_files(&tmp, &["py"]);
        let names: Vec<String> = files.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();

        assert!(names.iter().any(|p| p.ends_with("src/main.py")), "src/main.py should be found");
        assert!(names.iter().all(|p| !p.contains(".venv-lme")), ".venv-lme must be excluded");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_is_ignored_path_windows_backslash() {
        assert!(is_ignored_path("D:\\projects\\myapp\\.hologram\\baseline.json"));
        assert!(is_ignored_path("D:\\projects\\myapp\\node_modules\\express\\index.js"));
        assert!(!is_ignored_path("D:\\projects\\myapp\\src\\main.rs"));
    }
}