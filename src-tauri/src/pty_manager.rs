// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PTY 管理器 — 为集成终端提供伪终端会话。
// 使用 portable-pty (WezTerm) 实现跨平台 ConPTY/pty 支持。

use portable_pty::{CommandBuilder, PtySize, PtySystem, NativePtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}};
use tauri::{AppHandle, Emitter};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct PtySession {
    writer: Box<dyn Write + Send>,
    /// 用于调整大小的 Master — 在取走 reader/writer 后保留。
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// ⚠️ Windows 的 ChildKiller 没有 Drop impl——drop 它只是关句柄，不杀进程。
    /// 必须显式 kill()（见 reap）。
    child_killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    // 注意：reader 不住在这里——它由读取线程独有（P0-11）。
    // 若 reader 留在会话里，读取线程就必须持全局 SESSIONS 锁阻塞 read，
    // 终端无输出期间 pty_write/resize/kill 全部拿不到锁 → PTY 子系统假死。
    /// Windows：本会话的 ConPTY conhost PID 列表（reap 死锁兜底用）。
    /// 非 Windows 平台恒为空。见 conhost_guard 模块注释。
    conhost_pids: Vec<u32>,
}

type PtyMap = Arc<Mutex<HashMap<u32, PtySession>>>;
static SESSIONS: std::sync::LazyLock<PtyMap> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

fn pty_sessions() -> PtyMap {
    SESSIONS.clone()
}

// ═══════════════════════════════════════════════════════════════
// Windows：ConPTY conhost 生命周期兜底
// ═══════════════════════════════════════════════════════════════
// 每个 ConPTY 会话由一个 conhost.exe 进程承载。MS 官方文档明确：
// ClosePseudoConsole 会先向输出通道写入最后帧更新，若通道未被排空
// 则可能死锁——通道应由独立线程持续排空，直到客户端退出或关闭流程
// 完成。客户端被 TerminateProcess 强杀后 ConPTY 管道不必然 EOF
// （本文件 start_session 注释亦实测），读取线程可永久阻塞 →
// ClosePseudoConsole 无限等待 → conhost 永不退出，成为无父进程的
// 空转进程（CPU 持续空烧，日积月累打满整机）。
// 修复：会话启动时快照捕获所属 conhost PID，关闭后 8 秒宽限仍存活
// 则直接 TerminateProcess —— 打破死锁，阻塞中的关闭调用随之解除。
#[cfg(windows)]
mod conhost_guard {
    use std::collections::HashSet;

    extern "system" {
        fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut PROCESSENTRY32W) -> i32;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> isize;
        fn TerminateProcess(process: isize, exit_code: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const PROCESS_TERMINATE: u32 = 0x0001;

    /// 枚举全部 conhost.exe，返回 (pid, parent_pid) 列表。
    fn conhost_pids() -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == 0 || snap == -1 {
                return out;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let name_end = entry.sz_exe_file.iter().position(|&c| c == 0).unwrap_or(260);
                let name = String::from_utf16_lossy(&entry.sz_exe_file[..name_end]);
                if name.eq_ignore_ascii_case("conhost.exe") {
                    out.push((entry.th32_process_id, entry.th32_parent_process_id));
                }
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
        }
        out
    }

    /// 当前全部 conhost PID（启动前快照用）。
    pub fn snapshot() -> HashSet<u32> {
        conhost_pids().into_iter().map(|(pid, _)| pid).collect()
    }

    /// 启动前后快照差值 → 本会话的 conhost。
    /// 按父进程归属过滤（本应用 / 会话客户端 / 已孤儿化），
    /// 避免误杀其他程序同一瞬间派生的 conhost。
    pub fn capture(before: &HashSet<u32>, client_pid: u32) -> Vec<u32> {
        let ours = std::process::id();
        conhost_pids()
            .into_iter()
            .filter(|(pid, _)| !before.contains(pid))
            .filter(|(_, parent)| *parent == ours || *parent == client_pid || *parent == 0)
            .map(|(pid, _)| pid)
            .collect()
    }

    /// 当前仍存活的 conhost PID 集合。
    pub fn alive() -> HashSet<u32> {
        conhost_pids().into_iter().map(|(pid, _)| pid).collect()
    }

    /// 强杀进程（TerminateProcess）。对已退出进程是安全空操作。
    pub fn force_kill(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h == 0 {
                return false;
            }
            let ok = TerminateProcess(h, 1) != 0;
            CloseHandle(h);
            ok
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct PtyOutputPayload {
    session_id: u32,
    data: Vec<u8>,
}

/// 使用 shell 创建新的 PTY 会话。返回会话 ID。
#[tauri::command]
pub async fn pty_spawn(
    app_handle: AppHandle,
    cwd: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    start_session(cwd, shell, cols, rows, move |session_id, data| {
        let _ = app_handle.emit("pty-output", PtyOutputPayload { session_id, data });
    })
    .map(|(id, _pid)| id)
}

/// PTY 会话核心（与 Tauri 解耦，便于测试）：输出经 emit 回调送出。
/// 返回 (会话 ID, 子进程 PID)——PID 供测试验证 kill 生效。
fn start_session(
    cwd: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    emit: impl Fn(u32, Vec<u8>) + Send + 'static,
) -> Result<(u32, u32), String> {
    let pty_system = NativePtySystem::default();
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };

    #[cfg(windows)]
    let conhost_before = conhost_guard::snapshot();

    let pair = pty_system.openpty(size)
        .map_err(|e| format!("无法打开 PTY: {}", e))?;

    let cmd_str = shell.unwrap_or_else(|| {
        #[cfg(windows)] { "cmd.exe".into() }
        #[cfg(not(windows))] { std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()) }
    });

    let mut cmd = CommandBuilder::new(&cmd_str);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("无法启动 shell: {}", e))?;
    let pid = child.process_id().unwrap_or(0);

    // ConPTY 的 conhost 在 CreatePseudoConsole 时派生——差值捕获需覆盖 openpty。
    #[cfg(windows)]
    let conhost_pids = conhost_guard::capture(&conhost_before, pid);
    #[cfg(not(windows))]
    let conhost_pids: Vec<u32> = Vec::new();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("无法获取 PTY reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("无法获取 PTY writer: {}", e))?;

    let session = PtySession {
        writer,
        master: pair.master,
        child_killer: child.clone_killer(),
        conhost_pids,
    };

    {
        let map_ref = pty_sessions();
        let mut map = crate::utils::lock_or_recover(&map_ref);
        map.insert(id, session);
    }

    // 读取线程：将 PTY 输出流式传输到前端。
    // reader 由此线程独有——循环内完全不碰全局 SESSIONS 锁（P0-11），
    // 阻塞 read 期间 pty_write/resize/kill 都能正常拿锁。
    // 注意：Windows ConPTY 在子进程被杀后管道不一定立刻 EOF（实测），
    // 此线程可能滞留到进程退出——无害，绝不影响其他会话。
    let sessions = pty_sessions();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            emit(id, buf[..n].to_vec());
        }
        let map_ref = sessions.clone();
        crate::utils::lock_or_recover(&map_ref).remove(&id);
    });

    Ok((id, pid))
}

/// 向 PTY 会话的 stdin 写入数据。
#[tauri::command]
pub async fn pty_write(session_id: u32, data: String) -> Result<(), String> {
    let map_ref = pty_sessions();
    let mut map = crate::utils::lock_or_recover(&map_ref);
    if let Some(s) = map.get_mut(&session_id) {
        s.writer.write_all(data.as_bytes())
            .map_err(|e| format!("PTY 写入失败: {}", e))?;
        s.writer.flush().ok();
    }
    Ok(())
}

/// 调整 PTY 会话大小。
#[tauri::command]
pub async fn pty_resize(session_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map_ref = pty_sessions();
    let mut map = crate::utils::lock_or_recover(&map_ref);
    if let Some(s) = map.get_mut(&session_id) {
        s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY 调整大小失败: {}", e))?;
    }
    Ok(())
}

/// 终止并回收会话：显式杀子进程，再在分离线程中 drop 其余资源。
/// - Windows ChildKiller drop 不杀进程（无 Drop impl），必须显式 kill()；
/// - drop(master) 内 ClosePseudoConsole 实测可能长时间阻塞（ConPTY 管道在
///   客户端死后不必然 EOF）——放分离线程吸收，绝不在 tokio worker 上执行。
///   代价是异常情况下滞留一个回收线程，进程退出时由 OS 兜底清理。
fn reap(mut session: PtySession) {
    let _ = session.child_killer.kill();
    let conhost_pids = std::mem::take(&mut session.conhost_pids);
    std::thread::spawn(move || drop(session));
    #[cfg(windows)]
    {
        // 兜底：ClosePseudoConsole 卡死时（客户端死后管道不 EOF + 最后帧
        // 无法排空，MS 文档记载的死锁），conhost 不会自己退出。8 秒宽限后
        // 仍存活 → 直接 TerminateProcess，打破死锁并终结空转进程。
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let alive = conhost_guard::alive();
            for pid in conhost_pids {
                if alive.contains(&pid) {
                    let _ = conhost_guard::force_kill(pid);
                }
            }
        });
    }
}

/// 终止 PTY 会话。
#[tauri::command]
pub async fn pty_kill(session_id: u32) -> Result<(), String> {
    let session = {
        let map_ref = pty_sessions();
        let mut guard = crate::utils::lock_or_recover(&map_ref);
        guard.remove(&session_id)
    };
    if let Some(s) = session {
        reap(s);
    }
    Ok(())
}

/// 终止所有 PTY 会话 — 在关闭时由 ResourceLedger 调用。
pub fn kill_all() {
    let sessions: Vec<PtySession> = {
        let map_ref = pty_sessions();
        let mut map = crate::utils::lock_or_recover(&map_ref);
        map.drain().map(|(_, s)| s).collect()
    };
    for s in sessions {
        reap(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// 回归 P0-11：读取线程阻塞在无输出的 read 上时，pty_kill 必须能拿到锁。
    /// 修复前：读取线程持全局 SESSIONS 锁阻塞 read → pty_kill 永久等锁。
    #[test]
    fn pty_kill_not_starved_by_idle_reader() {
        let (id, _pid) = start_session(
            std::env::temp_dir().to_string_lossy().to_string(),
            None,
            80,
            24,
            |_id, _data| {},
        )
        .expect("spawn pty");
        // 等初始 banner 输出完，读取线程进入阻塞 read
        std::thread::sleep(Duration::from_millis(800));

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(pty_kill(id)).expect("pty_kill");
            let _ = tx.send(());
        });
        rx.recv_timeout(Duration::from_secs(3))
            .expect("pty_kill 被阻塞的读取线程饿死（P0-11 回归）");
    }

    /// 回归：pty_kill 必须真的杀死子进程。
    /// Windows 的 ChildKiller drop 不杀进程（无 Drop impl）——reap 若漏掉
    /// 显式 kill()，shell 进程会变成孤儿泄漏。
    #[test]
    fn pty_kill_actually_terminates_child() {
        let (id, pid) = start_session(
            std::env::temp_dir().to_string_lossy().to_string(),
            None,
            80,
            24,
            |_id, _data| {},
        )
        .expect("spawn pty");
        assert!(pid > 0, "必须拿到子进程 PID");
        std::thread::sleep(Duration::from_millis(500));

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(pty_kill(id)).expect("pty_kill");

        // 轮询等待进程消失（TerminateProcess 异步生效）
        let mut alive = true;
        for _ in 0..20 {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .expect("tasklist");
            let listing = String::from_utf8_lossy(&out.stdout);
            if !listing.contains(&pid.to_string()) {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(!alive, "pty_kill 后子进程 PID {pid} 仍然存活——显式 kill 缺失");
    }

    /// 回归 2026-08-13：PTY 会话关闭后，其 ConPTY conhost 必须退出。
    /// 修复前 ClosePseudoConsole 可无限阻塞 → conhost 变孤儿进程空转烧 CPU，
    /// 每次终端开/关泄漏一个，日积月累打满整机（本机实测 21 个）。
    #[test]
    #[cfg(windows)]
    fn pty_close_reaps_conhost() {
        let before = conhost_guard::snapshot();
        let (id, _pid) = start_session(
            std::env::temp_dir().to_string_lossy().to_string(),
            None,
            80,
            24,
            |_id, _data| {},
        )
        .expect("spawn pty");
        std::thread::sleep(Duration::from_millis(500));

        let after = conhost_guard::snapshot();
        let ours: Vec<u32> = after.difference(&before).copied().collect();
        assert!(!ours.is_empty(), "PTY 会话应创建 conhost（快照差值非空）");

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(pty_kill(id)).expect("pty_kill");

        // 轮询等待 conhost 退出（正常关闭应 <2s；修复前永久存活）。
        let deadline = std::time::Instant::now() + Duration::from_secs(12);
        loop {
            let alive_now = conhost_guard::alive();
            if !ours.iter().any(|p| alive_now.contains(p)) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "conhost 未随会话关闭退出（ConPTY 泄漏回归）"
            );
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
