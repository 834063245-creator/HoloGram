# docs/plans — 计划与实验入口

> 状态词：Proposed（待评审）· Draft（未执行）· In progress · Landed（代码已落地，剩真机验证）。
> 已完成的施工规格/被取代的 plan 移入 `docs/archive/`。

## 活跃计划

| 计划 | 状态 | 下一步 |
|---|---|---|
| [`arch-action-plan.md`](arch-action-plan.md) | 批 1/2 完成；批 3 的 13/12/11a/11b 完成，14 部分完成，11c 搁置 | 11c 与 agent 区 any 清理 |
| [`shell-stability-bundled-bash-plan.md`](shell-stability-bundled-bash-plan.md) | P0–P5 已落地 | Windows 真机验证（cfg(windows) 路径） |
| [`browser-cdp-suite-review-round2.md`](browser-cdp-suite-review-round2.md) | 第一至第五批已提交 | Windows 真机 E2E-1/2/3/4/5 |
| [`agent-core-convergence/`](agent-core-convergence/) | **Done — Phase 0–6 + V0–V6 全部完成**（四原语全落地：Context / Effect 所有权 / 类型化事件 / 事件溯源日志 + blueprint 声明式装配；baseline 8 快照冻结） | 工程转入维护态：gate 与 baseline 长期守护（维护约束见 handoff-phase6） |
| [`cordis-migration/`](cordis-migration/) | **Done — P0-P4 全部落地**（内核 vendor → Workspace fiber 化 → Agent 身份 fiber 桥接 → LSP Service 化 → 四件套评估收口：双范式残留清零、epoch 定案永久保留、8 baseline 零漂移） | 后续同模式候选（goal-manager / memory-bundle-client 等）按需逐个迁 |
| [`v4-pro-minimal-ab-test-plan.md`](v4-pro-minimal-ab-test-plan.md) | Draft | Linux 环境执行 |
| [`ui-react-island-retirement-plan.md`](ui-react-island-retirement-plan.md) | **Done**（2026-08-19：ui/react/ 目录删除、5 总线事件退役迁 store、32 文件全量迁入 app/**；终态守护测试常驻） | — |
| [`eventbus-zero-and-ui-split-plan.md`](eventbus-zero-and-ui-split-plan.md) | P0 ✅ · P1 ✅（2026-08-19：11 事件全退役迁 store、events.ts 删除、bridge-adapters 删除） | P2 物理拆分 state/+scene/（git mv + import 路径）→ P3 终态收口（COMPLETE 翻真 + 文档回写） |
| [`agent-plugin-architecture-plan.md`](agent-plugin-architecture-plan.md) | Proposed（方向性立项：DSH 源码实证对标——执行原语 + 工具面单一真源 + cordis Service 收口 + 插件边界；**生态跟随观望中**：P4 门控于 DSH 官方接口稳定信号，P1-P3 纯自研独立成立，见 D8） | P1 工具面文档生成（半天，独立收益）随时可做；P2 执行原语建议在总线归零后开；P4a 契约调研（纯侦察）可先行 |

## 已归档计划

见 [`docs/archive/README.md`](../archive/README.md)：graph-id-refactor-plan（R0–R10 竣工）、tool-convergence-browser-plan、browser-cdp-suite-plan-2026-08-13 等。
