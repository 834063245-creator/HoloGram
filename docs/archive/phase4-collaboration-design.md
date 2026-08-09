# Phase 4：Agent 协作能力设计方案

> 创建：2026-07-24
> 状态：设计稿（待确认）
> 前置：Phase 1-3 已落地，隔离层鲁棒性已修复

## 1. 背景与目标

Phase 1-3 落地了通信层（MessageBus）、异步编排（async spawn + TaskBoard + merge）、持久化恢复、系统提示词适配和可观测性 UI。实际运行验证了 spawn → merge 全链路可用。

Phase 4 聚焦**协作能力**——让多个 Agent 从"各自干活"进化到"协同工作"。

### 调研结论

对比了 kimi-code、DeepSeek-Reasonix 两个成熟实现 + AutoGen/LangGraph/Erlang 的模式：

| 问题 | kimi-code | Reasonix | 工业界共识 |
|------|-----------|----------|-----------|
| Agent 间直接通信 | ❌ 靠返回值 | ❌ 靠返回值 + context | 很少做 |
| 死锁检测 | ❌ | ❌ | 不做，timeout 兜底 |
| 拓扑 | 纯树形 | 纯树形 | 树形足够 |
| 共享发现 | ❌ | ❌ | 少见但有用 |
| Rate limit 调度 | ✅ AgentRunBatch | ❌ | kimi-code 最成熟 |
| 深度限制 | max depth 2 | max depth 2 | 必须有 |

**HoloGram 已有而它们没有的**：MessageBus（直接通信能力）、TaskBoard（共享状态）、多拓扑策略、可观测性 UI。

### Phase 4 范围调整

基于调研，对原计划做了调整：

| 原计划 | 调整 | 理由 |
|--------|------|------|
| 同步请求 + 死锁检测 | 同步请求 + **timeout 兜底**（不做死锁检测） | 两个产品都不做死锁检测，timeout 是工业标准 |
| DAG 拓扑 | **推迟到 Phase 5** | 两个产品都只用树形，DAG 非刚需 |
| 共享发现区 | **保留，优先做** | 差异化功能，避免并行子 Agent 重复探索 |
| 深度限制 | **已有**（MAX_SUBAGENT_DEPTH=3）✅ | 无需额外工作 |
| —（新增）| **Rate limit 退避调度** | kimi-code 有，HoloGram 缺失，影响实际使用 |

---

## 2. 同步请求（agent_request）

### 2.1 设计

`agent_request` 工具——Agent A 向 Agent B 发请求并**阻塞等待回复**。基于现有 MessageBus 的 send + subscribe 实现，不修改 runLoop。

**核心机制**：

```
Agent A 调 agent_request(target=B, type="question", content="auth 逻辑在哪?")
  → bus.send({ from: A, to: B, type: "request", payload: content, meta: { requestId } })
  → 同时 bus.subscribe({ replyTo: requestId }, handler) — 等待回复
  → Promise.race([replyPromise, timeoutPromise])
  → B 收到消息后（通过 _injectInbox 注入），用 agent_reply 回复
  → bus.reply 触发 replyTo 匹配的 subscribe handler
  → resolve(replyPayload) 或 reject(timeout)
```

**不做**：
- ❌ wait-for graph 死锁检测
- ❌ runLoop 中断点（不修改 runLoop 结构）
- ❌ `block` 背压策略

**为什么不做死锁检测**：
1. kimi-code 和 Reasonix 都不做
2. Erlang gen_server 用 timeout 兜底，40 年验证可靠
3. 死锁场景（A 等 B，B 等 A）会自然 timeout，LLM 收到错误后自行处理
4. wait-for graph 维护成本高，每次 send/reply 都要更新图

### 2.2 工具 schema

```typescript
{
  name: 'agent_request',
  description: 'Send a synchronous request to another agent and wait for a reply. ' +
    'Blocks until the target agent replies or timeout expires. ' +
    'Use agent_message for fire-and-forget; use agent_request when you need a direct answer.',
  parameters: {
    target: { type: 'string', description: 'Target agent ID' },
    type: { type: 'string', description: 'Request type (e.g. "question", "lookup", "verify")' },
    content: { type: 'string', description: 'Request content' },
    timeout_seconds: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' },
  },
}
```

### 2.3 实现

新增文件：`src-ui/src/agent/tools/request.ts`

```typescript
export function createRequestTool(bus: MessageBus, getAgentId: () => string): Tool {
  return {
    name: () => 'agent_request',
    // ... schema ...
    readOnly: () => false, // 阻塞工具，不算只读
    execute: async (args) => {
      const target = args.target as string;
      const type = args.type as string;
      const content = args.content as string;
      const timeoutSec = Math.min(args.timeout_seconds ?? 30, 120);
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const from = getAgentId();

      // 拓扑检查
      if (!bus.canSend(from, target)) {
        return `Failed: topology denied — you cannot request from '${target}'`;
      }

      // 发送请求消息
      const msgId = bus.send({
        from,
        to: target,
        type: 'request',
        payload: content,
        meta: { requestId },
      });

      // 等待回复 — subscribe 匹配 replyTo = msgId
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          unsub();
          resolve(`请求超时（${timeoutSec}s）— ${target} 未在时限内回复。消息仍在对方 inbox 中。`);
        }, timeoutSec * 1000);

        const unsub = bus.subscribe(
          { to: from, predicate: (msg) => msg.replyTo === msgId },
          (reply) => {
            clearTimeout(timer);
            unsub();
            const payload = typeof reply.payload === 'string'
              ? reply.payload
              : JSON.stringify(reply.payload);
            resolve(`回复来自 ${reply.from}:\n${payload}`);
          },
        );
      });
    },
  };
}
```

### 2.4 注册

在 `runtime/runtime.ts` 的 `createAgent()` 中注册：
```typescript
for (const tool of createRequestTools(this._bus, () => newAgent.id)) {
  if (config.collaborationMode === 'plan') continue;
  effR.register(tool);
}
```

### 2.5 系统提示词更新

在 `buildSystemPrompt()` 的 "Agent 间通信" 段落中加：
```
- agent_request 向指定 Agent 发同步请求并阻塞等待回复（有超时）。
  当你需要另一个 Agent 的直接回答时使用，而非 fire-and-forget。
  超时后不会重试——自行决定后续行动。
```

---

## 3. Rate Limit 退避调度

### 3.1 问题

当前 `SubAgentPool` 在 `agents.size >= maxConcurrent` 时直接返回 `null`，调用方报错"池满"。实际使用中，多个 async spawn 并发时容易触发，LLM 无从处理。

kimi-code 的 `AgentRunBatch` 有完整的 burst-then-throttle + rate limit 退避 + 重排队机制。

### 3.2 设计

改造 `SubAgentPool`，增加排队 + 退避：

```typescript
export class SubAgentPool {
  private maxConcurrent: number;
  private queue: QueuedSpawn[] = [];        // 排队等待的 spawn 请求
  private rateLimitMode = false;
  private rateLimitCapacity = 1;
  private rateLimitRetryMs = 3000;

  spawn(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent | null {
    // ... 幂等检查（callId 去重）...

    if (this.agents.size >= this.maxConcurrent) {
      // 不再返回 null — 排队
      return this._enqueue(description, runFn, callId, timeoutMs);
    }

    if (this.rateLimitMode) {
      return this._enqueueWithBackoff(description, runFn, callId, timeoutMs);
    }

    return this._doSpawn(description, runFn, callId, timeoutMs);
  }

  // _doSpawn — 实际创建 agent，runFn 执行
  // _enqueue — 排队，agent 完成后自动 dequeue 下一个
  // _enqueueWithBackoff — rate limit 退避，指数退避 + 容量恢复
}
```

**退避逻辑**（参照 kimi-code AgentRunBatch）：
1. spawn 时如果 provider 返回 rate limit 错误 → 进入 rateLimitMode
2. rateLimitCapacity 收缩到 `max(1, startedSuccessCount)`
3. 重排队待执行的 spawn，指数退避（3s, 6s, 12s...）
4. 每 3 分钟尝试恢复 capacity +1
5. 成功 spawn 恢复后退出 rateLimitMode

### 3.3 改动范围

| 文件 | 改动 |
|------|------|
| `src-ui/src/agent/coordinator.ts` | `SubAgentPool` 加 queue + rateLimitMode + 退避逻辑 |
| `src-ui/src/agent/tools/subagent.ts` | spawn 返回 null 时不再报错，改为"已排队"提示 |
| `src-ui/src/agent/runtime/runtime.ts` | 无改动（pool 接口不变） |

### 3.4 不做

- ❌ 不做 per-provider rate limit 检测（太复杂，依赖 provider SDK 的错误分类）
- ❌ 不做容量动态调整（kimi-code 的 shrink/recover）——简化为固定退避
- ❌ 不做 burst-then-throttle（HoloGram 的 max 5 已经够保守）

**简化版**：只做排队 + 固定 3s 退避重试。比 kimi-code 简单，但解决了"池满直接报错"的问题。

---

## 4. 共享发现区（DiscoveryBoard）

### 4.1 设计

Blackboard 模式——一个共享的 key-value store，Agent 可以 post 发现、query 发现。类似 TaskBoard 但面向"知识"而非"状态"。

### 4.2 数据结构

```typescript
// src-ui/src/agent/discovery-board.ts

export interface DiscoveryEntry {
  id: string;
  agentId: string;           // 谁发现的
  key: string;               // 发现的标签，如 "auth-logic-location"
  value: string;             // 发现内容，如 "src/auth.ts:42 — JWT 验证在此"
  category: string;          // 分类，如 "architecture" / "bug" / "pattern"
  ts: number;
}

export class DiscoveryBoard {
  private entries: DiscoveryEntry[] = [];

  post(agentId: string, key: string, value: string, category: string): string;
  query(filter?: { key?: string; category?: string; agentId?: string }): DiscoveryEntry[];
  getAll(): DiscoveryEntry[];
  clear(): void;

  // 持久化（同 TaskBoard 模式）
  async flush(): Promise<void>;
  async restore(): Promise<void>;
  clearFlushTimer(): void;
}
```

### 4.3 工具

两个工具：

```typescript
// agent_discover — 发布发现
{
  name: 'agent_discover',
  description: 'Post a discovery to the shared discovery board. Other agents can query it.',
  parameters: {
    key: { type: 'string', description: 'Short label (e.g. "auth-location")' },
    value: { type: 'string', description: 'Discovery content' },
    category: { type: 'string', description: 'Category: "architecture" / "bug" / "pattern" / "config"' },
  },
}

// agent_lookup — 查询发现
{
  name: 'agent_lookup',
  description: 'Query the shared discovery board for findings posted by other agents.',
  parameters: {
    key: { type: 'string', description: 'Filter by key (optional)' },
    category: { type: 'string', description: 'Filter by category (optional)' },
  },
}
```

### 4.4 注入路径

```
AgentRuntime
  ├── 持有 DiscoveryBoard 实例（同 TaskBoard 模式）
  ├── createAgent() 时注入 board 到 AgentConfig
  └── register discovery tools

Agent.runLoop()
  └── 每轮开始时 _injectDiscoveries() — 注入最近发现作为 system-reminder
```

### 4.5 runLoop 集成

在 `_injectInbox()` 之后加 `_injectDiscoveries()`：

```typescript
private _injectDiscoveries(): void {
  if (!this._discoveryBoard) return;
  const entries = this._discoveryBoard.query();
  if (entries.length === 0) return;
  // 只注入自己没 post 过的 + 最近 5 分钟内的
  const recent = entries.filter(
    (e) => e.agentId !== this.id && Date.now() - e.ts < 5 * 60 * 1000,
  );
  if (recent.length === 0) return;
  const formatted = recent.map(
    (e) => `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`,
  ).join('\n');
  this._insertPending(
    `<system-reminder>\n🔬 共享发现 (${recent.length} 条):\n${formatted}\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>`,
  );
}
```

### 4.6 持久化

与 TaskBoard 相同模式——flush 到 `.hologram/discoveries.json`，debounced 2s。

### 4.7 UI 面板

在 AgentsPanel 中加一个 "发现区" section（消息流上方）：

```
┌─ 发现区 (3) ─────────────────────┐
│ [architecture] auth-location:     │
│   src/auth.ts:42 (by sub-aaa)     │
│ [bug] race-in-parser:             │
│   parser.ts:88 null check (by sub-bbb) │
└───────────────────────────────────┘
```

### 4.8 系统提示词更新

在 "决策指南" 段落中加：
```
- **发现共享**：找到关键信息（文件位置、bug 根因、架构模式）时用 agent_discover 发布。
  开始新任务前用 agent_lookup 查看其他 Agent 的发现，避免重复探索。
```

---

## 5. 实现计划

### 优先级

| # | 功能 | 复杂度 | 依赖 |
|---|------|--------|------|
| 1 | Rate limit 退避调度 | 中 | 改 SubAgentPool |
| 2 | 共享发现区 | 中 | 新建 DiscoveryBoard + 2 工具 + runLoop 注入 |
| 3 | 同步请求 | 低 | 新建 request 工具（基于现有 bus.subscribe） |

建议按 1 → 2 → 3 顺序实施，每个可以独立验证。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src-ui/src/agent/discovery-board.ts` | DiscoveryBoard 共享发现区 + 持久化 |
| `src-ui/src/agent/tools/request.ts` | agent_request 同步请求工具 |
| `src-ui/src/agent/tools/discovery.ts` | agent_discover / agent_lookup 工具 |
| `src-ui/tests/phase4-collaboration.test.ts` | Phase 4 测试 |

### 改动文件

| 文件 | 改动 |
|------|------|
| `src-ui/src/agent/coordinator.ts` | SubAgentPool 加排队 + 退避 |
| `src-ui/src/agent/tools/subagent.ts` | 池满时返回"已排队"而非报错 |
| `src-ui/src/agent/agent.ts` | `_injectDiscoveries()` + discoveryBoard 字段 |
| `src-ui/src/agent/runtime/runtime.ts` | 注入 DiscoveryBoard + 注册 discovery/request 工具 |
| `src-ui/src/agent/runtime/types.ts` | AgentConfig 加 `discoveryBoard?` |
| `src-ui/src/agent/runtime/agent-builder.ts` | 系统提示词加 agent_request / agent_discover / agent_lookup |
| `src-ui/src/ui/agent-panel-store.ts` | 加 discoveries 数据源 |
| `src-ui/src/ui/react/AgentsPanel.tsx` | 加发现区 section |
| `src-ui/src/workspace.ts` | 初始化 DiscoveryBoard + deactivate 清理 |
| `MULTI_AGENT_STATUS.md` | 更新 Phase 4 状态 |

---

## 6. 验证计划

### 测试用例

| 测试 | 验证点 |
|------|--------|
| `test_agent_request_reply` | A request B → B reply → A 收到回复 |
| `test_agent_request_timeout` | A request B → B 不回复 → 超时返回错误 |
| `test_agent_request_topology_denied` | A request C（拓扑不允许）→ 返回错误 |
| `test_discovery_post_query` | post 发现 → query 检索 → 内容正确 |
| `test_discovery_inject_in_runloop` | 发现注入 system-reminder → 只注入别人的 |
| `test_discovery_persistence` | flush → restore 往返一致 |
| `test_pool_queue_on_full` | 池满时排队 → 完成后自动 dequeue |
| `test_pool_rate_limit_backoff` | rate limit 错误 → 退避重试 → 恢复 |

### 实际运行验证

```
用 async spawn 派 3 个子 Agent 探索不同模块：
1. 子 A 探索 auth 模块 → agent_discover("auth-location", "src/auth.ts:42")
2. 子 B 探索 API 路由 → agent_discover("api-routes", "src/routes/")
3. 子 C 开始前 agent_lookup → 看到 A 和 B 的发现 → 不重复探索
```

---

## 7. 开放问题

1. **agent_request 与 async spawn 的关系**：agent_request 是向已存在的 Agent 发同步请求。如果目标 Agent 正在跑 runLoop（_isRunning=true），请求消息会躺在 inbox 中直到下一轮 `_injectInbox`。timeout 会先触发。这是预期行为——不要为了同步请求而打断正在运行的 Agent。

2. **DiscoveryBoard 的容量**：不设上限。发现数量通常很少（每个 Agent 几条）。如果需要限制，加 LRU 淘汰（类似 messageFlow 的 50 条上限）。

3. **Rate limit 检测**：当前不做 per-provider 错误分类。简化方案：如果 `runFn` 抛出包含 "rate limit" 或 "429" 的错误，进入退避模式。比 kimi-code 的 `isProviderRateLimitError` 粗糙，但够用。

4. **TreeTopology 兄弟通信**：当前 TreeTopology 不允许兄弟通信。如果需要，加 `allowSiblings: boolean` 配置。但 Phase 4 不急——MeshTopology 已覆盖全连通场景。
