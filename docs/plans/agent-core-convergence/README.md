# Agent Core Convergence 计划集

> 创建日期：2026-08-15 · 更新：2026-08-16
> 状态：In progress（Phase 0/V0 完成，分支 feat/agent-gap-closure；待人类放行 Phase 1）
> 内容：HoloGram 自有 Agent 运行时向 Cordis 设计原语收敛的规划与验证工程。

## 文件

| 文件 | 内容 |
|---|---|
| `agent-core-convergence-plan-2026-08-15.md` | 主计划：Context / Effect / 类型化事件 / 事件溯源日志，6 个 Phase |
| `agent-core-convergence-verification-plan-2026-08-15.md` | 验证工程计划：Agent 执行下的人机分工、门禁与 baseline 协议 |
| `agent-core-convergence-progress.md` | 进度表：每 phase 的基线数字、度量与决策记录 |

## 结论摘要

- 不整体迁移到 Cordis / DeepSeek Harness。
- 保留 HoloGram 自有运行时与垂直能力（worktree、merge gate、TaskBoard、图引擎）。
- 在自有 runtime 内实现四个原语：Context、Effect/Disposer、类型化事件、事件溯源会话日志。
- 实现主体预计为 Agent，因此验证工程先行：先建 gate 与 baseline，再进入代码迁移。

## 阅读顺序

1. 先读主计划，理解目标与非目标；
2. 再读验证计划，理解 Agent 执行下的交付与验收方式；
3. 开工前先评审 Phase 0 / V0，不直接进入业务代码修改。✅ 已完成（2026-08-16，进度表见 progress.md）
