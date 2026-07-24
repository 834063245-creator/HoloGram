// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// External services — MCP Server, Unity process manager, sandbox status.

use std::sync::{Arc, Mutex};
use std::io::Read;
use std::net::{TcpListener as StdTcpListener, TcpStream as StdTcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use crate::mcp_manager::McpManager;
use crate::unity_manager::UnityManager;

pub(crate) static MCP_MANAGER: std::sync::LazyLock<Arc<Mutex<McpManager>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(McpManager::new())));

/// Retained Child handle for memory-bundle.exe — killed by ResourceLedger on shutdown.
pub(crate) static MEMORY_BUNDLE_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

/// Shutdown flag for the Unity event TCP server thread.
pub(crate) static UNITY_EVENT_SHUTDOWN: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub(crate) async fn start_mcp_server(project_root: String) -> Result<String, String> {
    let engine = crate::utils::engine_binary();
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.start(&project_root, &engine)
}

#[tauri::command]
pub(crate) async fn stop_mcp_server() -> Result<String, String> {
    let mut mgr = MCP_MANAGER.lock().unwrap();
    mgr.stop();
    Ok("MCP Server 已停止".into())
}

pub(crate) fn start_unity_event_server(app: tauri::AppHandle) {
    UNITY_EVENT_SHUTDOWN.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let listener = match StdTcpListener::bind("127.0.0.1:9776") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[unity-events] bind failed: {}", e);
                return;
            }
        };
        // Non-blocking so we can poll the shutdown flag
        let _ = listener.set_nonblocking(true);
        println!("[unity-events] listening on 127.0.0.1:9776");

        loop {
            if UNITY_EVENT_SHUTDOWN.load(Ordering::SeqCst) {
                eprintln!("[unity-events] shutdown flag set, exiting");
                break;
            }
            match listener.accept() {
                Ok((mut s, _)) => {
                    // Accepted stream may inherit non-blocking mode from listener
                    // (platform-dependent). Set back to blocking for the per-connection
                    // handler which uses blocking read().
                    let _ = s.set_nonblocking(false);
                    handle_unity_connection(&mut s, &app);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => {
                    if UNITY_EVENT_SHUTDOWN.load(Ordering::SeqCst) {
                        break;
                    }
                    eprintln!("[unity-events] accept error: {}", e);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
    });
}

fn handle_unity_connection(stream: &mut StdTcpStream, app: &tauri::AppHandle) {
    let mut buf = vec![0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let msg = String::from_utf8_lossy(&buf[..n]);
                println!("[unity-events] received: {}", msg.trim());

                let parts: Vec<&str> = msg.trim().splitn(2, ':').collect();
                if parts.len() == 2 {
                    let event = parts[0];
                    let payload = parts[1];
                    let _ = app.emit("unity-event", serde_json::json!({
                        "event": event,
                        "payload": payload
                    }));
                }
            }
            Err(e) => {
                eprintln!("[unity-events] read error: {}", e);
                break;
            }
        }
    }
}

pub(crate) static UNITY_MANAGER: std::sync::LazyLock<UnityManager> =
    std::sync::LazyLock::new(|| UnityManager::new(UnityManager::default_exe_path()));

#[tauri::command]
pub(crate) fn start_unity() -> Result<String, String> {
    match UNITY_MANAGER.start() {
        Ok(true) => Ok("Unity started".into()),
        Ok(false) => Ok("Unity already running".into()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) fn stop_unity() -> Result<String, String> {
    UNITY_MANAGER.stop().map(|_| "Unity stopped".into())
}

#[tauri::command]
pub(crate) fn unity_status() -> Result<String, String> {
    Ok(if UNITY_MANAGER.is_running() { "running" } else { "stopped" }.into())
}

#[tauri::command]
pub(crate) fn sandbox_status() -> Result<String, String> {
    let s = crate::os_sandbox::status();
    let (available, degraded, reason) = match s {
        crate::os_sandbox::SandboxStatus::Available => (true, false, String::new()),
        crate::os_sandbox::SandboxStatus::Unavailable => (false, true, "OS sandbox 不可用 — 仅权限引擎生效".into()),
    };
    Ok(serde_json::json!({
        "available": available,
        "degraded": degraded,
        "reason": reason,
    }).to_string())
}