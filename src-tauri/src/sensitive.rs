// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 敏感操作文本判定 — CDP（browser 域）与 UIA（desktop 域）共享的单一事实源。
// 从 cdp/actions.rs 提取（2026-08 computer-use 改造）：两端对「什么算敏感点击」
// 必须同词表，否则同一个按钮在浏览器里 Ask、在桌面应用里放行（或反之）。

use std::sync::LazyLock;

/// 敏感点击词表（正则源）。中文动词直接匹配；英文用 \b 词边界防误伤
/// （deletion 不含 delete、play 不含 pay）。
pub(crate) const SENSITIVE_CLICK_RE_SOURCE: &str = r"(确认|提交|支付|转账|购买|删除|注销|退订|清空|\b(pay(?:\s+now)?|payment|purchase|buy(?:\s+now)?|delete|confirm|unsubscribe|sign\s*out|log\s*out|transfer|checkout|clear|submit)\b)";

/// 判定控件/元素文本是否命中敏感词表（大小写不敏感）。
pub(crate) fn is_sensitive_click_text(text: &str) -> bool {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(&format!("(?i)({SENSITIVE_CLICK_RE_SOURCE})"))
            .expect("SENSITIVE_CLICK_RE_SOURCE 是静态正则")
    });
    RE.is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_text_covers_cn_and_en() {
        for text in [
            "Pay now",
            "PAY NOW",
            "Delete account",
            "Confirm subscription",
            "Unsubscribe",
            "Sign out",
            "Transfer money",
            "Checkout",
            "确认支付",
        ] {
            assert!(is_sensitive_click_text(text), "高危文本应命中: {text}");
        }
        for text in [
            "Read more",
            "Sign in",
            "Delivery status",
            "Deletion is not supported", // 词边界：delete 不匹配 deletion
            "Play now",                  // 词边界：pay 不匹配 play
        ] {
            assert!(!is_sensitive_click_text(text), "普通文本不应命中: {text}");
        }
    }
}
