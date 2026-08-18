// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// DesktopGrant（窗口级授权注册表）+ DesktopInputLease（全局输入租约）。
//
// Grant：对齐 CDP「attach 授权一次、页内普通动作放行」的姿势——用户批准
// 一次窗口接管后，该 agent 在该窗口上的 pattern 动作（invoke/toggle/select/
// expand/setvalue/scroll）不再二次确认；敏感目标与物理输入路径仍单独 Ask。
// 按 (agent_id, hwnd) 键控，滑动 TTL（默认 10min，env 可调）。
//
// Lease：物理输入注入（SetCursorPos/SendInput/SendKeys/剪贴板/抢前台）在
// 整个进程内全局串行化——SubAgentPool 并发 5 个子 Agent 时防止抢光标/抢焦点，
// 也防止打断正在打字的用户。持有者对状态面板可见。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::errors;

// ═══════════════════════════════════════════════════════════
// DesktopGrant
// ═══════════════════════════════════════════════════════════

fn grant_ttl() -> Duration {
    std::env::var("HOLOGRAM_DESKTOP_GRANT_TTL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&s| s >= 1)
        .unwrap_or(600)
        .pipe_secs()
}

trait PipeSecs {
    fn pipe_secs(self) -> Duration;
}
impl PipeSecs for u64 {
    fn pipe_secs(self) -> Duration {
        Duration::from_secs(self)
    }
}

static GRANTS: LazyLock<Mutex<HashMap<(String, u64), Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn agent_key(agent: Option<&str>) -> String {
    agent
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("default")
        .to_string()
}

fn prune(map: &mut HashMap<(String, u64), Instant>) {
    let ttl = grant_ttl();
    map.retain(|_, t| t.elapsed() < ttl);
}

/// 该 agent 是否持有该窗口的接管授权（滑动 TTL，惰性过期）。
pub(crate) fn has_grant(agent: Option<&str>, hwnd: Option<u64>) -> bool {
    let Some(hwnd) = hwnd else { return false };
    let mut map = crate::utils::lock_or_recover(&GRANTS);
    prune(&mut map);
    map.contains_key(&(agent_key(agent), hwnd))
}

/// 记录/续期授权。
pub(crate) fn grant(agent: Option<&str>, hwnd: u64) {
    let mut map = crate::utils::lock_or_recover(&GRANTS);
    prune(&mut map);
    map.insert((agent_key(agent), hwnd), Instant::now());
}

/// 撤销某 agent 的全部授权（desktop_status 诊断/测试用）。
#[cfg(test)]
pub(crate) fn revoke_agent(agent: Option<&str>) {
    let key = agent_key(agent);
    crate::utils::lock_or_recover(&GRANTS).retain(|(a, _), _| a != &key);
}

/// 当前授权快照（状态面板/诊断用）：[(agent, hwnd, 剩余秒)]。
pub(crate) fn list_grants() -> Vec<(String, u64, u64)> {
    let map = crate::utils::lock_or_recover(&GRANTS);
    let ttl = grant_ttl();
    let mut out = Vec::with_capacity(map.len());
    for ((a, h), t) in map.iter() {
        out.push((a.clone(), *h, (ttl - t.elapsed()).as_secs()));
    }
    out
}

// ═══════════════════════════════════════════════════════════
// DesktopInputLease
// ═══════════════════════════════════════════════════════════

static INPUT_LEASE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LEASE_HOLDER: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 租约守卫：Drop 时先清持有者标记再释放锁。
#[derive(Debug)]
pub(crate) struct InputLeaseGuard {
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl Drop for InputLeaseGuard {
    fn drop(&mut self) {
        *crate::utils::lock_or_recover(&LEASE_HOLDER) = None;
    }
}

/// 获取物理输入租约（默认等 3s；拿不到回 [UIA_LEASE_BUSY] + 当前持有者）。
pub(crate) async fn acquire_input_lease(
    agent: Option<&str>,
    wait: Duration,
) -> Result<InputLeaseGuard, String> {
    match tokio::time::timeout(wait, INPUT_LEASE.lock()).await {
        Ok(g) => {
            *crate::utils::lock_or_recover(&LEASE_HOLDER) = Some(agent_key(agent));
            Ok(InputLeaseGuard { _guard: g })
        }
        Err(_) => {
            let holder = crate::utils::lock_or_recover(&LEASE_HOLDER).clone();
            Err(errors::err(
                errors::codes::LEASE_BUSY,
                format!(
                    "桌面输入租约被占用（holder: {}），稍后重试",
                    holder.unwrap_or_else(|| "未知".into())
                ),
            ))
        }
    }
}

/// 当前租约持有者（状态显示）。
pub(crate) fn lease_holder() -> Option<String> {
    crate::utils::lock_or_recover(&LEASE_HOLDER).clone()
}

// ═══════════════════════════════════════════════════════════
// 测试 — 纯逻辑（无 COM）
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_is_agent_and_hwnd_scoped() {
        let a1 = "grant-test-a1";
        let a2 = "grant-test-a2";
        grant(Some(a1), 111);
        assert!(has_grant(Some(a1), Some(111)));
        assert!(!has_grant(Some(a2), Some(111)), "授权按 agent 隔离");
        assert!(!has_grant(Some(a1), Some(222)), "授权按窗口隔离");
        assert!(!has_grant(Some(a1), None), "无 hwnd 不算持有");
        revoke_agent(Some(a1));
        assert!(!has_grant(Some(a1), Some(111)), "撤销后失效");
    }

    #[test]
    fn grant_ttl_expires() {
        let a = "grant-test-ttl";
        grant(Some(a), 333);
        // 手动把时间拨到过期之后（模拟 TTL 流逝）
        {
            let mut map = crate::utils::lock_or_recover(&GRANTS);
            let ttl = grant_ttl();
            map.insert((agent_key(Some(a)), 333), Instant::now() - ttl - Duration::from_secs(1));
        }
        assert!(!has_grant(Some(a), Some(333)), "过期授权应失效");
    }

    #[tokio::test]
    async fn input_lease_serializes_and_reports_holder() {
        let g1 = acquire_input_lease(Some("lease-a"), Duration::from_millis(100))
            .await
            .expect("首次获取应成功");
        assert_eq!(lease_holder().as_deref(), Some("lease-a"));
        // 第二个 agent 在等待窗口内拿不到 → LEASE_BUSY
        let e = acquire_input_lease(Some("lease-b"), Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(e.starts_with("[UIA_LEASE_BUSY]"), "{e}");
        assert!(e.contains("lease-a"), "错误应带持有者: {e}");
        drop(g1);
        assert_eq!(lease_holder(), None, "Drop 后持有者清空");
        let g2 = acquire_input_lease(Some("lease-b"), Duration::from_millis(100))
            .await
            .expect("释放后应可获取");
        drop(g2);
    }
}
