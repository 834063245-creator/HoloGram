// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LSP 管理器 — Language Server Protocol 集成。
// 架构：Monaco ↔ Tauri IPC ↔ Rust ↔ stdio ↔ Language Server。
// 模式：与 MCP 管理器相同（基于 stdio 的 JSON-RPC，崩溃追踪）。
//
// 响应路由：请求（textDocument/completion、hover、definition 等）
// 创建一个 oneshot channel。读取线程通过匹配 JSON-RPC "id" 字段
// 找到等待中的 sender。通知（textDocument/did*）跳过此步骤 — 它们
// 通过 lsp-message 事件流向前端，用于诊断信息。

#[cfg(windows)] use std::os::windows::process::CommandExt;

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc, atomic::{AtomicU32, Ordering}};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct LspServer {
    child: Child,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    request_id: AtomicU32,
    /// 等待 JSON-RPC 响应的 pending 请求。
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Value>>>>,
}

type LspMap = Arc<Mutex<HashMap<u32, LspServer>>>;
static SERVERS: std::sync::LazyLock<LspMap> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 检测给定语言可用的 LSP。
fn detect_lsp(language: &str) -> Option<(&str, Vec<&str>)> {
    match language {
        "python" => Some(("pyright-langserver", vec!["--stdio"])),
        "rust" => Some(("rust-analyzer", vec![])),
        "go" => Some(("gopls", vec![])),
        "typescript" | "javascript" => Some(("typescript-language-server", vec!["--stdio"])),
        "java" => Some(("jdtls", vec![])),
        "c" | "cpp" => Some(("clangd", vec![])),
        "csharp" => Some(("omnisharp", vec!["-lsp"])),
        "ruby" => Some(("solargraph", vec!["stdio"])),
        "lua" => Some(("lua-language-server", vec![])),
        "php" => Some(("intelephense", vec!["--stdio"])),
        "swift" => Some(("sourcekit-lsp", vec![])),
        "dart" => Some(("dart", vec!["language-server", "--stdio"])),
        "haskell" => Some(("haskell-language-server-wrapper", vec!["--lsp"])),
        "elixir" => Some(("elixir-ls", vec![])),
        "erlang" => Some(("erlang_ls", vec![])),
        "zig" => Some(("zls", vec![])),
        "bash" | "shell" => Some(("bash-language-server", vec!["start"])),
        "html" => Some(("vscode-html-language-server", vec!["--stdio"])),
        "css" | "scss" | "less" => Some(("vscode-css-language-server", vec!["--stdio"])),
        "yaml" | "yml" => Some(("yaml-language-server", vec!["--stdio"])),
        "scala" => Some(("metals", vec![])),
        "kotlin" => Some(("kotlin-language-server", vec![])),
        "r" => Some(("R", vec!["--slave", "-e", "languageserver::run()"])),
        "nix" => Some(("nil", vec![])),
        "ocaml" => Some(("ocamllsp", vec![])),
        _ => None,
    }
}

/// 为语言启动 LSP 服务器。返回会话 ID 或错误。
#[tauri::command]
pub async fn lsp_start(
    app_handle: AppHandle,
    language: String,
    root_uri: String,
) -> Result<u32, String> {
    let (cmd, args) = detect_lsp(&language)
        .ok_or_else(|| format!("不支持的语言或未安装 LSP: {}", language))?;

    let mut c = Command::new(cmd);
    c.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    { c.creation_flags(crate::utils::NO_WINDOW); }
    let mut child = c.spawn()
        .map_err(|e| format!("无法启动 LSP ({cmd}): {e}"))?;

    crate::os_sandbox::assign_to_job(&child);
    let stdout = child.stdout.take()
        .ok_or("无法获取 LSP stdout")?;
    let stdin: Box<dyn Write + Send> = Box::new(child.stdin.take()
        .ok_or("无法获取 LSP stdin")?);
    let stdin = Arc::new(Mutex::new(stdin));

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let req_id = Arc::new(AtomicU32::new(1));

    // 用于将 JSON-RPC 响应路由回等待中请求者的共享 map
    let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = Arc::clone(&pending);

    // 读取线程：转发 LSP 消息。
    // - 通知（无 "id"）→ 发出 lsp-message 到前端（诊断等）
    // - 响应（有 "id"）  → 先尝试 oneshot sender；回退到 lsp-message
    let sessions = Arc::clone(&SERVERS);
    let sid = id;
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(text) = line {
                if text.is_empty() { continue; }
                if let Ok(msg) = serde_json::from_str::<Value>(&text) {
                    // 通过 oneshot channel 路由带 id 的响应
                    if let Some(resp_id) = msg.get("id").and_then(|v| v.as_u64()) {
                        let rid = resp_id as u32;
                        let sender = crate::utils::lock_or_recover(&pending_reader).remove(&rid);
                        if let Some(tx) = sender {
                            // 不关心接收方是否已丢弃（超时）
                            let _ = tx.send(msg);
                            continue; // 已路由 — 不再重新发送到前端
                        }
                        // 无 oneshot 等待 — 仍作为事件发送（如延迟响应）
                    }
                    // 通知或无人认领的响应 → 转发到前端
                    let _ = handle.emit("lsp-message", serde_json::json!({
                        "session_id": sid,
                        "message": msg,
                    }));
                }
            }
        }
        // Server stdout 已关闭 → 清理
        crate::utils::lock_or_recover(&sessions).remove(&sid);
    });

    // 发送 initialize 并等待响应后才返回。
    // 否则 didOpen 和 textDocument/completion 可能在
    // 服务器初始化完成之前执行（尤其是 tsserver 等慢服务器）。
    // 使用 mpsc（而非 tokio oneshot）以保持 Tauri 命令的 Send 安全。
    let (tx, rx) = mpsc::channel();
    {
        let init_id = req_id.fetch_add(1, Ordering::Relaxed);
        // 通过 mpsc sender 路由响应 — 读取线程会拾取它
        let pending = pending.clone();
        let tx = tx.clone();
        let init = serde_json::json!({
            "jsonrpc": "2.0", "id": init_id,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "completion": {
                            "completionItem": {
                                "snippetSupport": true,
                                "documentationFormat": ["markdown", "plaintext"],
                            },
                            "triggerCharacters": [".", ":", "\"", "'", "/", " "],
                        },
                        "hover": {
                            "contentFormat": ["markdown", "plaintext"],
                        },
                        "definition": { "linkSupport": true },
                        "references": {},
                        "publishDiagnostics": { "relatedInformation": true },
                    }
                }
            }
        });
        let mut lock = crate::utils::lock_or_recover(&stdin);
        writeln!(lock, "{}", serde_json::to_string(&init).unwrap()).ok();
        lock.flush().ok();
        // 注册一个转发到 mpsc 的 oneshot
        let (otx, orx) = oneshot::channel();
        crate::utils::lock_or_recover(&pending).insert(init_id, otx);
        // 桥接：tokio oneshot → std mpsc（读取线程解析 tokio oneshot）
        std::thread::spawn(move || {
            let _ = tx.send(orx.blocking_recv());
        });
    }

    // 等待 initialize 响应（30s 超时，避免坏服务器永久挂起）
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(val)) => { let _ = val; /* initialize 成功 */ }
        Ok(Err(_)) => { return Err(format!("LSP 初始化失败 ({})", cmd)); }
        Err(_) => { return Err(format!("LSP 初始化超时 ({})", cmd)); }
    }

    // 发送 initialized 通知
    {
        let notif = serde_json::json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {}
        });
        let mut lock = crate::utils::lock_or_recover(&stdin);
        writeln!(lock, "{}", serde_json::to_string(&notif).unwrap()).ok();
        lock.flush().ok();
    }

    let server = LspServer {
        child,
        stdin: stdin.clone(),
        request_id: AtomicU32::new(2), // 1 已用于 initialize
        pending,
    };

    crate::utils::lock_or_recover(&SERVERS).insert(id, server);

    Ok(id)
}

    /// 向 LSP 服务器发送请求/通知。
    /// 对于请求（completion、hover、definition 等），等待
    /// JSON-RPC 响应并返回 `result` 字段。
    /// 对于通知（textDocument/did*），立即返回。
#[tauri::command]
pub async fn lsp_request(
    session_id: u32,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let is_notification = method.starts_with("textDocument/did");

    // --- 准备并发送消息（在 SERVERS 锁内）---
    let (rx, request_id) = {
        let map = crate::utils::lock_or_recover(&SERVERS);
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

        let mut lock = crate::utils::lock_or_recover(&server.stdin);
        writeln!(*lock, "{}", serde_json::to_string(&msg).unwrap())
            .map_err(|e| format!("LSP 写入失败: {e}"))?;
        lock.flush().ok();

        if is_notification {
            (None, 0u32)
        } else {
            // 在释放 map 锁之前创建 oneshot，使读取
            // 线程即使响应很快也能找到它
            let (tx, rx) = oneshot::channel();
            crate::utils::lock_or_recover(&server.pending).insert(id, tx);
            (Some(rx), id)
        }
    }; // SERVERS 锁在此释放

    // --- 等待响应（锁外 — 无死锁风险）---
    if let Some(rx) = rx {
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(json_rpc_response)) => {
                // 从 JSON-RPC 信封中提取 result 或 error
                if let Some(err) = json_rpc_response.get("error") {
                    let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("LSP 错误");
                    return Err(format!("LSP 错误: {msg}"));
                }
                let result = json_rpc_response.get("result").cloned()
                    .unwrap_or(Value::Null);
                Ok(result)
            }
            Ok(Err(_recv_err)) => {
                // Sender 已丢弃（服务器崩溃？）— 清理过期的 pending 条目
                let map = crate::utils::lock_or_recover(&SERVERS);
                if let Some(server) = map.get(&session_id) {
                    crate::utils::lock_or_recover(&server.pending).remove(&request_id);
                }
                Err("LSP 连接已断开".to_string())
            }
            Err(_timeout) => {
                // 超时 — 清理过期的 pending 条目
                let map = crate::utils::lock_or_recover(&SERVERS);
                if let Some(server) = map.get(&session_id) {
                    crate::utils::lock_or_recover(&server.pending).remove(&request_id);
                }
                Err("LSP 请求超时".to_string())
            }
        }
    } else {
        // 通知 — 立即返回
        Ok(serde_json::json!({ "sent": true }))
    }
}

/// 停止一个 LSP 服务器。
#[tauri::command]
pub async fn lsp_stop(session_id: u32) -> Result<(), String> {
    let mut map = crate::utils::lock_or_recover(&SERVERS);
    if let Some(mut server) = map.remove(&session_id) {
        server.child.kill().ok();
    }
    Ok(())
}

/// 停止所有 LSP 服务器 — 在关闭时由 ResourceLedger 调用。
pub fn stop_all() {
    let mut map = crate::utils::lock_or_recover(&SERVERS);
    for (_, mut server) in map.drain() {
        server.child.kill().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::detect_lsp;

    #[test]
    fn test_all_registered_languages_have_lsp() {
        let langs = [
            "python", "rust", "go", "typescript", "javascript",
            "java", "c", "cpp", "csharp", "ruby", "lua", "php",
            "swift", "dart", "haskell", "elixir", "erlang", "zig",
            "bash", "shell", "html", "css", "scss", "less",
            "yaml", "yml", "scala", "r", "nix", "ocaml",
        ];
        for lang in &langs {
            assert!(
                detect_lsp(lang).is_some(),
                "LSP should be configured for: {}", lang
            );
        }
    }

    #[test]
    fn test_unsupported_language_returns_none() {
        assert!(detect_lsp("markdown").is_none());
        assert!(detect_lsp("json").is_none());
        assert!(detect_lsp("plaintext").is_none());
        assert!(detect_lsp("nonsense").is_none());
    }

    #[test]
    fn test_python_lsp_has_expected_command() {
        let (cmd, args) = detect_lsp("python").unwrap();
        assert_eq!(cmd, "pyright-langserver");
        assert!(args.contains(&"--stdio"));
    }

    #[test]
    fn test_rust_lsp_has_expected_command() {
        let (cmd, args) = detect_lsp("rust").unwrap();
        assert_eq!(cmd, "rust-analyzer");
        assert!(args.is_empty());
    }

    #[test]
    fn test_typescript_and_javascript_share_lsp() {
        let (ts_cmd, _) = detect_lsp("typescript").unwrap();
        let (js_cmd, _) = detect_lsp("javascript").unwrap();
        assert_eq!(ts_cmd, js_cmd);
    }
}