# Baseline 变更申请 — phase-0/create-agent.wiring.txt

> 申请日期：2026-08-16 · 申请人：Phase 3 实现 Agent（agent-core-convergence）
> 状态：**待用户审批** — 审批通过前不执行 record，runtime 侧实现改动保持未提交。
> 依据：验证计划 §3.3（唯一合法场景 1：工程明确决定的结构收敛）；交接文档 §5 V3 T3
> 已预声明"这条 baseline 在 Phase 3 必然要变——wiring 收敛正是目的"。

## 1. 变更对象

仅 **1 个文件**：`src-ui/tests/convergence/baseline/phase-0/create-agent.wiring.txt`。

同一次 gate check 中其余全部快照**逐字节一致、零漂移**（已实测）：
`tool-schemas.full.json` / `tool-schemas.plan.json` / `phase-1/tool-schemas.effective.json` /
`system-prompt.fixture.json` / `plan-gate.decisions.json` / `hook-pipeline.trace.json`。
即：**模型可见表面（工具 schema 面 / system prompt / 执行管道行为）没有任何变化**，
漂移的只是 createAgent 的装配结构度量。

## 2. 为什么必须变

Phase 3 把 `createAgent` 从"26 字段手工装配"收敛为三层结构：

| 层 | 职责 | config.* 直读 |
|---|---|---|
| `createAgent(config)` | 纯翻译层适配器（3 行） | **0** |
| `_contextFromConfig` | AgentConfig → AgentContext + AssemblyInputs 翻译（唯一 config 消费点） | 26（全部历史字段） |
| `_assembleAgent(ctx, inputs)` | 装配本体，只消费 ctx + inputs | **0** |

wiring 快照的度量对象是 `createAgent` 方法本体——装配逻辑整体迁出后，
四个度量位（config 读 / 注册点 / setter 接线 / 清理步骤）中前三个归零是结构事实，
不是把逻辑藏进私有方法刷数字：装配本体的防回归由 specs/phase-3 的三条新断言接管
（见 §4）。

## 3. 度量变化明细（旧 → 拟议新）

| 度量 | Phase 0 基线 | 拟议新值 | 说明 |
|---|---|---|---|
| `config_reads` | 26 | **0** | 全部 26 字段经 `_contextFromConfig` 翻译（specs/phase-3 断言逐字段核对） |
| `register_calls` | 11 | **0** | 11 个注册点原序迁入 `_assembleAgent`（实测清单一致：loop:t / enter / exit / loop:tool ×2 / merge / boardStatus / kill / request / subAgent / loop:taskTool）——tool-schemas.effective 字节不变佐证注册序未动 |
| `setter_wiring` | 12 | **0** | 5 个 setter（setBus/setAgentStore/setGoalManager/setSubAgentPool/setDiscoveryBoard）改为 Agent 构造内经 ctx 完成；7 个（setCompactionConfigPath/spawnSubAgent/setHooks/setPreflightHooks/setPlanState/setPreRunHook/applyAutoTuneConfig）留在 `_assembleAgent` |
| `dispose_cleanup_steps` | 21 | **21（不变）** | `_disposeAgent` 未动——这是 Phase 4 的度量对象 |

主计划 §6 Phase 3 验收线："直接字段赋值数量至少下降 40%"——实际 26→0（-100%）。

## 4. 防自证措施（结构门禁如何接管度量）

`tests/convergence/specs/phase-3.test.ts`（新，6 例）：

1. `createAgent` config 直读 ≤ 15（验收线，宽松上限防回潮）；
2. `createAgent` 零注册/零 setter（纯适配器结构断言）；
3. **`_assembleAgent` 零 config 直读**——装配本体不得绕过翻译层直接摸 AgentConfig；
4. **翻译完整性**：Phase 0 基线 26 字段必须全部出现在 `_contextFromConfig` 消费面
   （漏字段 = 静默丢弃调用方配置，`execState` 漏配即以此方式发现并修复）；
5. AgentContext 公共成员必须有 JSDoc（AST 检查）；
6. T2 差分：旧 AgentConfig 入口 vs 新 AgentContext 入口（ctx 手工构造、不经翻译层）
   生成同一 AgentSummary / 同一工具 schema 面 / 同一 system prompt。

## 5. 实现过程中门禁拦截的真回归（证据：验证工程有效）

- **F-ctx-tools**：首版把 ctx 的 `tools` 服务（=调用方输入注册表）直接装配给 Agent，
  克隆件 `effR` 没接上 → `phase-1/tool-schemas.effective.json` 立即报 count 5→0。
  T2 差分未抓到（两路径同错）——F8 快照正是为此存在。已修：克隆件写回 `ctx.set('tools', r)`。
- **F-execState**：翻译层漏了 `config.execState`（workspace.ts:825 实际在传）
  → Agent 会拿到新建实例而非面板共享执行状态。已修：翻译层显式注册该服务，
  并落地 §4.4 的 26 字段完整性断言。

## 6. 拟议新 baseline 全文（record 将生成的内容）

```text
# createAgent / _disposeAgent 装配清单（AST 静态提取）
# 来源: src/agent/runtime/runtime.ts
# 用途: Phase 3/4 收敛度量基线 — config.* 直读数、注册点数、setter 接线数、清理步骤数

config_reads (0):

register_calls (0):

setter_wiring (0):

dispose_cleanup_steps (21):
  - const handle = this.agents.get(id);
  - if (!handle) return;
  - const sessionId = this._agentSessions.get(id) ?? 'default';
  - const taskBoard = this._taskBoards.get(sessionId);
  - const discoveryBoard = this._discoveryBoards.get(sessionId);
  - this._bus.clearFlushTimer();
  - taskBoard?.clearFlushTimer();
  - discoveryBoard?.clearFlushTimer();
  - void this._bus.flush();
  - void taskBoard?.flush();
  - void discoveryBoard?.flush();
  - handle 
  - this._lifecycleManagers.get(id)?.stop();
  - this._lifecycleManagers.delete(id);
  - this._bus.unregister(id);
  - taskBoard?.unregister(id);
  - this._agentProxies.delete(id);
  - this._agentSessions.delete(id);
  - this._agentTaskManagers.delete(id);
  - this.agents.delete(id);
  - log.info('runtime', `agent destroyed: ${id}`);
```

（dispose 21 步与 Phase 0 基线完全一致；record 实际输出以上文为准。）

## 7. 验证证据（申请时点）

| 门禁 | 结果 |
|---|---|
| 全量 vitest | **1096 passed / 1 skipped / 1 failed**——唯一 failed 即本申请针对的 wiring 快照比对（预期红） |
| tsc --noEmit | 干净（exit 0） |
| biome（触碰文件） | 零新增诊断（runtime.ts noExplicitAny 7→5，净减 2；其余与 HEAD 持平） |
| verify:convergence | exit 1，报告仅列 `phase-0/create-agent.wiring.txt` 一处漂移 |

已提交的绿色部分：commit `a0ad55b6`（context.ts + agent.ts ctx 重载 + T1 测试 12 例，
四门全绿）。待本申请获批后提交：runtime 三层重构 + specs/phase-3 + wiring helper 扩展。

## 8. 获批后的落地步骤（供审批人核对）

1. 提交实现 commit（runtime.ts / runtime/types.ts / wiring.ts helper / specs/phase-3.test.ts
   + 本文件 + progress.md 更新）——该 commit 的 gate 状态 = §7（wiring 一项预期红）；
2. `npm run record:convergence` 重写 baseline，独立 freeze commit：
   `test(convergence): freeze phase-3 wiring baseline`；
3. record 后 `git diff` 应只显示 `create-agent.wiring.txt` 变化（autocrlf 噪声以 diff 为准，
   决策 #7）；
4. 复跑 verify:convergence + 全量 vitest → 全绿（预期 1096+1skip，0 failed）。
