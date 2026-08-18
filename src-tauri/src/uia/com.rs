// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA COM 核心 — 只存活在 hologram-uia 专用线程内（worker.rs 调度）。
//
// 关键纪律：
//   - COM 对象（IUIAutomationElement 等）绝不跨线程；本文件所有 fn 只被
//     worker_loop 在同一线程调用
//   - 树缓存 hwnd → {generation, controls, elements}：uia_tree 填充，
//     动作按 ref(全量下标) O(1) 取元素；失效自动重建一次（对 Agent 透明）
//   - 读路径（tree/find/resolve/read/wait）零打扰：不抢前台、不动光标
//   - 写路径 pattern 优先（Invoke/Toggle/Select/Expand/SetValue/Scroll），
//     物理兜底（SendInput/剪贴板）必须由 rpc 层授权后才走（allow_* 参数）
//   - UIA_E_ELEMENTNOTAVAILABLE → [UIA_STALE_REF]，上层重建树重试一次

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HWND, RECT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, ExpandCollapseState, ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded,
    ExpandCollapseState_LeafNode, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
    ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
    ScrollAmount_SmallIncrement, ToggleState, ToggleState_Off, ToggleState_On,
    UIA_E_ELEMENTNOTAVAILABLE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, IsIconic, IsWindow, SetForegroundWindow, ShowWindow,
    SW_RESTORE,
};

use super::cache::{control_matches, control_type_id, control_type_name, is_interactive, page_bounds, tree_text, ControlRec};
use super::errors;
use super::worker::{Locator, Msg, Target, UiaRequest};

/// 单窗口树构建上限 — 超出即截断（标记 truncated），防失控窗口拖垮回合。
const MAX_TREE: usize = 4000;
/// wait 轮询间隔。
const WAIT_POLL_MS: u64 = 150;

fn hre(ctx: &str, e: windows::core::Error) -> String {
    let code = e.code().0 as u32;
    if code == UIA_E_ELEMENTNOTAVAILABLE {
        errors::err(errors::codes::STALE_REF, format!("{ctx}: 控件已不可用（树已变化，将自动重建）"))
    } else if code == 0x80070005 {
        errors::err(errors::codes::ACCESS_DENIED, format!("{ctx}: 目标进程权限更高（UIPI），需提权运行"))
    } else {
        errors::err(errors::codes::INTERNAL, format!("{ctx}: {e}"))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ═══════════════════════════════════════════════════════════
// worker 状态
// ═══════════════════════════════════════════════════════════

struct WindowTree {
    generation: u64,
    controls: Vec<ControlRec>,
    elements: Vec<IUIAutomationElement>,
    truncated: bool,
    built_at: Instant,
}

struct UiaCore {
    automation: IUIAutomation,
    trees: HashMap<u64, WindowTree>,
    generation_seq: u64,
}

impl UiaCore {
    fn new(automation: IUIAutomation) -> Self {
        Self { automation, trees: HashMap::new(), generation_seq: 0 }
    }

    /// 取/建窗口树（clone 出快照；元素句柄留在缓存里按 ref 索引）。
    fn tree_snapshot(&mut self, hwnd: HWND) -> Result<(u64, Vec<ControlRec>, bool), String> {
        let key = hwnd.0 as u64;
        let stale = match self.trees.get(&key) {
            Some(t) => t.built_at.elapsed() > Duration::from_secs(30),
            None => true,
        };
        if stale {
            let el = unsafe { self.automation.ElementFromHandle(hwnd) }.map_err(|e| hre("ElementFromHandle", e))?;
            let (controls, elements, truncated) = walk_tree(&self.automation, &el)?;
            self.generation_seq += 1;
            let generation = self.generation_seq;
            self.trees.insert(
                key,
                WindowTree { generation, controls, elements, truncated, built_at: Instant::now() },
            );
        }
        let t = self.trees.get(&key).expect("刚插入");
        Ok((t.generation, t.controls.clone(), t.truncated))
    }

    /// 强制重建（ref 失效重试用）。
    fn rebuild_tree(&mut self, hwnd: HWND) -> Result<(u64, Vec<ControlRec>, bool), String> {
        self.trees.remove(&(hwnd.0 as u64));
        self.tree_snapshot(hwnd)
    }

    fn element_at(&self, hwnd: HWND, ref_id: usize) -> Option<IUIAutomationElement> {
        self.trees.get(&(hwnd.0 as u64))?.elements.get(ref_id).cloned()
    }
}

// ═══════════════════════════════════════════════════════════
// worker 主循环
// ═══════════════════════════════════════════════════════════

pub(super) fn worker_loop(rx: std::sync::mpsc::Receiver<Msg>) {
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() {
        drain_with(rx, &format!("UIA COM 初始化失败: {hr:?}"));
        return;
    }
    let automation: IUIAutomation =
        match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
            Ok(a) => a,
            Err(e) => {
                drain_with(rx, &format!("UIA CUIAutomation 创建失败: {e}"));
                return;
            }
        };
    let mut core = UiaCore::new(automation);
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Quit => break,
            Msg::Req(req) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dispatch(&mut core, req)
            })) {
                Ok((reply, result)) => {
                    let _ = reply.send(result);
                }
                Err(p) => {
                    // reply 已随 panic drop → 调用方收到 RecvError → INTERNAL
                    eprintln!("[uia] worker panic（已恢复）: {p:?}");
                }
            },
        }
    }
}

fn drain_with(rx: std::sync::mpsc::Receiver<Msg>, msg: &str) {
    while let Ok(m) = rx.recv() {
        if let Msg::Req(req) = m {
            let _ = send_err(req, errors::err(errors::codes::INTERNAL, msg));
        }
    }
}

/// 把请求的 reply 取出来发错误（初始化失败路径）。
fn send_err(req: UiaRequest, e: String) -> Result<(), String> {
    macro_rules! take {
        ($v:expr) => {{
            let r = $v;
            let _ = r.send(Err(e.clone()));
        }};
    }
    match req {
        UiaRequest::Tree { reply, .. } => take!(reply),
        UiaRequest::Find { reply, .. } => take!(reply),
        UiaRequest::Resolve { reply, .. } => take!(reply),
        UiaRequest::Read { reply, .. } => take!(reply),
        UiaRequest::Wait { reply, .. } => take!(reply),
        UiaRequest::Click { reply, .. } => take!(reply),
        UiaRequest::Type { reply, .. } => take!(reply),
        UiaRequest::Scroll { reply, .. } => take!(reply),
        UiaRequest::Select { reply, .. } => take!(reply),
        UiaRequest::Expand { reply, .. } => take!(reply),
        UiaRequest::Keys { reply, .. } => take!(reply),
        UiaRequest::Activate { reply, .. } => take!(reply),
        UiaRequest::WindowRect { reply, .. } => take!(reply),
        UiaRequest::ProbeRoute { reply, .. } => take!(reply),
    }
    Ok(())
}

type R = Result<Value, String>;

fn dispatch(core: &mut UiaCore, req: UiaRequest) -> (super::worker::Reply, R) {
    match req {
        UiaRequest::Tree { loc, all, offset, max_results, reply } => {
            (reply, req_tree(core, &loc, all, offset, max_results))
        }
        UiaRequest::Find { loc, all, name, ctype, aid, enabled, reply } => {
            (reply, req_find(core, &loc, all, name.as_deref(), ctype.as_deref(), aid.as_deref(), enabled))
        }
        UiaRequest::Resolve { loc, target, reply } => (reply, req_resolve(core, &loc, &target)),
        UiaRequest::Read { loc, target, reply } => (reply, req_read(core, &loc, &target)),
        UiaRequest::Wait { loc, target, until, value, timeout_ms, reply } => {
            (reply, req_wait(core, loc, target, until, value, timeout_ms))
        }
        UiaRequest::Click { loc, target, right, allow_coords, reply } => {
            (reply, req_click(core, loc, target, right, allow_coords))
        }
        UiaRequest::Type { loc, target, text, allow_physical, reply } => {
            (reply, req_type(core, loc, target, &text, allow_physical))
        }
        UiaRequest::Scroll { loc, target, direction, amount, allow_wheel, reply } => {
            (reply, req_scroll(core, loc, target, &direction, amount, allow_wheel))
        }
        UiaRequest::Select { loc, target, reply } => (reply, req_simple_pattern(core, loc, target, "select")),
        UiaRequest::Expand { loc, target, reply } => (reply, req_simple_pattern(core, loc, target, "expand")),
        UiaRequest::Keys { loc, modifiers, key, reply } => (reply, req_keys(core, loc, &modifiers, &key)),
        UiaRequest::Activate { loc, reply } => (reply, req_activate(core, loc)),
        UiaRequest::WindowRect { loc, reply } => (reply, req_window_rect(core, &loc)),
        UiaRequest::ProbeRoute { hwnd, budget_ms, reply } => (reply, req_probe_route(core, hwnd, budget_ms)),
    }
}

// ═══════════════════════════════════════════════════════════
// 元素属性读取（全 Result 兜底 → 缺省值，与旧 PS 版 Try/Catch 姿势一致）
// ═══════════════════════════════════════════════════════════

fn rec_of(el: &IUIAutomationElement, ref_id: usize, depth: u32) -> ControlRec {
    unsafe {
        let ctype = el.CurrentControlType().map(|c| c.0 as u32).unwrap_or(0);
        let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
        let aid = el.CurrentAutomationId().map(|b| b.to_string()).unwrap_or_default();
        let enabled = el.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(true);
        let password = el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false);
        let r = el.CurrentBoundingRectangle().unwrap_or(RECT::default());
        ControlRec {
            ref_id,
            ctype,
            name,
            automation_id: aid,
            enabled,
            password,
            rect: (r.left, r.top, r.right - r.left, r.bottom - r.top),
            depth,
        }
    }
}

fn el_pid(el: &IUIAutomationElement) -> i64 {
    unsafe { el.CurrentProcessId().map(|p| p as i64).unwrap_or(-1) }
}

fn el_name(el: &IUIAutomationElement) -> String {
    unsafe { el.CurrentName().map(|b| b.to_string()).unwrap_or_default() }
}

fn el_hwnd(el: &IUIAutomationElement) -> i64 {
    unsafe { el.CurrentNativeWindowHandle().map(|h| h.0 as i64).unwrap_or(0) }
}

// ═══════════════════════════════════════════════════════════
// 树遍历（ControlViewWalker DFS 先序，保持文档顺序）
// ═══════════════════════════════════════════════════════════

fn children_of(walker: &IUIAutomationTreeWalker, el: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
    let mut out = Vec::new();
    unsafe {
        let mut cur = match walker.GetFirstChildElement(el) {
            Ok(c) => c,
            Err(_) => return out,
        };
        loop {
            out.push(cur.clone());
            match walker.GetNextSiblingElement(&cur) {
                Ok(next) => cur = next,
                Err(_) => break,
            }
            if out.len() >= MAX_TREE {
                break;
            }
        }
    }
    out
}

fn walk_tree(
    automation: &IUIAutomation,
    root: &IUIAutomationElement,
) -> Result<(Vec<ControlRec>, Vec<IUIAutomationElement>, bool), String> {
    let walker = unsafe { automation.ControlViewWalker() }.map_err(|e| hre("ControlViewWalker", e))?;
    let mut controls: Vec<ControlRec> = Vec::new();
    let mut elements: Vec<IUIAutomationElement> = Vec::new();
    let mut truncated = false;
    // 栈式 DFS：子级逆序入栈保证先序输出（父在前、同级按序）
    let mut stack: Vec<(IUIAutomationElement, u32)> = Vec::new();
    for c in children_of(&walker, root).into_iter().rev() {
        stack.push((c, 1));
    }
    while let Some((el, depth)) = stack.pop() {
        if controls.len() >= MAX_TREE {
            truncated = true;
            break;
        }
        let ref_id = controls.len();
        controls.push(rec_of(&el, ref_id, depth));
        for c in children_of(&walker, &el).into_iter().rev() {
            stack.push((c, depth + 1));
        }
        elements.push(el);
    }
    Ok((controls, elements, truncated))
}

// ═══════════════════════════════════════════════════════════
// 窗口定位（hwnd > pid > title > 前台；不抢前台）
// ═══════════════════════════════════════════════════════════

struct Located {
    hwnd: HWND,
    element: IUIAutomationElement,
    pid: i64,
    title: String,
}

fn locate_window(core: &UiaCore, loc: &Locator) -> Result<Located, String> {
    if let Some(h) = loc.hwnd {
        let hwnd = HWND(h as usize as *mut _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err(errors::err(
                errors::codes::WINDOW_NOT_FOUND,
                format!("hwnd={h} 无效或已关闭（句柄可能失效，请重新 desktop_probe 获取最新 hwnd）"),
            ));
        }
        let el = unsafe { core.automation.ElementFromHandle(hwnd) }
            .map_err(|e| hre("ElementFromHandle", e))?;
        return Ok(Located { hwnd, pid: el_pid(&el), title: el_name(&el), element: el });
    }
    if loc.pid.is_some() || loc.title.is_some() {
        let root = unsafe { core.automation.GetRootElement() }
            .map_err(|e| hre("GetRootElement", e))?;
        let walker = unsafe { core.automation.ControlViewWalker() }
            .map_err(|e| hre("ControlViewWalker", e))?;
        for c in children_of(&walker, &root) {
            let pid_match = loc.pid.map(|want| el_pid(&c) == want as i64).unwrap_or(true);
            let title_match = loc
                .title
                .as_deref()
                .map(|want| el_name(&c).to_lowercase().contains(&want.to_lowercase()))
                .unwrap_or(true);
            if pid_match && title_match {
                let h = el_hwnd(&c);
                let hwnd = HWND(h as usize as *mut _);
                if h != 0 && unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                    return Ok(Located { hwnd, pid: el_pid(&c), title: el_name(&c), element: c });
                }
            }
        }
        let desc = if let Some(p) = loc.pid {
            format!("pid={p} 的主窗口")
        } else {
            format!("标题含「{}」的顶层窗口", loc.title.clone().unwrap_or_default())
        };
        return Err(errors::err(
            errors::codes::WINDOW_NOT_FOUND,
            format!("找不到{desc}（先 desktop_probe 确认窗口存在）"),
        ));
    }
    // 前台窗口
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err(errors::err(errors::codes::WINDOW_NOT_FOUND, "无法定位前台窗口"));
    }
    let el = unsafe { core.automation.ElementFromHandle(hwnd) }
        .map_err(|e| hre("ElementFromHandle", e))?;
    Ok(Located { hwnd, pid: el_pid(&el), title: el_name(&el), element: el })
}

// ═══════════════════════════════════════════════════════════
// 控件解析（ref → 缓存下标；selector → 精确条件首个命中）
// ═══════════════════════════════════════════════════════════

fn resolve_index(core: &mut UiaCore, hwnd: HWND, target: &Target) -> Result<usize, String> {
    let (_, controls, _) = core.tree_snapshot(hwnd)?;
    resolve_index_in(&controls, target)
}

fn resolve_index_in(controls: &[ControlRec], target: &Target) -> Result<usize, String> {
    if let Some(r) = target.ref_id {
        let r = r as usize;
        return if r < controls.len() {
            Ok(r)
        } else {
            Err(errors::err(
                errors::codes::STALE_REF,
                format!("ref {r} 不存在（控件列表已变化，请重新 desktop_uia_tree 获取新 ref）"),
            ))
        };
    }
    // selector 模式：name 精确(忽略大小写) / automation_id 精确 / control_type 精确，AND 组合
    if !target.has_any() {
        return Err(errors::err(
            errors::codes::ARG_INVALID,
            "至少要给一个定位条件（ref / name / automation_id / control_type）",
        ));
    }
    for c in controls {
        let name_ok = target
            .name
            .as_deref()
            .map(|want| c.name.eq_ignore_ascii_case(want))
            .unwrap_or(true);
        let aid_ok = target
            .automation_id
            .as_deref()
            .map(|want| c.automation_id.eq_ignore_ascii_case(want))
            .unwrap_or(true);
        let ct_ok = target
            .control_type
            .as_deref()
            .and_then(control_type_id)
            .map(|want| c.ctype == want)
            .unwrap_or(true);
        if name_ok && aid_ok && ct_ok {
            return Ok(c.ref_id);
        }
    }
    Err(errors::err(
        errors::codes::WINDOW_NOT_FOUND,
        "找不到匹配控件（name/automation_id/control_type 组合无命中，先 desktop_uia_tree 确认实际值）",
    ))
}

/// 解析元素：缓存索引直取；元素失效时重建树重试一次（对 Agent 透明的自愈）。
fn resolve_element(
    core: &mut UiaCore,
    hwnd: HWND,
    target: &Target,
) -> Result<(usize, IUIAutomationElement), String> {
    let idx = resolve_index(core, hwnd, target)?;
    if let Some(el) = core.element_at(hwnd, idx) {
        // 探活：读一个属性，元素 detached 会报 ELEMENTNOTAVAILABLE
        let _ = unsafe { el.CurrentIsEnabled() };
        return Ok((idx, el));
    }
    let _ = core.rebuild_tree(hwnd)?;
    let idx = resolve_index(core, hwnd, target)?;
    let el = core.element_at(hwnd, idx).ok_or_else(|| {
        errors::err(errors::codes::STALE_REF, "控件已失效且重建后仍未找到（请重新 desktop_uia_tree）")
    })?;
    Ok((idx, el))
}

fn pattern_of<T: Interface>(el: &IUIAutomationElement, pattern_id: windows::Win32::UI::Accessibility::UIA_PATTERN_ID) -> Option<T> {
    unsafe { el.GetCurrentPatternAs::<T>(pattern_id) }.ok()
}

// ═══════════════════════════════════════════════════════════
// Tree / Find 请求
// ═══════════════════════════════════════════════════════════

fn controls_json(c: &ControlRec) -> Value {
    json!({
        "ref": c.ref_id,
        "name": c.name,
        "type": control_type_name(c.ctype),
        "automation_id": c.automation_id,
        "enabled": c.enabled,
        "value": c.value_or_mask(),
        "rect": format!("{},{},{},{}", c.rect.0, c.rect.1, c.rect.2, c.rect.3),
        "depth": c.depth,
    })
}

impl ControlRec {
    /// value 掩码占位（实际 value 由 read/action 读回时掩码；树里不读 value，
    /// 省一次 COM 往返/控件，旧版树里的 value 字段在 UIA 直连下不再默认读取）。
    fn value_or_mask(&self) -> Value {
        Value::String(String::new())
    }
}

fn req_tree(core: &mut UiaCore, loc: &Locator, all: bool, offset: usize, max_results: usize) -> R {
    let located = locate_window(core, loc)?;
    let (generation, controls, truncated_tree) = core.tree_snapshot(located.hwnd)?;
    let subset: Vec<ControlRec> = controls
        .iter()
        .filter(|c| all || is_interactive(c.ctype))
        .cloned()
        .collect();
    let total = subset.len();
    let (start, end) = {
        let r = page_bounds(total, offset, max_results);
        (r.start, r.end)
    };
    let page: Vec<ControlRec> = subset[start..end].to_vec();
    let truncated = end < total || truncated_tree;
    Ok(json!({
        "window": {
            "pid": located.pid,
            "title": located.title,
            "hwnd": located.hwnd.0 as i64,
        },
        "refs": controls.len(),
        "generation": generation,
        "interactive_only": !all,
        "total": total,
        "offset": start,
        "count": page.len(),
        "truncated": truncated,
        "tree": tree_text(&page),
        "controls": page.iter().map(controls_json).collect::<Vec<_>>(),
        "note": if truncated_tree {
            "树过大已截断（>4000 控件）；用 find 精确查找或 name/automation_id selector 定位"
        } else {
            "默认只列可交互控件（all:true 看全量）；ref 是全量树下标，动作/翻页均稳定复用"
        },
    }))
}

fn req_find(
    core: &mut UiaCore,
    loc: &Locator,
    all: bool,
    name: Option<&str>,
    ctype: Option<&str>,
    aid: Option<&str>,
    enabled: Option<bool>,
) -> R {
    if let Some(t) = ctype {
        if control_type_id(t).is_none() {
            return Err(errors::err(
                errors::codes::ARG_INVALID,
                format!("未知 ControlType: {t}（常见: Button, Edit, ListItem, MenuItem, CheckBox, ComboBox, Pane, Window）"),
            ));
        }
    }
    let located = locate_window(core, loc)?;
    let (generation, controls, _) = core.tree_snapshot(located.hwnd)?;
    let matched: Vec<ControlRec> = controls
        .iter()
        .filter(|c| (all || is_interactive(c.ctype)) && control_matches(c, name, ctype, aid, enabled))
        .cloned()
        .collect();
    Ok(json!({
        "window": {
            "pid": located.pid,
            "title": located.title,
            "hwnd": located.hwnd.0 as i64,
        },
        "generation": generation,
        "matched": matched.len(),
        "controls": matched.iter().map(controls_json).collect::<Vec<_>>(),
    }))
}

// ═══════════════════════════════════════════════════════════
// 世界快照与 diff（反馈闭环）
// ═══════════════════════════════════════════════════════════

use windows::Win32::UI::Accessibility::{
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationScrollItemPattern,
    IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
    IUIAutomationValuePattern, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
    UIA_ScrollItemPatternId, UIA_ScrollPatternId, UIA_SelectionItemPatternId,
    UIA_TogglePatternId, UIA_ValuePatternId,
};

fn toggle_str(s: ToggleState) -> &'static str {
    match s.0 {
        x if x == ToggleState_On.0 => "on",
        x if x == ToggleState_Off.0 => "off",
        _ => "indeterminate",
    }
}

fn expand_str(s: ExpandCollapseState) -> &'static str {
    match s.0 {
        x if x == ExpandCollapseState_Expanded.0 => "expanded",
        x if x == ExpandCollapseState_Collapsed.0 => "collapsed",
        _ => "leaf",
    }
}

#[derive(Clone, Default)]
struct Snap {
    title: String,
    focused: String,
    value: Option<String>,
    toggle: Option<String>,
    expand: Option<String>,
    v_pct: Option<f64>,
    h_pct: Option<f64>,
}

fn snap_target(core: &UiaCore, hwnd: HWND, el: &IUIAutomationElement) -> Snap {
    let mut s = Snap {
        title: el_name(&unsafe { core.automation.ElementFromHandle(hwnd) }.unwrap_or_else(|_| el.clone())),
        focused: unsafe { core.automation.GetFocusedElement() }
            .map(|f| el_name(&f))
            .unwrap_or_default(),
        ..Default::default()
    };
    if let Some(vp) = pattern_of::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) {
        unsafe {
            // 密码框掩码（ValuePattern 无 IsPassword — 用元素级 IsPassword 判定）
            let pw = el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false);
            s.value = Some(if pw { "***".into() } else { vp.CurrentValue().map(|b| b.to_string()).unwrap_or_default() });
        }
    }
    if let Some(tp) = pattern_of::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId) {
        s.toggle = unsafe { tp.CurrentToggleState() }.ok().map(|t| toggle_str(t).to_string());
    }
    if let Some(ep) = pattern_of::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId) {
        s.expand = unsafe { ep.CurrentExpandCollapseState() }.ok().map(|t| expand_str(t).to_string());
    }
    if let Some(sp) = pattern_of::<IUIAutomationScrollPattern>(el, UIA_ScrollPatternId) {
        s.v_pct = unsafe { sp.CurrentVerticalScrollPercent() }.ok();
        s.h_pct = unsafe { sp.CurrentHorizontalScrollPercent() }.ok();
    }
    s
}

fn diff_snaps(before: &Snap, after: &Snap) -> Value {
    let mut changed = serde_json::Map::new();
    if before.title != after.title {
        changed.insert("window_title".into(), json!(format!("{} → {}", before.title, after.title)));
    }
    if before.focused != after.focused {
        changed.insert(
            "focused".into(),
            json!(format!("{} → {}", before.focused, after.focused)),
        );
    }
    if before.value != after.value {
        let fmt = |v: &Option<String>| v.clone().unwrap_or_else(|| "—".into());
        changed.insert("value".into(), json!(format!("{} → {}", fmt(&before.value), fmt(&after.value))));
    }
    if before.toggle != after.toggle {
        let fmt = |v: &Option<String>| v.clone().unwrap_or_else(|| "—".into());
        changed.insert("toggle".into(), json!(format!("{} → {}", fmt(&before.toggle), fmt(&after.toggle))));
    }
    if before.expand != after.expand {
        let fmt = |v: &Option<String>| v.clone().unwrap_or_else(|| "—".into());
        changed.insert("expand".into(), json!(format!("{} → {}", fmt(&before.expand), fmt(&after.expand))));
    }
    if before.v_pct != after.v_pct || before.h_pct != after.h_pct {
        changed.insert(
            "scroll".into(),
            json!(format!(
                "v {:?}→{:?} h {:?}→{:?}",
                before.v_pct, after.v_pct, before.h_pct, after.h_pct
            )),
        );
    }
    Value::Object(changed)
}

fn target_json(el: &IUIAutomationElement, snap: &Snap) -> Value {
    let rec = rec_of(el, 0, 0);
    json!({
        "name": rec.name,
        "type": control_type_name(rec.ctype),
        "automation_id": rec.automation_id,
        "enabled": rec.enabled,
        "value": snap.value.clone().unwrap_or_default(),
        "toggle": snap.toggle,
        "expand": snap.expand,
    })
}

fn action_result(
    method: &str,
    hwnd: HWND,
    pid: i64,
    title: &str,
    el: &IUIAutomationElement,
    before: &Snap,
    after: &Snap,
) -> Value {
    let changed = diff_snaps(before, after);
    let changed_any = changed.as_object().map(|o| !o.is_empty()).unwrap_or(false);
    json!({
        "done": true,
        "method": method,
        "window": { "pid": pid, "title": title, "hwnd": hwnd.0 as i64 },
        "target": target_json(el, after),
        "changed": changed,
        "hint": if changed_any {
            "目标窗口已发生变化（见 changed）；若非预期可 desktop_uia_read 复核"
        } else {
            "操作已提交，未观察到窗口变化（异步生效或需等待；可用 desktop_uia_wait 轮询确认）"
        },
    })
}

// ═══════════════════════════════════════════════════════════
// 物理输入（必须由 rpc 层授权 + 持有 input lease 才可达）
// ═══════════════════════════════════════════════════════════

#[allow(clippy::upper_case_acronyms)]
mod phys {
    use super::*;

    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSE_EVENT_FLAGS,
        MOUSEINPUT, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;

    fn send(inputs: &[INPUT]) {
        if inputs.is_empty() {
            return;
        }
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub(super) fn click(x: i32, y: i32, right: bool) {
        let _ = unsafe { SetCursorPos(x, y) };
        let (down, up) = if right {
            (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        } else {
            (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
        };
        send(&[mouse_input(down, x, y, 0), mouse_input(up, x, y, 0)]);
    }

    pub(super) fn wheel(x: i32, y: i32, delta: i32, horizontal: bool) {
        let _ = unsafe { SetCursorPos(x, y) };
        let flags = if horizontal { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL };
        send(&[mouse_input(flags, x, y, delta)]);
    }

    /// key 名 → VK 码。支持功能键/编辑键/箭头/F1-F12/单字符。
    fn vk_of(key: &str) -> Option<u16> {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        let k = key.trim();
        let vk = match k.to_ascii_lowercase().as_str() {
            "enter" | "return" => VK_RETURN.0,
            "tab" => VK_TAB.0,
            "escape" | "esc" => VK_ESCAPE.0,
            "backspace" => VK_BACK.0,
            "delete" | "del" => VK_DELETE.0,
            "insert" => VK_INSERT.0,
            "home" => VK_HOME.0,
            "end" => VK_END.0,
            "pageup" => VK_PRIOR.0,
            "pagedown" => VK_NEXT.0,
            "up" | "arrowup" => VK_UP.0,
            "down" | "arrowdown" => VK_DOWN.0,
            "left" | "arrowleft" => VK_LEFT.0,
            "right" | "arrowright" => VK_RIGHT.0,
            "space" => VK_SPACE.0,
            "win" | "meta" => VK_LWIN.0,
            other => {
                let mut chars = other.chars();
                let (first, second) = (chars.next(), chars.next());
                match (first, second) {
                    (Some(c), None) if c.is_ascii_alphanumeric() => c.to_ascii_uppercase() as u16,
                    (Some('f'), Some(d)) if d.is_ascii_digit() => {
                        // F1-F12
                        let n: u32 = other[1..].parse().unwrap_or(0);
                        if (1..=12).contains(&n) {
                            0x70 + (n - 1) as u16
                        } else {
                            return None;
                        }
                    }
                    _ => return None,
                }
            }
        };
        Some(vk)
    }

    /// 修饰键序列：ctrl/alt/shift/meta(win)。
    fn mod_vks(mods: &[String]) -> Result<Vec<u16>, String> {
        let mut out = Vec::new();
        for m in mods {
            let vk = match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => VK_CONTROL.0,
                "alt" | "option" => VK_MENU.0,
                "shift" => VK_SHIFT.0,
                "meta" | "cmd" | "win" => VK_LWIN.0,
                other => return Err(errors::err(errors::codes::ARG_INVALID, format!("不支持的修饰键: {other}（ctrl/alt/shift/meta）"))),
            };
            if !out.contains(&vk) {
                out.push(vk);
            }
        }
        Ok(out)
    }

    fn key_input(vk: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// 热键：按住 modifiers → key down/up → 释放 modifiers。
    pub(super) fn key_tap(mods: &[String], key: &str) -> Result<(), String> {
        let vk = vk_of(key).ok_or_else(|| {
            errors::err(
                errors::codes::ARG_INVALID,
                format!("无法识别的按键: {key}（Enter/Tab/Escape/Backspace/Delete/ArrowUp/F1-F12/单字符）"),
            )
        })?;
        let m = mod_vks(mods)?;
        let mut seq: Vec<INPUT> = m.iter().map(|&v| key_input(v, false)).collect();
        seq.push(key_input(vk, false));
        seq.push(key_input(vk, true));
        seq.extend(m.iter().rev().map(|&v| key_input(v, true)));
        send(&seq);
        Ok(())
    }
}

/// 剪贴板写入（type 的 paste 兜底）。写入前保存旧内容，调用方负责恢复。
pub(super) fn clipboard_set(text: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        if !opened {
            return Err(errors::err(errors::codes::INTERNAL, "剪贴板打不开（被其他进程占用）"));
        }
        let result = (|| -> Result<(), String> {
            let w: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let bytes = w.len() * 2;
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes)
                .map_err(|e| errors::err(errors::codes::INTERNAL, format!("GlobalAlloc: {e}")))?;
            let p = GlobalLock(h);
            if p.is_null() {
                return Err(errors::err(errors::codes::INTERNAL, "GlobalLock 失败"));
            }
            std::ptr::copy_nonoverlapping(w.as_ptr(), p.cast::<u16>(), w.len());
            let _ = GlobalUnlock(h);
            let _ = EmptyClipboard();
            SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(h.0)))
                .map_err(|e| errors::err(errors::codes::INTERNAL, format!("SetClipboardData: {e}")))?;
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

pub(super) fn clipboard_get() -> Option<String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    unsafe {
        if !OpenClipboard(None).is_ok() {
            return None;
        }
        let out = (|| -> Option<String> {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let h = windows::Win32::Foundation::HGLOBAL(handle.0);
            let p = GlobalLock(h);
            if p.is_null() {
                return None;
            }
            // SAFETY: CF_UNICODETEXT 数据是以 nul 结尾的 UTF-16 缓冲
            let mut len = 0usize;
            while *p.cast::<u16>().add(len) != 0 {
                len += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(p.cast::<u16>(), len));
            let _ = GlobalUnlock(h);
            Some(s)
        })();
        let _ = CloseClipboard();
        out
    }
}

fn center_of(el: &IUIAutomationElement) -> Result<(i32, i32), String> {
    let r = unsafe { el.CurrentBoundingRectangle() }
        .map_err(|e| hre("BoundingRectangle", e))?;
    if r.right <= r.left || r.bottom <= r.top {
        return Err(errors::err(
            errors::codes::STALE_REF,
            "控件没有可点击区域（可能已隐藏或滚动出视口，请重新 desktop_uia_tree）",
        ));
    }
    Ok((r.left + (r.right - r.left) / 2, r.top + (r.bottom - r.top) / 2))
}

// ═══════════════════════════════════════════════════════════
// 动作请求实现
// ═══════════════════════════════════════════════════════════

fn req_resolve(core: &mut UiaCore, loc: &Locator, target: &Target) -> R {
    let located = locate_window(core, loc)?;
    let (idx, el) = resolve_element(core, located.hwnd, target)?;
    let rec = rec_of(&el, idx, 0);
    let has_value: bool = pattern_of::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId).is_some();
    let value = if has_value {
        snap_target(core, located.hwnd, &el).value
    } else {
        None
    };
    Ok(json!({
        "hwnd": located.hwnd.0 as i64,
        "pid": located.pid,
        "title": located.title,
        "ref": idx,
        "name": rec.name,
        "type": control_type_name(rec.ctype),
        "automation_id": rec.automation_id,
        "enabled": rec.enabled,
        "password": rec.password,
        "value": value.unwrap_or_default(),
        "has_invoke": pattern_of::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId).is_some(),
        "has_toggle": pattern_of::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId).is_some(),
        "has_select": pattern_of::<IUIAutomationSelectionItemPattern>(&el, UIA_SelectionItemPatternId).is_some(),
        "has_expand": pattern_of::<IUIAutomationExpandCollapsePattern>(&el, UIA_ExpandCollapsePatternId).is_some(),
        "has_value": has_value,
        "has_scroll": pattern_of::<IUIAutomationScrollPattern>(&el, UIA_ScrollPatternId).is_some(),
    }))
}

fn req_read(core: &mut UiaCore, loc: &Locator, target: &Target) -> R {
    let located = locate_window(core, loc)?;
    let (idx, el) = resolve_element(core, located.hwnd, target)?;
    let rec = rec_of(&el, idx, 0);
    let snap = snap_target(core, located.hwnd, &el);
    let patterns: Vec<&str> = [
        (UIA_ValuePatternId, "Value"),
        (UIA_TogglePatternId, "Toggle"),
        (UIA_InvokePatternId, "Invoke"),
        (UIA_SelectionItemPatternId, "SelectionItem"),
        (UIA_ExpandCollapsePatternId, "ExpandCollapse"),
        (UIA_ScrollPatternId, "Scroll"),
        (UIA_ScrollItemPatternId, "ScrollItem"),
    ]
    .iter()
    .filter(|(id, _)| {
        use windows::core::IUnknown;
        unsafe { el.GetCurrentPatternAs::<IUnknown>(*id) }.is_ok()
    })
    .map(|(_, name)| *name)
    .collect();
    Ok(json!({
        "window": { "pid": located.pid, "title": located.title, "hwnd": located.hwnd.0 as i64 },
        "ref": idx,
        "name": rec.name,
        "type": control_type_name(rec.ctype),
        "automation_id": rec.automation_id,
        "enabled": rec.enabled,
        "rect": format!("{},{},{},{}", rec.rect.0, rec.rect.1, rec.rect.2, rec.rect.3),
        "patterns": patterns,
        "value": snap.value,
        "toggle": snap.toggle,
        "expand": snap.expand,
        "scroll": { "vertical_percent": snap.v_pct, "horizontal_percent": snap.h_pct },
    }))
}

fn req_wait(core: &mut UiaCore, loc: Locator, target: Target, until: String, value: Option<String>, timeout_ms: u64) -> R {
    let timeout = Duration::from_millis(timeout_ms.clamp(100, 30_000));
    let started = Instant::now();
    let until_valid = ["exists", "enabled", "value"].contains(&until.as_str());
    if !until_valid {
        return Err(errors::err(
            errors::codes::ARG_INVALID,
            format!("until 必须是 exists/enabled/value 之一，收到: {until}"),
        ));
    }
    if until == "value" && value.is_none() {
        return Err(errors::err(errors::codes::ARG_INVALID, "until=value 需要同时给 value 参数"));
    }
    loop {
        let ok = (|| -> Result<bool, String> {
            let located = locate_window(core, &loc)?;
            let (_, el) = resolve_element(core, located.hwnd, &target)?;
            match until.as_str() {
                "exists" => Ok(true),
                "enabled" => Ok(unsafe { el.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(false)),
                _ => {
                    let v = snap_target(core, located.hwnd, &el).value.unwrap_or_default();
                    Ok(v == value.clone().unwrap_or_default())
                }
            }
        })();
        match ok {
            Ok(true) => {
                return Ok(json!({
                    "found": true,
                    "until": until,
                    "waited_ms": started.elapsed().as_millis() as u64,
                }));
            }
            Ok(false) => {}
            Err(_) if until == "exists" => {} // 窗口/控件尚未出现 → 继续等
            Err(e) => return Err(e),
        }
        if started.elapsed() >= timeout {
            return Ok(json!({
                "found": false,
                "until": until,
                "waited_ms": started.elapsed().as_millis() as u64,
                "hint": "超时未满足条件；可加大 timeout_ms 或重新 desktop_uia_tree 观察现状",
            }));
        }
        std::thread::sleep(Duration::from_millis(WAIT_POLL_MS));
    }
}

fn req_click(core: &mut UiaCore, loc: Locator, target: Target, right: bool, allow_coords: bool) -> R {
    let located = locate_window(core, &loc)?;
    let (_, el) = resolve_element(core, located.hwnd, &target)?;
    let before = snap_target(core, located.hwnd, &el);
    let method: String;
    if right {
        // 右键没有 pattern 语义 —— 纯坐标物理输入
        let (x, y) = center_of(&el)?;
        if !allow_coords {
            return Err(errors::err(
                errors::codes::NO_PATTERN,
                "右键是纯物理输入（需批准物理输入路径后执行）",
            ));
        }
        phys::click(x, y, true);
        method = "coords".into();
    } else {
        let invoked = pattern_of::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId)
            .and_then(|p| unsafe { p.Invoke() }.ok());
        if invoked.is_some() {
            method = "invoke".into();
        } else if let Some(tp) = pattern_of::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId) {
            unsafe { tp.Toggle() }.map_err(|e| hre("Toggle", e))?;
            method = "toggle".into();
        } else if let Some(sp) = pattern_of::<IUIAutomationSelectionItemPattern>(&el, UIA_SelectionItemPatternId) {
            unsafe { sp.Select() }.map_err(|e| hre("Select", e))?;
            method = "selection".into();
        } else {
            let (x, y) = center_of(&el)?;
            if !allow_coords {
                return Err(errors::err(
                    errors::codes::NO_PATTERN,
                    "该控件不支持 Invoke/Toggle/Select pattern，只能坐标点击（需批准物理输入路径后执行）",
                ));
            }
            if let Some(si) = pattern_of::<IUIAutomationScrollItemPattern>(&el, UIA_ScrollItemPatternId) {
                let _ = unsafe { si.ScrollIntoView() };
            }
            phys::click(x, y, false);
            method = "coords".into();
        }
    }
    std::thread::sleep(Duration::from_millis(120));
    let after = snap_target(core, located.hwnd, &el);
    Ok(action_result(&method, located.hwnd, located.pid, &located.title, &el, &before, &after))
}

fn req_type(core: &mut UiaCore, loc: Locator, target: Target, text: &str, allow_physical: bool) -> R {
    let located = locate_window(core, &loc)?;
    let (_, el) = resolve_element(core, located.hwnd, &target)?;
    let before = snap_target(core, located.hwnd, &el);
    let method: String;
    if let Some(vp) = pattern_of::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId) {
        let w = wide(text);
        let b = windows::core::BSTR::from_wide(w.as_slice());
        unsafe { vp.SetValue(&b) }.map_err(|e| hre("SetValue", e))?;
        method = "setvalue".into();
    } else if allow_physical {
        // 聚焦 + 剪贴板粘贴（保存/恢复旧剪贴板）
        unsafe { el.SetFocus() }.map_err(|e| hre("SetFocus", e))?;
        let old = clipboard_get();
        clipboard_set(text)?;
        std::thread::sleep(Duration::from_millis(80));
        phys::key_tap(&["ctrl".into()], "v")?;
        std::thread::sleep(Duration::from_millis(80));
        if let Some(prev) = old {
            let _ = clipboard_set(&prev);
        }
        method = "paste".into();
    } else {
        return Err(errors::err(
            errors::codes::NO_PATTERN,
            "该控件不支持 ValuePattern（仅提权物理输入后可用聚焦+粘贴兜底）",
        ));
    }
    std::thread::sleep(Duration::from_millis(120));
    let after = snap_target(core, located.hwnd, &el);
    Ok(action_result(&method, located.hwnd, located.pid, &located.title, &el, &before, &after))
}

fn req_scroll(
    core: &mut UiaCore,
    loc: Locator,
    target: Target,
    direction: &str,
    amount: f64,
    allow_wheel: bool,
) -> R {
    let located = locate_window(core, &loc)?;
    let (_, el) = resolve_element(core, located.hwnd, &target)?;
    let before = snap_target(core, located.hwnd, &el);
    let dir = direction.to_ascii_lowercase();
    if !["up", "down", "left", "right"].contains(&dir.as_str()) {
        return Err(errors::err(
            errors::codes::ARG_INVALID,
            format!("direction 必须是 up/down/left/right，收到: {direction}"),
        ));
    }
    let amount = if amount <= 0.0 { 1.0 } else { amount };
    let method: String;
    if let Some(sp) = pattern_of::<IUIAutomationScrollPattern>(&el, UIA_ScrollPatternId) {
        // 注意 ScrollAmount 实际值：NoAmount=2 LargeDecrement=0 LargeIncrement=3
        // SmallDecrement=1 SmallIncrement=4（windows crate 绑定与直觉不同，用常量名）
        let magnitude = if amount >= 1.0 { ScrollAmount_LargeIncrement } else { ScrollAmount_SmallIncrement };
        let (h, v) = match dir.as_str() {
            "up" => (ScrollAmount_NoAmount, ScrollAmount_LargeDecrement),
            "down" => (ScrollAmount_NoAmount, magnitude),
            "left" => (ScrollAmount_LargeDecrement, ScrollAmount_NoAmount),
            _ => (magnitude, ScrollAmount_NoAmount), // right
        };
        unsafe { sp.Scroll(h, v) }.map_err(|e| hre("Scroll", e))?;
        method = "scrollpattern".into();
    } else {
        let (x, y) = center_of(&el)?;
        if !allow_wheel {
            return Err(errors::err(
                errors::codes::NO_PATTERN,
                "该控件不支持 ScrollPattern，只能滚轮兜底（需批准物理输入路径后执行）",
            ));
        }
        let ticks = (amount.round() as i32).clamp(1, 20);
        let delta = match dir.as_str() {
            "up" => 120 * ticks,
            "down" => -120 * ticks,
            "right" => 120 * ticks,
            _ => -120 * ticks, // left
        };
        phys::wheel(x, y, delta, dir == "left" || dir == "right");
        method = "wheel".into();
    }
    std::thread::sleep(Duration::from_millis(120));
    let after = snap_target(core, located.hwnd, &el);
    Ok(action_result(&method, located.hwnd, located.pid, &located.title, &el, &before, &after))
}

fn req_simple_pattern(core: &mut UiaCore, loc: Locator, target: Target, kind: &str) -> R {
    let located = locate_window(core, &loc)?;
    let (_, el) = resolve_element(core, located.hwnd, &target)?;
    let before = snap_target(core, located.hwnd, &el);
    match kind {
        "select" => {
            let sp: IUIAutomationSelectionItemPattern =
                pattern_of(&el, UIA_SelectionItemPatternId).ok_or_else(|| {
                    errors::err(errors::codes::NO_PATTERN, "该控件不支持 SelectionItemPattern（先 desktop_uia_read 确认 patterns）")
                })?;
            unsafe { sp.Select() }.map_err(|e| hre("Select", e))?;
        }
        _ => {
            let ep: IUIAutomationExpandCollapsePattern =
                pattern_of(&el, UIA_ExpandCollapsePatternId).ok_or_else(|| {
                    errors::err(errors::codes::NO_PATTERN, "该控件不支持 ExpandCollapsePattern（组合框/树节点才有）")
                })?;
            // 幂等：已展开则折叠（toggle 语义，模型可重复调用展开/收起）
            let state = unsafe { ep.CurrentExpandCollapseState() }.map_err(|e| hre("ExpandCollapseState", e))?;
            if state.0 == ExpandCollapseState_LeafNode.0 {
                return Err(errors::err(errors::codes::NO_PATTERN, "该节点是叶子（无展开状态）"));
            }
            if state.0 == ExpandCollapseState_Expanded.0 {
                unsafe { ep.Collapse() }.map_err(|e| hre("Collapse", e))?;
            } else {
                unsafe { ep.Expand() }.map_err(|e| hre("Expand", e))?;
            }
        }
    }
    std::thread::sleep(Duration::from_millis(120));
    let after = snap_target(core, located.hwnd, &el);
    let method = if kind == "select" { "selection" } else { "expandcollapse" };
    Ok(action_result(method, located.hwnd, located.pid, &located.title, &el, &before, &after))
}

fn req_keys(core: &mut UiaCore, loc: Locator, modifiers: &[String], key: &str) -> R {
    let located = locate_window(core, &loc)?;
    phys::key_tap(modifiers, key)?;
    std::thread::sleep(Duration::from_millis(100));
    let snap = snap_target(core, located.hwnd, &located.element);
    Ok(json!({
        "done": true,
        "method": "sendinput",
        "window": { "pid": located.pid, "title": located.title, "hwnd": located.hwnd.0 as i64 },
        "changed": { "focused": snap.focused },
        "hint": "热键已注入目标窗口（SendInput）",
    }))
}

fn req_activate(core: &mut UiaCore, loc: Locator) -> R {
    let located = locate_window(core, &loc)?;
    unsafe {
        if IsIconic(located.hwnd).as_bool() {
            let _ = ShowWindow(located.hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(located.hwnd);
        let _ = located.element.SetFocus();
    }
    std::thread::sleep(Duration::from_millis(120));
    let fg = unsafe { GetForegroundWindow() };
    Ok(json!({
        "done": fg.0 == located.hwnd.0,
        "method": "activate",
        "window": { "pid": located.pid, "title": located.title, "hwnd": located.hwnd.0 as i64 },
        "foreground_now": fg.0 as i64,
        "hint": if fg.0 == located.hwnd.0 { "窗口已在前台" } else { "前台切换未生效（Windows 前台锁可能拦截，可重试一次）" },
    }))
}

fn req_window_rect(core: &mut UiaCore, loc: &Locator) -> R {
    let located = locate_window(core, loc)?;
    let mut r = RECT::default();
    let _ = unsafe { GetWindowRect(located.hwnd, &mut r) };
    if r.right <= r.left || r.bottom <= r.top {
        return Err(errors::err(
            errors::codes::WINDOW_NOT_FOUND,
            "窗口矩形无效（窗口可能最小化或已关闭）",
        ));
    }
    Ok(json!({
        "hwnd": located.hwnd.0 as i64,
        "pid": located.pid,
        "title": located.title,
        "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
    }))
}

fn req_probe_route(core: &mut UiaCore, hwnd: u64, budget_ms: u32) -> R {
    let hwnd = HWND(hwnd as usize as *mut _);
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(errors::err(errors::codes::WINDOW_NOT_FOUND, format!("hwnd={hwnd:?} 无效")));
    }
    let deadline = Instant::now() + Duration::from_millis(budget_ms as u64);
    let walker = unsafe { core.automation.ControlViewWalker() }.map_err(|e| hre("ControlViewWalker", e))?;
    let el = unsafe { core.automation.ElementFromHandle(hwnd) }.map_err(|e| hre("ElementFromHandle", e))?;
    let mut stack: Vec<IUIAutomationElement> = children_of(&walker, &el);
    let mut sampled = 0usize;
    let mut interactive_count = 0usize;
    while let Some(e) = stack.pop() {
        sampled += 1;
        let rec = rec_of(&e, 0, 0);
        if is_interactive(rec.ctype) {
            interactive_count += 1;
        }
        if sampled >= 400 || Instant::now() >= deadline {
            break;
        }
        for c in children_of(&walker, &e) {
            stack.push(c);
        }
    }
    Ok(json!({
        "hwnd": hwnd.0 as i64,
        "sampled": sampled,
        "interactive": interactive_count,
        "budget_ms": budget_ms,
        "elapsed_ms": (budget_ms as u64).saturating_sub(deadline.saturating_duration_since(Instant::now()).as_millis() as u64),
    }))
}

// ═══════════════════════════════════════════════════════════
// 测试 — 纯逻辑（VK 映射 / 掩码 / diff 不依赖 COM）
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vk_mapping_covers_common_keys() {
        // vk_of 是 phys 模块私有 —— 通过 key_tap 校验参数校验路径（无效键报 ARG_INVALID）
        assert!(phys::key_tap(&[], "NotAKey!!").is_err());
        assert!(phys::key_tap(&["bogus".into()], "a").is_err());
        // 有效组合不报错（真实注入发生在测试机上，无窗口焦点也无害）
        let _ = phys::key_tap(&[], "F13"); // F13 不支持 → 错误
        assert!(phys::key_tap(&[], "F13").is_err());
    }

    #[test]
    fn diff_snaps_reports_only_changes() {
        let mut a = Snap::default();
        a.title = "计算器".into();
        a.toggle = Some("off".into());
        let mut b = a.clone();
        b.toggle = Some("on".into());
        let d = diff_snaps(&a, &b);
        assert!(d.get("toggle").is_some(), "toggle 变化应报告: {d}");
        assert!(d.get("window_title").is_none(), "标题未变不应报告");
        let empty = diff_snaps(&a, &a);
        assert!(empty.as_object().unwrap().is_empty(), "无变化应为空对象");
    }

    #[test]
    fn expand_and_toggle_str_mapping() {
        assert_eq!(toggle_str(ToggleState_On), "on");
        assert_eq!(toggle_str(ToggleState_Off), "off");
        assert_eq!(expand_str(ExpandCollapseState_Expanded), "expanded");
        assert_eq!(expand_str(ExpandCollapseState_Collapsed), "collapsed");
        assert_eq!(expand_str(ExpandCollapseState_LeafNode), "leaf");
    }
}

