// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Shell 执行：exec_command、bash_output、bash_wait、bash_kill。

use std::thread;
use std::time::Duration;

use tauri::Emitter;

#[tauri::command]
pub(crate) async fn exec_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: Option<bool>,
    is_agent: Option<bool>,
    stream_tool_id: Option<String>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let dir = cwd.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());

    let is_bg = run_in_background.unwrap_or(false);
    let physical_dir = if is_bg {
        crate::utils::require_command_sync(&command, &state)?;
        crate::utils::require_read_sync(&dir, _agent_id.as_deref(), &state)?
    } else {
        crate::utils::require_command(&command, &state, &app).await?;
        crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?
    };
    let physical_dir_str = physical_dir.to_string_lossy().to_string();

    if is_bg {
        let id = crate::utils::spawn_bg(&command, &physical_dir_str)?;
        return Ok(format!("[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_wait({}) 等待完成, bash_kill({}) 终止任务", id, id, id, id));
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let mut child = crate::os_sandbox::spawn_shell(&command, &physical_dir_str)
        .map_err(|e| format!("无法执行命令: {e}"))?;

    // ── 流式路径：通过 Tauri 事件发送数据块 ──
    if let Some(stream_id) = stream_tool_id.clone() {
        let stdout_reader = child.take_stdout();
        let stderr_reader = child.take_stderr();

        // 共享输出缓冲区 — 管道被 take 后，转后台时 bg job 从这里读。
        use std::sync::{Arc, Mutex};
        let shared_out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let shared_err: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

        let app_stdout = app.clone();
        let sid_stdout = stream_id.clone();
        let app_stderr = app.clone();
        let so_clone = Arc::clone(&shared_out);

        // 在后台线程中排空 stdout，逐块 emit 到事件 + 累积到共享 Arc。
        // 必须用 read_vectored:裸 read() 在此手工管道上第二次调用会永久阻塞
        // (复现测试证实,卡 Windows 管道 4KB 边界 → bash/cargo 写端阻塞 →
        // 子进程永不退出 → shell:done 永不发出 → Agent loop 无限等待)。
        // read_to_end 能读完但憋到 EOF,长命令期间一个字节都不 emit → 前端假卡。
        // read_vectored 逐块可靠(191ms/23KB 实测),每块实时 emit,两者兼得。
        let stdout_thread = stdout_reader.map(|mut reader| {
            std::thread::spawn(move || {
                use std::io::{IoSliceMut, Read};
                let mut buf = [0u8; 4096];
                loop {
                    let n = {
                        let mut iov = [IoSliceMut::new(&mut buf)];
                        match reader.read_vectored(&mut iov) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(_) => break,
                        }
                    };
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_stdout.emit("shell:output", serde_json::json!({
                        "streamId": sid_stdout,
                        "kind": "stdout",
                        "chunk": chunk,
                    }));
                    so_clone.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            })
        });

        // 在后台线程中排空 stderr（同上，read_vectored 逐块实时 emit）
        let stream_id_stderr = stream_id.clone();
        let se_clone = Arc::clone(&shared_err);
        let stderr_thread = stderr_reader.map(|mut reader| {
            std::thread::spawn(move || {
                use std::io::{IoSliceMut, Read};
                let mut buf = [0u8; 4096];
                loop {
                    let n = {
                        let mut iov = [IoSliceMut::new(&mut buf)];
                        match reader.read_vectored(&mut iov) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(_) => break,
                        }
                    };
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_stderr.emit("shell:output", serde_json::json!({
                        "streamId": stream_id_stderr,
                        "kind": "stderr",
                        "chunk": chunk,
                    }));
                    se_clone.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            })
        });

        // 在后台等待子进程，发送完成事件 / 超时转后台
        let app_done = app.clone();
        let sid_done = stream_id.clone();
        let timeout_ms_val = timeout_ms.unwrap_or(300_000);
        let cmd_for_bg = command.clone();
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if let Some(t) = stdout_thread { let _ = t.join(); }
                        if let Some(t) = stderr_thread { let _ = t.join(); }
                        let _ = app_done.emit("shell:done", serde_json::json!({
                            "streamId": sid_done,
                            "exitCode": status.code().unwrap_or(-1),
                        }));
                        return;
                    }
                    Ok(None) => {
                        if start.elapsed() >= Duration::from_millis(timeout_ms_val) {
                            // 转后台:管道被 take 了但输出已通过共享 Arc 保存,
                            // bg job 从 shared_out/shared_err 读取,不受管道所有权影响。
                            let label: String = cmd_for_bg.chars().take(80).collect();
                            let shared = crate::utils::BgSharedOutput {
                                stdout: Arc::clone(&shared_out),
                                stderr: Arc::clone(&shared_err),
                            };
                            match crate::utils::spawn_bg_from_child_shared(child, &label, shared) {
                                Ok(job_id) => {
                                    let msg = format!(
                                        "命令超时 ({}ms)，已转为后台任务 (ID: {})。使用 bash_output({}) 查看输出, bash_wait({}) 等待完成, bash_kill({}) 终止。",
                                        timeout_ms_val, job_id, job_id, job_id, job_id
                                    );
                                    crate::utils::push_bg_note(&msg);
                                    let _ = app_done.emit("shell:done", serde_json::json!({
                                        "streamId": sid_done,
                                        "exitCode": -1,
                                        "error": msg,
                                    }));
                                }
                                Err(e) => {
                                    let _ = app_done.emit("shell:done", serde_json::json!({
                                        "streamId": sid_done,
                                        "exitCode": -1,
                                        "error": format!("命令超时且转后台失败: {}", e),
                                    }));
                                }
                            }
                            return;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => {
                        let _ = app_done.emit("shell:done", serde_json::json!({
                            "streamId": sid_done,
                            "exitCode": -1,
                            "error": "命令执行异常",
                        }));
                        return;
                    }
                }
            }
        });

        return Ok(serde_json::json!({
            "streamId": stream_id,
            "status": "started"
        }).to_string());
    }

    // ── 非流式路径（原始阻塞行为） ──
    let stdout_drainer = child.take_stdout().map(|mut reader| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut reader, &mut v);
            let _ = tx.send(v);
        });
        rx
    });
    let stderr_drainer = child.take_stderr().map(|mut reader| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut reader, &mut v);
            let _ = tx.send(v);
        });
        rx
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_drainer
                    .as_ref()
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| String::from_utf8_lossy(&v).to_string())
                    .unwrap_or_default();
                let stderr = stderr_drainer
                    .as_ref()
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| String::from_utf8_lossy(&v).to_string())
                    .unwrap_or_default();

                let full_output = if stdout.is_empty() && stderr.is_empty() {
                    "(无输出)".into()
                } else {
                    format!("{}{}", stdout, stderr)
                };

                if !status.success() {
                    return Ok(format!(
                        "[exit code: {}]\n{}",
                        status.code().unwrap_or(-1),
                        full_output
                    ));
                }

                return Ok(full_output);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    // 终止进程树而非转后台 — 非流式路径的 stdout 已被 take 走,
                    // 转后台后同样收不回输出,agent 只会反复重跑。终止并带回已收集的输出。
                    child.kill_tree().ok();
                    let stdout = stdout_drainer
                        .as_ref()
                        .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                        .map(|v| String::from_utf8_lossy(&v).to_string())
                        .unwrap_or_default();
                    let stderr = stderr_drainer
                        .as_ref()
                        .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                        .map(|v| String::from_utf8_lossy(&v).to_string())
                        .unwrap_or_default();
                    return Ok(format!(
                        "[exit code: -1] 命令超时 ({}ms)，已终止。可拆小命令或增大 timeoutMs 后重试。\n{}{}",
                        timeout_ms.unwrap_or(300_000),
                        stdout,
                        stderr
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                child.kill().ok();
                return Err(format!("命令执行异常: {e}"));
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn bash_output(job_id: u32) -> Result<String, String> {
    crate::utils::read_bg_output(job_id)
}

#[tauri::command]
pub(crate) async fn bash_kill(job_id: u32) -> Result<String, String> {
    crate::utils::kill_bg(job_id)
}

#[tauri::command]
pub(crate) async fn bash_wait(job_id: u32, timeout_ms: Option<u64>) -> Result<String, String> {
    crate::utils::wait_bg(job_id, timeout_ms.unwrap_or(60_000))
}

#[tauri::command]
pub(crate) async fn drain_bg_notifications() -> Result<String, String> {
    Ok(crate::utils::drain_bg_notifications())
}