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
}

type PtyMap = Arc<Mutex<HashMap<u32, PtySession>>>;
static SESSIONS: std::sync::LazyLock<PtyMap> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

fn pty_sessions() -> PtyMap {
    SESSIONS.clone()
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

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("无法获取 PTY reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("无法获取 PTY writer: {}", e))?;

    let session = PtySession {
        writer,
        master: pair.master,
        child_killer: child.clone_killer(),
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
    std::thread::spawn(move || drop(session));
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
}
