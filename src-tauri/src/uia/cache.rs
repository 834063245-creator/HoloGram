// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA 树缓存纯逻辑 — 无 COM 依赖，全部可单测。
// COM 元素句柄（线程内）在 com.rs 的 WindowTree 里，这里只有数据形状
// 与过滤/分页/格式化算法。

// ═══════════════════════════════════════════════════════════
// 控件记录（tree/find/read 共用形状）
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ControlRec {
    /// ref = 全量控件数组的稳定下标（interactive 过滤/分页不改变 ref 语义）
    pub ref_id: usize,
    /// UIA ControlType id（50000 Button / 50004 Edit / …）
    pub ctype: u32,
    pub name: String,
    pub automation_id: String,
    pub enabled: bool,
    pub password: bool,
    /// x, y, w, h（屏幕坐标；多显示器为虚拟屏幕坐标）
    pub rect: (i32, i32, i32, i32),
    /// 树深度（窗口根的直接子级 = 1）
    pub depth: u32,
}

/// UIA ControlType id → 名称（与旧 PowerShell 树输出的 ControlType 名对齐）。
pub(crate) fn control_type_name(id: u32) -> &'static str {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "Pane",
        50013 => "ProgressBar",
        50014 => "RadioButton",
        50015 => "ScrollBar",
        50016 => "Slider",
        50017 => "Spinner",
        50018 => "StatusBar",
        50019 => "Tab",
        50020 => "TabItem",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Header",
        50034 => "HeaderItem",
        50035 => "Table",
        50036 => "TitleBar",
        50037 => "SemanticZoom",
        _ => "Unknown",
    }
}

/// 名称 → ControlType id（selector 模式的 control_type 参数反查）。
/// 大小写不敏感；未知名称返回 None（上层报 ARG_INVALID）。
pub(crate) fn control_type_id(name: &str) -> Option<u32> {
    const ALL: [(&str, u32); 38] = [
        ("Button", 50000),
        ("Calendar", 50001),
        ("CheckBox", 50002),
        ("ComboBox", 50003),
        ("Edit", 50004),
        ("Hyperlink", 50005),
        ("Image", 50006),
        ("ListItem", 50007),
        ("List", 50008),
        ("Menu", 50009),
        ("MenuBar", 50010),
        ("MenuItem", 50011),
        ("Pane", 50012),
        ("ProgressBar", 50013),
        ("RadioButton", 50014),
        ("ScrollBar", 50015),
        ("Slider", 50016),
        ("Spinner", 50017),
        ("StatusBar", 50018),
        ("Tab", 50019),
        ("TabItem", 50020),
        ("ToolBar", 50021),
        ("ToolTip", 50022),
        ("Tree", 50023),
        ("TreeItem", 50024),
        ("Custom", 50025),
        ("Group", 50026),
        ("Thumb", 50027),
        ("DataGrid", 50028),
        ("DataItem", 50029),
        ("Document", 50030),
        ("SplitButton", 50031),
        ("Window", 50032),
        ("Header", 50033),
        ("HeaderItem", 50034),
        ("Table", 50035),
        ("TitleBar", 50036),
        ("SemanticZoom", 50037),
    ];
    ALL.iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, id)| *id)
}

/// 可交互控件白名单 — tree/find 默认只展示这些（对齐 CDP snapshot 的
/// interactive-only 形态）。刻意排除：Pane/Group/Custom（布局容器，
/// 自绘应用里 Custom 遍地都是，纳入会淹没有效信息）、Text 类静态元素。
/// List/Tree/Document 保留（滚动容器是 scroll 的合法目标）。
pub(crate) fn is_interactive(ctype: u32) -> bool {
    matches!(
        ctype,
        50000 // Button
        | 50001 // Calendar
        | 50002 // CheckBox
        | 50003 // ComboBox
        | 50004 // Edit
        | 50005 // Hyperlink
        | 50007 // ListItem
        | 50008 // List
        | 50009 // Menu
        | 50011 // MenuItem
        | 50014 // RadioButton
        | 50016 // Slider
        | 50017 // Spinner
        | 50019 // Tab
        | 50020 // TabItem
        | 50023 // Tree
        | 50024 // TreeItem
        | 50027 // Thumb
        | 50029 // DataItem
        | 50030 // Document
        | 50031 // SplitButton
        | 50034 // HeaderItem
    )
}

/// find 过滤条件匹配（沿旧 uia.rs 语义：name 模糊、ctype/aid 精确忽略大小写）。
pub(crate) fn control_matches(
    c: &ControlRec,
    name: Option<&str>,
    ctype: Option<&str>,
    aid: Option<&str>,
    enabled: Option<bool>,
) -> bool {
    if let Some(n) = name {
        if !c.name.to_lowercase().contains(&n.to_lowercase()) {
            return false;
        }
    }
    if let Some(t) = ctype {
        if !control_type_name(c.ctype).eq_ignore_ascii_case(t) {
            return false;
        }
    }
    if let Some(a) = aid {
        if !c.automation_id.eq_ignore_ascii_case(a) {
            return false;
        }
    }
    if let Some(e) = enabled {
        if c.enabled != e {
            return false;
        }
    }
    true
}

/// 缩进式树文本（按 depth 缩进；供模型阅读）。
pub(crate) fn tree_text(controls: &[ControlRec]) -> String {
    let mut s = String::new();
    for c in controls {
        let state = if c.enabled { "" } else { " (disabled)" };
        let name = if c.name.is_empty() {
            String::new()
        } else {
            format!(" \"{}\"", c.name)
        };
        let indent = "  ".repeat(c.depth.saturating_sub(1) as usize);
        s.push_str(&format!(
            "{indent}[{}] {}{}{}\n",
            c.ref_id,
            control_type_name(c.ctype),
            name,
            state,
        ));
    }
    s
}

/// 分页边界：clamp 到 [0, total]。max=0 视为默认 80。
pub(crate) fn page_bounds(total: usize, offset: usize, max_results: usize) -> std::ops::Range<usize> {
    let max = if max_results == 0 { 80 } else { max_results };
    let start = offset.min(total);
    let end = (start + max).min(total);
    start..end
}

// ═══════════════════════════════════════════════════════════
// 测试 — 纯逻辑，不依赖 COM
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ctype: u32, name: &str, depth: u32) -> ControlRec {
        ControlRec {
            ref_id: 0,
            ctype,
            name: name.into(),
            automation_id: String::new(),
            enabled: true,
            password: false,
            rect: (0, 0, 10, 10),
            depth,
        }
    }

    #[test]
    fn control_type_roundtrip() {
        assert_eq!(control_type_name(50004), "Edit");
        assert_eq!(control_type_id("edit"), Some(50004));
        assert_eq!(control_type_id("ComboBox"), Some(50003));
        assert_eq!(control_type_id("Nope"), None);
        assert_eq!(control_type_name(99999), "Unknown");
    }

    #[test]
    fn interactive_whitelist_excludes_layout_noise() {
        assert!(is_interactive(50000), "Button 可交互");
        assert!(is_interactive(50004), "Edit 可交互");
        assert!(is_interactive(50008), "List（滚动容器）可交互");
        assert!(!is_interactive(50012), "Pane 是布局容器，默认过滤");
        assert!(!is_interactive(50025), "Custom 是自绘噪音，默认过滤");
        assert!(!is_interactive(50036), "TitleBar 过滤");
    }

    #[test]
    fn control_matches_filters() {
        let c = ControlRec {
            ref_id: 0,
            ctype: 50000,
            name: "Save File".into(),
            automation_id: "save_btn".into(),
            enabled: true,
            password: false,
            rect: (0, 0, 10, 10),
            depth: 1,
        };
        assert!(control_matches(&c, Some("save"), None, None, None));
        assert!(control_matches(&c, None, Some("button"), None, None));
        assert!(control_matches(&c, None, None, Some("SAVE_BTN"), Some(true)));
        assert!(!control_matches(&c, Some("open"), None, None, None), "name 不匹配");
        assert!(!control_matches(&c, None, None, None, Some(false)), "enabled 不匹配");
    }

    #[test]
    fn tree_text_formats_readable() {
        let mut a = rec(50004, "", 1);
        a.ref_id = 0;
        a.name = String::new();
        let mut b = rec(50000, "OK", 2);
        b.ref_id = 1;
        b.enabled = false;
        let t = tree_text(&[a, b]);
        assert!(t.contains("[0] Edit"));
        assert!(t.contains("  [1] Button \"OK\" (disabled)"), "depth=2 应缩进: {t}");
    }

    #[test]
    fn page_bounds_clamps() {
        assert_eq!(page_bounds(10, 0, 0), 0..80.min(10), "max=0 → 默认 80 并 clamp");
        assert_eq!(page_bounds(10, 8, 5), 8..10);
        assert_eq!(page_bounds(10, 20, 5), 10..10, "offset 越界 → 空页");
        assert_eq!(page_bounds(100, 80, 80), 80..100);
    }
}
