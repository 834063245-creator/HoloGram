# Agent 执行下的验证工程计划（Convergence Verification Plan）

> 状态：Proposed（待评审）
> 日期：2026-08-15
> 关联计划：`agent-core-convergence-plan-2026-08-15.md`
> 解决问题：实现主体是 Agent 时，人类手工验证会退化成“人机异步串行互相等待”，不可靠也不可扩展。
> 目标：**把人类从“验证行为”中解放出来，只保留“审批意图”。**

---

## 0. 核心判断

这次改造的风险不是写代码，而是**行为漂移在事后才被发现**。

因此测试工程要解决三个问题：

1. **基线先行**：改造前，先把“当前正确行为”固化成机器可读的事实；
2. **门禁权威**：Agent 每个 commit 必须过同一套本地/CI 门禁，门禁通过才算完成；
3. **人类只做两件事**：写 brief 和审 baseline diff。人类不再执行任何“手动验证”。

设计原则：

- 快照只用于稳定契约面，不用于易变输出；
- 内部重构用**差分测试**（旧路径 vs 新路径）证明等价；
- 基线文件对实现 Agent 只读；修改基线必须走单独的人类审批路径；
- Agent 不能靠“自己写的测试”自证；基线来自改造前的独立 freeze commit。

---

## 1. 验证分层

| 层 | 名称 | 回答的问题 | 工具 |
|---|---|---|---|
| T0 | 结构门禁 | 公开接口和禁止模式是否被破坏 | tsc、biome、专用 AST/静态脚本 |
| T1 | 单元行为 | 单个原语是否正确 | vitest |
| T2 | 差分行为 | 新旧实现是否输出一致 | vitest 双路径 fixture |
| T3 | 契约快照 | 模型可见表面是否漂移 | vitest snapshot + JSON baseline |
| T4 | 全量回归 | 既有行为是否整体不变 | 现有 972 用例 |
| T5 | 泄漏与顺序 | teardown 是否可靠 | 生命周期专项测试 |

每 phase 的验收 = 该 phase 指定的层级全部通过，而不是“看起来没问题”。

---

## 2. 目录与脚本设计

新增目录：

```
src-ui/tests/convergence/
  gate.mjs                 # 门禁入口：check / record / report
  helpers/
    normalize.ts           # 稳定化时间戳、随机 id、路径
    differential.ts        # 同一输入跑旧路径/新路径并逐字段比较
    fixtures.ts            # 确定性工具集与假 Provider
  baseline/
    phase-1/*.json         # 契约快照（人类拥有，Agent 只读）
    phase-2/*.json
    phase-3/*.json
    phase-4/*.json
    phase-5/*.json
  specs/
    phase-*.test.ts        # 每 phase 的专项行为测试
  reports/                 # gitignored，运行报告
```

新增 `src-ui/package.json` scripts：

```json
{
  "test:convergence": "vitest run tests/convergence",
  "verify:convergence": "node tests/convergence/gate.mjs check",
  "record:convergence": "CONVERGENCE_RECORD=1 node tests/convergence/gate.mjs record",
  "report:convergence": "node tests/convergence/gate.mjs report"
}
```

`gate.mjs` 的行为：

- `check`：
  1. 按 `CONVERGENCE_PHASE` 运行该 phase 的 T0–T3；
  2. 比较 baseline 文件与当前实际输出；
  3. 有任何 diff → exit 1，并把 diff 写入 `reports/`；
- `record`：
  1. 要求显式 `CONVERGENCE_RECORD=1`；
  2. 打印警告并重写 baseline；
  3. **只允许在 baseline 专用提交中使用**；
- `report`：
  1. 汇总最近一次运行的命令、用例数、耗时、diff 文件路径；
  2. 输出人类审阅单。

---

## 3. 基线协议（防 Agent 自证）

### 3.1 基线 freeze commit

每个 phase 开始前，先单独提交一个 commit：

```text
test(convergence): freeze phase-N baseline
```

内容只有：

- `tests/convergence/baseline/phase-N/`
- `tests/convergence/specs/phase-N.test.ts` 的采集部分

这个 commit 不允许夹带任何 `src/agent` 改动。

### 3.2 实现 commit 的禁令

实现 Agent 的工作包 brief 中写死：

> 禁止修改 `tests/convergence/baseline/**`。
> `verify:convergence` 失败时，先修复代码；如果 baseline 必须变，停止工作并输出 `baseline-change-request.md`，由人类决定。

### 3.3 人类审批 baseline 的唯一场景

只有两种合法 baseline 变更：

1. 产品层明确决定改变模型可见行为（例如系统提示词正式变更）；
2. 测试夹具本身被证明记录的是 bug。

审批流程：

1. Agent 提交 `baseline-change-request.md`，说明哪个快照、为什么变、影响面；
2. 人类批准后，**人类或独立 baseline commit** 执行 `record:convergence`；
3. 实现 commit 与 baseline commit 分开，永远不同在一个 commit。

---

## 4. 每 phase 的验证规格

### Phase 0 — 基线冻结

**T0**：`npx tsc --noEmit`；`npx biome ci src/agent src/tests`。

**T3 采集以下契约**：

| 快照 | 来源 | 用途 |
|---|---|---|
| `tool-schemas.full.json` | 标准 `buildToolRegistry` 结果 | Phase 1–4 工具面不变 |
| `tool-schemas.plan.json` | plan 派生工具集 | planGate 不变 |
| `system-prompt.fixture.json` | 固定 graphData/projectPath/memory 的 `buildSystemPrompt` | Phase 3 装配不变 |
| `plan-gate.decisions.json` | 固定工具/args 矩阵跑 `planGateCheck` | Phase 2 门禁不变 |
| `hook-pipeline.trace.json` | 固定工具调用跑 `StreamingToolExecutor` 的事件顺序 | Phase 2 执行顺序不变 |
| `create-agent.wiring.txt` | AST 静态提取 `createAgent` 的 `config.*` 字段与 `effR.register` 调用清单 | Phase 3 结构收敛度量 |

**T4**：记录当前 `npx vitest run` 通过数（972 左右）与耗时。

### Phase 1 — Disposer 契约

**T0 新增静态检查**：`tests/convergence/gate.mjs` 扫描 agent 目录，要求以下方法返回 `Disposer` 或已登记的豁免：

- `ToolRegistry.register`
- `HookRegistry.register`
- `PreflightHookRegistry.register`

**T1 新增**：

- disposer 幂等；
- 逆序清理；
- async 清理被等待；
- 一个清理失败不阻断后续。

**T2**：无需差分。

**T3**：Phase 0 全部快照不变。

**T4**：全量 vitest。

**T5 新增**：注册 100 次再 dispose 100 次，registry 长度归零。

### Phase 2 — 工具执行管道事件

**T0**：事件声明要求 `mode` 字段存在且属于 `serial|parallel|waterfall|emit`。

**T1 新增**：

- event bus 各 mode 的调度顺序与短路语义；
- listener disposer 能移除监听。

**T2 核心差分**：

- 同一 `ToolCall` fixture 分别跑 legacy 路径和新 event pipeline 路径；
- 比较：`output`、`truncated`、事件种类、事件顺序、错误行为；
- 矩阵至少覆盖：未知工具、hidden 工具、非法 JSON、HIGH gate 拦截、planGate 拦截、hook 富化、hook 抛错、AbortError。

**T3**：`hook-pipeline.trace.json` 必须逐项一致。

**T4**：全量 vitest。

### Phase 3 — AgentContext

**T0 新增**：

- AST 度量：`createAgent` 中 `config.*` 直读数量必须较 Phase 0 基线下降；
- 新增 `AgentContext` 公共字段必须有 JSDoc；
- 禁止 `Agent` 再直接 import `ToolRegistry`/`HookRegistry` 之外的装配工厂（分阶段收紧）。

**T1 新增**：

- context 服务解析、缺依赖报错；
- `effect` 注册与逆序释放；
- `child()` 隔离；
- 子 Agent 派生不复制父 context 全部字段。

**T2**：

- 用 fixture Provider 创建 agent：
  - 旧 `AgentConfig` 入口与新 `AgentContext` 入口生成同一 `AgentSummary`、同一工具集、同一 system prompt。

**T3**：`tool-schemas.*`、`system-prompt.fixture.json` 不变；`create-agent.wiring.txt` 只允许记录的变化发生。

**T4**：全量 vitest。

### Phase 4 — 生命周期统一

**T0**：

- `_disposeAgent` 不再直接调用 `lifecycle.stop()` / `bus.unregister()` / `board.unregister()` 的分散路径，除非在豁免表。

**T1/T5 新增**：

- dispose 幂等与并发单次；
- 清理顺序 trace：`loop stop → bus/board flush → saveState('done') → effects 逆序 → worktree 释放`；
- 清理中某 effect 抛错，后续 effect 仍执行且错误被记录；
- dispose 后注册抛错；
- 创建/销毁循环 100 次，timer 和 registry 无增长。

**T2**：

- 对同一假 Agent 分别运行“旧 `_disposeAgent` 清理路径”和“context dispose 路径”，比较 flush 调用顺序、bus/board 状态、timer 数量。

**T3**：Phase 0 全部快照不变。

**T4**：全量 vitest，特别重跑 `agent-lifecycle-dispose`、`lifecycle-integration`、`lifecycle-unit`。

### Phase 5 — 会话事件溯源

**T0**：

- session event 类型封闭可扩展；`seq` 严格递增由类型/运行检查保证；
- 禁止 `agent.ts` 直接 `this.session.push(...)`（在日志接入后）。

**T1 新增**：

- append、snapshot、deriveMessages、replay；
- 重复 append 拒绝；
- 投影与旧 session 等价。

**T2 核心差分**：

- 同一 run 序列分别走旧消息数组路径与新日志投影路径；
- 比较：每一步的 provider 请求消息、compaction 边界、retract 后的投影。

**T3**：

- 新增 `session-projection.trace.json`；
- 旧 `Message[]` 相关快照不变。

**T4**：全量 vitest；重点重跑 compaction、session-sync、agent-store、goal-persistence。

---

## 5. 工作流：人机角色分离

### 5.1 人类

1. 为每个 work package 写 brief：允许动哪些文件、禁止动哪些文件、验收 gate 是什么；
2. 在 freeze commit 后开始实现；
3. 只看三样东西：
   - `git diff --stat`；
   - `reports/convergence/*.md`；
   - `baseline-change-request.md`（如果有）；
4. 不再手工点界面、不再手工跑测试、不再凭感觉判断“是不是变快了/变卡了”。

### 5.2 Agent

1. 每完成一个 commit，运行对应 `CONVERGENCE_PHASE` 的 `verify:convergence check`；
2. gate 不过，不得请求人类 review；
3. gate 过了，提交 `report:convergence` 报告；
4. 发现 baseline diff：
   - 禁止 `--update` 或 `record`；
   - 输出 `baseline-change-request.md` 后停止；
5. 不自己合并，不自己改 gate 脚本（测试工程改动属于另一个 work package）。

### 5.3 并行规则

- 同一 branch/checkout 同时只有一个实现 Agent；
- 若必须并行：每个 Agent 独立 git worktree + 独立 `CONVERGENCE_WORKTREE_ID`，报告目录按 id 隔离；
- baseline 文件与 gate 脚本任何并行期间锁定，只允许主线单独修改。

---

## 6. CI 设计

新增一个 GitHub Actions job：

```yaml
verify-convergence:
  runs-on: ubuntu-latest
  env:
    CONVERGENCE_PHASE: ${{ inputs.phase }}
  steps:
    - uses: actions/checkout@v4
    - run: npm ci --prefix src-ui
    - run: npm run test:convergence --prefix src-ui
    - run: npm run verify:convergence --prefix src-ui
```

规则：

- PR 必须携带 phase label；
- 缺少 label 或 gate 失败，不得合并；
- baseline 文件被修改时，PR 必须同时有 `baseline-approved` 标记，否则 CI 直接失败；
- `record:convergence` 不上 CI。

---

## 7. 防漂移与防自证

1. **基线来自 freeze commit**：实现 Agent 无法合法改 baseline；
2. **差分测试双路径独立实现**：legacy 路径必须保留到 phase 验收，防止新路径与旧路径共享同一 bug；
3. **契约快照只测稳定表面**：不把耗时、随机 id、未规范化路径写入快照；统一走 `normalize.ts`；
4. **门禁脚本本身被测试**：gate.mjs 的 diff 检测有一个会故意失败的小 spec；
5. **人类审批意图，机器审批行为**：人类不判断行为，只判断“这次 baseline 变更是否被产品接受”。

---

## 8. 工作量预估（Agent 执行口径）

| 工作包 | 内容 | Agent 工作窗口 |
|---|---|---|
| V0 | gate.mjs、helpers、fixtures、Phase 0 采集与 freeze commit | 4–6 |
| V1 | Phase 1 静态检查 + disposer 测试 + 接入 gate | 2–3 |
| V2 | 差分 harness + event pipeline 测试矩阵 | 3–5 |
| V3 | context 结构度量和等价测试 | 3–4 |
| V4 | 生命周期 trace/泄漏测试 | 3–5 |
| V5 | session log 差分与 replay fixtures | 4–6 |
| CI 与报告 | workflow、report 格式化、防漂移规则 | 2–3 |
| **合计** | | **21–32 个窗口** |

该验证工程约占整个收敛工程总窗口的 **35%–40%**。这不是额外成本，而是把“人类验证时间”转成“机器验证时间”的必要投资；没有它，Phase 3 之后的语义重构不应开工。

---

## 9. 与主计划的接入方式

主计划每个 phase 的门禁从“手工跑测试”改为：

```text
Agent 交付定义 = verify:convergence check 通过 + 全量 vitest 通过 + report 生成
```

Phase 0 先把本验证工程建好，再进入 Phase 1。后续任何 phase 若 gate 尚未覆盖某类行为，先在 V 系列工作包中补 gate，再继续实现；不允许“先改完再补测试”。
