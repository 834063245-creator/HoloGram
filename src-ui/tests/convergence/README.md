# tests/convergence — Agent Core Convergence 验证工程

> 关联：`docs/plans/agent-core-convergence/`（主计划 + 验证计划）。
> 本目录是验证计划的落地：把"行为正确"固化成机器可读的 baseline，人类只审意图，不验行为。

## 命令（src-ui 下）

| 命令 | 作用 | 谁能用 |
|---|---|---|
| `npm run verify:convergence` | check：跑契约比对（baseline 只读），漂移 exit 1 | 任何人/CI |
| `npm run record:convergence` | record：重写 baseline | **仅限人类审批的 baseline 专用提交** |
| `npm run report:convergence` | 打印最近一次运行报告（reports/latest.md） | 任何人 |
| `CONVERGENCE_PHASE=N npm run verify:convergence` | 只跑 phase N 的 specs | 任何人 |

## 目录

```
gate.mjs            门禁入口（check / record / report）
helpers/            normalize（稳定序列化）/ snapshot（采集比对）/ differential（双路径差分）/
                    fixtures（确定性夹具）/ wiring（runtime.ts AST 度量）
baseline/phase-N/   契约快照 — 人类拥有，实现 Agent 只读
specs/phase-N.test.ts  每 phase 的采集/比对测试
reports/            运行报告（gitignored）
```

## baseline 协议（防自证）

1. baseline 产生自 **freeze commit**（`test(convergence): freeze phase-N baseline`），不夹带任何 `src/agent` 改动；
2. 实现期发现 `verify:convergence` 漂移：**禁止 record 覆盖**——先修代码；确认需要变更模型可见表面时，写 `baseline-change-request.md`（哪个快照、为什么变、影响面）后停工，由人类决定；
3. 合法的 baseline 变更只有两种：产品层明确决定改变模型可见行为；或测试夹具被证明记录的是 bug。人类批准后由独立 record 提交执行；
4. 差分测试（Phase 2 起）legacy 与 new 路径必须各自独立构建夹具，防止共享同一 bug。

## 快照清单（Phase 0）

| 快照 | 钉住的契约 |
|---|---|
| `tool-schemas.full.json` | 标准注册表模型可见工具面（name/description/parameters 逐字节） |
| `tool-schemas.plan.json` | planRegistry 派生工具面（现仅服务 plan 中 spawn 的只读子 Agent；主 Agent 的 plan 约束走 planGate 运行时拦截，不切换注册表） |
| `system-prompt.fixture.json` | 固定输入下 buildSystemPrompt 的完整输出 |
| `plan-gate.decisions.json` | 固定工具/args 矩阵下 planGateCheck 的判定与拦截文案 |
| `hook-pipeline.trace.json` | StreamingToolExecutor 固定调用的事件顺序与输出 |
| `create-agent.wiring.txt` | createAgent 装配的 AST 事实（config.* 直读 26 / 注册点 11 / setter 12 / 清理步骤 21） |
