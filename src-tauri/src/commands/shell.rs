// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Shell execution: exec_command, bash_output, bash_kill.

use std::thread;
use std::time::Duration;

#[tauri::command]
pub(crate) async fn exec_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: Option<bool>,
    is_agent: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
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
                    child.kill().ok();
                    return Err(format!("命令超时 ({}ms)，已强制终止", timeout_ms.unwrap_or(300_000)));
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
