# HoloGram 前端架构重构 Spec

## 目标

消除 Agent 引擎和聊天 UI 之间不必要的耦合，建立清晰的数据流边界。修复 reactive compaction 后 UI/Agent 数据不同步的实际 bug。

## 当前问题清单（对照）

| # | 问题 | 根因 |
|---|------|------|
| 1 | reactive compact 后 UI 消息与 Agent session 不同步 | Agent 缺乏 session 变更通知通道 |
| 2 | workspace.ts 1586 行，`_setupAgentInner` 476 行 | Workspace 是 God Class |
| 3 | chat-session.ts 双轨状态（zustand + module Map） | 可序列化与非可序列化状态分散 |
| 4 | StreamContext 30+ 方法的 God Interface | 渲染上下文未做最小化裁剪 |
| 5 | Agent event 通过 bus 回环到自己 panel | 不必要的间接层 |
| 6 | `_pendingStreamingSessions` 全局 Map | 时序桥接的脆弱补丁 |
| 7 | `maybeCompact` fire-and-forget，成功替换 session 无 UI 通知 | 缺少 session 变更回调 |
| 8 | `_runAgentTurn` 两种调用模式混用（await vs fire-and-forget） | 调用模式不统一 |
| 9 | `_factAuthorized` 模块级全局可变变量 | 跨 workspace 共享状态 |
| 10 | `_refreshGoalRecord` 每次 new GoalManager | 不必要的实例创建 |
| 11 | `loadSessionFromDisk` 直接捅 `agentHandles` Map | 绕过 AgentSessionState 抽象 |
| 12 | `retractTurnAt` 也不触发 ChatMessage 重建 | 同问题 1，缺少 session 变更回调 |
| 13 | `subParts` Map + `bumpStore` 闭包跨 session 串流 | `msgStoreForActive` 在闭包中迟到绑定 |
| 14 | `_rebuildMessagesFromSession` 依赖 `SessionContext` DOM 元素 | 和 ChatCore 的 stub DOM 耦合 |

## 架构目标

```
重构前：

  Workspace (God)
    ├── Agent 创建
    ├── ToolRegistry 组装
    ├── Memory / Task / Skill / Goal 管理
    ├── Graph hooks 注入
    ├── Provider 创建
    ├── UI 回调
    └── check/analysis

  Agent ──AgentEvent──→ bus ──agent:event──→ ChatCore.renderEvent()
                           ↑                        │
                           └────────────────────────┘ (回环，同一实例)

  chat-session.ts (双轨状态)
    ├── zustand store (sessions[], activeIdx, tokens)
    └── module Maps (agentHandles, execStates, turnPairs, factory)
         ↑ 直接被 loadSessionFromDisk 写入，绕过所有抽象

  StreamContext (30 methods)
    ├── getAgent() / getSessionMessages() / setSessionMessages()
    ├── getUserScrolledUp() / getStarGraph()
    ├── updateFooter() / setLastUsageText()
    ├── abort() / setRunning()
    └── saveActiveSession() / retractTurn()

  subParts Map (workspace.ts 闭包)
    └── bumpStore → msgStoreForActive()  ← 跨 session 串流风险

  _pendingStreamingSessions (全局 Map)
    └── sendMessage 设值 → streaming 消费 → 脆弱时序桥接

  _factAuthorized (模块级全局)
    └── /remember 设 true → memory_save 消费 → 跨 workspace 共享


重构后：

  AgentBootstrap (纯函数)
    ├── 输入: Provider + Settings + GraphSnapshot
    └── 输出: { agent, toolRegistry, hooks, memoryManager }

  Workspace (精简)
    ├── 生命周期: open() / deactivate()
    ├── 持有: AgentBootstrap 产物 + StarGraph
    └── 转发: check/analysis

  Agent ──AgentEvent──→ ChatCore.renderEvent()  (直连，不走 bus)

  bus (只用于跨组件)
    ├── graph:node-clicked → ChatCore
    ├── check:result → Toolbar
    └── memory:saved → MemoryPanel

  AgentSessionState (新的 zustand store)
    └── { isRunning, sessionVersion, abortController, permCards }
        替代 chat-session.ts 的 module Maps + execState

  RenderContext (6 methods)
    ├── targetSessionMessages()  — 只读
    ├── bumpTargetSession()     — 触发重渲染
    └── streamingAssistantId()  — 当前 streaming assistant 标识
```

## 变更清单

### 1. 新增 `AgentSessionState` store（替代 `chat-session.ts` module Maps）

**文件**: `src-ui/src/agent/agent-session-state.ts` (新建)

```typescript
interface AgentSessionState {
  // 每 session 的 agent 句柄
  agentBySession: Map<string, ChatAgentHandle>;
  // 每 session 的执行状态
  execBySession: Map<string, ExecStateInstance>;
  // 每 panel 的 agent 工厂
  agentFactoryByPanel: Map<string, () => Promise<ChatAgentHandle | null>>;
  // 每 panel 的 turn pairs
  turnPairsByPanel: Map<string, TurnPair[]>;

  // 操作
  setAgent(storeId: string, sessionId: number, agent: ChatAgentHandle): void;
  getAgent(storeId: string, sessionId: number): ChatAgentHandle | null;
  removeAgent(storeId: string, sessionId: number): void;
  setExec(storeId: string, sessionId: number, exec: ExecStateInstance): void;
  getExec(storeId: string, sessionId: number): ExecStateInstance;
  // ... 等其他操作
}
```

用 zustand vanilla store + 内部 Map 实现。Map 不可序列化但 zustand 的 `version` counter 可在 agent 变更时触发订阅。

**验证**: 删除 `chat-session.ts` 中的 `agentHandles` / `sessionExecStates` / `turnPairsByPanel` / `agentFactoryByPanel` 四个 module-level Map，所有引用走 `AgentSessionState`。

---

### 2. 新增 `AgentBootstrap` 纯函数（拆分 `Workspace._setupAgentInner`）

**文件**: `src-ui/src/agent/bootstrap.ts` (新建)

```typescript
interface AgentBootstrapInput {
  settings: ProviderSettings;
  projectPath: string;
  graphSnapshot: GraphSnapshot | null;
  memoryManager: MemoryManager;
  skillRegistry: SkillRegistry;
  taskManager: TaskManager;
  agentStore: AgentStore;
  goalManager: GoalManager;
  subAgentPool: SubAgentPool;
}

interface AgentBootstrapOutput {
  agent: Agent;
  toolRegistry: ToolRegistry;
  hooks: HookRegistry;
  preflightHooks: PreflightHookRegistry;
  memoryManager: MemoryManager;  // 回传（已初始化 Aura）
}

async function bootstrapAgent(input: AgentBootstrapInput): Promise<AgentBootstrapOutput>
```

**职责边界**:
- `bootstrapAgent` 负责：创建 Provider → 注册工具 → 构建 system prompt → new Agent → 注入 hooks
- `bootstrapAgent` 不负责：读取文件、持久化设置、创建 MemoryManager / AgentStore / GoalManager（这些由 Workspace 传入）
- `Workspace._setupAgentInner` 删除，替换为调用 `bootstrapAgent`

**验证**: `Workspace._setupAgentInner` 方法删除。`Workspace` 行数从 1586 降到 ~1100 行。

---

### 3. Agent → UI 双向同步通道

**当前问题**: Agent 只通过 `AgentEvent` 流式推送 token 级事件。结构性变更（compaction、session replace、retract）没有通知 ChatCore。

**新增**（`agent-types.ts`）:

```typescript
enum EventKind {
  // ... 现有 ...
  SessionReplaced = 'session_replaced',  // compaction / session 替换后触发
}

// AgentUINotifier 新增:
interface AgentUINotifier {
  // ... 现有 ...
  /** Agent 的 session 数组已被整体替换（compaction / retract）。
   *  ChatCore 需要重建 ChatMessage[] 投影。 */
  sessionReplaced?(messages: Message[]): void;
}
```

**Agent 侧**（`agent.ts`）:
- `compactNow()` 替换 `this.session` 后调用 `this._ui.sessionReplaced?.(this.session)`
- `retractTurnAt()` 同理
- `setSession()` 同理

**ChatCore 侧**（`chat-core.ts`）:
- `uiNotifier.sessionReplaced` 实现：调用 `rebuildMessagesFromAgentSession(messages)` 重建 `ChatMessage[]` 并写入 store

**验证**: 手动触发 `/compact` 后，UI 显示的消息和 Agent 的 `session` 一致。reactive compact（上下文过长自动触发）同样同步。

---

### 4. StreamContext → RenderContext 最小化裁剪

**当前**: `StreamContext` 有 30+ 方法，暴露了整个 ChatCore 的内部。

**目标**: `RenderContext` 只有渲染真正需要的 6 个能力。

**文件**: `src-ui/src/ui/chat-stream.ts`

```typescript
interface RenderContext {
  /** 获取 streaming 目标 session 的消息列表 */
  getTargetMessages(): ChatMessage[];
  /** 写入目标 session 的消息列表（触发重渲染） */
  setTargetMessages(msgs: ChatMessage[]): void;
  /** 触发目标 session store 的版本 bump */
  bumpTarget(): void;
  /** 获取/设置 streaming assistant ID */
  getStreamingAssistantId(): MessageId | null;
  setStreamingAssistantId(id: MessageId | null): void;
  /** 获取/设置 streaming 目标 session ID（替代 _pendingStreamingSessions） */
  getStreamingTargetSid(): number | null;
  setStreamingTargetSid(sid: number | null): void;
}
```

`StreamContext` 中删除的方法及迁移目的地：

| 删除的方法 | 迁移到 |
|-----------|--------|
| `getAgent()` | 不再需要（renderEvent 不需要访问 agent） |
| `getStarGraph()` | 不再需要 |
| `updateFooter()` | ChatCore 内部调用，不通过 RenderContext |
| `setLastUsageText()` | Usage event 直接由 ChatCore 处理 |
| `abort()` | ChatCore 内部，不暴露给渲染 |
| `setRunning()` | ChatCore 内部 |
| `saveActiveSession()` | ChatCore 内部 |
| `retractTurn()` | ChatCore 内部 |
| `sendMessage()` | ChatCore 内部 |
| `addNotice()` | 保留为独立函数（非 RenderContext 成员） |
| `_recordToolUsage()` | ChatCore 内部 |

**验证**: `renderEvent()` 的签名从 `(ctx: StreamContext, ev: AgentEvent)` 变为 `(ctx: RenderContext, ev: AgentEvent)`。所有现有调用点不报类型错误（通过逐步裁剪实现）。

---

### 5. Agent Event 直连（消除 bus 回环）

**当前**:
```
Agent._sink(ev)
  → ChatCore.eventSink (getter)
    → bus.emit('agent:event', ev)
      → ChatCore constructor: bus.on('agent:event', renderEvent)
```

Agent → ChatCore 是 1:1 关系（每个 ChatCore 有一个 Agent），不需要 bus。

**修改**:

`ChatCore`:
```typescript
// 旧：
get eventSink(): (ev: AgentEvent) => void {
  return (ev) => this._bus.emit('agent:event', ev);
}
// 新：
get eventSink(): (ev: AgentEvent) => void {
  return (ev) => this.renderEvent(ev);
}
```

`ChatCore` 构造函数中删除 `this._bus.on('agent:event', ...)` 订阅。

**验证**: Agent 运行一轮对话，UI 正常渲染。`BusEvents` 中删除 `'agent:event'` 条目。

---

### 6. 消除 `_pendingStreamingSessions` 全局 Map

**当前**: `chat-stream.ts` 中 `const _pendingStreamingSessions = new Map<string, number>()`，在 `sendMessage` 设值，在 `_streamingAssistant` 清除。

**修改**: streaming 目标 session ID 作为 `RenderContext` 的一部分，在 `sendMessage` 调用 `agent.run()` 前设置:

```typescript
// chat-core.ts sendMessage():
const activeSid = getActiveSessionId(this.panelId);
this._renderCtx.setStreamingTargetSid(activeSid);
try {
  await this.agent.run(signal, text);
} finally {
  this._renderCtx.setStreamingTargetSid(null);
}
```

`_resolveSessionTarget` 改为从 `RenderContext.getStreamingTargetSid()` 读取，不再查全局 Map。

**验证**: 删除 `_pendingStreamingSessions` 变量。多 session 切换测试通过。

---

### 7. `_rebuildMessagesFromSession` 解耦 DOM 依赖

**当前**: 函数签名接受 `SessionContext`，内部使用 `ctx.panel` 等 DOM 元素，且直接读 `agentHandles` Map。

**修改**: 改为纯数据操作，不再依赖 `SessionContext`：

```typescript
// 旧：
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  // ... 从 ctx 取值 + 操作 DOM ...
}

// 新：
export function rebuildMessagesFromAgent(
  agent: ChatAgentHandle,
  storeId: string,
  sessionId: number,
): void {
  const msgs = agent.getSession();
  const store = msgStoreFor(storeId, sessionId);
  // 重建 ChatMessage[] 从 Message[]
  store.getState().setMessages(/* ... */);
  bumpSession(storeId, sessionId);
}
```

**验证**: `loadSessionFromDisk` 和 `sessionReplaced` 回调都调用同一函数。

---

### 8. `subParts` 跨 session 串流修复

**当前**: `workspace.ts` 中 `bumpStore = () => msgStoreForActive(this._storeId)?.getState().bump()` — 始终 bump ACTIVE session，不一定是 sub-agent 所属的 session。

**修改**: `AgentUINotifier.subAgentSpawn` 和 `subAgentFinished` 接收 `sessionId`，按精确 session bump：

```typescript
// AgentUINotifier 修改:
subAgentSpawn?(
  info: { agentId: string; description: string; sessionId: number },
  onProgress?: (chunk: string) => void,
): EventSink | undefined;
subAgentFinished?(agentId: string, sessionId: number, ok: boolean): void;
```

`workspace.ts` 中改为按 sessionId 精确 bump：

```typescript
const bumpStore = (sid: number) => msgStoreFor(this._storeId, sid)?.getState().bump();
```

**验证**: 子 agent 完成时，bump 的是发起子 agent 的 session，不是当前激活的 session。

---

### 9. 统一 `_runAgentTurn` 调用模式

**当前**: `sendMessage` 用 `await`，`runGoal`/`runGoalResume`/`sendAgentText` 用 fire-and-forget。

**修改**: 统一为 `async/await`：

```typescript
private async _runAgentTurn(opts: { ... }): Promise<void> {
  // ... setup ...
  try {
    const result = await opts.drive(signal);
    if (result) opts.onResult?.(result as GoalRunResult);
  } catch (err) { ... }
  finally {
    this._activeExec().done();
    this.finishTurn();
    this._renderCtx.setStreamingTargetSid(null);
  }
}
```

调用方全部改为 `await this._runAgentTurn(...)`。

**验证**: cleanup 不再依赖 Promise.finally() 时序，所有调用者行为一致。

---

## 实施顺序

```
Phase 1: AgentSessionState (地基 — 先消除 module Maps)
  ├── 1.1 新建 agent-session-state.ts
  ├── 1.2 chat-session.ts / chat-core.ts / loadSessionFromDisk 迁移引用
  ├── 1.3 删除旧 module Maps (agentHandles / sessionExecStates / turnPairsByPanel / agentFactoryByPanel)
  └── 1.4 loadSessionFromDisk 不再直接写 Map，走 AgentSessionState.setAgent()

Phase 2: AgentBootstrap (拆分 Workspace)
  ├── 2.1 新建 bootstrap.ts
  ├── 2.2 将 _setupAgentInner 逻辑迁移进去
  └── 2.3 Workspace 精简 (~1100 行)

Phase 3: Session 同步通道 + 调用模式统一 (修 P0 bug)
  ├── 3.1 AgentUINotifier 新增 sessionReplaced(messages: Message[])
  ├── 3.2 Agent 侧触发点 (compactNow / retractTurnAt / setSession / maybeCompact.then)
  ├── 3.3 ChatCore 侧重建 ChatMessage[] (调用 _rebuildMessagesFromSession)
  ├── 3.4 _rebuildMessagesFromSession 解耦 DOM — 不再依赖 SessionContext，仅需 (agent, storeId, sid)
  ├── 3.5 _runAgentTurn 统一为 await 模式 — sendAgentText/runGoal/runGoalResume 改用 async 等待
  └── 3.6 subParts bumpStore 修复 — 从 msgStoreForActive 改为按 sessionId 精确 bump

Phase 4: RenderContext 裁剪 + bus 直连 + pendingSessions 消除
  ├── 4.1 StreamContext → RenderContext (逐步删除方法)
  ├── 4.2 Agent event 直连 (eventSink 改直调 renderEvent)
  ├── 4.3 消除 _pendingStreamingSessions — 改为 RenderContext.setStreamingTargetSid()
  └── 4.4 清理 event bus 死订阅 (agent:event / agent:progress / agent:tool-done)

每个 Phase 独立可测试，不破坏现有功能。Phase 间按顺序依赖（Phase 2 依赖 Phase 1 的 AgentSessionState）。

## 不做什么

- 不重写 `chat-stream.ts` 的流式渲染逻辑（renderEvent / applyEventToParts 本身没问题，是它的输入 StreamContext 太大）
- 不修改 Agent 循环的核心逻辑（runLoop / stream / goal loop 结构不变）
- 不修改 provider / message-model / tool 层
- 不修改 Rust 后端
- 不改变现有的 INVARIANTS.md 规则
