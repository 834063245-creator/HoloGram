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
| `runtime/runtime.ts:666` `lifecycle.start()`（60s 巡检 interval） | `runtime._lifecycleManagers` map | `_disposeAgent`（runtime.ts:768）`stop()`；重复创建时 :649 先 stop 旧实例 | ✅ 显式（双保险） |
| — | — | Phase 4 迁移：改由 `context.effect()` 持有 `startOwned()` 返回的 disposer | ⏳ Phase 4 |

## McpClient（连接型）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `runtime/agent-builder.ts:464`（client 工具注册进 registry） | Runtime/UI（MCP 会话管理） | `disconnect()` 幂等（未连接 no-op）；`ownedDisposer()` 已备，调用方未消费 | ⚠️ 依赖调用方；Phase 4 接线 context effect |

## MessageBus.register（订阅型）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `agent.ts:612`（setBus → bus.register(addr)） | Agent 实例 | `_disposeAgent`（runtime.ts:770）`bus.unregister(id)` | ✅ 显式 |

## TaskBoard / DiscoveryBoard.register（内容型——board 条目，非订阅）

| 注册点 | owner | 清理点 | 自动清理 |
|---|---|---|---|
| `agent.ts:2559`（子 Agent board 条目） | TaskBoard（会话级） | merge/stop 时更新状态；会话销毁 `destroySessionBoards` | ✅ 生命周期化 |
| `runtime/runtime.ts:329`（启动恢复重放条目） | Runtime 恢复流程 | 状态重建，非新增订阅 | ✅ N/A |
| `task-board.ts:278`（proxy 转发） | TaskBoardProxy | 转发，无独立状态 | ✅ N/A |

## 结论（Phase 1 基线）

1. 订阅型注册（bus / lifecycle timer / hooks）在现有代码里都有对称清理或随实例释放，无已知泄漏路径；
2. 工具型注册全部随 Agent 实例整体 GC——Phase 1 的 disposer 契约是为 Phase 3/4 的 context 所有权做准备，不要求现有调用点立即消费；
3. Phase 1 后的新增注册 API：默认返回 Disposer；确不返回的必须在本清单登记豁免 + 原因，且 T0 gate（`tests/convergence/specs/phase-1.test.ts` + `gate.mjs`）同步豁免表。
