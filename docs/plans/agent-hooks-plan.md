# agent hooks 计划（一期：步前裁决面）

> 状态：**一期已竣工**（2026-10-13，B1-B4 全落；二期 request/turn-stopping + 存量收编待拍，三期 CC 兼容桥待拍）
> 目标：把 Agent 生命周期从「纯观测」升级为「可裁决、可注入」的扩展点体系——形态对标
> DSH 的 interception extension points（参照 `d:\useful\deepseek-harness` 的
> `packages/hooks/` 与 `.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`，
> 另参照 Claude Code 泄露快照 `D:\crap\jeecg-cc` 的 hooks 面）。一期只落**步前裁决（pre-step）**。
> 同族先例：工具管道裁决（`agent/events.ts` 的 guard/preflight/around + `ctx.hooks` 第七通道）。
> 契约：v54 → v55（四步流程，见 §4）。

## 0. 路线（三期，后两期单独拍）

- **一期（本件）**：步前裁决面——每步进入前可裁决 `enter`/`reject`、可向本步注入消息。
- **二期**：request / request-error / turn-stopping（含 steer 继续）点补全；内部注入链
  （plan 提醒 / 记忆更新 / inbox / 发现）从 loop 直读迁到公开面上吃狗粮。
- **三期（可选）**：CC hooks 兼容桥（command 子集）；用户配置面（settings 式）。
  判断留后：DSH 的桥做了大量减法（只 command、7/30 事件），说明兼容层是「给存量配置一个去处」，
  不是能力本体。

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
