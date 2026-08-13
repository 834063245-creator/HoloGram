// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// MCP / ACP stdio 桥：让 webview 里的 TS MCP client / ACP server 通过 Tauri 起一个
// 子进程（外部 MCP server / ACP host），并在 webview 与子进程 stdin/stdout 之间双向搬
// 运 JSON-RPC 行。stdout 行经 `protocol-bridge:output` 事件推给前端；前端用
// `protocol_bridge_spawn` 起,`protocol_bridge_write` 写 stdin,`protocol_bridge_kill` 关。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;

use tauri::Emitter;
use tracing::info;

struct BridgeProc {
    child: Child,
    stdin: Option<ChildStdin>,
    /// 子进程退出通知（keepalive 用）。
    _exit_tx: mpsc::Sender<i32>,
}

static PROCS: std::sync::LazyLock<Mutex<HashMap<String, BridgeProc>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 生成一个 stdio 子进程（外部 MCP server / ACP host），返回其 bridge id。
#[tauri::command]
pub(crate) fn protocol_bridge_spawn(
    id: String,
    command: String,
    args: Vec<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut child = std::process::Command::new(&command)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("protocol_bridge_spawn: {command} 启动失败: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "protocol_bridge_spawn: 无法捕获 stdout".to_string())?;
    let stdin = child.stdin.take();

    let app_out = app.clone();
    let bridge_id = id.clone();
    let (exit_tx, exit_rx) = mpsc::channel::<i32>();
    // stdout 读者线程：逐行 emit 到前端。
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_out.emit(
                "protocol-bridge:output",
                serde_json::json!({ "id": bridge_id, "line": line }),
            );
        }
        // stdout EOF → 通知退出
        let _ = app_out.emit("protocol-bridge:exit", serde_json::json!({ "id": bridge_id }));
    });
    std::thread::spawn(move || {
        // 让 exit_rx 存活以接收 child 退出（未直接使用 child.wait 以免阻塞）
        let _ = exit_rx.recv();
    });

    PROCS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), BridgeProc { child, stdin, _exit_tx: exit_tx });
    info!(id = %id, command = %command, "protocol bridge spawned");
    Ok(id)
}

/// 向指定 bridge 子进程的 stdin 写一行（不含换行）。
#[tauri::command]
pub(crate) fn protocol_bridge_write(id: String, line: String) -> Result<String, String> {
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    let proc = procs
        .get_mut(&id)
        .ok_or_else(|| format!("protocol_bridge_write: unknown bridge {id}"))?;
    let stdin = proc
        .stdin
        .as_mut()
        .ok_or_else(|| format!("protocol_bridge_write: {id} stdin closed"))?;
    stdin
        .write_all(format!("{}\n", line).as_bytes())
        .map_err(|e| format!("protocol_bridge_write: {id} 写入失败: {e}"))?;
    stdin.flush().map_err(|e| format!("protocol_bridge_write: {id} flush 失败: {e}"))?;
    Ok(id)
}

/// 关闭指定 bridge：杀子进程 + 从注册表移除。
#[tauri::command]
pub(crate) fn protocol_bridge_kill(id: String) -> Result<String, String> {
    let mut procs = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut p) = procs.remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    Ok(id)
}
