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
| 3 AgentContext 抽取 | ⬜ 未开始 | |
| 4 生命周期所有权统一 | ⬜ 未开始 | |
| 5 会话事件溯源日志 | ⬜ 未开始 | |
| 6 组合层收尾（可选） | ⬜ 未开始 | |

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

## 决策检查点（待填）

- Phase 1 结束：＿
- Phase 2 结束：＿
- Phase 3 结束：＿
- Phase 4 结束：＿
- Phase 5 结束：＿
