# Agent Core Convergence — Phase 6 交接文档（可选收尾）

> 交接日期：2026-08-16 · 交接点：Phase 5 完毕（freeze `5e42c995` + docs commit）
> 接手者：下一个实现窗口（若决定启动 Phase 6）。本文自包含开工所需全部事实。
> 前任交接文档 `agent-core-convergence-handoff-phase5.md` 已成历史，勿作现状依据。

> **收尾追记（2026-08-16 第二窗口）：Phase 6 已完成**——T1 `431e6eca`（AgentBlueprint
> 原语）+ T2（_assembleAgent 表驱动重写 + specs/phase-6 + gate.mjs phase-6 规则）。
> 验收达成：新增工具/hook 走 `blueprint.add()`，AgentConfig 字段面冻结 31（T0 双层门禁）。
> 终态：vitest 1162 passed / 1 skipped（109 文件），verify:convergence exit 0，tsc 干净。
> 决策 30-33 与验收核对见 progress.md Phase 6 记录；§4 的维护约束（演进纪律）继续有效。

## 1. 工程终态一句话

HoloGram 自有 Agent 运行时已完成向 Cordis 四原语的收敛——Context、Effect/Disposer、
类型化事件、事件溯源会话日志全部落地（Phase 0-5 ✅，决策 1-29 落盘）。
**Phase 5 决策检查点结论：DSH 迁移触发线未出现，继续自有 runtime；Phase 6 是可选项。**

## 2. 当前状态（2026-08-16 收工时）

| 项 | 状态 |
|---|---|
| 分支 | `feat/agent-gap-closure`，领先 main 24 commits（`5ff78821`…docs commit） |
| Phase 5 交付 | `bfa5bc91`（SessionLog 原语+T1）→ `40ae6355`（双写接线+T0/T2+门禁）→ `5e42c995`（session-projection baseline freeze）→ docs |
| 门禁基线 | vitest **1150 passed / 1 skipped（107 文件）**；tsc 干净；build 绿；verify:convergence exit 0（数字会漂移，开工自检实测为准） |
| baseline | 8 快照：phase-0 六件 + phase-1 effective + **phase-5 session-projection.trace.json（新增，交接时待用户过目）** |
| 未动区 | `src-tauri/**`、`engine/**`、`.github/workflows/ci.yml`、冻结文件零改动；agent.ts 未拆分（3130 行左右，只做边界追加与来源替换） |
| Phase 5 双写语义 | `this.session` 仍是真源（restore/UI 读它）；SessionLog 事件流与之逐字节等价（差分 11 场景 + 冻结快照钉住）；session-log.ndjson append-only 双写，恢复仍读 session.ndjson |

**开工自检**：`cd src-ui && npm run verify:convergence && npx vitest run`——全绿才开工。

## 3. Phase 5 落地要点（接手者必读的代码事实）

- **session 变异只有三个入口**：agent.ts 的 `_appendMessage` / `_replaceSession` /
  `_retractSessionRange`（+构造初始化）。phase-5 T0 双层门禁（spec AST 白名单 +
  gate.mjs 计数扫描）钉死；新增直改会在 check 阶段失败关闭，豁免须登记 progress.md。
- **事件 kind 9 种**（决策 #24）：计划 7 种 + `session/reset`（深拷贝快照）+
  `session/retract`（[from,to) splice）；`assistant/reasoning` 保留不发射（决策 #25：
  tool/call 也是审计记录，不参与投影）。
- **`_toolFoldBoundary` 不入事件流**（决策 #26）：derivePayload 显式镜像调用前边界值，
  内部执行同样的 nextFoldBoundary 单次推进——与旧路径同起同进逐字节相等。
  window=0（默认）边界恒 0 无此问题；改折叠逻辑必须同步 session-log.ts derivePayload。
- **事件 ndjson 写链**（决策 #29）：`_eventAppendChain` 防 run() 结尾 fire-and-forget
  saveState 与显式 saveState 并发重复追加；新增持久化路径沿用该模式。
- **事件持久化在 agent-store.ts**（决策 #28：交接时文档笔误 message-store.ts——那是
  inbox）；经 `log_append` RPC 真追加，不改 Rust。

## 4. 下一步（按优先级）

1. **（用户决定）phase-5 baseline 过目**：`src-ui/tests/convergence/baseline/phase-5/
   session-projection.trace.json`——15 事件 + 6 载荷步的固定场景契约。有异议 → revert
   `5e42c995` 重录；无异议 → 归档确认。
2. **（可选）Phase 6 组合层收尾**（主计划 §6）：
   - `agent/blueprint.ts` 声明式 service/factory 构建 AgentContext；
   - `runtime/agent-builder.ts` 工具/hook 工厂迁 context factory；
   - 验收：新增工具或 hook 不再要求修改 `AgentConfig`。
   - **先决问题**：Phase 5 检查点结论是"视后续装配痛点再启动"——若近期没有新增
     工具/hook 的装配需求，Phase 6 建议不开工，本工程转入维护态（gate 与 baseline
     长期守护）。
3. **（维护）后续演进约束**：
   - 新增 AgentConfig 字段 → 同步 `_contextFromConfig` 26 字段翻译完整性断言（phase-3 spec）；
   - 新增 session 变异路径 → 必须走三入口 + 差分矩阵补场景 + phase-5 快照零漂移；
   - 新增引擎/前端模型可见面 → 考虑加 baseline（走 change request 审批）。

## 5. 验证协议（不变）

```sh
cd src-ui
npx vitest run              # 全量（含 convergence specs）
npx tsc --noEmit
npx biome check <改动文件>   # 零新增诊断
npm run verify:convergence  # T0 静态 + 全部 phase specs 对拍 baseline
```

baseline 纪律、change request 流程、record 永不上 CI——同 phase-5 交接文档 §4，
全文见 `tests/convergence/README.md` 与 progress.md。

## 6. 并发与环境纪律（不变）

每个会话独占一个 worktree；主仓 `D:/HoloGramHG` 归本工程；`D:/HoloGramHG-main`
是用户另一窗口，绝对不要碰；每 commit 只 add 本任务文件。

## 7. 与用户的交互点

- phase-5 baseline（新增快照）请用户过目——本窗口已按 Phase 1 先例落地 freeze commit，
  用户否决则 revert 重录；
- 若启动 Phase 6：结束时更新 progress.md（决策 #30 起 + 检查点结论）并简报；
- 用户风格：中文、结论先行、"数字 + 证据"。
