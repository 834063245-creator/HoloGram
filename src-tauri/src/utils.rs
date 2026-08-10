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
    /// 共享输出缓冲区（必有）：drain 线程排空管道到此 Arc，
    /// 读方(wait_bg/read_bg_output/kill_bg)只碰 Arc 内存，永不阻塞读管道。
    /// P1-17：曾为 Option，None 分支持 BG_JOBS 锁做阻塞管道读——
    /// 非 Windows 可继承管道下孙进程持写端 → 永久阻塞 → bash_* 全瘫。
    /// 改为必填字段，从类型上根除该分支。
    shared: BgSharedOutput,
    /// 任务发起者：Some(agent_id)=Agent 发起；None=用户/UI 直接发起。
    /// bash_kill 权限边界：Agent 只能 kill 自己发起的 job。
    pub(crate) owner: Option<String>,
    /// 本 job 持有的构建锁（若有）— 随 job 移除时自动释放。
    pub(crate) lock_key: Option<LockKey>,
}

pub(crate) static BG_JOBS: std::sync::LazyLock<Arc<Mutex<HashMap<u32, BgJob>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

// ══════════════════════════════════════════════════════════════════════
// BuildLock — 多 Agent 构建锁互斥（替代前端 shell 队列的互斥职责）。
//
// 设计（2026-08-10，退役前端全局串行队列的替代方案）：
//   - 互斥粒度是"锁资源"不是"命令"：同一 (cwd, lock_name) 上同时只能
//     有一个 job，不同资源互不阻塞——冲突面从时间线收窄到资源交集。
//   - 原子检查+注册：Tauri 单进程 + Mutex 临界区，无 TOCTOU 窗口。
//   - 锁生命周期 = job 生命周期：锁随 BG_JOBS 移除自动释放（remove_job）。
//   - 打回而非排队：冲突时返回带路径的错误（重试 / bash_wait），
//     由 LLM 决策；OS 文件锁（cargo/npm/git 自带）兜底竞态外冲突。
//   - 局限性（接受）：用户手动命令不注册 ledger → 锁表不可见 →
//     冲突由 OS 锁兜底；cargo workspace root 场景锁键按 cwd 判定可能漏判。
pub(crate) type LockKey = (String, String); // (cwd, lock_name)

pub(crate) struct LockHolder {
    pub(crate) job_id: u32,
    pub(crate) cmd: String,
    pub(crate) owner: Option<String>,
    pub(crate) started_at: std::time::Instant,
}

pub(crate) static BUILD_LOCKS: std::sync::LazyLock<Arc<Mutex<HashMap<LockKey, LockHolder>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 命令 → 锁名映射（种子抄前端 cmd-class.ts 的 HEAVY_SUB / GIT_WRITE_SUB）。
/// 只覆盖会抢构建锁的命令：cargo→target/，npm/pnpm/yarn→node_modules/，git 写→index。
/// 其余命令无锁，不检查不注册（互斥交给 OS/工具自带锁）。
pub(crate) fn lock_name_for_command(cmd: &str) -> Option<&'static str> {
    let mut it = cmd.split_whitespace();
    let tool = it.next()?;
    let sub = it.next().unwrap_or("");
    let heavy = |set: &[&str]| set.contains(&sub);
    match tool {
        "cargo" => heavy(&["build", "test", "check", "clippy", "run", "install", "bench", "audit"]).then_some("target"),
        "npm" | "pnpm" | "yarn" => heavy(&["install", "ci", "build", "test", "run", "exec", "audit", "start"]).then_some("node_modules"),
        "git" => {
            let write = [
                "add", "commit", "push", "pull", "fetch", "checkout", "switch", "create-branch",
                "init", "reset", "merge", "rebase", "cherry-pick", "revert", "clean",
                "restore", "rm", "mv", "stage", "unstage", "stash", "tag", "apply", "am",
            ];
            write.contains(&sub).then_some("git_index")
        }
        _ => None,
    }
}

fn lock_label(lock_name: &str) -> &str {
    match lock_name {
        "target" => "target/ 构建目录",
        "node_modules" => "node_modules/ 目录",
        "git_index" => ".git/index 索引",
        _ => lock_name,
    }
}

/// 原子检查+注册构建锁（同一 Mutex 临界区，无 TOCTOU）。
/// 冲突 → Err(带路径的打回信息)；成功 → Ok(锁键，None=无锁命令)。
/// job_id 须由调用方先用 next_job_id() 预留（与后续 spawn 使用同一 id）。
pub(crate) fn acquire_build_lock(
    cmd: &str,
    cwd: &str,
    job_id: u32,
    owner: Option<String>,
) -> Result<Option<LockKey>, String> {
    let Some(lock_name) = lock_name_for_command(cmd) else {
        return Ok(None);
    };
    let key = (cwd.to_string(), lock_name.to_string());
    let mut locks = lock_or_recover(&BUILD_LOCKS);
    if let Some(h) = locks.get(&key) {
        let secs = h.started_at.elapsed().as_secs();
        let holder = h.owner.as_deref().unwrap_or("用户手动命令");
        return Err(format!(
            "⚠️ 构建锁冲突：{label} 被 job #{id} 持有（{cmd}，已运行 {secs}s，持有者：{holder}）。\
             本命令未执行。可稍后重试，或 bash_wait({id}) 等它完成。",
            label = lock_label(lock_name),
            id = h.job_id,
            cmd = h.cmd,
        ));
    }
    locks.insert(
        key.clone(),
        LockHolder { job_id, cmd: cmd.to_string(), owner, started_at: std::time::Instant::now() },
    );
    Ok(Some(key))
}

/// 从 ledger 移除 job 并释放其构建锁（所有 job 移除路径的统一出口）。
pub(crate) fn remove_job(id: u32) -> Option<BgJob> {
    let removed = lock_or_recover(&BG_JOBS).remove(&id);
    if let Some(job) = &removed {
        if let Some(k) = &job.lock_key {
            lock_or_recover(&BUILD_LOCKS).remove(k);
        }
    }
    removed
}

/// 预留下一个 job id（acquire_build_lock 与 spawn 共用同一 id，保证锁原子注册）。
pub(crate) fn next_job_id() -> u32 {
    NEXT_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

/// 通知队列 — 由 agent 在每次 stream() 调用前清空。
pub(crate) static COMPLETED_NOTES: std::sync::LazyLock<Mutex<Vec<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

static NEXT_JOB_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// 排空并返回所有待处理的后台通知（同时清空队列）。
pub(crate) fn drain_bg_notifications() -> String {
    let mut notes = crate::utils::lock_or_recover(&COMPLETED_NOTES);
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

            let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
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
                    crate::utils::lock_or_recover(&COMPLETED_NOTES).push(msg);
                    return; // 不移除 — read_bg_output 会在 agent 检查时清理
                }
                Ok(None) => {
                    let stall_elapsed = job.last_output_time.elapsed();
                    if stall_elapsed > STALL_THRESHOLD {
                        let msg = format!(
                            "⚠️ 后台任务可能已停滞: {} 已 {}s 无输出 (job_id: {})。考虑用 bash_output({}) 检查或 bash_kill({}) 终止。",
                            label, stall_elapsed.as_secs(), id, id, id
                        );
                        crate::utils::lock_or_recover(&COMPLETED_NOTES).push(msg);
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

pub(crate) fn spawn_bg(cmd: &str, cwd: &str, owner: Option<String>, lock_key: Option<LockKey>) -> Result<u32, String> {
    let child = os_sandbox::spawn_shell(cmd, cwd)
        .map_err(|e| format!("无法启动后台命令: {e}"))?;
    let label: String = cmd.chars().take(80).collect();
    spawn_bg_from_child(child, &label, owner, lock_key)
}

/// 将已启动的 SandboxedChild 注册为后台任务。
/// 由 spawn_bg（runInBackground 路径）调用；前台流式路径用 register_fg_child。
///
/// 必须 take 管道并用 drain 线程排空到 shared Arc:
///  1) std 管道是阻塞模式且缓冲极小(Windows 匿名管道默认 4KB),后台任务
///     (cargo build/test 等)输出一多就塞满管道 → bash 写阻塞 → 命令假死;
///  2) 读方(wait_bg/read_bg_output/kill_bg)只读 shared Arc 内存,永不阻塞——
///     shared 为 BgJob 必填字段,阻塞读管道分支已从类型上移除(P1-17)。
pub(crate) fn spawn_bg_from_child(
    child: os_sandbox::SandboxedChild,
    label: &str,
    owner: Option<String>,
    lock_key: Option<LockKey>,
) -> Result<u32, String> {
    let id = next_job_id();
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
                crate::utils::lock_or_recover(&buf).extend_from_slice(&chunk[..n]);
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
                crate::utils::lock_or_recover(&buf).extend_from_slice(&chunk[..n]);
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
        shared: BgSharedOutput { stdout: stdout_buf, stderr: stderr_buf },
        owner,
        lock_key,
    };
    crate::utils::lock_or_recover(&BG_JOBS).insert(id, job);
    spawn_monitor(id, label.to_string());
    Ok(id)
}

/// P1-21: 前台 exec_command 子进程注册进 ledger（不 spawn monitor — 前台路径
/// 自己等待并负责移除）。使 kill_all_bg（工作区切换）/ shutdown 能终止仍在运行
/// 的前台命令（如占用 target 锁的 cargo），否则它们会成为跨工作区残留进程。
/// id 须由调用方用 next_job_id() 预留（与 acquire_build_lock 共用同一 id）。
pub(crate) fn register_fg_child(
    id: u32,
    child: os_sandbox::SandboxedChild,
    label: &str,
    shared: BgSharedOutput,
    owner: Option<String>,
    lock_key: Option<LockKey>,
) {
    let now = std::time::Instant::now();
    let job = BgJob {
        child,
        stdout_buf: Vec::new(),
        stderr_buf: Vec::new(),
        start_time: now,
        label: label.to_string(),
        last_output_time: now,
        shared,
        owner,
        lock_key,
    };
    crate::utils::lock_or_recover(&BG_JOBS).insert(id, job);
}

pub(crate) fn read_bg_output(id: u32) -> Result<String, String> {
    let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;

    // ── 只从共享 Arc 读取（drain 线程已排空管道）——不碰 child 管道，永不阻塞 ──
    let (stdout_str, stderr_str, new_output) = {
        let shared = &job.shared;
        let so = crate::utils::lock_or_recover(&shared.stdout);
        let se = crate::utils::lock_or_recover(&shared.stderr);
        let has_new = so.len() > job.stdout_buf.len() || se.len() > job.stderr_buf.len();
        let s = String::from_utf8_lossy(&so).to_string();
        let t = String::from_utf8_lossy(&se).to_string();
        job.stdout_buf = so.clone();
        job.stderr_buf = se.clone();
        (s, t, has_new)
    };

    if new_output {
        job.last_output_time = std::time::Instant::now();
    }
    let elapsed = job.start_time.elapsed().as_secs();
    let status = job.child.try_wait().map_err(|e| format!("检查进程状态失败: {e}"))?;
    let info = if let Some(ec) = status {
        let msg = format!("[任务已完成, exit code: {}, 耗时: {}s]\n", ec, elapsed);
        let lock_key = job.lock_key.clone();
        jobs.remove(&id);
        drop(jobs);
        if let Some(k) = lock_key {
            crate::utils::lock_or_recover(&BUILD_LOCKS).remove(&k);
        }
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
        let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
        let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
        match job.child.try_wait() {
            Ok(Some(status)) => {
                // 只从共享 Arc 读取——不碰 child 管道，永不持锁阻塞（P1-17）
                let (stdout_str, stderr_str) = {
                    let shared = &job.shared;
                    let so = crate::utils::lock_or_recover(&shared.stdout);
                    let se = crate::utils::lock_or_recover(&shared.stderr);
                    let s = String::from_utf8_lossy(&so).to_string();
                    let t = String::from_utf8_lossy(&se).to_string();
                    (s, t)
                };
                let elapsed = job.start_time.elapsed().as_secs();
                let ec = status.code().unwrap_or(-1);
                let lock_key = job.lock_key.clone();
                jobs.remove(&id);
                drop(jobs);
                if let Some(k) = lock_key {
                    crate::utils::lock_or_recover(&BUILD_LOCKS).remove(&k);
                }
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
                let lock_key = jobs.get(&id).and_then(|j| j.lock_key.clone());
                jobs.remove(&id);
                drop(jobs);
                if let Some(k) = lock_key {
                    crate::utils::lock_or_recover(&BUILD_LOCKS).remove(&k);
                }
                return Err(format!("检查进程状态失败: {e}"));
            }
        }
    }
}

/// 终止后台任务。caller=Some(agent_id) 时校验所有权：
/// Agent 只能 kill 自己发起的 job（用户/其他 Agent 的任务无权终止）。
pub(crate) fn kill_bg(id: u32, caller: Option<&str>) -> Result<String, String> {
    let (lock_key, output) = {
        let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
        let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
        if let Some(caller) = caller {
            match job.owner.as_deref() {
                None => {
                    return Err("该任务由用户发起，Agent 无权终止。请等待其完成或由用户手动清理。".into())
                }
                Some(owner) if owner != caller => {
                    return Err(format!("该任务由 {owner} 持有，当前 Agent 无权终止"))
                }
                _ => {}
            }
        }
        // 必须 kill_tree:kill() 只杀顶层 bash/cmd,残留的 cargo/rustc 孙进程会继续
        // 占用 target/ 文件锁,导致后续所有 cargo 命令无限等待锁 → "cargo test 卡死"。
        job.child.kill_tree().map_err(|e| format!("无法终止任务: {e}"))?;
        let (stdout, stderr) = {
            let shared = &job.shared;
            let so = crate::utils::lock_or_recover(&shared.stdout);
            let se = crate::utils::lock_or_recover(&shared.stderr);
            (String::from_utf8_lossy(&so).to_string(),
             String::from_utf8_lossy(&se).to_string())
        };
        let lk = job.lock_key.clone();
        jobs.remove(&id);
        (lk, format!("[任务已终止]\n{stdout}{stderr}"))
    };
    if let Some(k) = lock_key {
        crate::utils::lock_or_recover(&BUILD_LOCKS).remove(&k);
    }
    Ok(output)
}

/// 终止全部后台任务（workspace 切换时调用）。
/// 全部走 kill_tree — 防 cargo/rustc 孙进程残留占用 target/ 锁。
pub(crate) fn kill_all_bg() {
    let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
    for job in jobs.values_mut() {
        let _ = job.child.kill_tree();
    }
    jobs.clear();
    crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
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

// ═══════════════════════════════════════════════════════
// Phase 2：权限辅助函数（2026-08-04：with_workspace 已删 — 全库零调用）

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
        // yolo 模式：Ask 一律自动放行（同步路径无前端弹窗可等）
        if permissions::current_permission_mode() == permissions::PermissionMode::Yolo {
            return Ok(());
        }
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
            let rx = register_ask(request_id.clone());
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(true)) => Ok(()),
                Ok(Ok(false)) | Ok(Err(_)) => Err("用户拒绝了此操作".into()),
                Err(_) => {
                    // ⚡ 2026-08-04 状态治理：超时后移除残留的 Sender，
                    // 防止 PENDING_ASKS 只增不减地泄漏。
                    crate::permissions::remove_ask(&request_id);
                    Err("权限请求超时".into())
                }
            }
        }
    }
}

/// 同步检查权限（无 Await — 用于后台任务：Ask → 记录日志 + 拒绝并给出明确原因）。
/// 权限模式旁路（与前端 permission-ask 旁路对齐）：yolo → 全部 Ask 自动放行；
/// auto → 白名单工具放行。仅旁路 Ask — Deny（Critical 危险）始终拒绝。
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
            let mode = permissions::current_permission_mode();
            if mode == permissions::PermissionMode::Yolo
                || (mode == permissions::PermissionMode::Auto
                    && permissions::auto_mode_allows(tool.name()))
            {
                ctx.audit_allow(tool.name(), &target);
                return Ok(());
            }
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
            let nodes: Vec<serde_json::Value> = graph.nodes_map().values().map(|n| serde_json::json!({
                "id": n.id, "name": n.name, "type": n.kind.as_str(),
                "location": n.location, "in_degree": n.in_degree,
                "out_degree": n.out_degree, "properties": n.properties,
                "position": n.position, "community_id": n.community_id,
            })).collect();
            let edges: Vec<serde_json::Value> = graph.edges_map().values().map(|e| serde_json::json!({
                "id": e.id, "source": e.source, "target": e.target,
                "type": e.kind.as_str(), "coupling_depth": e.coupling_depth,
                "cross_file": e.cross_file,
                "temporal_delay_sec": e.temporal_delay_sec,
            })).collect();
            let mut comm_map: std::collections::HashMap<usize, Vec<&str>> = std::collections::HashMap::new();
            for n in graph.nodes_map().values() {
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
    // 原子写：大图数百 MB 写入窗口长，中途崩溃留下截断 JSON
    // 会被冷启动原样读回（雷区地图 P0-4）；失败必须可见（宪法·错误不静默）
    if let Err(e) = write_atomic(&graph_path, &serde_json::to_string(&wrapped).unwrap_or_default()) {
        eprintln!("[hologram] hologram_graph.json 落盘失败（冷启动缓存缺失）: {e}");
    }
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
// （2026-08-04 清理：with_graph 全库零调用，已删 — 查询统一走 with_index/MemoryIndex）

/// 在 MemoryIndex（基于 CSR，O(1) 邻接查询）上运行查询。
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
        let nodes: Vec<serde_json::Value> = g.nodes_map().values().map(|n| serde_json::json!({
            "id": n.id, "name": n.name, "type": n.kind.as_str(),
            "location": n.location, "in_degree": n.in_degree,
            "out_degree": n.out_degree,
            "properties": n.properties, "position": n.position,
            "community_id": n.community_id,
        })).collect();
        let edges: Vec<serde_json::Value> = g.edges_map().values().map(|e| serde_json::json!({
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
        for n in g.nodes_map().values() {
            if let Some(cid) = n.community_id {
                base_map.entry(cid).or_default().push(n.id.as_str().to_owned());
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

/// 工具/命令输出上限 — 超长输出进 Agent 上下文会滚雪球烧 token，
/// 经 IPC 回传也有击毁 WebView2 的风险（2026-08-08 事故）。
/// 对齐 DeepSeek-Reasonix 的 32KB（head+tail 各半 + 截断标记）。
pub(crate) const MAX_TOOL_OUTPUT_CHARS: usize = 32_000;

/// 截断超长输出：head 50% + tail 50%，中间插截断标记。
/// 按 char 边界切，避免 UTF-8 切坏；保留首尾最有信息量的部分。
pub(crate) fn truncate_output(s: &str) -> String {
    let total = s.chars().count();
    if total <= MAX_TOOL_OUTPUT_CHARS {
        return s.to_string();
    }
    let half = MAX_TOOL_OUTPUT_CHARS / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s.chars().skip(total - half).collect();
    let omitted = total - MAX_TOOL_OUTPUT_CHARS;
    format!(
        "{head}\n…[output truncated: {omitted} chars omitted — 可拆小命令或加窄参数后重试]…\n{tail}"
    )
}

/// IPC 响应尺寸硬上限 — 2026-08-08 事故：256MB 响应经 IPC 击毁 WebView2 进程栈。
/// 图 JSON 是唯一合法的大 payload（kernel 级仓库可达数百 MB），
/// 暂以硬上限换「明确报错」替代「白屏假死」；真正的解法是图分页/流式
/// （见 docs/landmine-map.md P0-2 → L 级项目）。
pub(crate) const MAX_IPC_RESPONSE_BYTES: usize = 128 * 1024 * 1024;

/// 大响应护栏：超过 IPC 上限则报错而非静默传输（宪法·错误不静默）。
pub(crate) fn guard_ipc_size(content: String, what: &str) -> Result<String, String> {
    if content.len() > MAX_IPC_RESPONSE_BYTES {
        return Err(format!(
            "{what} 大小 {}MB 超过 IPC 上限 {}MB——直接传输会击毁 WebView2。需要图分页支持（见 docs/landmine-map.md P0-2）",
            content.len() / (1024 * 1024),
            MAX_IPC_RESPONSE_BYTES / (1024 * 1024),
        ));
    }
    Ok(content)
}

/// 统一加锁：锁中毒（持锁线程 panic）时恢复数据并告警，绝不让 panic
/// 沿 IPC 面连锁扩散——一处 panic 不得拖死整个命令面（雷区地图 P0-12）。
pub(crate) fn lock_or_recover<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| {
        eprintln!("[hologram] Mutex 中毒（持锁线程曾 panic），已恢复继续: {e}");
        e.into_inner()
    })
}

/// RwLock 读版本，语义同 lock_or_recover。
pub(crate) fn read_or_recover<T>(l: &std::sync::RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| {
        eprintln!("[hologram] RwLock 读中毒（持锁线程曾 panic），已恢复继续: {e}");
        e.into_inner()
    })
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
    // tmp 路径带进程内唯一后缀 — 固定 ".tmp" 会让并发写同一文件的调用
    // 互相覆盖临时文件，rename 时触发 "系统找不到指定的文件"（os error 2）
    // 或写入内容错乱（后写覆盖先写的 tmp 再 rename）。
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = format!("{}.tmp.{}", file_path, seq);
    let bak_path = format!("{}.bak", file_path);

    // 重试临时文件写入（NFS 等的瞬时 I/O 错误）
    io_retry(|| std::fs::write(&tmp_path, content), "write_atomic(tmp)")?;

    // 在覆盖原文件前创建 .bak 快照（尽力而为）
    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        // 上次崩溃可能残留旧 .bak；rename 对既有目标的行为依赖平台/std 语义，
        // 先删旧 .bak 保证重命名一定可用——否则残留 .bak 会让该文件的
        // 所有后续写入永久失败（雷区地图 P0-3）
        let _ = std::fs::remove_file(&bak_path);
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

    // ── P0-2：大响应护栏（2026-08-08 事故的物理通道） ──
    #[test]
    fn truncate_output_short_passthrough() {
        let s = "hello world";
        assert_eq!(truncate_output(s), s);
    }

    #[test]
    fn truncate_output_long_keeps_head_and_tail() {
        let s: String = (0..MAX_TOOL_OUTPUT_CHARS * 2).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let out = truncate_output(&s);
        assert!(out.contains("[output truncated:"), "必须带截断标记");
        assert!(out.starts_with(&s[..100]), "必须保留头部");
        assert!(out.ends_with(&s[s.len() - 100..]), "必须保留尾部");
        assert!(out.chars().count() < s.chars().count(), "必须真的变短");
    }

    #[test]
    fn truncate_output_multibyte_no_panic() {
        // 中文 3 字节/字，按 char 边界切绝不能 panic 或切出乱码
        let s: String = "汉".repeat(MAX_TOOL_OUTPUT_CHARS * 2);
        let out = truncate_output(&s);
        assert!(out.contains("[output truncated:"));
    }

    #[test]
    fn guard_ipc_size_allows_small() {
        let s = "x".repeat(1024);
        assert_eq!(guard_ipc_size(s.clone(), "测试").unwrap(), s);
    }

    #[test]
    fn guard_ipc_size_rejects_oversize() {
        let s = "x".repeat(MAX_IPC_RESPONSE_BYTES + 1);
        let err = guard_ipc_size(s, "Graph JSON").unwrap_err();
        assert!(err.contains("超过 IPC 上限"), "报错必须说明原因：{err}");
    }

    /// 回归 P0-3：上次崩溃残留的 .bak 不得让后续写入永久失败。
    #[test]
    fn write_atomic_clears_stale_bak() {
        let dir = std::env::temp_dir().join("hologram_test_write_atomic_bak");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("settings.json");
        let fs = f.to_string_lossy().to_string();
        std::fs::write(&f, "old").unwrap();
        std::fs::write(format!("{fs}.bak"), "stale-corpse").unwrap();
        write_atomic(&fs, "new").expect("残留 .bak 不得导致写失败");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new");
        assert!(
            !std::path::Path::new(&format!("{fs}.bak")).exists(),
            "成功后 .bak 必须清理"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归 P0-12：锁中毒后 lock_or_recover 恢复数据而非 panic 连锁。
    #[test]
    fn lock_or_recover_survives_poisoning() {
        use std::sync::{Arc, Mutex};
        let m = Arc::new(Mutex::new(42));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            // 故意持锁 panic 制造中毒（用 expect 避开 lock_or_recover 的 codemod 模式）
            let mut g = m2.lock().expect("test lock");
            *g = 43;
            panic!("boom");
        })
        .join();
        assert!(m.lock().is_err(), "前提：锁必须已中毒");
        assert_eq!(*lock_or_recover(&m), 43, "中毒后必须恢复数据而非 panic");
    }

    // ── BuildLock：多 Agent 构建锁互斥 ──
    // 测试共享全局 BUILD_LOCKS 且并行执行——各测试末尾的 clear() 会互踩，
    // 用共享 Mutex 串行化（Rust 测试默认并行线程）。
    static BUILD_LOCK_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 锁键按 (cwd, lock_name) 判定：同目录两个 cargo build 冲突。
    #[test]
    fn build_lock_conflict_same_resource() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let k1 = acquire_build_lock("cargo build", "C:/ws-t1", 1, Some("agent-a".into())).unwrap();
        assert!(k1.is_some(), "cargo build 应注册 target 锁");
        let err = acquire_build_lock("cargo test", "C:/ws-t1", 2, Some("agent-b".into())).unwrap_err();
        assert!(err.contains("构建锁冲突"), "冲突应打回: {err}");
        assert!(err.contains("job #1"), "打回应指明持有者 job: {err}");
        assert!(err.contains("agent-a"), "打回应指明持有者: {err}");
        assert!(err.contains("bash_wait(1)"), "打回应带等待路径: {err}");
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// 不同锁资源 / 不同 cwd 互不冲突（worktree 隔离白赚）。
    #[test]
    fn build_lock_no_conflict_different_resource() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let k1 = acquire_build_lock("cargo build", "C:/ws-t2", 1, None).unwrap();
        let k2 = acquire_build_lock("npm install", "C:/ws-t2", 2, None).unwrap();
        let k3 = acquire_build_lock("cargo build", "C:/ws-t2/worktree2", 3, None).unwrap();
        assert!(k1.is_some() && k2.is_some() && k3.is_some(), "异资源/异目录不应冲突");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// 无锁命令不注册；git 只读子命令不锁。
    #[test]
    fn build_lock_ignores_nonlocking_commands() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        assert!(acquire_build_lock("echo hi", "C:/ws-t3", 1, None).unwrap().is_none());
        assert!(acquire_build_lock("git status", "C:/ws-t3", 2, None).unwrap().is_none());
        assert!(acquire_build_lock("git commit -m x", "C:/ws-t3", 3, None).unwrap().is_some());
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// remove_job 释放锁：job 完成后同资源命令恢复可执行。
    #[test]
    fn build_lock_released_on_remove_job() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let id = next_job_id();
        let k = acquire_build_lock("cargo build", "C:/ws-t4", id, None).unwrap().unwrap();
        // 模拟 job 完成 → remove_job 释放锁
        crate::utils::lock_or_recover(&BG_JOBS).insert(
            id,
            BgJob {
                child: {
                    // 占位 child — 测试只关心锁释放，不启动进程
                    // （用 spawn 一个立即退出的命令得到 SandboxedChild）
                    let c = crate::os_sandbox::spawn_shell("echo x", ".").expect("spawn_shell failed");
                    c
                },
                stdout_buf: Vec::new(),
                stderr_buf: Vec::new(),
                start_time: std::time::Instant::now(),
                label: "test".into(),
                last_output_time: std::time::Instant::now(),
                shared: BgSharedOutput {
                    stdout: Default::default(),
                    stderr: Default::default(),
                },
                owner: None,
                lock_key: Some(k.clone()),
            },
        );
        remove_job(id);
        assert!(
            !crate::utils::lock_or_recover(&BUILD_LOCKS).contains_key(&k),
            "remove_job 应释放构建锁"
        );
    }

    /// bash_kill 所有权边界：Agent 不能 kill 用户任务 / 其他 Agent 任务。
    #[test]
    fn kill_bg_ownership_boundary() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let id = next_job_id();
        let child = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        register_fg_child(id, child, "sleep 30", BgSharedOutput { stdout: Default::default(), stderr: Default::default() }, Some("agent-a".into()), None);
        // 其他 Agent 无权 kill
        let err = kill_bg(id, Some("agent-b")).unwrap_err();
        assert!(err.contains("无权终止"), "跨 Agent kill 应拒绝: {err}");
        // 本人可 kill
        assert!(kill_bg(id, Some("agent-a")).is_ok(), "本人 kill 应放行");
        // 用户任务（owner=None）：Agent 无权 kill
        let id2 = next_job_id();
        let child2 = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        register_fg_child(id2, child2, "sleep 30", BgSharedOutput { stdout: Default::default(), stderr: Default::default() }, None, None);
        let err2 = kill_bg(id2, Some("agent-a")).unwrap_err();
        assert!(err2.contains("无权终止"), "用户任务 Agent 不可 kill: {err2}");
        // 用户（无 agent_id）可 kill 任何任务
        assert!(kill_bg(id2, None).is_ok(), "用户 kill 应放行");
    }

    // ── P1-17：bg 任务读方只碰 shared Arc，永不阻塞读管道 ──
    #[test]
    fn bg_job_roundtrip_via_shared_arc() {
        let id = spawn_bg("echo bg-p117", ".", None, None).expect("spawn_bg failed");
        let out = wait_bg(id, 10_000).expect("wait_bg failed");
        assert!(out.contains("bg-p117"), "unexpected output: {out}");
        assert!(out.contains("exit code: 0"), "unexpected output: {out}");
    }

    /// 无输出的长任务：read_bg_output 必须立即返回快照（修复前 shared=None 分支
    /// 会持 BG_JOBS 锁阻塞读管道，任务安静时永久卡死）。shared 现为必填字段，
    /// 该分支已从类型上移除，此测试锁定行为。
    #[test]
    fn bg_output_snapshot_quiet_task_returns_fast() {
        let id = spawn_bg("sleep 5", ".", None, None).expect("spawn_bg failed");
        let start = std::time::Instant::now();
        let out = read_bg_output(id).expect("read_bg_output failed");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "快照读取耗时 {:?}——疑似退化为阻塞管道读",
            start.elapsed()
        );
        assert!(out.contains("任务运行中"), "unexpected output: {out}");
        kill_bg(id, None).expect("kill_bg failed");
    }
}