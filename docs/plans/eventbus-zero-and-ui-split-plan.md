# 事件总线归零 + ui/ 层拆分计划

> 立项：2026-08-19（岛层退休收口当日立项；执行窗口：下一个新窗口）
> 状态：**P0 ✅ · P1 ✅（2026-08-19 本窗口完成：11 事件全退役 + events.ts 删除）· P2-P3 待执行**
> 守护：`tests/eventbus-zero-and-ui-split.test.ts`（三重只减不增门禁 + 终态断言）
> 前置：docs/plans/ui-react-island-retirement-plan.md（Done，2026-08-19）

## 1. 背景与目标

岛层退休后遗留两笔账：

1. **事件总线仍是冻结的活物**。events.ts 缩编到 11 事件后，冻结的理由（机会主义拆除有风险）
   已不成立——剩余事件全部 ≤2 消费者且消费面完全已知。冻结从「风险管理」退化成了「惯性」。
2. **ui/ 名不副实**。真正的 UI（React 组件）已全部迁走，57 个文件实际是
   scene 引擎（23）+ 状态层（12）+ 编排核心 + 基础设施适配器的杂物桶。

目标一句话：**总线归零删除，ui/ 拆成 scene/ + state/ + 诚实的残余**。

## 2. 完成判据（全部可测）

| # | 判据 | 验证方式 |
|---|---|---|
| C1 | `src/ui/events.ts` 不存在；全仓零 `ui/events` import | 守护终态断言 |
| C2 | `src/app/bridge-adapters.ts` 不存在；App.tsx 无 initBridgeAdapters | 守护终态断言 |
| C3 | `src/scene/` ≥23 文件；`src/ui/graph.ts` 为 ≤3 行 re-export shim | 守护终态断言 |
| C4 | `src/state/` ≥11 文件（10 存量 store + dock-config + P1 新增信号 store 全落此） | 守护终态断言 |
| C5 | 全量门禁：build + vitest + biome 改动文件零新增（规则级对照 HEAD） | §6 方法 |
| C6 | 文档回写：CONVENTIONS（bus 规则改写为「总线已退役」）、AGENTS §6、app/README、INVARIANTS #4（标记退役）、本计划 Done、plans/README | 人工 + 评审 |

## 3. 现状盘点（2026-08-19 实测）

### 3.1 剩余 11 事件全拓扑（emit/on 位点均为实测行号）

| 事件 | 发射方 | 消费方 | 退役设计 |
|---|---|---|---|
| check:result | workspace:1006 | bridge-adapters→shell-store | workspace 直写 dock-store（checkResult 已在）；**删 bridge-adapters 整文件** |
| agent:diag | workspace ×3 | chat-core:166 | agent-panel-store 加 diag {text, ready} 字段 |
| agent:tool-done | runtime-adapter:46（已双轨 bumpToolDoneTick） | agent-visualizer:36 + workspace:477 | toolDoneTick 扩为携带 payload 的 lastToolDone，两消费者订阅 |
| chat:turn-done | chat-core:782,1008 | main:644（追加持久化+自动保存） | 信号 store（turnDoneTick） |
| goal:state | chat-core ×3 + workspace:754（GoalManager 回调注入） | chat-core:170 | goal store；emit 点本就是回调注入，改一行 setter |
| prompt:ask | runtime-adapter:183 | chat-core:113 | ask store {seq, req}；callback-in-store 先例=overlay-store.TranslatorSession |
| highlight:file | app-shell:71 | chat-core:144 | chat-context store（与 navigate 合并设计或双信号，执行定） |
| navigate:file | app-shell:62 | chat-core:149 | 同上 |
| graph:rendered | graph.ts:553 | chat-core:163 | scene 信号 store；scene→state 方向已有先例（graph.ts 已订阅 useLangStore） |
| graph:node-clicked | graph-interaction-controller:297 | graph-interaction:21 | 两端同在 scene 集群：回调注入或 scene-local 信号 store，按实际接线定 |
| workspace:switched | main:271 | chat-core:171 | tick store；**消费端必须 epoch 守卫（INVARIANTS #12）** |

**归零可行性已验证**：冻结四文件（chat-session/chat-stream/part-mutator/execution-state）零 bus
emit/on；agent/events.ts 是独立管道（tool/guard 等），与 ui/events 无关；bus.clear 与
withPrefix 生产调用为零。

### 3.2 冻结钉住表（位置锁定约束）

冻结文件的 import 语句不可改 → 其相对引用的文件**不能搬家**：

| 冻结文件 | 钉住的 ui/ 内文件 |
|---|---|
| chat-session.ts | agent-panel-store, chat-store, message-model, tool-semantics |
| chat-stream.ts | chat-session, chat-store, **graph**（type StarGraph）, message-model, part-mutator, tool-semantics |
| part-mutator.ts | message-model, tool-semantics |

推论：
- **graph.ts 搬 scene/ 需在 ui/ 留 1 行 re-export shim**（本计划唯一特许的 shim——scene 集群
  完整性优先于零 shim 教条；chat-stream 的 type import 走 shim）
- agent-panel-store / chat-store / message-model / tool-semantics 留 ui/ 残余（本来就是
  chat 编排域，语义上属于那）

### 3.3 拆分清单

| 去向 | 文件 | 数量 |
|---|---|---|
| `src/scene/` | graph.ts + 21 个 graph-* + gpu-layout.ts | 23 |
| `src/state/` | scoped-store, panel-store, messages-store, session-store, input-store, dock-store, overlay-store, agent-config-store, timeline-store, dataflow-store, dock-config | 11 |
| `src/ui/` 残余（不动） | 冻结三 + chat-store + agent-panel-store + chat-utils + message-model + message-height + tool-semantics + runtime-adapter + lsp-client + app-shell + agent-visualizer + subagent-sink + command-registry + context-menu + file-translator(.css) + file-viewer + markdown-file-preview + icons + debug + pretext-cache + resize-zones + graph.ts(shim) | ~24 |

残余 ui/ 定位一句话（P3 写进目录 README）：**chat 编排域核心 + 旧层命令式基础设施**。
不改名（见 D8）。

## 4. 设计决策

- **D1 目标是归零不是缩编**：每事件 ≤2 消费者且全已知，总线的解耦价值归零；部分保留会让
  EventBus 类 + BusEvents 类型 + INVARIANTS #4 为个别事件永生。全删总复杂度低于任何部分保留。
- **D2 先归零后拆分**：语义工作（P1）在稳定布局下做；P1 新建的信号 store **直接落 state/**
  （P1 第一步即创建该目录），避免二次搬家。
- **D3 类型随状态走**（岛层退休确立的原则延续）：退役事件的 payload 类型随 store 走。
- **D4 钉住不搬**：§3.2 钉住的文件一律留 ui/，除 graph.ts 的特许 shim。
- **D5 callback-in-store 是既定模式**：overlay-store.TranslatorSession 先例；prompt:ask 的
  callback 进 store 反而比 bus 更稳（pending 请求跨 chat-core 重建存活）。
- **D6 workspace:switched 消费端 epoch 纪律**：chat-core._refreshGoalRecord 是跨工作区触发，
  store 订阅必须 `getWorkspaceEpoch()/isCurrentEpoch()` 守卫（INVARIANTS #12）。
- **D7 对称拆除**：chat-core 的 bus.on 目前无对称 off（疑似单例设计）。替换为 store.subscribe
  时先确认其生命周期；单例则一次性订阅常驻，非单例则镜像现有清理路径——**不新增不减少清理点**。
- **D8 残余 ui/ 不改名**：收窄后一句 README 定义即可；名字 churn 无功能收益。

## 5. 阶段

### P0 ✅（2026-08-19，本窗口）

- 本计划 + 判据表
- 守护测试 tests/eventbus-zero-and-ui-split.test.ts：
  ① events.ts 事件名 ⊆ 11 基线（只减不增）；② ui/ 文件 ⊆ 59 文件 manifest（只减不增，
  禁止新文件落 ui/——新 store 一律去 state/）；③ app/** 的 ui/events import 仅允许
  chat-core 与 bridge-adapters（过渡期豁免面，终态全零）
- plans/README 注册 + CONVENTIONS 封口行

### P1 ✅（2026-08-19，本窗口）事件归零（语义工作，风险升序，每步 tsc + 定向 vitest）

实际执行记录：11 事件全数退役，新增 6 个信号 store 落 `src/state/`（turn-done / goal /
chat-context / scene-signal / ask / workspace-switch），agent-panel-store 扩展 diag +
lastToolDone（tool-done 双轨合并单轨），bridge-adapters.ts 删除、workspace 直写
shell-store 违章徽标，chat-core 全部 bus.on 换 store 订阅（workspace:switched 消费端
补 INVARIANTS #12 epoch 守卫），prompt:ask 落 callback-in-store + 回归测试
tests/ask-store.test.ts（pending 期 chat-core 重建），events.ts 整文件删除，30 个测试
文件的陈旧 ui/events mock 清零，守护测试适配「文件已删则门禁天然满足」。
执行差异：graph:node-clicked 实测有两个消费者（graph-interaction + chat-core，
计划拓扑表漏登后者），均迁 scene-signal-store。

1. check:result → workspace 直写 dock-store；删 bridge-adapters.ts + App.tsx 挂载行
2. agent:diag → agent-panel-store.diag；chat:turn-done → turnDoneTick（简单信号热身）
3. goal:state → goal store（多点 emit 但全是回调注入改写）
4. agent:tool-done → 合并双轨为 lastToolDone payload
5. highlight:file + navigate:file → chat-context store（同消费点，一起做）
6. graph:rendered + graph:node-clicked → scene 信号（先核对 interaction↔controller 接线）
7. prompt:ask → ask store（callback 生命周期最微妙，放后）
8. workspace:switched → tick store + epoch 守卫（语义最深，最后）
9. 删 events.ts 整文件（EventBus 类 + bus + BusEvents）；INVARIANTS #4 加退役旁注
10. 每步后：npx tsc --noEmit 零错 + 相关测试文件单跑

### P2 物理拆分（纯 git mv + import 路径，零逻辑改动）

- Batch S（state/）：11 文件 → src/state/；消费方改路径（app/**、ui/ 残余、main/workspace）
- Batch G（scene/）：23 文件 → src/scene/；ui/graph.ts 置换为 1 行 shim；
  消费方改路径（main、workspace、runtime-adapter、app/、ui/ 残余内部）
- 方法：占位符两步法 + 深度表（§6）；CSS side-effect import 单独审计
  （ui/ 内仅 file-translator.css 一枚，不随批次走）
- 高 fan-in 大文件（graph.ts / graph-scene.ts）改前先跑 preflight

### P3 终态收口

- 守护测试翻 COMPLETE=true（终态断言生效）
- 文档回写：CONVENTIONS bus 段改写、AGENTS §6、app/README、ui/ 残余 README、
  INVARIANTS #4 旁注、本计划 Done、plans/README
- 全量门禁：npm run build + npx vitest run + biome 规则级对照零新增

## 6. 执行方法论（岛层退休实战教训，直接复用）

1. **中文内容读写一律 .NET IO**：`[System.IO.File]::ReadAllText/WriteAllText` +
   `UTF8Encoding($false)`。Get/Set-Content 按 GBK 误读会毁文件（已炸过一次）。
2. **路径改写占位符两步法**：先 `from '../../X'` → `from '@S@/X'` 类占位，再统一替换真实
   前缀。**动手前先写深度表**（上次两级/一级算错两次）。
3. **CSS side-effect import 不带 from**，正则改写必漏——每批次后 `git grep "^import '"` 审计。
4. **biome 零新增验证**：规则级计数对照 HEAD 同文件（`git show` 到临时文件再跑 biome；
   临时文件名不能以 . 开头，否则 biome 当隐藏文件跳过返回假 0）。
5. vitest 与 vite build 不并行（worker 超时假失败）；跑测试前清 NODE_ENV。
6. 关键编辑批次用顺序 await（parallel-array 一败全败、静默丢后续）。
7. stash 往返若留 DU 冲突态：先验工作树内容完整性，再 git add 解决，勿慌。
8. 禁触面：冻结四文件、agent/**、graph-layout/gpu-layout 的**参数**（搬家可以，改参数不行）、
   .github/workflows/ci.yml。

## 7. 明确不做（Non-goals）

- 残余 ui/ 改名或继续缩编（i18n、icons、lsp-client 等的去向是未来另议）
- agent/events.ts（执行管道内部机制，与本项目无关）
- cordis/ 内核
- 任何布局参数、渲染逻辑、交互行为的变更——P2 是纯位置移动
- graph-interaction ↔ controller 接线方式的重构（除非 node-clicked 退役确实需要）

## 8. 风险表

| 风险 | 缓解 |
|---|---|
| prompt:ask callback 生命周期 | store 方案反而更稳；执行时写一条回归测试（pending 期 chat-core 重建） |
| workspace:switched epoch 语义 | D6 强制守卫；对照现有 INVARIANTS #12 案例审 |
| graph.ts 外部消费面比预估大 | P2 前跑 graph(preflight) 实测 fan-in；shim 兜底冻结侧 |
| chat-core 非单例导致订阅泄漏 | D7：先确认生命周期再选订阅模式 |
| 事件退役改变时序（同步 emit vs 异步 store 通知） | zustand subscribe 是同步的，语义等价；仍需逐事件跑相关测试 |
