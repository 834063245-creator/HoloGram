// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram v4 Phase 0 — Unity 进程生命周期管理器
// 最小化桩：启动 Unity.exe，验证已启动，提供终止功能。

use std::process::{Child, Command};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct UnityManager {
    process: Mutex<Option<Child>>,
    exe_path: PathBuf,
}

impl UnityManager {
    pub fn new(exe_path: PathBuf) -> Self {
        Self { process: Mutex::new(None), exe_path }
    }

    /// 将 Unity 作为子进程启动。
    /// 进程成功启动时返回 true。
    pub fn start(&self) -> Result<bool, String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(true); // 已在运行
        }

        let child = Command::new(&self.exe_path)
            .args(["-batchmode", "-nographics"]) // Phase 0: 无头模式，直到需要窗口
            .spawn()
            .map_err(|e| format!("Failed to spawn Unity: {}", e))?;

        crate::os_sandbox::assign_to_job(&child);
        *guard = Some(child);
        Ok(true)
    }

    /// 检查 Unity 进程是否仍在运行。
    pub fn is_running(&self) -> bool {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(ref mut child) = *guard {
                match child.try_wait() {
                    Ok(None) => return true,  // 仍在运行
                    Ok(Some(_)) => return false, // 已退出
                    Err(_) => return false,
                }
            }
        }
        false
    }

    /// 终止 Unity 进程。
    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *guard {
            child.kill().map_err(|e| format!("Failed to kill Unity: {}", e))?;
            child.wait().ok();
        }
        *guard = None;
        Ok(())
    }

    /// 返回 Unity 可执行文件的预期路径。
    /// Phase 0 阶段硬编码；后续从配置读取。
    pub fn default_exe_path() -> PathBuf {
        PathBuf::from(r"D:\2022.3.62f3c1\Editor\Unity.exe")
    }
}
