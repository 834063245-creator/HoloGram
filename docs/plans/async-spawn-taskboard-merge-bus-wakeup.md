# 异步 Spawn + TaskBoard + 统一 Merge + Bus 唤醒设计方案

## 1. 背景与目标

通信层（MessageBus Phase 1）已落地。当前 `agent_spawn` 阻塞等待子 agent 完成，父 agent 完全停摆。要激活通信层的实际用途，需要：

1. **非阻塞 spawn** — 父 agent spawn 后立即继续，结果通过 bus 回来
2. **TaskBoard** — 共享状态区，自动追踪每个 agent 改了哪些文件（发现式，非声明式）
3. **统一 merge** — 子 agent 只保全 diff，父 agent 像合 PR 一样统一 merge
4. **Bus 唤醒** — idle agent 收到 bus 消息时自动启动一轮 runLoop

四个改动互相依赖，不可拆分实现。

## 2. 设计原则

- **保留阻塞模式** — `agent_spawn` 加 `async: true` 参数，默认仍为阻塞（向后兼容）
- **发现式文件追踪** — 子 agent 不声明改哪些文件，工具执行时自动登记到 board
- **merge 是父 agent 的主动决策** — 子 agent 完成后只保全 diff 到 board，不自动 merge
- **git 是安全网** — 统一 merge 出问题可以 git reset 回滚

## 3. TaskBoard — 共享状态区

### 3.1 数据结构

```typescript
// src-ui/src/agent/task-board.ts

interface BoardEntry {
  agentId: string;
  parentAgentId: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  isolationId: string | null;       // worktree ID
  filesTouched: string[];           // 自动追踪（工具层副作用）
  summary?: string;                 // 完成后的报告
  diff?: string;                    // 完成后的 diff（保全在 board 上）
  startedAt: number;
  finishedAt?: number;
}

class TaskBoard {
  private entries = new Map<string, BoardEntry>();

  /** 父 agent spawn 时调用 */
  register(entry: Omit<BoardEntry, 'status' | 'filesTouched' | 'startedAt'>): void;

  /** 工具执行副作用：子 agent write/edit 时自动登记 */
  recordFileTouch(agentId: string, filepath: string): void;

  /** 子 agent 完成时调用 */
  complete(agentId: string, summary: string, diff: string): void;
  fail(agentId: string, error: string): void;
  stop(agentId: string): void;

  /** 父 agent 查询全部子 agent 状态 */
  getChildren(parentAgentId: string): BoardEntry[];
  getEntry(agentId: string): BoardEntry | undefined;

  /** 注销 */
  unregister(agentId: string): void;
}
```

### 3.2 文件追踪机制

不是子 agent 主动声明，而是 **PostTool Hook 副作用**：

```
子 agent 调用 write_file / edit_file
  → StreamingToolExecutor.executeTool() 执行
  → PostTool Hook 检查工具名
    → 如果是 write_file / edit_file
    → 从 args 中提取 filepath
    → 调用 board.recordFileTouch(this._agent_id, filepath)
```

这复用现有的 `HookRegistry` 机制——`GraphContextHook` 已经在 post-tool 注入图元数据，新增一个 `BoardFileTrackingHook` 做同样的事。

### 3.3 TaskBoard 与 MessageBus 的关系

- **MessageBus** = 消息通道（"我完成了"的通知）
- **TaskBoard** = 共享状态（"谁改了什么"的账本）

子 agent 完成时：
1. 保全 diff 到 TaskBoard（`board.complete(agentId, summary, diff)`）
2. 通过 bus 发消息通知父 agent（`bus.send({ type: 'result', ... })`）

父 agent 收到 bus 消息后从 TaskBoard 读结构化状态，而非从消息文本里解析。

### 3.4 注入路径

```
AgentRuntime
  ├── 持有 TaskBoard 实例（全局单例，类似 MessageBus）
  ├── createAgent() 时注入 board 到 AgentConfig + AgentOptions
  └── destroyAgent() 时 board.unregister()

Agent.spawnSubAgent()
  └── 子 Agent 创建后 board.register(childEntry)
       └── 子 Agent 的 HookRegistry 注册 BoardFileTrackingHook
```

## 4. 非阻塞 Spawn

### 4.1 工具 schema 变更

`agent_spawn` 新增 `async` 参数：

```typescript
{
  name: 'agent_spawn',
  parameters: () => ({
    type: 'object',
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
      subagent_type: { type: 'string' },
      tool_allowlist: { type: 'array', items: { type: 'string' } },
      timeout_minutes: { type: 'number' },
      async: {
        type: 'boolean',
        description: 'If true, returns immediately with the sub-agent ID. ' +
          'The sub-agent runs in the background; its result arrives via agent_message (type: "result"). ' +
          'If false (default), blocks until the sub-agent finishes.',
      },
    },
    required: ['description', 'prompt'],
  }),
}
```

### 4.2 异步 spawn 执行流程

```
async: true 时:
  1. pool.spawn(...) → 拿到 signal + done promise
  2. board.register({ agentId, parentAgentId, description, isolationId })
  3. 立即返回 tool result: "子Agent已启动 (id: sub-xxx)。完成后将通过消息通知你。"
  4. 子 agent 在后台 run()（不 await done）
  5. 子 agent 完成后:
     a. 保全 diff 到 board
     b. bus.send({ from: childId, to: parentId, type: 'result', payload: summary })
     c. 通知 UI（subPart.status → done/failed）
     d. 不自动 merge（统一 merge 由父 agent 决定）

async: false 时（默认）:
  现有行为不变——await spawned.done，返回 result
```

### 4.3 spawnSubAgent() 改动

新增 `asyncMode: boolean` 参数：

```typescript
async spawnSubAgent(
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
  toolAllowlist?: string[] | null,
  poolSignal?: AbortSignal,
  asyncMode?: boolean,        // ← 新增
): Promise<{ text: string; err?: string }>
```

`asyncMode === true` 时：
- 不 await `subAgent.run()`，而是 fire-and-forget
- `run()` 的 `.then()` 中做：board.complete + bus.send + UI 通知
- `spawnSubAgent()` 立即返回 `{ text: '子Agent已启动...' }`

### 4.4 isolation 改动

异步模式下：
- `agent_isolation_create` 照常调用（创建 worktree）
- 子 agent 完成后：
  - 调用 `agent_isolation_diff` 保全 diff 到 board
  - **不调用 `agent_isolation_merge`**（统一 merge 由父 agent 触发）
  - **不调用 `agent_isolation_discard`**（worktree 保留，等 merge 后再清理）
- 如果子 agent 失败/中止：discarded worktree

## 5. 统一 Merge

### 5.1 新增工具：agent_merge

```typescript
{
  name: 'agent_merge',
  description: 'Merge completed sub-agent worktrees back into the main repository. ' +
    'Reviews all pending changes from the TaskBoard, merges them sequentially. ' +
    'On conflict, preserves the diff for manual application.',
  parameters: () => ({
    type: 'object',
    properties: {
      agent_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sub-agent IDs to merge. If omitted, merges all completed sub-agents.',
      },
    },
  }),
}
```

### 5.2 统一 merge 流程

```
父 agent 调用 agent_merge
  → 从 TaskBoard 读取所有 status=completed 的子 agent
  → 对每个子 agent（按完成顺序）:
    1. 从 board 读取 isolationId
    2. enqueueIsolationOp(() => agent_isolation_merge(agentId))
       - 成功 → agent_isolation_discard(agentId) 清理 worktree
       - 冲突 → 保全 diff（已在 board 上），discarded worktree
    3. 更新 board 状态
  → 返回汇总: "已合并 3 个子Agent，0 个冲突"
  → 如果有冲突: 列出冲突的子 agent + diff
```

### 5.3 父 agent 的使用模式

```
LLM: agent_spawn(async=true, "实现登录页面", prompt1)  → "已启动 sub-aaa"
LLM: agent_spawn(async=true, "实现API路由", prompt2)    → "已启动 sub-bbb"
LLM: agent_spawn(async=true, "写测试", prompt3)         → "已启动 sub-ccc"
... 父 agent 继续做其他工作 ...
[bus 消息: sub-aaa 完成]
[bus 消息: sub-bbb 完成]
[bus 消息: sub-ccc 完成]
LLM: agent_merge()  → "已合并 3 个子Agent，0 个冲突"
```

### 5.4 _finalizeIsolation 的变化

现有 `_finalizeIsolation()` 在子 agent 完成时立即 merge。改为：

- **阻塞模式**：行为不变（立即 merge，因为父 agent 在等结果）
- **异步模式**：不 merge，只保全 diff 到 board

```typescript
// spawnSubAgent() 中
if (asyncMode) {
  // 不 merge，保全 diff
  const diff = await diffT.execute({ agent_id: isolationId });
  board.complete(childId, summary, diff);
  // worktree 保留，等 agent_merge 时再处理
} else {
  // 现有行为：enqueueIsolationOp(() => _finalizeIsolation(...))
}
```

## 6. Bus 唤醒机制

### 6.1 问题

异步子 agent 完成后通过 bus 发消息。但如果父 agent 已经结束 runLoop（LLM 说"我做完了"），`_injectInbox()` 不会被调用——消息永远躺在 inbox 里。

### 6.2 设计

MessageBus 在 deliver 成功后调一个回调。Agent 注册时传入"唤醒"回调：

```typescript
// message-types.ts 新增
interface MessageTransport {
  deliver(agentId: string, msg: AgentMessage): void;
  /** 注册消息到达回调（agent idle 时用来唤醒 runLoop） */
  onDelivered?(agentId: string): void;
}

// message-bus.ts
class MessageBus {
  private wakeCallbacks = new Map<string, () => void>();

  register(addr: AgentAddress, onWake?: () => void): void {
    this.agents.set(addr.agentId, addr);
    if (!this.inboxes.has(addr.agentId)) this.inboxes.set(addr.agentId, []);
    if (onWake) this.wakeCallbacks.set(addr.agentId, onWake);
  }

  private _deliverToInbox(agentId: string, msg: AgentMessage): void {
    // ... 现有投递逻辑 ...
    // 投递成功后触发唤醒
    this.wakeCallbacks.get(agentId)?.();
  }
}
```

### 6.3 Agent 端唤醒

```typescript
class Agent {
  private _isRunning = false;  // 追踪 runLoop 状态

  setBus(bus: MessageBus): void {
    this._bus = bus;
    bus.register(
      { agentId: this.id, parentId: this.parentId, depth: this._subagentDepth },
      () => this._onMessageDelivered(),  // 唤醒回调
    );
  }

  private async _onMessageDelivered(): Promise<void> {
    // 只在 idle 时唤醒——如果已经在 runLoop 中，_injectInbox 会自然处理
    if (this._isRunning) return;
    if (this._bus?.unreadCount(this.id) === 0) return;

    // 用一个新的 AbortController 启动一轮 runLoop
    const ac = new AbortController();
    try {
      await this.run(ac.signal, '');  // 空 input，runLoop 中 _injectInbox 会注入消息
    } catch {
      // 唤醒失败不致命——消息还在 inbox，下次 run() 会捡到
    }
  }
}
```

### 6.4 runLoop 改动

```typescript
private async runLoop(signal: AbortSignal): Promise<void> {
  this._isRunning = true;          // ← 新增
  this._currentRunSignal = signal;
  // ... 现有逻辑 ...
  // 循环结束时:
  this._isRunning = false;         // ← 新增
  // 如果唤醒期间有新消息到达，再次唤醒
  if (this._bus && this._bus.unreadCount(this.id) > 0) {
    // 微任务延迟，避免同步重入
    queueMicrotask(() => this._onMessageDelivered());
  }
}
```

### 6.5 空 input 处理

`run(signal, '')` 时空 input 需要特殊处理——不 push user message，直接进 runLoop：

```typescript
async run(signal: AbortSignal, input: string): Promise<void> {
  this._isRunning = true;
  if (this._preRunHook && input) { ... }
  if (input) {
    this.session.push({ role: 'user', content: input });
  }
  await this.runLoop(signal);
  // ...
}
```

空 input 时 runLoop 直接从 `_injectInbox()` 开始——inbox 消息作为唯一的"输入"。

## 7. UI 适配

### 7.1 异步子 agent 的 UI 状态

现有 `SubAgentPart` 已有 `status: 'running' | 'done' | 'error'`。异步模式下：

- spawn 时：创建 SubAgentPart，status = 'running'（现有逻辑不变）
- 子 agent 运行中：事件通过 subSink 流入 SubAgentPart.parts（现有逻辑不变）
- 子 agent 完成：通过 board/bus 通知 → runtime-adapter 更新 SubAgentPart.status = 'done'
- merge 时：父 agent 的 `agent_merge` 工具结果显示 merge 汇总

### 7.2 runtime-adapter 改动

`onSubAgentFinished` 需要在异步模式下也能被调用。现有调用点在 `spawnSubAgent()` 的 finally 块中。异步模式下，finally 在子 agent 的 `.then()` 中执行：

```typescript
// 异步模式下
subAgent.run(signal, prompt).then(() => {
  // 保全 diff + board + bus
  this._ui.subAgentFinished?.(subAgentId, this._uiSessionId, true);
}).catch(() => {
  this._ui.subAgentFinished?.(subAgentId, this._uiSessionId, false);
});
```

## 8. 文件清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src-ui/src/agent/task-board.ts` | TaskBoard 核心实现 |
| `src-ui/src/agent/hooks/board-tracking-hook.ts` | PostTool hook，自动追踪文件修改到 board |
| `src-ui/src/agent/tools/merge.ts` | agent_merge 工具 |

### 改动文件

| 文件 | 改动 |
|------|------|
| `src-ui/src/agent/tools/subagent.ts` | schema 加 `async` 参数；异步模式返回 agentId |
| `src-ui/src/agent/agent.ts` | `spawnSubAgent()` 加 asyncMode；`_isRunning` 字段；`_onMessageDelivered()` 唤醒；`run()` 空输入处理；`runLoop` `_isRunning` 管理 |
| `src-ui/src/agent/coordinator.ts` | SubAgentPool 无需改动（pool 本身不关心阻塞/非阻塞） |
| `src-ui/src/agent/message-bus.ts` | `register()` 加 onWake 回调；`_deliverToInbox` 后触发回调 |
| `src-ui/src/agent/message-types.ts` | `MessageTransport` 接口加 `onDelivered` |
| `src-ui/src/agent/runtime/types.ts` | AgentConfig 加 `taskBoard?: TaskBoard` |
| `src-ui/src/agent/runtime/runtime.ts` | createAgent 注入 board；注册 board tracking hook |
| `src-ui/src/agent/runtime/agent-builder.ts` | buildToolRegistry 注册 agent_merge 工具 |
| `src-ui/src/agent/streaming-executor.ts` | 无需改动（hook 自动拦截） |

## 9. 中断与超时语义

### 阻塞模式（不变）
- 用户 stop → cascadeAbort → pool.stopAll → 子 agent 中止
- 超时 → pool abort → 子 agent 中止

### 异步模式
- 用户 stop → cascadeAbort → pool.stopAll → 所有异步子 agent 中止
- 超时 → pool abort → 子 agent 中止
- 中止后：board.stop(agentId)，worktree discarded
- 唤醒机制不受影响——中止的 agent 不会被唤醒（`_isRunning` 检查 + abort signal）

## 10. 验证计划

### 单元测试

| 测试 | 验证点 |
|------|--------|
| `test_task_board_register_complete` | 注册 + 完成 + 查询 |
| `test_task_board_file_tracking` | recordFileTouch 正确追加文件 |
| `test_async_spawn_returns_immediately` | async=true 时工具立即返回 agentId |
| `test_async_spawn_result_via_bus` | 子 agent 完成后 bus 收到 type=result 消息 |
| `test_async_spawn_no_auto_merge` | 异步模式下 worktree 不被 merge，diff 保全在 board |
| `test_agent_merge_tool` | agent_merge 串行合并所有 completed 子 agent |
| `test_agent_merge_conflict` | 冲突时 diff 保全，worktree 清理 |
| `test_bus_wakeup_idle_agent` | idle agent 收到消息后自动启动 runLoop |
| `test_bus_wakeup_running_agent` | running agent 收到消息不重复唤醒 |
| `test_wakeup_empty_input` | 空 input 时 runLoop 从 _injectInbox 开始 |

### 集成测试

| 测试 | 验证点 |
|------|--------|
| `test_parallel_async_spawn_and_merge` | 3 个异步子 agent并行跑，统一 merge，无冲突 |
| `test_parallel_async_spawn_with_conflict` | 2 个子 agent 改同一文件，merge 时冲突保全 diff |
| `test_mixed_sync_async_spawn` | 先 spawn 异步 A，再 spawn 同步 B，B 完成后 A 也完成 |
| `test_wakeup_during_goal_loop` | goal loop 中异步子 agent 完成后被唤醒 |

## 11. 开放问题

1. **异步子 agent 的递归 spawn**：异步子 agent 是否能 spawn 自己的异步子 agent？当前 `agent_spawn` 在 fork 子 agent 中被移除。异步模式可能需要保留（但加深度限制）。

2. **worktree 生命周期**：异步模式下 worktree 保留到 merge。如果父 agent 忘记 merge，worktree 会泄漏。需要超时清理机制（如 30 分钟未 merge 自动 discard）。

3. **agent_merge 的调用时机**：是让 LLM 自己决定何时 merge，还是检测到所有子 agent 完成后自动提示？建议给 LLM 自由度，但在 system-reminder 中提示"有 N 个子 agent 待 merge"。

4. **bus 唤醒的并发安全**：多个子 agent 同时完成时，父 agent 可能被并发唤醒。`_isRunning` guard + `queueMicrotask` 应该能防止重入，但需要验证。
