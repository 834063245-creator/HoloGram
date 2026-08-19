# ui/react/ 岛层退休计划

> 立项：2026-08-19（会话拍板：冻结策略缺判据已拖散，改为专门立项一次做完）
> 状态：**Done — 2026-08-19 单日完成（P0 立项 → P1 信号层 5 事件退役 → P2 全量物理搬家 → P3 终态收口）**
> 终态守护：`tests/ui-react-retirement.test.ts`（目录空 + 5 事件零残留 + src/ 零 ui/react 路径引用）

## 1. 背景与目标

`ui/events.ts` 冻结 + `ui/react/` 岛层是 frontend-refactor（P0–P7）的既定策略，
但「逐步退休」从未定义判据，也无计划跟踪：新岛组件（TasksPanel / AgentsPanel /
BackgroundActivity / BrowserActivityPanel，2026-08-14/15 出生）仍在往 `ui/react/` 落。

本计划把「退休」变成一次有判据、有守护、有门禁的收口工程：

- **目标**：`src-ui/src/ui/react/` 目录清空删除；岛专属的 5 个总线事件随之退役；
  全部岛组件物理迁入 `src/app/**`（一个例外见 §4.6）；`events.ts` 缩编不删除。
- **非目标（scope guard）**：
  - 不动 `ui/` 其余模块（graph 家族 / stores / file-viewer / runtime-adapter / app-shell 的退休是另一个未来计划）
  - 不动冻结文件 `ui/chat-session.ts` / `ui/chat-stream.ts` / `ui/part-mutator.ts` / `agent/execution-state.ts`
  - 不碰 `src-ui/src/agent/**`（不触发 verify:convergence 门禁）
  - 不删除 `events.ts` 本体——缩编后它继续作为旧层编排内部信号（存亡判定见 §3）
  - 不动 graph-layout / gpu-layout 布局参数

## 2. 验收判据（可机器验证）

| # | 判据 | 验证方式 |
|---|---|---|
| C1 | `src-ui/src/ui/react/` 目录不存在 | 守护测试终态断言（RETIREMENT_COMPLETE=true） |
| C2 | `BusEvents` 不含 `agent:status` / `agent:config-changed` / `lang:changed` / `timeline:refresh` / `dataflow:saved` | 守护测试对 events.ts 源码断言 |
| C3 | `src/` 与 `tests/` 中 `ui/react` 路径零命中 | grep 验证 |
| C4 | `app/**` 中 ui/events import 零新增（既有豁免：chat-core 编排层、bridge-adapters 桥） | grep 验证 |
| C5 | 全量门禁绿：`npm run build` + `npx vitest run` + biome 改动文件零新增 | CI 门禁 |
| C6 | 文档回写：CONVENTIONS §6 / app README / AGENTS §6 / docs/plans/README / INVARIANTS #4 旁注 | 评审 |

## 3. 现状盘点（2026-08-19 实测）

32 个文件（react/ 直下 25 + settings/ 7），全部有活消费者、零死岛。
挂载拓扑：全部经 app 单树收编（ChatBeacon / panel-def / App / StatusBar / FileTranslatorPortal），
唯一旧层宿主是 `ui/file-viewer.tsx`（MarkdownFilePreview）。

bus 触点组件 8 个（其余 24 文件不碰 bus）：

| 组件 | 事件 | 方向 | 重接线方案 |
|---|---|---|---|
| SettingsPanel | agent:config-changed / lang:changed | emit | 调 ui/agent-config-store + ui/lang-store |
| ModelSwitcher | agent:config-changed | emit | 同上 |
| ChatFooter | agent:config-changed | emit | 同上 |
| AgentsPanel | agent:status | on | useAgentPanelStore.subscribe（runtime-adapter 已写入 store） |
| BackgroundActivity | agent:status + agent:tool-done | on | agent-panel-store 新增 lastToolDone 切片 |
| BrowserActivityPanel | agent:tool-done | on | 同上 |
| TimelineHUD | timeline:refresh | on | ui/timeline-store（refreshSeq） |
| DataflowPanel | dataflow:saved + workspace:switched | on | ui/dataflow-store（savedSeq）+ dock-store.projectPath 订阅 |

事件存亡判定：

- **退役 5 个**：`agent:status`（岛是唯一消费者）、`agent:config-changed`（岛是唯一生产者，main.ts 唯一消费者）、`lang:changed`（SettingsPanel 唯一生产者，graph.ts 唯一消费者）、`timeline:refresh`（TimelineHUD 唯一消费者）、`dataflow:saved`（DataflowPanel 唯一消费者）
- **存活但缩编**：`agent:tool-done`（workspace 的 FILE_MODIFY_TOOLS 语义过滤链与 agent-visualizer 都在旧层 → 保留，岛侧消费者改 store）、`workspace:switched`（chat-core 豁免层仍在 → 保留，DataflowPanel 改订 dock-store.projectPath）
- **不动**：其余 9 个事件（agent:diag / prompt:ask / check:result / goal:state / chat:turn-done / graph:node-clicked / graph:rendered / highlight:file / navigate:file）生产消费两端都在旧层或豁免层

## 4. 设计决策

1. **先重接线、后搬家**：P1 在原位把 8 个组件的 bus 依赖换成 store，P2 才做纯 git mv。
   任何中间时刻 app/ 代码都不 import ui/events——不需要临时豁免。
2. **信号 = zustand seq store**（per-domain 小模块，~25 行）：agent-config（`{seq, reason}` + notify）、
   timeline（refreshSeq + bump）、dataflow（savedSeq + bump）；lang 是真状态（`{lang}` + setLang）。
   lang 信号若现有 i18n 模块已持有 current lang 则并入该模块，否则新建 ui/lang-store.ts。
   类型 `AgentConfigChangeReason` 随 agent-config-store 搬家（workspace.ts / ModelSwitcher import 同步改）。
3. **agent:tool-done 双轨**：runtime-adapter 发 bus（旧层消费者）的同时写
   agent-panel-store.lastToolDone（岛侧消费者订阅）。
4. **agent:status 直接触发 store 订阅**：runtime-adapter onAgentStatus 本就先写 store 再 emit；
   AgentsPanel / BackgroundActivity 的 handler 都只是「踢一脚重读 store」→ 直接 subscribe store 变化。
5. **ContextMenu 健在**（P7c「无触发路径」笔记已过时——Composer.tsx 消费 showContextMenu）：
   组件 + Host 迁 app/；`ContextMenuItem` 类型下沉进 ui/overlay-store.ts（它本就是 ContextMenuRequest 的字段类型）；
   ui/context-menu.ts 从转发 shim 改为本地实现（showContextMenu = 写 overlay-store，5 行，无 React 依赖）→
   app/chat/Composer 的既有 import 路径不变。
6. **MarkdownFilePreview 例外**：宿主 ui/file-viewer.tsx 是旧层长期住户（Monaco 宿主，AGENTS 认定的
   imperative-DOM 所有者）→ 组件迁至 ui/markdown-file-preview.tsx（同层随主），不进 app/，避免 ui→app 反向边。
7. **ModelSelector 随 settings/ 组走**：唯一消费者是 settings/ProviderDetail → app/panels/settings/ModelSelector.tsx。
8. **helpers.ts → app/panels/helpers.ts**：三个消费者（Check / Dataflow / FileTranslator）全是面板。

## 5. 阶段

### P0 立项（✅ 2026-08-19）

- 本文档 + docs/plans/README 注册
- 守护测试 tests/ui-react-retirement.test.ts（manifest 模式：32 文件白名单，断言实际 ⊆ 白名单；
  RETIREMENT_COMPLETE=false；终态翻 true 后断言目录空 + events.ts 无 5 事件名）
- 封口：CONVENTIONS §6 + app/README 追加「ui/react/ 只减不增，新组件落 app/**」

### P1 信号层重接线（组件原位，5 个子步每步独立验证）

- 1a ✅（2026-08-19）lang:changed → i18n.useLangStore（setLang/t/getLang 读写 store）；
  SettingsPanel 删 emit；graph.ts ctor subscribe + graph-scene-lifecycle destroy unsub；事件已删。
  语义微调：同值 setLang 不再触发图例重建（旧版每次保存都无条件重建，纯冗余 DOM churn）
- 1b ✅（2026-08-19）agent:config-changed → ui/agent-config-store（seq+reason）；
  ChatFooter/ModelSwitcher/SettingsPanel 改 notifyAgentConfigChanged；main.ts 改 subscribe；
  AgentConfigChangeReason 类型搬家至 store 模块；事件已删；2 个测试改断言
- 1c ✅（2026-08-19）agent:status 退役 + agent:tool-done 双轨：agent-panel-store 增 statusTick/toolDoneTick
  （refresh 只写数据字段不写 tick，无订阅回路）；runtime-adapter 删 status emit、tool-done 发 bus 同时 bump tick；
  AgentsPanel / BackgroundActivity / BrowserActivityPanel 改 store 订阅；agent:status 事件已删
- 1d ✅（2026-08-19）timeline:refresh → ui/timeline-store（refreshTick）；workspace 4 处 emit 改 bump；
  TimelineHUD 改订阅（600ms 防抖保留）；事件已删；backoff 测试的惰性 bus mock 顺手清除
- 1e ✅（2026-08-19）dataflow:saved → ui/dataflow-store（savedTick）；runtime-adapter onDataflowSaved 改 bump；
  DataflowPanel 保存信号订 dataflow-store、工作区切换改订 shell-store.projectPath（注意：交接文档说 projectPath
  在 dock-store 已过时，实测在 shell-store）；事件已删
- 每子步：tsc + 相关单测（model-switcher / settings-panel-save-split / timeline-hud-backoff 等）
- P1 收口跑全量 vitest

### P2 ✅（2026-08-19）物理搬家（纯 git mv + import 路径，零逻辑改动）

四批：chat 七件套 → app/chat/；面板组（6 面板 + settings/7 + helpers + BrowserActivityPanel +
FileTranslatorPanel）→ app/panels/；TimelineHUD / BackgroundActivity / ContextMenu → app/；
MarkdownFilePreview → ui/markdown-file-preview.tsx

- 生产 import 点 ~12 处 + 测试 7 文件 + ui/context-menu.ts 本地化 + overlay-store 类型下沉
- 搬家批次前核对 co-located CSS（prompt-shelf.css / TasksPanel.css / AgentsPanel.css / BackgroundActivity.css）
  的实际 importer；settings/ 组内相对 import 随组保持
- manifest 白名单随批次扣减；P2 收口全量 vitest + build

### P3 ✅（2026-08-19）缩编收口

- 删 ui/react/ 目录（已删）
- 守护测试翻终态（3 断言：目录空 / 5 事件零残留 / src 零路径引用）
- 类型随状态走：CheckResult/Violation 迁入 dock-store（checkResult 单一事实源）；ContextMenuItem
  迁入 overlay-store；ui/context-menu.ts 本地实现（无 React 依赖）；app/ContextMenu.tsx 只留 Host
- 执行波折记录（供后来者避坑）：① Windows PowerShell Get/Set-Content 按 GBK 误读 UTF-8 造成
  mojibake——一律用 .NET ReadAllText/WriteAllText(UTF8 no BOM)；② 相对路径深度两次算错
  （ui/react 与 app/chat 同为两级；app/panels→app 是一级），tsc 即时抓获；③ ChatFooter/
  ModelSwitcher 的 P1b 编辑在首败批次+stash 往返中意外丢失，Batch A 时重做——批量编辑失败后
  必须逐文件核对落地状态，不能只看报错文件
- 文档回写：CONVENTIONS §6 冻结行改「缩编后 11 事件」、AGENTS §6、app/README、
  INVARIANTS #4 旁注（withPrefix 生产面为零、clear 语义不变）、本文件状态 Done、plans/README 状态更新
- 全量门禁：npm run build + npx vitest run + biome（改动文件零新增）

## 6. 风险与回滚

- 高 fan-in 触点（panel-def / ChatBeacon / App / workspace）搬家只改 import 行；改前跑 preflight_check
- zustand subscribe 与 bus.on 语义差异：二者都同步触发；但 bus emit 对 handler 有 try/catch 隔离，
  zustand listener 抛错会传播到 setState 调用方（runtime-adapter）——组件 listener 保持副作用轻量
  （现有 handler 本就只 set state + 定时器，不抛）；若担心可在订阅回调里自行 try/catch
- 每子步独立 commit，可单独 revert；P2 每批一 commit
