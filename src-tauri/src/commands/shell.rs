// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Shell 执行：exec_command、bash_output、bash_wait、bash_kill、shell_env。

use std::thread;
use std::time::Duration;

use tauri::Emitter;

use crate::utils::truncate_output_spill;

/// 当前 shell 环境 — 前端注入 Agent system prompt 用（见 os_sandbox::shell_env）。
#[tauri::command]
pub(crate) fn shell_env() -> String {
    serde_json::to_string(&crate::os_sandbox::shell_env())
        .unwrap_or_else(|_| r#"{"os":"unknown","shell":"unknown","shell_path":"","notes":""}"#.into())
}

#[tauri::command]
pub(crate) async fn exec_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: Option<bool>,
    is_agent: Option<bool>,
    stream_tool_id: Option<String>,
    agent_id: Option<String>,
    interpreter: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // P5：解释器选择（"pwsh" → PowerShell；其余/缺省 → 捆绑 bash 阶梯）
    let shell_kind = match interpreter.as_deref() {
        Some("pwsh") => crate::os_sandbox::ShellInterpreter::Pwsh,
        _ => crate::os_sandbox::ShellInterpreter::Auto,
    };
    // 默认 cwd = 当前工作区根（而非应用安装目录 project_root()）——
    // 否则切换工作区后 Agent 省略 cwd 时，命令会在 HoloGram 自身目录执行。
    let dir = match cwd {
        Some(c) => c,
        None => crate::utils::workspace_path(&state)?,
    };

    let is_bg = run_in_background.unwrap_or(false);
    let physical_dir = if is_bg {
        crate::utils::require_command_sync(&command, &state)?;
        crate::utils::require_read_sync(&dir, agent_id.as_deref(), &state)?
    } else {
        crate::utils::require_command(&command, &state, &app).await?;
        crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), agent_id.as_deref(), &state, &app).await?
    };
    let physical_dir_str = physical_dir.to_string_lossy().to_string();

    // ── BuildLock：原子检查+注册（Tauri 单进程 + Mutex，无 TOCTOU）──
    // 冲突 → 打回（带路径错误，LLM 决策）；无冲突 → 持锁执行，随 job 释放。
    let job_id = crate::utils::next_job_id();
    let lock_key = crate::utils::acquire_build_lock(&command, &physical_dir_str, job_id, agent_id.clone())?;

    if is_bg {
        let id = crate::utils::spawn_bg_with(job_id, &command, &physical_dir_str, shell_kind, agent_id, lock_key)?;
        return Ok(format!("[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_wait({}) 等待完成, bash_kill({}) 终止任务", id, id, id, id));
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let mut child = match crate::os_sandbox::spawn_shell_with(&command, &physical_dir_str, shell_kind) {
        Ok(c) => c,
        Err(e) => {
            crate::utils::release_build_lock(&lock_key);
            return Err(format!("无法执行命令: {e}"));
        }
    };

    // ── 流式路径：通过 Tauri 事件发送数据块 ──
    if let Some(stream_id) = stream_tool_id.clone() {
        let stdout_reader = child.take_stdout();
        let stderr_reader = child.take_stderr();

        // 共享输出缓冲区 — 管道被 take 后，转后台时 bg job 从这里读。
        use std::sync::{Arc, Mutex};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let shared_out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let shared_err: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

        // 输出线程完成计数(0=none, 1=stdout, 2=stderr, 3=both)。
        // join 不能无超时阻塞:bash 退出后孙进程(cargo→rustc/test 子进程)
        // 可能短暂持有管道写端句柄,read_vectored 阻塞等待 → 线程不退出 →
        // join 无限拖住 shell:done → 前端"任务已结束但卡片卡在执行中"。
        // 用计数 + 有界等待替代 join,超时直接发 done。
        let drain_done: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));

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
        stdout_reader.map(|mut reader| {
            let dd = Arc::clone(&drain_done);
            std::thread::spawn(move || {
                use std::io::{IoSliceMut, Read};
                // 增量编码解码（2026-08-17）：跨 4KB 块边界的多字节 UTF-8
                // 不再被 from_utf8_lossy 切成 U+FFFD；GBK 输出自动转码。
                let mut dec = crate::utils::StreamDecoder::new();
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
                    let chunk = dec.push(&buf[..n]);
                    if !chunk.is_empty() {
                        let _ = app_stdout.emit("shell:output", serde_json::json!({
                            "streamId": sid_stdout,
                            "kind": "stdout",
                            "chunk": chunk,
                        }));
                    }
                    crate::utils::append_shared_bounded(&mut *crate::utils::lock_or_recover(&so_clone), &buf[..n]);
                }
                // EOF：清空解码器残余（不完整序列 / GBK 尾）
                let tail = dec.finish();
                if !tail.is_empty() {
                    let _ = app_stdout.emit("shell:output", serde_json::json!({
                        "streamId": sid_stdout,
                        "kind": "stdout",
                        "chunk": tail,
                    }));
                }
                dd.fetch_add(1, Ordering::SeqCst);
            })
        });

        // 在后台线程中排空 stderr（同上，read_vectored 逐块实时 emit）
        let stream_id_stderr = stream_id.clone();
        let se_clone = Arc::clone(&shared_err);
        stderr_reader.map(|mut reader| {
            let dd = Arc::clone(&drain_done);
            std::thread::spawn(move || {
                use std::io::{IoSliceMut, Read};
                // 与 stdout 同款增量编码解码（2026-08-17）
                let mut dec = crate::utils::StreamDecoder::new();
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
                    let chunk = dec.push(&buf[..n]);
                    if !chunk.is_empty() {
                        let _ = app_stderr.emit("shell:output", serde_json::json!({
                            "streamId": stream_id_stderr,
                            "kind": "stderr",
                            "chunk": chunk,
                        }));
                    }
                    crate::utils::append_shared_bounded(&mut *crate::utils::lock_or_recover(&se_clone), &buf[..n]);
                }
                let tail = dec.finish();
                if !tail.is_empty() {
                    let _ = app_stderr.emit("shell:output", serde_json::json!({
                        "streamId": stream_id_stderr,
                        "kind": "stderr",
                        "chunk": tail,
                    }));
                }
                dd.fetch_add(1, Ordering::SeqCst);
            })
        });

        // P1-21: 注册进 ledger — 工作区切换 kill_all_bg 能终止运行中的流式命令；
        // 前端 abort 也能按 job_id 调 bash_kill（job_id 经 started 响应暴露给 JS）。
        let label: String = command.chars().take(80).collect();
        let shared = crate::utils::BgSharedOutput {
            stdout: Arc::clone(&shared_out),
            stderr: Arc::clone(&shared_err),
            drain_done: Arc::clone(&drain_done),
        };
        crate::utils::register_fg_child(job_id, child, &label, shared, agent_id, lock_key);

        // 在后台等待子进程，发送完成事件 / 超时杀进程树
        let app_done = app.clone();
        let sid_done = stream_id.clone();
        let timeout_ms_val = timeout_ms.unwrap_or(300_000);
        let drain_flag = Arc::clone(&drain_done);
        std::thread::spawn(move || {
            enum Poll {
                Running,
                Done(i32),
                Gone,
            }
            let start = std::time::Instant::now();
            loop {
                let poll = {
                    let mut jobs = crate::utils::lock_or_recover(&crate::utils::BG_JOBS);
                    match jobs.get_mut(&job_id) {
                        Some(job) => match job.child.try_wait() {
                            Ok(Some(st)) => Poll::Done(st.code().unwrap_or(-1)),
                            Ok(None) => Poll::Running,
                            Err(_) => Poll::Gone,
                        },
                        // job 被 bash_kill / kill_all_bg 移除 → 视为已终止
                        None => Poll::Gone,
                    }
                };
                match poll {
                    Poll::Done(code) => {
                        // 有界等待输出线程收尾(最多 3s):孙进程短暂持管时
                        // read_vectored 阻塞,但 shell:done 不能因此延迟。
                        // 超时则放弃 — 输出线程在后台自行退出(写端最终关闭)。
                        let deadline = std::time::Instant::now() + Duration::from_secs(3);
                        while drain_flag.load(Ordering::SeqCst) < 2
                            && std::time::Instant::now() < deadline
                        {
                            thread::sleep(Duration::from_millis(20));
                        }
                        crate::utils::remove_job(job_id);
                        let _ = app_done.emit("shell:done", serde_json::json!({
                            "streamId": sid_done,
                            "exitCode": code,
                        }));
                        return;
                    }
                    Poll::Running => {
                        if start.elapsed() >= Duration::from_millis(timeout_ms_val) {
                            // 超时杀进程树（不再转后台）——
                            // 转后台会让进程残留并继续持有构建锁（target/ 等），
                            // 队列放行的后续命令实际卡在 OS 文件锁上连锁超时。
                            // 长任务应走 runInBackground: true（工具描述已引导）。
                            {
                                let mut jobs = crate::utils::lock_or_recover(&crate::utils::BG_JOBS);
                                if let Some(job) = jobs.get_mut(&job_id) {
                                    let _ = job.child.kill_tree();
                                }
                            }
                            // 有界等待输出线程收尾（与 Done 路径一致）：kill 后
                            // 管道写端随进程树关闭，read_vectored 很快收到 EOF。
                            let deadline = std::time::Instant::now() + Duration::from_secs(3);
                            while drain_flag.load(Ordering::SeqCst) < 2
                                && std::time::Instant::now() < deadline
                            {
                                thread::sleep(Duration::from_millis(20));
                            }
                            crate::utils::remove_job(job_id);
                            let msg = format!(
                                "命令超时 ({}ms)，已终止（进程树已杀）。长任务请用 runInBackground: true 启动后用 bash_wait 等待。",
                                timeout_ms_val
                            );
                            let _ = app_done.emit("shell:done", serde_json::json!({
                                "streamId": sid_done,
                                "exitCode": -1,
                                "error": msg,
                            }));
                            return;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    Poll::Gone => {
                        crate::utils::remove_job(job_id);
                        let _ = app_done.emit("shell:done", serde_json::json!({
                            "streamId": sid_done,
                            "exitCode": -1,
                            "error": "命令执行异常或已被终止",
                        }));
                        return;
                    }
                }
            }
        });

        return Ok(serde_json::json!({
            "streamId": stream_id,
            "status": "started",
            // 暴露 ledger job_id — 前端 abort 时据此调 bash_kill 终止进程树
            // （此前流式命令无法按 streamId 终止，abort 后进程变幽灵继续占队列）
            "job_id": job_id,
        }).to_string());
    }

    // ── 非流式路径（原始阻塞行为） ──
    let stdout_drainer = pipe_drainer(child.take_stdout());
    let stderr_drainer = pipe_drainer(child.take_stderr());

    // P1-21: 前台命令也注册进 ledger（不 spawn monitor — 本路径自己等待并移除）。
    // 工作区切换 kill_all_bg 能终止仍在运行的前台命令，避免跨工作区残留进程。
    use std::sync::{Arc, Mutex};
    let shared = crate::utils::BgSharedOutput {
        stdout: Arc::new(Mutex::new(Vec::new())),
        stderr: Arc::new(Mutex::new(Vec::new())),
        drain_done: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };
    let label: String = command.chars().take(80).collect();
    crate::utils::register_fg_child(job_id, child, &label, shared, agent_id, lock_key);

    // P1-16：try_wait+sleep 忙等是阻塞循环，移入 spawn_blocking——
    // 否则一条长命令（默认上限 300s）占住一个 tokio worker，并发命令叠加可耗尽线程池。
    let timeout_ms_val = timeout_ms.unwrap_or(300_000);
    let result = tokio::task::spawn_blocking(move || {
        let r = wait_child_blocking(job_id, stdout_drainer, stderr_drainer, timeout, timeout_ms_val);
        // 命令结束（含超时/错误）→ 从 ledger 移除（锁随 job 释放）
        crate::utils::remove_job(job_id);
        r
    })
    .await
    .map_err(|e| format!("命令等待任务异常: {e}"))?;
    result
}

/// 为子进程管道起 drainer 线程：read_to_end 后经 channel 送回，避免管道写满阻塞子进程。
fn pipe_drainer(
    reader: Option<Box<dyn std::io::Read + Send + Unpin>>,
) -> Option<std::sync::mpsc::Receiver<Vec<u8>>> {
    reader.map(|mut r| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut r, &mut v);
            let _ = tx.send(v);
        });
        rx
    })
}

/// 非流式路径的阻塞等待：轮询子进程退出，收集 drainer 输出，超时杀进程树。
/// 必须运行在阻塞线程上（spawn_blocking），不得内联在 async worker。
/// P1-21: child 已注册进 BG_JOBS ledger（register_fg_child），本函数按 job_id
/// 从 ledger 取 child 轮询 — kill_all_bg（工作区切换）可随时终止它。
fn wait_child_blocking(
    job_id: u32,
    stdout_drainer: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    stderr_drainer: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    timeout: Duration,
    timeout_ms_val: u64,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    loop {
        let status = {
            let mut jobs = crate::utils::lock_or_recover(&crate::utils::BG_JOBS);
            match jobs.get_mut(&job_id) {
                Some(job) => job.child.try_wait(),
                // job 被 kill_bg / kill_all_bg 移除 → 视为已终止
                None => return Err("后台任务不存在或已被终止".into()),
            }
        };
        match status {
            Ok(Some(status)) => {
                let stdout = stdout_drainer
                    .as_ref()
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| crate::utils::decode_shell_bytes(&v))
                    .unwrap_or_default();
                let stderr = stderr_drainer
                    .as_ref()
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| crate::utils::decode_shell_bytes(&v))
                    .unwrap_or_default();

                let full_output = if stdout.is_empty() && stderr.is_empty() {
                    "(无输出)".into()
                } else {
                    truncate_output_spill(&format!("{}{}", stdout, stderr), &format!("job-{job_id}"))
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
                    crate::utils::lock_or_recover(&crate::utils::BG_JOBS)
                        .get_mut(&job_id)
                        .and_then(|j| j.child.kill_tree().ok());
                    let stdout = stdout_drainer
                        .as_ref()
                        .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                        .map(|v| crate::utils::decode_shell_bytes(&v))
                        .unwrap_or_default();
                    let stderr = stderr_drainer
                        .as_ref()
                        .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                        .map(|v| crate::utils::decode_shell_bytes(&v))
                        .unwrap_or_default();
                    return Ok(truncate_output_spill(
                        &format!(
                            "[exit code: -1] 命令超时 ({}ms)，已终止。可拆小命令或增大 timeoutMs 后重试。\n{}{}",
                            timeout_ms_val,
                            stdout,
                            stderr
                        ),
                        &format!("job-{job_id}"),
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                crate::utils::lock_or_recover(&crate::utils::BG_JOBS)
                    .get_mut(&job_id)
                    .and_then(|j| j.child.kill_tree().ok());
                return Err(format!("命令执行异常: {e}"));
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn bash_output(job_id: u32) -> Result<String, String> {
    crate::utils::read_bg_output(job_id).map(|s| truncate_output_spill(&s, &format!("bg-job-{job_id}")))
}

#[tauri::command]
pub(crate) async fn bash_kill(job_id: u32, agent_id: Option<String>) -> Result<String, String> {
    crate::utils::kill_bg(job_id, agent_id.as_deref())
}

#[tauri::command]
pub(crate) async fn bash_wait(job_id: u32, timeout_ms: Option<u64>) -> Result<String, String> {
    crate::utils::wait_bg(job_id, timeout_ms.unwrap_or(60_000)).map(|s| truncate_output_spill(&s, &format!("bg-job-{job_id}")))
}

#[tauri::command]
pub(crate) async fn drain_bg_notifications() -> Result<String, String> {
    Ok(crate::utils::drain_bg_notifications())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn empty_shared() -> crate::utils::BgSharedOutput {
        use std::sync::{Arc, Mutex};
        crate::utils::BgSharedOutput {
            stdout: Arc::new(Mutex::new(Vec::new())),
            stderr: Arc::new(Mutex::new(Vec::new())),
            drain_done: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    /// 前台等待辅助：注册进 ledger（与 exec_command 非流式路径一致），完成后移除。
    fn run_wait(cmd: &str, timeout_ms: u64) -> Result<String, String> {
        let mut child = crate::os_sandbox::spawn_shell(cmd, ".").expect("spawn_shell failed");
        let stdout = pipe_drainer(child.take_stdout());
        let stderr = pipe_drainer(child.take_stderr());
        let job_id = crate::utils::next_job_id();
        crate::utils::register_fg_child(job_id, child, cmd, empty_shared(), None, None);
        let r = wait_child_blocking(
            job_id,
            stdout,
            stderr,
            Duration::from_millis(timeout_ms),
            timeout_ms,
        );
        crate::utils::remove_job(job_id);
        r
    }

    // P1-16 回归：阻塞等待移入 spawn_blocking 后行为不变
    #[test]
    fn test_wait_child_blocking_success_output() {
        let out = run_wait("echo hello-p116", 30_000).unwrap();
        assert!(out.contains("hello-p116"), "unexpected output: {out}");
    }

    #[test]
    fn test_wait_child_blocking_exit_code() {
        let out = run_wait("exit 3", 30_000).unwrap();
        assert!(out.contains("[exit code: 3]"), "unexpected output: {out}");
    }

    #[test]
    fn test_wait_child_blocking_timeout_kills() {
        let start = std::time::Instant::now();
        let out = run_wait("sleep 30", 500).unwrap();
        assert!(out.contains("命令超时"), "unexpected output: {out}");
        // 超时即终止进程树，不得等满 sleep 30
        assert!(start.elapsed() < Duration::from_secs(20), "took {:?}", start.elapsed());
    }

    // P1-21 回归：前台命令注册进 ledger（kill_all_bg 可遍历终止）；
    // job 被移除（kill_bg/kill_all_bg）后 wait 立即报告「已被终止」。
    // 注意：不调真实 kill_all_bg —— 它清空全局 BG_JOBS，会干扰并行测试的其他 job。
    #[test]
    fn test_fg_command_killed_by_ledger_removal() {
        let mut child = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        let stdout = pipe_drainer(child.take_stdout());
        let stderr = pipe_drainer(child.take_stderr());
        let job_id = crate::utils::next_job_id();
        crate::utils::register_fg_child(job_id, child, "sleep 30", empty_shared(), None, None);
        // 注册生效：ledger 中可见（kill_all_bg 遍历能杀到它）
        assert!(
            crate::utils::lock_or_recover(&crate::utils::BG_JOBS).contains_key(&job_id),
            "前台命令应注册进 ledger"
        );
        // 模拟 kill_all_bg / kill_bg 移除 job → wait 立即报「已被终止」
        crate::utils::remove_job(job_id);
        let r = wait_child_blocking(job_id, stdout, stderr, Duration::from_secs(10), 10_000);
        assert!(r.is_err(), "wait 应因 job 被移除而报错, got {r:?}");
        assert!(r.unwrap_err().contains("已被终止"), "unexpected err");
    }

    // P1-21 回归：前台命令正常完成后，ledger 中不再残留该 job
    #[test]
    fn test_fg_command_removed_after_completion() {
        let mut child = crate::os_sandbox::spawn_shell("echo p121-done", ".").expect("spawn_shell failed");
        let stdout = pipe_drainer(child.take_stdout());
        let stderr = pipe_drainer(child.take_stderr());
        let job_id = crate::utils::next_job_id();
        crate::utils::register_fg_child(job_id, child, "echo p121-done", empty_shared(), None, None);
        let r = wait_child_blocking(job_id, stdout, stderr, Duration::from_secs(10), 10_000);
        crate::utils::remove_job(job_id);
        assert!(r.as_ref().unwrap().contains("p121-done"), "unexpected output: {r:?}");
        assert!(
            crate::utils::lock_or_recover(&crate::utils::BG_JOBS).get(&job_id).is_none(),
            "job {job_id} 应已从 ledger 移除"
        );
    }
}
