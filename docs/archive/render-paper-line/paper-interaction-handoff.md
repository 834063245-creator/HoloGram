# 纸壳交互承接施工单（paper-interaction-handoff）

> **已归档（2026-08-25 竣工）**——8/8 全销账（审计「交互面断链全集」= 空，KNOWN_DEAD 收敛机制已清空）；守护测试 `src-ui/tests/paper-interaction-handoff.test.ts`。现状指针：[`plans/README.md`](../../plans/README.md) 与 [族索引](../README.md)。

> 立项：2026-08-25 · 状态：审计完成，逐条修复中
> 守护测试：`src-ui/tests/paper-interaction-handoff.test.ts`（KNOWN_DEAD 收敛机制）

## 一、背景

纸壳（PaperPanel）成为唯一主界面（`a621b1e6`，2026-08-22 深夜拍板）时，旧观测台前端整体
拆除，`ChatMessages.tsx`（1438 行，含 PlanCard 审批、消息操作、停止按钮等全部交互件）一并删
除。拆除时列了"幸存件与承接"清单（PromptShelfHost 承接 ask/权限、WinControls 承接窗口控制、
PaperPanel 书眉承接设置），但清单不全：**Agent 工作流刚需的交互卡被当成了展示件**，承接断
层由此产生。

2026-08-25 排查"plan 模式退不出"时定位到第一条断链（plan 审批回调丢失），随后对全部交互
出口做了封闭集合审计，本施工单即审计产物与修复台账。

## 二、审计方法（封闭集合枚举，保证完整性）

"交互承接断层"的全部形态：**Agent/数据侧有一个交互出口（事件、part、回调、Promise、
信号），UI 侧没有消费方**。出口是有限集合，逐项验证消费方即可穷尽：

| 集合 | 规模 | 消费方检测 |
|---|---|---|
| EventKind 事件 | 11 | chat-stream case 全覆盖 |
| 消息 part 类型 | 5（reasoning/text/tool/subagent/plan） | block-model kind + 渲染器注册 |
| BuilderDeps 注入回调 | 5 | createBuilderDeps 装配 |
| AgentUINotifier | 6 | runtime._wrapNotifier（全通） |
| chat-core 视图委托方法 | ~8 | 纸壳调用点 |

守护测试用 KNOWN_DEAD 收敛机制把这张表固化成机器断言（见守护测试头注释），
**新增断链未登记会红，修复断链未销账会红**。

## 三、审计结果

### 展示面（全部已接，守护锚点）

- 11 个 EventKind 全部进消息流；5 种 part 全部有块转译 + 渲染器；AgentUINotifier 6 回调全通。
- 展示是完整的。断层全部在**交互面**。

### 交互面断链全集（施工单）

| # | id | 链路 | 症状 | 修复方案 | 状态 |
|---|---|---|---|---|---|
| 1 | plan-callback-translate | PlanPart._callback → 纸块 | 转译时丢回调，无审批按钮，exit_plan_mode 永久挂起 | block-model plan payload 增 `_callback`/`options`；translate 透传 | ✅ |
| 2 | plan-approval-ui | 审批按钮 | 卡片只有展示无交互 | PlanBody 渲染 批准/修改/拒绝 + 方案选择，点击调 callback | ✅ |
| 3 | plan-exit-timeout | exit_plan_mode Promise | 审批 UI 丢失/损坏即永久死锁 | 加超时/兜底 resolve（参考 PromptShelf CARD_TIMEOUT_MS），别无限期挂起 | ✅ |
| 4 | stop-button | chat-core.abort() | Agent 跑飞无法硬停；plan 卡死时无暴力兜底 | 纸壳 composer/书眉接入停止按钮（exec.isRunning 驱动） | ⬜ |
| 5 | message-ops | edit/resend/copy 回调 | 打错字没法改，答废没法重发 | 纸块加消息操作入口（user 块可编辑/重发）。答块原带「重试」——与来文块「重发」同轨冗余，2026-09-16 用户裁定删除（`retryAssistant`/`canRetryAssistant` 同批拆干净） | ⬜ |
| 6 | dataflow-display | bumpDataflowSaved 信号 | 面板拆了，信号白发 | 决定：纸面块展示 or 信号退役（二选一，不养死信号） | ⬜ |
| 7 | slash-at-composer | SlashPanel/AtAutocomplete 注册槽 | 拆除承诺"待纸壳复用"未兑现，裸 textarea | composer 接入斜杠命令 + @提及（复用 chat-core 解析） | ⬜ |
| 8 | plan-mode-ui-switch | "界面直接切换到执行模式"文案 | 虚承诺：无此入口 | 实现书眉 plan 模式切换，或改文案删承诺（二选一） | ⬜ |

### 虚承诺（文案写了、实现不存在）

- `plan-tools.ts` exit_plan_mode 留档分支提示"或用户在界面直接切换到执行模式"→ 无该入口。
- `prompt-sections.ts` 协作模式块提示"经 enter_plan_mode 或界面切换"→ 同上。（并入 #8）

### 已知旧世界存量（交互层同族，暂不并入本单）

- 首页列表 `slice(0,8)` 硬编码、删除会话无 UI 入口、workspace 行不可点。
- 等本单收敛后再立，避免一口吃成胖子。

## 四、修复纪律

- 每条修复配套：代码落位 + 施工单状态 ⬜→✅ + 守护测试 KNOWN_DEAD 销账（删对应 id）+ 门禁全绿。
- 一次性修一条，全绿再下一条（"连环问题记账不连环修"纪律）。
- 真机交互验收由用户跑（守护测试管机器能验的数据面，按钮手感归真机）。

## 五、当前进度

全部销账（2026-08-25 一口气扫完）。

- [x] #1 plan-callback-translate
- [x] #2 plan-approval-ui
- [x] #3 plan-exit-timeout
- [x] #4 stop-button
- [x] #5 message-ops
- [x] #6 dataflow-display（决定：退役信号，dataflow-store.ts 删除）
- [x] #7 slash-at-composer（命令解析本就在 core，补发现性面板；@提及依赖图谱节点名，图谱面退役后永久降级）
- [x] #8 plan-mode-ui-switch（决定：删虚承诺文案，不做 UI 入口）

收敛说明：
- 守护测试 KNOWN_DEAD 已清空（断链全集 = 空）。
- #8 与 #6 是「拆干净」型收敛：虚承诺删文案、死信号退役，均非新增功能。
- convergence baseline 因 prompt-sections 文案变更重录一次（record 提交）。