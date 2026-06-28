// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// OS-level sandbox — Phase 4a: Windows Job Object for process lifecycle (spec §6.3)
// ponytail: pure FFI, no windows-sys/windows crate. Only 4 functions needed.
// Phase 4b will add AppContainer for filesystem/network isolation.

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    // ── Win32 FFI (minimal — avoids windows-sys crate) ──

    extern "system" {
        fn CreateJobObjectW(
            job_attrs: *mut std::ffi::c_void,
            name: *const u16,
        ) -> isize;
        fn SetInformationJobObject(
            job: isize,
            info_class: i32,
            info: *const std::ffi::c_void,
            info_len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_DIE_ON_JOB_CLOSE: u32 = 0x00002000;
    const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x00000800;

    #[repr(C)]
    #[allow(dead_code)]
    struct JobObjectExtendedLimitInformationRaw {
        basic: JobObjectBasicLimitInformation,
        io_counters: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: u64,
        per_job_user_time_limit: u64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    /// Lazily-initialized Job Object handle. None = creation failed (pre-Win8 or permission issue).
    static JOB: OnceLock<Option<isize>> = OnceLock::new();

    pub fn init() {
        JOB.get_or_init(|| {
            let h = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if h == 0 {
                eprintln!("[hologram] CreateJobObjectW failed — Job Object 不可用，跳过进程纳管");
                return None;
            }

            let mut limits: JobObjectExtendedLimitInformationRaw =
                unsafe { std::mem::zeroed() };
            limits.basic.limit_flags =
                JOB_OBJECT_LIMIT_DIE_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            // ponytail: no ActiveProcessLimit — bash pipes/fork would break.

            let ret = unsafe {
                SetInformationJobObject(
                    h,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &limits as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JobObjectExtendedLimitInformationRaw>() as u32,
                )
            };

            if ret == 0 {
                eprintln!("[hologram] SetInformationJobObject failed — Job Object 不可用");
                return None;
            }

            // ponytail: handle intentionally leaked — lives for process lifetime.
            // On exit, Windows closes all handles; DIE_ON_JOB_CLOSE kills remaining
            // child processes before the handle is released.
            Some(h)
        });
    }

    /// Assign a spawned child process to the global Job Object.
    /// Returns true if assignment succeeded; false means Job Object unavailable.
    /// On failure, the child still runs — just without die-with-parent protection.
    pub fn assign(child: &std::process::Child) -> bool {
        let job = match JOB.get() {
            Some(Some(h)) => *h,
            _ => return false,
        };

        let raw = child.as_raw_handle();
        // as_raw_handle is a pointer-sized value; on Windows it IS the process handle
        // ponytail: cast through usize to avoid type mismatch across rust versions
        if raw.is_null() {
            return false;
        }

        unsafe { AssignProcessToJobObject(job, raw as isize) != 0 }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn init() {}
    pub fn assign(_child: &std::process::Child) -> bool {
        true
    }
}

pub use imp::*;
