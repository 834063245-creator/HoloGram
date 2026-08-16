# Agent Core Convergence — Phase 3 交接文档

> 交接日期：2026-08-16 · 交接点：Phase 2/V2 完毕（commit `dd0c6684`）
> 接手者：下一个实现窗口。本文自包含开工所需全部事实；细节以链接文档为准。

## 1. 工程一句话

HoloGram 自有 Agent 运行时（`src-ui/src/agent/`）向 Cordis 设计原语收敛——不换运行时、不改模型可见行为，四个原语：Context、Effect/Disposer、类型化事件、事件溯源日志。

## 2. 当前状态（2026-08-16 收工时）

| 项 | 状态 |
|---|---|
| 分支 | `feat/agent-gap-closure`，自 main `67f21ec2` 切出，领先 10 个 commit（`5ff78821`…`dd0c6684`） |
| Phase 0/V0 | ✅ 基线冻结 + gate.mjs + 6 契约快照；独立对抗审计**有条件放行**，条件全部处置 |
| Phase 1/V1 | ✅ Disposer 契约（3 个 register API 返回清理器）+ startOwned/ownedDisposer + F8 effective 快照 + 独立 CI workflow |
| Phase 2/V2 | ✅ AgentEventBus 五事件双路径；12 场景差分 + pipeline 对拍 phase-0 冻结 baseline 逐字节一致 |
| 门禁基线 | vitest **1079 passed / 1 skipped（99 文件）**；tsc 干净；触碰文件 biome 零新增 |
| 未动区 | `src-tauri/**`、`engine/**`、`.github/workflows/ci.yml`、冻结文件（chat-session/chat-stream/part-mutator/execution-state）零改动 |

**开工自检（先做再动代码）**：`cd src-ui && npm run verify:convergence && npx vitest run`——两者全绿才开工；不绿先停下报告用户。

## 3. 必读文档（按序）

1. `docs/plans/agent-core-convergence/agent-core-convergence-plan-2026-08-15.md` — 主计划 §6 Phase 3/4/5 任务清单
2. `docs/plans/agent-core-convergence/agent-core-convergence-verification-plan-2026-08-15.md` — 验证分层与 baseline 协议
3. `docs/plans/agent-core-convergence/agent-core-convergence-progress.md` — **15 条决策记录（全部已落盘的偏差与理由，不许重蹈）**
4. `docs/agents/REGISTRY_OWNERSHIP.md` — 注册点所有权清单（Phase 4 的迁移地图）
5. 仓库规则自动注入（AGENTS/CONVENTIONS/INVARIANTS）照常生效

## 4. 验证协议（每个 commit 的硬门槛）

```sh
cd src-ui
npx vitest run              # 全量（含 convergence specs）
npx tsc --noEmit
npx biome check <改动文件>   # 零新增诊断（存量 581/338 不许顺手清）
npm run verify:convergence  # T0 静态扫描 + 全部 phase specs 对拍 baseline
```

**baseline 纪律（防自证，违反即返工）**：
- `tests/convergence/baseline/**` 对实现者是只读；漂移 → 修代码，修不了 → 写 `baseline-change-request.md` 停工，用户审批；
- 新 baseline 只出现在 freeze 式 commit（`test(convergence): freeze phase-N ...`），只经 `npm run record:convergence` 生成；
- `record` 永不上 CI；check 会显式剔除 `CONVERGENCE_RECORD` env（审计 F1 修复，勿回退）。

## 5. 下一步：Phase 3 — AgentContext 抽取（主计划 §6 原文 + 本地化要点）

目标：`createAgent` 的 26 个 config.* 直读收敛为 Context + 显式依赖。**结构变化最大的一步**。

任务（按序）：
1. `src-ui/src/agent/context.ts`（新）：`AgentServices` 接口（provider/tools/events/hooks/messageBus/taskBoard/discoveryBoard/planState/goalManager/agentStore/sessionLog）+ `class AgentContext`（身份字段 agentId/parentId/subagentDepth/isolationId/projectPath；`get/resolve` 服务访问；`effect(register, label)` 基于 `lifecycle.ts` 的 DisposerBag；`child(overrides)` 子 Agent 派生）；
2. `runtime/types.ts`：新增 `AgentContext` 构造入口，`AgentConfig` 保留兼容；
3. `runtime/runtime.ts` `createAgent`：先把 taskProxy/discoveryProxy/planState/execState 创建移入 context 工厂——**只换 owner，不减逻辑**；
4. `agent.ts`：构造函数兼容重载 `new Agent(ctx, systemPrompt, opts)`，新路径只读 ctx；`setBus/setSubAgentPool/setGoalManager` 逐步改 context 字段。**禁止拆分 agent.ts（3059 行），只做字段来源替换**；
5. `spawnSubAgent` 从父 context `child()` 派生，不复制全部配置字段。

V3 验证规格（先建 gate 再实现）：
- T0：AST 度量 `createAgent` config.* 直读数较 26 下降（用 `tests/convergence/helpers/wiring.ts` 现成提取器）；`AgentContext` 公共字段必须有 JSDoc；
- T1：context 服务解析/缺依赖报错/effect 逆序/child 隔离；
- T2：旧 `AgentConfig` 入口与新 `AgentContext` 入口生成同一 AgentSummary/工具集/system prompt（差分）；
- T3：`tool-schemas.*`、`system-prompt.fixture.json` 不变；`create-agent.wiring.txt` 只允许记录在案的变化（**注意：这条 baseline 在 Phase 3 必然要变——wiring 收敛正是目的，走 baseline-change-request.md 请用户审批后 freeze**）；
- T4：全量 vitest。

Phase 3 决策检查点（计划 §10）：若 `createAgent` 复杂度没有实际下降 → 暂停 Phase 4，报告用户。

## 6. 雷区速查（浓缩版，全文见 progress.md 决策 1–15）

- 管道顺序**镜像 legacy**：guard（addTool 同步段）→ preflight → execute → around → result/error；不是主计划 §6 清单的序（决策 #12）；
- executor 第 8 参 `eventBus` 存在时 ctor 的 planGate/hooks/preflightHooks 被忽略——适配器挂 bus（`events.ts` attach*）；
- bus 事件与 legacy EventKind sink **双发**，UI 零改动；guard 不吞异常，preflight/around 静默降级（决策 #13）；
- meta key 注入链（`_forceGate`/`_callId`/`_agent_id`）一个都不许动（INVARIANTS #7-#10）；
- tool schema、system prompt、消息序列字节稳定 = 硬不变式（前缀缓存）；
- Windows 坑：Vite 静态改写 `new URL(字面量, import.meta.url)`（决策 #3）；autocrlf 下 baseline 变更以 `git diff` 为准（决策 #7/审计 F7）；
- `.gitignore` 根有全局 `specs/` 规则，convergence 的 specs 靠末尾否定行活着——别删（决策 #8）。

## 7. 并发与环境纪律

- **每个会话独占一个 worktree**。主仓 `D:/HoloGramHG` 归本工程；`D:/HoloGramHG-main` 是用户另一窗口的工作区（main 分支 + graph 改动），**绝对不要碰**；根目录的 `paging-rework.patch` 是那边的，勿删勿提交；
- 用户工作区/其他会话的未提交改动永不混入 commit（每 commit 只 add 本任务文件）；
- 仓库残留备份 `D:/HoloGramHG-phase2-wip-backup`（双会话事故的 WIP 副本，已全部落地提交）——可提醒用户删除，接手者不负责清理。

## 8. 与用户的交互点

- baseline 新增/变更 → freeze commit 请用户过目；
- 每个 Phase 结束 → 更新 progress.md（验收核对 + 决策记录 + 检查点结论）并简报；
- 用户风格：中文、要结论先行、喜欢"数字 + 证据"；审计类工作可请用户把 prompt 丢给独立窗口执行。
