# Baseline 变更申请 — phase-0/create-agent.wiring.txt（Phase 4：dispose 段）

> ⚠️ 状态：**已批准并执行完毕**（2026-08-16）——freeze commit `45f328a2`。
> 本文件同时是 Phase 3 申请（wiring 0/0/0 段，freeze `828679fc`）的执行记录与后续
> 申请的模板：既有快照漂移时，按本格式重写此文件（对象/理由/证据/拟议内容/
> 落地步骤），停工等用户审批。

> 申请日期：2026-08-16 · 申请人：Phase 4 实现 Agent（agent-core-convergence）
> ~~状态：待用户审批~~ 已批准执行（见顶部墓碑）。原文如下存档：
> 前例：Phase 3 的同类申请已获批执行（freeze commit `828679fc`）；本申请只涉及
> 同一文件的 `dispose_cleanup_steps` 段。**模型可见表面零变化**（其余全部快照
> 逐字节一致，含 tool-schemas.* 与 system-prompt.fixture）。

## 1. 变更对象

仅 `src-ui/tests/convergence/baseline/phase-0/create-agent.wiring.txt` 的
**dispose_cleanup_steps 段**：21 → **14**。同一次 gate check 其余快照零漂移。

## 2. 为什么必须变

Phase 4 把 `_disposeAgent` 的分散清理收敛为 ctx 所有权（主计划 §6 Phase 4 验收：
"`_disposeAgent` 不再包含分散的 timer/board/bus 清理分支"）。被移除的 7 个顶层步骤
全部转为装配期登记的 `AgentContext.effect()`，由 `ctx.dispose()` 逆序释放：

| 旧步骤（21 中的 7 步） | 去向 |
|---|---|
| `_lifecycleManagers.get(id)?.stop()` | `ctx.effect` 持有 `lifecycle.startOwned()`（Phase 1 原语） |
| `_lifecycleManagers.delete(id)` | 同上 effect 内 |
| `this._bus.unregister(id)` | Agent ctor 登记的 `bus-unregister` effect |
| `taskBoard?.unregister(id)` | `_assembleAgent` 顶部登记的 `board-unregister` effect（经 proxy 转发） |
| `_agentProxies/_agentSessions/_agentTaskManagers.delete(id)` | 末端登记的 `runtime-maps` effect |
| `agents.delete(id)` | 同上 |

保留的 14 步：幂等早退 + 会话板查找 + flush 前置序（clearFlushTimer×3 → flush×3）
+ saveState('done') + `ctx.dispose()`（聚合错误 log.warn 可观测）+ 日志——
**顺序铁律 bus/board flush → saveState → effects 与 Phase 4 前一致**（trace 测试钉住）。

## 3. 行为等价证据（V4 验证规格）

- **T1 顺序 trace**（specs/phase-4）：flush 计时器清 → bus/board flush → saveState →
  逆序 effects（bus 注销 → board 注销——与旧代码相对顺序一致）；dispose() 返回后
  listAgents/bus 状态同步可观测（依赖本次为 DisposerBag 加的同步快通道）；
- **T5 泄漏**：fake timers 下 create/dispose 百次循环，每轮恰好 +1 巡检 timer、
  dispose 归零，注册表/总线终态全空；
- **T0 静态**：_disposeAgent 禁止片段（`_lifecycleManagers`/`unregister(`/`.stop(`/
  maps `.delete`）；`_assembleAgent` 必须 ≥3 处 `ctx.effect`；dispose 步骤 ≤16；
- 现有栅栏全绿：agent-lifecycle-dispose（含新增双 dispose 单次注销观测）、
  taskboard-session-routing、lifecycle-disposer、agent-context、coordinator；
- 全量 vitest：**1111 passed / 1 skipped / 1 failed（唯一 failed 即本比对，预期红）**；
  tsc 干净；触碰文件 biome 零新增（coordinator.test.ts 存量 19 条 nonNull 持平）。

## 4. 拟议新 dispose 段（record 将生成的内容）

```text
dispose_cleanup_steps (14):
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
  - handle 
  - log.info('runtime', `agent destroyed: ${id}`);
```

（config_reads/register_calls/setter_wiring 三段维持 Phase 3 冻结值 0/0/0 不变。）

## 5. 获批后的落地步骤

1. 提交实现 commit（runtime.ts effects 接线 + _disposeAgent 重写 + specs/phase-4 +
   REGISTRY_OWNERSHIP.md 终态 + 本文件 + progress.md）；
2. `npm run record:convergence` → 独立 freeze commit
   `test(convergence): freeze phase-4 wiring baseline`；
3. record 后 `git diff` 应仅本文件 dispose 段变化（autocrlf stat 噪声以 diff 为准，
   决策 #7）；
4. 复跑 verify:convergence + 全量 vitest → 全绿（预期 1112 passed / 1 skipped / 0 failed）。
