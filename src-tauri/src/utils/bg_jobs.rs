// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 后台任务系统 — 超时 + 后台 + 输出 + 终止（从 utils.rs 拆出）

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::os_sandbox;
use crate::utils::build_lock::{BUILD_LOCKS, LockKey};
use crate::utils::ipc_guard::lock_or_recover;

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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::build_lock::{acquire_build_lock, BUILD_LOCK_TESTS};

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

}
