# Agent Core Convergence — 进度表

> 计划：`agent-core-convergence-plan-2026-08-15.md` · 验证：`agent-core-convergence-verification-plan-2026-08-15.md`
> 分支：`feat/agent-gap-closure`
> 规则：每 phase 结束更新本表；决策检查点结论必须落盘。

## 状态总览

| Phase | 状态 | 说明 |
|---|---|---|
| 0 基线冻结 + V0 验证工程 | ✅ 完成 | 6 契约快照 + gate.mjs 落地，全量绿 |
| 1 Disposer 契约 | ⬜ 未开始 | |
| 2 工具管道类型化事件 | ⬜ 未开始 | |
| 3 AgentContext 抽取 | ⬜ 未开始 | |
| 4 生命周期所有权统一 | ⬜ 未开始 | |
| 5 会话事件溯源日志 | ⬜ 未开始 | |
| 6 组合层收尾（可选） | ⬜ 未开始 | |

## Phase 0 / V0 记录（2026-08-16）

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
