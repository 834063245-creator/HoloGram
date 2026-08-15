# HoloGram Agent 运行时架构收敛计划

> 状态：Proposed（待评审）
> 日期：2026-08-15
> 目标分支：feat/agent-gap-closure（建议另开分支执行）
> 范围：`src-ui/src/agent/`（TS Agent 运行时）；不触碰 `src-tauri/`、`engine/` 业务逻辑
> 依据：
> - `docs/agents/dsh-harness-comparison.md`
> - `docs/MULTI_AGENT_ROADMAP.md`
> - `docs/adr/project-constitution.md`
> - DeepSeek Harness 的 Cordis core 研究结论

---

## 0. 一句话目标

**不更换运行时，不改产品行为，把 HoloGram 自有 Agent 内核收敛到四个原语上：**
Context、Effect/Disposer、类型化事件、事件溯源会话日志。

这四个原语取自 Cordis 的设计内核，但以 HoloGram 自己的 TS runtime 形式实现；本计划不引入 `@deepseek-ai/cordis` 运行时，也不把 Agent 主循环迁入 DeepSeek Harness。

---

## 1. 为什么要做

当前架构已经出现“再增长会变贵”的信号：

| 证据 | 位置 | 影响 |
|---|---|---|
| `agent.ts` 2963 行，拆分已搁置 | `src-ui/src/agent/agent.ts`；`docs/ARCH_ACTION_PLAN.md` 任务 11c | 状态与循环耦合，单文件变更风险高 |
| `AgentConfig` 约 30 个可选字段 | `src-ui/src/agent/runtime/types.ts` | 组装靠 `createAgent` 手工接线，依赖关系不可静态检查 |
| 注册 API 不返回 disposer | `ToolRegistry.register`、`HookRegistry.register`、`PreflightHookRegistry.register` | 生命周期清理靠调用方自觉，泄漏容易回归 |
| 工具执行只有“preflight + post enrich”两个 hook 阶段 | `streaming-executor.ts` | 没有统一裁决语义；planGate、guard、hook、spill 各自硬编码 |
| 生命周期清理分散 | `runtime/_disposeAgent`、`LifecycleManager.stop`、`AgentHandle.dispose` | teardown 顺序不可复用，重入问题没有统一防线 |
| 会话是消息数组快照 | `agent.ts` 的 `Message[]` + `message-store` | 无法可靠派生历史、恢复、回放与审计 |
| 事件是单一 `EventSink` 观察流 | `agent-types.ts` 的 `EventKind` | 观察与裁决混在一起，无法表达短路/优先级 |

这与“代码是否乱”无关，而是架构抽象正在逼近需要显式化生命周期的拐点。

---

## 2. 为什么采用 Cordis 思想，而不是迁移到 Cordis

HoloGram 的护城河是垂直机制：git worktree 隔离、资源租约、merge gate、TaskBoard/DiscoveryBoard、记忆分级、图引擎。DSH 没有这些；即使迁移到 DSH，也必须重写这些能力。

但 Cordis 的通用层——Context、Effect、类型化事件、事件溯源日志——可以直接在 HoloGram 内部落地，收益是：

1. 新能力接入从“改 builder + 改 Agent + 改 dispose”收敛为“注册 + 返回 disposer”；
2. 工具执行策略从硬编码 `if` 变成可测试、可排序、可短路的 pipeline；
3. teardown 从分散清理变成单一 owner 的逆序释放；
4. 会话历史从可变数组快照变成可推导事实流；
5. 未来如果产品形态触发 DSH 迁移，核心语义已经对齐，迁移成本显著下降。

---

## 3. 非目标（防止计划膨胀）

- ❌ 不替换 `Agent` 主循环；
- ❌ 不引入 Cordis/DSH 作为运行时依赖；
- ❌ 不重构 `src-tauri/` 与 `engine/`；
- ❌ 不改变模型可见的 tool schema 顺序与内容（前缀缓存约束）；
- ❌ 不改变 planGate、storm breaker、compaction、spawn/merge 的现有语义；
- ❌ 不迁移持久化文件格式（Phase 5 只加 append-only log 投影，旧格式继续写）；
- ❌ 不在本计划内拆分 `agent.ts` 之外的新 UI/Rust 能力；
- ❌ 不处理与当前未提交改动冲突的区域：`src-tauri/src/os_sandbox.rs`、`src-tauri/src/utils.rs`。

---

## 4. 执行原则

1. **每步行为中性**：每阶段结束必须通过现有全套测试，且不允许模型可见输出变化。
2. **只加接口，先不改语义**：新原语与旧 API 并行；旧实现作为适配器挂在新原语上。
3. **一个小步一个 commit**：遵循项目 Conventional Commits，例如 `refactor(agent): introduce disposer contract for ToolRegistry`。
4. **测试先行**：每个原语先写行为测试，再迁移调用点。
5. **不碰未提交区域**：工作区现有 `src-tauri` 修改保持原样，本计划所有改动只发生在 `src-ui/src/agent/` 与 `src-ui/tests/`。
6. **可回滚**：每个 phase 独立可 revert；不回滚行为测试与文档。

---

## 5. 目标架构蓝图

```
                 ┌──────────────────────────────────────────┐
                 │            AgentContext (新)              │
                 │  身份 / provider / tools / hooks / events │
                 │  boards / bus / planState / sessionLog    │
                 │  effect(): 注册即 ownership               │
                 └──────────────┬───────────────────────────┘
                                │ 构造并持有
                 ┌──────────────▼───────────────────────────┐
                 │              Agent (现有)                 │
                 │  只负责 loop：run → stream → tools        │
                 └──────────────┬───────────────────────────┘
                                │ 通过类型化 pipeline
                 ┌──────────────▼───────────────────────────┐
                 │         ToolPipelineEvents (新)           │
                 │  tool/preflight  tool/around  tool/result │
                 │  观察 + 裁决 + 短路，替代硬编码 if          │
                 └───────────────────────────────────────────┘

所有注册点（ToolRegistry / HookRegistry / McpClient / LifecycleManager timer）
统一返回 disposer，并登记到 AgentContext.effect()。
模型可见事实追加到 SessionEventLog，Message[] 成为其派生物。
```

---

## 6. Phase 划分

### Phase 0 — 基线冻结与测试栅栏（0.5 个窗口）

**目标**：先固定“行为正确”的定义，不写生产代码。

任务：

- [ ] 记录当前基线：`npx vitest run`（当前约 972 用例）、`npx tsc --noEmit`、`npm run build` 的通过结果与耗时；
- [ ] 锁定 8 个关键回归套件作为快速栅栏：
  - `agent-exec.test.ts`
  - `agent-hooks.test.ts`
  - `streaming-executor-hooks.test.ts`
  - `agent-lifecycle-dispose.test.ts`
  - `lifecycle-integration.test.ts`
  - `plan-gate.test.ts`
  - `message-bus.test.ts`
  - `coordinator.test.ts`
- [ ] 记录当前 `AgentConfig` 字段清单、`createAgent` 装配步骤数、`_disposeAgent` 清理步骤数，作为 Phase 3/4 的度量基线；
- [ ] 建立 `docs/plans/agent-core-convergence-progress.md` 进度表（每 phase 更新）。

**验收**：基线与度量表落盘。

---

### Phase 1 — Disposer 契约（小步，1 个窗口）

**目标**：先让所有注册 API 显式返回清理器。

新增文件：

- [ ] `src-ui/src/agent/lifecycle.ts`
  - `type Disposer = () => void | Promise<void>`
  - `class DisposerBag`：逆序清理、单次执行、async 串行等待；
  - `runInContext(register: () => Disposer)` 辅助函数。

改动：

- [ ] `tool.ts`：`ToolRegistry.register()` 返回 `Disposer`（unregister 已有幂等语义）；`alias/hide/unhide` 暂不动；
- [ ] `hooks.ts`：`HookRegistry.register()`、`PreflightHookRegistry.register()` 返回 `Disposer`；
- [ ] `lifecycle-manager.ts`：`start/stop` 保留，新增 `startOwned()` 返回 disposer，内部 stop 幂等；
- [ ] `mcp/client.ts`：确认 `disconnect()` 幂等，新增 `ownedDisposer` 包装（不改变现有调用方）；
- [ ] 全局搜索 agent 内注册点，建立 `REGISTRY_OWNERSHIP.md` 清单：每个注册点的 owner、清理点、当前是否自动清理。

测试：

- [ ] `src-ui/tests/lifecycle-disposer.test.ts`：逆序、幂等、async 清理等待、部分失败不影响后续；
- [ ] `src-ui/tests/tool-registry-disposer.test.ts`：register 返回的 disposer 删除指定工具；重复调用 no-op；
- [ ] 现有测试全绿。

**验收**：
- agent 目录内新增注册 API 均有 disposer 或写入豁免清单；
- 行为测试证明 ToolRegistry/HookRegistry 语义未变。

---

### Phase 2 — 工具执行管道类型化事件（中步，1–2 个窗口）

**目标**：把 `StreamingToolExecutor` 的硬编码阶段显式化，但不改变现有顺序与默认行为。

新增：

- [ ] `src-ui/src/agent/events.ts`
  - `interface AgentEventMap`：`tool/preflight`、`tool/around`、`tool/result`、`tool/error`；
  - 每个事件声明 `mode: 'serial' | 'parallel' | 'waterfall' | 'emit'`；
  - `class AgentEventBus`：`on/emit/serial/waterfall`，listener 注册返回 disposer；
  - 保持 `EventKind` 旧 sink 兼容：event bus 转发一份 legacy EventKind，UI 零改动。

改动：

- [ ] `streaming-executor.ts`
  - 构造参数增加可选 `eventBus`；`eventBus === undefined` 时走旧路径（行为完全一致）；
  - 新路径顺序固定：
    1. `tool/preflight`（serial 聚合 warning，保持 HIGH gate 语义）；
    2. planGate 以 `tool/guard` 优先级监听器接入（先不动 planGate 逻辑）；
    3. `tool/around`（serial，包装原 hooks.apply 的 post enrich 行为）；
    4. `tool/result`（emit）；
    5. 错误路径 `tool/error`（emit）。
  - 旧 `preflightHooks/hooks` 作为 adapter listener 注册进新 bus；
  - 删除或保留旧直调路径由测试决定，目标是一个执行器、两条等价路径。

- [ ] `agent-types.ts`：新增 `ToolPipelineContext` 类型（call、tool、args、agentId、signal），旧 `ToolEvent` 不变。

测试：

- [ ] `src-ui/tests/tool-pipeline-events.test.ts`
  - 旧路径与新路径对同一调用产生相同 `PendingResult`；
  - waterfall 短路优先级、serial 顺序、emit 广播；
  - planGate 在新 bus 下拦截结果一致；
  - hook 抛错仍静默降级。

**验收**：
- `streaming-executor` 执行阶段由 event map 驱动；
- 现有 hook/planGate 测试全绿；
- tool schema 字节不变（`buildSystemPrompt` / `registry.schemas()` 快照测试）。

---

### Phase 3 — AgentContext 抽取（中大步，2–3 个窗口）

**目标**：把 `createAgent` 的 30 字段手工装配收敛为 Context + 显式依赖。

新增：

- [ ] `src-ui/src/agent/context.ts`
  - `interface AgentServices`：`provider / tools / events / hooks / messageBus / taskBoard / discoveryBoard / planState / goalManager / agentStore / sessionLog`
  - `class AgentContext`
    - 身份：`agentId / parentId / subagentDepth / isolationId / projectPath`
    - 服务访问：`get(name)`，可选依赖显式 `resolve(name)`；
    - `effect(register: () => Disposer, label): Disposer`；
    - `child(overrides)` 用于子 Agent 派生，暂不强制迁移所有字段；
  - 不立即删 `AgentConfig`；`createAgent` 先把 config 转成 context，再逐步把 Agent 构造函数从 config 字段改为 context 字段。

改动顺序：

1. [ ] `runtime/types.ts`：新增 `AgentContext` 构造入口，`AgentConfig` 保留兼容；
2. [ ] `runtime/runtime.ts`：`createAgent` 第一阶段只把 `taskProxy/discoveryProxy/planState/execState` 的创建移入 context 工厂；装配步骤不减逻辑，只换 owner；
3. [ ] `agent.ts`：
   - 构造函数保持兼容重载：`new Agent(ctx, systemPrompt, opts)`；
   - 新路径只读 `ctx`，旧 `setBus/setSubAgentPool/setGoalManager` 逐步改为 context 字段；
   - 禁止在本阶段拆分 `agent.ts` 大文件，只做字段来源替换；
4. [ ] 子 Agent 派生 `spawnSubAgent` 从父 context `child()` 生成，不复制全部配置字段。

测试：

- [ ] `src-ui/tests/agent-context.test.ts`：服务解析、缺依赖报错、effect 逆序清理、child 隔离；
- [ ] 现有 spawn/identity/status 测试全绿；
- [ ] 旧 `AgentConfig` 调用方（含测试）零改动通过。

**验收**：
- 新 Agent 创建路径只依赖 `AgentContext` 的公开接口；
- `createAgent` 直接字段赋值数量至少下降 40%；
- `agent.ts` 中 setter 接线调用清零或全部标记 deprecated。

---

### Phase 4 — 生命周期所有权统一（高风险，2–3 个窗口）

**目标**：所有长生命周期资源归 AgentContext 所有，`AgentHandle.dispose()` 变成“等待 context quiescence”。

改动：

- [ ] `context.ts`：实现 `context.dispose()`：先停新注册，逆序运行 effects，等待 async 清理；
- [ ] `runtime/runtime.ts`：
  - `_disposeAgent` 改为调用 `handle.ctx.dispose()`；
  - 保留 flush 顺序：`bus.flush → board.flush → saveState('done') → context.dispose()`；
  - LifecycleManager timer 不再手动 stop，由 context effect 持有；
- [ ] `lifecycle-manager.ts`：timer 注册通过 context effect；`stop()` 保留为 disposer 别名；
- [ ] `message-bus.ts` / `task-board.ts` / `discovery-board.ts`：注册/取消保持现状，Phase 4 只把“谁持有谁清理”写入 context，不重写持久化；
- [ ] `mcp/client.ts`：McpClient 注册与 disconnect 纳入 context effect；
- [ ] `coordinator.ts`：SubAgentPool 的 timeout timer 与 onFinish 回调按 context effect 登记（先只做 timeout timer）。

测试：

- [ ] `src-ui/tests/lifecycle-integration.test.ts` 扩充：
  - dispose 幂等；并发 dispose 只执行一次；
  - 清理中失败不影响后续清理且可观测；
  - dispose 后新注册抛错；
  - 子 Agent 清理顺序：先停 spawn/loop，再 flush boards/bus，最后释放 worktree；
- [ ] 增加 `src-ui/tests/agent-context-dispose.test.ts`。

**验收**：
- `_disposeAgent` 不再包含分散的 timer/board/bus 清理分支；
- 泄漏检测测试（重复 create/dispose 100 次）无 timer 增长。

---

### Phase 5 — 模型可见事件溯源日志（大，3–4 个窗口）

**目标**：模型可见事实追加为事件；`Message[]` 成为投影。不迁移旧持久化格式。

新增：

- [ ] `src-ui/src/agent/session-log.ts`
  - `type SessionEvent = { seq, ts, kind, data }`
  - `SessionEventKinds`：`turn/start`、`user/message`、`assistant/text`、`assistant/reasoning`、`tool/call`、`tool/result`、`session/compaction`；
  - `class SessionLog`：append、snapshot、deriveMessages(工具折叠规则)、replay；
  - 与 `Message[]` 的双写适配器：先 append 事件，再从事件 derive 现有 messages；旧路径只读投影。
- [ ] `agent.ts`：
  - 在 runLoop 关键边界追加事件；
  - `this.session` 改为“当前投影”；
  - compaction/retract 先以 log slice/rewrite 语义实现，保持旧快照行为一致；
- [ ] `message-store.ts`：保留现有 NDJSON 快照作为向后兼容导出；新增 `session-log.ndjson` 的 append 路径（双写阶段）；
- [ ] UI/EventSink 不变，只增加 `session/event` 内部事件供测试与未来回放使用。

测试：

- [ ] `src-ui/tests/session-log.test.ts`：seq 严格递增、deriveMessages 与旧 session 一致、compaction 后投影一致；
- [ ] `src-ui/tests/session-replay.test.ts`：从 log 重放一轮等价 tool 序列；
- [ ] 现有 `agent-store`、`session-sync`、`compaction` 测试全绿。

**验收**：
- 模型请求消息由 session log 派生，不直接改 session 数组；
- 旧持久化文件仍可读，新 log 为追加文件；
- 关键模型可见路径有 `session/event` 记录。

---

### Phase 6 — 组合层收尾（可选，1 个窗口）

**目标**：用 context/service 描述 agent 组成，不再扩展 `AgentConfig`。

- [ ] 新增 `agent/blueprint.ts`：以声明式 service/factory 表构建 AgentContext；
- [ ] `runtime/agent-builder.ts` 的工具/hook 工厂迁移为 context factory；
- [ ] 视前五阶段收益决定是否继续。

**验收**：新增一个工具或 hook 不再要求修改 `AgentConfig`。

---

## 7. 依赖与顺序

```
Phase 0 → Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5
              └─────────────→（Phase 1 可与 Phase 2 并行开发，但分 commit 合入）
```

- Phase 1 是后续所有 ownership 的前提；
- Phase 2 不依赖 Phase 3，可先行；
- Phase 3 是 Phase 4 的前置；
- Phase 4 稳定后，才允许做 Phase 5 的事件溯源；不要在生命周期不可靠时叠加新存储。

---

## 8. 测试与门禁

每 phase 合入前必须通过：

```sh
cd src-ui
npx tsc --noEmit
npx vitest run
npx biome check src/agent src/tests
```

关键不变式测试必须始终覆盖：

1. `ToolRegistry.schemas()` 输出与迁移前逐字节一致；
2. planGate 拦截集合与拦截文案不变；
3. hook 失败静默降级不变；
4. AbortSignal 行为不变；
5. `agent_spawn`/`agent_merge`/`agent_board` 语义不变；
6. 旧持久化文件可读。

---

## 9. 风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| Phase 3 改动 `agent.ts` 引入行为漂移 | 中 | 只替换字段来源，不做逻辑重构；以 8 个栅栏测试先行 |
| 工具管道事件改变 hook 执行顺序 | 中 | 新路径先镜像旧顺序；旧路径保留到 Phase 2 验收后才删除 |
| 生命周期清理顺序变化导致 flush 丢数据 | 中高 | Phase 4 保持 `_disposeAgent` 的 flush 前置顺序，只替换 timer/board cleanup |
| 事件溯源与现有快照双写不一致 | 中 | Phase 5 先双写，derive 结果与旧 session 做差分测试 |
| `src-tauri`/`engine` 未提交改动混入 | 低 | 只 add `src-ui` 与 `docs/plans` 文件，分 commit |
| 与并发 Agent 会话在同一工作区冲突 | 中 | 按仓库既有纪律：每 phase 只 `git add` 本 phase 文件；合入前 rebase 核对 |
| 前缀缓存失效 | 低但代价高 | tool schema、system prompt、消息序列的字节稳定性列为硬性不变式 |

---

## 10. 决策检查点

- **Phase 1 结束**：若 disposer 契约没有让任何现有 bug 消失，仍继续 Phase 2（价值主要在未来）；
- **Phase 2 结束**：若事件管道只是“换皮”，则说明工具阶段已经足够简单，降低 Phase 2 后续投入；
- **Phase 3 结束**：评审 `AgentContext` 是否真的减少了装配复杂度；若 `createAgent` 复杂度没有下降，暂停 Phase 4；
- **Phase 4 结束**：确认生命周期统一是否带来可测的泄漏减少；否则不进入 Phase 5；
- **Phase 5 结束**：重新评估是否值得迁移到 DSH。届时如果触发线（多表面运行、第三方插件生态、可续聊子 Agent、模型自修改）仍未出现，继续自有 runtime。

---

## 11. 完成定义（DoD）

1. Agent 内所有注册点返回 disposer，并具备明确 owner；
2. 工具执行策略可由类型化事件组合表达；
3. Agent 创建不再需要 30 字段手工装配；
4. `AgentHandle.dispose()` 是唯一 teardown 入口，且可等待 quiescence；
5. 模型请求消息从 session log 派生；
6. 全部旧测试 + 新测试通过，tool schema 与模型可见输出无漂移；
7. 进度与决策记录更新到 `docs/plans/agent-core-convergence-progress.md`。

---

## 12. 规模预估（相对，不承诺日历）

| Phase | 相对规模 | 说明 |
|---|---|---|
| 0 | S | 基线 |
| 1 | S | 机械但调用面广 |
| 2 | M | 行为镜像要求高 |
| 3 | L | 最大结构变化 |
| 4 | L | 生命周期风险最高 |
| 5 | XL | 事件溯源涉及存储兼容 |
| 6 | S | 视收益决定 |

建议按 Phase 独立开分支、独立 review、独立 revert；不要将 Phase 3 与 Phase 4 压缩成一个大重构。
