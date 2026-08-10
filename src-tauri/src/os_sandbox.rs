// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OS 级沙箱 (spec §6)
// Phase 4a: Windows Job Object — die-with-parent 进程生命周期管理。
//   AppContainer (Phase 4b) 已移除 — 它与通用
//   开发工具链冲突，后者会生成深层进程树从不可预测的
//   路径加载 DLL。文件系统和网络隔离由权限引擎处理。
// Phase 5: macOS sandbox-exec + Linux bubblewrap (spec §6.4–§6.7)
// ponytail: 纯 Win32 FFI + 平台工具，零新增 crate 依赖。

use std::io::{self, Read};
use std::process::ExitStatus;
use std::time::Duration;

// ═══════════════════════════════════════════════════════════════
// 进程启动重试 — 瞬态 fork/spawn 错误会重试
// ═══════════════════════════════════════════════════════════════

// ponytail: spawn 重试仅用于非 Windows 平台（Linux seccomp、
// macOS sandbox-exec）。在 Windows 上，Job Object 以不同方式处理。
#[cfg_attr(windows, allow(dead_code))]
const SPAWN_RETRY_COUNT: u32 = 3;
#[cfg_attr(windows, allow(dead_code))]
const SPAWN_RETRY_BASE_DELAY: Duration = Duration::from_millis(200);

/// 在瞬态错误（EAGAIN、ENOMEM 等）时重试进程启动。
/// 返回第一个不可重试的错误或最后一个可重试的错误。
#[cfg_attr(windows, allow(dead_code))]
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

/// 检查原始 OS 错误是否为瞬态启动失败。
/// Unix 上 EAGAIN (11)、ENOMEM (12)；Windows 上 ERROR_NO_SYSTEM_RESOURCES (1450)。
#[cfg_attr(windows, allow(dead_code))]
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
// 跨平台公共 API
// ═══════════════════════════════════════════════════════════════

/// 沙箱可用性状态，用于 UI/警告显示 (spec §6.6–§6.7)。
#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum SandboxStatus {
    /// 完整沙箱已激活（Windows 上为 Job Object）。
    Available,
    /// 不可用 — 无 OS 沙箱（权限引擎作为回退）。
    Unavailable,
}

/// 沙箱化进程句柄 — 包装 std::process::Child，
/// 已分配到 Job Object（Windows）或普通启动（其他平台）。
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

    /// 终止整个进程树。Windows 用 taskkill /F /T 递归终止
    /// (bash/cmd → cargo → rustc/test 多层子进程),其他平台 kill 直接子进程。
    /// 只 kill 直接子进程会留下僵尸孙进程,继续占用 target 锁或管道。
    pub fn kill_tree(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            let pid = self.inner.id();
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
            Ok(())
        }
        #[cfg(not(windows))]
        {
            self.inner.kill()
        }
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
// 公共函数
// ═══════════════════════════════════════════════════════════════

/// 一次性初始化 — 在应用启动时调用。创建 Job Object (Windows)。
/// 在 Linux 上，检查 bubblewrap 可用性并记录状态。
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

/// 查询当前沙箱状态用于 UI 显示 (spec §6.6)。
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

/// 在沙箱中启动 shell 命令。在 Windows 上，将进程
/// 分配到 Job Object 以实现 die-with-parent 生命周期管理。
/// 在 macOS 上使用 sandbox-exec；在 Linux 上使用 bubblewrap。
/// 当 OS 沙箱工具不可用时回退到普通启动。
pub fn spawn_shell(command: &str, cwd: &str) -> io::Result<SandboxedChild> {
    #[cfg(windows)]
    {
        // 固定解释器策略（对齐 kimi-code / hermes-agent）：
        // - 探测到 Git Bash → 一律用 bash，spawn 失败直接报错，不静默回退 cmd
        //   （静默回退会让 Agent 猜不到命令跑在哪个解释器上，语法必踩坑）
        // - 探测结果就是 Cmd（本机无 Git Bash）→ 用 cmd，但 shell_env() 会
        //   显式上报，前端注入 Agent system prompt 声明 shell=cmd
        //
        // 命令传递策略（2026-08：修复"转译问题/斜杠问题"）：
        // - Bash：命令串原样经 Command::arg 传给 bash -c（不经 split_cmdline 分词，
        //   也不做任何包裹）— 模型写的 $VAR / $(...) / 引号嵌套由 bash 正常解析。
        //   此前整体单引号包裹把 $、$()、` 全部变成字面量，模型写什么都"不生效"。
        // - Cmd：命令写入临时 .cmd 文件再执行 — cmd /s /c 的引号剥离规则对内嵌
        //   双引号必错乱，批处理文件免疫一切 cmd 引号/展开问题。
        match imp::detect_shell() {
            imp::Shell::Bash(ref bash_path) => imp::spawn_bash(bash_path, command, cwd),
            imp::Shell::Cmd => {
                eprintln!(
                    "[hologram] no Git Bash detected — shell=cmd (Agent environment block will declare this)"
                );
                imp::spawn_cmd_script(command, cwd)
            }
        }
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

/// 当前 shell 环境信息 — 供前端注入 Agent system prompt。
/// Agent 第一轮就知道命令跑在哪个解释器上，从源头消灭"猜语法"类错误。
pub fn shell_env() -> serde_json::Value {
    #[cfg(windows)]
    {
        match imp::detect_shell() {
            imp::Shell::Bash(path) => serde_json::json!({
                "os": "windows",
                "shell": "bash",
                "shell_path": path,
                "notes": "命令跑在 Git Bash (bash) 上，用 Unix 语法：$VAR / $(...) / 引号嵌套正常解析；路径用正斜杠（/c/Users/... 或相对路径），D:\\foo 这种反斜杠路径在 bash 内建命令里不可靠；MSYS 路径自动转换已关闭，/ 开头的参数按字面传给程序"
            }),
            imp::Shell::Cmd => serde_json::json!({
                "os": "windows",
                "shell": "cmd",
                "shell_path": "",
                "notes": "未检测到 Git Bash，命令跑在 cmd.exe 上：用 %var% 而非 $var，用 dir 而非 ls"
            }),
        }
    }
    #[cfg(target_os = "macos")]
    {
        serde_json::json!({
            "os": "macos",
            "shell": "bash",
            "shell_path": "/bin/bash",
            "notes": "命令跑在 bash 上，用 Unix 语法"
        })
    }
    #[cfg(target_os = "linux")]
    {
        serde_json::json!({
            "os": "linux",
            "shell": "bash",
            "shell_path": "/bin/bash",
            "notes": "命令跑在 bash 上，用 Unix 语法"
        })
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        serde_json::json!({
            "os": "unknown",
            "shell": "unknown",
            "shell_path": "",
            "notes": ""
        })
    }
}

/// 无沙箱包装的普通 shell 启动 — 在 OS 沙箱不可用时
/// 作为回退使用 (spec §6.7)。对瞬态 fork 错误进行重试。
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

/// 将已启动的 std::process::Child 分配到 Job Object。
/// 非沙箱化基础设施启动（LSP、MCP、Unity）使用此方法。
/// 成功返回 true，Job Object 不可用时返回 false。
pub fn assign_to_job(child: &std::process::Child) -> bool {
    #[cfg(windows)]
    { imp::job::assign(child) }
    #[cfg(not(windows))]
    { let _ = child; true }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Windows 实现 — 仅 Job Object
// ═══════════════════════════════════════════════════════════════

#[cfg(windows)]
#[allow(dead_code)]
pub mod imp {
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::sync::OnceLock;

    use super::SandboxStatus;

    // ── FFI 声明 ──

    extern "system" {
                // Job Object
        fn CreateJobObjectW(attrs: *mut std::ffi::c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(
            job: isize, info_class: i32, info: *const std::ffi::c_void, info_len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
        // 管道创建
        fn CreatePipe(
            read: *mut isize, write: *mut isize,
            attrs: *mut std::ffi::c_void, size: u32,
        ) -> i32;
        fn SetHandleInformation(handle: isize, mask: u32, flags: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    // ── 常量 ──

    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const HANDLE_FLAG_INHERIT: u32 = 1;

    // Job Object 限制
    const JOB_OBJECT_LIMIT_DIE_ON_JOB_CLOSE: u32 = 0x00002000;
    const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x00000800;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x00000008;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: u32 = 0x00000200;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    // ── FFI 结构体 ──

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

    // ── Shell 检测 ──

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

    /// 冒烟测试：启动 `bash -c "exit 0"` 验证 bash 是否实际可用。
    /// 必须带超时:若 bash 启动后卡住(如 BASH_ENV 指向卡住的初始化脚本、
    /// 杀毒拦截、bash 状态损坏),wait() 会永久阻塞。而 detect_shell() 是
    /// OnceLock::get_or_init,冒烟测试卡住 = 整个 shell 子系统全局锁死,
    /// 之后所有 shell 命令(前台/后台)全部无限等待。
    fn smoke_test_bash(bash_path: &str) -> bool {
        match spawn_bash(bash_path, "exit 0", ".") {
            Ok(mut child) => {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => return status.success(),
                        Ok(None) => {
                            if std::time::Instant::now() >= deadline {
                                let _ = child.kill();
                                return false;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                        Err(_) => return false,
                    }
                }
            }
            Err(_) => false,
        }
    }

    pub fn detect_shell() -> Shell {
        DETECTED_SHELL.get_or_init(detect_shell_inner).clone()
    }

    /// 将 Windows 路径转换为 POSIX 格式（用于 Git Bash）。
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

    // ── 沙箱状态 ──

    pub fn status() -> SandboxStatus {
        if job::is_active() {
            SandboxStatus::Available
        } else {
            SandboxStatus::Unavailable
        }
    }

    // ── 沙箱化启动（仅 Job Object）──

    /// 启动 shell 命令并分配到 Job Object。
    /// 使用不可继承的 stdout/stderr 管道，使孙进程
    /// （如 bash 启动的 cargo test 二进制）不能在直接子进程
    /// 退出后保持管道打开。
    pub fn spawn(cmdline: &str, cwd: &str) -> io::Result<super::SandboxedChild> {
        let (program, args) = split_cmdline(cmdline);
        spawn_argv(&program, &args, cwd, &[])
    }

    /// 以 argv 数组形式启动（不经 split_cmdline 分词/去引号）。
    /// 命令字符串作为单个参数传给解释器 — 内部 $、$(...)、引号由
    /// 解释器自行解析，此处不做任何改写（2026-08 修转义问题）。
    pub fn spawn_argv(
        program: &str,
        args: &[String],
        cwd: &str,
        envs: &[(&str, &str)],
    ) -> io::Result<super::SandboxedChild> {
        use std::os::windows::io::{FromRawHandle, OwnedHandle, RawHandle};
        // 创建 stdout/stderr 管道，子端标记为不可继承。
        // 这防止子进程（cargo → test 二进制）持有
        // 管道句柄打开，导致 read_to_end 永久阻塞。
        let (stdout_read, stdout_write) = create_non_inheritable_pipe()?;
        let (stderr_read, stderr_write) = create_non_inheritable_pipe()?;

        let mut c = std::process::Command::new(program);
        c.args(args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(stdout_write)
            .stderr(stderr_write)
            .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
        for (k, v) in envs {
            c.env(k, v);
        }
        let mut child = c.spawn()?;

        // 用我们的读取句柄替换子进程的 stdout/stderr。
        // Command::spawn 在使用自定义 Stdio 时会将 stdout/stderr 留为 None。
        child.stdout = Some(unsafe {
            std::process::ChildStdout::from(OwnedHandle::from_raw_handle(
                stdout_read as RawHandle,
            ))
        });
        child.stderr = Some(unsafe {
            std::process::ChildStderr::from(OwnedHandle::from_raw_handle(
                stderr_read as RawHandle,
            ))
        });

        job::assign(&child);
        Ok(super::SandboxedChild { inner: child })
    }

    /// Git Bash：`bash -c <command>` — 命令串原样传参，bash 自行解析
    /// $VAR / $(...) / 引号嵌套。设 MSYS2_ARG_CONV_EXCL='*' 关闭 MSYS
    /// 参数路径自动转换（否则 /src/main.ts 会被改写成
    /// C:\Program Files\Git\src\main.ts，正斜杠参数必错）。
    pub fn spawn_bash(bash_path: &str, command: &str, cwd: &str) -> io::Result<super::SandboxedChild> {
        let arg = command.to_string();
        spawn_argv(bash_path, &[String::from("-c"), arg], cwd, &[("MSYS2_ARG_CONV_EXCL", "*")])
    }

    /// cmd.exe：命令写入临时 .cmd 批处理文件再执行 —
    /// cmd /s /c 对内嵌双引号的剥离规则必错乱（如
    /// git commit -m "msg"），批处理文件免疫全部 cmd 引号/展开问题。
    /// spawn 返回时 cmd 可能仍持有句柄，3 秒后尽力删除（失败无害，留在 temp）。
    pub fn spawn_cmd_script(command: &str, cwd: &str) -> io::Result<super::SandboxedChild> {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SCRIPT_SEQ: AtomicU32 = AtomicU32::new(0);
        let script_name = format!(
            "hologram_cmd_{}_{}.cmd",
            std::process::id(),
            SCRIPT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let script_path = std::env::temp_dir().join(script_name);
        // CRLF 必需 — cmd 对纯 LF 批处理文件的部分语法解析异常。
        let script = format!("@echo off\r\n{}\r\nexit /b %errorlevel%\r\n", command);
        std::fs::write(&script_path, script)?;
        let path_arg = script_path.to_string_lossy().to_string();
        // /c 后跟批处理路径；cmd 用 /d 跳过 AutoRun 注册表项，行为更可预期。
        let child = spawn_argv("cmd.exe", &[String::from("/d"), String::from("/c"), path_arg], cwd, &[])?;
        // 延迟清理：cmd /c 秒级执行完即释放句柄，3 秒后删除足够安全。
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let _ = std::fs::remove_file(&script_path);
        });
        Ok(child)
    }

    /// 创建一个管道，子端（写入端）标记为不可继承。
    /// 返回 (parent_read_handle, child_write_as_stdio)。
    fn create_non_inheritable_pipe() -> io::Result<(isize, std::process::Stdio)> {
        use std::os::windows::io::{FromRawHandle, RawHandle};
        let mut read: isize = 0;
        let mut write: isize = 0;
        let ret = unsafe {
            CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0)
        };
        if ret == 0 {
            return Err(io::Error::last_os_error());
        }
        // 将子端写入句柄标记为不可继承。
        // read（父端）句柄保持可继承，使 Rust 能管理它。
        let ret = unsafe {
            SetHandleInformation(write, HANDLE_FLAG_INHERIT, 0)
        };
        if ret == 0 {
            unsafe {
                CloseHandle(read);
                CloseHandle(write);
            }
            return Err(io::Error::last_os_error());
        }
        // 将写入句柄转换为 Stdio — 由 Command::stdout/stderr 消费
        let child_stdio = unsafe {
            std::process::Stdio::from_raw_handle(write as RawHandle)
        };
        Ok((read, child_stdio))
    }

    // ── 命令行辅助函数 ──

    /// 将 "bash" -c '...' 拆分为 ("bash", ["-c", "..."])。
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

    /// 去掉一层匹配的引号。
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

    // ── 测试 ──

    #[cfg(test)]
    mod tests {
        use super::{detect_shell, spawn_bash, spawn_cmd_script, windows_to_posix_path, Shell};

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

        /// 大输出管道对照实验：同一命令 `seq 1 5000`（约 25KB 输出），
        /// 分别走手工管道（spawn_shell / CreatePipe）和标准库 Stdio::piped()。
        /// 用于定位"大输出后台任务卡死"根因 —— 手工管道 vs 标准库实现。
        /// 只输出诊断信息，不 assert（避免测试本身卡死 / 平台差异误报）。
        #[test]
        #[cfg(windows)]
        fn test_compare_handmade_pipe_vs_std_piped_large_output() {
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let bash_path = match detect_shell() {
                Shell::Bash(ref p) => p.clone(),
                Shell::Cmd => {
                    eprintln!("[pipe-compare] no bash detected, skip");
                    return;
                }
            };

            // ── 方式 A: 手工管道（spawn_shell → imp::spawn → CreatePipe） ──
            let mut child_a = super::super::spawn_shell("seq 1 5000", ".").expect("spawn_shell failed");
            let mut reader_a = child_a.take_stdout().expect("take_stdout failed");
            let (tx_a, rx_a) = mpsc::channel();
            std::thread::spawn(move || {
                let mut v = Vec::new();
                let _ = std::io::Read::read_to_end(&mut reader_a, &mut v);
                let _ = tx_a.send(v.len());
            });
            let a_start = Instant::now();
            let a_bytes = rx_a.recv_timeout(Duration::from_secs(5));
            let a_elapsed = a_start.elapsed();
            child_a.kill_tree().ok();

            // ── 方式 B: 标准库 Stdio::piped() ──
            let mut child_b = std::process::Command::new(&bash_path)
                .arg("-c")
                .arg("seq 1 5000")
                .current_dir(".")
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("std spawn failed");
            let mut reader_b = child_b.stdout.take().expect("std stdout failed");
            let (tx_b, rx_b) = mpsc::channel();
            std::thread::spawn(move || {
                let mut v = Vec::new();
                let _ = std::io::Read::read_to_end(&mut reader_b, &mut v);
                let _ = tx_b.send(v.len());
            });
            let b_start = Instant::now();
            let b_bytes = rx_b.recv_timeout(Duration::from_secs(5));
            let b_elapsed = b_start.elapsed();
            let _ = child_b.kill();

            eprintln!("[pipe-compare] handmade: {:?} bytes in {:?} (Err=超时卡住)", a_bytes, a_elapsed);
            eprintln!("[pipe-compare] std-piped: {:?} bytes in {:?} (Err=超时卡住)", b_bytes, b_elapsed);
        }

        /// 完整后台链路复现：spawn_bg → drain 线程 → read_bg_output / wait_bg。
        /// 复现 Agent 跑 `seq 1 5000`（大输出后台任务）的卡死现场。
        /// 只输出诊断，不 assert（避免测试卡死）。
        #[test]
        #[cfg(windows)]
        fn test_repro_background_large_output_chain() {
            use std::time::{Duration, Instant};

            // spawn_bg 需要 os_sandbox::init() 的 Job Object? 不需要 — spawn_bg 内部调 spawn_shell
            let id = match crate::utils::spawn_bg("seq 1 5000", ".", None, None) {
                Ok(id) => id,
                Err(e) => {
                    eprintln!("[bg-repro] spawn_bg failed: {e}");
                    return;
                }
            };
            eprintln!("[bg-repro] spawned job {id}");

            // 等 2 秒让任务跑完（seq 5000 行应 <1s）
            std::thread::sleep(Duration::from_secs(2));

            // read_bg_output — 之前卡死的地方
            let t0 = Instant::now();
            let out = crate::utils::read_bg_output(id);
            let read_elapsed = t0.elapsed();
            match &out {
                Ok(s) => {
                    let lines = s.lines().count();
                    let has_marker = s.contains("1040") || s.contains("5000");
                    eprintln!("[bg-repro] read_bg_output OK in {read_elapsed:?}, {} lines, has_5k={}", lines, s.contains("5000"));
                    eprintln!("[bg-repro] last lines: {:?}", s.lines().rev().take(3).collect::<Vec<_>>());
                    let _ = has_marker;
                }
                Err(e) => eprintln!("[bg-repro] read_bg_output Err: {e}"),
            }

            // 如果还在运行,试 wait_bg 等 5 秒
            if let Ok(s) = &out {
                if s.contains("任务运行中") {
                    let t1 = Instant::now();
                    let w = crate::utils::wait_bg(id, 5000);
                    eprintln!("[bg-repro] wait_bg in {:?}: {:?}", t1.elapsed(), w.as_ref().map(|x| x.lines().count()));
                }
            }
        }

        /// 循环 read 诊断：区分 Err 与 Ok(0)，Err 不退出线程。
        /// 判定"循环 read 卡 4KB"真凶是否 = 旧代码的 `Err(_) => break`。
        /// 若 Err 不退出能读完 5000 行 → 元凶是 Err 中断线程,而非循环本身。
        #[test]
        #[cfg(windows)]
        fn test_loop_read_err_does_not_kill_drain() {
            use std::io::Read;
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let mut child = super::super::spawn_shell("seq 1 5000", ".")
                .expect("spawn_shell failed");
            let mut reader = child.take_stdout().expect("take_stdout failed");
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let mut total = 0usize;
                let mut err_count = 0usize;
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) => break, // EOF — 正常结束
                        Ok(n) => {
                            total += n;
                            // 打印关键节点:首次读、4KB 边界、之后每 2KB
                            if total <= 4096 || total % 2048 < 4096 {
                                eprintln!("[loop-read] read n={n}, total={total}");
                            }
                        }
                        Err(e) => {
                            // 关键诊断：Err 不退出,继续读
                            err_count += 1;
                            eprintln!("[loop-read] read Err #{err_count}: {e:?}");
                            if err_count > 5 { break; } // 保险丝,防无限刷屏
                        }
                    }
                }
                let _ = tx.send((total, err_count));
            });
            let t0 = Instant::now();
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok((total, err_count)) => {
                    eprintln!("[loop-read] DONE in {:?}: total={total} bytes, err_count={err_count} (期望 total≈23893, err_count=0)", t0.elapsed());
                }
                Err(_) => {
                    eprintln!("[loop-read] TIMEOUT 5s — 循环 read 卡住了! child.kill_tree");
                    child.kill_tree().ok();
                }
            }
        }

        /// 决定实验：read_vectored 能否边读边 emit 且不卡 4KB 边界。
        /// read_to_end 内部走 read_buf/read_vectored 路径(证据:读满 23893 字节);
        /// read() 第二次调用永久阻塞(证据:上一条测试)。流式实时输出需要
        /// 逐块读取 — 若 read_vectored 可行,则流式路径用它替代 read。
        #[test]
        #[cfg(windows)]
        fn test_read_vectored_loop_for_streaming() {
            use std::io::{IoSliceMut, Read};
            use std::sync::mpsc;
            use std::time::{Duration, Instant};

            let mut child = super::super::spawn_shell("seq 1 5000", ".")
                .expect("spawn_shell failed");
            let mut reader = child.take_stdout().expect("take_stdout failed");
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let mut total = 0usize;
                let mut err_count = 0usize;
                let mut chunk = [0u8; 4096];
                let mut iov = [IoSliceMut::new(&mut chunk)];
                loop {
                    match reader.read_vectored(&mut iov) {
                        Ok(0) => break,
                        Ok(n) => {
                            total += n;
                            if total <= 4096 || total % 2048 < 4096 {
                                eprintln!("[vec-read] read_vectored n={n}, total={total}");
                            }
                        }
                        Err(e) => {
                            err_count += 1;
                            eprintln!("[vec-read] read_vectored Err #{err_count}: {e:?}");
                            if err_count > 5 { break; }
                        }
                    }
                }
                let _ = tx.send((total, err_count));
            });
            let t0 = Instant::now();
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok((total, err_count)) => {
                    eprintln!("[vec-read] DONE in {:?}: total={total} bytes, err_count={err_count}", t0.elapsed());
                }
                Err(_) => {
                    eprintln!("[vec-read] TIMEOUT 5s — read_vectored 也卡住! child.kill_tree");
                    child.kill_tree().ok();
                }
            }
        }

        fn run_and_capture(child: &mut super::super::SandboxedChild) -> String {
            use std::io::Read;
            let mut out = String::new();
            if let Some(mut r) = child.take_stdout() {
                let _ = r.read_to_string(&mut out);
            }
            let _ = child.wait();
            out
        }

        /// 回归 2026-08：整体单引号包裹曾使 $() / $VAR / 引号嵌套全部失效。
        /// 修复后命令原样传给 bash -c，bash 语义完整保留。
        #[test]
        #[cfg(windows)]
        fn test_bash_expansion_semantics() {
            match detect_shell() {
                Shell::Bash(path) => {
                    let mut child = spawn_bash(&path, "echo \"x=$(echo hi) y=$((2+3))\"", ".")
                        .expect("spawn_bash");
                    let out = run_and_capture(&mut child);
                    assert!(
                        out.contains("x=hi y=5"),
                        "子 shell/算术展开失效（转译问题回归）: {out:?}"
                    );

                    let mut child2 = spawn_bash(&path, "printf '%s\\n' \"a b\"", ".")
                        .expect("spawn_bash");
                    let out2 = run_and_capture(&mut child2);
                    assert_eq!(out2.trim(), "a b", "引号嵌套失效: {out2:?}");
                }
                Shell::Cmd => eprintln!("[bash-semantics] no Git Bash, skip"),
            }
        }

        /// 回归 2026-08：cmd /s /c 对内嵌双引号的剥离规则必错乱 —
        /// 改为临时 .cmd 文件执行后，引号与 & 分隔命令都按 cmd 语义正常。
        #[test]
        #[cfg(windows)]
        fn test_cmd_script_quoting() {
            use std::sync::mpsc;
            use std::time::{Duration, Instant};
            let mut child = spawn_cmd_script("echo \"a b\"&echo two", ".").expect("spawn_cmd_script");
            let mut reader = child.take_stdout().expect("take_stdout failed");
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let mut v = Vec::new();
                use std::io::Read;
                let _ = reader.read_to_end(&mut v);
                let _ = tx.send(v);
            });
            let t0 = Instant::now();
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(v) => {
                    let out = String::from_utf8_lossy(&v);
                    eprintln!("[cmd-script] output: {out:?} in {:?}", t0.elapsed());
                    assert!(out.contains("a b"), "cmd 脚本引号失效: {out:?}");
                    assert!(out.contains("two"), "cmd 脚本 & 分隔失效: {out:?}");
                }
                Err(_) => {
                    eprintln!("[cmd-script] TIMEOUT 5s — cmd 未退出或未输出! kill_tree");
                    child.kill_tree().ok();
                    let _ = child.wait();
                    panic!("cmd 脚本执行卡住");
                }
            }
            let _ = child.wait();
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// macOS 实现 — sandbox-exec (spec §6.4)
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
        // 用 ulimit 包裹以限制资源（8 GiB VM, 300s CPU）
        let limited_cmd = format!(
            "ulimit -v {} -t {} && exec {}",
            8 * 1024 * 1024, // 8 GiB（以 KiB 为单位）
            300,             // 300秒 CPU 时间
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
// Linux 实现 — bubblewrap (spec §6.5)
// ═══════════════════════════════════════════════════════════════

#[cfg(target_os = "linux")]
mod linux {
    use std::io;
    use std::path::{Path, PathBuf};

    use super::{SandboxStatus, SandboxedChild};

    /// 检查 bwrap 二进制是否在 PATH 中可用。
    fn bwrap_path() -> Option<PathBuf> {
        // 先检查常见位置（比 `which` 更快）
        let candidates = [
            "/usr/bin/bwrap",
            "/usr/local/bin/bwrap",
        ];
        for c in &candidates {
            if Path::new(c).exists() {
                return Some(PathBuf::from(c));
            }
        }
        // 回退到 PATH 查找
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

        // 收集 home 目录用于只读绑定（需要 ~/.cargo, ~/.rustup, ~/.nvm 等）
        let home = std::env::var("HOME").unwrap_or_default();

        // 用资源限制包裹命令：8 GiB 虚拟内存，300s CPU 时间。
        // ulimit -v 限制地址空间（栈+堆+mmap），可捕获大多数失控
        // 进程，无需 cgroup 或 systemd-run。超限时 SIGKILL。
        let limited_cmd = format!(
            "ulimit -v {} -t {} && exec {}",
            8 * 1024 * 1024, // 8 GiB（以 KiB 为单位）
            300,             // 300秒 CPU 时间
            command
        );

        let mut cmd = std::process::Command::new(&bwrap);

        // 只读系统路径
        for (src, dst) in &ro_binds {
            cmd.arg("--ro-bind").arg(src).arg(dst);
        }

        // 只读 home 目录（开发工具链需要读取 ~/.cargo, ~/.nvm, ~/.rustup）
        if !home.is_empty() && Path::new(&home).exists() {
            cmd.arg("--ro-bind").arg(&home).arg(&home);
        }

        // 读写：项目目录和临时目录
        cmd.arg("--bind").arg(cwd).arg(cwd);
        cmd.arg("--bind").arg(temp.as_os_str()).arg("/tmp");

        // 进程生命周期：随父进程退出
        cmd.arg("--die-with-parent");

        // 允许新命名空间（嵌套进程启动需要）
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
            ("/dev", "/dev"), // PTY, /dev/null 等需要
        ];
        candidates
            .iter()
            .filter(|(src, _)| Path::new(src).exists())
            .copied()
            .collect()
    }
}