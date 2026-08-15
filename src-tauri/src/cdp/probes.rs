// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 探针 JS 单一来源：独立文件 include_str! 嵌入（ADR 0003 D7）。
//! 从 cdp.rs 拆出（第四批工程债）；语法由 cdp.rs 测试用 node --check 验证。

use serde_json::Value;

use super::errors::{codes, err};

// ═══════════════════════════════════════════════════════════
// 探针 JS — 独立文件，include_str! 嵌入（单一来源，ADR 0003 D4/D7）
// 语法由底部 #[cfg(test)] probes_are_valid_javascript 用 node --check 强制验证。
// ═══════════════════════════════════════════════════════════

pub(super) const CONTENT_PROBE: &str = include_str!("probes/content.js");
pub(super) const INSPECT_PROBE: &str = include_str!("probes/inspect.js");
pub(super) const REPORT_PROBE: &str = include_str!("probes/report.js");
pub(super) const SNAPSHOT_PROBE: &str = include_str!("probes/snapshot.js");

/// 解析探针 evaluate 返回值，统一兑现「probe 返回 stringify 字符串」的契约
/// （ADR 0003 D7：probe 用 JSON.stringify 包裹 + returnByValue 取字符串）。
/// 违反契约（如误返回对象 / 被二次序列化）时返回明确错误，而非静默落到空结果
/// ——空快照会掩盖"探针根本没跑出东西"这条线索（曾因 JSON.stringify 形态错乱
/// 在 world_snapshot 静默失效，e1679a0f 修复；这里把同类契约显式锁死）。
pub(super) fn probe_result_str(val: &Value, label: &str) -> Result<String, String> {
    val.as_str().map(|s| s.to_string()).ok_or_else(|| {
        err(
            codes::PROBE_FAILED,
            format!(
                "{label}: 探针返回形态异常（期望 stringify 字符串，实际 {:?}）——             页面上下文可能被销毁，或返回契约被破坏",
                if val.is_object() { "对象" } else { "非字符串" }
            ),
        )
    })
}
