// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PTY Manager — pseudo-terminal sessions for the integrated terminal.
// Uses portable-pty (WezTerm) for cross-platform ConPTY/pty support.

use portable_pty::{CommandBuilder, PtySize, PtySystem, NativePtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}};
use tauri::{AppHandle, Emitter};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct PtySession {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    /// Master for resize — kept after taking reader/writer.
    master: Box<dyn portable_pty::MasterPty + Send>,
    _child: Box<dyn portable_pty::ChildKiller + Send + Sync>,
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

/// Spawn a new PTY session with a shell. Returns the session ID.
#[tauri::command]
pub async fn pty_spawn(
    app_handle: AppHandle,
    cwd: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
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

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("无法获取 PTY reader: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("无法获取 PTY writer: {}", e))?;

    let session = PtySession {
        reader,
        writer,
        master: pair.master,
        _child: child.clone_killer(),
    };

    {
        let map_ref = pty_sessions();
        let mut map = map_ref.lock().unwrap();
        map.insert(id, session);
    }

    // Reader thread: stream PTY output to frontend
    let sessions = pty_sessions();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = {
                let map_ref = sessions.clone();
                let mut map = map_ref.lock().unwrap();
                match map.get_mut(&id) {
                    Some(s) => match s.reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    },
                    None => break,
                }
            };
            let _ = app_handle.emit("pty-output", PtyOutputPayload {
                session_id: id,
                data: buf[..n].to_vec(),
            });
        }
        let map_ref = sessions.clone();
        map_ref.lock().unwrap().remove(&id);
    });

    Ok(id)
}

/// Write data to a PTY session's stdin.
#[tauri::command]
pub async fn pty_write(session_id: u32, data: String) -> Result<(), String> {
    let map_ref = pty_sessions();
    let mut map = map_ref.lock().unwrap();
    if let Some(s) = map.get_mut(&session_id) {
        s.writer.write_all(data.as_bytes())
            .map_err(|e| format!("PTY 写入失败: {}", e))?;
        s.writer.flush().ok();
    }
    Ok(())
}

/// Resize a PTY session.
#[tauri::command]
pub async fn pty_resize(session_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map_ref = pty_sessions();
    let mut map = map_ref.lock().unwrap();
    if let Some(s) = map.get_mut(&session_id) {
        s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY 调整大小失败: {}", e))?;
    }
    Ok(())
}

/// Kill a PTY session.
#[tauri::command]
pub async fn pty_kill(session_id: u32) -> Result<(), String> {
    let map_ref = pty_sessions();
    map_ref.lock().unwrap().remove(&session_id);
    Ok(())
}
