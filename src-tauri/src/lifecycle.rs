// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 统一生命周期管理 — ResourceLedger + LifecycleService trait。
// 替代 main.rs 中 WindowEvent::Destroyed 里分散的清理逻辑。

use std::time::{Duration, Instant};

/// 服务 shutdown() 方法返回的关闭状态。
#[derive(Debug)]
pub enum ShutdownStatus {
    /// 服务在截止时间内优雅关闭。
    Clean,
    /// 服务超出截止时间并被强制终止。
    #[allow(dead_code)]
    Forced,
    /// 服务在关闭过程中遇到错误。
    Failed(String),
    /// 服务无需清理状态（如无状态包装器）。
    NotApplicable,
}

/// 每个有生命周期需求的后端服务都实现此 trait。
/// 在 ResourceLedger 中注册；在应用退出的 Drain 阶段
/// 按注册顺序调用 shutdown。
pub trait LifecycleService: Send + Sync {
    fn name(&self) -> &'static str;
    /// 关闭服务。必须在 `deadline` 之前完成。
    /// 如果服务无法在时间内完成，应强制终止并返回 `Forced`。
    fn shutdown(&self, deadline: Instant) -> ShutdownStatus;
}

/// 所有具有生命周期管理的后端服务的中央注册表。
/// 替代 main.rs setup() 和 Destroyed 处理器中分散的清理逻辑。
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

    /// Phase 1 (Drain)：依次关闭所有已注册的服务。
    /// 每个服务最多有 `per_svc_budget` 时间；总时间不得超过 `total_budget`。
    /// 超出截止时间的服务被强制终止（如果支持）或记为 `Forced`。
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
// 服务实现 — 现有全局对象的轻量包装器
// ═══════════════════════════════════════════════════════

/// 后台 shell 作业 — 终止所有已启动的进程。
pub struct BgJobsService;

impl LifecycleService for BgJobsService {
    fn name(&self) -> &'static str { "bg_jobs" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        // 使用 lock() 而非 try_lock() — 在关闭路径中阻塞是可接受的。
        // 从中毒的 mutex 恢复（panic 的监控线程可能导致 mutex 中毒）。
        let mut jobs = crate::utils::BG_JOBS.lock().unwrap_or_else(|e| e.into_inner());
        for (_, job) in jobs.iter_mut() {
            // kill_tree 递归杀子孙进程，避免孤儿进程继续占用资源
            let _ = job.child.kill_tree();
            // try_wait 轮询替代 wait()，防止子进程不响应时永久阻塞
            let wait_start = std::time::Instant::now();
            loop {
                match job.child.try_wait() {
                    Ok(Some(_)) => break,
                    _ => {
                        if wait_start.elapsed() >= Duration::from_millis(500) {
                            eprintln!("[lifecycle] bg_job pid={} did not exit within 500ms, skipping wait", job.child.id());
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        }
        jobs.clear();
        crate::utils::lock_or_recover(&crate::utils::BUILD_LOCKS).clear();
        ShutdownStatus::Clean
    }
}

/// MCP server 进程。
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

/// Unity 编辑器进程。
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

/// PTY 会话 — 终止所有 shell。
pub struct PtyService;

impl LifecycleService for PtyService {
    fn name(&self) -> &'static str { "pty_manager" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::pty_manager::kill_all();
        ShutdownStatus::Clean
    }
}

/// LSP 服务器 — 终止所有语言服务器。
pub struct LspService;

impl LifecycleService for LspService {
    fn name(&self) -> &'static str { "lsp_manager" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::lsp_manager::stop_all();
        ShutdownStatus::Clean
    }
}

/// UIA worker 线程 — 发 Quit 并在截止时间内等线程退出。
/// 未用过（无任何 desktop_uia_* 调用）时不触发 LazyLock 启动，直接 Clean。
pub struct UiaService;

impl LifecycleService for UiaService {
    fn name(&self) -> &'static str { "uia_worker" }

    fn shutdown(&self, deadline: Instant) -> ShutdownStatus {
        if crate::uia::shutdown_worker(deadline) {
            ShutdownStatus::Clean
        } else {
            ShutdownStatus::Forced
        }
    }
}

/// AuraSDK 记忆引擎 — 关闭句柄并释放资源。
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

/// memory-bundle.exe — 终止已启动的进程。
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

/// LLM 本地反向代理 — 置停机标志使 accept 循环（≤200ms）退出。
/// 必须注册：否则 exit(0) 会撞上仍活着的 hyper/reqwest 线程，
/// Windows 弹 0x40000015 unknown software exception（2026-08-17 修复）。
pub struct LlmProxyService;

impl LifecycleService for LlmProxyService {
    fn name(&self) -> &'static str { "llm_proxy" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::llm_proxy::stop_llm_proxy();
        ShutdownStatus::Clean
    }
}

/// Unity 事件 TCP 服务器 — 设置关闭标志使监听线程退出。
pub struct UnityEventService;

impl LifecycleService for UnityEventService {
    fn name(&self) -> &'static str { "unity_event_server" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        crate::commands::external::UNITY_EVENT_SHUTDOWN
            .store(true, std::sync::atomic::Ordering::SeqCst);
        ShutdownStatus::Clean
    }
}

/// 结构化日志 — 丢弃 WorkerGuard 以刷新非阻塞写入器。
pub struct LoggingService;

impl LifecycleService for LoggingService {
    fn name(&self) -> &'static str { "logging" }

    fn shutdown(&self, _deadline: Instant) -> ShutdownStatus {
        // 取出 WorkerGuard 并丢弃以刷新。
        // OnceLock::get 不允许 take，所以我们用不同方式：
        // guard 存储在 utils::LOG_GUARD (OnceLock<WorkerGuard>) 中。
        // OnceLock 没有 take()，但我们也无法从中 move 出来。
        // 非阻塞写入器在进程退出时会被刷新。
        // 对于显式刷新，我们依赖 process::exit() 来 drop 所有内容。
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
