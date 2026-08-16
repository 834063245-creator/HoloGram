# Agent Core Convergence — 进度表

> 计划：`agent-core-convergence-plan-2026-08-15.md` · 验证：`agent-core-convergence-verification-plan-2026-08-15.md`
> 分支：`feat/agent-gap-closure`
> 规则：每 phase 结束更新本表；决策检查点结论必须落盘。

## 状态总览

| Phase | 状态 | 说明 |
|---|---|---|
| 0 基线冻结 + V0 验证工程 | ✅ 完成 | 6 契约快照 + gate.mjs 落地，全量绿；独立审计有条件放行，条件已处置 |
| 1 Disposer 契约 + V1 | ✅ 完成 | 3 注册 API 返回 Disposer；startOwned/ownedDisposer；T0 门禁 + F8 快照 + F2 workflow |
| 2 工具管道类型化事件 + V2 | ✅ 完成 | AgentEventBus 双路径；12 场景差分 + pipeline 对拍 phase-0 冻结 baseline 逐字节一致 |
| 3 AgentContext 抽取 | ✅ 完成 | 三层收敛 26/11/12→0/0/0；wiring baseline 经审批冻结（828679fc）；决策 16-19 |
| 4 生命周期所有权统一 | ✅ 完成 | dispose 21→14 步收敛为 ctx 所有权；wiring baseline 经审批冻结（45f328a2）；决策 20-23 |
| 5 会话事件溯源日志 | ✅ 完成 | SessionLog 双写 + 14 变异点收敛三入口 + 11 场景差分 + session-projection 冻结（5e42c995）；决策 24-29 |
| 6 组合层收尾（可选） | ⬜ 未开始 | 视 Phase 5 收益决定 |

## Phase 0 / V0 记录（2026-08-16）

### 独立审计结论（2026-08-16，对抗性审计）

**有条件放行**。审计复算了全部自述数字（vitest 1030/1sk、tsc、biome 581/338、wiring 四项度量、8 条决策记录）——全部一致；确认 freeze 干净、baseline 真实钉住声称契约、门禁对诚实路径（漂移/缺失/无 env record）失败关闭。放行条件处置如下：

| 发现 | 严重度 | 处置 |
|---|---|---|
| F1 环境劫持：外部导出 `CONVERGENCE_RECORD=1` 可把 check 静默变成 record | major | ✅ **已修**：`runSpecs(check)` 显式剔除该 env；实测注入漂移 + 劫持 env 后 check 仍 exit 1、baseline 字节未被重写、stdout 报出差异行 |
| F2 门禁代码自身零锚定 + 零 CI 执行 | major | ⏳ 随 V1 落地：新增独立 workflow（不改 `ci.yml`，决策#5）+ baseline/gate 路径变更的机器可识别标记 |
| F3 check 失败时 stdout 无差异定位 | minor | ✅ **已修**：失败时 stdout 回显含 `[convergence] baseline` 的漂移/缺失行 |
| F4 `CONVERGENCE_PHASE` 可收窄执行范围 | minor | ⏳ V1 的 CI 固定不带 phase 跑全量 specs |
| F5 归一化宽度（plan-id / ISO 时间戳） | info | 维持现状；新增快照时 review 归一化命中面 |
| F6 compareText 末尾差异不可被掩盖 | info | 无需动作（审计确认行为正确） |
| F7 autocrlf 下 record 后 `git status` 可能有 stat 噪声 | info | 约定：审批 baseline 变更以 `git diff` 为准（diff 为空即内容未变） |
| F8 createAgent 运行时注册的工具 schema 无快照 | minor→major（随 phase 升） | ⏳ **范围已定**（见下），实现随 V1 |

**F8 范围决定（Phase 1/2 开工前条件）**：V1 新增 `tool-schemas.effective` 快照——用确定性 fixture 跑完 `createAgent` 完整注册后的模型可见 schema 面，至少覆盖 enter/exit_plan_mode、通信族（agent_message/inbox/ack/reply/list）、discovery 族（agent_discover/lookup）、子 Agent 管理族（agent_merge/board/kill/request/spawn 替换版）、task 替换版与 compaction 工具。引擎动态工具豁免维持（决策#1）。

审计放行条件核对：F1 已修 ✅；F2 随 V1 ⏳；F8 范围已定 ⏳ → **Phase 1 可以开工**（F2/F8 的实现属 V1 工作包，与 Phase 1 并行推进，不阻塞）。

## Phase 1 / V1 记录（2026-08-16）

### 交付物（4 个实现 commit + 1 个 baseline freeze commit）

| commit | 内容 |
|---|---|
| `be5b25e4` | `src/agent/lifecycle.ts`：Disposer / DisposerBag（逆序串行、单次、部分失败聚合）/ once / runInContext + 9 行为测试 |
| `3c022c3d` | `ToolRegistry.register` / `HookRegistry.register` / `PreflightHookRegistry.register` 返回幂等 Disposer（陈旧 disposer 不误删同名新工具）；`tool-registry-disposer.test.ts`（含 T5 100 次注册/释放归零）；`specs/phase-1.test.ts` T0 结构门禁 + `gate.mjs` T0 静态扫描（负向验证：签名改回 void → check 在 vitest 之前失败关闭） |
| `53943ced` | `AgentLifecycleManager.startOwned()` / `McpClient.ownedDisposer()` + 测试 |
| `644b0c39` | F8：`phase-1/tool-schemas.effective.json` baseline（空输入注册表跑真实 createAgent → converge 后 5 个模型可见工具：enter/exit_plan_mode、hologram_compaction_stats、agent、task） |
| （本 commit） | F2：`.github/workflows/convergence.yml`（独立 workflow，不动 ci.yml；无 CONVERGENCE_PHASE 全量跑；record 永不上 CI）；`docs/agents/REGISTRY_OWNERSHIP.md` 注册点所有权清单 |

### 验收核对（验证计划 §4 Phase 1）

- [x] T0：三个 register 签名返回 Disposer（spec + gate 双层，含豁免表机制）
- [x] T1：disposer 幂等 / 逆序 / async 等待 / 部分失败不阻断（lifecycle-disposer 9 例）
- [x] T5：100 次注册/释放 registry 归零
- [x] T3：Phase 0 全部快照不变（effective 快照通过 verify:convergence + 全量 vitest 双确认）
- [x] T4：全量 vitest 通过（终态实测 **1055 passed / 1 skipped**；新增测试 = lifecycle-disposer 9 + tool-registry-disposer 7 + lifecycle-owned 3 + phase-1 spec 5）
- [x] REGISTRY_OWNERSHIP.md 落盘：订阅型注册全部有对称清理；工具型随实例 GC；新增豁免须登记
- [x] 审计 F2/F4/F8 处置完成（F4 = CI 恒跑全量 specs）

### 决策与偏差记录（Phase 1 追加）

9. **runInContext 签名**：计划原文单参 `runInContext(register)`，落地为 `(bag, register, label)`——单参形式无处安放清理器；Phase 3 的 `AgentContext.effect()` 直接复用此组合。
10. **T0 双层实现**：spec 内断言（自描述、随 vitest 报告）+ gate.mjs 静态扫描（CI 可不跑 vitest 也拦得住）；两层共享"豁免需登记"纪律。
11. **现有调用点不强制消费 disposer**：REGISTRY_OWNERSHIP.md 论证订阅型已有对称清理、工具型随实例 GC；Phase 4 才接线 context effect。与计划"只加接口，先不改语义"一致。

### Phase 1 决策检查点（计划 §10）

> Phase 1 结束：若 disposer 契约没有让任何现有 bug 消失，仍继续 Phase 2（价值主要在未来）。

结论：**继续 Phase 2**。符合预期——Phase 1 价值在 Phase 3/4 的所有权接线；T5 泄漏检测与 startOwned 已为 worktree TTL 泄漏类问题提供了修复路径（docs/landmine-map.md 的 lifecycle 条目）。

## Phase 2 / V2 记录（2026-08-16）

### 交付物

- `src/agent/events.ts`（新）：`AGENT_EVENT_MAP`（tool/guard·waterfall / tool/preflight·serial / tool/around·waterfall / tool/result·emit / tool/error·emit）+ `AgentEventBus`（on→Disposer、优先级调度、runGuard 同步短路不吞异常、runPreflight 聚合 join '\n\n'、runAround 异步 waterfall、emitResult/emitError 广播）+ 过渡适配层 `attachPlanGate/attachPreflightRegistry/attachHookRegistry`（静默降级语义与旧 executor 逐点一致）。
- `agent-types.ts`：`ToolPipelineContext`（call/tool/args/agentId/signal/guardName）。
- `streaming-executor.ts`：构造参数新增第 8 位可选 `eventBus`；eventBus 存在时 guard/preflight/around/result/error 经 bus 驱动、且 ctor 的 planGate/hooks/preflightHooks 被忽略（适配器挂 bus）；缺省时旧直调路径原样保留。双发纪律：bus 事件 + legacy EventKind sink 同发，UI 零改动。
- `tests/tool-pipeline-events.test.ts`：T1 7 例（调度/短路/聚合/disposer）+ T2 12 场景差分（未知/隐藏/非法 JSON/HIGH/HIGH+forceGate/planGate/富化/hook 抛错/preflight 抛错/执行错误/AbortError/混合多调用）——两侧 PendingResult、sink 事件序列、异常行为逐项一致 + bus 事件结构性验证。
- convergence：trace 夹具抽到 `helpers/trace-fixtures.ts`（legacy/pipeline 双模式）；`specs/phase-2.test.ts` T0 mode 门禁 + **pipeline 路径直接对拍 phase-0/hook-pipeline.trace.json 冻结 baseline，逐字节一致**（不另立 baseline——新路径的等价性锚在人类审批的 legacy 行为上）；phase-0 spec 复用共享夹具后 baseline 零漂移。

### 验收核对（验证计划 §4 Phase 2）

- [x] T0：事件声明 mode 合法且五事件齐备（specs/phase-2）
- [x] T1：bus 各 mode 调度顺序与短路语义；listener disposer 移除
- [x] T2 核心差分：12 场景矩阵全过（覆盖验证计划要求的全部场景 + preflight 抛错 + 混合多调用）
- [x] T3：`hook-pipeline.trace.json` 逐项一致（双保险：phase-0 spec legacy 比对 + phase-2 spec pipeline 比对，同一 baseline）
- [x] T4：全量 vitest 1079 passed / 1 skipped（99 文件）；tsc 干净；触碰文件 biome 诊断 7→5（顺手清 2 存量，零新增）
- [x] 现有 hook/planGate 测试全绿（plan-gate / streaming-executor-hooks / agent-hooks / agent-exec 101 例）
- [x] tool schema 字节不变（phase-0/1 全部 baseline 经 verify:convergence 零漂移）

### 决策与偏差记录（Phase 2 追加）

12. **管道顺序镜像 legacy 而非计划清单序**：计划 §6 列的顺序是 preflight→planGate，但 legacy 实际顺序是 planGate（addTool 同步段）→ preflight（executeTool）；按计划 §9 风险表"新路径先镜像旧顺序"，落地为 guard→preflight→around→result/error，dispatch 同步短路的时序结构（completed vs pending）也逐点保留。
13. **guard 短路不吞异常**：legacy planGate 直调无 try/catch，bus.runGuard 同样传播——静默降级只属于 preflight/around（与旧代码容错点一致）。
14. **phase-2 不新增 baseline**：pipeline 路径的等价性直接对拍 phase-0 冻结 trace（同一快照名），避免"新路径自证新 baseline"的循环；单元级差分与收敛级对拍互为印证。
15. **双会话事故记录**：Phase 2 进行中另一会话把主工作区切回 main 并带入 graph 改动；对方迁往独立 worktree（D:/HoloGramHG-main）后无损恢复，WIP 曾备份于 D:/HoloGramHG-phase2-wip-backup（可删）。纪律：并发会话必须各自独占 worktree（与验证计划 §5.3 一致）。

### Phase 2 决策检查点（计划 §10）

> Phase 2 结束：若事件管道只是"换皮"，则说明工具阶段已经足够简单，降低 Phase 2 后续投入。

结论：**非换皮**——eventBus 已把 guard/preflight/around 三类裁决从 executor 硬编码中分离为可组合监听器（T1 证明可排序/短路/聚合），Phase 3 起 AgentContext 可将 planGate、guard、hook 以 effect() 声明式接入。按计划推进 Phase 3。

## Phase 3 / V3 记录（2026-08-16）

> 状态：**✅ 完成并冻结**（2026-08-16）。wiring baseline 变更经用户批准后落地
> （`baseline-change-request.md` → record → freeze commit `828679fc`）。

### 交付物

| commit | 内容 |
|---|---|
| `a0ad55b6` | `src/agent/context.ts`（AgentServices 14 服务 + AgentContext：身份只读 / get+resolve / set / effect=runInContext / child 白名单派生 / dispose 预留 Phase 4）+ agent.ts ctx 构造重载（legacy 逐字节不变；setBus/setSubAgentPool/setGoalManager write-through；spawnSubAgent 优先父 ctx.child() 派生）+ `tests/agent-context.test.ts` T1 规约 12 例。四门全绿（1091+1skip） |
| `aad8a9ce` | runtime.ts 三层重构：`createAgent`=翻译层适配器（config 直读 26→0）/ `_contextFromConfig`=唯一 config 消费点（26 字段全量翻译）/ `_materializeSessionServices`（board proxies / planState / execState 缺啥补啥写回 ctx）/ `_assembleAgent`=config-free 装配本体；`runtime/types.ts` 新增 `AgentAssemblyInputs` + `RuntimePort.createAgentFromContext`；wiring helper 按方法名提取（`extractRuntimeMethodWiring`）；`specs/phase-3.test.ts` 6 例 |
| `828679fc` | baseline freeze：`phase-0/create-agent.wiring.txt` 重写为收敛后事实（26/11/12→0/0/0，dispose 21 不变）。record 触碰的其余 6 快照内容逐字节未变（git diff 为空，status M 为 autocrlf stat 噪声——决策 #7） |

### 验收核对（验证计划 §4 Phase 3）

- [x] T0：createAgent config.* 直读 26→**0**（验收线 ≤15）；装配本体 `_assembleAgent` 零 config 直读；翻译层 26 字段完整性断言；AgentContext 公共成员 JSDoc（AST 检查）
- [x] T1：服务解析 / 缺依赖报错（报出服务名+agentId）/ effect 逆序+单项释放+dispose 幂等 / child 白名单继承与所有权独立（12 例）
- [x] T2：旧 AgentConfig 入口 vs 新 AgentContext 入口（ctx 手工构造不经翻译层）生成同一 AgentSummary / 同一工具 schema 面 / 同一 system prompt
- [x] T3：tool-schemas.full/plan/effective、system-prompt.fixture、plan-gate.decisions、hook-pipeline.trace **全部逐字节不变**；create-agent.wiring.txt 漂移经审批冻结（`828679fc`）
- [x] T4：全量 vitest 终态 **1097 passed / 1 skipped / 0 failed（101 文件）**（冻结前 1096+1failed=预期红；一次 translator-cache 偶发失败复跑即过，该测试零 agent 依赖，与本工程无关）；tsc 干净；触碰文件 biome 零新增（runtime.ts noExplicitAny 7→5 净减 2）
- [x] 主计划验收附加项：setter 接线 12→7（5 个入 Agent 构造，7 个留装配本体且其中 spawnSubAgent/applyAutoTuneConfig 非注入型）；`_disposeAgent` 21 步未动（Phase 4 对象）
- [x] wiring baseline freeze（审批 → record → freeze commit `828679fc`；record 后 git diff 仅 wiring.txt 一处内容变化）

### 决策与偏差记录（Phase 3 追加）

16. **AgentServices 字段名以代码现实为准**：计划的 `events` 落地为 `eventSink`（本仓领域词），`sessionLog` 留 Phase 5 不占位；另按实际依赖补 `subAgentPool`/`execState`/`memoryManager`/`preflightHooks` 服务（共 14）。`AgentContext` 在计划 5 个身份字段外增 `sessionId`（会话板路由键，物化层需要）与 `set`（setter write-through 目标）、`dispose`（Phase 4 前置契约）。
17. **三层结构而非把 config 读数挪进私有方法刷数字**：`createAgent` 是 3 行适配器（度量归零是结构事实）；防回潮由 phase-3 spec 三断言接管——createAgent ≤15 直读 + 零注册零 setter、`_assembleAgent` config-free、翻译层 26 字段完整性。度量语义（决策 #4 口径）不变，仍指向 createAgent 方法本体。
18. **两次真回归被门禁/断言拦截**：① 首版把 ctx.tools（输入注册表）装配给 Agent 而非克隆件 effR → phase-1 effective 快照报 count 5→0（T2 差分两路径同错未抓到——F8 快照价值实证）；② 翻译层漏 `config.execState`（workspace.ts:825 实际在传）→ 人工复核发现，修复后落地 26 字段完整性断言防同类回归。
19. **ctx 入口签名 `createAgentFromContext(ctx, inputs?)`**：inputs 承载非服务装配输入（提示词素材 graphData/graphContext/hooksEnabled/subAgentSpawner + 调优参数），Phase 6 blueprint 再收敛；会话级基础设施（proxies/planState/execState）由 `_materializeSessionServices` 缺啥补啥写回 ctx——子 Agent child() 与差分手工 ctx 都走同一物化路径。

### Phase 3 决策检查点（计划 §10）

> Phase 3 结束：评审 AgentContext 是否真的减少了装配复杂度；若 createAgent 复杂度没有下降，暂停 Phase 4。

结论：**复杂度实质下降，进入 Phase 4**（baseline 已批准冻结，判定生效）。证据：
- createAgent 26 个 config 直读、11 个注册点、12 个 setter 接线 → 0/0/0（装配迁入单一 config-free 本体）；
- spawnSubAgent 不再手工复制 7 项 opts + 3 个条件 setter，child() 白名单派生；
- Agent 构造从"opts 大杂烩 + 后置 setter 补线"变为 ctx 单一来源（bus 注册/隔离/store/pool 入构造）；
- 防回归代价：phase-3 spec 6 例（含 26 字段翻译完整性——比原 wiring 快照更强的定向断言）。

### 度量基线（Phase 3 后，freeze `828679fc` 已生效）

| 度量 | Phase 0 基线 | Phase 3 实测 | 变化 |
|---|---|---|---|
| `agent.ts` 行数 | 3059 | 3110 | +51（ctx 重载 + child 派生 + 注释；未拆分，符合禁令） |
| `createAgent` config.* 直读 | 26 | **0** | -100%（验收线 -40%） |
| `createAgent` 注册点 | 11 | 0（11 原序迁入 _assembleAgent） | 结构迁移 |
| `createAgent` setter 接线 | 12 | 0（5 入构造 / 7 留装配本体） | 结构迁移 |
| `_disposeAgent` 清理步骤 | 21 | 21 | 不变（Phase 4 对象） |

## Phase 4 / V4 记录（2026-08-16）

> 状态：**✅ 完成并冻结**（2026-08-16）。wiring dispose 段变更经用户批准后落地
> （`baseline-change-request.md` → record → freeze commit `45f328a2`）。

### 交付物

| commit | 内容 |
|---|---|
| `8c6279a8` | 生命周期原语备齐（行为中性）：`lifecycle.ts` DisposerBag **同步快通道**（非 Promise 清理器不产生微任务边界，全 sync 链在 dispose() 返回前完成；async 仍串行等待）；`coordinator.ts` `SubAgentPool.ownedDisposer()`（stopAll + 兜底清 timer，幂等）；`agent.ts` ctx 构造路径登记 `bus-unregister` effect；`tests/agent-context-dispose.test.ts` 6 例（幂等/并发单次/错误聚合可观测/后注册抛错/同步排空/终态只读）+ lifecycle-disposer 2 例 + agent-lifecycle-dispose 1 例 + coordinator 1 例。四门全绿（1107+1skip） |
| `aea5f905` | `runtime.ts`：装配期 effects 接线（board-unregister / lifecycle-manager 持有 startOwned / runtime-maps）+ `_disposeAgent` 重写（flush 前置序保持 → saveState → `ctx.dispose()` 逆序释放，聚合错误 log.warn）；`specs/phase-4.test.ts` 5 例（T0 静态×3 + T1 顺序 trace + T5 百次循环）；REGISTRY_OWNERSHIP.md 终态 |
| `45f328a2` | baseline freeze：wiring dispose 段 21→14（record 后 git diff 仅此一处内容变化，其余 6 快照 diff 为空——决策 #7 autocrlf 口径） |

### 验收核对（验证计划 §4 Phase 4）

- [x] T0：_disposeAgent 无分散清理调用（`_lifecycleManagers`/`unregister(`/`.stop(`/maps `.delete`，豁免表空）；_assembleAgent ≥3 处 ctx.effect；dispose 步骤 21→**14**（≤16 门禁）
- [x] T1：dispose 幂等 / 并发单次 / 错误聚合可观测 / 后注册抛错（agent-context-dispose 6 例）；顺序 trace：flush 计时器清 → flush → saveState → 逆序 effects（bus 注销先于 board 注销，与旧代码相对序一致）
- [x] T2（映射实现）：旧 dispose 行为的预言由既有栅栏承担（agent-lifecycle-dispose 同步可观测断言 + taskboard-session-routing + 新增双 dispose 单次注销观测）；新路径顺序由 trace 测试钉住——未保留双路径（dispose 无"可选参数"式分叉，保留双路径会复活分散清理）
- [x] T5：fake timers 百次 create/dispose——每轮 +1 巡检 timer、dispose 归零，注册表/总线终态全空
- [x] T3：其余全部快照逐字节不变；wiring dispose 段漂移 = 本申请对象
- [x] T4：全量 vitest 1111 passed / 1 skipped / 1 failed（唯一 failed 即 wiring 比对，预期红）；tsc 干净；触碰文件 biome 零新增
- [x] wiring baseline freeze（审批 → record → freeze commit `45f328a2`）；冻结后终态：verify:convergence exit 0，全量 vitest **1112 passed / 1 skipped / 0 failed（103 文件）**

### 决策与偏差记录（Phase 4 追加）

20. **DisposerBag 同步快通道**：`_disposeAgent` 的同步可观测语义（dispose() 返回后 listAgents/bus 立即为空，agent-lifecycle-dispose 钉住）要求全 sync effect 链不跨微任务——dispose() 改为条件 await（返回非 Promise 的清理器直接继续）。规约 1-5 不变（async 仍串行等待），新增 2 个行为测试。
21. **McpClient / SubAgentPool 不挂单 Agent ctx**：两者都是跨 Agent 共享资源（MCP 连接 / 会话级子 Agent 池），挂单 Agent context 会在该 Agent dispose 时掐断兄弟 Agent 的工具面或在跑任务——与主计划 §6 Phase 4 的字面清单偏差，按"代码现实优先"落地为：disposer 原语齐备（ownedDisposer），owner 保持 workspace/会话层，REGISTRY_OWNERS.md 登记决策。
22. **T2 不做双路径差分**：Phase 2 的 executor 有天然的"eventBus 可选参数"分叉点，dispose 没有等价物——保留旧 _disposeAgent 作为第二路径等于复活分散清理分支。等价性改由"既有栅栏（旧行为的预言）+ 新路径 trace"组合承担。
23. **effect 释放顺序与旧代码相对序一致**：bus 注销先于 board 注销（ctor effect 晚于装配顶部的 board effect 注册 → 逆序释放时先跑），与旧 `_disposeAgent` 中 `bus.unregister → taskBoard.unregister` 顺序相同；runtime-maps effect 末端注册最先释放，保证同步可见。

### Phase 4 决策检查点（计划 §10）

> Phase 4 结束：确认生命周期统一是否带来可测的泄漏减少；否则不进入 Phase 5。

结论：**可测泄漏减少成立，进入 Phase 5**（baseline 已批准冻结，判定生效）。证据：
- T5：百次循环 timer 数严格归零（旧路径依赖 7 个手工清理步骤的"都记得调"，新路径所有权随构造登记、释放不可绕过）；
- 防回归代价：phase-4 T0 禁止片段——任何把分散清理写回 _disposeAgent 的尝试在 gate 即失败；
- REGISTRY_OWNERSHIP 清单闭环：runtime 侧订阅型注册 100% ctx 所有权，共享资源（MCP/pool）显式豁免并备好原语。


### 基线（freeze point：分支自 main 67f21ec2 切出）

| 项 | 结果 |
|---|---|
| `npx vitest run` | 1021 passed / 1 skipped（92 文件），52.11s；加入 convergence 9 例后为 **1030 / 1 skipped（93 文件），61.02s** |
| `npx tsc --noEmit` | 通过（exit 0） |
| `npm run build` | 通过（tsc + vite build 全绿，exit 0） |
| `npx biome ci .` | 实测 581 errors / 338 warnings：新增文件零诊断；较 AGENTS.md 记录的 501/338 多出的 80 errors 来自基线测量（HEAD 5bb3bd7）之后的既有提交，非本工程引入，不顺手清 |

### 度量基线（Phase 3/4 的收敛目标对照）

| 度量 | 当前值 | 来源 |
|---|---|---|
| `agent.ts` 行数 | 3059 | wc -l |
| `AgentConfig` 字段 | 31（3 必填 + 28 可选） | runtime/types.ts |
| `createAgent` config.* 直读 | 26 | create-agent.wiring.txt |
| `createAgent` 注册点（effR/r.register） | 11 | 同上 |
| `newAgent.setX` 接线调用 | 12 | 同上 |
| `_disposeAgent` 顶层清理步骤 | 21 | 同上 |
| 标准注册表模型可见工具 | 见 tool-schemas.full.json count | 快照 |

### 验证工程落地物

- `src-ui/tests/convergence/`：gate.mjs（check/record/report）+ helpers（normalize/snapshot/differential/fixtures/wiring）+ specs/phase-0.test.ts（9 例：6 快照 + 3 机制自检）+ baseline/phase-0/（6 契约快照）+ README（人类协议入口）。
- npm scripts：`test:convergence` / `verify:convergence` / `record:convergence` / `report:convergence`。
- biome.json `files.includes` 排除 `tests/convergence/baseline` 与 `reports`（生成物不进格式门禁）；`reports/` 已 gitignore。
- 门禁自证：故意注入 baseline 漂移 → check 精确报出差异行并 exit 1（负向验证通过）；`gate.mjs record` 无显式 `CONVERGENCE_RECORD=1` 时拒绝执行（exit 2）；record 幂等重写（内容字节不变）。

### 决策与偏差记录

1. **引擎动态工具不进快照**：`loadHologramSchemas()` 测试环境（无 Tauri bridge）恒返回 `[]`，属环境决定非代码决定；引擎侧工具面由 Rust 测试与 RPC 契约文档守护。快照内已注明。
2. **record 触发方式**：验证计划原文 `CONVERGENCE_RECORD=1 node ...` 前缀式 env 在 Windows npm-scripts 下不可移植，改用 `cross-env`（项目既有依赖）实现等价语义；gate.mjs 内保留 env 守卫（缺 env 拒绝执行）。
3. **Vite 静态改写规避**：`new URL(字面量, import.meta.url)` 会被 Vite 改写为 dev-server origin；snapshot 路径解析经中间变量绕开改写 + cwd 兜底（helpers/snapshot.ts 有注释）。
4. **wiring 度量口径**：config.* 按"属性名去重后出现顺序"计（26 项）；注册点含循环体（`loop:t` 等）；清理步骤按 `_disposeAgent` 顶层语句数计（21）。Phase 3/4 验收以此口径对比。
5. **CI**：仓库规则禁止修改 `.github/workflows/ci.yml`；验证计划的 verify-convergence job 将来若需要，以**新增独立 workflow 文件**实现，不改既有文件。
6. **freeze commit 粒度**：V0 骨架（gate/helpers/scripts/biome 排除）与 phase-0 baseline 同 commit 提交——拆开会让前一 commit 在无 baseline 时红测试，违反"每 commit 行为中性"；该 commit 不含任何 `src/agent` 改动，满足 freeze 的实质约束。
7. **biome 存量漂移**：`biome ci .` 实测 581/338（AGENTS.md 记录 501/338），差额 80 errors 属既有提交的漂移；本工程新增文件零诊断，维持"不顺手清存量"纪律。
8. **根 .gitignore 的 `specs/` 全局规则误伤测试代码**：该规则为历史 markdown 文档目录而设，会忽略任何名为 specs 的目录；在根 .gitignore 末尾加精确否定 `!src-ui/tests/convergence/specs/` 解决（不改原规则语义）。

### Phase 0 验收核对

- [x] 基线与度量表落盘（本文件）
- [x] 8 个关键回归套件存在性确认（agent-exec / agent-hooks / streaming-executor-hooks / agent-lifecycle-dispose / lifecycle-integration / plan-gate / message-bus / coordinator）
- [x] 契约快照 6 件全部采集且 check 模式绿
- [x] 门禁脚本自身被测试（compareText/stableStringify/runDifferential 自检 + 负向漂移验证）

## Phase 5 / V5 记录（2026-08-16）

> 状态：**✅ 完成并冻结**（2026-08-16）。新增 baseline `phase-5/session-projection.trace.json`
> 经 record 幂等验证后 freeze（`5e42c995`）——**待用户过目**（交接协议 §9）。

### 交付物

| commit | 内容 |
|---|---|
| `bfa5bc91` | `src/agent/session-log.ts`（SessionEvent 封闭可扩展 9 kind + SessionLog：append 严格递增 / appendEvent 重复乱序拒绝 / snapshot / replay / deriveMessages / derivePayload 复刻压缩+工具折叠 / onEvent 内部事件）+ `buildCompactedSummaryMessage` 单一实现 + `tests/session-log.test.ts` 15 例 + `tests/session-replay.test.ts` 5 例。行为中性（未接线） |
| `40ae6355` | 双写接线：agent.ts 14 处 session 变异点收敛到三入口（`_appendMessage`/`_replaceSession`/`_retractSessionRange`）+ runLoop 边界事件（turn/start、tool/call 审计）+ `_applyCompactState` 压缩事件 + payloadMessages 摘要构造来源替换（字节同源）；saveState 事件增量追加（`_persistedEventSeq` 永不重置 + `_eventAppendChain` 写链防并发重复 seq）；agent-store `appendSessionEvents`（log_append 真追加 session-log.ndjson）；context.ts `sessionLog` 服务位 + runtime `_materializeSessionServices` 物化（createAgent/_disposeAgent 本体零改动 → wiring 零漂移）；gate.mjs phase-5 T0 静态扫描（负向验证通过）+ `specs/phase-5.test.ts` 6 例 + `tests/session-differential.test.ts` T2 差分 11 场景 |
| `5e42c995` | baseline freeze：`phase-5/session-projection.trace.json`（15 事件全序 + 6 逐步派生载荷）；二次 record 字节不变；既有 6 快照 git diff 零漂移 |
| （本 commit） | progress.md Phase 5 记录 + plans 索引更新 + handoff-phase6 交接文档 |

### 验收核对（验证计划 §4 Phase 5）

- [x] T0：session event 类型封闭可扩展（SESSION_EVENT_KINDS 冻结 + Record 编译期对齐 + 主计划 7 kind 齐备）；seq 严格递增由运行检查保证（appendEvent 重复/乱序抛错）；日志接入后 agent.ts 直改 session 仅存在于三入口与构造初始化（spec AST 白名单 + gate.mjs 计数扫描双层，负向验证：注入违规 push → check 在 vitest 前失败关闭）
- [x] T1：append / snapshot / deriveMessages / replay / 重复 append 拒绝 / 投影与旧 session 等价（session-log 15 例 + session-replay 5 例 + spec 2 例）
- [x] T2 核心差分：11 场景矩阵——每步 provider 请求消息（请求时刻快照日志投影，字节级对拍）、compaction 边界（事件 tailStart 镜像 `_compactTailStart` + 压缩后请求含 `<compacted-context>`）、retract 后投影（含折叠保留 + tailStart 越界钳制）、多工具批、insertMessage 安全边界、setSession/newSession（折叠失效语义）、window>0 工具折叠（方法级：镜像边界前值单次推进与旧路径逐字节相等）、持久化双写（P1-15 游标钉住 + ndjson 事件回放重建投影）
- [x] T3：新增 `session-projection.trace.json` 冻结（固定场景 15 事件 + 6 载荷步）；既有全部快照（tool-schemas.full/plan/effective、system-prompt.fixture、plan-gate.decisions、hook-pipeline.trace、create-agent.wiring）git diff 内容零漂移
- [x] T4：全量 vitest 终态 **1150 passed / 1 skipped / 0 failed（107 文件）**；tsc 干净；`npm run build` 绿；重点重跑 compaction-pipeline / compaction-model / session-sync / agent-store-incremental / goal-persistence / agent-session-state / agent-exec / agent-lifecycle-dispose（8 套件 90 例全绿）
- [x] 主计划验收附加项：模型请求消息可由 session log 派生（derivePayload）；旧持久化文件仍可读（恢复路径零改动）；关键模型可见路径有事件记录（turn/start、tool/call、tool/result、session/compaction）

### 决策与偏差记录（Phase 5 追加）

24. **事件 kind 超 7 种（+session/reset、session/retract）**：主计划列举 7 kind 覆盖不了既有会话变异面（setSession/newSession/goal 清场是整体替换、retractTurnAt/goal 暂停是区间裁剪）。按"封闭可扩展"落地为 9 kind——reset 事件携带深拷贝快照（调用方后续改动不得回写历史），retract 事件携带 [from,to) splice 语义。`assistant/reasoning` 按计划保留 kind 但双写阶段不发射（reasoning 已在 assistant/text 消息内，单一事实源）。
25. **`tool/call` 为审计记录不参与投影**：assistant 消息内嵌 tool_calls 已是投影事实源；每调用一条的 tool/call 事件仅供审计与未来回放，deriveMessages 跳过。避免双源漂移。
26. **`_toolFoldBoundary` 不入事件流，derivePayload 显式镜像**：折叠边界是 payloadMessages 调用序列的累积态（每步 2-4 次调用、跨步收敛到不动点），从事件重算只能得到无状态近似。诚实边界：derivePayload 接收调用前边界值并在内部执行同样的 nextFoldBoundary 单次推进——与旧路径同起同进，任何状态逐字节相等（差分测试钉住）；请求级对拍限 window=0（生产默认，边界恒 0）。
27. **session/event 落地为 SessionLog.onEvent 订阅面，不加 AgentEventBus 第 6 事件**：Agent 不持有 eventBus（Phase 2 后 executor 才持有），挂上去是死代码；bus 是执行管道机制，会话日志不与之耦合。onEvent 返回 Disposer（Phase 1 契约），UI/EventSink 零改动。
28. **事件持久化在 agent-store.ts 而非交接文档写的 message-store.ts**：message-store.ts 是 inbox 持久化（JsonMessageStore）；会话持久化与 `_persistedMsgCount`（P1-15）都在 agent-store.ts。按"代码现实优先"落在 agent-store.ts，经 `log_append` RPC 真追加（`OpenOptions.create+append`），不改 Rust、不动 agent_session_append。
29. **`_eventAppendChain` 写链**：run() 结尾 fire-and-forget saveState 与显式/dispose saveState 并发时会读到同一事件游标重复追加（ndjson 出现重复 seq，回放即拒绝）。按 P1-13 `_indexChain` 模式按调用序串行化——差分测试曾真实抓到该竞态（修复前落盘事件 14 条含重复，修复后精确 7 条）。

### Phase 5 决策检查点（计划 §10）

> Phase 5 结束：重新评估是否值得迁移到 DSH。届时如果触发线（多表面运行、第三方插件生态、可续聊子 Agent、模型自修改）仍未出现，继续自有 runtime。

结论：**触发线未出现，继续自有 runtime**。四原语（Context / Effect-Disposer / 类型化事件 / 事件溯源日志）全部落地，DoD 1-7 逐项达成（见下）；DSH 迁移的收益场景（多表面/插件生态/可续聊子 Agent/模型自修改）当前均不存在，而垂直机制（worktree 隔离、merge gate、boards、图引擎）仍是 HoloGram 护城河。Phase 6（组合层收尾）为可选项，视后续新增工具/hook 的装配痛点再启动。

### 完成定义（DoD）核对（主计划 §11）

1. [x] 注册点返回 disposer 且有 owner（Phase 1/4 + REGISTRY_OWNERSHIP.md）
2. [x] 工具执行策略可由类型化事件组合表达（Phase 2 eventBus）
3. [x] Agent 创建不再 30 字段手工装配（Phase 3 三层收敛 0/0/0）
4. [x] `AgentHandle.dispose()` 唯一 teardown 且可等待 quiescence（Phase 4 ctx 所有权）
5. [x] 模型请求消息可从 session log 派生（Phase 5 derivePayload，差分+冻结快照钉住）
6. [x] 全部旧测试 + 新测试通过，tool schema 与模型可见输出零漂移（1150/1 + verify:convergence exit 0）
7. [x] 进度与决策记录更新到本文件（决策 1-29 + 检查点结论）

## 决策检查点（汇总）

- Phase 1 结束：继续 Phase 2（价值在未来所有权接线）
- Phase 2 结束：非换皮，按计划推进 Phase 3
- Phase 3 结束：复杂度实质下降（26/11/12→0/0/0），进入 Phase 4（2026-08-16）
- Phase 4 结束：可测泄漏减少成立（T5 百次归零 + T0 禁止片段），进入 Phase 5（2026-08-16）
- Phase 5 结束：触发线未出现，继续自有 runtime；Phase 6 可选（2026-08-16）
