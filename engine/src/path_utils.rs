// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

/// Unified path normalization: backslash → forward slash + uppercase drive letter.
/// Use this instead of ad-hoc `replace('\\', "/")` so all code paths
/// produce the same canonical form.
pub fn normalize_path(path: &str) -> String {
    let s = path.replace('\\', "/");
    // Normalize Windows drive letter to uppercase to prevent split identities
    // (e.g. "d:/foo" and "D:/foo" were creating two different graph nodes)
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
        assert_eq!(normalize_path("/home/user/src/main.rs"), "/home/user/src/main.rs");
    }

    #[test]
    fn test_normalize_mixed() {
        assert_eq!(normalize_path(r"C:\project\src/module\file.rs"), "C:/project/src/module/file.rs");
    }

    #[test]
    fn test_normalize_lowercase_drive_letter() {
        assert_eq!(normalize_path(r"d:\HoloGramHG\src\main.rs"), "D:/HoloGramHG/src/main.rs");
    }

    #[test]
    fn test_normalize_uppercase_drive_idempotent() {
        assert_eq!(normalize_path(r"D:\HoloGramHG\src\main.rs"), "D:/HoloGramHG/src/main.rs");
    }
}
