# SPEC: 权限系统统一 — 删前端规则引擎，独留 Rust 后端

**版本**: v3 — 修复 reviewer 指出的 B1/B2/B3/B4/D1/D2/O1/O2/M1/M2  
**日期**: 2026-06-29  
**目标**: 消灭双规则源 + 双匹配引擎 + 双弹窗，统一到 Rust `has_permission_to_use_tool()`

---

## 1. 现状分析

### 1.1 当前架构（问题版）

```
┌──────────────────────────────────────────────────────────────┐
│ 前端 PermissionGate (TS)                                      │
│ • PermissionPolicy.decide() — 规则匹配 (glob → regex)         │
│ • 规则来源: localStorage (hologram_settings.permissions)      │
│ • 覆盖: 所有工具 (coding + hologram MCP)                       │
│ • 弹窗: showApprovalDialog()                                  │
│ • "记住"按钮: 写 localStorage                                 │
└──────────────────────────┬───────────────────────────────────┘
                           │ gate.check() — agent.ts:530
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ 后端 PermissionContext (Rust)                                  │
│ • has_permission_to_use_tool() — 规则匹配 (glob → regex)      │
│ • 规则来源: .hologram/permissions.json + 系统内置规则          │
│ • 覆盖: 仅 Tauri 命令 (Read/Edit/Bash/Git/WebFetch)            │
│ • 弹窗: permission-ask event → main.ts → showApprovalDialog   │
│ • "记住"按钮: 会话级内存 (add_session_rule)，不持久化          │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 三个问题

| # | 问题 | 症状 |
|---|------|------|
| 1 | **双数据源** | 前端读 localStorage，后端读 `.hologram/permissions.json`。前端"始终允许"只写 localStorage，后端不感知。后端项目规则前端不显示。 |
| 2 | **双弹窗** | 前端 gate 弹一次（因为 Bash/Edit 的 readOnly=false + defaultMode=ask），后端再通过 permission-ask event 弹一次。同一个命令用户要点两次。 |
| 3 | **MCP 权限真空** | hologram_* 工具（25个）在 main.rs 里零权限检查，直接调 engine。前端 gate 是它们唯一的防护——删掉前端层后必须补上。 |

### 1.3 根因

三个阶段叠加形成：

- **Phase 1** (6月12日): 前端 `permission.ts` 是 MVP，Agent 需要权限才能上线
- **Phase 2** (6月28日): Rust `permissions/` 是完整引擎，spec 称为"两层自治架构"
- **执行**: Phase 2 落地时没回头统一 Phase 1，前端层继续运行

---

## 2. 目标架构

```
所有工具调用 (Tauri command invoke)
    │
    ▼
┌─────────────────────────────────────────────┐
│ has_permission_to_use_tool() — 唯一规则引擎   │
│ 规则来源: .hologram/permissions.json + 系统规则│
│ ① Deny规则 → ② Ask规则 → ③ tool自查        │
│ ④ safety → ⑤ mode → ⑥ Allow规则 → ⑦ 兜底   │
└──────────────┬──────────────────────────────┘
               │ Allow → 执行
               │ Ask   → permission-ask event → UI弹窗
               │ Deny  → 返回错误
               ▼
┌─────────────────────────────────────────────┐
│ showApprovalDialog() — 纯UI组件               │
│ 只负责画弹窗 + 返回用户选择                     │
│ 不做任何规则判断                               │
└──────────────┬──────────────────────────────┘
               │ "记住" → invoke('add_permission_rule')
               ▼
          .hologram/permissions.json（持久化,单数据源）
```

---

## 3. 改动清单

### 3.1 删除前端规则引擎

**文件**: `src-ui/src/agent/permission.ts`

**删除**（约 110 行）:
- `type Decision` (line 8)
- `interface Rule` (line 10-13)
- `interface PolicyData` (line 15-20)
- `function globToRegex()` (line 25-37)
- `function matchGlob()` (line 39-66)
- `type ApproveCallback` (line 146-149) — PermissionGate 删了就没用了
- `function matchAny()` (line 82-89)
- `class PermissionPolicy` (line 93-119) — **全部**
- `function parseRules()` (line 121-137)
- `function isSameRule()` (line 139-141)
- `class PermissionGate` (line 151-196) — **全部**

**保留**（`showApprovalDialog` 内部依赖）:
- `function showApprovalDialog()` → 不变
- `function cancelPendingApprovals()` → 不变
- `const pending` / `let nextId` / `bus import` → 不变
- `const subjectKeys` (line 70) → **必须留** — `showApprovalDialog` L272 调用 `extractSubject(args)` 画参数提示
- `function extractSubject()` (line 72-78) → **必须留** — 同上

---

### 3.2 删智能体Agent 里的 gate 调用

**文件**: `src-ui/src/agent/agent.ts`

| 行 | 改动 |
|----|------|
| 16 | 删除 `import type { PermissionGate } from './permission'` |
| 89 | 删除 `gate?: PermissionGate` 从 AgentOptions |
| 145 | 删除 `private gate: PermissionGate \| null = null` |
| 179 | 删除 `this.gate = opts.gate \|\| null` |
| 530-540 | **删除整个 `if (this.gate)` 代码块** |

删除内容 (line 530-540):
```typescript
// ── Permission gate ──
if (this.gate) {
    const check = await this.gate.check(call.name, t.description(), args, t.readOnly());
    if (!check.allow) {
        return {
            output: check.reason || 'permission denied',
            errMsg: check.reason,
            blocked: true,
            truncated: false,
        };
    }
}
```

工具执行直接走 `t.execute(args)` → `invoke(toolName, args)` → Rust 后端鉴权。Abort 检查 (line 527) 保留。

---

### 3.3 清理 workspace.ts 的 gate 构造

**文件**: `src-ui/src/workspace.ts`

| 行 | 改动 |
|----|------|
| 20 | 删除 `import { PermissionPolicy, PermissionGate, showApprovalDialog }` → 改为 `import { showApprovalDialog }` |
| 408-414 | **删除 PermissionGate 构造代码段** |
| 415-422 | **删除 `gate.onRemember` 赋值** |
| 425 | `gate,` → 删除，Agent 不再接收 gate 参数 |
| 484-486 | **删除第二处 gate 构造**（agentFactory 内） |
| 487 | 删除 `gate2.onRemember` |
| 492 | 删除 `gate: gate2,` |

删除的 workspace.ts:408-422:
```typescript
// Permission gate
const defaultMode = settings.permissions?.defaultMode || 'ask';
const perm = new PermissionPolicy(defaultMode);
if (settings.permissions) perm.importRules(settings.permissions);
const gate = new PermissionGate(perm, (toolName, desc, args) =>
    showApprovalDialog(toolName, desc, args),
);
gate.onRemember = (rule: string) => {
    const s = loadSettings();
    const rules = s.permissions || { allow: [], deny: [] };
    if (!rules.allow) rules.allow = [];
    if (!rules.allow.includes(rule)) rules.allow.push(rule);
    s.permissions = rules;
    saveSettings(s);
};
```

---

### 3.4 前端 — 删除无效的权限 UI 和 settings 字段

#### 3.4.1 settings-panel.ts — 删除权限标签页

**文件**: `src-ui/src/ui/settings-panel.ts`

`renderPermissionsTab()` (line 282-503) 从 `this.workingSettings.permissions`（localStorage）读写 allow/deny/defaultMode。删前端规则引擎后，这个 tab 编辑的 localStorage 字段对后端行为**零影响**——用户在 UI 改规则但实际鉴权不受影响，会让他们困惑"为什么加了白名单还是不生效"。

**改动**:
1. 删除 `renderPermissionsTab()` 整个方法
2. 删除权限 tab 的按钮/路由（line ~122 `'权限'` tab 定义）
3. `parseRuleString()` 如果仅被权限 tab 使用 → 也删除

#### 3.4.2 settings.ts — 标记 permissions 字段 deprecated

**文件**: `src-ui/src/settings.ts`

`AppSettings.permissions` (line 50) 字段保留但标记 deprecated——删字段可能造成已存 localStorage 反序列化失败（旧 JSON 含有 permissions key 但新类型没有，值丢失）。

```typescript
// @deprecated — 权限规则已迁移到 .hologram/permissions.json，由 Rust 后端管理。
// 此字段仅保留以兼容旧 localStorage 数据，不再被读取。
permissions?: { defaultMode?: 'allow' | 'ask' | 'deny'; allow?: string[]; deny?: string[] };
```

---

### 3.5 后端 — 给 hologram_* 命令补权限检查

**文件**: `src-tauri/src/main.rs`

**现状**: 29 个 hologram_* Tauri 命令零权限检查（25 个 agent 可达 + 4 个仅 Tauri 暴露）。例如：
```rust
#[tauri::command]
async fn hologram_explore(
    query: Option<String>, symbols: Option<Vec<String>>, include_source: Option<bool>,
) -> Result<String, String> {
    let q = query.clone(); // ... 直接调用 engine
```

**改动**: 在每个 hologram_* 命令开头加一行 deny 规则检查。不跑完整的 `has_permission_to_use_tool()`（那需要构造 Tool trait 实现），只检查 deny 规则——MCP 工具只读无害，唯一需要的控制是"禁止某个工具"。

**加辅助函数**（在 L228-230 附近，`get_ctx` 之后）:
```rust
/// Check MCP/graph tool permission — deny-only, skips ask/allow/safety.
/// MCP tools are read-only; only explicit deny rules should block them.
fn check_mcp_permission(tool_name: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    // ponytail: 无工作区 = 无 .hologram/permissions.json = 无自定义规则，放行。
    // 防止 hologram_status 等诊断工具因前置条件失败而无法诊断引擎状态（循环依赖）。
    let ctx = match get_ctx(state) {
        Ok(ctx) => ctx,
        Err(_) => return Ok(()),
    };
    // ponytail: use public accessor ctx.read_rules(), not private ctx.rules
    let rules = ctx.read_rules();
    if let Some(rule) = rules.find_deny(tool_name, None) {
        let reason = format!("{} 工具被规则禁止使用", rule.explain());
        drop(rules);
        ctx.audit_deny(tool_name, "", &reason);
        return Err(reason);
    }
    Ok(())
}
```

**每个 hologram_* 命令**（共 25 个），在第一行加:
```rust
check_mcp_permission("hologram_explore", &state)?;
```

**Agent 可达的 25 个**（在 `createHologramTools()` 注册，agent 可直接调用）:
`hologram_analyze`, `hologram_neighbors`, `hologram_impact`, `hologram_path`, `hologram_explore`, `hologram_fragile`, `hologram_cycle`, `hologram_community`, `hologram_community_report`, `hologram_coupling_report`, `hologram_blindspots`, `hologram_thread_conflicts`, `hologram_timeline`, `hologram_diff`, `hologram_graph_summary`, `hologram_run_check`, `hologram_run_preflight`, `hologram_run_health`, `hologram_history`, `hologram_delayed`, `hologram_changes`, `hologram_search`, `hologram_rename`, `hologram_status`, `hologram_policy_check`

**仅 Tauri 暴露的 4 个**（agent 不直接调，但可被前端 invoke 直接命中，同样零鉴权）:
`hologram_record_event` (写 timeline, **写操作**), `hologram_hotspots` (只读), `hologram_workspace_conflict` (stub 只读), `hologram_gate_check` (只读, 已有 state 参数)

**关于 hologram_rename**: `tool.ts` L466 标记 `readOnly: () => false`，但目前 Rust 实现（main.rs L854-875）是 no-op stub——dry_run=false 也只返回 JSON 不写文件。所以 deny-only 碰巧安全。**必须注释**: 一旦实现真 rename 写操作，必须升级为 `require_write` 全管道。当前检查代码加 `// ponytail: deny-only 对 stub 安全，真 rename 实现前必须改为 require_write`。

**需加 `state` 参数的命令**: 29 个 total。已有 `state` 的 2 个（`hologram_run_check` L894, `hologram_gate_check` L1216），直接用 `check_mcp_permission`。其余 **27 个**需加 `state: tauri::State<'_, WorkspaceState>` 参数。关键事实核对：
- `hologram_run_preflight` L1045 — `(path, files)` **无 state**
- `hologram_run_health` L972 — `(path, days)` **无 state**
- `hologram_status` L1059 — `()` 零参数需补 state
- `hologram_gate_check` L1216 — 已有 state（reviewer 补充）

---

### 3.6 后端 — "记住"按钮持久化到 .hologram/permissions.json

**文件**: `src-tauri/src/main.rs` L2708-2727 (`permission_ask_response`)

**现状**: `permission_ask_response` 已经处理 `remember` + `rule_to_add`，但只调用 `ctx.add_session_rule()` ——会话级内存规则，关掉重开就丢了。

**改动**: 当 `remember=true` 且 `rule_to_add` 存在时，额外写 `.hologram/permissions.json`:

```rust
if remember.unwrap_or(false) {
    if let Some(ref rule_str) = rule_to_add {
        // ponytail: single get_ctx, apply session rule + persist in one block
        if let Ok(ctx) = get_ctx(&state) {
            let behavior = if allow { "allow" } else { "deny" };
            ctx.add_session_rule(rule_str, behavior);
            crate::permissions::rule::append_project_rule(
                &ctx.project_root,
                rule_str,
                behavior,
            );
        }
    }
}
```

**新增函数**: `src-tauri/src/permissions/rule.rs`:
```rust
/// Append a single rule to the project permissions.json.
/// Creates the file + directory if they don't exist.
pub fn append_project_rule(project_root: &Path, rule_str: &str, behavior: &str) {
    let path = project_root.join(".hologram").join("permissions.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    let section = match behavior {
        "allow" => "allow",
        "deny" => "deny",
        _ => "ask",
    };
    let arr = json[section]
        .as_array_mut()
        .or_else(|| {
            json[section] = serde_json::json!([]);
            json[section].as_array_mut()
        });
    if let Some(arr) = arr {
        let rule_str = rule_str.to_string();
        if !arr.iter().any(|v| v.as_str() == Some(&rule_str)) {
            arr.push(serde_json::json!(rule_str));
        }
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap_or_default());
}
```

---

## 4. 不变的部分

以下代码完全不动：

| 模块 | 原因 |
|------|------|
| `permissions/mod.rs` | 中央引擎，逻辑正确 |
| `permissions/rule.rs` | 规则模型 + 匹配，逻辑正确 |
| `permissions/bash.rs` | 危险命令检测，逻辑正确 |
| `permissions/filesystem.rs` | 读写路径检查，逻辑正确 |
| `permissions/git.rs` | Git 子命令规则，逻辑正确 |
| `permissions/web.rs` | WebFetch 检查，逻辑正确 |
| `permissions/safety.rs` | 安全层，逻辑正确 |
| `tools/mod.rs` | 5 个 Tool 实现，逻辑正确 |
| `sandbox.rs` | 路径边界，逻辑正确 |
| `os_sandbox.rs` | OS 进程沙箱，逻辑正确 |
| `agent_isolation.rs` | Worktree 隔离，逻辑正确 |
| `main.rs` (Tauri 命令部分) | Read/Edit/Bash/Git/WebFetch 的 `require_read/write/command` 调用已正确挂载 |

---

## 5. 边界情况

### 5.1 web_search 工具
`web_search` 在 `tool.ts` 里是纯前端 fetch（DuckDuckGo HTML），不走 Tauri invoke。没有权限控制，也不需要有——只读外发 HTTP，零副作用。保留现状。

### 5.2 ask_user 工具
同 web_search——纯前端 DOM 弹窗，不走后端。保留现状。

### 5.3 会话规则 vs 持久化规则
- `.hologram/permissions.json` = 持久化规则（项目级，git-tracked）
- 系统内置规则 = 硬编码 deny 列表（不可变）
- `add_session_rule()` = 会话级内存规则（关掉就丢），"允许一次"用这个

弹窗按钮映射：
- "允许" → `remember=false` → 不写文件，不写 session
- "始终允许" → `remember=true` → 写 `.hologram/permissions.json` **且** `add_session_rule()`

---

## 6. 实现顺序

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | 后端加 `append_project_rule()` 并改 `permission_ask_response` | 无 |
| 2 | 后端加 `check_mcp_permission()` 并给 29 个 hologram_* 命令补检查 | 无 |
| 3 | 前端删 `PermissionPolicy` / `PermissionGate`（保留 extractSubject + subjectKeys） | 无 |
| 4 | 前端 `agent.ts` 删 gate 调用 | 步骤 3 |
| 5 | 前端 `workspace.ts` 删 gate 构造 | 步骤 3 |
| 6 | 前端删除 settings-panel.ts 权限 tab + 标记 settings.ts permissions deprecated | 无 |
| 7 | 端到端测试 | 全部 |

步骤 1/2/3/6 互不依赖，可并行。

---

## 7. 测试验证

改完后的预期行为：

| 场景 | 预期 |
|------|------|
| `read_file "src/main.rs"` | 不弹窗，直接返回内容（项目内 + 只读 + 无 deny 规则） |
| `write_file "D:/outside/file.txt"` | 一次弹窗："路径在项目目录外" → 拒绝 |
| `exec_command "npm test"` | 一次弹窗（后端 Ask），允许后执行 |
| `exec_command "rm -rf /"` | 直接拒绝，不弹窗（Critical 危险命令） |
| `hologram_search "auth"` | 不弹窗，直接返回结果（只读 MCP 工具） |
| `hologram_rename "old" "new"` | 不弹窗（当前 stub 安全，deny-only 通过） |
| `hologram_record_event "type" null "msg"` | 不弹窗（当前仅 deny 可拦截，写操作但无危险路径） |
| 弹窗点"始终允许 `Bash(npm test:*)`" | 规则写入 `.hologram/permissions.json`，下次不弹窗 |
| 重启后 `exec_command "npm test"` | 不弹窗（规则已持久化到 `.hologram/permissions.json`） |
| `.hologram/permissions.json` 加 `"deny": ["hologram_explore"]` | `hologram_explore` 调用返回"工具被规则禁止使用" |
| 打开设置面板 | 无"权限"标签页（已删除，规则仅通过文件管理） |

---

## 8. 变更量

| 文件 | 操作 | 行数 |
|------|------|------|
| `src-ui/src/agent/permission.ts` | 删 | ~110 删（extractSubject/subjectKeys/弹窗保留） |
| `src-ui/src/agent/agent.ts` | 改 | ~18 删 |
| `src-ui/src/workspace.ts` | 改 | ~35 删 |
| `src-ui/src/ui/settings-panel.ts` | 改 | ~230 删（权限 tab 整个方法） |
| `src-ui/src/settings.ts` | 改 | 1 行标记 deprecated |
| `src-tauri/src/main.rs` | 改 | +50 加 check_mcp_permission 调用 + 改 permission_ask_response |
| `src-tauri/src/permissions/rule.rs` | 加 | +30 append_project_rule |
| **合计** | | **~395 删, ~80 加, 净删 ~315** |
