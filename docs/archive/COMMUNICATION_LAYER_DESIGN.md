# HoloGram 多 Agent 通信层设计方案

## 1. 设计目标

构建一个**拓扑无关、格式无关**的通信层基础设施，作为 HoloGram 多 Agent 体系的坚实底座。

### 硬性约束

| 约束 | 含义 |
|------|------|
| 拓扑无关 | 通信层不假设谁能跟谁说话，拓扑是上层策略 |
| 格式无关 | 消息 payload 类型为 `unknown`，文本/结构化/二进制都能传 |
| 异步优先 | Phase 1 只做异步 send（发完即走）；同步 request 需要 runLoop 原生支持"等待消息"中断点，放到 Phase 2+ |
| 可持久化 | 消息可持久化、可回放，与现有 AgentStore 体系打通 |
| 背压控制 | 每个 agent 有有界 inbox，满了不会 OOM |
| 故障隔离 | 一个 agent 崩溃不影响其他 agent 的通信通道 |
| 可传输替换 | 当前进程内，未来可换跨进程/跨机器 |

> **Phase 1 不包含 `agent_request` / `bus.request()`**。原因：`StreamingToolExecutor` 并发执行 tool calls，一个阻塞的 request 会挂起整个 executor。更致命的是目标 agent 在 runLoop 中等待 LLM stream，不会检查 inbox，形成活锁。同步请求需要 agent runLoop 原生支持"等待消息"中断点，这是 Phase 4 的工作。

---

## 2. 核心抽象

### 2.1 AgentAddress — 身份与路由

```typescript
interface AgentAddress {
  /** agentId 在 runtime 内唯一 */
  agentId: string;
  /** parentId 用于拓扑策略判断（树形） */
  parentId: string | null;
  /** subagentDepth 用于深度限制 */
  depth: number;
}
```

不需要新类型——现有的 `AgentHandle.id` / `parentId` / `subagentDepth` 已经够用。通信层直接引用这些字段。

### 2.2 AgentMessage — 消息信封

```typescript
interface AgentMessage {
  /** 唯一 ID，用于去重和回复关联 */
  id: string;
  /** 发送者 agentId */
  from: string;
  /** 接收者 agentId，或 'broadcast' 表示广播 */
  to: string;
  /** 消息类型，用于订阅过滤（如 'question', 'result', 'status', 'notification'） */
  type: string;
  /** 消息内容，类型不限 */
  payload: unknown;
  /** 时间戳 */
  ts: number;
  /** 如果是回复某条消息，关联原消息 ID */
  replyTo?: string;
  /** 扩展元数据 */
  meta?: Record<string, unknown>;
}
```

### 2.3 MessageFilter — 订阅过滤

```typescript
interface MessageFilter {
  from?: string;              // 仅匹配特定发送者
  to?: string;               // 仅匹配特定接收者
  type?: string | string[];  // 仅匹配特定消息类型
  /** 自定义谓词，最终决定是否匹配 */
  predicate?: (msg: AgentMessage) => boolean;
}
```

### 2.4 MessageBus — 通信总线（核心）

```typescript
class MessageBus {
  // ── 注册 ──
  /** Agent 创建时注册到总线 */
  register(addr: AgentAddress): void;
  /** Agent 销毁时注销 */
  unregister(agentId: string): void;

  // ── 通信原语（Phase 1: 仅异步） ──
  /** 异步发送：发完即走，不等待回复。返回消息 ID */
  send(msg: Omit<AgentMessage, 'id' | 'ts' | 'from'> & { from: string }): string;
  /** 回复某条消息 — 回复消息的 replyTo 自动设为 originalMsgId。
   *  callerId = 回复者的 agentId（只搜自己的 inbox 找原消息） */
  reply(callerId: string, originalMsgId: string, payload: unknown, meta?: Record<string, unknown>): string;
  /** 广播：当前 scope 内所有 agent 收到（受拓扑策略限制） */
  broadcast(from: string, type: string, payload: unknown, meta?: Record<string, unknown>): string[];

  // ── 订阅 ──
  /** 订阅消息流，返回取消订阅函数 */
  subscribe(filter: MessageFilter, handler: (msg: AgentMessage) => void): () => void;

  // ── Inbox ──
  /** 获取 agent 的未读消息（不消费） */
  peekInbox(agentId: string): AgentMessage[];
  /** 确认消息已处理 — 从 inbox 移除 */
  ackMessage(agentId: string, msgId: string): boolean;
  /** 获取未读消息数量 */
  unreadCount(agentId: string): number;

  // ── 拓扑策略 ──
  /** 设置拓扑策略（默认 tree） */
  setTopology(policy: TopologyPolicy): void;

  // ── 持久化（Phase 1: no-op；Phase 2 实现） ──
  /** 持久化当前状态。Phase 1 中 store=null 时为 no-op */
  flush(): Promise<void>;
  /** 从持久化恢复。Phase 1 中 store=null 时为 no-op */
  restore(): Promise<void>;
}
```

> **Phase 2 预留**：`request()` / `isDeadlocked()` / 等待图。Phase 1 不实现这些，
> 但 MessageBus 接口设计已为它们留出扩展空间。详见 Phase 4。

### 2.5 TopologyPolicy — 拓扑策略

```typescript
interface TopologyPolicy {
  /** 判断 from→to 的消息是否允许通过 */
  canSend(from: string, to: string, bus: { getAgent: (id: string) => AgentAddress | undefined }): boolean;
  /** 返回允许的通信目标列表（供工具描述使用） */
  allowedTargets(agentId: string, bus: { listAgents: () => AgentAddress[] }): string[];
}
```

内置实现：

```typescript
// 树形拓扑：只有 parent↔child 能通信
class TreeTopology implements TopologyPolicy { ... }

// 星形拓扑：只有 center↔spoke 能通信
class StarTopology implements TopologyPolicy { ... }

// 网状拓扑：任意两个 agent 都能通信
class MeshTopology implements TopologyPolicy { ... }
```

默认使用 `TreeTopology`，与现有行为兼容。

### 2.6 Backpressure — 背压策略

```typescript
type BackpressureStrategy = 'block' | 'drop' | 'reject';

// 每个 agent 的 inbox 有容量上限
const DEFAULT_INBOX_CAPACITY = 100;
// 默认策略：reject — 发送方收到错误，不会静默丢消息
const DEFAULT_BACKPRESSURE: BackpressureStrategy = 'reject';
```

- `reject`（默认）: 返回错误给发送方，发送方可决定重试或放弃
- `block`: 发送方等待（仅适用于同步 request）
- `drop`: 丢弃最旧的消息（仅在显式配置时启用，如日志类消息）

### 2.7 消息去重

```typescript
class MessageBus {
  // LRU 去重窗口 — 保留最近 N 条消息 ID
  private seenIds = new Set<string>();
  private seenIdOrder: string[] = [];
  private static readonly DEDUP_WINDOW = 500; // 保留最近 500 条消息 ID
  private static readonly DEDUP_TTL_MS = 5 * 60 * 1000; // 5 分钟 TTL
  private seenIdTs = new Map<string, number>(); // ID → 入队时间戳
}
```

去重流程：send() 时检查 `seenIds`，若已存在且未过 TTL → 跳过投递，返回原 msgId。
超过 DEDUP_WINDOW 时淘汰最旧条目。

---

## 3. 与现有系统的集成

### 3.1 注入路径

```
AgentRuntime
  └── 持有 MessageBus 实例（构造时创建，全局单例）
       ├── createAgent() 时：
       │     1. buildToolRegistry({ messageBus: bus }) → 工具闭包捕获 bus
       │     2. new Agent(..., { messageBus: bus }) → Agent 持有 bus
       │     3. bus.register(agentAddr)
       └── destroyAgent() 时 bus.unregister(agentId)

Agent.spawnSubAgent()
  └── 子 Agent 创建后立即 setBus(this._bus)
       └── 如果父有 bus，子 agent 自动获得同一 bus 引用
       └── bus.register(childAddr)
```

**关键修复**：子 Agent 通过 `spawnSubAgent()` 创建，**不走** `AgentRuntime.createAgent()`。
因此必须在 `spawnSubAgent()` 中显式注入：

```typescript
// agent.ts — spawnSubAgent() 中
const subAgent = new Agent(...);
if (this._bus) {
  subAgent.setBus(this._bus);
  this._bus.register({
    agentId: subAgent.id,
    parentId: this.id,
    depth: this._subagentDepth + 1,
  });
}
```

**AgentConfig + AgentOptions 都需要新增字段**：

```typescript
// runtime/types.ts — AgentConfig
interface AgentConfig {
  // ... 现有字段 ...
  /** 通信总线（可选 — 无则为 headless 无通信能力） */
  messageBus?: MessageBus;
}

// agent.ts — AgentOptions（Agent 构造函数收的参数）
interface AgentOptions {
  // ... 现有字段 ...
  /** 通信总线（可选） */
  messageBus?: MessageBus;
}
```

**循环依赖解决**：通信工具在 `buildToolRegistry()` 中注册，闭包捕获 bus 引用（不是 agent 引用）。
bus 在 Runtime 构造时已创建，工具注册时 bus 已就绪。Agent 构造时 tools 已包含通信工具，同时 AgentOptions 传入 bus。
两者都引用同一个 bus 实例，不存在循环。

`Agent` 类新增字段：

```typescript
class Agent {
  private _bus: MessageBus | null = null;
  
  setBus(bus: MessageBus): void { this._bus = bus; }
  
  // runLoop() 中每轮 stream 前调用
  // 非破坏式：只 peek，不 drain。消息保留在 inbox 直到被 ack
  private _injectInbox(): void {
    if (!this._bus) return;
    const msgs = this._bus.peekInbox(this.id);
    if (msgs.length === 0) return;
    // 暴露消息 ID，让 LLM 可以通过 agent_reply 回复
    const formatted = msgs.map(m => 
      `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`
    ).join('\n\n');
    this._insertPending(`<system-reminder>\n📬 Agent 消息 (${msgs.length} 条未读):\n${formatted}\n\n可用 agent_reply 工具回复，或 agent_ack 确认已读。\n</system-reminder>`);
  }
}
```

### 3.2 现有 drain_bg_notifications 的关系

现有机制：
```
Rust 后台任务 → COMPLETED_NOTES 静态队列 → drain_bg_notifications() → <system-reminder>
```

通信层是它的**超集**：
- 现有 `drain_bg_notifications` = bus.broadcast(type='bg_notification') 的特化
- 通信层 inbox 注入复用同样的 `<system-reminder>` 路径
- 短期内两者并存，逐步迁移

### 3.3 与 SubAgentPool 的关系

`SubAgentPool` 继续管理并发/超时/中断，**不变**。

通信层是正交的新维度：
- `agent_spawn` 创建子 agent → `spawnSubAgent()` 中 `bus.register(child)`
- 子 agent 完成 → `bus.unregister(child)`（或保持注册以便 resume）
- 父 agent 可在子 agent 运行期间通过 bus 发消息（如果拓扑允许）

### 3.4 与 EventSink 的关系

```
EventSink = Agent → UI 的事件流（单向，渲染用）
MessageBus = Agent ↔ Agent 的消息通道（双向，协作用）
```

两者完全正交，不互相依赖。MessageBus 可选地通过 `RuntimeNotifier` 把消息事件也推给 UI（用于显示消息流），但这不是必须的。

### 3.5 消息生命周期（ack 模型）

```
发送方 send() → inbox [未读]
                      ↓
runLoop _injectInbox() → <system-reminder> 注入 [仍未读]
                      ↓
LLM 看到 system-reminder，决定:
  ├─ agent_reply(msg_id, content) → 回复 + 自动 ack(msg_id) → inbox 移除
  ├─ agent_ack(msg_id)            → 确认已读 → inbox 移除
  └─ 忽略                          → 消息保留在 inbox，下轮再次注入
```

**关键**：消息不因注入而消失。只有显式 ack（或 reply 时自动 ack）才从 inbox 移除。
这避免了"LLM 没处理的消息直接消失"的问题。

### 3.6 同步 request() 与死锁检测（Phase 4，暂不实现）

Phase 1 不包含 `request()`。当 Phase 4 实现 `request()` 时，需要：
- 等待图 (`waitForGraph`) + `isDeadlocked()` 检测
- agent runLoop 原生支持"等待消息"中断点（不阻塞 StreamingToolExecutor）
- 死锁时 throw `DeadlockError`，LLM 工具层捕获并返回给模型

### 3.7 broadcast 与拓扑策略

```typescript
broadcast(from: string, type: string, payload: unknown): string[] {
  // 返回实际投递成功的 agentId 列表
  const delivered: string[] = [];
  for (const [agentId, addr] of this.agents) {
    if (agentId === from) continue;
    // 拓扑策略检查：from → agentId 是否允许
    if (this.topology.canSend(from, agentId, this)) {
      this._deliverToInbox(agentId, msg);
      delivered.push(agentId);
    }
    // 不允许的 agent 被静默跳过（不 throw）
  }
  return delivered;
}
```

**语义**：broadcast 受拓扑限制。TreeTopology 下，agent 只能广播给其直接子 agent。
MeshTopology 下，广播给所有 agent。返回值让发送方知道谁收到了。

---

## 4. 新增 LLM 工具

> Phase 1 提供 5 个工具。`agent_request`（同步请求）推迟到 Phase 2+。

### 4.1 agent_message — 异步消息

```typescript
{
  name: 'agent_message',
  description: 'Send a message to another agent. Fire-and-forget — does not wait for a reply.',
  parameters: {
    target: { type: 'string', description: 'Target agent ID' },
    type: { type: 'string', description: 'Message type (e.g. "question", "status", "handoff")' },
    content: { type: 'string', description: 'Message content' },
  },
}
// 错误处理：拓扑拒绝/agent不存在/inbox满 → 返回错误字符串给模型
// 示例错误返回: "Failed to send: agent 'xxx' not found" 
//             或 "Failed to send: inbox full (reject strategy)"
//             或 "Failed to send: topology denied"
```

### 4.2 agent_reply — 回复消息（关键）

```typescript
{
  name: 'agent_reply',
  description: 'Reply to a message received in your inbox. The message_id comes from the <system-reminder> inbox notification. Replying also ACKs the original message.',
  parameters: {
    message_id: { type: 'string', description: 'ID of the message to reply to (from inbox notification)' },
    content: { type: 'string', description: 'Reply content' },
  },
}
// 回复流程：
// 1. bus.reply(this.id, message_id, content)
//    → 在自己的 inbox 中查找原消息（O(1) via msgIdIndex）
//    → 构造 replyTo=message_id 的新消息，投递到原发送者 inbox
//    → 从自己 inbox 移除原消息（自动 ack）
// 2. 如果原发送方在 Phase 2 的 request() 中等待，reply 会触发其 resolve()
```

### 4.3 agent_ack — 确认已读

```typescript
{
  name: 'agent_ack',
  description: 'Acknowledge a message as read/processed. Removes it from your inbox so it is not shown again.',
  parameters: {
    message_id: { type: 'string', description: 'ID of the message to acknowledge' },
  },
}
```

### 4.4 agent_inbox — 查看未读消息

```typescript
{
  name: 'agent_inbox',
  description: 'List unread messages in your inbox. Messages include ID, sender, type, and content. Use agent_reply to respond or agent_ack to dismiss.',
  parameters: {},
}
// 返回格式：每条消息一行，包含 msg_id, from, type, payload
```

### 4.5 agent_list — 列出可通信的 agent

```typescript
{
  name: 'agent_list',
  description: 'List all agents you can communicate with, based on the current topology.',
  parameters: {},
}
// 调用 bus.topology.allowedTargets(this.id, bus)
// 返回 agentId + description 列表
```

### 4.6 agent_request — 同步请求（Phase 2+，暂不实现）

```typescript
// Phase 2+ 预留：需要 agent runLoop 原生支持"等待消息"中断点
// 当前 StreamingToolExecutor 并发执行 tool calls，阻塞 request 会挂起整个 executor
```

---

## 5. 实现计划

### Phase 1: 核心通信层 ✅ 已落地

**新增文件：**

| 文件 | 职责 |
|------|------|
| `src-ui/src/agent/message-bus.ts` | MessageBus 核心实现 |
| `src-ui/src/agent/message-types.ts` | AgentMessage, MessageFilter, TopologyPolicy, BackpressureStrategy 等类型 + 错误类型 |
| `src-ui/src/agent/topology.ts` | TreeTopology / MeshTopology 等策略实现 |
| `src-ui/src/agent/tools/communication.ts` | agent_message / agent_reply / agent_ack / agent_inbox / agent_list 五个工具 |

**改动文件：**

| 文件 | 改动 |
|------|------|
| `src-ui/src/agent/runtime/types.ts` | `AgentConfig` 新增 `messageBus?: MessageBus` |
| `src-ui/src/agent/agent.ts` | `AgentOptions` 新增 `messageBus?: MessageBus`；新增 `_bus` 字段 + `setBus()` + `_injectInbox()` |
| `src-ui/src/agent/runtime/runtime.ts` | `createAgent()` 中：先确保 bus → 注册通信工具到 ToolRegistry → 再 new Agent；`destroyAgent()` 时 `bus.unregister()` |
| `src-ui/src/agent/runtime/agent-builder.ts` | `buildToolRegistry()` 新增参数接收 bus，条件注册通信工具 |

**循环依赖解决（#9）：**

```
createAgent(config) {
  // 1. 确保 bus 存在（runtime 持有全局 bus 实例）
  const bus = this._bus;  // MessageBus 在 Runtime 构造时创建

  // 2. 先构建 ToolRegistry，传入 bus 引用
  //    通信工具在 execute 时才从闭包捕获的 bus 取值，此时 bus 已就绪
  const tools = buildToolRegistry({
    ...,
    messageBus: bus,  // 传给 builder，注册通信工具
  });

  // 3. 再 new Agent（此时 tools 已包含通信工具）
  const agent = new Agent(provider, tools, systemPrompt, {
    ...,
    messageBus: bus,  // 也传给 AgentOptions
  });

  // 4. 注册 agent 到 bus
  bus.register({ agentId: agent.id, parentId: config.parentId, depth: config.subagentDepth ?? 0 });

  return handle;
}
```

通信工具的闭包捕获 bus 引用而非 agent 引用，不存在"工具需要 agent → agent 需要工具"的循环。

### 异步编排层（Phase 1.5 — 已落地）

在 Phase 1 和 Phase 2 之间，落地了异步编排层（详见 `async-spawn-taskboard-merge-bus-wakeup.md`）：

- 非阻塞 spawn（`async: true` 参数）
- TaskBoard 共享状态区（文件追踪、diff 保全）
- agent_merge 统一合并工具
- Bus 唤醒机制（idle agent 收到消息自动启动 runLoop）
- AgentLifecycleManager（全局空闲判定 + 泄漏检测 + worktree TTL 30min）
- isolation-queue（git 操作串行化）

### Phase 2: 持久化与崩溃恢复 ✅ 已落地

- JsonMessageStore — inbox 持久化到 `.hologram/agents/{id}/inbox.json`
- MessageBus debounced flush（2 秒批量写入）
- TaskBoard 持久化（`.hologram/taskboard.json`）
- 启动恢复（restore inbox + restore board + 孤儿检测）
- 孤儿 worktree 清理（崩溃时 running 的子 agent → stop + discard）
- destroyAgent 先 clearFlushTimer 再 flush 落盘
- `AgentRuntime.ready()` 防 restore 竞态

### Phase 3: 系统提示词适配 + 可观测性 UI ✅ 已落地

- `buildSystemPrompt()` 加多 Agent 协作指南（async spawn / merge / 通信 / 决策指南）
- AgentPanelStore — agents / taskBoard / messageFlow / alerts 单一数据源
- AgentsPanel React 组件（Agent 树 / TaskBoard 表格 / 消息流 / 告警）
- RuntimeNotifier.onAgentStatus — Agent runLoop 状态推送到面板
- RuntimeNotifier.onLifecycleAlert — LifecycleManager 告警推送到面板
- DockPanelId 加 'agents' + 面板注册

### Phase 4: 协作能力（未开始）

- 同步请求（`agent_request` + runLoop 等待中断点 + 死锁检测）
- 拓扑扩展（兄弟 agent 直接通信、DAG 拓扑）
- 共享发现区（Agent 间共享中间发现，避免重复探索）

### Phase 5: 高级能力（未开始）

- 订阅式协作（pub/sub topic）
- 消息转换/过滤管道
- 跨进程传输（IPC / WebSocket）

---

## 6. 详细设计：MessageBus 实现

### 6.1 数据结构

```typescript
class MessageBus {
  // 注册的 agent 地址表
  private agents = new Map<string, AgentAddress>();
  
  // 每个 agent 的 inbox（有界队列）— 消息保留直到被 ack
  private inboxes = new Map<string, AgentMessage[]>();
  
  // 消息索引：msgId → { agentId, index } — O(1) 查找，避免遍历所有 inbox
  private msgIndex = new Map<string, { agentId: string; index: number }>();
  
  // 订阅者列表
  private subscribers = new Array<{
    filter: MessageFilter;
    handler: (msg: AgentMessage) => void;
  }>();
  
  // 拓扑策略
  private topology: TopologyPolicy = new TreeTopology();
  
  // 持久化后端（Phase 1: null → flush/restore 为 no-op）
  private store: MessageStore | null = null;
  
  // 背压
  private inboxCapacity = 100;
  private backpressureStrategy: BackpressureStrategy = 'reject';
  
  // 去重
  private seenIds = new Set<string>();
  private seenIdOrder: string[] = [];
  private seenIdTs = new Map<string, number>();
  
  // Phase 4 预留（暂不实现）：
  // private waitForGraph = new Map<string, Set<string>>();
  // private pendingRequests = new Map<string, { resolve, timer }>();
}

// 自定义错误类型
class TopologyDeniedError extends Error { ... }
class AgentNotFoundError extends Error { ... }
class InboxFullError extends Error { ... }
class MessageNotFoundError extends Error { ... }
// Phase 4: class DeadlockError extends Error { ... }
// Phase 4: class RequestTimeoutError extends Error { ... }
```

### 6.2 send() 流程

```
1. 构造完整 AgentMessage（生成 id + ts）
2. 去重检查：seenIds 中已存在且未过 TTL？
   - 是 → 跳过投递，返回原 msgId（幂等）
3. 拓扑策略检查：canSend(from, to) ?
   - 否 → throw TopologyDeniedError
4. 查找目标 agent 的 inbox
   - 不存在 → throw AgentNotFoundError
5. 检查 inbox 容量
   - 满 → 按 backpressureStrategy 处理：
     - reject（默认）→ throw InboxFullError
     - drop → 移除最旧消息（同时移除其 msgIndex 条目），腾出空间
     - block → 等待（仅同步 request 场景，Phase 2+）
6. 推入 inbox，记录 msgIndex[msgId] = { agentId: to, index }
7. 记录 seenIds
8. 通知匹配的订阅者
9. （如果有 store）异步持久化
10. 返回 msgId
```

**错误传播到 LLM**：所有工具层 catch 异常并返回错误字符串：
```typescript
// communication.ts 工具 execute()
try {
  const msgId = bus.send({ ... });
  return `Message sent (id: ${msgId})`;
} catch (e) {
  if (e instanceof TopologyDeniedError) return `Failed: topology denied — you cannot send to '${target}'`;
  if (e instanceof AgentNotFoundError) return `Failed: agent '${target}' not found`;
  if (e instanceof InboxFullError) return `Failed: inbox full for '${target}' (capacity exceeded)`;
  return `Failed: ${e.message}`;
}
```

### 6.3 reply() 流程

```
1. 在 callerId 的 inbox 中查找原消息（O(1) via msgIndex[originalMsgId]）
   - msgIndex 中不存在 → throw MessageNotFoundError（可能已 ack 或已过期）
   - msgIndex 指向的 agentId ≠ callerId → throw MessageNotFoundError（不能回复别人的消息）
2. 构造回复消息：
   - from = callerId
   - to = 原消息.from
   - replyTo = originalMsgId
   - 新生成 id + ts
3. 从 callerId 的 inbox 移除原消息（自动 ack）+ 清理 msgIndex
4. 投递回复消息到原发送者的 inbox（走 send() 流程，含拓扑检查 + msgIndex 记录）
5. 返回新消息 ID
```

### 6.4 ackMessage() 流程

```
1. 在 msgIndex 中查找 msgId
   - 不存在 → 返回 false（可能已 ack 或不存在）
2. 在 agentId 的 inbox 中按 index 移除消息
3. 清理 msgIndex[msgId]
4. 返回 true
```

### 6.5 Agent.runLoop() 集成

```
现有 runLoop 每轮迭代:
  abort check
  → applyPendingInserts/memory
  → drainBgNotifications        ← 现有
  → _injectInbox() (新增)        ← peek 未读消息，注入 system-reminder（不消费）
  → stream()
  → store assistant turn
  → collect tool results
  → storm-breaker check
  → compaction check
  → loop
```

**关键**：`_injectInbox()` 只 peek 不消费。
消息保留在 inbox 中直到 LLM 显式 ack 或 reply。
如果 LLM 忽略了某条消息，它会在下一轮再次出现在 system-reminder 中。

---

## 7. 验证计划

### 单元测试

| 测试 | 验证点 |
|------|--------|
| `test_message_bus_send_receive` | 基本发送 + peekInbox 接收 + msgIndex 正确 |
| `test_message_bus_broadcast` | 广播到所有拓扑允许的 agent，返回投递列表 |
| `test_message_bus_reply` | reply 后原消息从 inbox 移除 + 回复投递到原发送者 |
| `test_reply_wrong_agent` | agent A 不能 reply 发给 agent B 的消息 → MessageNotFoundError |
| `test_message_bus_ack` | ack 后从 inbox 移除；ack 不存在的 msgId → 返回 false |
| `test_inbox_peek_does_not_consume` | peekInbox 后消息仍在 inbox，下一轮仍注入 |
| `test_topology_tree` | 树形拓扑：parent↔child 允许，sibling↔sibling 拒绝 |
| `test_topology_mesh` | 网状拓扑：任意通信允许 |
| `test_topology_broadcast_respects` | broadcast 在 TreeTopology 下只投递给子 agent |
| `test_backpressure_reject` | inbox 满时抛 InboxFullError，消息不入队 |
| `test_backpressure_drop` | inbox 满时丢弃最旧消息（仅显式配置时）+ 清理 msgIndex |
| `test_agent_unregister` | 注销后消息不送达 |
| `test_dedup` | 相同 msgId 在 TTL 内不重复投递 |
| `test_dedup_ttl_expiry` | TTL 过期后相同 msgId 可再次投递 |
| `test_flush_noop_without_store` | store=null 时 flush()/restore() 为 no-op |
| `test_subscribe_unsubscribe` | 订阅 + 取消订阅 + 过滤 |
| `test_error_propagation` | 拓扑拒绝/agent不存在/inbox满 → 工具层返回错误字符串 |

### 集成测试

| 测试 | 验证点 |
|------|--------|
| `test_agent_message_tool` | LLM 通过 agent_message 工具发送消息 |
| `test_inbox_drain_in_runloop` | 消息在 runLoop 中自动注入为 system-reminder |
| `test_parent_child_communication` | 父子 agent 通过 bus 通信 |

---

## 8. 已解决问题（v3 修订）

### v2 → v3 修复

| # | 问题 | 解决方案 |
|---|------|---------|
| 9 | request() 阻塞语义与 StreamingToolExecutor 冲突 | Phase 1 砍掉 `agent_request`；同步请求需 runLoop 原生中断点，Phase 4 |
| 10 | reply() 全局搜索 inbox O(n) | 只搜 caller 自己的 inbox + 维护 `msgIndex: Map<msgId, {agentId, index}>` O(1) |
| 11 | 6.3 和 6.4 节重复 | 合并为单一 reply() 流程 |
| 12 | 实现清单缺 agent_reply / agent_ack | 文件清单更新为 5 个工具 |
| 13 | AgentOptions 也需要加 messageBus | AgentConfig + AgentOptions 都新增 `messageBus?: MessageBus` |
| 14 | Phase 1 无持久化时 flush/restore 行为未定义 | 明确为 no-op（store=null） |
| 15 | 消息堆积无自动清理 | Phase 2 加超时自动 ack（10 分钟未读 → 自动清理 + warning） |
| 16 | _injectInbox / _drainInbox 命名不一致 | 统一为 `_injectInbox()` |
| 17 | 通信工具注册循环依赖 | buildToolRegistry 传入 bus 引用（非 agent）；工具闭包捕获 bus，不捕获 agent |

### v1 → v2 修复

| # | 问题 | 解决方案 |
|---|------|---------|
| 1 | LLM 工具层缺少 reply 机制 | 新增 `agent_reply` 工具 + `agent_ack` 工具；inbox 注入暴露 `msg_id` |
| 2 | 子 Agent 拿不到 MessageBus | `spawnSubAgent()` 中显式 `setBus()` + `bus.register()` |
| 3 | drainInbox 消费式清空导致消息丢失 | 改为 peek + ack 模型；消息保留直到显式 ack/reply |
| 4 | request() 潜在死锁 | Phase 4 实现时需等待图 + 死锁检测（Phase 1 不含 request） |
| 5 | broadcast 与拓扑策略语义冲突 | broadcast 受拓扑限制，返回实际投递列表 |
| 6 | 默认背压策略 drop 危险 | 默认改为 `reject`，发送方收到错误 |
| 7 | 消息去重机制未定义 | LRU 去重窗口 (500 条, 5 分钟 TTL) |
| 8 | 拓扑拒绝的错误传播 | 工具层 catch 异常 → 返回错误字符串给模型 |

## 9. 开放问题

1. **子 agent 运行期间的通信**：✅ 已解决（异步编排层）。`agent_spawn` 支持 `async: true`，父 agent spawn 后立即继续，子 agent 完成后通过 bus 发 `type: 'result'` 消息通知父 agent。详见 `async-spawn-taskboard-merge-bus-wakeup.md`。

2. **消息与 agent_spawn 的关系**：`agent_message` 工具与 `agent_spawn` 工具的差异——spawn 创建一个新 agent 并给它任务，message 给已存在的 agent 发消息。两者互补，不替代。

3. **消息格式**：payload 为 `unknown`，但 LLM 工具层只能处理 string。工具层将 payload 序列化为 string，bus 内部可传结构化对象。后续可加 schema 验证。

4. **UI 渲染**：✅ 已解决（Phase 3）。消息流通过 `MessageBus.subscribe` 推送到 `agent-panel-store`，在 AgentsPanel 中渲染。Agent 状态通过 `RuntimeNotifier.onAgentStatus` 推送。

5. **安全**：拓扑策略是第一道防线。后续可加消息内容审查（类似 Claude Code 的 subagent output scanning）。

6. **消息堆积风险**：如果 agent 长时间不 ack，消息会持续堆积在 inbox 中。inbox 容量上限（reject 策略）阻止无限增长。LifecycleManager 的泄漏检测 + TTL 清理提供兜底。如需更精细的自动 ack，可在 Phase 4 中加超时清理。

7. **同步 request（Phase 4）**：实现 `agent_request` 需要 agent runLoop 原生支持"等待消息"中断点——不阻塞 StreamingToolExecutor，而是在 runLoop 中 yield 等待 inbox 中的 reply。同时需要死锁检测（等待图）。
