# Agent Core Convergence 计划集

> 创建日期：2026-08-15 · 更新：2026-08-16
> 状态：**Done — Phase 0–6 + V0–V6 全部完成**（分支 feat/agent-gap-closure；工程转入维护态，gate 与 baseline 长期守护）
> 内容：HoloGram 自有 Agent 运行时向 Cordis 设计原语收敛的规划与验证工程。

## 文件

| 文件 | 内容 |
|---|---|
| `agent-core-convergence-plan-2026-08-15.md` | 主计划：Context / Effect / 类型化事件 / 事件溯源日志，6 个 Phase |
| `agent-core-convergence-verification-plan-2026-08-15.md` | 验证工程计划：Agent 执行下的人机分工、门禁与 baseline 协议 |
| `agent-core-convergence-progress.md` | 进度表：每 phase 的基线数字、度量、决策记录（1–33）与检查点结论 |
| `agent-core-convergence-handoff-phase6.md` | Phase 6 交接文档（工程收尾后的维护约束在此） |
| `agent-core-convergence-handoff-phase5.md` | Phase 5 交接文档（历史，勿作现状依据） |
| `agent-core-convergence-handoff-phase3.md` | Phase 3 交接文档（历史，勿作现状依据） |
| `baseline-change-request.md` | baseline 变更申请（活文件；Phase 3/4 两次申请均已批准执行） |

## 结论摘要

- 不整体迁移到 Cordis / DeepSeek Harness。
- 保留 HoloGram 自有运行时与垂直能力（worktree、merge gate、TaskBoard、图引擎）。
- 在自有 runtime 内实现四个原语：Context（✅ Phase 3）、Effect/Disposer（✅ Phase 1/4）、类型化事件（✅ Phase 2）、事件溯源会话日志（✅ Phase 5）；组合层收尾（✅ Phase 6：blueprint 声明式装配，新增工具/hook 不再扩 AgentConfig）。
- 实现主体预计为 Agent，因此验证工程先行：先建 gate 与 baseline，再进入代码迁移。
- 阅读顺序：主计划 → 验证计划 → progress.md 决策记录；维护约束见 handoff-phase6 §4。
