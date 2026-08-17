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
    /// 启动纪元——start/stop 都自增。start 的长等待（read_ready 最长 600s）不持锁，
    /// 完成后比对纪元：已变说明期间被 stop 或被新 start 取代，本进程自杀（P1-19）。
    epoch: u64,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            child: None,
            request_id: 0,
            crash_count: 0,
            crash_window_start: None,
            degraded: false,
            epoch: 0,
        }
    }

    /// 阶段 1（持锁，短）：杀旧进程、spawn 新进程，返回 (纪元, 子进程)。
    /// 长等待（wait_ready / tools/list）由调用方在不持锁的情况下完成，
    /// 然后调 finish_start 安装。
    /// P1-19：旧实现的 start 持 MCP_MANAGER 锁最长 600s，期间 stop_mcp 的
    /// try_lock 静默跳过 → 旧 serve 进程残留 + 新 start 卡死（"切换项目卡死"）。
    pub fn begin_start(&mut self, project_root: &str, engine_path: &str) -> Result<(u64, Child), String> {
        if self.degraded {
            return Err("MCP 已永久降级，请使用 CLI 模式".into());
        }

        // 终止任何已有进程
        self.kill_inner();
        self.epoch += 1;

        let root = crate::utils::project_root();

        #[cfg(windows)]
        let child = {
            use std::os::windows::process::CommandExt;
            Command::new(engine_path)
                // engine serve 可能拉起子进程（子 Agent/工具）→ 需隐藏控制台继承
                .creation_flags(crate::utils::HIDDEN_CONSOLE)
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

        crate::os_sandbox::assign_to_job(&child);
        Ok((self.epoch, child))
    }

    /// 阶段 3（持锁，短）：长等待通过后安装子进程并重置状态。
    /// 纪元已变（期间被 stop / 新 start 取代）→ 杀本子进程并报错，不安装。
    pub fn finish_start(&mut self, epoch: u64, mut child: Child, tools: String) -> Result<String, String> {
        if epoch != self.epoch {
            let _ = child.kill();
            let _ = child.wait();
            return Err("MCP 启动期间被停止或取代，子进程已清理".into());
        }
        self.child = Some(child);
        self.request_id = 0;

        // 成功启动后重置崩溃追踪
        self.crash_count = 0;
        self.crash_window_start = None;

        Ok(tools)
    }

    /// 停止 MCP 服务器并重置状态。纪元自增——使任何进行中的 start 在
    /// finish_start 时发现已过期并自杀子进程。
    pub fn stop(&mut self) {
        self.kill_inner();
        self.epoch += 1;
        self.degraded = false;
        self.crash_count = 0;
        self.crash_window_start = None;
        self.request_id = 0;
    }

    // ── 内部实现 ──

    fn kill_inner(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
    }

    /// 从子进程 stdout 读取 JSON "ready" 通知（启动后）。
    /// 阻塞直到服务器完成分析并发出就绪信号。
    /// 超时：600 秒（大型项目需要时间进行布局计算）。
    /// 关联函数操作传入的 child 而非 self——调用方在不持全局锁的情况下等待，
    /// 失败时由调用方负责 kill 子进程（P1-19）。
    pub fn wait_ready(child: &mut Child) -> Result<(), String> {
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;

        // 启动一个线程读取就绪行，带超时
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

        // 带超时等待（大型项目布局计算需要 600 秒）
        match rx.recv_timeout(std::time::Duration::from_secs(600)) {
            Ok(Ok((stdout_back, line))) => {
                // 将 stdout 放回
                child.stdout = Some(stdout_back);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return Err("MCP Server 启动失败：无就绪信号".into());
                }
                // 验证是否为有效的 JSON ready 通知
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if val.get("method").and_then(|m| m.as_str()) == Some("ready") {
                        eprintln!("[mcp] 就绪信号已收到");
                        return Ok(());
                    }
                }
                // 非就绪信号 — 服务器可能出错了
                Err(format!("MCP Server 异常启动输出: {trimmed}"))
            }
            Ok(Err(e)) => Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err("MCP Server 启动超时（600秒），项目分析 + 布局计算可能耗时过长".into())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("MCP Server 读取线程异常断开".into())
            }
        }
    }

    /// 发送 JSON-RPC 请求（method + params 为 JSON 字符串）并从
    /// 响应中提取文本内容。关联函数操作传入的 child（P1-19）。
    pub fn request_on(child: &mut Child, request_id: &mut u64, method: &str, params_json: &str) -> Result<String, String> {
        let id = *request_id;
        *request_id += 1;

        let request = format!(
            r#"{{"jsonrpc":"2.0","id":{},"method":"{}","params":{}}}"#,
            id, method, params_json
        );

        Self::send_raw(child, &request)
    }

    /// 向 stdin 写入一行原始 JSON-RPC，从 stdout 读取一行，
    /// 并提取 result 文本。
    fn send_raw(child: &mut Child, json_line: &str) -> Result<String, String> {

        // 将请求写入 stdin
        {
            let stdin = child.stdin.as_mut().ok_or("stdin 不可用")?;
            writeln!(stdin, "{}", json_line)
                .map_err(|e| format!("写入 stdin 失败: {e}"))?;
            stdin
                .flush()
                .map_err(|e| format!("flush stdin 失败: {e}"))?;
        }

        // 从 stdout 读取响应（取出、读取、放回）
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

        // 解析 JSON-RPC 响应
        let resp: serde_json::Value =
            serde_json::from_str(trimmed).map_err(|e| format!("JSON-RPC 解析失败: {e} — raw: {}", trimmed))?;

        // 检查 JSON-RPC 错误
        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
            return Err(format!("MCP 错误: {msg}"));
        }

        // 提取 result 内容
        let result = resp.get("result").ok_or("响应无 result 字段")?;

        // 对于 tools/list，返回完整的 result 作为 JSON
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

        // tools/list 直接返回 {tools: [...]}，未包裹在 content 中
        if let Some(_tools) = result.get("tools") {
            return Ok(serde_json::to_string(result).unwrap_or_default());
        }

        // 回退：返回整个 result 作为 JSON 字符串
        Ok(serde_json::to_string(result).unwrap_or_default())
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_child() -> Child {
        #[cfg(windows)]
        {
            Command::new("cmd")
                .args(["/c", "exit 0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
        #[cfg(not(windows))]
        {
            Command::new("sh")
                .args(["-c", "exit 0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
    }

    // P1-19 回归：纪元语义——start 长等待期间的 stop/新 start 必须使旧 start 失效
    #[test]
    fn test_finish_start_fresh_epoch_installs() {
        let mut mgr = McpManager::new();
        let epoch = mgr.epoch;
        let tools = mgr.finish_start(epoch, dummy_child(), "[]".into()).unwrap();
        assert_eq!(tools, "[]");
        assert!(mgr.child.is_some());
        mgr.stop();
        assert!(mgr.child.is_none());
    }

    #[test]
    fn test_finish_start_stale_epoch_rejected() {
        let mut mgr = McpManager::new();
        let stale = mgr.epoch;
        // 模拟 start 等待 read_ready 期间被 stop（workspace 切换路径）
        mgr.stop();
        let r = mgr.finish_start(stale, dummy_child(), "[]".into());
        assert!(r.is_err(), "过期纪元必须被拒绝");
        assert!(mgr.child.is_none(), "过期 start 不得安装子进程");
    }

    #[test]
    fn test_stop_bumps_epoch_invalidating_inflight() {
        let mut mgr = McpManager::new();
        let e0 = mgr.epoch;
        mgr.stop();
        assert_ne!(mgr.epoch, e0, "stop 必须自增纪元");
    }
}
