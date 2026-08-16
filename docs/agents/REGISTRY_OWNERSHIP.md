# REGISTRY_OWNERSHIP — agent 注册点所有权清单

> 生成：2026-08-16（agent-core-convergence Phase 1 任务，基线 commit `5ff78821`）
> 规则：**新增注册 API 必须返回 Disposer 并登记到本清单**；不返回 disposer 的要写豁免原因。
> Phase 4（生命周期所有权统一）将以本清单为迁移地图：每行最终都应指向 `AgentContext.effect()`。

## 图例

- **订阅型**注册（hooks / bus / timer）：必须显式清理，否则跨 Agent 泄漏。
- **内容型**注册（工具 / board 条目）：注册表随宿主实例整体释放，无全局残留——豁免于"调用方必须消费 disposer"，但 API 仍返回 disposer（Phase 1 契约）。

## ToolRegistry.register（内容型）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `runtime/agent-builder.ts:328-456`（hologram/dataflow/coding/skill/memory/task/subagent/browser/desktop/wait 工具） | `buildToolRegistry` → 调用方（workspace/Runtime） | registry 本身无全局状态，随 Agent 实例 GC | ✅ 随实例 |
| `runtime/agent-builder.ts:488`（compaction 工具） | createAgent | 同上 | ✅ 随实例 |
| `mcp/registry.ts:57` `registerMcpTools` | builder/调用方；`unregisterMcpTools`（:67）已提供对称清理 | 当前调用方（builder:464）未调用——随 registry GC | ✅ 随实例（豁免：批量注册，整体释放） |
| `runtime/runtime.ts:532`（registry 克隆循环） | createAgent → Agent 实例 | 随 Agent 实例 | ✅ 随实例 |
| `runtime/runtime.ts:541-643`（plan 工具/通信/discovery/merge/board/kill/request/spawn 替换/task 替换） | createAgent → Agent 实例 | 随 Agent 实例 | ✅ 随实例 |
| `agent.ts:68,2389-2430`（子 Agent 工具克隆，`convergeRegistry` 重建） | 子 Agent 实例 | 随子 Agent | ✅ 随实例 |
| `agent.ts:983`（goal_report） | Agent goal loop | `agent.ts:923,951` unregister（对称存在） | ✅ 显式 |
| `tool.ts:150`（subset 临时 registry） | 调用方作用域 | 作用域结束 GC | ✅ 随作用域 |

## HookRegistry / PreflightHookRegistry.register（订阅型）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `runtime/runtime.ts:695-709`（graph/state/plan/board hooks） | createAgent → `newAgent.setHooks/setPreflightHooks` | 随 Agent 实例 GC（无跨 Agent 引用） | ✅ 随实例 |
| `agent.ts:2566`（子 Agent board-tracking hook） | 子 Agent | 随子 Agent | ✅ 随实例 |

> Phase 1 起 `register()` 返回 Disposer；上述调用点暂不消费（随实例释放已足够）。
> Phase 4 接线 context effect 后，订阅型注册必须消费 disposer。

## AgentLifecycleManager（订阅型 + timer）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `runtime.ts` `_assembleAgent`（60s 巡检 interval） | `AgentContext.effect('lifecycle-manager')` | `ctx.dispose()` 逆序释放 `startOwned()` 清理器（Phase 4 已接线）；重复创建时先 stop 旧实例（保留） | ✅ ctx 所有权 |
| ~~`runtime._lifecycleManagers` map~~ | map 仅供重复创建去重 | entry 删除随 lifecycle effect 释放 | ✅ |

## McpClient（连接型）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `runtime/agent-builder.ts`（client 工具注册进 registry） | Runtime/UI（MCP 会话管理） | `disconnect()` 幂等；`ownedDisposer()` 已备 | ⚠️ Phase 4 决策：**保持 workspace 所有权**——client 是跨 Agent 共享连接，挂单个 Agent 的 context 会在该 Agent dispose 时掐断兄弟 Agent 的工具面；owner 停用 MCP 会话时消费 `ownedDisposer()`（待 workspace 侧接线，非本工程范围） |

## MessageBus.register（订阅型）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `agent.ts` setBus → bus.register(addr)（ctx 构造路径） | `AgentContext.effect('bus-unregister')`（ctor 登记，Phase 4 已接线） | `ctx.dispose()` 逆序释放 → bus.unregister(id) | ✅ ctx 所有权 |
| `agent.ts` setBus（legacy 直构路径，测试/spawn 兜底） | 调用方/spawn finally | spawnSubAgent finally 显式 unregister | ✅ 显式 |

## SubAgentPool（订阅型 + timer，Phase 4 新增条目）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| per-spawn 超时 setTimeout（`timeouts` map） | spawn → finish() 清除 | `ownedDisposer()` 原语已备（stopAll + 兜底清 timer，幂等） | ✅ Phase 4 决策：**owner=workspace/会话层**——池是会话级共享资源，挂单 Agent context 会在一个 Agent dispose 时误杀兄弟 Agent 在跑任务；会话停用时由 owner 消费（workspace 接线非本工程范围） |

## TaskBoard / DiscoveryBoard.register（内容型——board 条目，非订阅）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `agent.ts`（子 Agent board 条目） | TaskBoard（会话级） | merge/stop 时更新状态；会话销毁 `destroySessionBoards` | ✅ 生命周期化 |
| `runtime.ts`（启动恢复重放条目） | Runtime 恢复流程 | 状态重建，非新增订阅 | ✅ N/A |
| `task-board.ts`（proxy 转发） | TaskBoardProxy | 转发，无独立状态 | ✅ N/A |
| Agent 注销时的 board 条目清理（`unregister(agentId)`） | `AgentContext.effect('board-unregister')`（`_assembleAgent` 顶部登记，Phase 4 已接线；经 proxy 转发到该 Agent 终生绑定的会话板） | `ctx.dispose()` 逆序释放 | ✅ ctx 所有权 |

## 结论（Phase 4 后）

1. runtime 侧订阅型清理（lifecycle timer / bus / taskBoard 条目 / runtime maps）已全部收敛为 `AgentContext.effect()` 所有权，`_disposeAgent` 只保留 flush 前置序 + `ctx.dispose()`（specs/phase-4 T0 钉住）；
2. McpClient 与 SubAgentPool 保持 workspace/会话层所有权（共享资源，挂单 Agent ctx 会误伤兄弟）——disposer 原语均已备好，待 owner 侧消费；
3. 新增注册 API 纪律不变：默认返回 Disposer；不返回的登记豁免 + T0 gate 同步。
