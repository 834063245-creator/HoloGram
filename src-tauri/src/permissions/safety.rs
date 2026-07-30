// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// safetyCheck — 不可绕过的安全层 (spec §4.5)
// 即使规则允许，safety_check 仍可对受保护路径强制 Ask。
use std::path::Path;

pub struct SafetyCheckResult {
    pub safe: bool,
    pub message: String,
}

/// 检查路径是否可以安全读取。
/// 类似 check_path_safety，但跳过 .hologram/ 配置检查 — 读取
/// HoloGram 自身的数据文件（memory、sessions、logs）是安全且必要的，
/// 是正常操作的一部分。只有写入它们才是危险的。
/// ponytail: 读路径不检查 dangerous_dir — 浏览 .vscode/.git/.idea 是正常操作,
/// 只有写这些目录才需要保护. 之前读也拦导致文件树展开 .vscode 被 safety Ask 拦截.
pub fn check_path_safety_read(path: &Path) -> SafetyCheckResult {
    let path_str = path.to_string_lossy();

    // 1. Windows 可疑路径模式
    #[cfg(windows)]
    if has_suspicious_windows_path(&path_str) {
        return SafetyCheckResult { safe: false, message: "可疑的 Windows 路径模式".into() };
    }

    // 1b. Linux/macOS — /proc/self/fd/* 可能泄露其他进程的文件描述符
    #[cfg(unix)]
    if is_suspicious_unix_read_path(&path_str) {
        return SafetyCheckResult { safe: false, message: "受保护的系统路径".into() };
    }

    // 2. 危险的系统配置文件 — 读取也保护（凭据）
    if is_dangerous_file(path) {
        return SafetyCheckResult { safe: false, message: "系统配置文件受保护".into() };
    }

    SafetyCheckResult { safe: true, message: String::new() }
}

/// 检查路径是否可以安全写入（或任何操作）。
/// 不可绕过：规则/模式无法覆盖此项。
pub fn check_path_safety(path: &Path) -> SafetyCheckResult {
    let path_str = path.to_string_lossy();

    // 1. Windows 可疑路径模式（NTFS ADS、8.3 短文件名、尾部点号、DOS 设备名）
    #[cfg(windows)]
    if has_suspicious_windows_path(&path_str) {
        return SafetyCheckResult {
            safe: false,
            message: "可疑的 Windows 路径模式".into(),
        };
    }

    // 1b. Linux/macOS 可疑路径（/proc、/sys、/dev 写入）
    #[cfg(unix)]
    if is_suspicious_unix_path(&path_str) {
        return SafetyCheckResult {
            safe: false,
            message: "受保护的系统路径，不可修改".into(),
        };
    }

    // 2. HoloGram 配置文件 — 始终受保护
    if is_hologram_config_path(path) {
        return SafetyCheckResult {
            safe: false,
            message: "HoloGram 配置文件受保护，不可修改".into(),
        };
    }

    // 3. 危险的系统配置文件
    if is_dangerous_file(path) {
        return SafetyCheckResult {
            safe: false,
            message: "系统配置文件受保护，不可修改".into(),
        };
    }

    // 4. 危险目录（worktree 豁免）
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

/// HoloGram 配置路径 — `.hologram/` 目录内容。
/// 运行时数据目录（memory、sessions、logs、worktrees）被豁免 —
/// HoloGram UI 在正常运行时会写入这些目录。
fn is_hologram_config_path(path: &Path) -> bool {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    for i in 0..components.len() {
        if components[i] == ".hologram" {
            // 运行时数据目录被豁免 — HoloGram UI 会写入这些目录
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

/// 危险的系统配置文件 — 永远不允许写入。
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
        ".env",
        ".env.production",
        ".env.local",
        ".mcp.json",
        ".npmrc",
        ".htpasswd",
    ];
    if dangerous_names.contains(&name) {
        return true;
    }
    // 检查完整路径中的 .ssh 目录
    let path_str = path.to_string_lossy().replace('\\', "/");
    if path_str.contains("/.ssh/") {
        return true;
    }
    // 检查完整路径中的 .aws 目录 (AWS 凭据)
    if path_str.contains("/.aws/") {
        return true;
    }
    // 检查完整路径中的 .docker 目录 (Docker 配置)
    if path_str.contains("/.docker/") {
        return true;
    }
    // 检查完整路径中的 .kube 目录 (Kubernetes 配置)
    if path_str.contains("/.kube/") {
        return true;
    }
    false
}

/// 危险目录 — .git, .vscode, .idea, .hologram (非 worktree)
fn is_dangerous_dir(path: &Path) -> bool {
    // 检查路径中是否有任何组件是危险目录
    for component in path.components() {
        if let Some(s) = component.as_os_str().to_str() {
            if s.eq_ignore_ascii_case(".git")
                || s.eq_ignore_ascii_case(".vscode")
                || s.eq_ignore_ascii_case(".idea")
                || s.eq_ignore_ascii_case(".cursor")
            {
                return true;
            }
        }
    }
    false
}

#[cfg(windows)]
fn has_suspicious_windows_path(path_str: &str) -> bool {
    // NTFS 备用数据流: file.txt:stream
    // 盘符冒号是合法的: "C:\..." 或 "\\?\C:\..." (长路径前缀)
    let bytes = path_str.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b':' {
            // 位置 1: "C:\..." 盘符
            if i == 1 && bytes.get(i.wrapping_sub(1)).is_some_and(|b| b.is_ascii_alphabetic()) {
                continue;
            }
            // 位置 5: "\\?\C:\..." 长路径盘符
            if i == 5 && path_str.starts_with("\\\\?\\") && bytes.get(4).is_some_and(|b| b.is_ascii_alphabetic()) {
                continue;
            }
            // 其他位置的冒号均可疑 (ADS)
            return true;
        }
    }
    // 尾部点号或空格 (NTFS 会去除但某些 API 会保留)
    if path_str.ends_with('.') || path_str.ends_with(' ') {
        return true;
    }
    // DOS 设备名
    let dos_names = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    for name in dos_names {
        if path_str == *name || path_str.starts_with(&format!("{}.", name)) {
            return true;
        }
    }
    // 原始设备路径: \\.\PhysicalDrive0, \\.\C: 等
    let lower = path_str.to_lowercase();
    if lower.starts_with("\\\\.\\physicaldrive") {
        return true;
    }
    // \\.\C: 模式 (原始卷访问)
    if lower.starts_with("\\\\.\\") {
        let rest = &path_str[4..]; // after "\\.\"
        if rest.len() >= 1 && rest.as_bytes()[0].is_ascii_alphabetic() {
            if rest.len() == 1 || (rest.len() >= 2 && rest.as_bytes()[1] == b':') {
                return true;
            }
        }
    }
    // \\?\GLOBALROOT 前缀
    if lower.starts_with("\\\\?\\globalroot") {
        return true;
    }
    false
}

/// Linux/macOS 写操作的可疑路径。
/// /proc 和 /sys 是内核接口 — 写入可能导致系统崩溃。
/// /dev 设备文件 — 写入可能损坏硬件状态。
#[cfg(unix)]
fn is_suspicious_unix_path(path_str: &str) -> bool {
    let p = path_str;

    // /proc/self/* — 符号链接逃逸 (可访问其他进程的内存、fd 等)
    if p.starts_with("/proc/self/") || p == "/proc/self" {
        return true;
    }

    // /sys — 内核接口，写入很危险
    if p.starts_with("/sys/") || p == "/sys" {
        return true;
    }

    // /dev — 设备文件，写入可能损坏硬件
    // 允许 /dev/null, /dev/zero, /dev/urandom (脚本中常用)
    if (p.starts_with("/dev/") || p == "/dev")
        && !p.ends_with("/dev/null")
        && !p.ends_with("/dev/zero")
        && !p.ends_with("/dev/urandom")
        && !p.ends_with("/dev/random")
        && !p.ends_with("/dev/stdin")
        && !p.ends_with("/dev/stdout")
        && !p.ends_with("/dev/stderr")
        && !p.ends_with("/dev/tty")
    {
        return true;
    }

    // /boot — 内核镜像，引导加载器配置
    if p.starts_with("/boot/") || p == "/boot" {
        return true;
    }

    // /etc — 系统配置 (写入)
    // 读取允许 (浏览配置是正常操作)，写入被阻止
    if p.starts_with("/etc/") || p == "/etc" {
        return true;
    }

    false
}

/// Linux/macOS 读操作的可疑路径。
/// 比写操作更宽松 — 允许读取 /etc 和 /dev。
/// 仅阻止 /proc/self/fd/* (可能泄露其他进程的文件描述符)。
#[cfg(unix)]
fn is_suspicious_unix_read_path(path_str: &str) -> bool {
    // /proc/self/fd/* — 可能泄露 HoloGram 进程的文件描述符
    if path_str.starts_with("/proc/self/fd/") {
        return true;
    }
    // /proc/self/mem — 进程内存转储
    if path_str.starts_with("/proc/self/mem") {
        return true;
    }
    // /proc/self/environ — 环境变量 (可能包含密钥)
    if path_str.starts_with("/proc/self/environ") {
        return true;
    }
    // /proc/self/maps — ASLR 泄露 (内存布局)
    if path_str.starts_with("/proc/self/maps") {
        return true;
    }
    // /proc/self/cmdline — 命令行参数
    if path_str.starts_with("/proc/self/cmdline") {
        return true;
    }
    // /proc/self/status — 进程状态 (可能泄露敏感信息)
    if path_str.starts_with("/proc/self/status") {
        return true;
    }
    // /proc/self/cgroup — cgroup 成员信息
    if path_str.starts_with("/proc/self/cgroup") {
        return true;
    }
    // /proc/self/mountinfo — 挂载命名空间信息
    if path_str.starts_with("/proc/self/mountinfo") {
        return true;
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

    // ── 读取安全检查 (check_path_safety_read) 豁免 .hologram/ ──

    #[test]
    fn test_read_safety_allows_hologram() {
        // 读取 .hologram/ 文件是安全的 — 它们是 HoloGram 自身的数据
        let r = check_path_safety_read(Path::new(".hologram/memory/MEMORY.md"));
        assert!(r.safe, "memory reads should be allowed");
        let r = check_path_safety_read(Path::new(".hologram/logs/bridge.log"));
        assert!(r.safe, "log reads should be allowed");
        let r = check_path_safety_read(Path::new(".hologram/sessions/chat.json"));
        assert!(r.safe, "session reads should be allowed");
    }

    #[test]
    fn test_read_safety_blocks_dangerous() {
        // 危险系统文件读取仍被阻止 (凭据)
        let r = check_path_safety_read(Path::new("/home/user/.bashrc"));
        assert!(!r.safe, "bashrc reads should be blocked");
        let r = check_path_safety_read(Path::new("/home/user/.ssh/id_rsa"));
        assert!(!r.safe, "ssh key reads should be blocked");
        // ponytail: .git/config 读取现在允许 — dangerous_dir 检查仅针对写。
        // 文件树需要浏览 .vscode/.idea 等目录而不触发 Ask 弹窗。
        let r = check_path_safety_read(Path::new(".git/config"));
        assert!(r.safe, ".git/config reads should be allowed (only writes to .git are blocked)");
        let r = check_path_safety_read(Path::new(".vscode/settings.json"));
        assert!(r.safe, ".vscode reads should be allowed");
    }

    // ── 写入安全检查豁免运行时目录 (memory/logs/sessions/worktrees) ──

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
        // 实际配置文件仍受保护
        let r = check_path_safety(Path::new(".hologram/permissions.json"));
        assert!(!r.safe, "permissions.json writes should be blocked");
        let r = check_path_safety(Path::new(".hologram/baseline.json"));
        assert!(!r.safe, "baseline.json writes should be blocked");
        let r = check_path_safety(Path::new(".hologram/settings.json"));
        assert!(!r.safe, "settings.json writes should be blocked");
        let r = check_path_safety(Path::new(".git/config"));
        assert!(!r.safe, ".git/config writes should be blocked");
    }

    // ── Unix 路径安全 ──

    #[cfg(unix)]
    #[test]
    fn test_unix_write_blocks_proc() {
        let r = check_path_safety(Path::new("/proc/self/status"));
        assert!(!r.safe, "/proc/self writes should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_write_blocks_sys() {
        let r = check_path_safety(Path::new("/sys/class/net/eth0/mtu"));
        assert!(!r.safe, "/sys writes should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_write_blocks_dev() {
        let r = check_path_safety(Path::new("/dev/sda"));
        assert!(!r.safe, "/dev/sda writes should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_write_allows_dev_null() {
        let r = check_path_safety(Path::new("/dev/null"));
        assert!(r.safe, "/dev/null writes should be allowed");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_write_blocks_boot() {
        let r = check_path_safety(Path::new("/boot/grub/grub.cfg"));
        assert!(!r.safe, "/boot writes should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_write_blocks_etc() {
        let r = check_path_safety(Path::new("/etc/passwd"));
        assert!(!r.safe, "/etc writes should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_fd() {
        let r = check_path_safety_read(Path::new("/proc/self/fd/3"));
        assert!(!r.safe, "/proc/self/fd reads should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_mem() {
        let r = check_path_safety_read(Path::new("/proc/self/mem"));
        assert!(!r.safe, "/proc/self/mem reads should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_allows_etc() {
        let r = check_path_safety_read(Path::new("/etc/hostname"));
        assert!(r.safe, "/etc reads should be allowed");
    }

    // ── 修复 1: is_dangerous_dir 大小写不敏感 ──

    #[test]
    fn test_dangerous_dir_case_insensitive_git() {
        // .GIT 应像 .git 一样被阻止
        let r = check_path_safety(Path::new(".GIT/config"));
        assert!(!r.safe, ".GIT/config writes should be blocked (case-insensitive)");
    }

    #[test]
    fn test_dangerous_dir_case_insensitive_vscode() {
        let r = check_path_safety(Path::new(".VSCode/settings.json"));
        assert!(!r.safe, ".VSCode writes should be blocked (case-insensitive)");
    }

    #[test]
    fn test_dangerous_dir_case_insensitive_idea() {
        let r = check_path_safety(Path::new(".IdEa/workspace.xml"));
        assert!(!r.safe, ".IdEa writes should be blocked (case-insensitive)");
    }

    #[test]
    fn test_dangerous_dir_case_insensitive_cursor() {
        let r = check_path_safety(Path::new(".CURSOR/rules.txt"));
        assert!(!r.safe, ".CURSOR writes should be blocked (case-insensitive)");
    }

    // ── 修复 2: is_suspicious_unix_read_path 额外 /proc/self 路径 ──

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_maps() {
        let r = check_path_safety_read(Path::new("/proc/self/maps"));
        assert!(!r.safe, "/proc/self/maps reads should be blocked (ASLR leak)");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_cmdline() {
        let r = check_path_safety_read(Path::new("/proc/self/cmdline"));
        assert!(!r.safe, "/proc/self/cmdline reads should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_status() {
        let r = check_path_safety_read(Path::new("/proc/self/status"));
        assert!(!r.safe, "/proc/self/status reads should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_cgroup() {
        let r = check_path_safety_read(Path::new("/proc/self/cgroup"));
        assert!(!r.safe, "/proc/self/cgroup reads should be blocked");
    }

    #[cfg(unix)]
    #[test]
    fn test_unix_read_blocks_proc_mountinfo() {
        let r = check_path_safety_read(Path::new("/proc/self/mountinfo"));
        assert!(!r.safe, "/proc/self/mountinfo reads should be blocked");
    }

    // ── 修复 3: has_suspicious_windows_path 设备路径 ──

    #[cfg(windows)]
    #[test]
    fn test_windows_blocks_physical_drive() {
        let r = check_path_safety(Path::new("\\\\.\\PhysicalDrive0"));
        assert!(!r.safe, "PhysicalDrive should be blocked");
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_blocks_raw_volume() {
        let r = check_path_safety(Path::new("\\\\.\\C:"));
        assert!(!r.safe, "raw volume C: should be blocked");
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_blocks_globalroot() {
        let r = check_path_safety(Path::new("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1"));
        assert!(!r.safe, "GLOBALROOT should be blocked");
    }

    // ── 修复 4: is_dangerous_file 额外敏感文件 ──

    #[test]
    fn test_dangerous_file_npmrc() {
        let r = check_path_safety(Path::new("/home/user/.npmrc"));
        assert!(!r.safe, ".npmrc should be blocked");
    }

    #[test]
    fn test_dangerous_file_htpasswd() {
        let r = check_path_safety(Path::new("/var/www/.htpasswd"));
        assert!(!r.safe, ".htpasswd should be blocked");
    }

    #[test]
    fn test_dangerous_file_aws_credentials() {
        let r = check_path_safety(Path::new("/home/user/.aws/credentials"));
        assert!(!r.safe, ".aws/credentials should be blocked");
    }

    #[test]
    fn test_dangerous_file_docker_config() {
        let r = check_path_safety(Path::new("/home/user/.docker/config.json"));
        assert!(!r.safe, ".docker/config.json should be blocked");
    }

    #[test]
    fn test_dangerous_file_kube_config() {
        let r = check_path_safety(Path::new("/home/user/.kube/config"));
        assert!(!r.safe, ".kube/config should be blocked");
    }
}