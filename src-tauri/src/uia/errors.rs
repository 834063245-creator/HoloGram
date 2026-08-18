// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA 结构化错误码 — 镜像 cdp/errors.rs 契约：`[UIA_XXX] 人话 message`。
// TS 侧 parseStructuredError 据此路由（browser/desktop 共用同一正则）。

pub(crate) mod codes {
    pub(crate) const WINDOW_NOT_FOUND: &str = "UIA_WINDOW_NOT_FOUND";
    pub(crate) const STALE_REF: &str = "UIA_STALE_REF";
    pub(crate) const NO_PATTERN: &str = "UIA_NO_PATTERN";
    pub(crate) const TIMEOUT: &str = "UIA_TIMEOUT";
    pub(crate) const LEASE_BUSY: &str = "UIA_LEASE_BUSY";
    pub(crate) const ACCESS_DENIED: &str = "UIA_ACCESS_DENIED";
    pub(crate) const ARG_INVALID: &str = "UIA_ARG_INVALID";
    pub(crate) const INTERNAL: &str = "UIA_INTERNAL";
}

/// 构造 `[CODE] message`。无 code 的旧错误由调用方兜底为 INTERNAL。
pub(crate) fn err(code: &str, msg: impl AsRef<str>) -> String {
    format!("[{code}] {}", msg.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn err_formats_code_prefix() {
        assert_eq!(err(codes::INTERNAL, "x"), "[UIA_INTERNAL] x");
        assert_eq!(err(codes::STALE_REF, "控件已消失"), "[UIA_STALE_REF] 控件已消失");
    }
}
