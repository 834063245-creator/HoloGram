// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # 路径规范化工具
//!
//! 统一路径格式：反斜杠 → 正斜杠 + 驱动器字母大写。
//! 应使用此函数替代临时 `replace('\\', "/")`，确保所有代码路径产生相同的规范形式。

/// 将路径规范化为统一格式。
///
/// - Windows 反斜杠 `\` 转换为正斜杠 `/`
/// - Windows 驱动器字母统一为大写（如 `d:` → `D:`）
///
/// 这样可以避免 `d:/foo` 和 `D:/foo` 在依赖图中创建两个不同的节点。
pub fn normalize_path(path: &str) -> String {
    let s = path.replace('\\', "/");
    // 将 Windows 驱动器字母统一为大写，防止大小写差异导致图节点分裂
    // （例如 "d:/foo" 和 "D:/foo" 之前会创建两个不同的图节点）
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let mut chars: Vec<char> = s.chars().collect();
        chars[0] = chars[0].to_ascii_uppercase();
        chars.into_iter().collect()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_windows_path() {
        assert_eq!(normalize_path(r"C:\project\src\main.rs"), "C:/project/src/main.rs");
    }

    #[test]
    fn test_normalize_unix_path_idempotent() {
        // Unix 路径不含反斜杠，规范化后应保持不变
        assert_eq!(normalize_path("/home/user/src/main.rs"), "/home/user/src/main.rs");
    }

    #[test]
    fn test_normalize_mixed() {
        // 混合分隔符也应正确处理
        assert_eq!(normalize_path(r"C:\project\src/module\file.rs"), "C:/project/src/module/file.rs");
    }

    #[test]
    fn test_normalize_lowercase_drive_letter() {
        // 小写驱动器字母应转换为大写
        assert_eq!(normalize_path(r"d:\HoloGramHG\src\main.rs"), "D:/HoloGramHG/src/main.rs");
    }

    #[test]
    fn test_normalize_uppercase_drive_idempotent() {
        // 大写驱动器字母应保持不变（幂等性）
        assert_eq!(normalize_path(r"D:\HoloGramHG\src\main.rs"), "D:/HoloGramHG/src/main.rs");
    }
}
