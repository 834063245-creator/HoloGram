// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA worker 桥接层 — async 命令层 ↔ 专用 COM 线程。
//
// 设计（计划 §3.1）：
//   - 单一专用线程独占 COM（apartment/阻塞调用隔离；IUIAutomationElement 非 Send，
//     一切 COM 对象只存活在该线程内）
//   - mpsc 请求 + tokio oneshot 回复，单请求 15s 硬超时
//   - catch_unwind 守卫：线程内 panic 转错误响应，线程存活（com.rs 实现）
//   - 生命周期：UiaService(LifecycleService) 发 Quit 并等 exited condvar

use std::sync::{mpsc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::errors;

// ═══════════════════════════════════════════════════════════
// 请求类型（全部 Send；COM 对象绝不跨界）
// ═══════════════════════════════════════════════════════════

/// 窗口定位：hwnd（精确）> pid（主窗口）> title（模糊）> 前台窗口。
#[derive(Debug, Clone, Default)]
pub(crate) struct Locator {
    pub title: Option<String>,
    pub pid: Option<u32>,
    pub hwnd: Option<u64>,
}

/// 控件定位：selector（name/automation_id/control_type 任一，精确条件）或 ref（树快照下标）。
#[derive(Debug, Clone, Default)]
pub(crate) struct Target {
    pub ref_id: Option<u32>,
    pub name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
}

impl Target {
    pub(crate) fn has_any(&self) -> bool {
        self.ref_id.is_some()
            || self.name.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.automation_id.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.control_type.as_deref().is_some_and(|s| !s.trim().is_empty())
    }
}

pub(crate) type Reply = tokio::sync::oneshot::Sender<Result<Value, String>>;

pub(crate) enum UiaRequest {
    /// 全量树（all=false 时只展示 interactive 子集；ref 始终是全量下标）
    Tree {
        loc: Locator,
        all: bool,
        offset: usize,
        max_results: usize,
        reply: Reply,
    },
    /// 条件查找（在缓存树上过滤，interactive 默认开）
    Find {
        loc: Locator,
        all: bool,
        name: Option<String>,
        ctype: Option<String>,
        aid: Option<String>,
        enabled: Option<bool>,
        reply: Reply,
    },
    /// 只读解析：定位窗口+控件，返回分类所需的全部信息（权限分类前置步骤）
    Resolve {
        loc: Locator,
        target: Target,
        reply: Reply,
    },
    Read {
        loc: Locator,
        target: Target,
        reply: Reply,
    },
    Wait {
        loc: Locator,
        target: Target,
        until: String,
        value: Option<String>,
        timeout_ms: u64,
        reply: Reply,
    },
    Click {
        loc: Locator,
        target: Target,
        right: bool,
        /// 坐标兜底是否被授权（physical 分类才允许；pattern 分类保持纯净报错）
        allow_coords: bool,
        reply: Reply,
    },
    Type {
        loc: Locator,
        target: Target,
        text: String,
        /// SendKeys/剪贴板兜底是否被授权
        allow_physical: bool,
        reply: Reply,
    },
    Scroll {
        loc: Locator,
        target: Target,
        direction: String,
        amount: f64,
        /// 滚轮兜底是否被授权
        allow_wheel: bool,
        reply: Reply,
    },
    Select {
        loc: Locator,
        target: Target,
        reply: Reply,
    },
    Expand {
        loc: Locator,
        target: Target,
        reply: Reply,
    },
    Keys {
        loc: Locator,
        modifiers: Vec<String>,
        key: String,
        reply: Reply,
    },
    Activate {
        loc: Locator,
        reply: Reply,
    },
    /// 窗口矩形（window_shot 截图前定位）
    WindowRect {
        loc: Locator,
        reply: Reply,
    },
    /// 路由探测（desktop_probe 通道路由建议）：预算内数 interactive 后代数
    ProbeRoute {
        hwnd: u64,
        budget_ms: u32,
        reply: Reply,
    },
}

pub(crate) enum Msg {
    Req(UiaRequest),
    Quit,
}

// ═══════════════════════════════════════════════════════════
// worker 句柄（惰性启动；进程级单例）
// ═══════════════════════════════════════════════════════════

pub(super) struct WorkerHandle {
    tx: mpsc::Sender<Msg>,
    exited: std::sync::Arc<(Mutex<bool>, std::sync::Condvar)>,
}

static WORKER: LazyLock<WorkerHandle> = LazyLock::new(WorkerHandle::start);

impl WorkerHandle {
    fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();
        let exited = std::sync::Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let ex = exited.clone();
        std::thread::Builder::new()
            .name("hologram-uia".into())
            .spawn(move || {
                worker_loop(rx);
                let (lock, cvar) = &*ex;
                *crate::utils::lock_or_recover(lock) = true;
                cvar.notify_all();
            })
            .expect("spawn hologram-uia worker");
        Self { tx, exited }
    }

    /// 发送请求并等待回复（15s 硬超时；worker 挂死不拖垮 Agent 流）。
    pub(crate) async fn call(&self, build: impl FnOnce(Reply) -> UiaRequest) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(Msg::Req(build(tx)))
            .map_err(|_| errors::err(errors::codes::INTERNAL, "UIA worker 已停止"))?;
        match tokio::time::timeout(Duration::from_secs(15), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(errors::err(errors::codes::INTERNAL, "UIA worker 内部错误（panic 或通道关闭），可重试一次")),
            Err(_) => Err(errors::err(
                errors::codes::TIMEOUT,
                "UIA 操作超时（15s）— 目标窗口可能无响应或树过大；可用 all:false 缩小观察面",
            )),
        }
    }

    /// 优雅停机：发 Quit，等线程退出直至 deadline。true = 干净退出。
    pub(crate) fn shutdown(&self, deadline: Instant) -> bool {
        let _ = self.tx.send(Msg::Quit);
        let (lock, cvar) = &*self.exited;
        let mut g = crate::utils::lock_or_recover(lock);
        while !*g {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (ng, _) = match cvar.wait_timeout(g, deadline - now) {
                Ok(r) => r,
                Err(_) => return false,
            };
            g = ng;
        }
        true
    }
}

/// 统一入口（facade 用）。
pub(crate) async fn request(build: impl FnOnce(Reply) -> UiaRequest) -> Result<Value, String> {
    WORKER_USED.store(true, std::sync::atomic::Ordering::Relaxed);
    WORKER.call(build).await
}

/// worker 是否被用过（未用过则 shutdown 无需启动它）。
static WORKER_USED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 优雅停机（lifecycle 调用）。true = 干净退出（或从未启动，无需清理）。
pub(crate) fn shutdown(deadline: Instant) -> bool {
    if !WORKER_USED.load(std::sync::atomic::Ordering::Relaxed) {
        return true;
    }
    WORKER.shutdown(deadline)
}

// 平台分派：Windows 走 com.rs；其余平台全部回结构化错误（可编译）
#[cfg(windows)]
use super::com as worker_impl;
#[cfg(not(windows))]
mod worker_impl {
    use super::*;
    pub(super) fn worker_loop(rx: mpsc::Receiver<Msg>) {
        for msg in rx {
            let Msg::Req(req) = msg else { break };
            let err = errors::err(errors::codes::INTERNAL, "UIA 仅支持 Windows");
            let _ = match req {
                UiaRequest::Tree { reply, .. }
                | UiaRequest::Find { reply, .. }
                | UiaRequest::Resolve { reply, .. }
                | UiaRequest::Read { reply, .. }
                | UiaRequest::Wait { reply, .. }
                | UiaRequest::Click { reply, .. }
                | UiaRequest::Type { reply, .. }
                | UiaRequest::Scroll { reply, .. }
                | UiaRequest::Select { reply, .. }
                | UiaRequest::Expand { reply, .. }
                | UiaRequest::Keys { reply, .. }
                | UiaRequest::Activate { reply, .. }
                | UiaRequest::ProbeRoute { reply, .. } => reply.send(Err(err)),
            };
        }
    }
}
use worker_impl::worker_loop;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_has_any_rejects_blank() {
        assert!(Target {
            ref_id: Some(3),
            ..Default::default()
        }
        .has_any());
        assert!(Target {
            name: Some("OK".into()),
            ..Default::default()
        }
        .has_any());
        assert!(!Target {
            name: Some("   ".into()),
            ..Default::default()
        }
        .has_any(), "空白 name 不算定位条件");
        assert!(!Target::default().has_any());
    }
}
