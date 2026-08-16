# Agent Core Convergence — Phase 5 交接文档

> 交接日期：2026-08-16 · 交接点：Phase 4 完毕（commit `3088b68b`）
> 接手者：下一个实现窗口（建议干净窗口整窗投入——Phase 5 是 XL 规模）。本文自包含开工所需全部事实；细节以链接文档为准。
> 前任交接文档 `agent-core-convergence-handoff-phase3.md` 已成历史，勿作现状依据。

## 1. 工程一句话

HoloGram 自有 Agent 运行时（`src-ui/src/agent/`）向 Cordis 设计原语收敛——不换运行时、不改模型可见行为，四个原语：Context、Effect/Disposer、类型化事件、事件溯源日志。**前三个原语已全部落地，只剩第四个（事件溯源）= Phase 5。**

## 2. 当前状态（2026-08-16 收工时）

| 项 | 状态 |
|---|---|
| 分支 | `feat/agent-gap-closure`，领先 main **20 commits**（`5ff78821`…`3088b68b`） |
| Phase 0/V0 | ✅ 基线冻结 + gate.mjs + 6 契约快照；独立对抗审计有条件放行，条件全部处置 |
| Phase 1/V1 | ✅ Disposer 契约（3 register API 返回清理器）+ startOwned/ownedDisposer + F8 effective 快照 + 独立 CI workflow |
| Phase 2/V2 | ✅ AgentEventBus 五事件双路径；12 场景差分 + pipeline 对拍 phase-0 冻结 baseline 逐字节一致 |
| Phase 3/V3 | ✅ AgentContext 抽取：createAgent 三层收敛（翻译层/context 入口/config-free 装配本体），wiring 26/11/12→0/0/0，baseline 经审批冻结（`828679fc`） |
| Phase 4/V4 | ✅ 生命周期所有权统一：`_disposeAgent` 21→14 步，7 个分散清理收敛为 ctx effects（T0 禁止片段 + T5 百次循环零泄漏），baseline 经审批冻结（`45f328a2`） |
| 门禁基线 | vitest **1112 passed / 1 skipped（103 文件）**；tsc 干净；verify:convergence exit 0（数字会因其他分支合入漂移，以开工自检实测为准） |
| 未动区 | `src-tauri/**`、`engine/**`、`.github/workflows/ci.yml`、冻结文件（chat-session/chat-stream/part-mutator/execution-state）零改动；**agent.ts 未拆分**（3110 行，只做过字段来源替换 + 边界追加） |

**开工自检（先做再动代码）**：`cd src-ui && npm run verify:convergence && npx vitest run`——两者全绿才开工；不绿先停下报告用户（若数字与 1112/1 有小差，先 `git log` 查是否有其他分支 merge 进来，属正常漂移，0 failed 才是硬条件）。

## 3. 必读文档（按序）

1. `docs/plans/agent-core-convergence/agent-core-convergence-plan-2026-08-15.md` §6 Phase 5 / §10 决策检查点 — 任务与验收原文
2. `docs/plans/agent-core-convergence/agent-core-convergence-verification-plan-2026-08-15.md` §4 Phase 5 — V5 分层验证规格
3. `docs/plans/agent-core-convergence/agent-core-convergence-progress.md` — **23 条决策记录（全部已落盘的偏差与理由，不许重蹈）**
4. `docs/agents/REGISTRY_OWNERSHIP.md` — 注册点所有权终态（Phase 4 已闭环）
5. 仓库规则自动注入（AGENTS/CONVENTIONS/INVARIANTS）照常生效

## 4. 验证协议（每个 commit 的硬门槛）

```sh
cd src-ui
npx vitest run              # 全量（含 convergence specs）
npx tsc --noEmit
npx biome check <改动文件>   # 零新增诊断（存量不许顺手清；精确对比法见 progress.md Phase 3/4 记录）
npm run verify:convergence  # T0 静态扫描 + 全部 phase specs 对拍 baseline
```

**baseline 纪律（防自证，违反即返工）**：
- `tests/convergence/baseline/**` 对实现者只读；漂移 → 修代码；修不了 → 更新 `baseline-change-request.md` 停工，用户审批（Phase 3/4 各走过一次，流程模板在文件里）；
- 新 baseline 只出现在 freeze 式 commit（`test(convergence): freeze phase-N ...`），只经 `npm run record:convergence` 生成；record 后以 `git diff` 为准（autocrlf stat 噪声不算变化，决策 #7）；
- `record` 永不上 CI；check 显式剔除 `CONVERGENCE_RECORD` env。

## 5. 下一步：Phase 5 — 模型可见事件溯源日志（主计划 §6 原文 + 本地化要点）

目标：模型可见事实追加为事件；`Message[]` 成为投影。**不迁移旧持久化格式**（NDJSON 快照继续写，双写阶段）。这是全工程对"字节稳定"约束压力最大的 phase——provider 请求消息序列必须逐字节一致（DeepSeek 前缀缓存），差一个字节就是全量缓存 miss。

任务（按序，建议拆多个 commit）：

1. `src-ui/src/agent/session-log.ts`（新）：
   - `type SessionEvent = { seq, ts, kind, data }`；`SessionEventKinds`：`turn/start`、`user/message`、`assistant/text`、`assistant/reasoning`、`tool/call`、`tool/result`、`session/compaction`；
   - `class SessionLog`：append（**重复 append 拒绝**，T1）、snapshot、`deriveMessages(工具折叠规则)`、replay；
   - 与 `Message[]` 双写适配器：先 append 事件，再从事件 derive 现有 messages；旧路径只读投影；
   - 注册进 `AgentServices.sessionLog`（context.ts 已预留位，见该文件注释）；
2. `agent.ts`：runLoop 关键边界追加事件；`this.session` 改为"当前投影"；compaction/retract 先以 log slice/rewrite 语义实现，**保持旧快照行为一致**。**继续禁止拆分 agent.ts，只做边界追加与来源替换**；
3. `message-store.ts`：保留现有 NDJSON 快照向后兼容导出；新增 `session-log.ndjson` append 路径（双写阶段）；**P1-15 增量游标 `_persistedMsgCount` 语义不能破坏**（saveState 的 append/truncate 逻辑有测试钉着）；
4. UI/EventSink 零改动；只加 `session/event` 内部事件供测试与未来回放。

V5 验证规格（先建 gate 再实现，V3/V4 同款节奏）：
- T0：session event 类型封闭可扩展；`seq` 严格递增由类型/运行检查保证；日志接入后**禁止 agent.ts 直接 `this.session.push(...)`**（AST 检查，豁免需登记——progress.md 决策 #10 的双层模式）；
- T1：append/snapshot/deriveMessages/replay + 重复 append 拒绝 + 投影与旧 session 等价；
- T2 核心差分：同一 run 序列（fixture Provider）分别走旧消息数组路径与新日志投影路径，比较**每一步的 provider 请求消息、compaction 边界、retract 后投影**——这是 V5 的生命线，参考 Phase 2 的 12 场景矩阵写法（tests/tool-pipeline-events.test.ts）；
- T3：**新增** `session-projection.trace.json`（新快照，走 freeze commit，请用户过目）；旧快照（tool-schemas.*/system-prompt.fixture/hook-pipeline.trace/plan-gate.decisions/wiring）**零漂移**；
- T4：全量 vitest，重点重跑 compaction / session-sync / agent-store / goal-persistence。

wiring baseline 预期：Phase 5 不应改 `runtime.ts` 的 createAgent/_disposeAgent 方法本体 → **wiring 零漂移**。若确需改（例如 _assembleAgent 接 sessionLog 服务——这不影响 wiring 度量，可以改）但涉及两方法本体时，停下走 change request。

Phase 5 决策检查点（§10）：结束后重新评估是否值得迁移 DSH——届时若触发线（多表面运行、第三方插件生态、可续聊子 Agent、模型自修改）仍未出现，继续自有 runtime。

## 6. Phase 5 特有雷区（接手前必须吃透的代码事实）

- **投影必须复刻 compaction 的全部折叠层**：`agent.ts` 的 session = 完整历史，发送载荷由 `payloadMessages()` 构造——涉及 `_compactSummary`/`_compactTailStart`（压缩折叠）、`_toolFoldBoundary`/`foldToolResults`（工具结果批量折叠）、`_transientReminders`（不持久化的临时提醒）、`retractTurnAt`/`setSession`（折叠状态失效重置）。deriveMessages 差分矩阵必须逐层覆盖，否则前缀缓存被击穿；
- **`_pendingInserts`/`_pendingMemoryUpdates` 在安全边界应用**——事件 append 的时机必须与现有数组变更点一一对应，早一拍晚一拍都会让投影与 session 失同步；
- 冻结文件 `execution-state.ts`/`chat-session.ts` 等不碰；UI 消息流的雷（touchMessage 等 INVARIANTS #1-3）与本 phase 无关——agent session 数组是另一层，不要混淆着改；
- `bump()` 之类 UI store 操作不进 session-log 事件（那是渲染层，非模型可见事实）。

## 7. 雷区速查（浓缩版，全文见 progress.md 决策 1–23）

- 管道顺序镜像 legacy：guard → preflight → execute → around → result/error（决策 #12）；guard 不吞异常，preflight/around 静默降级（#13）；
- executor 第 8 参 eventBus 存在时 ctor 的 planGate/hooks/preflightHooks 被忽略（适配器挂 bus）；bus 与 legacy EventKind 双发，UI 零改动；
- meta key 注入链（`_forceGate`/`_callId`/`_agent_id`）一个都不许动（INVARIANTS #7-#10）；工具 execute 全量透传 args；
- tool schema、system prompt、消息序列字节稳定 = 硬不变式；
- Windows 坑：Vite 改写 `new URL(字面量, import.meta.url)`（#3）；autocrlf 以 `git diff` 为准（#7）；根 .gitignore 的全局 `specs/` 规则靠末尾否定行活着（#8）；
- Phase 3：AgentConfig 唯一消费点是 `_contextFromConfig`（specs/phase-3 断言 26 字段完整性）；装配本体 `_assembleAgent` config-free；ctx.tools 在克隆后写回（曾把输入注册表装配给 Agent，被 phase-1 effective 快照拦下——#18）；
- Phase 4：DisposerBag 同步快通道（sync 清理器不跨微任务，dispose 后同步可观测，#20）；McpClient/SubAgentPool 保持 workspace 所有权不挂单 Agent ctx（#21）；dispose 无双路径，等价性 = 既有栅栏 + trace（#22）；
- 双 baseline 变更已批已冻：wiring 0/0/0 + dispose 14——任何再度漂移都要 change request。

## 8. 并发与环境纪律

- **每个会话独占一个 worktree**。主仓 `D:/HoloGramHG` 归本工程；`D:/HoloGramHG-main` 是用户另一窗口（main + graph 工作），**绝对不要碰**；根目录 `paging-rework.patch` 是那边的，勿删勿提交；
- 用户工作区/其他会话的未提交改动永不混入 commit（每 commit 只 add 本任务文件；stash 拆分提交的手法见 Phase 3/4 的绿色 commit 先例）；
- 提交拆分纪律：不漂移 baseline 的原语/测试先行（绿色 commit），触碰快照的部分攒成一批，change request 批准后 实现 commit → record freeze commit → docs commit 三连落地。

## 9. 与用户的交互点

- 新增 baseline（session-projection.trace.json）的 freeze commit 请用户过目；既有快照漂移 → change request 停工等批；
- 每个 Phase 结束 → 更新 progress.md（验收核对 + 决策记录从 #24 起 + 检查点结论）并简报；
- 用户风格：中文、结论先行、"数字 + 证据"；审计类工作可请用户把 prompt 丢给独立窗口执行。
