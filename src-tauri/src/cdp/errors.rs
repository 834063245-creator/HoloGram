// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 结构化错误构造：CDP 套件的错误字符串统一携带 `[CODE]` 前缀。
//! 模型读到的是去掉前缀的人话 message；测试与 TS 层按 code 路由
//! （2026-08-15 收口：对齐 harness 的结构化错误路由，wire 仍为 String）。
//!
//! 纪律：新增错误点必须从 [`codes`] 取 code（不要手写新前缀），
//! 并在 `cdp.rs` 测试模块的 error code 单测与 `browser-tools.test.ts`
//! 的 parseBrowserError 覆盖清单里同步。

/// 浏览器错误码清单。格式固定为 `[CODE] message`，前缀由 [`err`] 构造。
pub(super) mod codes {
    /// 全链路/CDP 层超时（WS 命令、Runtime.evaluate、导航轮询等）。
    pub const TIMEOUT: &str = "CDP_TIMEOUT";
    /// target 已消失/不存在（页面被关闭、attach 的目标没了）。
    pub const TARGET_GONE: &str = "CDP_TARGET_GONE";
    /// 快照 ref 失效——页面已变化，需重新 snapshot（可恢复错误）。
    pub const REF_STALE: &str = "CDP_REF_STALE";
    /// 元素等待可交互超时（被遮挡/位置持续变化）。
    pub const ACTIONABILITY: &str = "CDP_ACTIONABILITY";
    /// 找不到 Chrome/Edge 可执行文件。
    pub const NO_CHROME: &str = "CDP_NO_CHROME";
    /// 调试端口被占用/端口就绪超时。
    pub const PORT_CONFLICT: &str = "CDP_PORT_CONFLICT";
    /// 传输层失败（HTTP /json、WS 连接/收发）。
    pub const NETWORK: &str = "CDP_NETWORK";
    /// 探针返回契约异常（非 stringify 字符串）。
    pub const PROBE_FAILED: &str = "CDP_PROBE_FAILED";
    /// eval 表达式被白名单拦截。
    pub const EVAL_BLOCKED: &str = "CDP_EVAL_BLOCKED";
    /// slot/profile 名非法。
    pub const SLOT_INVALID: &str = "CDP_SLOT_INVALID";
    /// 会话状态错误（尚未 launch/connect、session 不存在/未运行）。
    pub const SESSION: &str = "CDP_SESSION";
    /// launch proxy/proxyBypass 参数非法。
    pub const PROXY_INVALID: &str = "CDP_PROXY_INVALID";
    /// 未分类的内部错误（协议响应解析、会话状态异常等）。
    pub const INTERNAL: &str = "CDP_INTERNAL";
}

/// 构造带 code 的错误字符串：`[code] message`。
/// TS 层 `parseBrowserError` 解析此前缀；模型看到的是剥离后的 message。
pub(super) fn err(code: &str, message: impl AsRef<str>) -> String {
    format!("[{}] {}", code, message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn err_formats_code_prefix() {
        assert_eq!(
            err(codes::REF_STALE, "目标不存在或已失效"),
            "[CDP_REF_STALE] 目标不存在或已失效"
        );
    }
}
