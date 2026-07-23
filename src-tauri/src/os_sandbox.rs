// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OS-level sandbox (spec §6)
// Phase 4a: Windows Job Object — die-with-parent process lifecycle.
//   AppContainer (Phase 4b) has been removed — it conflicted with general-purpose
//   dev toolchains that spawn deep process trees loading DLLs from unpredictable
//   paths. File-system and network isolation are handled by the permission engine.
// Phase 5: macOS sandbox-exec + Linux bubblewrap (spec §6.4–§6.7)
// ponytail: pure Win32 FFI + platform tools, zero new crate deps.

use std::io::{self, Read};
use std::process::ExitStatus;
use std::time::Duration;

// ═══════════════════════════════════════════════════════════════
// Spawn retry — transient fork/spawn errors are retried
// ═══════════════════════════════════════════════════════════════

const SPAWN_RETRY_COUNT: u32 = 3;
const SPAWN_RETRY_BASE_DELAY: Duration = Duration::from_millis(200);

/// Retry a process spawn on transient errors (EAGAIN, ENOMEM, etc.).
/// Returns the first non-retryable error or the last retryable error.
fn retry_spawn<F>(mut spawn_fn: F) -> io::Result<std::process::Child>
where
    F: FnMut() -> io::Result<std::process::Child>,
{
    let mut last_err: Option<io::Error> = None;
    for attempt in 0..=SPAWN_RETRY_COUNT {
        match spawn_fn() {
            Ok(child) => return Ok(child),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) || is_transient_spawn_error(&e);
                if !retryable || attempt == SPAWN_RETRY_COUNT {
                    return Err(e);
                }
                let delay = SPAWN_RETRY_BASE_DELAY * 2u32.pow(attempt);
                eprintln!(
                    "[hologram] spawn retry {}/{} — {:?} (retrying in {:?})",
                    attempt + 1, SPAWN_RETRY_COUNT, e, delay
                );
                std::thread::sleep(delay);
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::new(io::ErrorKind::Other, "spawn: unreachable")))
}

/// Check raw OS error for transient spawn failures.
/// EAGAIN (11), ENOMEM (12) on Unix; ERROR_NO_SYSTEM_RESOURCES (1450) on Windows.
fn is_transient_spawn_error(e: &io::Error) -> bool {
    match e.raw_os_error() {
        #[cfg(unix)]
        Some(11 /* EAGAIN */) | Some(12 /* ENOMEM */) => true,
        #[cfg(windows)]
        Some(1450 /* ERROR_NO_SYSTEM_RESOURCES */) => true,
        _ => false,
    }
}

// ═══════════════════════════════════════════════════════════════
// Cross-platform public API
// ═══════════════════════════════════════════════════════════════

/// Sandbox availability status for UI/warning display (spec §6.6–§6.7).
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum SandboxStatus {
    /// Full sandbox active (Job Object on Windows).
    Available,
    /// Unavailable — no OS sandbox (permission engine is the fallback).
    Unavailable,
}

/// Sandboxed process handle — wraps a std::process::Child,
/// assigned to the Job Object (Windows) or plain spawn (other platforms).
pub struct SandboxedChild {
    inner: std::process::Child,
}

#[allow(dead_code)]
impl SandboxedChild {
    pub fn id(&self) -> u32 {
        self.inner.id()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.inner.wait()
    }

    pub fn kill(&mut self) -> io::Result<()> {
        self.inner.kill()
    }

    pub fn take_stdout(&mut self) -> Option<Box<dyn Read + Send + Unpin>> {
        self.inner.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send + Unpin>)
    }

    pub fn take_stderr(&mut self) -> Option<Box<dyn Read + Send + Unpin>> {
        self.inner.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send + Unpin>)
    }

    pub fn stdout_reader(&mut self) -> Option<&mut dyn Read> {
        self.inner.stdout.as_mut().map(|s| s as &mut dyn Read)
    }

    pub fn stderr_reader(&mut self) -> Option<&mut dyn Read> {
        self.inner.stderr.as_mut().map(|s| s as &mut dyn Read)
    }
}

// ═══════════════════════════════════════════════════════════════
// Public functions
// ═══════════════════════════════════════════════════════════════

/// One-time init — call at app startup. Creates Job Object (Windows).
/// On Linux, checks bubblewrap availability and logs status.
pub fn init() {
    #[cfg(windows)]
    imp::job::init();
    #[cfg(target_os = "linux")]
    {
        let s = linux::status();
        match s {
            SandboxStatus::Available => {
                eprintln!("[hologram] bubblewrap sandbox detected — shell commands will be sandboxed");
            }
            SandboxStatus::Unavailable => {
                eprintln!(
                    "[hologram] bubblewrap not found — install with: apt install bubblewrap \
                     (or equivalent). Shell commands will run without OS sandbox; \
                     permission engine still active."
                );
            }
        }
    }
}

/// Query the current sandbox status for UI display (spec §6.6).
pub fn status() -> SandboxStatus {
    #[cfg(windows)]
    { imp::status() }
    #[cfg(target_os = "macos")]
    { mac::status() }
    #[cfg(target_os = "linux")]
    { linux::status() }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    { SandboxStatus::Unavailable }
}

/// Spawn a shell command in the sandbox. On Windows this assigns the
/// process to the Job Object for die-with-parent lifecycle management.
/// On macOS this uses sandbox-exec; on Linux, bubblewrap.
/// Falls back to plain spawn when the OS sandbox tool is not available.
pub fn spawn_shell(command: &str, cwd: &str) -> io::Result<SandboxedChild> {
    #[cfg(windows)]
    {
        let shell = imp::detect_shell();
        if let imp::Shell::Bash(ref bash_path) = shell {
            let cmdline = format!("\"{}\" -c {}", bash_path, quote_cmd(command));
            match imp::spawn(&cmdline, cwd) {
                Ok(child) => return Ok(child),
                Err(e) => {
                    eprintln!("[hologram] bash spawn failed ({}), falling back to Cmd", e);
                }
            }
        }
        let cmdline = format!("cmd /s /c \"{}\"", command);
        imp::spawn(&cmdline, cwd)
    }
    #[cfg(target_os = "macos")]
    {
        match mac::spawn(command, cwd) {
            Ok(child) => return Ok(child),
            Err(e) => {
                eprintln!("[hologram] sandbox-exec failed ({}), falling back to plain spawn", e);
            }
        }
        spawn_plain(command, cwd)
    }
    #[cfg(target_os = "linux")]
    {
        match linux::spawn(command, cwd) {
            Ok(child) => return Ok(child),
            Err(e) => {
                eprintln!("[hologram] bubblewrap failed ({}), falling back to plain spawn", e);
            }
        }
        spawn_plain(command, cwd)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        spawn_plain(command, cwd)
    }
}

/// Plain shell spawn without any sandbox wrapping — used as fallback when
/// OS sandbox is unavailable (spec §6.7). Retries on transient fork errors.
#[cfg(not(windows))]
fn spawn_plain(command: &str, cwd: &str) -> io::Result<SandboxedChild> {
    let cmd = command.to_string();
    let dir = cwd.to_string();
    let child = retry_spawn(|| {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(&dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    })?;
    Ok(SandboxedChild { inner: child })
}

/// Assign an already-spawned std::process::Child to the Job Object.
/// Non-sandboxed infrastructure spawns (LSP, MCP, Unity) use this.
/// Returns true on success, false if Job Object unavailable.
pub fn assign_to_job(child: &std::process::Child) -> bool {
    #[cfg(windows)]
    { imp::job::assign(child) }
    #[cfg(not(windows))]
    { let _ = child; true }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/// Single-quote a command for bash -c. Single quotes escape EVERYTHING
/// (including $, &, !, `, \), only ' itself needs special handling.
fn quote_cmd(cmd: &str) -> String {
    let escaped = cmd.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

// ═══════════════════════════════════════════════════════════════
// Windows implementation — Job Object only
// ═══════════════════════════════════════════════════════════════

#[cfg(windows)]
#[allow(dead_code)]
pub mod imp {
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::sync::OnceLock;

    use super::SandboxStatus;

    // ── FFI declarations ──

    extern "system" {
        // Job Object
        fn CreateJobObjectW(attrs: *mut std::ffi::c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(
            job: isize, info_class: i32, info: *const std::ffi::c_void, info_len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    }

    // ── Constants ──

    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Job Object limits
    const JOB_OBJECT_LIMIT_DIE_ON_JOB_CLOSE: u32 = 0x00002000;
    const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x00000800;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x00000008;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x00000200;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    // ── FFI structs ──

    #[repr(C)]
    struct JobObjectExtendedLimitInformationRaw {
        basic: JobObjectBasicLimitInformation,
        io_counters: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: u64,
        per_job_user_time_limit: u64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64, write_operation_count: u64, other_operation_count: u64,
        read_transfer_count: u64, write_transfer_count: u64, other_transfer_count: u64,
    }

    // ── Shell detection ──

    #[derive(Clone)]
    pub enum Shell {
        Bash(String),
        Cmd,
    }

    static DETECTED_SHELL: OnceLock<Shell> = OnceLock::new();

    fn detect_shell_inner() -> Shell {
        let bash_candidates = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ];
        for path in &bash_candidates {
            if std::path::Path::new(path).exists()
                && smoke_test_bash(path) {
                    return Shell::Bash(path.to_string());
                }
        }
        if let Ok(output) = std::process::Command::new("where")
            .arg("git")
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
            .output()
        {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let git_path = line.trim();
                if let Some(cmd_dir) = std::path::Path::new(git_path).parent() {
                    if let Some(git_root) = cmd_dir.parent() {
                        let bash = git_root.join("bin").join("bash.exe");
                        if bash.exists() {
                            let bash_str = bash.to_string_lossy().into_owned();
                            if smoke_test_bash(&bash_str) {
                                return Shell::Bash(bash_str);
                            }
                        }
                    }
                    let bash = cmd_dir.join("bash.exe");
                    if bash.exists() {
                        let bash_str = bash.to_string_lossy().into_owned();
                        if smoke_test_bash(&bash_str) {
                            return Shell::Bash(bash_str);
                        }
                    }
                }
            }
        }
        Shell::Cmd
    }

    /// Smoke-test: spawn `bash -c "exit 0"` to verify bash actually works.
    fn smoke_test_bash(bash_path: &str) -> bool {
        let cmdline = format!("\"{}\" -c {}", bash_path, super::quote_cmd("exit 0"));
        match spawn(&cmdline, ".") {
            Ok(mut child) => match child.wait() {
                Ok(status) => status.success(),
                Err(_) => false,
            },
            Err(_) => false,
        }
    }

    pub fn detect_shell() -> Shell {
        DETECTED_SHELL.get_or_init(detect_shell_inner).clone()
    }

    /// Convert a Windows path to POSIX form for Git Bash.
    /// "C:\\Users\\foo\\bar" → "/c/Users/foo/bar"
    pub fn windows_to_posix_path(path: &str) -> String {
        let path = path.strip_prefix("\\\\?\\").unwrap_or(path);
        if path.starts_with("\\\\") {
            return path.replace('\\', "/");
        }
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let drive = (bytes[0] as char).to_ascii_lowercase();
            let rest = path[2..].replace('\\', "/");
            return format!("/{}{}", drive, rest);
        }
        path.replace('\\', "/")
    }

    // ── Job Object ──

    pub mod job {
        use std::os::windows::io::AsRawHandle;
        use std::sync::OnceLock;
        use super::*;

        static JOB: OnceLock<Option<isize>> = OnceLock::new();

        pub fn init() {
            JOB.get_or_init(|| {
                let h = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
                if h == 0 {
                    eprintln!("[hologram] CreateJobObjectW failed — skipping job object");
                    return None;
                }
                let mut limits: JobObjectExtendedLimitInformationRaw =
                    unsafe { std::mem::zeroed() };
                limits.basic.limit_flags =
                    JOB_OBJECT_LIMIT_DIE_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_BREAKAWAY_OK
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | JOB_OBJECT_LIMIT_JOB_MEMORY;
                limits.basic.active_process_limit = 64;
                limits.job_memory_limit = 1024 * 1024 * 1024; // 1 GiB
                let ret = unsafe {
                    SetInformationJobObject(
                        h, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                        &limits as *const _ as *const std::ffi::c_void,
                        std::mem::size_of::<JobObjectExtendedLimitInformationRaw>() as u32,
                    )
                };
                if ret == 0 {
                    eprintln!("[hologram] SetInformationJobObject failed");
                    return None;
                }
                Some(h)
            });
        }

        pub fn assign(child: &std::process::Child) -> bool {
            let job = match JOB.get().and_then(|o| *o) {
                Some(h) => h,
                None => return false,
            };
            let raw = child.as_raw_handle();
            if raw.is_null() { return false; }
            unsafe { AssignProcessToJobObject(job, raw as isize) != 0 }
        }

        pub fn is_active() -> bool {
            JOB.get().and_then(|o| *o).is_some()
        }
    }

    // ── Sandbox status ──

    pub fn status() -> SandboxStatus {
        if job::is_active() {
            SandboxStatus::Available
        } else {
            SandboxStatus::Unavailable
        }
    }

    // ── Sandboxed spawn (Job Object only) ──

    /// Spawn a shell command and assign it to the Job Object.
    pub fn spawn(cmdline: &str, cwd: &str) -> io::Result<super::SandboxedChild> {
        let (program, args) = split_cmdline(cmdline);
        let mut c = std::process::Command::new(&program);
        for a in &args {
            c.arg(a);
        }
        c.current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
        let child = c.spawn()?;
        job::assign(&child);
        Ok(super::SandboxedChild { inner: child })
    }

    // ── Command-line helpers ──

    /// Split "bash" -c '...' into ("bash", ["-c", "..."]).
    fn split_cmdline(cmdline: &str) -> (String, Vec<String>) {
        let mut parts: Vec<String> = Vec::new();
        let mut current = String::new();
        let mut in_double = false;
        let mut in_single = false;
        for ch in cmdline.chars() {
            match ch {
                '"' if !in_single => {
                    in_double = !in_double;
                }
                '\'' if !in_double => {
                    in_single = !in_single;
                }
                ' ' | '\t' if !in_double && !in_single => {
                    if !current.is_empty() {
                        parts.push(unquote(&current));
                        current.clear();
                    }
                }
                _ => current.push(ch),
            }
        }
        if !current.is_empty() {
            parts.push(unquote(&current));
        }
        if parts.is_empty() {
            return (String::new(), vec![]);
        }
        let program = parts.remove(0);
        (program, parts)
    }

    /// Strip one layer of matching quotes.
    fn unquote(s: &str) -> String {
        let s = s.trim();
        if s.len() >= 2 {
            let bytes = s.as_bytes();
            if (bytes[0] == b'"' && bytes[s.len() - 1] == b'"')
                || (bytes[0] == b'\'' && bytes[s.len() - 1] == b'\'')
            {
                return s[1..s.len() - 1].to_string();
            }
        }
        s.to_string()
    }

    // ── Tests ──

    #[cfg(test)]
    mod tests {
        use super::{detect_shell, windows_to_posix_path, Shell};

        #[test]
        fn test_windows_to_posix_drive_letter() {
            assert_eq!(windows_to_posix_path("C:\\Users\\foo\\bar"), "/c/Users/foo/bar");
            assert_eq!(windows_to_posix_path("D:\\project\\src\\main.rs"), "/d/project/src/main.rs");
            assert_eq!(windows_to_posix_path("C:/Users/foo"), "/c/Users/foo");
        }

        #[test]
        fn test_windows_to_posix_nt_prefix() {
            assert_eq!(
                windows_to_posix_path("\\\\?\\D:\\HoloGramHG\\src"),
                "/d/HoloGramHG/src"
            );
            assert_eq!(
                windows_to_posix_path("\\\\?\\C:\\Program Files\\Git"),
                "/c/Program Files/Git"
            );
        }

        #[test]
        fn test_windows_to_posix_unc() {
            assert_eq!(
                windows_to_posix_path("\\\\server\\share\\file.txt"),
                "//server/share/file.txt"
            );
        }

        #[test]
        fn test_windows_to_posix_no_drive() {
            assert_eq!(windows_to_posix_path("src\\main.rs"), "src/main.rs");
            assert_eq!(windows_to_posix_path("some/relative/path"), "some/relative/path");
        }

        #[test]
        fn test_windows_to_posix_chinese_path() {
            assert_eq!(
                windows_to_posix_path("C:\\Users\\用户\\桌面\\绝密"),
                "/c/Users/用户/桌面/绝密"
            );
            assert_eq!(
                windows_to_posix_path("\\\\?\\D:\\360MoveData\\绝密\\data"),
                "/d/360MoveData/绝密/data"
            );
        }

        #[test]
        fn test_detect_shell_returns_valid_variant() {
            let shell = detect_shell();
            match shell {
                Shell::Bash(ref path) => {
                    assert!(
                        std::path::Path::new(path).exists(),
                        "detected bash path must exist: {}",
                        path
                    );
                }
                Shell::Cmd => {}
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// macOS implementation — sandbox-exec (spec §6.4)
// ═══════════════════════════════════════════════════════════════

#[cfg(target_os = "macos")]
mod mac {
    use std::io;
    use std::path::Path;

    use super::{SandboxStatus, SandboxedChild};

    pub fn status() -> SandboxStatus {
        if Path::new("/usr/bin/sandbox-exec").exists() {
            SandboxStatus::Available
        } else {
            SandboxStatus::Unavailable
        }
    }

    pub fn spawn(command: &str, cwd: &str) -> io::Result<SandboxedChild> {
        if !Path::new("/usr/bin/sandbox-exec").exists() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "sandbox-exec not found"));
        }
        let profile = build_profile(cwd);
        // Wrap with ulimit for resource bounds (8 GiB VM, 300s CPU)
        let limited_cmd = format!(
            "ulimit -v {} -t {} && exec {}",
            8 * 1024 * 1024, // 8 GiB in KiB
            300,             // 300s CPU time
            command
        );
        let child = super::retry_spawn(|| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .arg("-p")
                .arg(&profile)
                .arg("--")
                .arg("sh")
                .arg("-c")
                .arg(&limited_cmd)
                .current_dir(cwd)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
        })?;
        Ok(SandboxedChild { inner: child })
    }

    fn build_profile(cwd: &str) -> String {
        let root = cwd.replace('"', "\\\"");
        let tmp = std::env::temp_dir();
        let tmp_str = tmp.to_string_lossy().replace('"', "\\\"");

        format!(
            concat!(
                "(version 1)\n",
                "(deny default)\n",
                "(allow file-read*)\n",
                "(allow file-write* (subpath \"{0}\"))\n",
                "(allow file-write* (subpath \"{1}\"))\n",
                "(allow process-exec)\n",
                "(allow process-fork)\n",
                "(allow signal)\n",
                "(allow sysctl-read)\n",
                "(allow network-outbound)\n",
                "(allow mach-lookup)\n",
                "(allow iokit-open)\n",
            ),
            root, tmp_str,
        )
    }
}

// ═══════════════════════════════════════════════════════════════
// Linux implementation — bubblewrap (spec §6.5)
// ═══════════════════════════════════════════════════════════════

#[cfg(target_os = "linux")]
mod linux {
    use std::io;
    use std::path::{Path, PathBuf};

    use super::{SandboxStatus, SandboxedChild};

    /// Check if bwrap binary is available on PATH.
    fn bwrap_path() -> Option<PathBuf> {
        // Check common locations first (faster than `which`)
        let candidates = [
            "/usr/bin/bwrap",
            "/usr/local/bin/bwrap",
        ];
        for c in &candidates {
            if Path::new(c).exists() {
                return Some(PathBuf::from(c));
            }
        }
        // Fall back to PATH lookup
        let output = std::process::Command::new("which")
            .arg("bwrap")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout);
            let p = p.trim();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
        None
    }

    pub fn status() -> SandboxStatus {
        if bwrap_path().is_some() {
            SandboxStatus::Available
        } else {
            SandboxStatus::Unavailable
        }
    }

    pub fn spawn(command: &str, cwd: &str) -> io::Result<SandboxedChild> {
        let bwrap = bwrap_path().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "bubblewrap (bwrap) not found")
        })?;

        let ro_binds = existing_ro_binds();
        let temp = std::env::temp_dir();

        // Collect home directory for read-only bind (needed for ~/.cargo, ~/.rustup, ~/.nvm, etc.)
        let home = std::env::var("HOME").unwrap_or_default();

        // Wrap command with resource limits: 8 GiB virtual memory, 300s CPU time.
        // ulimit -v limits address space (stack+heap+mmap), catches most runaway
        // processes without requiring cgroup or systemd-run. SIGKILL on exceed.
        let limited_cmd = format!(
            "ulimit -v {} -t {} && exec {}",
            8 * 1024 * 1024, // 8 GiB in KiB
            300,             // 300s CPU time
            command
        );

        let mut cmd = std::process::Command::new(&bwrap);

        // Read-only system paths
        for (src, dst) in &ro_binds {
            cmd.arg("--ro-bind").arg(src).arg(dst);
        }

        // Read-only home directory (dev toolchains need to read ~/.cargo, ~/.nvm, ~/.rustup)
        if !home.is_empty() && Path::new(&home).exists() {
            cmd.arg("--ro-bind").arg(&home).arg(&home);
        }

        // Read-write: project directory and temp
        cmd.arg("--bind").arg(cwd).arg(cwd);
        cmd.arg("--bind").arg(temp.as_os_str()).arg("/tmp");

        // Process lifecycle: die with parent
        cmd.arg("--die-with-parent");

        // Allow new namespaces (needed for nested process spawning)
        cmd.arg("--unshare-pid");

        cmd.arg("--")
            .arg("sh")
            .arg("-c")
            .arg(&limited_cmd);

        cmd.current_dir(cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let child = super::retry_spawn(|| cmd.spawn())?;
        Ok(SandboxedChild { inner: child })
    }

    fn existing_ro_binds() -> Vec<(&'static str, &'static str)> {
        let candidates: &[(&str, &str)] = &[
            ("/usr", "/usr"),
            ("/lib", "/lib"),
            ("/lib64", "/lib64"),
            ("/bin", "/bin"),
            ("/sbin", "/sbin"),
            ("/etc", "/etc"),
            ("/proc", "/proc"),
            ("/dev", "/dev"), // needed for PTY, /dev/null, etc.
        ];
        candidates
            .iter()
            .filter(|(src, _)| Path::new(src).exists())
            .copied()
            .collect()
    }
}
