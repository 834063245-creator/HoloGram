// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 共享工具函数。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tracing_appender::non_blocking::WorkerGuard;
use hologram_engine as engine;
use engine::engine as engine_api;
use engine::graph::Graph;
use engine::storage::MemoryIndex;
use crate::os_sandbox;
use crate::workspace;
use crate::permissions;
use crate::permissions::{PermissionContext, PermissionDecision, has_permission_to_use_tool, register_ask};
use crate::tools;
use engine::community::detect_hierarchical_communities_with_base;
use engine::routing::preflight::save_baseline;
#[cfg(windows)] use std::os::windows::process::CommandExt;
#[cfg(windows)] pub(crate) const NO_WINDOW: u32 = 0x08000000;

// ═══════════════════════════════════════════════════════
// 后台任务系统 — 超时 + 后台 + 输出 + 终止
// ═══════════════════════════════════════════════════════

/// 共享输出缓冲区 — 用于流式→后台转换。
/// 流式 exec_command 的 stdout/stderr 被独立线程持有
/// (child.take_stdout 已移走管道)，线程写入此 Arc 的同时
/// 也发出 Tauri shell:output 事件。转后台时 bg job 从这里读，
/// 而非 child.stdout_reader()(后者返回 None)。
#[derive(Clone)]
pub(crate) struct BgSharedOutput {
    pub stdout: Arc<Mutex<Vec<u8>>>,
    pub stderr: Arc<Mutex<Vec<u8>>>,
}

pub(crate) struct BgJob {
    pub(crate) child: os_sandbox::SandboxedChild,
    stdout_buf: Vec<u8>,
    stderr_buf: Vec<u8>,
    start_time: std::time::Instant,
    #[allow(dead_code)] // 存储供未来任务列表功能使用
    label: String,
    last_output_time: std::time::Instant,
    /// 流式→后台转换：输出管道由独立线程持有，从此 Arc 读取。
    shared: Option<BgSharedOutput>,
}

pub(crate) static BG_JOBS: std::sync::LazyLock<Arc<Mutex<HashMap<u32, BgJob>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 通知队列 — 由 agent 在每次 stream() 调用前清空。
pub(crate) static COMPLETED_NOTES: std::sync::LazyLock<Mutex<Vec<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

static NEXT_JOB_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// 将通知消息推入后台通知队列。
pub(crate) fn push_bg_note(msg: &str) {
    COMPLETED_NOTES.lock().unwrap().push(msg.to_string());
}

/// 排空并返回所有待处理的后台通知（同时清空队列）。
pub(crate) fn drain_bg_notifications() -> String {
    let mut notes = COMPLETED_NOTES.lock().unwrap();
    if notes.is_empty() {
        return String::new();
    }
    let result = notes.join("\n");
    notes.clear();
    result
}

/// 停滞检测阈值 — 超过此时长无输出则触发警告。
const STALL_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(300);

/// 启动监控线程，每秒轮询子进程状态。
/// 进程退出时：向 COMPLETED_NOTES 推送完成通知。
/// 停滞时（超过 STALL_THRESHOLD 无输出）：推送停滞警告并重置计时器。
fn spawn_monitor(id: u32, label: String) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));

            let mut jobs = BG_JOBS.lock().unwrap();
            let job = match jobs.get_mut(&id) {
                Some(j) => j,
                None => return, // 任务已被 read_bg_output / kill_bg 移除
            };

            match job.child.try_wait() {
                Ok(Some(status)) => {
                    let elapsed = job.start_time.elapsed().as_secs();
                    let ec = status.code().unwrap_or(-1);
                    let msg = format!(
                        "后台任务已完成: {} (exit code: {}, 耗时: {}s)。使用 bash_output({}) 查看输出。",
                        label, ec, elapsed, id
                    );
                    COMPLETED_NOTES.lock().unwrap().push(msg);
                    return; // 不移除 — read_bg_output 会在 agent 检查时清理
                }
                Ok(None) => {
                    let stall_elapsed = job.last_output_time.elapsed();
                    if stall_elapsed > STALL_THRESHOLD {
                        let msg = format!(
                            "⚠️ 后台任务可能已停滞: {} 已 {}s 无输出 (job_id: {})。考虑用 bash_output({}) 检查或 bash_kill({}) 终止。",
                            label, stall_elapsed.as_secs(), id, id, id
                        );
                        COMPLETED_NOTES.lock().unwrap().push(msg);
                        job.last_output_time = std::time::Instant::now(); // 重置以避免重复警告
                    }
                }
                Err(_) => return,
            }
        }
    });
}

/// 日志守护 — 在首次打开项目时初始化一次，在整个进程生命周期内持有。
pub(crate) static LOG_GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();

pub(crate) fn spawn_bg(cmd: &str, cwd: &str) -> Result<u32, String> {
    let child = os_sandbox::spawn_shell(cmd, cwd)
        .map_err(|e| format!("无法启动后台命令: {e}"))?;
    let label: String = cmd.chars().take(80).collect();
    spawn_bg_from_child(child, &label)
}

/// 将已启动的 SandboxedChild 注册为后台任务。
/// 用于前台超时路径，将超时命令转为后台任务。
///
/// 必须 take 管道并用 drain 线程排空到 shared Arc:
///  1) std 管道是阻塞模式且缓冲极小(Windows 匿名管道默认 4KB),后台任务
///     (cargo build/test 等)输出一多就塞满管道 → bash 写阻塞 → 命令假死;
///  2) read_bg_output 的 shared 分支只读 Arc 内存,永不阻塞;若 shared=None
///     会走阻塞读管道分支,任务运行中无输出时永久卡死并占住 BG_JOBS 锁,
///     连锁导致 bash_output/bash_wait 全部无限等待。
pub(crate) fn spawn_bg_from_child(child: os_sandbox::SandboxedChild, label: &str) -> Result<u32, String> {
    let id = NEXT_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let now = std::time::Instant::now();
    let mut child = child;

    // 排空 stdout/stderr 到 shared Arc — drain 线程自己阻塞无妨,
    // 读方(wait_bg/read_bg_output/kill_bg)只碰 Arc,永远不会卡。
    // 必须用 read_vectored 循环:裸 read() 在此手工管道上第二次调用会永久阻塞
    // (复现测试证实,卡 Windows 管道 4KB 边界);read_to_end 能读完但憋到 EOF,
    // 长任务运行中 bash_output 读不到增量。read_vectored 逐块可靠(191ms/23KB 实测)。
    let stdout_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>> = Default::default();
    let stderr_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>> = Default::default();
    if let Some(mut reader) = child.take_stdout() {
        let buf = std::sync::Arc::clone(&stdout_buf);
        std::thread::spawn(move || {
            use std::io::{IoSliceMut, Read};
            let mut chunk = [0u8; 4096];
            loop {
                let n = {
                    let mut iov = [IoSliceMut::new(&mut chunk)];
                    match reader.read_vectored(&mut iov) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    }
                };
                buf.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });
    }
    if let Some(mut reader) = child.take_stderr() {
        let buf = std::sync::Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            use std::io::{IoSliceMut, Read};
            let mut chunk = [0u8; 4096];
            loop {
                let n = {
                    let mut iov = [IoSliceMut::new(&mut chunk)];
                    match reader.read_vectored(&mut iov) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    }
                };
                buf.lock().unwrap().extend_from_slice(&chunk[..n]);
            }
        });
    }

    let job = BgJob {
        child,
        stdout_buf: Vec::new(),
        stderr_buf: Vec::new(),
        start_time: now,
        label: label.to_string(),
        last_output_time: now,
        shared: Some(BgSharedOutput { stdout: stdout_buf, stderr: stderr_buf }),
    };
    BG_JOBS.lock().unwrap().insert(id, job);
    spawn_monitor(id, label.to_string());
    Ok(id)
}

/// 将已启动的 SandboxedChild 注册为后台任务，附共享输出缓冲区。
/// 用于流式 exec_command 超时路径：stdout/stderr 管道已被独立线程
/// take 走，bg job 从 shared.stdout / shared.stderr Arc 读取输出。
pub(crate) fn spawn_bg_from_child_shared(
    child: os_sandbox::SandboxedChild,
    label: &str,
    shared: BgSharedOutput,
) -> Result<u32, String> {
    let id = NEXT_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let now = std::time::Instant::now();
    let job = BgJob {
        child,
        stdout_buf: Vec::new(),
        stderr_buf: Vec::new(),
        start_time: now,
        label: label.to_string(),
        last_output_time: now,
        shared: Some(shared),
    };
    BG_JOBS.lock().unwrap().insert(id, job);
    spawn_monitor(id, label.to_string());
    Ok(id)
}

pub(crate) fn read_bg_output(id: u32) -> Result<String, String> {
    let mut jobs = BG_JOBS.lock().unwrap();
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;

    // ── 流式→后台路径: 从共享 Arc 读取(管道被独立线程持有) ──
    let (stdout_str, stderr_str, new_output) = if let Some(ref shared) = job.shared {
        let so = shared.stdout.lock().unwrap();
        let se = shared.stderr.lock().unwrap();
        let has_new = so.len() > job.stdout_buf.len() || se.len() > job.stderr_buf.len();
        let s = String::from_utf8_lossy(&so).to_string();
        let t = String::from_utf8_lossy(&se).to_string();
        job.stdout_buf = so.clone();
        job.stderr_buf = se.clone();
        (s, t, has_new)
    } else {
        // ── 常规后台路径: 从 child stdout/stderr 管道读取 ──
        let mut new_output = false;
        if let Some(stdout) = job.child.stdout_reader() {
            let mut buf = [0u8; 4096];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { job.stdout_buf.extend_from_slice(&buf[..n]); new_output = true; }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => break,
                }
            }
        }
        if let Some(stderr) = job.child.stderr_reader() {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { job.stderr_buf.extend_from_slice(&buf[..n]); new_output = true; }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => break,
                }
            }
        }
        let s = String::from_utf8_lossy(&job.stdout_buf).to_string();
        let t = String::from_utf8_lossy(&job.stderr_buf).to_string();
        (s, t, new_output)
    };

    if new_output {
        job.last_output_time = std::time::Instant::now();
    }
    let elapsed = job.start_time.elapsed().as_secs();
    let status = job.child.try_wait().map_err(|e| format!("检查进程状态失败: {e}"))?;
    let info = if let Some(ec) = status {
        let msg = format!("[任务已完成, exit code: {}, 耗时: {}s]\n", ec, elapsed);
        jobs.remove(&id);
        msg
    } else {
        format!("[任务运行中, 已运行: {}s]\n", elapsed)
    };
    Ok(format!("{info}{stdout_str}{stderr_str}"))
}

/// 阻塞等待后台任务完成（或超时）。返回完整输出和退出码。
/// 与 read_bg_output（非阻塞快照）不同，此函数会等待完成后清理资源。
pub(crate) fn wait_bg(id: u32, timeout_ms: u64) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let mut jobs = BG_JOBS.lock().unwrap();
        let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
        match job.child.try_wait() {
            Ok(Some(status)) => {
                let (stdout_str, stderr_str) = if let Some(ref shared) = job.shared {
                    // 流式→后台路径: 读取共享 Arc(管道被独立线程持有)
                    let so = shared.stdout.lock().unwrap();
                    let se = shared.stderr.lock().unwrap();
                    let s = String::from_utf8_lossy(&so).to_string();
                    let t = String::from_utf8_lossy(&se).to_string();
                    (s, t)
                } else {
                    // 常规后台路径: 读取 child 管道剩余输出
                    if let Some(stdout) = job.child.stdout_reader() {
                        let mut buf = [0u8; 4096];
                        loop {
                            match stdout.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => { job.stdout_buf.extend_from_slice(&buf[..n]); }
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                                Err(_) => break,
                            }
                        }
                    }
                    if let Some(stderr) = job.child.stderr_reader() {
                        let mut buf = [0u8; 4096];
                        loop {
                            match stderr.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => { job.stderr_buf.extend_from_slice(&buf[..n]); }
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                                Err(_) => break,
                            }
                        }
                    }
                    let s = String::from_utf8_lossy(&job.stdout_buf).to_string();
                    let t = String::from_utf8_lossy(&job.stderr_buf).to_string();
                    (s, t)
                };
                let elapsed = job.start_time.elapsed().as_secs();
                let ec = status.code().unwrap_or(-1);
                jobs.remove(&id);
                let header = format!("[任务已完成, exit code: {}, 耗时: {}s]\n", ec, elapsed);
                return Ok(format!("{header}{stdout_str}{stderr_str}"));
            }
            Ok(None) => {
                drop(jobs);
                if std::time::Instant::now() >= deadline {
                    return Err(format!("等待超时 ({}ms)", timeout_ms));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => {
                jobs.remove(&id);
                return Err(format!("检查进程状态失败: {e}"));
            }
        }
    }
}

pub(crate) fn kill_bg(id: u32) -> Result<String, String> {
    let mut jobs = BG_JOBS.lock().unwrap();
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
    // 必须 kill_tree:kill() 只杀顶层 bash/cmd,残留的 cargo/rustc 孙进程会继续
    // 占用 target/ 文件锁,导致后续所有 cargo 命令无限等待锁 → "cargo test 卡死"。
    job.child.kill_tree().map_err(|e| format!("无法终止任务: {e}"))?;
    let (stdout, stderr) = if let Some(ref shared) = job.shared {
        let so = shared.stdout.lock().unwrap();
        let se = shared.stderr.lock().unwrap();
        (String::from_utf8_lossy(&so).to_string(),
         String::from_utf8_lossy(&se).to_string())
    } else {
        (String::from_utf8_lossy(&job.stdout_buf).to_string(),
         String::from_utf8_lossy(&job.stderr_buf).to_string())
    };
    jobs.remove(&id);
    Ok(format!("[任务已终止]\n{stdout}{stderr}"))
}

/// 查找 Rust 引擎可执行文件。
/// 检查顺序：1) HOLOGRAM_ENGINE 环境变量  2) engine/target/release  3) engine/target/debug
pub(crate) fn engine_binary() -> String {
    if let Ok(p) = std::env::var("HOLOGRAM_ENGINE") {
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    let root = project_root();
    let paths = [
        // 打包资源：engine.exe 放在应用二进制文件旁边
        root.join("hologram-engine.exe"),
        // 开发布局：引擎构建在 engine/target/
        root.join("engine/target/release/hologram-engine.exe"),
        root.join("engine/target/debug/hologram-engine.exe"),
    ];
    for p in &paths {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    // 回退：默认 debug 路径
    project_root().join("engine/target/debug/hologram-engine.exe")
        .to_string_lossy().to_string()
}

pub(crate) fn project_root() -> PathBuf {
    // 生产环境（已安装应用）：使用 exe 所在目录 — python/ 和 src_python/ 打包在旁边
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir_str = dir.to_string_lossy();
            // 路径中含 "target" = cargo 构建目录 → 开发模式；否则为已安装应用
            if !dir_str.contains("target") {
                return dir.to_path_buf();
            }
        }
    }
    // 开发模式：CARGO_MANIFEST_DIR 是 src-tauri/，项目根目录在上一级
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(PathBuf::from(".").as_path())
        .to_path_buf()
}

/// 设置活动工作区 — 现为空操作桩函数。请改用 workspace_activate。
/// 仅为 API 兼容性保留；前端不会直接调用此函数。

type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

/// 辅助函数：从 WorkspaceHandle 状态获取活动工作区路径。
/// 若未打开工作区则返回错误（而非静默回退到全局变量）。
pub(crate) fn workspace_path(state: &WorkspaceState) -> Result<String, String> {
    state.lock()
        .map_err(|e| format!("工作区状态错误: {e}"))?
        .as_ref()
        .map(|h| h.path.clone())
        .ok_or_else(|| "未打开工作区，请先打开项目".into())
}

/// 拒绝可能用于路径穿越的 ID。
/// 允许字母数字、连字符、下划线、点、冒号和空格。
pub(crate) fn sanitize_path_id(id: &str, label: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("{label} 不能为空"));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") || id.contains('\0') {
        return Err(format!("{label} 包含非法字符"));
    }
    Ok(())
}

/// 验证路径是否在某个项目根目录的 `.hologram` 目录内。
/// 拒绝 `..` 穿越和 hologram 工作区之外的路径。
pub(crate) fn validate_hologram_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    let canonical = std::path::Path::new(path);
    let normalized = canonical.to_string_lossy().replace('\\', "/");
    if normalized.contains("/../") || normalized.starts_with("../") || normalized.ends_with("/..") {
        return Err("路径包含目录穿越序列".into());
    }
    if !normalized.contains(".hologram") {
        return Err("路径不在 .hologram 目录范围内".into());
    }
    Ok(())
}

/// 辅助函数：获取活动 WorkspaceHandle 的引用。
#[allow(dead_code)] // ponytail: 保留用于非权限工作区访问
pub(crate) fn with_workspace<F, R>(state: &WorkspaceState, f: F) -> Result<R, String>
where
    F: FnOnce(&workspace::WorkspaceHandle) -> Result<R, String>,
{
    let guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
    let handle = guard.as_ref().ok_or("未打开工作区，请先打开项目")?;
    f(handle)
}

// ═══════════════════════════════════════════════════════
// Phase 2：权限辅助函数 — 替换旧的 with_workspace 沙箱调用

/// 从工作区状态获取 PermissionContext，并立即释放锁。
pub(crate) fn get_ctx(state: &WorkspaceState) -> Result<Arc<PermissionContext>, String> {
    let guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
    let handle = guard.as_ref().ok_or("未打开工作区，请先打开项目")?;
    Ok(handle.permission_ctx.clone())
}

/// 检查 MCP/图工具权限 — deny + ask + allow + 安全检查。
/// MCP 工具是只读的；只有明确的 deny 规则才会阻止它们。
/// 无工作区 = 无规则 = 放行（允许 hologram_status 等诊断工具通过）。
pub(crate) fn check_mcp_permission(
    tool_name: &str,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    // ponytail: 无工作区 = 无 .hologram/permissions.json = 无自定义规则，放行。
    let ctx = match get_ctx(state) {
        Ok(ctx) => ctx,
        Err(_) => return Ok(()),
    };
    let rules = ctx.read_rules();

    // ① 工具级 Deny — 最高优先级
    if let Some(rule) = rules.find_deny(tool_name, None) {
        let reason = format!("{} 工具被规则禁止使用", rule.explain());
        drop(rules);
        ctx.audit_deny(tool_name, "", &reason);
        return Err(reason);
    }

    // ② 工具级 Ask — 强制弹窗确认（此前对 MCP 工具忽略此项）
    if let Some(rule) = rules.find_ask(tool_name, None) {
        let reason = rule.explain();
        drop(rules);
        return Err(format!("{} 工具需要用户确认: {}", tool_name, reason));
    }

    // ③ 工具级 Allow — 明确允许
    if rules.find_allow(tool_name, None).is_some() {
        return Ok(());
    }

    // ④ 无规则匹配 → 放行
    Ok(())
}

/// 检查工具权限。若为 Ask，则发送事件并等待用户响应。
pub(crate) async fn check_permission(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { request_id, reason, suggestions, danger } => {
            let _ = app.emit("permission-ask", serde_json::json!({
                "requestId": request_id,
                "tool": tool.name(),
                "path": tool.get_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                "reason": reason,
                "danger": danger,
                "agentId": tool.agent_id(),
                "suggestions": suggestions.iter().map(|s| serde_json::json!({
                    "rule": s.rule,
                    "behavior": s.behavior,
                })).collect::<Vec<_>>(),
            }));
            let rx = register_ask(request_id);
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(true)) => Ok(()),
                Ok(Ok(false)) | Ok(Err(_)) => Err("用户拒绝了此操作".into()),
                Err(_) => Err("权限请求超时".into()),
            }
        }
    }
}

/// 同步检查权限（无 Await — 用于后台任务：Ask → 记录日志 + 拒绝并给出明确原因）。
pub(crate) fn check_permission_sync(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { reason, suggestions, .. } => {
            let target = tool
                .get_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            ctx.audit_deny(tool.name(), &target, &format!("后台任务无法交互，自动拒绝: {}", reason));
            let hint = match suggestions.first() {
                Some(s) => format!("\n建议在 .hologram/permissions.json 添加: \"allow\": [\"{}\"]", s.rule),
                None => String::new(),
            };
            Err(format!("后台任务需要用户确认但无法交互: {}。请将对应操作加入 allow 规则或使用前台 Agent 执行。{}", reason, hint))
        }
    }
}

pub(crate) async fn require_read(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    // 权限已授予 — 沙箱已在 check_permission 内部检查过。
    // 不再重复检查沙箱边界；用户批准的外部读取必须放行。
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}

pub(crate) async fn require_write(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::EditTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    ctx.resolve_write(&physical_str)
}

/// ponytail: 用户 UI 操作的路径解析 — 只做 forward-map + sandbox resolve,
/// 不检查权限规则. 权限系统是给 Agent 的, 用户在 UI 上的操作不受权限限制.
/// safety check 仍然保留在写路径 (防误操作系统文件).
pub(crate) fn resolve_path_user_read(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_read(&physical_str)
}

pub(crate) fn resolve_path_user_write(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_write(&physical_str)
}

/// ponytail: 根据 is_agent 标志选择路径解析方式 — Agent 走权限检查(弹 Ask), UI 只解析.
/// 前端必须发 isAgent(camelCase) 匹配 Rust 参数 is_agent; 旧的 _agent 因 Tauri 默认
/// camelCase 重命名永远对不上, 导致 agent 外部读走 user 路径被沙箱静默硬拒.
pub(crate) async fn resolve_read_dispatch(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_read(file_path, agent_id, state, app).await
    } else {
        resolve_path_user_read(file_path, state)
    }
}

pub(crate) async fn resolve_write_dispatch(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_write(file_path, agent_id, state, app).await
    } else {
        resolve_path_user_write(file_path, state)
    }
}

/// ponytail: 根据 _agent 标志选择 git 权限检查方式
pub(crate) async fn require_git_dispatch(
    repo_path: &str,
    subcommand: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    if is_agent {
        require_git(repo_path, subcommand, agent_id, state, app).await
    } else {
        Ok(())  // 用户 UI git 操作不受限制
    }
}

pub(crate) async fn require_command(command: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission(&tool, &ctx, app).await
}

pub(crate) fn require_command_sync(command: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission_sync(&tool, &ctx)
}

pub(crate) fn require_read_sync(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission_sync(&tool, &ctx)?;
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}

pub(crate) async fn require_git(repo_path: &str, subcommand: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    // Phase 3：隔离时将仓库路径前向映射到 worktree (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(repo_path), agent_id);
    let tool = tools::GitTool { repo_path: physical.to_string_lossy().to_string(), subcommand: subcommand.to_string() };
    check_permission(&tool, &ctx, app).await
}

fn cache_is_stale(root: &std::path::Path) -> bool {
    let graph_json = root.join("hologram_graph.json");
    let cache_mtime = match std::fs::metadata(&graph_json) {
        Ok(m) => match m.modified() {
            Ok(t) => t,
            Err(_) => return true, // 无法读取 mtime → 假设已过期
        },
        Err(_) => return true, // 无基线 → 已过期
    };

    const EXTS: &[&str] = &[
        ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java", ".c",
        ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".rb", ".cs", ".kt", ".kts", ".swift",
        ".php", ".lua",
    ];
    const SKIP: &[&str] = &[
        ".git", "node_modules", "target", "build", "dist", "out", ".venv", "venv",
        ".hologram", "release-bin", "__pycache__", ".pytest_cache", ".ruff_cache",
        ".mypy_cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cursor",
        ".idea", ".vscode", ".coverage",
    ];

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !SKIP.iter().any(|d| name.as_ref() == *d)
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ext_dot = format!(".{}", ext);
        if !EXTS.contains(&ext_dot.as_str()) { continue; }
        if let Ok(meta) = path.metadata() {
            if let Ok(mtime) = meta.modified() {
                if mtime > cache_mtime {
                    eprintln!(
                        "[direct_analyze] 缓存已过期: {} 在上次分析后被修改",
                        path.display()
                    );
                    return true;
                }
            }
        }
    }
    false
}

pub(crate) fn direct_analyze(path: &str, force: bool) -> Result<String, String> {
    let root = std::path::PathBuf::from(path);
    if !root.exists() {
        return Err(format!("路径不存在: {path}"));
    }

    // 初始化引擎（幂等操作 — 加载 SQLite 缓存到内存）
    engine_api::engine_init(&root)
        .map_err(|e| format!("Engine init failed: {e}"))?;

    // ponytail: 如果 SQLite 缓存已有图数据且未强制重新分析，
    // 则跳过完整流水线。冷启动约需 420s；热重载 <1s。
    // 但首先需验证缓存新鲜度 — 若任何源文件在上次分析后被修改，
    // 缓存已过期，必须重建。否则在 HoloGram 外部所做的代码修改
    // （例如在 VS Code 中跨会话修改）将静默不可见，直到用户手动点击"重新分析"。
    if !force {
        let cached_node_count = engine_api::engine_read(|idx| idx.node_count())
            .unwrap_or(0);
        if cached_node_count > 0 && !cache_is_stale(&root) {
            eprintln!("[direct_analyze] 使用缓存图 ({cached_node_count} 个节点)，跳过完整分析");
        // 在回调内从缓存序列化 — 避免克隆整个 Graph
        return engine_api::engine_read_graph(|graph| {
            let nc = graph.node_count();
            let ec = graph.edge_count();
            let nodes: Vec<serde_json::Value> = graph.nodes.values().map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "location": n.location, "in_degree": n.in_degree,
                "out_degree": n.out_degree, "properties": n.properties,
                "position": n.position, "community_id": n.community_id,
            })).collect();
            let edges: Vec<serde_json::Value> = graph.edges.values().map(|e| serde_json::json!({
                "id": e.id, "source": e.source, "target": e.target,
                "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                "cross_file": e.cross_file,
                "temporal_delay_sec": e.temporal_delay_sec,
            })).collect();
            let mut comm_map: std::collections::HashMap<usize, Vec<&str>> = std::collections::HashMap::new();
            for n in graph.nodes.values() {
                if let Some(cid) = n.community_id {
                    comm_map.entry(cid).or_default().push(&n.id);
                }
            }
            let comms: Vec<serde_json::Value> = comm_map.iter()
                .map(|(cid, node_ids)| {
                    let nids: Vec<String> = node_ids.iter().map(|s| s.to_string()).collect();
                    let label = derive_community_label(&nids);
                    serde_json::json!({"id": format!("comm_{}", cid), "size": nids.len(), "node_ids": nids, "label": label})
                })
                .collect();
            serde_json::json!({
                "ok": true, "node_count": nc, "edge_count": ec,
                "nodes": nodes, "edges": edges, "communities": comms,
                "hierarchical_communities": [],
                "cached": true,
            }).to_string()
        }).map_err(|e| format!("Read cached graph failed: {e}"));
    }
    } // if !force 结束

    let result = engine_api::engine_analyze(&root)
        .map_err(|e| format!("Analyze failed: {e}"))?;

    // result.graph 已被引擎消费（节点/边已移至 MemoryIndex/store）。
    // 使用 result.node_count / result.edge_count 获取标量值，
    // 从 store 读取图数据进行序列化。
    let nc = result.node_count;
    let ec = result.edge_count;

    // 从图 store 序列化（数据已由 engine_analyze 交换入）
    let serialized = serialize_cached_graph(path)?;
    let wrapped: serde_json::Value = serde_json::from_str(&serialized)
        .unwrap_or(serde_json::json!({"nodes":[],"edges":[],"communities":[]}));
    let nodes = wrapped.get("nodes").cloned().unwrap_or(serde_json::json!([]));
    let edges = wrapped.get("edges").cloned().unwrap_or(serde_json::json!([]));
    let comms = wrapped.get("communities").cloned().unwrap_or(serde_json::json!([]));
    // 层次社区来自 result（未被消费）
    let hcomms: Vec<serde_json::Value> = result.hierarchical_communities.iter()
        .map(|hc| serde_json::json!({
            "id": hc.id,
            "label": hc.label,
            "node_ids": hc.node_ids,
            "level": hc.level,
            "parent_id": hc.parent_id,
        }))
        .collect();

    // 持久化 hologram_graph.json 供冷启动使用
    let graph_path = format!("{}/hologram_graph.json", path);
    let wrapped = serde_json::json!({
        "meta": { "source_root": path,
            "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            "version": "0.1.0", "node_count": nc, "edge_count": ec },
        "nodes": nodes, "edges": edges, "communities": comms,
        "hierarchical_communities": hcomms,
    });
    let _ = std::fs::write(&graph_path, serde_json::to_string(&wrapped).unwrap_or_default());
    // 每次全量分析后都更新基线，使后续检查
    // 与最新快照进行对比 — 防止基线过期导致的误报
    // （例如图结构在两次分析间演化时出现"53 个新循环"）。
    let _ = engine_api::engine_read_graph(|g| save_baseline(&root, g));
    // .hologram MsgPack 已废弃 — CACHED_GRAPH 是唯一的运行时真相，JSON 仅用于冷启动归档
    let _ = std::fs::remove_file(format!("{}/hologram_graph.hologram", path));
    let _ = regenerate_file_graph(path);

    // 记录时间线事件（与引擎二进制的 handle_analyze 对应）
    let _ = engine_api::engine_record_timeline(
        "analyze",
        None::<&str>,
        &format!("全量分析完成：{} 节点, {} 边, {:.1}s", nc, ec, result.elapsed_secs),
    );

    Ok(serde_json::json!({
        "status": "ok", "total_nodes": nc, "total_edges": ec,
        "communities": result.community_count, "elapsed_secs": result.elapsed_secs,
        "node_count": nc, "edge_count": ec,
    }).to_string())
}

/// 在图上运行查询。从 Engine 读取。
pub(crate) fn with_graph<F: Fn(&Graph) -> serde_json::Value>(f: F) -> Result<String, String> {
    engine_api::engine_read_graph(|g| {
        serde_json::to_string(&f(g)).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// 在 MemoryIndex（基于 CSR，O(1) 邻接查询）上运行查询。
/// 遍历查询时优先使用此函数而非 with_graph。
pub(crate) fn with_index<F: FnOnce(&MemoryIndex) -> serde_json::Value>(f: F) -> Result<String, String> {
    engine_api::engine_read(|idx| {
        serde_json::to_string(&f(idx)).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// 序列化完整图 JSON — 前端和 analyze_and_load 共用。
/// 仅从 Engine 读取。
pub(crate) fn serialize_cached_graph(source_root: &str) -> Result<String, String> {
    engine_api::engine_read_graph(|g| {
        let nodes: Vec<serde_json::Value> = g.nodes.values().map(|n| serde_json::json!({
            "id": n.id, "name": n.name, "type": n.kind.as_str(),
            "location": n.location, "in_degree": n.in_degree,
            "out_degree": n.out_degree,
            "properties": n.properties, "position": n.position,
            "community_id": n.community_id,
        })).collect();
        let edges: Vec<serde_json::Value> = g.edges.values().map(|e| serde_json::json!({
            "id": e.id, "source": e.source, "target": e.target,
            "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
            "cross_file": e.cross_file,
            "temporal_delay_sec": e.temporal_delay_sec,
        })).collect();
        // 从每个节点上预计算的 community_id 重建社区
        // （避免重新运行 Louvain，其复杂度为 O(V·avg_degree·iterations)）
        // community_id 是 Option<usize> → JSON 数字，而非字符串
        let mut comm_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for n in &nodes {
            if let Some(cid) = n.get("community_id").and_then(|v| v.as_u64()) {
                if let Some(node_id) = n.get("id").and_then(|v| v.as_str()) {
                    comm_map.entry(cid.to_string()).or_default().push(node_id.to_string());
                }
            }
        }
        let communities_json: Vec<serde_json::Value> = comm_map.iter()
            .map(|(cid, node_ids)| {
                // 从最常见的文件前缀推导可读标签
                let label = derive_community_label(node_ids);
                serde_json::json!({"id": cid, "size": node_ids.len(), "node_ids": node_ids, "label": label})
            })
            .collect();
        // 层次社区 — 从 node.community_id 重建基础社区
        // （在分析阶段已设置），然后仅运行 Phase 2 凝聚。
        // 避免每次序列化时重新运行 Phase 1 detect_communities。
        let mut base_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
        for n in g.nodes.values() {
            if let Some(cid) = n.community_id {
                base_map.entry(cid).or_default().push(n.id.clone());
            }
        }
        let base: Vec<Vec<String>> = base_map.values().cloned().collect();
        let hcommunities = detect_hierarchical_communities_with_base(g, base, 42);
        let hcommunities_json: Vec<serde_json::Value> = hcommunities.iter()
            .map(|hc| serde_json::json!({
                "id": hc.id,
                "label": hc.label,
                "node_ids": hc.node_ids,
                "level": hc.level,
                "parent_id": hc.parent_id,
            }))
            .collect();
        let meta = serde_json::json!({
            "source_root": source_root,
            "node_count": g.node_count(),
            "edge_count": g.edge_count(),
        });
        serde_json::to_string(&serde_json::json!({"meta": meta, "nodes": nodes, "edges": edges, "communities": communities_json, "hierarchical_communities": hcommunities_json})).unwrap_or_default()
    })
    .map_err(|e| format!("Engine error: {}", e))
}

/// 从社区的成员节点 ID 推导可读标签。
/// 使用节点 ID 中最常见的文件路径片段。
pub(crate) fn derive_community_label(node_ids: &[String]) -> String {
    use std::collections::HashMap;
    let mut prefix_counts: HashMap<String, usize> = HashMap::new();
    for nid in node_ids {
        // 节点 ID 通常为 "file_path:line" 或 "file_path::symbol"
        // 提取顶级目录或文件名
        let file = nid.split(':').next().unwrap_or(nid);
        let parts: Vec<&str> = file.split(['/', '\\']).collect();
        // 尝试获取有意义的前缀：路径的前 1-2 段
        let prefix = if parts.len() >= 2 {
            format!("{}/{}", parts[parts.len().saturating_sub(2)], parts[parts.len() - 1])
        } else {
            file.to_string()
        };
        *prefix_counts.entry(prefix).or_default() += 1;
    }
    // 选择最常见的前缀，若无则回退到第一个节点
    prefix_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(prefix, _)| prefix)
        .unwrap_or_else(|| "社区".to_string())
}

#[allow(dead_code)] // 供 main.rs 中的测试使用
pub(crate) fn diff_to_json(before: &Graph, after: &Graph) -> serde_json::Value {
    let d = before.diff(after);
    let added_nodes: Vec<_> = d.added_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
        "location": n.location,
    })).collect();
    let removed_nodes: Vec<_> = d.removed_nodes.iter().map(|n| serde_json::json!({
        "id": n.id, "name": n.name, "type": n.kind.as_str(),
    })).collect();
    let modified_nodes: Vec<_> = d.modified_nodes.iter().map(|(old, new)| serde_json::json!({
        "node_id": new.id, "name": new.name,
        "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
    })).collect();
    let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
    serde_json::json!({
        "is_empty": is_empty,
        "added_nodes": added_nodes,
        "removed_nodes": removed_nodes,
        "modified_nodes": modified_nodes,
        "added_edges": d.added_edges.len(),
        "removed_edges": d.removed_edges.len(),
    })
}

pub(crate) async fn run_analyze_with_progress(target: String, app: tauri::AppHandle, force: bool) -> Result<String, String> {
    let target_clone = target.clone();
    let app_clone = app.clone();
    let scheduled = std::time::Instant::now();

    // 在阻塞线程中启动分析
    let mut analyze_handle = tokio::task::spawn_blocking(move || {
        direct_analyze(&target_clone, force)
    });

    // 轮询进度直到阻塞任务完成（不要在 Ready 时提前退出 —
    // 排队中的分析在 analyze_lock 上等待，此时状态保持 Ready）。
    loop {
        tokio::select! {
            res = &mut analyze_handle => {
                match res {
                    Ok(result) => return result,
                    Err(e) => return Err(format!("分析任务失败: {}", e)),
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                let state = engine_api::engine_state();
                match state {
                    engine_api::EngineState::Analyzing { phase, current, total, file, started_at_ms, .. } => {
                        let _ = app_clone.emit("analyze-phase", serde_json::json!({
                            "phase": phase.clone(),
                            "message": phase,
                        }));
                        if total > 0 {
                            let _ = app_clone.emit("analyze-progress", serde_json::json!({
                                "current": current,
                                "total": total,
                                "file": file,
                            }));
                        }
                        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
                        let elapsed = now_ms.saturating_sub(started_at_ms);
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": phase,
                            "elapsed": format!("{:.1}s", elapsed as f64 / 1000.0),
                        }));
                    }
                    _ => {
                        let elapsed_s = scheduled.elapsed().as_secs_f64();
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": "等待分析引擎",
                            "elapsed": format!("{:.1}s", elapsed_s),
                        }));
                    }
                }
            }
        }
    }
}

#[derive(serde::Serialize)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) children: Option<Vec<DirEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) truncated: Option<bool>,
}

/// 递归列出目录内容（深度受限以避免过大的树）。
/// 最大深度：4 层，最大条目数：2000。当 `filter_ignored` 为 true 时，
/// 通过引擎的 is_ignored_path 排除被忽略的路径（用于面向 Agent 的工具调用）。
/// 内部调用者（消息存储、会话扫描器）传 false 以列出 .hologram 内容。
pub(crate) fn list_dir_recursive(root: &std::path::Path, filter_ignored: bool) -> Vec<DirEntry> {
    fn recurse(
        dir: &std::path::Path,
        depth: usize,
        entries: &mut Vec<DirEntry>,
        entry_count: &mut usize,
        truncated: &mut bool,
        filter_ignored: bool,
    ) {
        const MAX_DEPTH: usize = 3; // 0,1,2,3 = 4 层
        const MAX_ENTRIES: usize = 2000;

        if depth > MAX_DEPTH || *entry_count >= MAX_ENTRIES {
            *truncated = true;
            return;
        }

        let readdir = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };

        for entry in readdir.flatten() {
            if *entry_count >= MAX_ENTRIES {
                *truncated = true;
                break;
            }

            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            let is_dir = path.is_dir();
            // 复用引擎的 is_ignored_path 以保持一致的排除行为（仅面向 Agent）
            if filter_ignored && is_dir && hologram_engine::pipeline::discovery::is_ignored_path(
                &path.to_string_lossy().replace('\\', "/"),
            ) {
                continue;
            }

            let children = if is_dir {
                let mut child_entries = Vec::new();
                recurse(&path, depth + 1, &mut child_entries, entry_count, truncated, filter_ignored);
                if child_entries.is_empty() { None } else { Some(child_entries) }
            } else {
                None
            };

            *entry_count += 1;
            entries.push(DirEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
                truncated: None,
            });
        }
    }

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut entry_count = 0usize;
    let mut truncated = false;
    recurse(root, 0, &mut entries, &mut entry_count, &mut truncated, filter_ignored);
    // 如果达到限制，在第一个条目上设置截断标志
    if truncated && !entries.is_empty() {
        entries[0].truncated = Some(true);
    }
    entries
}

pub(crate) fn list_dir_flat(root: &std::path::Path) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    // ponytail: 只隐藏 VCS 内部目录 — 其他全显示, git ignored 着色在前端处理
    let skip_dirs: std::collections::HashSet<&str> = [
        ".git", ".hg", ".svn",
    ].iter().cloned().collect();

    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };

    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
            truncated: None,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    entries
}

#[derive(serde::Serialize)]
pub(crate) struct GlobEntry {
    pub(crate) path: String,
    pub(crate) name: String,
}

pub(crate) fn is_private_ip(host: &str) -> bool {
    // 主机名检查（解析到本地/私有的 DNS 名称）
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".local") || host_lower.ends_with(".internal") {
        return true;
    }
    use std::net::IpAddr;
    let ip: IpAddr = match host.parse() {
        Ok(ip) => ip,
        Err(_) => return false,
    };
    if ip.is_loopback() || ip.is_unspecified() { return true; }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local()
        }
        IpAddr::V6(v6) => {
            // 检查 IPv6 映射的 IPv4 地址 (::ffff:a.b.c.d)
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private_ip(&mapped.to_string());
            }
            let segs = v6.segments();
            // 链路本地 (fe80::/10) 或 ULA (fc00::/7 — 包含 fd00::/8)
            (segs[0] & 0xffc0 == 0xfe80) || (segs[0] & 0xfe00 == 0xfc00)
        }
    }
}

pub(crate) fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => { out.push('%'); out.push_str(&format!("{:02X}", b)); }
        }
    }
    out
}

pub(crate) fn regenerate_file_graph(project_path: &str) -> Result<String, String> {
    let graph_path = format!("{}/hologram_graph.json", project_path);
    let files_path = format!("{}/hologram_graph_files.json", project_path);

    let content = std::fs::read_to_string(&graph_path)
        .map_err(|e| format!("Cannot read graph: {}", e))?;
    let g: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid graph JSON: {}", e))?;

    // 按文件分组节点
    let mut file_nodes: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    if let Some(nodes) = g.get("nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            let loc = n.get("location").and_then(|v| v.as_str()).unwrap_or("");
            // 从 "file.py:123" 或 "file.py" 中提取文件路径
            let file = loc.split(':').next().unwrap_or("").to_string();
            if !file.is_empty() {
                if let Some(id) = n.get("id").and_then(|v| v.as_str()) {
                    file_nodes.entry(file).or_default().push(id.to_string());
                }
            }
        }
    }

    // 以 O(N) 构建 node_id → file 查找表 — 避免 O(N*E) 的 find_node_file 扫描
    let node_file: std::collections::HashMap<&str, &str> = g.get("nodes")
        .and_then(|v| v.as_array())
        .map(|nodes| {
            nodes.iter().filter_map(|n| {
                let id = n.get("id").and_then(|v| v.as_str())?;
                let file = n.get("location").and_then(|v| v.as_str()).unwrap_or("")
                    .split(':').next().unwrap_or("");
                if file.is_empty() { None } else { Some((id, file)) }
            }).collect()
        }).unwrap_or_default();

    // 统计每对文件之间的边数
    let mut file_edges: std::collections::HashMap<(String, String), u32> = std::collections::HashMap::new();
    if let Some(edges) = g.get("edges").and_then(|v| v.as_array()) {
        for e in edges {
            let src = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
            let tgt = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
            let src_file = node_file.get(src).copied().unwrap_or("");
            let tgt_file = node_file.get(tgt).copied().unwrap_or("");
            if !src_file.is_empty() && !tgt_file.is_empty() && src_file != tgt_file {
                *file_edges.entry((src_file.to_string(), tgt_file.to_string())).or_default() += 1;
            }
        }
    }

    let file_graph: serde_json::Value = serde_json::json!({
        "nodes": file_nodes.iter().map(|(f, ids)| serde_json::json!({
            "id": f,
            "name": f.split('/').next_back().unwrap_or(f),
            "type": "file",
            "location": f,
            "symbol_count": ids.len(),
        })).collect::<Vec<_>>(),
        "edges": file_edges.iter().map(|((s, t), count)| serde_json::json!({
            "source": s,
            "target": t,
            "type": "structural",
            "weight": count,
        })).collect::<Vec<_>>(),
        "meta": g.get("meta").cloned().unwrap_or(serde_json::json!({})),
    });

    std::fs::write(&files_path, serde_json::to_string(&file_graph).unwrap_or_default())
        .map_err(|e| format!("Cannot write file graph: {}", e))?;
    Ok("ok".to_string())
}

pub(crate) fn run_git_sync(dir: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        cmd.creation_flags(NO_WINDOW);
    }
    let output = cmd
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git 命令失败: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 在阻塞线程池中运行 git 命令。
/// ponytail: .output() 会阻塞线程等待 git 进程；
/// 在 async worker 上运行会饿死并发的 Tauri 命令。
pub(crate) async fn run_git(dir: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_sync(&dir, &args))
        .await
        .map_err(|e| format!("git 任务失败: {e}"))?
}

/// 将 `git status --porcelain` 解析为结构化 JSON。
pub(crate) fn parse_status(raw: &str) -> serde_json::Value {
    let files: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let (st, path) = if line.len() >= 4 {
                (&line[..2], line[3..].trim())
            } else {
                ("  ", line)
            };
            let status = match st.trim() {
                "M" => "modified",
                "A" => "added",
                "D" => "deleted",
                "R" => "renamed",
                "C" => "copied",
                "?" => "untracked",
                _ if st.starts_with(' ') && st.ends_with('M') => "modified",
                _ if st.starts_with(' ') && st.ends_with('D') => "deleted",
                _ => "modified",
            };
            let staged = !st.starts_with(' ') && st != "??";
            let is_rename = st.contains('R');
            // 对于重命名，路径格式为 "old -> new"
            let (display_path, old_path) = if is_rename && path.contains(" -> ") {
                let parts: Vec<&str> = path.split(" -> ").collect();
                (parts[1].to_string(), Some(parts[0].to_string()))
            } else {
                (path.to_string(), None)
            };
            let mut obj = serde_json::json!({
                "path": display_path,
                "status": status,
                "staged": staged,
            });
            if let Some(old) = old_path {
                obj["old_path"] = serde_json::json!(old);
            }
            obj
        })
        .collect();
    serde_json::json!(files)
}

/// 原子写入：临时文件再重命名。
/// 原子地写入文件（tmp → rename），当原文件已存在时创建 .bak 备份。
/// 使用 io_retry 处理瞬时错误。
/// 调用方必须已通过权限检查 — 此函数仅做纯 I/O。
pub(crate) fn write_atomic(file_path: &str, content: &str) -> Result<(), String> {
    let tmp_path = format!("{}.tmp", file_path);
    let bak_path = format!("{}.bak", file_path);

    // 重试临时文件写入（NFS 等的瞬时 I/O 错误）
    io_retry(|| std::fs::write(&tmp_path, content), "write_atomic(tmp)")?;

    // 在覆盖原文件前创建 .bak 快照（尽力而为）
    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        // 将原文件重命名为 .bak；忽略失败（磁盘满、权限等）
        let _ = std::fs::rename(file_path, &bak_path);
    }

    // 用 tmp 原子替换原文件
    match std::fs::rename(&tmp_path, file_path) {
        Ok(()) => {
            // 成功后删除旧的 .bak（尽力而为）
            if had_original {
                let _ = std::fs::remove_file(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            // 如果重命名失败，尝试从 .bak 恢复
            if had_original && std::path::Path::new(&bak_path).exists() {
                let _ = std::fs::rename(&bak_path, file_path);
            }
            Err(format!("write_atomic(rename): {}", e))
        }
    }
}

/// 对可能失败的 I/O 闭包最多重试 3 次（针对瞬时错误）。
/// 瞬时错误 = Interrupted、TimedOut、WouldBlock。其他错误立即失败。
fn io_retry<T, F>(mut op: F, label: &str) -> Result<T, String>
where
    F: FnMut() -> std::io::Result<T>,
{
    let retry_count = 3u32;
    for attempt in 0..=retry_count {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                );
                if !retryable || attempt == retry_count {
                    return Err(format!("{} (尝试 {} 次后失败): {}", label, attempt + 1, e));
                }
                let delay = std::time::Duration::from_millis(100) * 2u32.pow(attempt);
                eprintln!(
                    "[write_atomic] {}: 可重试错误，第 {}/{} 次尝试 — {:?}（{:?} 后重试）",
                    label,
                    attempt + 1,
                    retry_count,
                    e,
                    delay
                );
                std::thread::sleep(delay);
            }
        }
    }
    Err(format!("{}: unreachable", label))
}

/// 将深度限制到 u8::MAX (255)，溢出时记录警告。
/// 供 engine_neighbors/impact/path 使用，防止静默截断。
pub(crate) fn clamp_depth(depth: usize) -> u8 {
    if depth > u8::MAX as usize {
        tracing::warn!(depth, "depth clamped to 255");
        u8::MAX
    } else {
        depth as u8
    }
}

/// 在内容中查找包含查询字符串的行（模糊子串匹配）。
pub(crate) fn fuzzy_find(content: &str, query: &str) -> Option<(usize, String)> {
    let q = query.trim();
    if q.is_empty() { return None; }
    for (i, line) in content.lines().enumerate() {
        if line.contains(q) {
            return Some((i + 1, line.trim().chars().take(80).collect()));
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;

    // ── B1: SSRF 防护必须捕获 ipv6 映射的 ipv4 (::ffff:a.b.c.d) ──
    #[test]
    fn test_b1_is_private_ip_ipv6_mapped() {
        assert!(is_private_ip("::ffff:127.0.0.1"), "ipv6 映射的回环地址必须被拦截");
        assert!(is_private_ip("::ffff:10.0.0.5"), "ipv6 映射的私有地址段必须被拦截");
        assert!(is_private_ip("::ffff:192.168.1.1"), "ipv6 映射的私有地址段必须被拦截");
    }

    #[test]
    fn test_b1_is_private_ip_baseline() {
        assert!(is_private_ip("127.0.0.1"));
        assert!(is_private_ip("10.1.2.3"));
        assert!(is_private_ip("192.168.0.1"));
        assert!(is_private_ip("172.16.5.5"));
        assert!(is_private_ip("169.254.1.1"), "链路本地地址必须被拦截");
        assert!(is_private_ip("0.0.0.0"), "未指定地址必须被拦截");
        assert!(is_private_ip("::1"), "ipv6 回环地址必须被拦截");
        assert!(is_private_ip("fe80::1"), "ipv6 链路本地地址必须被拦截");
        assert!(is_private_ip("fd00::1"), "ipv6 ULA 地址必须被拦截");
        assert!(is_private_ip("localhost"));
        // 公网地址不应被标记
        assert!(!is_private_ip("8.8.8.8"));
        assert!(!is_private_ip("1.1.1.1"));
        assert!(!is_private_ip("2606:4700:4700::1111"), "公网 ipv6 必须放行");
        assert!(!is_private_ip("example.com"), "普通主机名不是 IP 字面量");
    }

    // ── 深度限制 ──
    #[test]
    fn test_clamp_depth_normal() {
        assert_eq!(clamp_depth(0), 0);
        assert_eq!(clamp_depth(10), 10);
        assert_eq!(clamp_depth(255), 255);
    }

    #[test]
    fn test_clamp_depth_overflow() {
        assert_eq!(clamp_depth(256), 255);
        assert_eq!(clamp_depth(1000), 255);
        assert_eq!(clamp_depth(usize::MAX), 255);
    }
}