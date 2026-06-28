// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// safetyCheck — bypass-immune safety layer (spec §4.5)
// Even if rules say Allow, safety_check can force Ask for protected paths.
use std::path::Path;

pub struct SafetyCheckResult {
    pub safe: bool,
    pub message: String,
}

/// Check if a path is safe to READ.
/// Like check_path_safety but skips the .hologram/ config check — reading
/// HoloGram's own data files (memory, sessions, logs) is safe and necessary
/// for normal operation. Only writing them is dangerous.
pub fn check_path_safety_read(path: &Path) -> SafetyCheckResult {
    let path_str = path.to_string_lossy();

    // 1. Windows suspicious path patterns
    #[cfg(windows)]
    if has_suspicious_windows_path(&path_str) {
        return SafetyCheckResult { safe: false, message: "可疑的 Windows 路径模式".into() };
    }

    // 2. Dangerous system config files — protect reads too (credentials)
    if is_dangerous_file(path) {
        return SafetyCheckResult { safe: false, message: "系统配置文件受保护".into() };
    }

    // 3. Dangerous directories
    if is_dangerous_dir(path) {
        return SafetyCheckResult { safe: false, message: "受保护的目录".into() };
    }

    SafetyCheckResult { safe: true, message: String::new() }
}

/// Check if a path is safe to WRITE (or any operation).
/// Bypass-immune: rules/mode cannot override this.
pub fn check_path_safety(path: &Path) -> SafetyCheckResult {
    let path_str = path.to_string_lossy();

    // 1. Windows suspicious path patterns (NTFS ADS, 8.3 short names, trailing dots, DOS devices)
    #[cfg(windows)]
    if has_suspicious_windows_path(&path_str) {
        return SafetyCheckResult {
            safe: false,
            message: "可疑的 Windows 路径模式".into(),
        };
    }

    // 2. HoloGram config files — always protected
    if is_hologram_config_path(path) {
        return SafetyCheckResult {
            safe: false,
            message: "HoloGram 配置文件受保护，不可修改".into(),
        };
    }

    // 3. Dangerous system config files
    if is_dangerous_file(path) {
        return SafetyCheckResult {
            safe: false,
            message: "系统配置文件受保护，不可修改".into(),
        };
    }

    // 4. Dangerous directories (with worktree exemption)
    if is_dangerous_dir(path) {
        return SafetyCheckResult {
            safe: false,
            message: "受保护的目录，不可修改".into(),
        };
    }

    SafetyCheckResult {
        safe: true,
        message: String::new(),
    }
}

/// HoloGram config paths — `.hologram/` directory contents.
/// Runtime data dirs (memory, sessions, logs, worktrees) are EXEMPT —
/// HoloGram UI writes to them during normal operation.
fn is_hologram_config_path(path: &Path) -> bool {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    for i in 0..components.len() {
        if components[i] == ".hologram" {
            // Runtime data dirs exempt — HoloGram UI writes to these
            if let Some(sub) = components.get(i + 1) {
                if *sub == "worktrees" || *sub == "memory" || *sub == "logs" || *sub == "sessions" {
                    return false;
                }
            }
            return true;
        }
    }
    false
}

/// Dangerous system config files — never allow write.
fn is_dangerous_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let dangerous_names = &[
        ".bashrc",
        ".zshrc",
        ".profile",
        ".bash_profile",
        ".gitconfig",
        ".ssh/config",
        "authorized_keys",
        "id_rsa",
        "id_ed25519",
        ".env.production",
        ".mcp.json",
    ];
    if dangerous_names.contains(&name) {
        return true;
    }
    // Check full path for .ssh directory
    let path_str = path.to_string_lossy().replace('\\', "/");
    if path_str.contains("/.ssh/") {
        return true;
    }
    false
}

/// Dangerous directories — .git, .vscode, .idea, .hologram (non-worktree)
fn is_dangerous_dir(path: &Path) -> bool {
    // Check if any path component is a dangerous directory
    for component in path.components() {
        if let Some(s) = component.as_os_str().to_str() {
            if s == ".git" || s == ".vscode" || s == ".idea" || s == ".cursor" {
                return true;
            }
        }
    }
    false
}

#[cfg(windows)]
fn has_suspicious_windows_path(path_str: &str) -> bool {
    // NTFS Alternate Data Stream: file.txt:stream
    // Drive letter colons are OK: "C:\..." or "\\?\C:\..." (long path prefix)
    let bytes = path_str.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b':' {
            // Position 1: "C:\..." drive letter
            if i == 1 && bytes.get(i.wrapping_sub(1)).map_or(false, |b| b.is_ascii_alphabetic()) {
                continue;
            }
            // Position 5: "\\?\C:\..." long path drive letter
            if i == 5 && path_str.starts_with("\\\\?\\") && bytes.get(4).map_or(false, |b| b.is_ascii_alphabetic()) {
                continue;
            }
            // Any other colon is suspicious (ADS)
            return true;
        }
    }
    // Trailing dot or space (NTFS strips them but some APIs preserve)
    if path_str.ends_with('.') || path_str.ends_with(' ') {
        return true;
    }
    // DOS device names
    let dos_names = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    for name in dos_names {
        if path_str == *name || path_str.starts_with(&format!("{}.", name)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_safety_normal_file() {
        let r = check_path_safety(Path::new("src/main.rs"));
        assert!(r.safe);
    }

    #[test]
    fn test_safety_hologram_config() {
        let r = check_path_safety(Path::new(".hologram/settings.json"));
        assert!(!r.safe);
    }

    #[test]
    fn test_safety_worktree_exempt() {
        let r = check_path_safety(Path::new(".hologram/worktrees/agent-abc/src/main.rs"));
        assert!(r.safe);
    }

    #[test]
    fn test_safety_git_dir() {
        let r = check_path_safety(Path::new(".git/config"));
        assert!(!r.safe);
    }

    #[test]
    fn test_safety_bashrc() {
        let r = check_path_safety(Path::new("/home/user/.bashrc"));
        assert!(!r.safe);
    }

    #[test]
    fn test_safety_ssh() {
        let r = check_path_safety(Path::new("/home/user/.ssh/id_rsa"));
        assert!(!r.safe);
    }

    // ── Read safety (check_path_safety_read) exempts .hologram/ ──

    #[test]
    fn test_read_safety_allows_hologram() {
        // Reading .hologram/ files is safe — they're HoloGram's own data
        let r = check_path_safety_read(Path::new(".hologram/memory/MEMORY.md"));
        assert!(r.safe, "memory reads should be allowed");
        let r = check_path_safety_read(Path::new(".hologram/logs/bridge.log"));
        assert!(r.safe, "log reads should be allowed");
        let r = check_path_safety_read(Path::new(".hologram/sessions/chat.json"));
        assert!(r.safe, "session reads should be allowed");
    }

    #[test]
    fn test_read_safety_blocks_dangerous() {
        // Dangerous system files are still blocked for reads
        let r = check_path_safety_read(Path::new("/home/user/.bashrc"));
        assert!(!r.safe, "bashrc reads should be blocked");
        let r = check_path_safety_read(Path::new("/home/user/.ssh/id_rsa"));
        assert!(!r.safe, "ssh key reads should be blocked");
        let r = check_path_safety_read(Path::new(".git/config"));
        assert!(!r.safe, ".git/config reads should be blocked");
    }

    // ── Write safety exempts runtime dirs (memory/logs/sessions/worktrees) ──

    #[test]
    fn test_write_safety_exempts_runtime_dirs() {
        let r = check_path_safety(Path::new(".hologram/memory/fact.md"));
        assert!(r.safe, "memory writes should be allowed for HoloGram UI");
        let r = check_path_safety(Path::new(".hologram/logs/bridge.log"));
        assert!(r.safe, "log writes should be allowed");
        let r = check_path_safety(Path::new(".hologram/sessions/chat.json"));
        assert!(r.safe, "session writes should be allowed");
        let r = check_path_safety(Path::new(".hologram/worktrees/abc/src/main.rs"));
        assert!(r.safe, "worktree writes should be allowed");
    }

    #[test]
    fn test_write_safety_blocks_config() {
        // Actual config files are still protected
        let r = check_path_safety(Path::new(".hologram/permissions.json"));
        assert!(!r.safe, "permissions.json writes should be blocked");
        let r = check_path_safety(Path::new(".hologram/baseline.json"));
        assert!(!r.safe, "baseline.json writes should be blocked");
        let r = check_path_safety(Path::new(".hologram/settings.json"));
        assert!(!r.safe, "settings.json writes should be blocked");
        let r = check_path_safety(Path::new(".git/config"));
        assert!(!r.safe, ".git/config writes should be blocked");
    }
}
