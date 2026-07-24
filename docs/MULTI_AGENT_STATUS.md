# 多 Agent 系统实现状态文档

> 最后更新：2026-07-24（Phase 3 收尾 — 状态推送 + 告警接入已修复）
> 用途：跨窗口交接的完整上下文

## 已落地的功能

### Phase 1：核心通信层

| 能力 | 文件 | 状态 |
|------|------|------|
| MessageBus（异步 send、reply、broadcast、peek+ack inbox） | `message-bus.ts` | ✅ |
| 拓扑策略（TreeTopology 默认、MeshTopology、StarTopology） | `topology.ts` | ✅ |
| 5 个通信工具（agent_message / agent_reply / agent_ack / agent_inbox / agent_list） | `tools/communication.ts` | ✅ |
| 类型定义（AgentMessage、AgentAddress、MessageTransport 等） | `message-types.ts` | ✅ |
| Agent runLoop 中 `_injectInbox()` 自动注入未读消息 | `agent.ts` | ✅ |
| Runtime 统一注入 bus + 注册通信工具 | `runtime/runtime.ts` | ✅ |

### 异步编排层

| 能力 | 文件 | 状态 |
|------|------|------|
| 非阻塞 spawn（`async: true` 参数，立即返回 agentId） | `tools/subagent.ts` | ✅ |
| TaskBoard（共享状态：status / filesTouched / diff） | `task-board.ts` | ✅ |
| BoardFileTrackingHook（PostTool 自动追踪 write_file / edit_file） | `hooks/board-tracking-hook.ts` | ✅ |
| agent_merge 工具（串行合并 completed 子 agent 的 worktree） | `tools/merge.ts` | ✅ |
| Bus 唤醒（idle agent 收到消息自动启动 runLoop） | `message-bus.ts` + `agent.ts` | ✅ |
| `_injectedMsgIds` 防无限唤醒死循环 | `agent.ts` | ✅ |
| 异步子 agent 完成后 bus.send(type=result) 通知父 agent | `agent.ts` | ✅ |
| 子 agent 独立 execState（不互相 abort） | `agent.ts` | ✅ |
| async 模式 signal 不含父 `_currentRunSignal`（不被用户下一条消息杀掉） | `agent.ts` | ✅ |
| AgentLifecycleManager（全局空闲判定 + 泄漏检测 + worktree TTL 30min） | `lifecycle-manager.ts` | ✅ |
| isolation-queue.ts（git 操作串行化，共享队列） | `isolation-queue.ts` | ✅ |

### Phase 2：持久化与崩溃恢复

| 能力 | 文件 | 状态 |
|------|------|------|
| JsonMessageStore（inbox 持久化到 `.hologram/agents/{id}/inbox.json`） | `message-store.ts` | ✅ |
| MessageBus debounced flush（2 秒批量写入） | `message-bus.ts` | ✅ |
| TaskBoard 持久化（`.hologram/taskboard.json`） | `task-board.ts` | ✅ |
| 启动恢复（restore inbox + restore board + 孤儿检测） | `runtime/runtime.ts` | ✅ |
| 孤儿 worktree 清理（崩溃时 running 的子 agent → stop + discard） | `runtime/runtime.ts` | ✅ |
| AgentRuntime 构造函数接收 projectPath | `runtime/runtime.ts` + `workspace.ts` | ✅ |
| destroyAgent 调 flush 落盘 | `runtime/runtime.ts` | ✅ |

### 测试

| 文件 | 用例数 | 状态 |
|------|--------|------|
| `tests/lifecycle-unit.test.ts` | 14（TaskBoard、async spawn、bus 唤醒、merge、防死循环） | ✅ 全过 |
| `tests/lifecycle-integration.test.ts` | 9（并行 merge、冲突保全、混合 spawn、lifecycle manager） | ✅ 全过 |
| `tests/async-spawn-fixes.test.ts` | 5（bus result、no-auto-merge、空输入唤醒、signal 独立、execState 隔离） | ✅ 全过 |
| `tests/persistence-recovery.test.ts` | 9（MessageBus flush/restore、TaskBoard flush/restore、debounced flush、空启动恢复、孤儿检测） | ✅ 全过 |

## 未落地的功能

### Phase 2 已修的问题（2 个）

| # | 严重度 | 问题 | 修法 | 状态 |
|---|--------|------|------|------|
| 1 | ⚠️ 竞态 | `_restore()` fire-and-forget，`createAgent()` 可能在 restore 完成前被调用，新消息被 restore 覆盖 | `AgentRuntime` 加 `ready()` 方法返回 restore promise；workspace 在 `createAgent` 前 `await runtime.ready()` | ✅ 已修 |
| 2 | ⚠️ 泄漏 | `destroyAgent` 调了 `flush()` 但没先 `clearFlushTimer()`，pending 的 debounced flush 会在 destroy 后触发 | `destroyAgent` 中 flush 前先调 `this._bus.clearFlushTimer()` 和 `this._taskBoard.clearFlushTimer()` | ✅ 已修 |

### Phase 2 持久化测试

| 文件 | 用例数 | 状态 |
|------|--------|------|
| `tests/persistence-recovery.test.ts` | 9（MessageBus flush/restore 往返、TaskBoard flush/restore 往返、debounced flush 不丢数据、空启动恢复、孤儿检测） | ✅ 全过 |

### Phase 3：系统提示词适配 + 可观测性 UI

| 能力 | 文件 | 状态 |
|------|------|------|
| 系统提示词加多 Agent 协作指南（async spawn / merge / 通信 / 决策指南） | `runtime/agent-builder.ts` → `buildSystemPrompt()` | ✅ |
| AgentPanelStore（agents / taskBoard / messageFlow / alerts 单一数据源） | `ui/agent-panel-store.ts` | ✅ |
| AgentsPanel React 组件（Agent 树 / TaskBoard 表格 / 消息流 / 告警） | `ui/react/AgentsPanel.tsx` | ✅ |
| AgentsPanel.css 样式 | `ui/react/AgentsPanel.css` | ✅ |
| DockPanelId 加 'agents' + 初始关闭 | `ui/dock-store.ts` | ✅ |
| 面板注册到 PANEL_DEFS（icon: 'agent'） | `app/panels/panel-def.ts` | ✅ |
| RuntimeNotifier.onAgentStatus 实现（更新 store + emit bus） | `ui/runtime-adapter.ts` | ✅ |
| RuntimeNotifier.onSubAgentFinished 实现（推送告警） | `ui/runtime-adapter.ts` | ✅ |
| AgentUINotifier.onStatusChange 回调（runLoop 开始/结束触发） | `agent.ts` + `agent-types.ts` | ✅ 已修复 |
| AgentHandleImpl.status 从 Agent.isRunning 派生（不再硬编码 idle） | `runtime/runtime.ts` | ✅ 已修复 |
| _wrapNotifier 转发 onStatusChange → onAgentStatus | `runtime/runtime.ts` | ✅ 已修复 |
| LifecycleManager 告警接入面板（wrappedSink 转发 Notice → onLifecycleAlert） | `runtime/runtime.ts` + `runtime-adapter.ts` | ✅ 已修复 |
| RuntimeNotifier.onLifecycleAlert 实现（推送 pushAlert 到面板告警区） | `ui/runtime-adapter.ts` | ✅ 已修复 |
| MessageBus.subscribe → pushMessage（消息流推送到 store） | `workspace.ts` | ✅ |
| 初始化刷新 + deactivate 清理 | `workspace.ts` | ✅ |
| bus 事件 'agent:status' 类型声明 | `ui/events.ts` | ✅ |

### Phase 4：协作能力（未开始）

- 同步请求（`agent_request` + runLoop 等待中断点 + 死锁检测）
- 拓扑扩展（兄弟 agent 直接通信、DAG 拓扑）
- 共享发现区

### Phase 5：优化（未开始）

- 任务自动分解
- Agent 能力路由
- 结构化冲突解决

## 文件清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/agent/task-board.ts` | TaskBoard 共享状态 + 持久化 |
| `src/agent/message-store.ts` | JsonMessageStore — inbox 持久化 |
| `src/agent/isolation-queue.ts` | git 操作串行化队列 |
| `src/agent/lifecycle-manager.ts` | 全局空闲判定 + 泄漏检测 + worktree TTL |
| `src/agent/hooks/board-tracking-hook.ts` | PostTool hook 自动追踪文件修改 |
| `src/agent/tools/merge.ts` | agent_merge 工具 |
| `src/ui/agent-panel-store.ts` | Agent 面板 zustand store（agents/taskBoard/messageFlow/alerts） |
| `src/ui/react/AgentsPanel.tsx` | Agent 可观测性面板 React 组件 |
| `src/ui/react/AgentsPanel.css` | Agent 面板样式 |
| `tests/lifecycle-unit.test.ts` | 单元测试 |
| `tests/lifecycle-integration.test.ts` | 集成测试 |
| `tests/async-spawn-fixes.test.ts` | P0/P1 修复验证测试 |
| `tests/persistence-recovery.test.ts` | 持久化与崩溃恢复测试 |

### 改动文件

| 文件 | 改了什么 |
|------|----------|
| `agent.ts` | asyncMode 分支、`_isRunning`、`_onMessageDelivered` 唤醒、`_injectedMsgIds` 防死循环、`setBus` 注册 wake 回调、`runLoop` try/finally、子 agent 独立 execState、async signal 不含父 run signal |
| `message-bus.ts` | `register()` 加 onWake、`_deliver()` 投递后触发回调 + `transport.onDelivered`、debounced flush、broadcast `to` 字段修复 |
| `message-types.ts` | `MessageTransport` 加 `onDelivered?` |
| `runtime/types.ts` | `AgentConfig` 加 `taskBoard?` |
| `runtime/runtime.ts` | 构造函数接收 projectPath、注入 board、注册 merge tool、注册 board hook、lifecycle manager、持久化恢复、孤儿检测、destroyAgent flush + clearFlushTimer、ready()、AgentHandleImpl.status 派生、_wrapNotifier 转发 onStatusChange、LifecycleManager wrappedSink 转发 Notice → onLifecycleAlert |
| `tools/subagent.ts` | schema 加 `async` 参数、统一 agentId（agentIdOverride） |
| `workspace.ts` | `new AgentRuntime(this.path)`、spawner lambda 传 asyncMode + agentIdOverride、`await runtime.ready()`、agent panel 初始化刷新 + bus.subscribe 消息流 + deactivate 清理 |
| `runtime/agent-builder.ts` | `buildSystemPrompt()` 加多 Agent 协作指南段落（async spawn / merge / 通信 / 决策指南） |
| `runtime/types.ts` | `AgentConfig` 加 `taskBoard?`、`RuntimePort` 加 `ready()`、`RuntimeNotifier` 加 `onLifecycleAlert?` |
| `agent-types.ts` | `AgentUINotifier` 加 `onStatusChange?` |
| `agent.ts` | `get isRunning()`、`run()` 触发 `onStatusChange(true)`、`runLoop()` finally 触发 `onStatusChange(false)` |
| `ui/runtime-adapter.ts` | 实现 `onAgentStatus`（更新 store + emit bus）、`onSubAgentFinished`（推送告警）、`onLifecycleAlert`（推送 pushAlert） |
| `ui/dock-store.ts` | `DockPanelId` 加 `'agents'` |
| `app/panels/panel-def.ts` | 注册 agents 面板 |
| `app/panels/dock-panels.css` | 统一右侧面板尺寸 + `.zh` 规则覆盖 ap-tab-label |
| `ui/events.ts` | 加 `agent:status` 事件类型 |
| `main.ts` | 加 `panel.agents` 命令 + 面板互斥逻辑 |

## 提交历史

```
d106a70 fix(agent): wire Agent status push + LifecycleManager alerts to panel
9763be9 feat(agent): add multi-agent system prompt + observability UI panel
e977372 docs: update commit history in MULTI_AGENT_STATUS.md
48bf828 fix(agent): fix restore race condition and clearFlushTimer leak, add persistence tests
7fa4cc4 feat(agent): add persistence & crash recovery for multi-agent runtime
336177b test(agent): add 5 async-spawn-fixes tests
77cdd9d fix(agent): sub-agent execState isolation, async signal independence, dead code cleanup
a398a1f test(agent): add 23 lifecycle tests (14 unit + 9 integration)
a9024de feat(agent): add AgentLifecycleManager for global lifecycle tracking
1aaec4f feat(agent): async spawn + TaskBoard + unified merge + bus wakeup
0784d72 fix(bus): fix 5 bugs in reply/send + add Transport interface
cfac45a feat(agent): add multi-agent communication layer (Phase 1)
6ca61a5 refactor(bus): clean dead events, enforce type safety, fix ChatCore leak
```

## 设计文档位置

- `docs/plans/async-spawn-taskboard-merge-bus-wakeup.md` — 异步编排设计方案
- `docs/plans/async-spawn-self-review.md` — 初版自查报告（已被后续审计取代）
- `COMMUNICATION_LAYER_DESIGN.md` — 通信层完整设计（含 Phase 路线图）

## 下一步

1. ~~修 Phase 2 的 2 个问题（竞态 + clearFlushTimer）~~ ✅ 已完成
2. ~~补 Phase 2 测试~~ ✅ 已完成
3. ~~Phase 3：系统提示词 + UI~~ ✅ 已完成
4. 实际运行验证
5. Phase 4：协作能力
