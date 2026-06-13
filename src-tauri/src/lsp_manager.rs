// LSP Manager — Language Server Protocol integration.
// Architecture: Monaco ↔ Tauri IPC ↔ Rust ↔ stdio ↔ Language Server.
// Pattern: same as MCP manager (JSON-RPC over stdio, crash tracking).

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicU32, Ordering}};
use tauri::{AppHandle, Emitter};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct LspServer {
    child: Child,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    request_id: AtomicU32,
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

    let stdout = child.stdout.take()
        .ok_or("无法获取 LSP stdout")?;
    let stdin: Box<dyn Write + Send> = Box::new(child.stdin.take()
        .ok_or("无法获取 LSP stdin")?);
    let stdin = Arc::new(Mutex::new(stdin));

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let req_id = Arc::new(AtomicU32::new(1));

    // Reader thread: forward LSP notifications to frontend
    let sessions = Arc::clone(&SERVERS);
    let sid = id;
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(text) = line {
                if text.is_empty() { continue; }
                if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                    let _ = handle.emit("lsp-message", serde_json::json!({
                        "session_id": sid,
                        "message": msg,
                    }));
                }
            }
        }
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
    };

    SERVERS.lock().unwrap().insert(id, server);

    Ok(id)
}

/// Send a request/notification to an LSP server.
#[tauri::command]
pub async fn lsp_request(
    session_id: u32,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let map = SERVERS.lock().unwrap();
    let server = map.get(&session_id)
        .ok_or("LSP 会话不存在")?;

    let is_notification = method.starts_with("textDocument/did");
    let id = if is_notification { 0 } else { server.request_id.fetch_add(1, Ordering::Relaxed) };

    let msg = if is_notification {
        serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
    } else {
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    };

    let mut lock = server.stdin.lock().unwrap();
    writeln!(*lock, "{}", serde_json::to_string(&msg).unwrap())
        .map_err(|e| format!("LSP 写入失败: {e}"))?;
    lock.flush().ok();

    Ok(serde_json::json!({ "sent": true, "id": id }))
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
