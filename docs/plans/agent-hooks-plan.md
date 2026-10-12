# agent hooks 计划

> 状态：**在办**——一期已竣工（2026-10-13）· 二期施工单已定（§7，待施工）· 三期待拍
> 目标：把 Agent 生命周期从「纯观测」升级为「可裁决、可注入」的扩展点体系——形态对标
> DSH 的 interception extension points（参照 `d:\useful\deepseek-harness` 的
> `packages/hooks/` 与 `.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`，
> 另参照 Claude Code 泄露快照 `D:\crap\jeecg-cc` 的 hooks 面）。
> 同族先例：工具管道裁决（`agent/events.ts` 的 guard/preflight/around + `ctx.hooks` 第七通道）。
> **分期：一期（§1-§6，步前裁决面，契约 v54 → v55）· 二期（§7，面扩展 + 停止边界 + 收编首批，
> 契约 v55 → v56）· 三期（待拍：request 系列 / plan·inbox 收编 / CC 兼容桥）。**

## 0. 路线

- **一期（已竣工 2026-10-13）**：步前裁决面——每步进入前可裁决 `enter`/`reject`、可向本步
  注入消息（§1-§6）。
- **二期（施工单已定，§7）**：面扩展（transient 注入 / per-Agent 实例 / 多事件）+ 停止边界
  （turn-stopping）+ 收编首批（发现注入）。
- **三期（待拍）**：request / request-error 点（待真实消费者）；plan 提醒与 inbox 收编
  （待「钩子上下文面」设计）；CC hooks 兼容桥（可选——DSH 的桥做了大量减法，说明兼容层是
  「给存量配置一个去处」不是能力本体）。

## 1. 一期设计（决定）

### 1.1 形态

- **新内核件** `src/agent/pre-step.ts`：`PreStepHook` / `PreStepRegistry` / `PreStepDecision` /
  `PreStepPayload`。registry 形状与 `agent/hooks.ts` 的 HookRegistry 同构（register → Disposer）。
- **贡献通道** `ctx.preStep`（`src/composition/pre-step-service.ts`，照 `hook-service.ts` 抄）：
  timing = `next-assembly`（同 hooks——下次 Agent 装配生效，在途会话冻结）；
  贡献形状 `{ id, hook }`（id = `<插件名>/<贡献名>`，重名装载期拒绝）。
- **装配折叠**：runtime `_assembleAgent` 在 hooks 折叠（步骤 5b）之后同址折叠
  `activePreStepContributions()`——序：capability 先、通道贡献随后（同 hooks 约定）；
  capability 经 `BlueprintScope.preStep`（新成员）注册；Agent 侧新增 `setPreStep(registry)`。
- **消费**：default-loop 每步入场调用（`AgentLoopHost` 新增只读成员 `preStep`）。
  **无 registry / 空注册者 ⇒ 逐字节零行为变化**（直通 enter、不产生任何消息/事件）。
- **子 Agent 不继承**（同 hooks 语义：spawnSubAgent 手工建的 registry 不挂 pre-step 贡献）。

### 1.2 语义

- **裁决值**：`{ action: 'enter'; messages?: PreStepMessage[] }` | `{ action: 'reject'; reason?: string }`
  （`PreStepMessage = { content: string }`，content 原样进消息，贡献者自备文本形态）。
- **合并**：按注册序**全跑**（每个 hook 都收到调用；`shouldRun?` 返回 false 跳过）；
  **任一 reject ⇒ 整体 reject**（reason 取第一个非空）；全部 enter ⇒ 注入批按序累积。
  （对齐 DSH hook-protocol 的 most-restrictive fold；不做 DSH 的 `next()` 链——那是适配器层语义，
  兰台没有桥的序列化边界，直接聚合更诚实。）
- **注入落地**：enter 批作为**落会话的 `user/message`**（durable）——这是「用户每次发消息时注入一段
  文字」的正式入口；落点在**本步现有注入链之后**（`injectDiscoveries()` 后、压缩预检前），
  保证：① 不动现有消息次序；② 注入后仍受压缩预检保护。
- **reject**：不开步（不发 `step/start`、不发请求），本轮结束（`turn/end` 照常收尾）；
  reason 经 UI Notice 可见（**模型不可见**——无请求即无模型消息，对齐 DSH blocked turn）。
- **异常降级**：单 hook 抛错 = catch + log.warn + 视作未投（不阻断、不否决）——对齐
  「Hook 崩溃静默降级，绝不影响工具结果」的既有语义（`agent/hooks.ts` 头注）。

### 1.3 时序（default-loop 每步入场，标注 [新] 为插入点）

```
stepBoundary（脉搏+栅栏）
[新] pre-step 裁决（reject ⇒ Notice + 本轮结束）
emit step/start
transientReminders 清空 / plan 注入 / applyPendingInserts / 记忆更新 / drain / inbox / 发现
[新] enter 注入批落盘（user/message）
压缩预检 → stream → …（既有全部不动）
```

### 1.4 裁定记录（自裁项+理由，事后有异议再翻案）

| 项 | 裁定 | 理由 |
|---|---|---|
| 事件名 | `agent/pre-step` | 借 DSH 原名（模板对齐）；与 `step/start` 不混淆（它是「步前」的裁决点） |
| 走 bus 还是 registry | **registry**（loop 直读，不走 AgentEventBus） | 消费方唯一（loop）；装配期需要独立注册面对象（capability 在 Agent 构造前注册，bus 在构造内才存在）；先例 = `planInjector` 直读面。bus 事件面扩张留二期评估 |
| 合并语义 | 全跑取最严 + 注入累积 | 对齐 hook-protocol fold；审计友好（每个 listener 都能观察本轮）；比 next 链简单可测 |
| 注入形态 | durable `user/message` | DSH 同款（pre-step 的 messages 进会话）；transient 那套（system-reminder）二期收编时再统一 |
| 来源元数据（source） | 一期不做 | `{ content }` 最小形状；结构化来源是纯增字段，需要时同批加 |
| reject 的模型可见性 | 不可见（只给 UI） | 对齐 DSH「blocked prompt is discarded with no model-visible message」 |
| 存量注入链 | 不迁 | 一期回归面 =「零变化 + 新面独立生效」；迁移是二期的事 |
| payload | `{ agentId, step, signal }` | 最小可用；claim 时序不动的约束下（messages 批在本步注入后才可得），不在 payload 里带消息 |

## 2. 改动清单

**新增**

| 文件 | 内容 |
|---|---|
| `src-ui/src/agent/pre-step.ts` | `PreStepHook` / `PreStepRegistry` / `PreStepDecision` / `PreStepPayload`（新内核件） |
| `src-ui/src/composition/pre-step-service.ts` | `ctx.preStep` 通道 service（照 hook-service.ts） |
| `src-ui/tests/pre-step.test.ts` | loop 行为面测试（见 §4） |
| `src-ui/tests/composition-pre-step-service.test.ts` | 通道测试（重名拒绝 / disposer / 形状校验） |

**修改**

| 文件 | 内容 |
|---|---|
| `src-ui/src/agent/blueprint.ts` | `BlueprintScope.preStep` 成员 |
| `src-ui/src/agent/runtime/runtime.ts` | registry 构造 + hooks 折叠后同址折叠 + `setPreStep` |
| `src-ui/src/agent/agent.ts` | `_preStep` 字段 + `setPreStep` + `_loopHost` 暴露 |
| `src-ui/src/agent/agent-loop/types.ts` ⚠️契约 | `AgentLoopHost.preStep` 只读成员（第三方 loop 不读 = 零影响） |
| `src-ui/src/plugins/builtin/agent-loop-service/default-loop.ts` ⚠️契约 | 消费点（两个插入点，见 §1.3） |
| `src-ui/src/plugins/service-plugins.ts` | 内核 service 表尾追加第 19 项（表序 = 字节契约） |
| `src-ui/src/agent/dynamic-runner/sandbox.ts` | 动态插件白名单补 `preStep`（三处：GUARDED_SERVICES / REQUIRED_FN_MEMBERS / SHAPE_CHECKS） |
| `src-ui/src/composition/contract-version.ts` | v54 → v55 + 契约文件清单登记新件 |
| `docs/agents/open-surface-contract.md` | 变更记录加一行 |
| `docs/plugins/README.md` | 通道表加 `ctx.preStep` 行（唯一人类契约） |
| `docs/plans/README.md` | 活跃线接入本件 |
| `docs/agents/REGISTRY_OWNERSHIP.md` | 新 registry 所有权登记（检查后同步） |

**生成物（重跑，勿手改）**：`docs/facts.generated.md`、`docs/agents/service-catalog.md`、
`docs/agents/open-surface-contract.md` 指纹段。

## 3. 边界（一期不做）

- 不动 claim 时序（`applyPendingInserts` 位置不动）、不动现有注入链、不加 bus 事件。
- 不做用户配置面、不做 CC 兼容桥、不做出厂示例插件（能力由测试覆盖证明）。
- 不改子 Agent 继承语义（不继承，同 hooks）。
- 不扩 payload 上下文（planState 等要看需求再加）。

## 4. 测试与门禁

- `tests/pre-step.test.ts`：①零注册 ⇒ 事件序/消息逐字节不变（回归门）；②enter + 注入 ⇒ 消息落会话、
  模型可见；③reject ⇒ 不开步（无 step/start、无 request）、Notice 可见、turn 正常收尾；
  ④多 hook 合并（注入累积 / 任一 reject 短路 / shouldRun 跳过）；⑤async decide；⑥hook 抛错降级。
- `tests/composition-pre-step-service.test.ts`：重名 id 装载期拒绝、disposer 幂等+陈旧性守卫、
  timing 声明、装载期形状校验（畸形贡献拒绝）。
- 集成半边：贡献注册 → 真实装配链 → loop 生效（参照 hooks 通道既有测试的装配复现方式）。
- 同步检查：`tests/dynamic-runner.test.ts`（白名单↔真装配对拍）、`tests/agent-loop-events.test.ts`
  （emit 域不受影响）、`tests/first-party-manifest.test.ts` / `tests/builtin-roster.test.ts`（派生面）。
- 门禁：`npm run build` + `npx vitest run`（全量）+ `npx biome ci .` 0/0 +
  `npm run verify:convergence`（双轨 standard + minimal，**baseline 期望零漂移**）；
  `npm run doc-sync` / `doc-check`。
- 契约四步：①改契约文件 → ②bump v55 → ③open-surface-contract.md 加行 → ④`gen:contract-fingerprint`，同 commit。

## 5. 批次

- **B1** 内核件：`agent/pre-step.ts` + `composition/pre-step-service.ts` + 通道测试。
- **B2** 装配接线：blueprint / runtime / agent / host / service-plugins / sandbox（+派生面测试）。
- **B3** loop 消费：default-loop 两个插入点 + `tests/pre-step.test.ts`。
- **B4** 契约与文档同步 + 全量门禁（build / vitest / biome / convergence）。

## 6. 竣工回执（2026-10-13）

B1-B4 全落，门禁全绿：vitest 421 文件 / 4470 用例、build、biome 0e0w、
`verify:convergence` 双轨零漂移、doc-sync + doc-check。与设计的两处差异（均已收进实现）：

1. **空表 size 短路**：default-loop 的消费条件为 `host.preStep && host.preStep.size > 0`——
   无注册者时**连同步时序都零变化**（非注册表语义的异步调用会截断「同步通到底」路径，
   `tests/landmine-l3-hang.test.ts` ⑤ 现场逼出并守护）。
2. **沙箱白名单同批**：动态插件面补 `preStep`（GUARDED_SERVICES + SHAPE_CHECKS），
   静态/动态两条装载路径对同一通道开放。

计数面同步：内核 service 18 → 19、第一方插件 57 → 58（manifest / loader 派生 /
特权区冻结基线 / PLUGINS.md / 生成物）。

## 7. 二期施工单 —— 步骤钩子家族扩展 + 停止边界 + 收编首批

> 状态：待施工。契约 v55 → v56。含一处对一期的**破坏性重命名**（`ctx.preStep` → `ctx.steps`）——
> 一期零消费者窗口期，一次做全（改名、文件、文档、契约、生成物）。

### 7.0 目标（三件事）

1. **面扩展**：把一期单点面扩成「步骤钩子家族」——多事件（`on`）、transient 注入（`reminders`）、
   per-Agent 实例（`create` 工厂）。
2. **新点**：`turn-stopping`——自然停止边界的裁决（停 / 继续 + 注入），含防失控护栏。
3. **收编首批**：发现注入（`_injectDiscoveries`）迁为面上一等公民——验证面能力、统一注入管道。

### 7.1 面扩展（决定）

**通道改名 + 多事件化**：`ctx.preStep` → **`ctx.steps`**（`composition/steps-service.ts`）；
贡献形状带 `on` 事件标识（替换一期的 `{ id, hook }`）：

```ts
type StepHookContribution =
  | { id: string; on: 'pre-step'; hook: PreStepHook; create?: (scope: StepHookScope) => PreStepHook }
  | { id: string; on: 'turn-stopping'; hook: TurnStoppingHook; create?: (scope: StepHookScope) => TurnStoppingHook };

interface StepHookScope {
  agentId: string;
}
```

- **`create` 工厂**（可选；给定时优先）：装配折叠时为**每个 Agent 调一次**，实例随 Agent 生命周期——
  补上一期「贡献实例跨装配复用、插件自担状态性」的缺口，让「需要 per-Agent 状态」的钩子有正确归属。
- **注册表**（`StepsRegistry`）判据按事件维度：`hasListeners(on)`——loop 的零注册短路按事件，
  各点独立零开销。
- **PreStepDecision 扩展**：`enter` 分支加 `reminders?: PreStepReminder[]`（transient——content
  原样 push 进 `transientReminders`，只给本次请求、不落会话；落地 = 本步注入链尾、压缩预检前，
  与一期 `messages` 同址）。durable（落会话）与 transient（每次请求重建）的既有分工不变。

### 7.2 turn-stopping（决定）

```ts
interface TurnStoppingPayload {
  agentId: string;
  step: number;
  signal: AbortSignal;
}
type TurnStopDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: string; messages?: PreStepMessage[]; reminders?: PreStepReminder[] };
interface TurnStoppingHook {
  name: string;
  shouldAsk?(payload: TurnStoppingPayload): boolean;
  decide(payload: TurnStoppingPayload): TurnStopDecision | Promise<TurnStopDecision>;
}
```

- **消费点**：default-loop 自然停止分支（`calls.length === 0 && pendingInserts.length === 0`），
  在 `emit step/end` 之前裁决；**两个分支都发 step/end**（本步已闭合），continue 再开下一步。
- **合并**：全跑；**任一 continue ⇒ 继续**（默认停——与 pre-step「任一 reject ⇒ 停」对称：
  一个默认进、有人拦则停；一个默认停、有人推则走）；注入累积；reason 取第一个非空（记 log）。
- **护栏**：同 turn 连续 continue 上限 `MAX_TURN_CONTINUES = 3`（default-loop 导出常量）——
  超限强制停 + `log.warn` + UI Notice。防「无条件继续」死循环（DSH 的 hook 桥至今没有这道闸，
  兰台显式补上）。
- **零注册者 = 直通 stop**，逐字节零行为变化（同款短路纪律）。

### 7.3 收编首批：发现注入（决定）

- 迁移对象：`Agent._injectDiscoveries`（含 `_injectedDiscoveryIds`）→ **装配期内建 pre-step
  钩子**（闭包持 board + 去重集；无需 `create`——装配点天然 per-Agent）。
- 接线点：`runtime._assembleAgent` 的 5c 段——**内建钩子先于通道贡献**（同「capability 先、
  通道贡献随后」精神）；钩子工厂落 `src/agent/discovery-reminder-hook.ts`（与 discovery-board 相邻）。
- 拆除（死代码不留）：`Agent._injectDiscoveries` / `_injectedDiscoveryIds` /
  `AgentLoopHost.injectDiscoveries` 成员 / loop 调用点 / `Agent.setDiscoveryBoard`（无调用方的
  死方法——构造路径 `ctx.get('discoveryBoard')` 已覆盖，连带清理）。
- **行为对齐**：注入内容与判据（非己 + 未见 + 5 分钟窗）逐字不变；**顺序位移**显式记录——
  发现提醒由「注入链中段」移到「链尾」（面 reminders 的统一点）。行为测试以 git 史旧实现为参照
  逐条对齐。

### 7.4 收编评估（本轮不做，留档结论）

- **plan 提醒**：缓（三期候选）。需先解决三件事——（a）钩子读取 plan 文件的 IO 面
  （b）payload 对 reset 语义的表达（c）产物注册路径。三者都是「钩子上下文面」的设计题，
  等第二个同类消费者出现时一并设计。
- **记忆更新**：不迁。推入式语义（app 事件 → Agent 队列 → 注入）与面（拉取裁决）不匹配；
  app 内部闭环，不是扩展点。
- **后台任务通知**：不迁。IO 拉取（process_cap RPC），非注入决策。
- **inbox 注入**：三期。bus/ack 语义耦合深（consume / 已注入 id / durable+transient 混合 /
  补唤醒联动），收益与风险比不划算。
- **turn-start 块**（workspace 会话落盘注入）：不迁。app 层事件驱动，不走 loop。

### 7.5 改动清单

**新增**：`src/agent/discovery-reminder-hook.ts`（收编钩子工厂）
**重命名/扩展**：`agent/pre-step.ts` → `agent/steps.ts`；`composition/pre-step-service.ts` →
`composition/steps-service.ts`
**修改**：`blueprint.ts` / `runtime.ts` / `agent.ts` / `agent-loop/types.ts` / `default-loop.ts` /
`plugins/service-plugins.ts` / `dynamic-runner/sandbox.ts`（白名单改名 + 形状扩展）/
`composition/contract-version.ts`（v56 + 清单更新）
**测试**：`pre-step.test.ts` → `steps.test.ts`（扩展）；`composition-pre-step-service.test.ts` →
`composition-steps-service.test.ts`；新增 `turn-stopping.test.ts`、发现收编行为测试
**文档**：`docs/plugins/README.md`（`ctx.steps` 节重写——含 turn-stopping 语义）、
`open-surface-contract.md`、生成物重跑、`docs/plans/README.md`、本件

### 7.6 边界（不做）

- 不做 request / request-error 点——无真实消费者；兰台的请求构造是派生式（拦截价值与
  pre-step 重叠、改写无场景）。触发条件 = 出现第一个真实需求。
- goal 循环 / 补唤醒 / 会话落盘注入保持原样（与 turn-stopping 正交；合流评估留三期）。
- payload 不扩字段（`hasNewUserInput` 等留到 plan 迁移同批——无消费者不预防性扩展）。

### 7.7 测试与门禁

- 面：reminders（进 transientReminders、不进会话）；factory（两 Agent 两实例、状态隔离）；
  `on` 分派与 per-事件短路；改名全量对齐（`preStep` 旧名 grep 清零）。
- turn-stopping：stop 默认；continue（同 run 下一步 + 注入落地 + 事件序 step/end → 新 step/start）；
  上限强制停（含 Notice）；崩溃/畸形返回值降级；零注册零变化。
- 收编：发现注入行为测试（对拍 git 史旧实现逐条对齐）；顺序位移记录在案。
- 门禁：build / vitest 全量 / biome / `verify:convergence` 双轨（期望零漂移；若顺序位移引起
  baseline 漂移 = 显式走 baseline-change-request，不偷跑）/ doc-sync + doc-check。
- 契约四步：v55 → v56（bump + 记录 + 指纹 + 同 commit）。

### 7.8 批次

- **B1** 面扩展：改名 + 多事件 + reminders + `create` 工厂 + registry 判据 + 测试对齐。
- **B2** turn-stopping：面 + 消费 + 护栏 + 测试。
- **B3** 收编：发现注入迁移 + 旧路径拆除 + 行为对拍测试。
- **B4** 契约/文档/生成物 + 全量门禁。
