# 并发会话（多卷同跑）— 会话身份贯通计划

> **已归档（2026-10-08 竣工）**——Phase 1-5 拆掉 chat UI 层全部单槽假设 + **Phase 6 测试面全落**（`tests/concurrent-sessions.test.ts` 226 行 / 10 用例覆盖计划要的 5 类断言；`chat-stream-session-leak.test.ts` 已改新 ctx 形状）；**余真机五项**。真机欠账见 [`plans/README.md`](../../plans/README.md) 欠账表。

> 立项：2026-08-26 · 状态：**In progress（Phase 1-5 代码已落地，Phase 6 门禁收尾中）**
> 触发：用户痛点——「画布层辛苦做到同工作区全量会话共存 + 每卷创作坞，结果多个会话不能同时运行」。
> 授权基线：⚡ 破坏性操作授权（CLAUDE/AGENTS 头部）——拆干净比绕着走重要，测试工程兜底。

## 0. 一句话

多会话并行的**地基早已就位**（每卷独立 Agent/独立 execState/独立消息 store/运行时天然并发/子 Agent 异步模式），唯一挡路的是 chat UI 层当年为单飞渲染留下的一组**单槽假设**——本计划把会话身份端到端贯通，拆掉全部单槽。

## 1. 病灶清单（调查实证，2026-08-26）

| # | 病灶 | 位置 | 类型 |
|---|---|---|---|
| 1 | 全局闸门：任一后台卷在跑就拒绝新轮次 | `chat-core.ts` `_runAgentTurn`/`sendMessage` 两处 `hasRunningBackgroundSession` 检查 | 显式策略锁 |
| 2 | 事件流无会话身份：所有卷的 Agent 共享同一个 eventSink，路由靠猜 | `workspace.ts` 工厂 `eventSink: chatPanel.eventSink`（所有 Agent 同一 sink） | 单槽 |
| 3 | `streamingAssistantId` 面板级单值 | `messages-store.ts` 默认面板 store（会话级 store 里同名字段闲置） | 单槽 |
| 4 | `_resolveSessionTarget` 三级猜测兜底「找不到就写进活跃卷」 | `chat-stream.ts` | 并发时必串卷 |
| 5 | ask_user 单坑：`useAskStore.pending` 一个槽，两卷同时提问→后者覆盖前者→前者 callback 永挂→Agent 死等 | `ask-store.ts` | 单槽 |
| 6 | 权限卡挂错卷：`showPermissionCard` 惰性抓**此刻活跃卷**的 execState，Rust 送来的 agentId 被 bridges.ts 丢弃 | `chat-core.ts:432` + `shell/rows/bridges.ts:56` | 归属错位（**今天就存在的活 bug**：A 卷在跑→切到 B→A 请求写权限→卡挂 B 的 exec→在 B 按停止→A 的写被静默否决） |
| 7 | `p.agentId !== 'main'` 判子 Agent：工厂早已改 `main-{ts}-{rand}` 唯一 id，现在**所有主 Agent 权限卡都被误判为子 Agent**（60s 超时+错误前缀） | `bridges.ts:48` | 潜伏 bug |
| 8 | `onSessionPersisted` 用共享 `agentRef.current?.insertMessage`——A 卷 turn 结束时 build 块可能注入**最后创建的** B 卷会话 | `workspace.ts` 工厂闭包 | 潜伏 bug |
| 9 | 状态栏/token 面板级单值：并发时交错闪烁；`autoTitleSessionIfDefault` 只认活跃卷（B 后台跑完会误改 A 的标题） | `chat-stream.ts` finishTurn / chat-core | 展示层 |
| 10 | turnPairs 面板级共享数组：多卷并发推对，retract/retry 语义错位 | `agent-session-state.ts` | 展示层 |

**已排除的非病灶**（调查确认，勿重查）：
- 子 Agent spawn 路由：blueprint `spawn-tool` 已绑定本 Agent（「修复多会话下 spawn 路由错位」注释实证）
- 子 Agent 事件路由：`onSubAgentSpawn` 携带 sessionId，runtime-adapter 按 sid 路由 ✓
- 每卷 execState/消息 store/草稿/创作坞偏好：早已按会话隔离 ✓
- ComposerDock 后台卷运行态指示 + 停止（B7）：2026-08-27 已落地 ✓
- 运行时层（AgentRuntime/bus/看板/文件所有权/原子写）：子 Agent 异步模式今天就在并行跑 ✓

## 2. 方案总纲：会话身份端到端贯通

**核心机制：工厂装配时把 sessionId 绑进每个 Agent 的 eventSink 闭包**——事件天生带身份，所有下游「猜测路由」降级为「直接寻址」。

```
工厂（workspace.ts factory(sessionId)）
  └─ eventSink: chatPanel.eventSinkFor(sessionId)   ← 绑定闭包（取代共享 eventSink）
       └─ Stream.renderEvent(ctxFor(sessionId), ev) ← ctx.sessionId 直达
            └─ msgStoreFor(storeId, sid)            ← 流式状态/消息全按卷寻址
```

### Phase 1 — 事件面身份贯通（病灶 2/3/4/8/9）
1. `chat-stream.ts` StreamContext 增 `sessionId: number | null`；`_resolveSessionTarget` 以 ctx.sessionId 直达（无 sid 的调用面走旧兜底——仅剩恢复路径）
2. `get/setStreamingAssistantId` 路由到**会话级** msgStore（字段已在 store 形状里，只是从没人按会话读写）
3. `_streamingTargetSid` 退役（sink 已带身份，猜测兜底删除）
4. `chat-core`：`eventSinkFor(sid)` 公开出口；`_runAgentTurn` 的 notice/finishTurn 按轮次所属卷（turnSid）路由；`autoTitleSessionIfDefault(sid)`；状态栏只响应活跃卷事件；token 按卷累计
5. `workspace.ts` 工厂：sink 绑定 + `onSessionPersisted` 用捕获的 agent（拆 `agentRef.current` 错位）

### Phase 2 — 闸门拆除（病灶 1）
6. 删 `hasRunningBackgroundSession` + 两处闸门检查。保留**本卷** isRunning 语义（活跃卷在跑 → Enter 走插话路径不变）

### Phase 3 — ask_user 多坑化（病灶 5）
7. `ask-store`：单坑 pending → 每会话队列（`consumeAsk(sid)`）
8. ask_user 工具 execute 从 `args._agent_id` 取 agent 盖章到 AskRequest（透传铁律已在，_agent_id 本就在 args 里）；chat-core 消费时经 agentId→卷 映射路由，PromptShelf 多卡 FIFO（其队列机制本就支持）+ 卡面卷徽标

### Phase 4 — 权限卡归属（病灶 6/7）
9. `agent-session-state`：setAgent/removeAgent/clearPanelState 自动维护 **agentId→(storeId, sessionId)** 注册表（handle.id 天然可用）
10. `bridges.ts`：agentId 解析归属卷（sub- 前缀走 runtime parentId 链上溯到主 Agent）→ `showPermissionCard` 按归属卷的 execState 挂队列；子 Agent 判定改为「请求者 ≠ 归属卷主 Agent id」
11. 停止语义归位：停 A 卷只杀 A 卷的卡（execState.stop 的 _cancelAllPermissions 天然按 exec 隔离，挂对 exec 即正确）

### Phase 5 — 展示层收尾（病灶 9/10）
12. turnPairs 按卷键控（`storeId:sid`）；retract/retry 消费面同步
13. 状态栏活跃卷守卫；token 面板-会话映射（切卷恢复既有机制核对）

### Phase 6 — 测试与门禁
14. 新增 `tests/concurrent-sessions.test.ts`：双卷交错流式零泄漏 / 闸门拆除 / ask 每卷队列 / 权限卡按 agentId 路由 / 子 Agent 判定
15. 更新 `chat-stream-session-leak.test.ts` 至新 ctx 形状
16. 门禁（顺序跑，勿并行）：vitest 全量 → build → biome（改动文件零新增，预览副本纪律）→ verify:convergence（改了 agent/** 必跑）

## 3. 验收判据

| 判据 | 验证方式 |
|---|---|
| 双卷同时流式输出，消息零串卷 | 自动化测试 + 真机 |
| A 卷在跑，B 卷可直接发起新轮次（无「有后台任务运行中」拦截） | 自动化 + 真机 |
| 两卷同时 ask_user，各答各的，无 Agent 死等 | 自动化 + 真机 |
| A 后台跑写动作权限卡：卡挂 A 的 exec、卡面显示 A 卷徽标、停 B 不杀 A 的卡 | 自动化 + 真机 |
| 主 Agent 权限卡恢复 120s 超时 + 无 [子Agent] 误标 | 单测 |
| 后台卷跑完自动命名自己的卷，不动活跃卷标题 | 单测 |
| 状态栏只反映活跃卷；后台卷运行态由创作坞既有指示承担 | 真机 |

## 4. 风险与边界

- **冻结文件**（chat-session.ts / chat-stream.ts）改动：逐块核对 INVARIANTS `⚠️` 注释，convergence 必跑
- **convergence baseline**：不动 prompt/工具 schema 面（ask_user 参数不变，agentId 盖在请求对象上），预期零漂移；若漂移即回查
- 前缀缓存语义：不改三层表序/段表，无涉
- 真机验收项记入 `docs/plans/README.md` 欠账表
