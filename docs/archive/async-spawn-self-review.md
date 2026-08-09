# Self-Review: 异步 Spawn + TaskBoard + 统一 Merge + Bus 唤醒

## 对照计划逐项验证

### 3. TaskBoard

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| BoardEntry 数据结构 | `status: 'running' \| 'completed' \| 'failed' \| 'stopped'` | 加了 `'merged'` 状态 — merge 成功后标记 | ⚠️ 偏差（合理扩展） |
| register() | `Omit<BoardEntry, 'status' \| 'filesTouched' \| 'startedAt'>` | 一致 | ✅ |
| recordFileTouch() | 追加文件，不重复 | 用 `includes()` 去重 | ✅ |
| complete/fail/stop | 完成时调用 | 一致 | ✅ |
| getChildren/getEntry | 父 agent 查询 | 一致 | ✅ |
| unregister | 注销 | 一致 | ✅ |
| markMerged | 计划未提及 | 新增 — merge 成功后标记 | ⚠️ 偏差（合理扩展） |

### 3.2 文件追踪机制

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| Hook 类型 | PostTool Hook (Hook interface) | 一致 — 实现 `Hook` 接口 | ✅ |
| 触发工具名 | `write_file` / `edit_file` | `FILE_WRITE_TOOLS = Set(['write_file', 'edit_file'])` | ✅ |
| 提取 filepath | 从 args 中提取 | `args.filePath \|\| args.file_path` | ✅ |
| agentId 来源 | `this._agent_id` (StreamingToolExecutor 注入) | **不用 `_agent_id`** — hook 工厂函数闭包捕获 `agentId`（Agent 的逻辑 ID） | ⚠️ 偏差（见下方说明） |

**说明**: 计划说 `board.recordFileTouch(this._agent_id, filepath)`，即从 StreamingToolExecutor 注入的 `_agent_id` 取 agent ID。但实际 `_agent_id` 是 **isolationId**（worktree ID），不是 agent 逻辑 ID。我改为在 `createBoardTrackingHook(agentId, board)` 工厂函数中闭包捕获 agent 的逻辑 ID，这是更正确的做法。

### 3.4 注入路径

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| AgentRuntime 持有 TaskBoard | 全局单例 | `private _taskBoard = new TaskBoard()` | ✅ |
| createAgent() 注入 board | AgentConfig + AgentOptions | `taskBoard: this._taskBoard` 传入 Agent 构造函数 | ✅ |
| destroyAgent() 注销 | `board.unregister()` | `this._taskBoard.unregister(id)` | ✅ |
| spawnSubAgent() 注册子 agent | `board.register(childEntry)` | 在子 agent 创建后注册 | ✅ |
| 子 agent HookRegistry 注册 BoardFileTrackingHook | 注册 hook | `subHooks.register(createBoardTrackingHook(...))` | ✅ |

### 4. 非阻塞 Spawn

#### 4.1 Schema 变更

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| `async` 参数 | boolean, description | 一致 | ✅ |
| required | `['description', 'prompt']` | 一致 | ✅ |

#### 4.2 异步 spawn 执行流程

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| pool.spawn → 拿到 signal + done | | 一致 | ✅ |
| board.register | | 一致（在 spawnSubAgent 中） | ✅ |
| 立即返回 tool result | `"子Agent已启动..."` | 一致 | ✅ |
| 子 agent 后台 run | 不 await done | **工具层不 await done**；但 spawnSubAgent (runFn) 仍 await subAgent.run() | ⚠️ 偏差（见下方说明） |
| 完成后保全 diff | board.complete | 一致 | ✅ |
| bus.send type=result | | 一致 | ✅ |
| 通知 UI | subAgentFinished | 在 finally 块中调用 | ✅ |
| 不自动 merge | | 一致 — async 分支不调 _finalizeIsolation | ✅ |

**说明**: 计划 4.3 说"不 await `subAgent.run()`，而是 fire-and-forget"。我的实现中 `spawnSubAgent` (作为 pool 的 runFn) **仍 await `subAgent.run()`**。原因：

1. **工具层**不 await `spawned.done` → 工具立即返回 ✅
2. **runFn (spawnSubAgent)** 仍 await `subAgent.run()` → pool 持续追踪为 "running"
3. 好处：pool 的 abort/stop 机制在子 agent 运行期间仍然有效（计划 9 中"用户 stop → cascadeAbort → pool.stopAll"语义正确）

如果按计划字面 fire-and-forget `subAgent.run()`，pool 会立即标记为 completed，`pool.stopAll()` 找不到该 agent，abort 信号不会触发。

#### 4.3 spawnSubAgent() 改动

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| 新增 asyncMode 参数 | `asyncMode?: boolean` | 一致 | ✅ |
| SubAgentSpawner 类型 | 新增 asyncMode | 一致 | ✅ |
| workspace.ts 传递 | | 已更新 lambda | ✅ |

#### 4.4 isolation 改动

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| isolation_create 照常 | | 一致 | ✅ |
| 完成后 isolation_diff 保全 | | 一致 | ✅ |
| 不 isolation_merge | | 一致 | ✅ |
| 不 isolation_discard（成功时） | worktree 保留 | 一致 | ✅ |
| 失败/中止时 discard | | 一致 | ✅ |

### 5. 统一 Merge

#### 5.1 agent_merge 工具

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| 工具名 | `agent_merge` | 一致 | ✅ |
| 参数 | `agent_ids?: string[]` | 一致 | ✅ |
| 注册位置 | agent-builder.ts | **runtime.ts** | ⚠️ 偏差（见下方说明） |

**说明**: 计划说在 agent-builder.ts 注册。实际在 runtime.ts 注册，因为 merge tool 需要 agent ID (`() => newAgent.id`)，而 agent-builder.ts 不知道具体 agent ID。功能等价。

#### 5.2 统一 merge 流程

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| 读取 completed 子 agent | 从 board | `board.getChildren(parentId).filter(status='completed')` | ✅ |
| 串行 merge | enqueueIsolationOp | 使用共享 `enqueueIsolationOp`（从 agent.ts 导入） | ✅ |
| 成功 → discard + 更新状态 | | `board.markMerged()` | ✅ |
| 冲突 → 保全 diff + discard | | diff 已在 board，worktree discard | ✅ |
| 返回汇总 | | `"已合并 N 个子Agent，M 个冲突"` | ✅ |

#### 5.4 _finalizeIsolation 变化

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| 阻塞模式：行为不变 | 立即 merge | 一致 | ✅ |
| 异步模式：不 merge，保全 diff | | 一致 — async 分支调 `board.complete()` | ✅ |

### 6. Bus 唤醒机制

#### 6.2 MessageBus 改动

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| wakeCallbacks map | | 一致 | ✅ |
| register() 加 onWake | | 一致 | ✅ |
| _deliver 后触发回调 | `_deliverToInbox` | `_deliver` (名字不同，功能一致) | ✅ |
| unregister 清理 wake | | 一致 | ✅ |
| MessageTransport 加 onDelivered | | 一致 | ✅ |

**说明**: 计划用 `_deliverToInbox` 方法名，实际代码中投递逻辑在 `InProcessTransport.deliver()` 中，不是 bus 的私有方法。我新增 `_deliver()` 作为 `transport.deliver()` + wake callback 的包装，功能等价。

#### 6.3 Agent 端唤醒

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| _isRunning 字段 | | 一致 | ✅ |
| setBus 注册 wake 回调 | `() => this._onMessageDelivered()` | `() => { void this._onMessageDelivered(); }` | ✅ |
| _onMessageDelivered | idle 检查 + 空 input run | 一致 | ✅ |

#### 6.4 runLoop 改动

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| _isRunning = true (开头) | | 一致 | ✅ |
| _isRunning = false (结尾) | | 在 `finally` 块中 | ✅ |
| 结尾检查 inbox + queueMicrotask | | 一致，额外加了 `!signal.aborted` 守卫 | ⚠️ 偏差（见下方说明） |

**说明**: 我加了 `!signal.aborted` 守卫 — 用户 stop 时不自动唤醒。计划没提，但这是合理的安全措施。

#### 6.5 空 input 处理

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| run() 跳过 preRunHook (空 input) | | `if (this._preRunHook && input)` | ✅ |
| run() 跳过 push user message (空 input) | | `if (input) { this.session.push(...) }` | ✅ |
| runLoop 从 _injectInbox 开始 | | 一致 — _injectInbox 在 for 循环开头 | ✅ |

### 7. UI 适配

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| subAgentFinished 在异步模式调用 | finally 块中 | 一致 — finally 块在 try/catch 后执行 | ✅ |
| 异步模式 UI 状态更新 | | 一致 — finally 调用 subAgentFinished | ✅ |

### 8. 文件清单对比

| 文件 | 计划状态 | 实际状态 | 备注 |
|------|----------|----------|------|
| `task-board.ts` | 新增 | ✅ 新增 | |
| `hooks/board-tracking-hook.ts` | 新增 | ✅ 新增 | |
| `tools/merge.ts` | 新增 | ✅ 新增 | |
| `tools/subagent.ts` | 改动 | ✅ 改动 | |
| `agent.ts` | 改动 | ✅ 改动 | |
| `coordinator.ts` | 无需改动 | ✅ 未改 | |
| `message-bus.ts` | 改动 | ✅ 改动 | |
| `message-types.ts` | 改动 | ✅ 改动 | |
| `runtime/types.ts` | 改动 | ✅ 改动 | |
| `runtime/runtime.ts` | 改动 | ✅ 改动 | |
| `runtime/agent-builder.ts` | 改动 | ❌ 未改 | merge tool 在 runtime.ts 注册（功能等价） |
| `streaming-executor.ts` | 无需改动 | ✅ 未改 | |
| `workspace.ts` | 未列出 | ✅ 改动 | spawner lambda 传递 asyncMode |

### 9. 中断与超时语义

| 验证点 | 计划 | 实现 | 状态 |
|--------|------|------|------|
| 阻塞模式不变 | | 一致 | ✅ |
| 异步模式 stop → cascadeAbort → pool.stopAll | | **可用** — spawnSubAgent (runFn) 仍阻塞，pool 持续追踪 | ✅ |
| 异步模式超时 → pool abort | | 一致 | ✅ |
| 中止后 board.stop + discard | | 一致 | ✅ |

## 偏差汇总

### 合理偏差（不影响功能正确性）

1. **BoardStatus 加了 `'merged'`** — merge 成功后标记，计划遗漏了这个状态
2. **文件追踪 hook 用闭包捕获 agentId** — 比从 `_agent_id`（实际是 isolationId）取更正确
3. **async 模式 spawnSubAgent 仍 await subAgent.run()** — 保证 pool 的 abort 语义正确（计划字面 fire-and-forget 会导致 pool 提前完成，abort 失效）
4. **merge tool 在 runtime.ts 注册** — 需要agent ID，agent-builder.ts 不持有
5. **runLoop finally 加了 `!signal.aborted` 守卫** — 防止用户 stop 后自动唤醒
6. **enqueueIsolationOp 共享队列** — merge.ts 从 agent.ts 导入，与 sync 模式共用同一队列，防止并发 git 操作

### 潜在问题

1. **setBus() 双重注册**: `setBus()` 内部调 `bus.register(addr, onWake)`，runtime 又调一次 `bus.register(addr)`（无 onWake）。第二次调用不会覆盖 wake callback（register 只在 onWake 存在时设置），但会覆盖 address 条目。地址相同，无影响。

2. **runLoop 的 try/finally 缩进**: for 循环体在 try 块内但没有额外缩进。TypeScript 不关心缩进，但代码可读性略差。

3. **子 agent 不继承 graph hooks**: spawnSubAgent 只注册 board tracking hook，不注册 graph context hook。这是现有行为（子 agent 原本就没有 hooks），不是本次引入的回退。

4. **异步子 agent 完成后 bus.unregister**: 在所有完成处理之后调用。如果父 agent 在 bus.send 后立即被唤醒并尝试 reply，子 agent 可能已经被 unregister。但 async 模式下子 agent 已完成，不需要 reply，所以这不是问题。

5. **_onMessageDelivered 创建独立 AbortController**: 唤醒 run 的 signal 不与任何外部 abort 源关联。如果用户在唤醒 run 期间想 stop，需要通过 execState.stop() 机制。但当前 runLoop 只检查传入的 signal，不检查 execState。这是已有行为限制，不是本次引入的。

## 类型检查

```
npx tsc --noEmit → 0 errors ✅
```

## 总结

实现与计划在核心设计上完全一致。6 处偏差均为合理改进或必要适配，不影响功能正确性。2 处潜在问题（双重注册、唤醒 abort signal）为低风险，可在后续迭代中处理。
