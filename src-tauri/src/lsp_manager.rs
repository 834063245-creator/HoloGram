// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LSP Manager — Language Server Protocol integration.
// Architecture: Monaco ↔ Tauri IPC ↔ Rust ↔ stdio ↔ Language Server.
// Pattern: same as MCP manager (JSON-RPC over stdio, crash tracking).
//
// Response routing: requests (textDocument/completion, hover, definition, etc.)
// create a oneshot channel. The reader thread matches JSON-RPC "id" fields
// to pending senders. Notifications (textDocument/did*) skip this — they
// flow to the frontend via the lsp-message event for diagnostics.

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct LspServer {
    child: Child,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    request_id: AtomicU32,
    /// Pending requests waiting for a JSON-RPC response.
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Value>>>>,
}

type LspMap = Arc<Mutex<HashMap<u32, LspServer>>>;
static SERVERS: std::sync::LazyLock<LspMap> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Detect which LSP is available for a given language.
fn detect_lsp(language: &str) -> Option<(&str, Vec<&str>)> {
    match language {
        "python" => Some(("pyright-langserver", vec!["--stdio"])),
        "rust" => Some(("rust-analyzer", vec![])),
        "go" => Some(("gopls", vec![])),
        "typescript" | "javascript" => Some(("typescript-language-server", vec!["--stdio"])),
        _ => None,
    }
}

/// Start an LSP server for a language. Returns session ID or error.
#[tauri::command]
pub async fn lsp_start(
    app_handle: AppHandle,
    language: String,
    root_uri: String,
) -> Result<u32, String> {
    let (cmd, args) = detect_lsp(&language)
        .ok_or_else(|| format!("不支持的语言或未安装 LSP: {}", language))?;

    let mut child = Command::new(cmd)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 LSP ({cmd}): {e}"))?;

    crate::os_sandbox::assign_to_job(&child);
    let stdout = child.stdout.take()
        .ok_or("无法获取 LSP stdout")?;
    let stdin: Box<dyn Write + Send> = Box::new(child.stdin.take()
        .ok_or("无法获取 LSP stdin")?);
    let stdin = Arc::new(Mutex::new(stdin));

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let req_id = Arc::new(AtomicU32::new(1));

    // Shared map for routing JSON-RPC responses back to pending requesters
    let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = Arc::clone(&pending);

    // Reader thread: forward LSP messages.
    // - Notifications (no "id") → emit lsp-message to frontend (diagnostics, etc.)
    // - Responses (has "id")   → try oneshot sender first; fall back to lsp-message
    let sessions = Arc::clone(&SERVERS);
    let sid = id;
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(text) = line {
                if text.is_empty() { continue; }
                if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                    // Route responses with an id through the oneshot channel
                    if let Some(resp_id) = msg.get("id").and_then(|v| v.as_u64()) {
                        let rid = resp_id as u32;
                        let sender = pending_reader.lock().unwrap().remove(&rid);
                        if let Some(tx) = sender {
                            // Don't care if receiver already dropped (timeout)
                            let _ = tx.send(msg);
                            continue; // routed — don't re-emit to frontend
                        }
                        // No oneshot waiting — emit as event anyway (e.g. late response)
                    }
                    // Notification or unclaimed response → forward to frontend
                    let _ = handle.emit("lsp-message", serde_json::json!({
                        "session_id": sid,
                        "message": msg,
                    }));
                }
            }
        }
        // Server stdout closed → clean up
        sessions.lock().unwrap().remove(&sid);
    });

    // Send initialize
    {
        let init = serde_json::json!({
            "jsonrpc": "2.0", "id": req_id.fetch_add(1, Ordering::Relaxed),
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "completion": { "dynamicRegistration": true },
                        "hover": { "dynamicRegistration": true },
                        "definition": { "dynamicRegistration": true },
                        "references": { "dynamicRegistration": true },
                        "publishDiagnostics": { "relatedInformation": true },
                    }
                }
            }
        });
        let mut lock = stdin.lock().unwrap();
        writeln!(lock, "{}", serde_json::to_string(&init).unwrap()).ok();
        lock.flush().ok();
    }

    // Send initialized notification
    {
        let notif = serde_json::json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {}
        });
        let mut lock = stdin.lock().unwrap();
        writeln!(lock, "{}", serde_json::to_string(&notif).unwrap()).ok();
        lock.flush().ok();
    }

    let server = LspServer {
        child,
        stdin: stdin.clone(),
        request_id: AtomicU32::new(2), // 1 was used for initialize
        pending,
    };

    SERVERS.lock().unwrap().insert(id, server);

    Ok(id)
}

/// Send a request/notification to an LSP server.
/// For requests (completion, hover, definition, etc.) this waits for the
/// JSON-RPC response and returns the `result` field.
/// For notifications (textDocument/did*) this returns immediately.
#[tauri::command]
pub async fn lsp_request(
    session_id: u32,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let is_notification = method.starts_with("textDocument/did");

    // --- Prepare and send the message (under SERVERS lock) ---
    let (rx, request_id) = {
        let map = SERVERS.lock().unwrap();
        let server = map.get(&session_id)
            .ok_or("LSP 会话不存在")?;

        let id = if is_notification {
            0
        } else {
            server.request_id.fetch_add(1, Ordering::Relaxed)
        };

        let msg = if is_notification {
            serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
        } else {
            serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
        };

        let mut lock = server.stdin.lock().unwrap();
        writeln!(*lock, "{}", serde_json::to_string(&msg).unwrap())
            .map_err(|e| format!("LSP 写入失败: {e}"))?;
        lock.flush().ok();

        if is_notification {
            (None, 0u32)
        } else {
            // Create oneshot BEFORE dropping the map lock so the reader
            // thread can find it even if the response is very fast
            let (tx, rx) = oneshot::channel();
            server.pending.lock().unwrap().insert(id, tx);
            (Some(rx), id)
        }
    }; // SERVERS lock dropped here

    // --- Wait for response (outside lock — no deadlock risk) ---
    if let Some(rx) = rx {
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(json_rpc_response)) => {
                // Extract result or error from JSON-RPC envelope
                if let Some(err) = json_rpc_response.get("error") {
                    let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("LSP 错误");
                    return Err(format!("LSP 错误: {msg}"));
                }
                let result = json_rpc_response.get("result").cloned()
                    .unwrap_or(Value::Null);
                Ok(result)
            }
            Ok(Err(_recv_err)) => {
                // Sender dropped (server crashed?) — clean up stale pending entry
                let map = SERVERS.lock().unwrap();
                if let Some(server) = map.get(&session_id) {
                    server.pending.lock().unwrap().remove(&request_id);
                }
                Err("LSP 连接已断开".to_string())
            }
            Err(_timeout) => {
                // Timeout — clean up stale pending entry
                let map = SERVERS.lock().unwrap();
                if let Some(server) = map.get(&session_id) {
                    server.pending.lock().unwrap().remove(&request_id);
                }
                Err("LSP 请求超时".to_string())
            }
        }
    } else {
        // Notification — return immediately
        Ok(serde_json::json!({ "sent": true }))
    }
}

/// Stop an LSP server.
#[tauri::command]
pub async fn lsp_stop(session_id: u32) -> Result<(), String> {
    let mut map = SERVERS.lock().unwrap();
    if let Some(mut server) = map.remove(&session_id) {
        server.child.kill().ok();
    }
    Ok(())
}
