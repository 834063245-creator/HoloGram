// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA (Windows UI Automation) 客户端 — 让 Agent 观察/操作任意标准 Windows 窗口。
//
// 设计（对标 desktop.rs 的只读快照姿势 + CDP 的 snapshot+ref 交互范式）：
//   - 零新依赖：全走 PowerShell 系统内置程序集（UIAutomationClient /
//     UIAutomationTypes / System.Windows.Forms / System.Drawing），
//     与 desktop.rs 的 run_ps 同一套静默无窗口执行姿势。
//   - 交互范式：desktop_uia_tree 输出「缩进式控件树 + ref 编号」给模型；
//     click/type/scroll 按 ref 引用（对标 CDP snapshot/click/type）。
//   - 窗口定位：hwnd / pid / title（模糊）/ 前台窗口 四种取窗口，任一即可。
//   - 操作降级：click 优先 InvokePattern → Toggle/SelectionItem → 坐标点击兜底；
//     type 优先 ValuePattern.SetValue → 聚焦 + SendKeys 兜底；
//     scroll 优先 ScrollPattern → 滚轮兜底。方法名随结果返回，模型可见真实机制。
//   - 边界：只覆盖标准控件（UIA 自动暴露）；自绘控件（QQ/微信/钉钉等）树为空，
//     文档引导走 desktop_uia_window_shot + 视觉兜底。不订阅 UIA 事件、不做持续监听。
//   - 多显示器坐标：窗口 rect 基于窗口本身（GetWindowRect 屏幕坐标），
//     单显示器场景直接可用；多显示器偏移换算留 TODO（V2）。

use serde_json::{json, Value};

/// 运行 PowerShell（错误严格模式）：$ErrorActionPreference='Stop' + try/catch 包裹，
/// 任何异常以 `UIA_ERROR=` 行输出到 stdout（避免 desktop::run_ps 的 SilentlyContinue 吞错），
/// Rust 端解析该行并转为 Err。与 desktop::run_ps 相同的静默无窗口执行姿势。
fn run_ps_strict(script_body: &str) -> Result<String, String> {
    let script = format!(
        "$ErrorActionPreference='Stop'\n\
         [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         try {{\n{script_body}\n}} catch {{\n\
           Write-Output ('UIA_ERROR=' + $_.Exception.Message)\n\
           exit 1\n\
         }}\n"
    );
    let mut ps = std::process::Command::new("powershell");
    ps.args(["-NoProfile", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps.creation_flags(crate::utils::HIDDEN_CONSOLE);
    }
    let out = ps
        .output()
        .map_err(|e| format!("uia: 执行 PowerShell 失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if let Some(err_line) = stdout.lines().find(|l| l.trim_start().starts_with("UIA_ERROR=")) {
        return Err(err_line.trim_start().trim_start_matches("UIA_ERROR=").trim().to_string());
    }
    if !out.status.success() {
        return Err(format!("uia: PowerShell 退出码 {}", out.status));
    }
    Ok(stdout)
}

// ═══════════════════════════════════════════════════════════
// 窗口定位参数（树/查找/操作的公共入口）
// ═══════════════════════════════════════════════════════════

/// 定位窗口的 PowerShell 片段：返回 $__win（AutomationElement）或抛错。
/// 优先级：hwnd（精确）> pid（进程主窗口）> title（模糊，取第一个）> 前台窗口。
/// 找不到时错误信息写明失败原因（模型据此提示用户重试）。
fn window_locator_ps(title: Option<&str>, pid: Option<u32>, hwnd: Option<u64>) -> String {
    let mut ps = String::from(
        "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes\n\
         $__root = [System.Windows.Automation.AutomationElement]::RootElement\n",
    );
    if let Some(h) = hwnd {
        ps.push_str(&format!(
            "try {{ $__win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]{h}) }} \
             catch {{ throw '窗口定位失败: hwnd={h} 无效或不可访问（句柄可能已失效，请重新 desktop_probe 获取最新 hwnd）' }}\n"
        ));
    } else if let Some(p) = pid {
        ps.push_str(&format!(
            "$__cond = New-Object System.Windows.Automation.PropertyCondition(\
             [System.Windows.Automation.AutomationElement]::ProcessIdProperty, {p})\n\
             $__win = $__root.FindFirst([System.Windows.Automation.TreeScope]::Children, $__cond)\n\
             if (-not $__win) {{ throw '窗口定位失败: 找不到 pid={p} 的主窗口（进程可能没有顶层窗口，或已退出）' }}\n"
        ));
    } else if let Some(t) = title {
        let esc = t.replace('\'', "''");
        // UIA PropertyCondition 不支持通配符（'*x*' 会被当字面量）——
        // 改为遍历顶层窗口按 -like 模糊匹配（大小写不敏感）。
        ps.push_str(&format!(
            "$__all = $__root.FindAll([System.Windows.Automation.TreeScope]::Children, \
             [System.Windows.Automation.Condition]::TrueCondition)\n\
             $__win = $null\n\
             foreach ($__c in $__all) {{\n\
               try {{ if ($__c.Current.Name -like '*{esc}*') {{ $__win = $__c; break }} }} catch {{}}\n\
             }}\n\
             if (-not $__win) {{ throw '窗口定位失败: 找不到标题含「{esc}」的顶层窗口（先 desktop_probe 确认窗口存在）' }}\n"
        ));
    } else {
        ps.push_str(
            "$__fg = [System.Windows.Automation.AutomationElement]::FocusedElement\n\
             $__win = $__fg.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty)\n\
             $__win = $__root.FindFirst([System.Windows.Automation.TreeScope]::Children, \
             (New-Object System.Windows.Automation.PropertyCondition(\
             [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $__win)))\n\
             if (-not $__win) {{ throw '窗口定位失败: 无法定位前台窗口' }}\n",
        );
    }
    // 窗口基本信息（供 tree 输出 & 日志）
    ps.push_str(
        "try { $__wpid = $__win.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty) } catch { $__wpid = -1 }\n\
         try { $__wtitle = $__win.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty) } catch { $__wtitle = '' }\n\
         try { $__whwnd = $__win.Current.NativeWindowHandle } catch { $__whwnd = 0 }\n\
         Write-Output \"__WIN__=$__wpid|$__wtitle|$__whwnd\"\n",
    );
    // 把目标窗口提到前台并聚焦 —— 坐标兜底/剪贴板粘贴的强制前置条件：
    // 窗口不在前台（被遮挡/最小化）时 SetCursorPos+SendInput 会错点在挡在最上面的
    // 窗口上、SendKeys 会打进错误的焦点窗口，造成静默错点。这里统一激活一次，
    // 动作（点击/输入/滚动）真正落进目标窗口。
    ps.push_str(
        "Add-Type -AssemblyName System.Windows.Forms\n\
         try { $__win.SetFocus() } catch {}\n\
         try {\n\
           $__fgH = [System.Windows.Forms.Form]::ActiveForm\n\
           $__sf = Add-Type -MemberDefinition '\n\
             [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n\
             [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n\
             [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);\n\
           ' -Name UiaFg -Namespace Win32 -PassThru\n\
           if ([Win32.UiaFg]::IsIconic([IntPtr]$__whwnd)) { [Win32.UiaFg]::ShowWindow([IntPtr]$__whwnd, 9) }  # SW_RESTORE\n\
           [Win32.UiaFg]::SetForegroundWindow([IntPtr]$__whwnd) | Out-Null\n\
           Start-Sleep -Milliseconds 120\n\
         } catch {}\n\
         try { $__win.SetFocus() } catch {}\n",
    );
    ps
}

/// 将「ref 编号 → AutomationElement」的查找脚本片段。
/// 需要前置变量 $__win（窗口元素）。树遍历已预先构建（$__map 数组按 ref 索引）。
/// ref 是当下树的一份快照索引；实际 ref 引用的元素在树发生变化后可能不再等于数组下标。
/// 因此用「ref 只作第一优先的候选；其后按 name/ControlType 回溯偏移重定位」的策略：
/// 命中即用；名称不符说明树已漂移，按名称反查 IndexOf；再失败切回候选原元素
/// （单层容器里属性和位置通常仍有效），仍然失败才抛错提示重建树。
fn ref_lookup_ps() -> &'static str {
    "if ($null -eq $__map) { throw '内部错误: 控件索引未构建（请先调用 desktop_uia_tree 重建）' }\n\
     if ($ref -ge $__map.Count) { throw \"ref 不存在: $ref（控件列表已变化，请重新 desktop_uia_tree 获取新 ref）\" }\n\
     $__el = $__map[$ref]; $__cand = $__el; $__candName = ''\n\
     try { $__candName = $__cand.Current.Name } catch { $__candName = '' }\n\
     if ($__candName -ne '' -and $__wantName -ne '' -and $__candName -cne $__wantName) {\n\
       # 树已漂移：按名称回溯重定位（首个匹配），兜底保留原候选\n\
       $__reloc = $__map | Where-Object { try { $_.Current.Name -ceq $__wantName } catch { $false } } | Select-Object -First 1\n\
       if ($null -ne $__reloc) { $__el = $__reloc; $__cand = $__reloc }\n\
     }\n\
     if ($null -eq $__cand) { throw \"ref $ref 已失效（控件可能已销毁，请重新 desktop_uia_tree）\" }\n"
}

/// 构建 ref → 控件映射（PowerShell 端）。
/// 在窗口元素上遍历控件树（DFS 先序），每节点一行输出，同时把元素存进 $__map 数组
/// （ref = 数组下标，与输出行一一对应）。行带 d= 深度字段（根的子级=1），
/// Rust 端据此输出缩进式树。
/// depth: None/0 = 全量（FindAll Descendants 一次取齐，比递归快）；
///         Some(n>=1) = 递归 Children 到 n 层（n=1 只列直接子级，行数可控）。
fn build_tree_ps(depth: Option<u32>) -> String {
    let mut ps = String::from("Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes\n");
    let header = "$__map = New-Object System.Collections.ArrayList\n\
         $__out = New-Object System.Text.StringBuilder\n\
         [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         # BoundingRectangle 可能返回 ±Infinity（隐藏/虚拟化控件）——安全转 int，非法值兜底 0\n\
         function __SafeInt([double]$v) { if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { 0 } else { [int]$v } }\n\
         function __EmitLine($e, $d) {\n\
           try { $__ct = $e.Current.ControlType.ProgrammaticName } catch { $__ct = '' }\n\
           if ($__ct -like 'ControlType.*') { $__ct = $__ct.Substring(12) }\n\
           try { $__nm = $e.Current.Name } catch { $__nm = '' }\n\
           try { $__aid = $e.Current.AutomationId } catch { $__aid = '' }\n\
           try { $__en = $e.Current.IsEnabled } catch { $__en = $true }\n\
           try { $__vp = $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { $__vp = $null }\n\
           $__val = ''\n\
           if ($__vp) { try { $__val = $__vp.Current.Value } catch { $__val = '' } }\n\
           try { $__r = $e.Current.BoundingRectangle } catch { $__r = [System.Windows.Rect]::Empty }\n\
           $__x = __SafeInt $__r.X; $__y = __SafeInt $__r.Y; $__w = __SafeInt $__r.Width; $__h = __SafeInt $__r.Height\n\
           [void]$__map.Add($e)\n\
           $__ref = $__map.Count - 1\n\
           $__nm2 = $__nm -replace \"[\\r\\n]\", ' '\n\
           $__aid2 = $__aid -replace \"[\\r\\n]\", ' '\n\
           $__val2 = $__val -replace \"[\\r\\n]\", ' '\n\
           [void]$__out.AppendLine(\"ref=$__ref|type=$__ct|name=$__nm2|id=$__aid2|enabled=$__en|value=$__val2|rect=$__x,$__y,$__w,$__h|d=$d\")\n\
         }\n";
    let traversal = match depth {
        Some(n) if n >= 1 => {
            // 递归 Children 到 n 层（DFS 先序 → 父在前子在后，天然层级）
            let d = n;
            format!(
                "function __Walk($node, $d) {{\n\
                   if ($d -ge {d}) {{ return }}\n\
                   try {{ $kids = $node.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) }} catch {{ return }}\n\
                   for ($i = 0; $i -lt $kids.Count; $i++) {{\n\
                     $e = $kids.Item($i)\n\
                     if ($null -eq $e) {{ continue }}\n\
                     __EmitLine $e ($d + 1)\n\
                     __Walk $e ($d + 1)\n\
                   }}\n\
                 }}\n\
                 __Walk $__win 0\n\
                 Write-Output \"__REFS__=$($__map.Count)\"\n\
                 Write-Output $__out.ToString()\n"
            )
        }
        _ => {
            // 全量：FindAll(Descendants) 一次性取齐（比递归快）。深度视为 1 层（扁平，无层级信息）。
            String::from(
                "$__all = $__win.FindAll([System.Windows.Automation.TreeScope]::Descendants, \
                 [System.Windows.Automation.Condition]::TrueCondition)\n\
                 $__count = $__all.Count\n\
                 for ($i = 0; $i -lt $__count; $i++) {\n\
                   $e = $__all.Item($i)\n\
                   if ($null -eq $e) { continue }\n\
                   __EmitLine $e 1\n\
                 }\n\
                 Write-Output \"__REFS__=$($__map.Count)\"\n\
                 Write-Output $__out.ToString()\n",
            )
        }
    };
    ps.push_str(&header);
    ps.push_str(&traversal);
    ps
}

/// 输出树行 → 解析成控件记录。行格式：
/// ref=0|type=Button|name=OK|id=btn1|enabled=True|value=|rect=10,20,80,30|d=1
#[derive(Debug, Clone)]
pub(crate) struct UiControl {
    pub ref_id: usize,
    pub ctype: String,
    pub name: String,
    pub automation_id: String,
    pub enabled: bool,
    pub value: String,
    pub rect: (i32, i32, i32, i32), // x, y, w, h
    pub depth: u32,                 // 树深度（根的子级=1；扁平全量模式=1）
}

fn parse_control_line(line: &str) -> Option<UiControl> {
    let mut ref_id = None;
    let mut ctype = String::new();
    let mut name = String::new();
    let mut automation_id = String::new();
    let mut enabled = true;
    let mut value = String::new();
    let mut rect = (0, 0, 0, 0);
    let mut depth = 1u32;
    for part in line.split('|') {
        let (k, v) = part.split_once('=')?;
        match k {
            "ref" => ref_id = v.trim().parse().ok(),
            "type" => ctype = v.to_string(),
            "name" => name = v.to_string(),
            "id" => automation_id = v.to_string(),
            "enabled" => enabled = v.eq_ignore_ascii_case("true"),
            "value" => value = v.to_string(),
            "d" => depth = v.trim().parse().unwrap_or(1),
            "rect" => {
                let mut it = v.split(',');
                let x = it.next()?.trim().parse().ok()?;
                let y = it.next()?.trim().parse().ok()?;
                let w = it.next()?.trim().parse().ok()?;
                let h = it.next()?.trim().parse().ok()?;
                rect = (x, y, w, h);
            }
            _ => {}
        }
    }
    Some(UiControl {
        ref_id: ref_id?,
        ctype,
        name,
        automation_id,
        enabled,
        value,
        rect,
        depth,
    })
}

/// 过滤：name 模糊 / control_type / automation_id / enabled。
fn control_matches(
    c: &UiControl,
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
        if !c.ctype.eq_ignore_ascii_case(t) {
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

/// 生成缩进式树文本（按 d= 深度字段缩进；全量模式无层级信息，退化为每行一控件）。
fn tree_text(controls: &[UiControl]) -> String {
    let mut s = String::new();
    for c in controls {
        let state = if c.enabled { "" } else { " (disabled)" };
        let val = if c.value.is_empty() {
            String::new()
        } else {
            format!(" value={}", c.value)
        };
        let indent = "  ".repeat(c.depth.saturating_sub(1) as usize);
        s.push_str(&format!(
            "{indent}[{}] {}{}{}{}\n",
            c.ref_id,
            c.ctype,
            if c.name.is_empty() {
                String::new()
            } else {
                format!(" \"{}\"", c.name)
            },
            val,
            state,
        ));
    }
    s
}

// ═══════════════════════════════════════════════════════════
// 公开动作（rpc 调用入口，返回 JSON 字符串）
// ═══════════════════════════════════════════════════════════

/// desktop_uia_tree — 窗口控件树 + ref 清单。
/// params: title?/pid?/hwnd?（窗口定位）；depth?（1=只列直接子级，缺省全量扁平）。
pub(crate) fn uia_tree(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    depth: Option<u32>,
) -> Result<String, String> {
    let loc = window_locator_ps(title, pid, hwnd);
    let bt = build_tree_ps(depth);
    let script = format!("{loc}\n{bt}");
    let out = run_ps_strict(&script)?;
    // 解析：先 __REFS__ 行 / __WIN__ 行，再逐控件行
    let mut controls: Vec<UiControl> = Vec::new();
    let mut refs = 0usize;
    let mut wpid = -1i64;
    let mut wtitle = String::new();
    let mut whwnd = 0i64;
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("__REFS__=") {
            refs = rest.parse().unwrap_or(0);
            continue;
        }
        if let Some(rest) = line.strip_prefix("__WIN__=") {
            let mut it = rest.splitn(3, '|');
            wpid = it.next().and_then(|s| s.parse().ok()).unwrap_or(-1);
            wtitle = it.next().unwrap_or("").to_string();
            whwnd = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if let Some(c) = parse_control_line(line) {
            controls.push(c);
        }
    }
    Ok(json!({
        "window": {
            "pid": wpid,
            "name": "",
            "title": wtitle,
            "hwnd": whwnd,
        },
        "refs": refs,
        "tree": tree_text(&controls),
        "controls": controls.iter().map(|c| json!({
            "ref": c.ref_id,
            "name": c.name,
            "type": c.ctype,
            "automation_id": c.automation_id,
            "enabled": c.enabled,
            "value": c.value,
            "rect": format!("{},{},{},{}", c.rect.0, c.rect.1, c.rect.2, c.rect.3),
            "depth": c.depth,
        })).collect::<Vec<_>>(),
        "note": "标准控件全覆盖；自绘控件(QQ/微信/钉钉等)树可能为空，用 desktop_uia_window_shot + 视觉兜底。depth>=1 时输出真实层级缩进树。",
    }).to_string())
}

/// desktop_uia_find — 在窗口内按条件查找控件。
pub(crate) fn uia_find(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    name: Option<&str>,
    ctype: Option<&str>,
    aid: Option<&str>,
    enabled: Option<bool>,
) -> Result<String, String> {
    let tree = uia_tree(title, pid, hwnd, None)?;
    let v: Value = serde_json::from_str(&tree).map_err(|e| format!("uia_find: 解析树失败: {e}"))?;
    let controls: Vec<UiControl> = v["controls"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    Some(UiControl {
                        ref_id: c["ref"].as_u64()? as usize,
                        ctype: c["type"].as_str()?.to_string(),
                        name: c["name"].as_str()?.to_string(),
                        automation_id: c["automation_id"].as_str()?.to_string(),
                        enabled: c["enabled"].as_bool()?,
                        value: c["value"].as_str()?.to_string(),
                        rect: {
                            let r = c["rect"].as_str()?;
                            let mut it = r.split(',');
                            let x = it.next()?.trim().parse().ok()?;
                            let y = it.next()?.trim().parse().ok()?;
                            let w = it.next()?.trim().parse().ok()?;
                            let h = it.next()?.trim().parse().ok()?;
                            (x, y, w, h)
                        },
                        depth: c["depth"].as_u64().unwrap_or(1) as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let matched: Vec<&UiControl> = controls
        .iter()
        .filter(|c| control_matches(c, name, ctype, aid, enabled))
        .collect();
    Ok(json!({
        "window": v["window"],
        "matched": matched.len(),
        "controls": matched.iter().map(|c| json!({
            "ref": c.ref_id,
            "name": c.name,
            "type": c.ctype,
            "automation_id": c.automation_id,
            "enabled": c.enabled,
            "value": c.value,
            "rect": format!("{},{},{},{}", c.rect.0, c.rect.1, c.rect.2, c.rect.3),
            "depth": c.depth,
        })).collect::<Vec<_>>(),
    })
    .to_string())
}

/// 坐标计算段（供 ref 模式 / selector 模式复用）：以元素矩形中心为点击点。
fn coords_calc_ps() -> &'static str {
    "$__rect = $__el.Current.BoundingRectangle\n\
     function __SafeInt([double]$v) { if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { 0 } else { [int]$v } }\n\
     $__cx = __SafeInt ($__rect.X + $__rect.Width / 2)\n\
     $__cy = __SafeInt ($__rect.Y + $__rect.Height / 2)\n\
     if ($__rect.Width -le 0 -or $__rect.Height -le 0) { throw \"控件没有可点击区域（可能已隐藏或滚动出视口，请重新 desktop_uia_tree）\" }\n"
}

/// 操作前的公共 PowerShell 前缀（ref 模式）：定位窗口 + 建 ref 映射 + 反查元素。
/// $__wantName 取 ref 当前指向元素的 Name，供 ref_lookup_ps 做树漂移回溯重定位。
fn action_prefix_ps(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: u32,
) -> String {
    let loc = window_locator_ps(title, pid, hwnd);
    let bt = build_tree_ps(None);
    format!(
        "{loc}\n{bt}\n$ref = {ref_id}\n\
         $__wantName = ''\n\
         try {{ $__wantName = $__map[$ref].Current.Name }} catch {{ $__wantName = '' }}\n\
         {}{}",
        ref_lookup_ps(),
        coords_calc_ps()
    )
}

/// 操作前的公共 PowerShell 前缀（selector 模式）：
/// 按 name / automation_id / control_type 组合 FindFirst 精确定位（不建全树），
/// 命中元素塞进单元素 $__map（ref=0），后续脚本与 ref 模式完全复用。
/// name/automation_id/control_type 至少给一个；name 精确匹配（IgnoreCase）。
fn selector_prefix_ps(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> String {
    let loc = window_locator_ps(title, pid, hwnd);
    let mut ps = format!("{loc}\n");
    ps.push_str("$__conds = New-Object System.Collections.ArrayList\n");
    if let Some(n) = name {
        let esc = n.replace('\'', "''");
        ps.push_str(&format!(
            "$__conds.Add((New-Object System.Windows.Automation.PropertyCondition(\
             [System.Windows.Automation.AutomationElement]::NameProperty, '{esc}', \
             [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)))\n"
        ));
    }
    if let Some(a) = automation_id {
        let esc = a.replace('\'', "''");
        ps.push_str(&format!(
            "$__conds.Add((New-Object System.Windows.Automation.PropertyCondition(\
             [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '{esc}')))\n"
        ));
    }
    if let Some(ct) = control_type {
        let esc = ct.replace('\'', "''");
        ps.push_str(&format!(
            "$__ctProp = [System.Windows.Automation.ControlType].GetProperty('{esc}', [System.Reflection.BindingFlags]'Static,Public')\n\
             if (-not $__ctProp) {{ throw '未知 ControlType: {esc}（常见: Button, Edit, Text, ListItem, MenuItem, CheckBox, ComboBox, Pane, Window, Group, Custom）' }}\n\
             $__conds.Add((New-Object System.Windows.Automation.PropertyCondition(\
             [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $__ctProp.GetValue($null, $null))))\n"
        ));
    }
    ps.push_str(
        "if ($__conds.Count -eq 0) { throw '至少要给一个定位条件（name / automation_id / control_type）' }\n\
         $__condArr = [System.Windows.Automation.Condition[]]$__conds.ToArray()\n\
         $__cond = if ($__conds.Count -eq 1) { $__conds[0] } else { New-Object System.Windows.Automation.AndCondition($__condArr) }\n\
         $__el = $__win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $__cond)\n\
         if (-not $__el) { throw '找不到匹配控件（name/automation_id/control_type 组合无命中，先 desktop_uia_tree 确认实际值）' }\n\
         $__map = New-Object System.Collections.ArrayList\n\
         [void]$__map.Add($__el)\n\
         $ref = 0\n",
    );
    ps.push_str(coords_calc_ps());
    ps
}

/// 统一前缀分发：给了 selector 条件（name/automation_id/control_type 任一）走 selector 模式，
/// 否则走 ref 模式。
fn action_prefix_dispatch(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: u32,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> String {
    if name.is_some() || automation_id.is_some() || control_type.is_some() {
        selector_prefix_ps(title, pid, hwnd, name, automation_id, control_type)
    } else {
        action_prefix_ps(title, pid, hwnd, ref_id)
    }
}

/// 内联 C# 鼠标操作（SendInput 姿势）——坐标点击/右键/滚轮兜底。
fn mouse_cs() -> &'static str {
    "Add-Type -TypeDefinition @'\n\
     using System;\n\
     using System.Runtime.InteropServices;\n\
     public static class UiaMouse {\n\
       [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);\n\
       [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);\n\
       public const uint LEFTDOWN = 0x02, LEFTUP = 0x04, RIGHTDOWN = 0x08, RIGHTUP = 0x10, WHEEL = 0x0800, HWHEEL = 0x01000;\n\
       public static void Click(int x, int y, bool right) {\n\
         SetCursorPos(x, y);\n\
         if (right) { mouse_event(RIGHTDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(RIGHTUP, 0, 0, 0, UIntPtr.Zero); }\n\
         else       { mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero); }\n\
       }\n\
       public static void Wheel(int x, int y, int delta) { SetCursorPos(x, y); mouse_event(WHEEL, 0, 0, (uint)delta, UIntPtr.Zero); }\n\
       public static void HWheel(int x, int y, int delta) { SetCursorPos(x, y); mouse_event(HWHEEL, 0, 0, (uint)delta, UIntPtr.Zero); }\n\
     }\n\
     '@\n"
}

/// index 格式：元素自带（脚本内已计算 $__cx/$__cy）。
fn click_impl_ps(right: bool) -> String {
    let mut ps = String::new();
    ps.push_str(&format!("{}\n", mouse_cs()));
    if right {
        ps.push_str("[UiaMouse]::Click($__cx, $__cy, $true)\n");
    } else {
        // 优先 Invoke → Toggle → SelectionItem → 坐标兜底
        ps.push_str(
            "$__inv = $null; $__tg = $null; $__sel = $null\n\
             try { $__inv = $__el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch { $__inv = $null }\n\
             if ($__inv) { $__inv.Invoke(); Write-Output '__METHOD__=invoke'; exit 0 }\n\
             try { $__tg = $__el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern) } catch { $__tg = $null }\n\
             if ($__tg) { $__tg.Toggle(); Write-Output '__METHOD__=toggle'; exit 0 }\n\
             try { $__sel = $__el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern) } catch { $__sel = $null }\n\
             if ($__sel) { $__sel.Select(); Write-Output '__METHOD__=selection'; exit 0 }\n\
             [UiaMouse]::Click($__cx, $__cy, $false)\n\
             Write-Output '__METHOD__=coords'\n",
        );
    }
    ps
}

/// desktop_uia_click — 按 ref 或 name/automation_id/control_type 点击
/// （Invoke/Toggle/Selection 优先，坐标兜底）。
pub(crate) fn uia_click(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: u32,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    let prefix = action_prefix_dispatch(title, pid, hwnd, ref_id, name, automation_id, control_type);
    let script = format!("{prefix}\n{}", click_impl_ps(false));
    let out = run_ps_strict(&script)?;
    let method = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("__METHOD__="))
        .unwrap_or("coords")
        .to_string();
    Ok(json!({ "done": true, "method": method, "ref": ref_id }).to_string())
}

/// desktop_uia_right_click — 按 ref 或 selector 坐标右键（上下文菜单）。
pub(crate) fn uia_right_click(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: u32,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    let prefix = action_prefix_dispatch(title, pid, hwnd, ref_id, name, automation_id, control_type);
    let script = format!("{prefix}\n{}", click_impl_ps(true));
    let out = run_ps_strict(&script)?;
    let method = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("__METHOD__="))
        .unwrap_or("coords")
        .to_string();
    Ok(json!({ "done": true, "method": method, "ref": ref_id }).to_string())
}

/// desktop_uia_type — 按 ref 或 selector 输入
/// （ValuePattern.SetValue 优先，聚焦+SendKeys 兜底）。
pub(crate) fn uia_type(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: u32,
    text: &str,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    let prefix = action_prefix_dispatch(title, pid, hwnd, ref_id, name, automation_id, control_type);
    let esc = text.replace('\'', "''");
    let mut ps = prefix;
    ps.push_str(&format!(
        "$__vp2 = $null\n\
         try {{ $__vp2 = $__el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }} catch {{ $__vp2 = $null }}\n\
         if ($__vp2) {{ $__vp2.SetValue('{esc}'); Write-Output '__METHOD__=setvalue'; exit 0 }}\n",
    ));
    // 兜底：聚焦 + SendKeys
    ps.push_str(&format!(
        "Add-Type -AssemblyName System.Windows.Forms\n\
         $__sp2 = $null\n\
         try {{ $__sp2 = $__el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern) }} catch {{ $__sp2 = $null }}\n\
         if ($__sp2) {{ try {{ $__sp2.ScrollIntoView() }} catch {{}} }}\n\
         try {{ $__el.SetFocus() }} catch {{}}\n\
         $__oldClip = [System.Windows.Forms.Clipboard]::GetText()\n\
         [System.Windows.Forms.Clipboard]::SetText('{esc}')\n\
         Start-Sleep -Milliseconds 80\n\
         Add-Type -AssemblyName System.Windows.Forms\n\
         [System.Windows.Forms.SendKeys]::SendWait('^v')\n\
         Write-Output '__METHOD__=sendkeys'\n\
         Start-Sleep -Milliseconds 80\n\
         try {{ [System.Windows.Forms.Clipboard]::SetText($__oldClip) }} catch {{}}\n",
    ));
    let out = run_ps_strict(&ps)?;
    let method = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("__METHOD__="))
        .unwrap_or("sendkeys")
        .to_string();
    Ok(json!({ "done": true, "method": method, "ref": ref_id }).to_string())
}

/// desktop_uia_scroll — 按 ref 或 selector 滚动（ScrollPattern 优先，滚轮兜底）。
pub(crate) fn uia_scroll(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: u32,
    direction: &str,
    amount: Option<f64>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    let prefix = action_prefix_dispatch(title, pid, hwnd, ref_id, name, automation_id, control_type);
    let mut ps = prefix;
    let (hv, vv) = match direction {
        "left" => (-amount.unwrap_or(1.0), 0.0),
        "right" => (amount.unwrap_or(1.0), 0.0),
        "up" => (0.0, -amount.unwrap_or(1.0)),
        _ => (0.0, amount.unwrap_or(1.0)), // down 默认
    };
    ps.push_str(&format!(
        "$__sc = $null\n\
         try {{ $__sc = $__el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) }} catch {{ $__sc = $null }}\n\
         if ($__sc) {{\n\
           $__h = $__sc.Current.HorizontallyScrollable; $__v = $__sc.Current.VerticallyScrollable\n\
           if (($__v -or $__h) -and (-not ($__v -eq $false -and {hv} -ne 0))) {{ $__sc.Scroll({hv}, {vv}); Write-Output '__METHOD__=scrollpattern'; exit 0 }}\n\
         }}\n",
    ));
    // 滚轮兜底：目标坐标 + 滚轮（direction 上下，左右用 Shift+Wheel）
    let delta = match direction {
        "left" => -120.0,
        "right" => 120.0,
        "up" => 120.0,
        _ => -120.0, // down 默认
    } * amount.unwrap_or(1.0);
    ps.push_str(&format!("{}\n", mouse_cs()));
    // 滚轮兜底：Wheel 垂直 / HWheel 横向（正确的横向滚轮事件，不碰选区）
    let wheel_call = match direction {
        "left" => format!("[UiaMouse]::HWheel($__cx, $__cy, {})", -delta),
        "right" => format!("[UiaMouse]::HWheel($__cx, $__cy, {delta})"),
        "up" => format!("[UiaMouse]::Wheel($__cx, $__cy, {})", delta.abs()),
        _ => format!("[UiaMouse]::Wheel($__cx, $__cy, -{})", delta.abs()), // down
    };
    ps.push_str(&format!(
        "{wheel_call}\n\
         Write-Output '__METHOD__=wheel'\n",
    ));
    let out = run_ps_strict(&ps)?;
    let method = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("__METHOD__="))
        .unwrap_or("wheel")
        .to_string();
    Ok(json!({ "done": true, "method": method, "ref": ref_id }).to_string())
}

/// desktop_uia_window_shot — 按窗口矩形截图（非全屏，隐私面更小）。
pub(crate) fn uia_window_shot(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
) -> Result<String, String> {
    let loc = window_locator_ps(title, pid, hwnd);
    let script = format!(
        "{loc}\n\
         Add-Type -AssemblyName System.Drawing\n\
         $__r = $__win.Current.BoundingRectangle\n\
         if ($__r.Width -le 0 -or $__r.Height -le 0) {{ throw '窗口矩形无效（窗口可能最小化或已关闭）' }}\n\
         function __SafeInt([double]$v) {{ if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) {{ 0 }} else {{ [int]$v }} }}\n\
         $__w = __SafeInt $__r.Width; $__h = __SafeInt $__r.Height\n\
         $b = New-Object System.Drawing.Bitmap($__w, $__h)\n\
         $g = [System.Drawing.Graphics]::FromImage($b)\n\
         $g.CopyFromScreen((__SafeInt $__r.X), (__SafeInt $__r.Y), 0, 0, $b.Size)\n\
         $out = Join-Path $env:TEMP (\"hologram-uia-\" + [guid]::NewGuid().ToString(\"N\") + \".png\")\n\
         $b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)\n\
         $g.Dispose(); $b.Dispose()\n\
         Write-Output $out\n\
         # 注意：字符串插值里 $__r.X 会被解析成变量 $__r + 字面量 .X（成员访问不生效），\n\
         # 必须先用命令调用形式算进局部变量再插值，否则 rect 元数据输出损坏。\n\
         $__rx = __SafeInt $__r.X; $__ry = __SafeInt $__r.Y; $__rw = __SafeInt $__r.Width; $__rh = __SafeInt $__r.Height\n\
         Write-Output \"__RECT__=$__rx,$__ry,$__rw,$__rh\"\n",
    );
    let out = run_ps_strict(&script)?;
    let path = out
        .lines()
        .find(|l| l.contains(".png"))
        .map(|l| l.trim().to_string())
        .ok_or("desktop_uia_window_shot: 未找到截图路径")?;
    let rect = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("__RECT__="))
        .unwrap_or("")
        .to_string();
    let bytes =
        std::fs::read(&path).map_err(|e| format!("desktop_uia_window_shot: 读截图失败: {e}"))?;
    // 转存到会话截图目录（与 desktop_screenshot 同目录），再清理临时源文件
    let dir = std::env::temp_dir().join("hologram-browser-shots");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("desktop_uia_window_shot: 创建截图目录失败: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let final_path = dir.join(format!("uia-win-{ts}.png"));
    std::fs::write(&final_path, &bytes)
        .map_err(|e| format!("desktop_uia_window_shot: 写截图文件失败: {e}"))?;
    let _ = std::fs::remove_file(&path); // 清理临时源
    Ok(json!({
        "path": final_path.to_string_lossy(),
        "bytes": bytes.len(),
        "rect": rect,
        "note": "窗口矩形截图已落盘(文本模型看不到内容,可交给用户确认; vision 模型可读路径)。",
    })
    .to_string())
}

// ═══════════════════════════════════════════════════════════
// 测试 — 纯解析函数,不依赖真实窗口
// ═══════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_control_line_full() {
        let c = parse_control_line(
            "ref=3|type=Button|name=OK|id=btn1|enabled=True|value=|rect=10,20,80,30|d=2",
        )
        .unwrap();
        assert_eq!(c.ref_id, 3);
        assert_eq!(c.ctype, "Button");
        assert_eq!(c.name, "OK");
        assert_eq!(c.automation_id, "btn1");
        assert!(c.enabled);
        assert_eq!(c.value, "");
        assert_eq!(c.rect, (10, 20, 80, 30));
        assert_eq!(c.depth, 2);
    }

    #[test]
    fn parse_control_line_disabled_and_value() {
        let c = parse_control_line(
            "ref=7|type=Edit|name=输入框|id=|enabled=False|value=abc|rect=0,0,100,20",
        )
        .unwrap();
        assert_eq!(c.ref_id, 7);
        assert_eq!(c.ctype, "Edit");
        assert!(!c.enabled);
        assert_eq!(c.value, "abc");
        assert_eq!(c.rect, (0, 0, 100, 20));
        assert_eq!(c.depth, 1, "无 d 字段时默认 1");
    }

    #[test]
    fn parse_control_line_malformed_returns_none() {
        assert!(parse_control_line("").is_none());
        assert!(parse_control_line("garbage").is_none());
        assert!(
            parse_control_line("ref=abc|type=Button").is_none(),
            "ref 非数字应丢弃"
        );
        assert!(
            parse_control_line("ref=1|rect=a,b,c").is_none(),
            "rect 非法应丢弃"
        );
    }

    #[test]
    fn control_matches_filters() {
        let c = UiControl {
            ref_id: 0,
            ctype: "Button".into(),
            name: "Save File".into(),
            automation_id: "save_btn".into(),
            enabled: true,
            value: String::new(),
            rect: (0, 0, 10, 10),
            depth: 1,
        };
        assert!(control_matches(&c, Some("save"), None, None, None));
        assert!(control_matches(&c, None, Some("button"), None, None));
        assert!(control_matches(
            &c,
            None,
            None,
            Some("SAVE_BTN"),
            Some(true)
        ));
        assert!(
            !control_matches(&c, Some("open"), None, None, None),
            "name 不匹配"
        );
        assert!(
            !control_matches(&c, None, None, None, Some(false)),
            "enabled 不匹配"
        );
    }

    #[test]
    fn tree_text_formats_readable() {
        let controls = vec![
            UiControl {
                ref_id: 0,
                ctype: "Edit".into(),
                name: String::new(),
                automation_id: String::new(),
                enabled: true,
                value: "hello".into(),
                rect: (0, 0, 1, 1),
                depth: 1,
            },
            UiControl {
                ref_id: 1,
                ctype: "Button".into(),
                name: "OK".into(),
                automation_id: String::new(),
                enabled: false,
                value: String::new(),
                rect: (0, 0, 1, 1),
                depth: 2,
            },
        ];
        let t = tree_text(&controls);
        assert!(t.contains("[0] Edit value=hello"));
        assert!(t.contains("  [1] Button \"OK\" (disabled)"), "depth=2 应缩进: {t}");
    }
}

#[cfg(test)]
mod debug_script_tests {
    use super::*;

    #[test]
    fn debug_print_script() {
        let loc = window_locator_ps(Some("Calculator"), None, None);
        let bt = build_tree_ps(None);
        let script = format!("{loc}\n{bt}");
        eprintln!("===SCRIPT-BEGIN===\n{script}\n===SCRIPT-END===");
    }
}
