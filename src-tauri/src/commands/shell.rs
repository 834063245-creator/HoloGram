// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Shell execution: exec_command, bash_output, bash_kill.

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
    if let Some(id) = &_agent_id {
        let ctx = crate::utils::get_ctx(&state)?;
        ctx.set_active_agent_id_ctx(id);
    }
    let dir = cwd.unwrap_or_else(|| crate::utils::project_root().to_string_lossy().to_string());

    let is_bg = run_in_background.unwrap_or(false);
    let physical_dir = if is_bg {
        crate::utils::require_command_sync(&command, &state)?;
        crate::utils::require_read_sync(&dir, &state)?
    } else {
        crate::utils::require_command(&command, &state, &app).await?;
        crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), &state, &app).await?
    };
    let physical_dir_str = physical_dir.to_string_lossy().to_string();

    if is_bg {
        let id = crate::utils::spawn_bg(&command, &physical_dir_str)?;
        return Ok(format!("[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_kill({}) 终止任务", id, id, id));
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let mut child = crate::os_sandbox::spawn_shell(&command, &physical_dir_str)
        .map_err(|e| format!("无法执行命令: {e}"))?;

    // ── Streaming path: emit chunks via Tauri events ──
    if let Some(stream_id) = stream_tool_id.clone() {
        let stdout_reader = child.take_stdout();
        let stderr_reader = child.take_stderr();
        let app_stdout = app.clone();
        let sid_stdout = stream_id.clone();
        let app_stderr = app.clone();

        // Drain stdout in background thread, emitting chunks
        let stdout_thread = stdout_reader.map(|mut reader| {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match std::io::Read::read(&mut reader, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_stdout.emit("shell:output", serde_json::json!({
                                "streamId": sid_stdout,
                                "kind": "stdout",
                                "chunk": chunk,
                            }));
                        }
                        Err(_) => break,
                    }
                }
            })
        });

        // Drain stderr in background thread
        let stream_id_stderr = stream_id.clone();
        let stderr_thread = stderr_reader.map(|mut reader| {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match std::io::Read::read(&mut reader, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_stderr.emit("shell:output", serde_json::json!({
                                "streamId": stream_id_stderr,
                                "kind": "stderr",
                                "chunk": chunk,
                            }));
                        }
                        Err(_) => break,
                    }
                }
            })
        });

        // Wait for child in background, emit done event
        let app_done = app.clone();
        let sid_done = stream_id.clone();
        let timeout_ms_val = timeout_ms.unwrap_or(300_000);
        let cmd_for_bg = command.clone();
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        // Wait for drainer threads to finish
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
                            // Convert to background task instead of killing
                            let label: String = cmd_for_bg.chars().take(80).collect();
                            match crate::utils::spawn_bg_from_child(child, &label) {
                                Ok(job_id) => {
                                    let msg = format!(
                                        "命令超时 ({}ms)，已转为后台任务 (ID: {})。使用 bash_output({}) 查看输出, bash_kill({}) 终止。",
                                        timeout_ms_val, job_id, job_id, job_id
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

    // ── Non-streaming path (original blocking behavior) ──
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
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| String::from_utf8_lossy(&v).to_string())
                    .unwrap_or_default();
                let stderr = stderr_drainer
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
                    // Convert to background task instead of killing
                    let label: String = command.chars().take(80).collect();
                    let job_id = crate::utils::spawn_bg_from_child(child, &label)?;
                    let msg = format!(
                        "命令超时 ({}ms)，已转为后台任务 (ID: {})。使用 bash_output({}) 查看输出, bash_kill({}) 终止。",
                        timeout_ms.unwrap_or(300_000), job_id, job_id, job_id
                    );
                    crate::utils::push_bg_note(&msg);
                    return Ok(msg);
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
pub(crate) async fn drain_bg_notifications() -> Result<String, String> {
    Ok(crate::utils::drain_bg_notifications())
}
