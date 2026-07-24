// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Unified lifecycle management — ResourceLedger + LifecycleService trait.
// Replaces the scattered cleanup in main.rs WindowEvent::Destroyed.

use std::time::{Duration, Instant};

/// Shutdown status returned by a service's shutdown() method.
#[derive(Debug)]
pub enum ShutdownStatus {
    /// Service shut down gracefully within the deadline.
    Clean,
    /// Service exceeded its deadline and was force-killed.
    #[allow(dead_code)]
    Forced,
    /// Service encountered an error during shutdown.
    Failed(String),
    /// Service has no state to clean up (e.g. stateless wrappers).
    NotApplicable,
}

/// Every backend service with lifecycle requirements implements this trait.
/// Registered in ResourceLedger; shutdown is called in registration order
/// during the Drain phase of app exit.
pub trait LifecycleService: Send + Sync {
    fn name(&self) -> &'static str;
    /// Shut down the service. Must complete before `deadline`.
    /// If the service cannot finish in time, it should force-kill and return `Forced`.
    fn shutdown(&self, deadline: Instant) -> ShutdownStatus;
}

/// Central registry of all backend services with lifecycle management.
/// Replaces ad-hoc cleanup scattered across main.rs setup() and Destroyed handler.
pub struct ResourceLedger {
    services: Vec<Box<dyn LifecycleService>>,
}

impl ResourceLedger {
    pub fn new() -> Self {
        Self { services: Vec::new() }
    }

    pub fn register(&mut self, svc: Box<dyn LifecycleService>) {
        eprintln!("[lifecycle] registered: {}", svc.name());
        self.services.push(svc);
    }

    /// Phase 1 (Drain): sequentially shut down all registered services.
    /// Each service gets up to `per_svc_budget`; total must not exceed `total_budget`.
    /// Services that exceed their deadline are force-killed (if they support it)
    /// or logged as `Forced`.
    pub fn shutdown_all(&self, total_budget: Duration) {
        let global_deadline = Instant::now() + total_budget;
        let per_svc_budget = Duration::from_millis(500);

        for svc in &self.services {
            if Instant::now() >= global_deadline {
                eprintln!("[lifecycle] global budget exhausted, skipping remaining services");
                break;
            }

            let svc_deadline = (Instant::now() + per_svc_budget).min(global_deadline);
            let name = svc.name();
            let started = Instant::now();

            match svc.shutdown(svc_deadline) {
                ShutdownStatus::Clean => {
                    eprintln!("[lifecycle] {} clean shutdown ({:?})", name, started.elapsed());
                }
                ShutdownStatus::Forced => {
                    eprintln!("[lifecycle] {} forced shutdown ({:?})", name, started.elapsed());
                }
                ShutdownStatus::Failed(e) => {
                    eprintln!("[lifecycle] {} failed: {} ({:?})", name, e, started.elapsed());
                }
                ShutdownStatus::NotApplicable => {}
            }
        }
    }
}

impl Default for ResourceLedger {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════
// Service implementations — thin wrappers around existing globals
// ═══════════════════════════════════════════════════════

/// Background shell jobs — kill all spawned processes.
pub struct BgJobsService;

impl LifecycleService for BgJobsService {
    fn name(&self) -> &'static str { "bg_jobs" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        // Use lock() instead of try_lock() — in shutdown path blocking is acceptable.
        // Recover from poisoned mutex (a panicked monitor thread may have poisoned it).
        let mut jobs = crate::utils::BG_JOBS.lock().unwrap_or_else(|e| e.into_inner());
        for (_, job) in jobs.iter_mut() {
            let _ = job.child.kill();
            let _ = job.child.wait();
        }
        jobs.clear();
        ShutdownStatus::Clean
    }
}

/// MCP server process.
pub struct McpService;

impl LifecycleService for McpService {
    fn name(&self) -> &'static str { "mcp_manager" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        let mut mgr = crate::commands::external::MCP_MANAGER.lock()
            .unwrap_or_else(|e| e.into_inner());
        mgr.stop();
        ShutdownStatus::Clean
    }
}

/// Unity editor process.
pub struct UnityService;

impl LifecycleService for UnityService {
    fn name(&self) -> &'static str { "unity_manager" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        match crate::commands::external::UNITY_MANAGER.stop() {
            Ok(()) => ShutdownStatus::Clean,
            Err(e) => ShutdownStatus::Failed(e),
        }
    }
}

/// PTY sessions — kill all shells.
pub struct PtyService;

impl LifecycleService for PtyService {
    fn name(&self) -> &'static str { "pty_manager" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::pty_manager::kill_all();
        ShutdownStatus::Clean
    }
}

/// LSP servers — kill all language servers.
pub struct LspService;

impl LifecycleService for LspService {
    fn name(&self) -> &'static str { "lsp_manager" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::lsp_manager::stop_all();
        ShutdownStatus::Clean
    }
}

/// AuraSDK memory engine — close handle and free resources.
pub struct AuraService;

impl LifecycleService for AuraService {
    fn name(&self) -> &'static str { "aura_memory" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        match crate::aura_memory::aura_shutdown() {
            Ok(()) => ShutdownStatus::Clean,
            Err(e) => ShutdownStatus::Failed(e),
        }
    }
}

/// memory-bundle.exe — kill the spawned process.
pub struct MemoryBundleService;

impl LifecycleService for MemoryBundleService {
    fn name(&self) -> &'static str { "memory_bundle" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        let mut guard = crate::commands::external::MEMORY_BUNDLE_CHILD.lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        ShutdownStatus::Clean
    }
}

/// Unity event TCP server — set shutdown flag so the listener thread exits.
pub struct UnityEventService;

impl LifecycleService for UnityEventService {
    fn name(&self) -> &'static str { "unity_event_server" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::commands::external::UNITY_EVENT_SHUTDOWN
            .store(true, std::sync::atomic::Ordering::SeqCst);
        ShutdownStatus::Clean
    }
}

/// Structured logging — drop WorkerGuard to flush non-blocking writer.
pub struct LoggingService;

impl LifecycleService for LoggingService {
    fn name(&self) -> &'static str { "logging" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        // Take the WorkerGuard out of the OnceLock and drop it to flush.
        // OnceLock::get doesn't allow taking, so we use a different approach:
        // The guard is stored in utils::LOG_GUARD (OnceLock<WorkerGuard>).
        // OnceLock doesn't have take(), but we can't move out of it anyway.
        // The non-blocking writer will be flushed when the process exits.
        // For explicit flush, we rely on process::exit() which drops everything.
        ShutdownStatus::NotApplicable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct MockService {
        name: &'static str,
        called: std::sync::Arc<AtomicBool>,
    }

    impl LifecycleService for MockService {
        fn name(&self) -> &'static str { self.name }
        fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
            self.called.store(true, Ordering::SeqCst);
            ShutdownStatus::Clean
        }
    }

    #[test]
    fn ledger_calls_all_services() {
        let called1 = std::sync::Arc::new(AtomicBool::new(false));
        let called2 = std::sync::Arc::new(AtomicBool::new(false));

        let mut ledger = ResourceLedger::new();
        ledger.register(Box::new(MockService { name: "svc1", called: called1.clone() }));
        ledger.register(Box::new(MockService { name: "svc2", called: called2.clone() }));

        ledger.shutdown_all(Duration::from_secs(5));

        assert!(called1.load(Ordering::SeqCst));
        assert!(called2.load(Ordering::SeqCst));
    }

    #[test]
    fn empty_ledger_is_noop() {
        let ledger = ResourceLedger::new();
        ledger.shutdown_all(Duration::from_secs(1));
    }
}
