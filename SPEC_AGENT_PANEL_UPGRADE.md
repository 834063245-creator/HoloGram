# Agent 面板 UI 升级 Spec

**目标**：ChatPanel 从"能对话"升级到"主流 Agent UI 水平"。
**约束**：不改四态变形架构（pill → input → panel → HUD），不引入新 npm 依赖，CSS 全在 `index.html`。

---

## 1. 输入历史导航

在 `sendMessage()` 发送前把当前文本 push 进 `this.inputHistory: string[]`。在 `inputArea keydown` 里处理 ↑↓：

- `↑` → 光标在行首且无选区 → 从 `inputHistory[this.historyIdx - 1]` 填入输入框
- `↓` → 光标在行尾 → 往新走，到底后恢复 `this.draftText`
- `Escape` → 恢复草稿并重置指针
- `historyIdx` 初始指向 `inputHistory.length`（表示"当前草稿位置"）
- 跨 session 切换时清空历史

每会话独立历史栈，不持久化。

---

## 2. 消息编辑 & 重发

用户消息气泡 hover 时显示 2 个按钮（复用 `.msg-actions` 模式）：

- **编辑**（铅笔图标）：点后把该气泡的文本填入 `inputArea`，光标定位末尾，focus。不删原气泡。
- **重发**（刷新图标）：用原文本重新 `sendMessage()`，新一轮 append 在后面。原气泡保留。

用户气泡改为跟 assistant 气泡一样的 `.msg-bubble` + `.msg-actions` 结构。

---

## 3. Agent 进度反馈

运行中，在 `.chat-header` 下方插入一条进度条：

```
┌─────────────────────────────────────┐
│ 步骤 3/50  ·  正在执行 explore_node │  ← 18px 文本行
│ ████████░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← 2px 进度条
│                                     │
│ (消息列表)                           │
└─────────────────────────────────────┘
```

数据来源：
- `agent.ts` 的 `runLoop()` 在每轮开始/工具调用时 emit `agent:progress { step, maxSteps, toolName }`
- ChatPanel 监听，渲染 `.chat-progress` 元素
- `setRunning(true)` 时插入，`setRunning(false)` 时移除
- 进度条颜色 `var(--signal)`，脉冲动画

Agent 改动（[agent.ts](src-ui/src/agent/agent.ts)）：
```ts
// runLoop() 里：
bus.emit('agent:progress', {
  step: this.stepCount,
  maxSteps: this.maxSteps,
  toolName: tool?.name || 'thinking',
});
```

---

## 4. 消息重试

每个 assistant 气泡 hover 时显示 **重试** 按钮（旋转箭头图标）。

实现：新增 `this.turnPairs: Array<{ userText: string; assistantBubble: HTMLElement | null }>`。

- `sendMessage()` 发送前 push `{ userText: text, assistantBubble: null }`
- `finishTurn()` 时把 `this.currentBubble` 回填到最后一个 pair 的 `assistantBubble`
- 重试按钮 click → 用 `pair.userText` 调 `agent.run()`，新一轮消息 append 在列表底

旧回复保留不删，用户可对比多轮结果。

---

## 5. @ 文件引用

输入框输入 `@`（前面是空格或行首，仅 ASCII `@` 不触发中文输入法）弹出补全弹窗：

- 弹窗位于输入框上方，宽度 = 输入框宽度，最大 10 行
- 数据源：
  1. 项目文件列表：`invoke('glob', { pattern: '**/*.{ts,js,py,rs,html,css}' })` → 最多 100 条，缓存 30 秒
  2. 图中节点名：`starGraph.getNodeNames()` → 全量匹配
- 匹配逻辑：`@cha` → 模糊匹配 `chat.ts`、`chat-panel.ts`、`ChatPanel` 等（简单的 substring match，不做 fuzzy）
- 选中后插入 `[@文件名](相对路径)` 或 `` `节点名` `` 的 token
- ↑↓ 选择，Enter 确认，Esc 关闭
- 持续输入自动过滤

弹窗 CSS 复用 `.chat-slash-popup` 的定位风格。

---

## 6. 代码块操作按钮

`.msg-markdown pre` 右上角注入两个小按钮：

- **复制**（copy 图标）→ 复制代码块内容到剪贴板，成功后图标变 ✓ 1.5 秒恢复
- **查看文件**（仅当代码块来自 `edit_file` / `write_file_content` / `read_file_content` 工具输出，且第一行是文件路径时显示）→ 调 `shell.openFile(path)`

CSS：按钮半透明 `rgba(120,160,215,0.3)`，hover 变亮。默认隐藏，pre 容器 hover 时显示。

注入时机：`flushText()` + `renderMarkdownText()` + `formatToolResult()`。

---

## 7. Diff 预览

`edit_file` / `write_file_content` 的工具结果区域使用 diff 视图：

- 手写行级 diff（输入 old/new 两段文本，输出带标记的 HTML）
- diff 算法：按行 split，逐行比较，标记 `+`（绿色）、`-`（红色）、` `（不变）
- 实现：简单的 LCS-based 或逐行 hash 比较。不引入 `diff` npm 包
- 超过 40 行默认折叠，按钮 "展开全部 (N 行)"
- diff 上方显示文件路径（工具参数中提取）

CSS：`.diff-added { background: rgba(60,200,80,0.1); color: #6e6; }` `.diff-removed { background: rgba(220,60,60,0.1); color: #e55; }`

---

## 8. 错误恢复

错误 notice 改为可操作卡片：

```
┌──────────────────────────────────────────┐
│ ⚠ API 请求超时 (DeepSeek)                 │
│                                          │
│ 完整错误: The request timed out after    │
│ 120s. Consider reducing context size.    │
│                               [展开详情] │
│                                          │
│ [重试本次请求]  [调整上下文]  [新建会话]  │
└──────────────────────────────────────────┘
```

- `sendMessage()` catch 块调 `addErrorNotice(text, detail, actions)`
- `actions` 是 `{ label: string; onClick: () => void }[]`
- 预设 action：重试（重新 send 同一条消息）、压缩上下文（`/compact`）、新建会话（`/new`）

---

## 9. 快捷键提示

Footer 右侧增加 `?` 按钮，hover 弹出 tooltip：

```
─────────────
Ctrl+L    打开/关闭面板
Enter     发送 (输入框)
Shift+Enter  换行
Esc       关闭面板
Ctrl+Y    始终允许 (权限)
↑↓        历史导航 (输入框)
─────────────
```

实现：纯 CSS tooltip（`::after` pseudo-element），不依赖 JS 弹窗。

快捷键列表从 `main.ts` 的全局绑定和 chat.ts 的本地绑定中各取。

---

## 10. 子 Agent 可视化

`agent_spawn` 工具卡片特殊渲染（不再是一般工具卡片）：

- 工具 header 显示 🧩 图标
- card body 流式显示子 Agent 输出
- 子 Agent 完成时 card 折叠，摘要行：`子 Agent 完成 · 5 步 · 1200 tok · [查看输出]`
- 数据来源：`agent_spawn` 工具实现 emit `bus.emit('agent:sub-spawn', ...)` 事件

Agent 端改动（[tool.ts](src-ui/src/agent/tool.ts) `createSubAgentTool()`）：
```ts
// 子 agent 每步产出时：
bus.emit('agent:sub-progress', { parentToolId: callId, text: chunk });
// 完成时：
bus.emit('agent:sub-done', { parentToolId: callId, summary: {...} });
```

ChatPanel 端：
- `pendingToolCards` 中识别 `agent_spawn` → 渲染特殊 DOM
- 监听 `agent:sub-progress` / `agent:sub-done` → 更新卡片 body
- 子 Agent 卡片追加独立的消息列表样式（缩进 + 左边框）

---

## 11. Agent 设置增强

[settings-panel.ts](src-ui/src/ui/settings-panel.ts) `renderAgentTab()` 增加：

```html
<!-- 工具管理 -->
<div class="sp-section">
  <div class="sp-section-title">工具管理</div>
  <div class="sp-search-box">
    <input placeholder="搜索工具…" class="sp-input">
  </div>
  <div class="sp-tool-list"><!-- 动态填充 --></div>
</div>

<!-- 自定义系统提示词 -->
<div class="sp-section">
  <div class="sp-section-title">自定义提示词</div>
  <textarea class="sp-textarea" placeholder="追加到默认 System Prompt 之后
留空则使用默认"></textarea>
</div>

<!-- 权限默认策略 -->
<div class="sp-section">
  <div class="sp-section-title">权限默认策略</div>
  <select class="sp-select">
    <option value="ask">始终询问</option>
    <option value="allowReads">自动允许读取</option>
    <option value="allowAll">全部自动允许</option>
  </select>
</div>
```

Schema 扩展（[settings.ts](src-ui/src/settings.ts)）：
```ts
interface AgentSettings {
  temperature: number;
  maxSteps: number;
  contextWindow: number;
  chatMode: ChatModeId;
  disabledTools: string[];       // 禁用的工具名列表
  customSystemPrompt: string;    // 追加 prompt，空 = 使用默认
  permissionDefault: 'ask' | 'allowReads' | 'allowAll';
}
```

工具列表从 `ToolRegistry` 拉取（需要在 workspace 或全局暴露 registry 引用）。

---

## 12. 上下文窗口用量条

Footer 中新增迷你进度条：

```
┌──────────────────────────────────────────┐
│ DeepSeek-V3 · 通用  │ 14.2k / 128k ██░░░ │
└──────────────────────────────────────────┘
```

- 数据：每次 `EventKind.Usage` 累加 input + output → `this.totalTokensUsed`
- 颜色：< 50% `var(--pass)` → < 80% `var(--sol)` → ≥ 90% `var(--fail)` 脉冲
- hover tooltip：`输入: 12.3k · 输出: 1.9k · 缓存命中: 2.1k · 约 $0.04`
- 上限取 `settings.agent.contextWindow`（0 = 不限制，不显示进度条）

实现位置：`addUsage()` 累加 token，`updateFooter()` 渲染 `.chat-token-bar`。

---

## 13. 对话导出

Slash 命令 `/export` → 导出当前会话为 Markdown 文件。

导出格式：
```md
# HoloGram 会话 — 2026-06-25 14:30
> 模型: DeepSeek-V3 · 模式: 通用 · 总 token: 14,200

## 用户
帮我看看 chat.ts 的依赖

## Agent
chat.ts 依赖以下模块...

### 工具调用: hologram_neighbors
> 参数: { "node": "ChatPanel" }
> 结果: 8 个邻居节点...
```

实现：`exportSession()` 方法遍历 `agent.getSession()`，格式化每个 message。

保存位置：弹出系统保存对话框。Tauri 下用 `invoke('save_file_dialog', ...)`，纯浏览器 fallback 用 `Blob` + `URL.createObjectURL` download。

Slash popup 加一项 "导出对话 (/export)"。

---

## 14. `/` 命令自动补全

输入 `/` 时自动弹出命令弹窗（替换当前点击按钮才弹出的行为）：

- 弹窗显示所有可用命令
- 继续输入做前缀匹配过滤：`/com` → 只显示 `/compact`
- ↑↓ 选择，Enter 确认，Esc 关闭
- 选中后自动填入完整命令到输入框

命令列表：
```
操作
  /new      — 重置当前会话
  /compact  — 压缩上下文
  /memory   — 查看记忆
  /remember — 记住一件事
  /export   — 导出对话

查询
  哪些模块最脆弱？
  检查循环依赖
  分析最近改动的影响
  追踪依赖路径
```

实现：`inputArea.addEventListener('input', ...)` 检测 `/`，复用现有的 `.chat-slash-popup` 样式。

---

## 文件改动清单

| 文件 | 改动量 | 内容 |
|------|--------|------|
| `src-ui/src/ui/chat.ts` | +400 行 | 所有 UI 功能实现 |
| `src-ui/src/agent/agent.ts` | +5 行 | emit `agent:progress` |
| `src-ui/src/agent/tool.ts` | +15 行 | emit `agent:sub-*` 事件 |
| `src-ui/src/ui/events.ts` | +10 行 | 新事件类型声明 |
| `src-ui/src/settings.ts` | +10 行 | AgentSettings 扩展 |
| `src-ui/src/ui/settings-panel.ts` | +80 行 | Agent 设置页扩展 |
| `src-ui/index.html` | +150 行 | CSS |
