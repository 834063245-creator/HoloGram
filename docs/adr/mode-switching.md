# ADR: 模式切换系统（修订版 v4）

## 设计参考

Reasonix 的两轴正交设计。Goal 保留 `/goal` 命令。

## 模式定义

### 协作模式 — Agent 怎么工作

| 模式 | 含义 | 行为 |
|------|------|------|
| `normal` | 普通对话 | 按用户指令执行 |
| `plan` | 规划模式 | 只读分析，不给写工具 |

### 权限模式 — 对 Agent 多信任

| 模式 | 含义 | 行为 |
|------|------|------|
| `ask` | 询问（默认） | 所有写操作弹确认框 |
| `auto` | 安全自动 | 常规编辑自动批准，危险命令仍询问 |
| `yolo` | 全部自动 | 所有写操作自动批准 |

**auto vs yolo 白名单：**

| 工具 | ask | auto | yolo |
|------|-----|------|------|
| `edit_file`, `write_file`, `rename_file` 等 | 弹框 | ✓ 自动 | ✓ 自动 |
| `git_stage`（暂存） | 弹框 | ✓ 自动 | ✓ 自动 |
| `run_shell`（任意命令） | 弹框 | 弹框 | ✓ 自动 |
| `git_commit`, `git_push` | 弹框 | 弹框 | ✓ 自动 |
| `delete_file` | 弹框 | 弹框 | ✓ 自动 |
| `git_discard`, `git_checkout` | 弹框 | 弹框 | ✓ 自动 |

两轴独立，6 种组合（2×3）。

---

## 权限实现：不改 Rust

```
Agent 调工具 → Rust engine 执行
  → 工具 read_only=false → Rust emit "permission-ask" 事件
    → main.ts 监听
      → if permissionMode=auto && tool in AUTO_WHITELIST → 直接 allow:true
      → if permissionMode=yolo → 直接 allow:true
      → else → chatPanel.showPermissionCard()
```

`AUTO_WHITELIST = ['edit_file','write_file','rename_file','move_file','git_stage']`

Rust 零改动。所有权限判断在 `main.ts` 的 `permission-ask` 监听器里截断。

---

## UI：双行底栏

```
┌─ chat-footer ──────────────────────────────────────┐
│ 模式行  │ 📋 Plan                │  🛡询问 · ✓自动 · ⚠YOLO │
│─────────│────────────────────────│─────────────────────│
│ 信息行  │ 🔧 model  15.2k        │  ⌨  /  +           │
└─────────────────────────────────────────────────────┘
```

- Plan 按钮：开关，激活变蓝
- 权限三段控件：`🛡 询问` · `✓ 自动` · `⚠ YOLO`，当前激活高亮
- YOLO 用警告色（红/橙），强调危险性

---

## 存储：Zustand chat-store

```typescript
// chat-store.ts — panel slice
interface PanelState {
  // ...existing...
  collaborationMode: 'normal' | 'plan';  // 默认 'normal'
  permissionMode: 'ask' | 'auto' | 'yolo'; // 默认 'ask'
}
```

不新建文件。模式持久化走 `settings.ts`。

---

## 审计问题（v2/v3 保留，全部已解决）

- 🔴 Agent 不重建 — 只替换 session[0]，不丢内部状态
- 🔴 先去重 — `buildAgentOptions()` 消除两处重复
- 🟡 权限在 Rust — 前端截断，Rust 零改动
- 🟢 GSAP morph — pill 不受影响，panel/hud 多 24px 不撑破
- 🟢 slash panel bottom — 36px → ~60px

---

## 实施

| 阶段 | 文件 | 内容 | 量 |
|------|------|------|----|
| 1 | `chat-store.ts` | 加 `collaborationMode` / `permissionMode` | +5 |
| 1 | `settings.ts` | 加持久化字段 | +4 |
| 2 | `workspace.ts` | 抽 `buildAgentOptions()` + mode 参数 | +30 |
| 3 | `workspace.ts` | Plan 模式只注册只读工具 | +15 |
| 4 | `main.ts` | `permission-ask` 监听加 auto/yolo 截断 | +15 |
| 5 | `ChatFooter.tsx` | `ChatModebar` 组件 + 双行布局 | +55 |
| 5 | `chat.css` | modebar 样式 + column + slash bottom | +30 |

**不新建任何文件。总计 ~150 行。**

## 不做

- ❌ Goal 不进模式切换（保留 `/goal`）
- ❌ 不重建 Agent
- ❌ 不新建 ModeManager 类
- ❌ 不动 Rust
