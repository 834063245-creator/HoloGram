// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// MCP Process Manager — 持久 MCP 进程生命周期管理
// Step 2: Rust 引擎替代 Python — engine.exe serve 替换 python -m src_python serve
//
// 设计：
//   McpManager 掌管一个长期运行的 Rust Engine MCP Server 子进程。
//   通过 stdin/stdout JSON-RPC 通信，避免每次工具调用都冷启动。
//   崩溃追踪：60 秒内 3 次崩溃 → 永久降级，前端自动回退 CLI。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

pub struct McpManager {
    child: Option<Child>,
    request_id: u64,
    crash_count: u32,
    crash_window_start: Option<Instant>,
    pub degraded: bool,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            child: None,
            request_id: 0,
            crash_count: 0,
            crash_window_start: None,
            degraded: false,
        }
    }

    /// Spawn the Rust engine MCP server, wait for the ready signal, then return
    /// the tool list via tools/list.
    pub fn start(&mut self, project_root: &str, engine_path: &str) -> Result<String, String> {
        if self.degraded {
            return Err("MCP 已永久降级，请使用 CLI 模式".into());
        }

        // Kill any existing process
        self.kill_inner();

        let root = super::project_root();

        #[cfg(windows)]
        let child = {
            use std::os::windows::process::CommandExt;
            Command::new(engine_path)
                .creation_flags(super::NO_WINDOW)
                .current_dir(&root)
                .args(["serve", "--project-root", project_root])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("无法启动 MCP Server: {e}"))?
        };
        #[cfg(not(windows))]
        let child = {
            Command::new(engine_path)
                .current_dir(&root)
                .args(["serve", "--project-root", project_root])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("无法启动 MCP Server: {e}"))?
        };

        self.child = Some(child);
        self.request_id = 0;

        // Wait for the ready signal from the server (analysis may take a while)
        if let Err(e) = self.read_ready() {
            self.kill_inner(); // clean up leaked child
            return Err(e);
        }

        // Immediately fetch tool list so the frontend can build dynamic tools
        let tools = match self.send_request("tools/list", "{}") {
            Ok(t) => t,
            Err(e) => {
                self.kill_inner(); // clean up leaked child
                return Err(e);
            }
        };

        // Reset crash tracking on successful start
        self.crash_count = 0;
        self.crash_window_start = None;

        Ok(tools)
    }

    /// Stop the MCP server and reset state.
    pub fn stop(&mut self) {
        self.kill_inner();
        self.degraded = false;
        self.crash_count = 0;
        self.crash_window_start = None;
        self.request_id = 0;
    }

    // ── internals ──

    fn kill_inner(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
    }

    /// Read the JSON "ready" notification from stdout after spawning.
    /// Blocks until the server finishes analysis and signals readiness.
    /// Timeout: 600 seconds (large projects need time for layout computation).
    fn read_ready(&mut self) -> Result<(), String> {
        let child = self.child.as_mut().ok_or("子进程不存在")?;
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;

        // Spawn a thread to read the ready line with a timeout
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(_) => {
                    let _ = tx.send(Ok((reader.into_inner(), line)));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("读取 MCP 就绪信号失败: {e}")));
                }
            }
        });

        // Wait with timeout (600 seconds for large projects with layout computation)
        match rx.recv_timeout(std::time::Duration::from_secs(600)) {
            Ok(Ok((stdout_back, line))) => {
                // Put stdout back
                if let Some(ref mut child) = self.child {
                    child.stdout = Some(stdout_back);
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return Err("MCP Server 启动失败：无就绪信号".into());
                }
                // Verify it's a valid JSON ready notification
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if val.get("method").and_then(|m| m.as_str()) == Some("ready") {
                        eprintln!("[mcp] 就绪信号已收到");
                        return Ok(());
                    }
                }
                // Not a ready signal — the server might have errored
                Err(format!("MCP Server 异常启动输出: {trimmed}"))
            }
            Ok(Err(e)) => Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.kill_inner();
                Err("MCP Server 启动超时（600秒），项目分析 + 布局计算可能耗时过长".into())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("MCP Server 读取线程异常断开".into())
            }
        }
    }

    /// Send a JSON-RPC request (method + params as JSON string) and extract
    /// the text content from the response.
    fn send_request(&mut self, method: &str, params_json: &str) -> Result<String, String> {
        let id = self.request_id;
        self.request_id += 1;

        let request = format!(
            r#"{{"jsonrpc":"2.0","id":{},"method":"{}","params":{}}}"#,
            id, method, params_json
        );

        self.send_raw(&request)
    }

    /// Write a raw JSON-RPC line to stdin, read one line from stdout,
    /// and extract the result text.
    fn send_raw(&mut self, json_line: &str) -> Result<String, String> {
        let child = self.child.as_mut().ok_or("MCP Server 未启动")?;

        // Write request to stdin
        {
            let stdin = child.stdin.as_mut().ok_or("stdin 不可用")?;
            writeln!(stdin, "{}", json_line)
                .map_err(|e| format!("写入 stdin 失败: {e}"))?;
            stdin
                .flush()
                .map_err(|e| format!("flush stdin 失败: {e}"))?;
        }

        // Read response from stdout (take, read, put back)
        let response_line = {
            let stdout = child.stdout.take().ok_or("stdout 不可用")?;
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("读取响应失败: {e}"))?;
            child.stdout = Some(reader.into_inner());
            line
        };

        let trimmed = response_line.trim();
        if trimmed.is_empty() {
            return Err("MCP 返回空响应".into());
        }

        // Parse JSON-RPC response
        let resp: serde_json::Value =
            serde_json::from_str(trimmed).map_err(|e| format!("JSON-RPC 解析失败: {e} — raw: {}", trimmed))?;

        // Check for JSON-RPC error
        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
            return Err(format!("MCP 错误: {msg}"));
        }

        // Extract result content
        let result = resp.get("result").ok_or("响应无 result 字段")?;

        // For tools/list, return the full result as JSON
        if let Some(content) = result.get("content") {
            if let Some(items) = content.as_array() {
                for item in items {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            return Ok(text.to_string());
                        }
                    }
                }
            }
        }

        // tools/list returns {tools: [...]} directly, not wrapped in content
        if let Some(_tools) = result.get("tools") {
            return Ok(serde_json::to_string(result).unwrap_or_default());
        }

        // Fallback: return the entire result as a JSON string
        Ok(serde_json::to_string(result).unwrap_or_default())
    }

}
