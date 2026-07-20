// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram v4 Phase 0 — Unity process lifecycle manager
// Minimal stub: spawn Unity.exe, verify it started, provide kill.

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

    /// Spawn Unity as a child process.
    /// Returns true if the process started successfully.
    pub fn start(&self) -> Result<bool, String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(true); // already running
        }

        let child = Command::new(&self.exe_path)
            .args(["-batchmode", "-nographics"]) // Phase 0: headless until we need the window
            .spawn()
            .map_err(|e| format!("Failed to spawn Unity: {}", e))?;

        crate::os_sandbox::assign_to_job(&child);
        *guard = Some(child);
        Ok(true)
    }

    /// Check if Unity process is still alive.
    pub fn is_running(&self) -> bool {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(ref mut child) = *guard {
                match child.try_wait() {
                    Ok(None) => return true,  // still running
                    Ok(Some(_)) => return false, // exited
                    Err(_) => return false,
                }
            }
        }
        false
    }

    /// Kill the Unity process.
    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *guard {
            child.kill().map_err(|e| format!("Failed to kill Unity: {}", e))?;
            child.wait().ok();
        }
        *guard = None;
        Ok(())
    }

    /// Returns the expected path to the Unity executable.
    /// Hardcoded for Phase 0; later reads from config.
    pub fn default_exe_path() -> PathBuf {
        PathBuf::from(r"D:\2022.3.62f3c1\Editor\Unity.exe")
    }
}
