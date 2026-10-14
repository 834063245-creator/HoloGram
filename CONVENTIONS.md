# CONVENTIONS.md — 兰台编码约定

> 最后校准：2026-08-29（逐条对照源码与实测门禁）。
> 所有写代码的 Agent（内置 Agent / Claude Code / Codex / Cursor）在动文件前必须先读本文件；
> `CLAUDE.md` 与 `AGENTS.md` 强制执行这一条。本文件只写仓库里**已经占多数**的模式，不是理想设计。

## 规则优先级

1. `docs/adr/project-constitution.md` — 四条架构约定（类型边界 / 单一权威源 / 异步纪律 / 错误不静默）。新代码违反即打回。
2. `INVARIANTS.md` — 已经炸过的雷。修改 `src-ui/src/ui/**`、`src-ui/src/agent/**`、Rust 接缝前逐条核对。
3. 本文件。
4. 历史 plan / handoff / `docs/archive/**` — 只是记录，不是现状；与代码冲突以代码为准。

## 0. 开工顺序（每次任务）

1. **先问图，再动手**：定位符号/影响面走图工具。内置 Agent 用 `fs(read)` + `search` 摸依赖；
   图谱引擎（`hologram-engine`，应用内默认关）接上后走引擎契约的域面
   （版本见 `docs/facts.generated.md`；`graph(action=...)` / `analysis(action=...)` / `lsp` / `ops`，含 `preflight`）——MCP 客户端
   看到的是同一套域面，`tools/call` 仍可按原名直达（`explore_deps` / `search_symbols` /
   `trace_impact` / `preflight_check`，清单见 `docs/agents/engine-plugin-contract.md`）。
   grep 是图查不到时的兜底。
2. **读雷区**：涉及 `src-ui/src/ui/**` 或 `src-ui/src/agent/**` 时，先读 `INVARIANTS.md` 相关条目，并 grep 目标文件里的 `⚠️ INVARIANT` 注释。
3. **先抄再写**：在仓库里找做同类事的文件，复制它的模式；不要发明新的通信、状态、工具定义或错误处理方式。
4. **最小 diff**：修 bug 在共享根因上修一次；加功能不顺手重构；一个文件能解决就不动两个。
5. **过门禁**：按下方第 3 节跑验证，不通过不交付、不 commit。

## 0.5 决策分层与提问纪律（2026-09-16 立规）

**背景**：设计件/施工单日益复杂 + 决策频率过高，已超出用户可承受的评审带宽（用户 2026-09-16
原话：「我其实都有点过载了…你得帮我做判断」）。**这是 Agent 制造的流程缺陷，不是用户的失误**——
把工程内部取舍包装成「N 道判断题」上交，等于把自己的判断责任外包给不具备代码上下文的人。

```
✅ Agent 自决（不再问用户）：工程内部的一切——修法选型、批次切分、命名、门禁层级、
   契约版本、范围与边界、依赖顺序，以及任何「要看代码才能答」的题（甲案/乙案之类）。
✅ 只有三类才问用户：
   ① 只有用户能给的输入（真机手感 / 产品取舍：要什么、值不值得）
   ② 不可逆且代价大（存储格式破坏、跨线大重写、对外发布、花钱）
   ③ 证据两边打平且 Agent 判断不了（须能说出「试了什么、为什么还是不定」，否则不许问）
✅ 提问形态硬约束：每批次**最多一个问题**；必须**一句话、以用户可见的后果**问
   （禁「甲案还是乙案」式内部名词题）；附带「我倾向哪个 + 不问也能先做的最小步」。
✅ 施工单/设计件不再写「请示：N 道判断题」，改写「**我的裁定 + 理由**」——留痕照旧，
   但不制造决策；事后有异议再翻案，翻案成本 < 事前评审成本。
❌ 禁止：把可由证据判定的题上交；把「我不确定」当提问理由；一次上交三道以上。
```

> **先例（本条的由来）**：`docs/archive/composition-architecture/work-orders/WO-S7-multi-core-panels.md` §0.5
> ——九道判断题经复核**没有一道属于用户**（八道是工程内部取舍；第九道「是否共享工作区」是引擎契约
> 强制、本不该问）。该批已全部自裁并把施工单形态改为「我的裁定 + 理由」。

## 1. 前端 `src-ui/`（TypeScript strict + React 19 + Zustand 5 + Vite + Biome 2 + zod 4）

### 1.1 分层

- `src-ui/src/app/` — 新观测台壳：单 React 根、chrome、面板注册表、聊天视图。新 UI 功能优先落这里。
- `src-ui/src/ui/` — 旧层 + 领域逻辑：星图 scene、事件总线、领域 stores、React 岛组件。没有迁移计划时，修改它要沿用该目录现有模式。
- **冻结文件**：`ui/chat-session.ts`、`ui/chat-stream.ts`、`ui/part-mutator.ts`、`agent/execution-state.ts` — 聊天/流式执行的核心状态机，不是局部需求不要改。
- `src-ui/src/agent/` — Agent 运行时、工具、多 Agent、目标/计划/记忆。

### 1.2 状态管理：Zustand，不要模块级变量

```
✅ 面板级（多面板/多会话）store：
   1. create<S>(() => ({ ... })) 定义 store
   2. createScopedStore('__lantai_xxx_stores__', createImpl) 建注册表（src-ui/src/state/scoped-store.ts）
   3. export const getXxxStore = scoped.getStore — 按 storeId 取实例
   4. 非响应式读走 getXxxStore(id).getState()
   参考：state/messages-store.ts / state/session-store.ts / state/panel-store.ts /
   state/input-store.ts，聚合入口 ui/chat-store.ts（编排域，留 ui/）

✅ app 级单例（一个应用只有一份）：
   app/shell-store.ts（chrome 状态）、state/dock-store.ts（面板开合/简报）、

✅ 组件内部瞬态 UI 状态（菜单开合、输入焦点等）用 useState；跨组件共享的业务状态进 store

❌ 禁止：模块顶层 let/const 存业务状态（跨面板串流已炸 6+ 次，见 INVARIANTS #1）
❌ 禁止：引入 Zustand 之外的状态库
```

### 1.3 跨组件通信：状态走 store，EventBus 已退役

```
✅ app/** 新代码：UI 状态走 zustand store（ui/events.ts 已于 2026-08-19 总线归零 P1 删除）
✅ Agent ↔ Agent：agent/message-bus.ts（有界 inbox + ack + 背压），不是事件总线
✅ ui/react/ 岛层已退休（2026-08-19，docs/archive/ui-react-island-retirement-plan.md）：目录已删除，
   组件全部迁入 src/app/**（聊天件 app/chat/、面板 app/panels/、chrome app/ 根级）；终态守护
   tests/ui-react-retirement.test.ts。总线缩编为 11 事件——lang/agent:config/agent:status/
   timeline/dataflow 五事件改为 zustand 信号 store（i18n.useLangStore /
   state/agent-config-store / agent-panel-store 的 statusTick/toolDoneTick /
   state/timeline-store / state/dataflow-store）
✅ 事件总线已归零（2026-08-19，docs/archive/eventbus-zero-and-ui-split-plan.md P1）：
   src/ui/events.ts 整文件删除，11 个残余事件全部迁 zustand 信号 store——
   turn-done / goal / chat-context / scene-signal / ask / workspace-switch 六个新信号 store
   落 src/state/（该目录自此为状态层新家），agent:diag 与 agent:tool-done 落
   agent-panel-store（diag / lastToolDone 扩展）；旧事件的 payload 类型随 store 走。
   跨工作区 fire-and-forget 消费端照 INVARIANTS #12 epoch 守卫（样板：chat-core
   _refreshGoalRecord）
🔒 总线归零 + ui/ 拆分已收口（2026-08-19，docs/archive/eventbus-zero-and-ui-split-plan.md
   P0-P3 全竣工）：P1 事件归零；P2 物理拆分——11 个领域 store 迁 src/state/（连同
   P1 六信号 store 共 17 文件）、23 个星图文件迁 src/scene/（ui/graph.ts 留 3 行
   re-export shim，冻结文件 chat-stream 的 type import 走此层）；ui/ 残余 = chat 编排域
   核心 + 旧层命令式基础设施（**文件数与逐簇清单见 `src/ui/README.md`**，此处不复述）。终态守护
   tests/eventbus-zero-and-ui-split.test.ts（COMPLETE=true）——新建 store 一律落
   src/state/，新组件落 src/app/**，新 scene 文件落 src/scene/

❌ 禁止：window.dispatchEvent / CustomEvent / 自己 new EventEmitter
```

### 1.4 聊天消息写入：mutate, then touch（铁律）

```
聊天数据模型原地 mutation（流式 part.text += chunk，逐 token 拷贝太贵），
React 靠引用比较观察变化。store 是唯一提交口：

✅ 原地改完已有消息或 part 后：
     getMessagesStore(`${panelId}:${sessionId}`).getState().touchMessage(msgId)
     getMessagesStore(...).getState().touchMessageContaining(part)
✅ 新增任何消息变更入口（新事件、新生命周期钩子）：mutate → touch

❌ 禁止：mutation 后只调 bump() 或手动 setState({ messages: [...] })
   — 数组展开不换消息引用，memo 化的气泡会静默跳过更新

参考：state/messages-store.ts 的 SINGLE WRITE PATH RULE；守护：tests/chat-write-path.test.ts
```

### 1.5 RPC：typedRpc / typedListen，契约单一

```
✅ 前端调后端：src-ui/src/rpc-contract.ts 的 typedRpc / typedListen（RpcContract / EventContract 编译期约束）
✅ 参数键一律 snake_case；返回一律 string：JSON 类用 parseJson()，文本直接读
✅ 后端新增方法：src-tauri/src/rpc.rs 加 match 分支 → 前端需要则同步 RpcContract；
   契约文档 docs/agents/frontend-rpc-contract.md 由 scripts/gen-rpc-contract-md.cjs 生成，勿手改
✅ bridge.ts 的 invoke<T> / listen<T> / rpc<T> 泛型必填

❌ 禁止：在 rpc-contract.ts 和 agent/tool.ts（agentInvoke 动态分发）之外 import { rpc } 裸调
   — biome style/noRestrictedImports 会直接拦截
```

### 1.6 模型工具：defineTool + zod v4，schema 是唯一事实源

```
✅ 新增/修改模型可见工具必须走 src-ui/src/agent/tools/define-tool.ts：
   一个 zod schema 同时产出 JSON Schema（z.toJSONSchema draft-7 + io:'input'）、
   运行时参数校验、z.infer 类型化 execute 参数
✅ **例外已退役（kernel-plugin-runtime 通道随 R5 脚手架拆除，2026-09-05）**：
   manifest 驱动工具面（tool_call 信封 + kernel-manifests 镜像 + 生成器）全拆
   ——全模型族 schema 真源回归 TS zod（十一能力口模型族：fs/git/shell/editor/
   constraints 在 coding.ts、search/web 在 manifest-tools.ts、browser/uia 在
   browser.ts），defineTool 纪律全域无例外
✅ 工具内部统一 .passthrough()：_forceGate 在 schema 里声明（LLM 要看得见）；
   _callId / _agent_id 不声明（executor 内部注入）
✅ execute 必须全量透传 args，禁止重建参数对象（fork 子 Agent 的 _agent_id 会丢）

❌ 禁止：手写 parameters() 对象字面量、execute 里 as 强转/静默兜底（x || 默认值）
❌ 禁止：把 defineTool 换成 .strict()（meta key 会被 strip，门禁静默变死路）
❌ 禁止：引入 zod-to-json-schema（只支持 zod v3，与项目 zod v4 不兼容）

领域工具（fs/shell/git/search/web/agent/task/memory/browser/desktop/cordis/office）：
✅ 新动作同步 tools/domains.ts 的 DOMAIN_SPECS（动作→旧工具名）+ collectHiddenToolNames()
✅ 旧工具名只允许 hide + retireRedirect，模型路径不得重新暴露旧名
⚠️ 引擎侧另有自己的域面（graph/analysis/lsp/ops + action，真源
   `engine/src/tools/mod.rs` 的 DOMAIN_SPECS），与本节 TS 域是两套东西——
   引擎工具以 `mcp__hologram__*` 形态出现，不登记进 tools/domains.ts。
```

### 1.7 Agent 运行时：装配组合与会话事件（agent-core-convergence 立规）

```
装配组合（三层，2026-08-20 组合架构 S1 起生效；P4 B①/②/A-1/B④/S4-4 甲乙/
①c 2026-08-23 增第一方插件通道与解析域收编）：
✅ 内置工具族（①c 后仅 web/browser-desktop 2 行——十二族已迁插件通道）：
   在 composition/tool-rows.ts 行表
   加一行（factory(ctx) → Tool[]，可 async）——buildToolRegistry 按表序装配，
   行内工具名冲突由 ToolRegistry.register 装载期拒绝
✅ 第一方工具域插件（P4 B① git/search + ② fs/shell/agent-isolation）：
   只依赖无状态装配依赖（codingExec 类）的族走
   ctx.tools 贡献通道——真源 plugins/builtin/<domain>/index.ts（一域一插件，
   disposer 经 ctx.effect 登记；共享助手 plugins/builtin/contribution-helpers.ts）+
   composition/first-party-tools.ts 清单单一真源（loader 表尾装载 + 测试/文档
   生成经 withFirstPartyToolChannel 复现生产装配）。**缓存分家**：无状态族
   （只依赖 codingExec）走默认实例缓存；装配期真值族（wait 的 subAgentPool /
   ask 的 ui 回调 / task 的 taskManager）声明贡献 noCache（①c 路线一，
   2026-08-23 拍板 #2）——pluginToolRows 每装配重调 factory，装配期真值直收
   rowCtx，无跨装配串扰；Tool[] factory 是整组形态贡献（一行承载该族全部工具，
   S4-4 乙形态）。（应用内 hologram 动态名族已随图谱内置接线退役，2026-09-09。）
✅ system-prompt 段落（persona/规则/记忆/运行环境）：在
   composition/prompt-sections.ts 段清单加一段（id + applicable + render；
   render 产出含自身前导分隔符的完整文本——\n/\n\n 混用是现行拼装的机械事实，
   禁"顺手规整分隔符"，会击穿 fixture 快照与前缀缓存）。P4 B④ 收官：13 段
   全量经 plugins/builtin/prompt-segments/（装载 firstPartyPromptSections()）
   走 ctx.prompts 通道贡献——出厂段表退役，新段直接进清单
✅ 插件 prompt 段贡献（P4 A-1 起）：ctx.prompts 通道（composition/
   prompt-service.ts，第六 service）——PromptContribution 形状即 PromptSection
   （id + applicable? + render，render 产出含自身前导分隔符的完整文本）；
   S4-4 甲（2026-08-23）起贡献段进组合解析域：factoryComposition() 的
   prompt 域快照通道贡献（同 tools 域收编 pluginToolRows 行）——patch/
   preset 可 disable/text 覆盖/锚定贡献段 id（含 13 第一方段）；合流点 =
   assembleSystemPrompt——sections（解析产物）提供即精确清单、缺省 =
   当前通道贡献；贡献 register/dispose = 组合输入变更（preset-assembly
   cache 代数失效 + bootShell 贡献监听 reapplyComposition 重应用）
✅ 会话级工具/hook（plan/通信/discovery/merge/board/kill/request/spawn/task
   替换/compaction/converge/code-execution）：在 agent/blueprint.ts 的 standard() capability 表
   加一项（或 createAgentFromContext 第 3 参注入扩展蓝图）——不改 AgentConfig
   （字段面冻结 23：specs/phase-6 AST 断言 + gate.mjs 计数扫描双层门禁）
✅ 注册顺序 = 表序（行表序 / section 表序 / capability 表序）：表序是字节契约
   （DeepSeek 前缀缓存 + phase-1 effective 快照依赖此序），插入必须显式选位置
✅ capability 只做组合不做 teardown：生命周期所有权走 ctx.effect；
   register 返回的 Disposer 归 owner 管理（清单 docs/agents/REGISTRY_OWNERSHIP.md）
❌ 禁止在 runtime.ts 装配本体直调工具/hook 工厂（T0 门禁 26 禁止片段，失败关闭）

session 事件溯源（双写期，this.session 是真源 + SessionLog 逐字节等价）：
✅ session 变异只走三入口：_appendMessage / _replaceSession / _retractSessionRange
   （phase-5 spec AST 白名单 + gate 计数扫描；豁免须登记 progress.md）
✅ 新增变异路径 = 新事件 kind + 差分矩阵补场景 + phase-5 快照零漂移；
   改工具折叠逻辑必须同步 session-log.ts derivePayload
✅ 新增持久化路径沿用 _eventAppendChain 写链（防并发 saveState 重复追加）

工具管道裁决：guard/preflight/around 经 agent/events.ts 的 AgentEventBus 组合，
bus 事件与 legacy EventSink 双发（UI 零改动依赖此）。

执行原语（P2/P3，agent-plugin-architecture-plan）：code_execution 工具经
ctx.codeRuntime 服务（vendored cordis Service，agent/code-run/runtime-service.ts，
codeRuntimePlugin 挂根 Context）运行程序体——绑定面 = CodeBindingSpec（invoke
闭包持有 executor 等价体 + session-log 审计），runtime 不知道工具和会话
（DSH 接缝纪律）；嵌套分发走 Agent.dispatchNestedTool（门禁/hooks/截断全套
不豁免，读并行写串行）；无服务挂载时惰性游离实例（行为 = 直接 runCode）。
守护：tests/code-execution.test.ts。
守护：改 src/agent/** 或 src/composition/** 必过 npm run verify:convergence（T0 静态 + 8 baseline 对拍；standard preset 零漂移规则——不设 CONVERGENCE_PRESET 直接跑，快照逐字节不变，漂了先修代码）；
record 永不上 CI；baseline 变更走 docs/archive/agent-core-convergence/baseline-change-request.md 审批。

组合外化（S2，2026-08-20 起生效）：
✅ 用户层 patch：~/.lantai/composition/roster.patch.yml 经 composition/roster.ts
   的 resolveRoster(factory, [patch]) 解析（禁用/覆盖/插入四域行；all-or-nothing，
   失败回退出厂组合）——patch 语义与涟漪表见 docs/composition/README.md；
   解析域 = builtin 行表 + 通道贡献快照（S4-4 甲——factoryComposition()
   收编 pluginToolRows 行 + ctx.prompts 段贡献，patch/preset 可寻址两类行；
   快照语义：同装载态同输出，贡献变更经 cache 代数 + reapplyComposition
   重取）；装配面（buildToolRegistry/assembleSystemPrompt/AgentBlueprint.
   fromRoster/bootShell）全部带出厂缺省参数，测试永不依赖用户盘文件
✅ 壳行通道分工：引导接线（无 ctx 生命周期诉求）= 壳行（composition/
   shell-rows.ts 表 + src/shell/rows/* 实现 + src/shell/boot.ts 编排器，
   表序=引导序，失败单行隔离）；有 ctx 生命周期/disposer 诉求的单元 =
   cordis 插件通道（plugins/loader.ts，S1 四 service / S3 起域插件）——
   两条通道不混用
✅ 新引导接线（事件桥/快捷键/动作注册/持久化订阅/冷启动）加壳行，
   不往 main.ts 堆代码（main.ts 终态 = 薄引导：CSS + 内核 + React + bootShell）
✅ 壳行代码不假设前行必然成功（判空降级沿用 main.ts 原状）；
   禁用行 = 接线不发生、调用一致地失败（涟漪表如实记录）
❌ 禁止把 factory 层复述进 yml（出厂表是代码真源；patch 只表达增量）
❌ 禁止 patch 语义引入 js 表达式（纯函数确定性；DSH !!js 是刻意偏离）

preset realm + 热重载 + 消费闭环（S4，2026-08-20 起生效）：
✅ preset = 命名的行组合叠加层：composition/presets.ts 内置表（standard/
   minimal）+ preset-discovery 用户目录（~/.lantai/composition/presets/
   <id>/）+ preset-assembly（resolveCurrentComposition 引用稳定 cache +
   settings↔store 选择同步）。层序 factory → 用户层 → preset；同 id 后写胜
✅ 装配组合覆盖：createAgentFromContext/createAgent 第 4/2 参可选
   composition（缺省 = runtime 组合 = S2 零漂移）；会话工厂在 resolved ≠
   工作区默认时自建会话作用域注册表（V5 选择器的机制位）；子 Agent 经
   ctx composition 服务 child() 继承（父子同面）
✅ 消费闭环（G0 修复）：面板清单 = panelDefs()（常量 + ctx.panels 贡献）；
   命令清单 = 会话内建（ChatCore.builtinCommands）+ ctx.commands 折算 + 技能候选，
   合流点 src/app/commands/command-catalog.ts（`/` 内联面板与 Ctrl+K 面板同源——
   旧 ui/command-registry 单例已随 command-surface-rework 退役）；工具行 = composition/
   plugin-tool-rows.ts 折算（行 id 'plugin/<贡献 id>'，factory 缓存实例）。
   S4-4 甲（2026-08-23）：折算行进组合解析域（factoryComposition 快照，
   patch/preset 可寻址 plugin/<贡献 id> 行）——buildToolRegistry 单一循环
   经组合解析产物装配，不再旁路追加 pluginToolRows。
   面板/命令即时生效（panel-defs-store bump 信号）；工具下次装配生效
✅ 热重载：Rust composition_watcher 监听根级 roster.patch.yml →
   composition:changed → patch-loader reloadCompositionPatch（404=显式
   回退 factory；坏 patch=可见+兜底；网络炸=旧组合保持）
✅ 插件安装通道：plugin_install/uninstall/set_enabled RPC（Rust
   commands/plugin_install.rs——tar-slip 双重围栏 + 原子落盘 + plugins.json
   读改写）；插件必须自包含（无裸 import——宿主桥
   window.__lantai_plugin_host__ 提供 createElement/notify）
✅ 插件/组合面变更同步 docs/plugins/README.md（通道 API/生效语义/
   信任模型的单一人类契约）
✅ 第一方插件清单（2026-08-29）：plugins/first-party-manifest.ts = 43 个
   第一方插件身份单一真源（kind = 展示分组标签——service 内核不可禁 /
   feature 出厂产物可禁用）；设置「插件」tab 三组陈列（平台服务/内置插件/
   已安装）；feature 启用/禁用经 state/plugin-prefs.ts（localStorage）
   **下次启动生效**（loader boot 跳过）；装载统一收 state/plugin-store.ts
   （builtin+meta，mergePlugins 按 name 合并——第一方 boot 与第三方异步装载
   互不冲刷）。
   **新增出厂产物 = 产品目录建 index.ts + builtin-roster.json 加条目 +
   插件对象进出厂装配面**（产物 manifest.json 由 build-builtin-plugins.mjs
   从名册生成、**不手写**；直接 import 的产物在 factory-products.ts 加行，
   工具/prompt/capability 域产物只进各自通道清单；**构建脚本与 Rust 资产
   通道都不用动**——规格已从名册派生、plugin_assets.rs 无名字白名单）。
   守护 tests/first-party-manifest.test.ts 钉死覆盖（漏条目 = loader 跳过 +
   error）+ tests/builtin-roster.test.ts
```

### 1.8 文件命名与 import

```
✅ 模块/类型文件：kebab-case.ts   （chat-store.ts、message-model.ts、rpc-contract.ts）
✅ React 组件：PascalCase.tsx      （ChatMessages.tsx、DockPanel.tsx、SettingsPanel.tsx）
✅ 测试：tests/<feature>.test.ts（或 .test.tsx）
✅ 新文件头两行：
   // Copyright (c) 2026 Wenbing Jing. MIT License.
   // SPDX-License-Identifier: MIT
✅ import 先第三方后项目内；类型导入用 import type，不与值导入混写
✅ Biome 是唯一格式权威：2 空格、宽 120、单引号、分号、trailing comma；
   编辑后跑 npx biome check --write <改动文件>
```

### 1.9 组件、DOM 与样式

```
✅ 函数组件 + hooks（React 19）；性能敏感组件用 React.memo
✅ 20 行以内子组件定义在同一文件；不要为小零件建新文件
✅ memo 会阻止必要重渲染（对象引用不变但内部被 mutate）时不用 memo，并加 // ponytail: 注释

DOM 所有权按层划分，不要跨层抢 DOM：
✅ app/ 的 UI 经 React 渲染
✅ 星图 scene/overlay（scene/graph*.ts）、Monaco 宿主（ui/file-viewer.tsx）、
   file-translator wrapper 是现有 imperative-DOM 所有者；修改它们沿用其内部模式
❌ 新的 React UI 组件不要 document.createElement / appendChild / innerHTML 自建游离 DOM
   确有必要时：把 DOM 操作封在对应所有者模块内，加 // ponytail: 说明原因

样式：
✅ app/ 新样式只用 tokens.css 的 --obs-* 变量（--font-scale 是唯一例外）
✅ 面板样式落在 src-ui/src/app/panels/dock-panels/ 对应文件
❌ 不引入新 CSS 方案/框架；不新增 !important / 降级特异性豁免，除非面板样式同源迁移
❌ 不要改 tsconfig.json 的 strict: true
```

### 1.10 工作区级资源两原语（2026-08-17 立规；2026-08-18 cordis-migration P1 起登记原语升级为 fiber effect）

工作区「存活期」没有结构体是病根：状态散在 Workspace 实例 / 进程级单例 / scoped store
三处，切换时靠人肉枚举清理，枚举必然漂移。两条铁律（原语在 `workspace-scope.ts` + `src/cordis/`）：

```
✅ 获取必须登记进 Workspace fiber（cordis effect，单一 owner）：
   凡 Workspace 在 open/setupAgent 里获取的资源（事件监听器 / 计时器 / runtime /
   subAgentPool / agentSessionState / useAgentPanelStore / 引擎快照刷新 …）
   一律在获取点就地 this._fiber.ctx.effect(() => disposer, 'label') 登记（独立清理器）；
   有顺序依赖的成组清理（setupAgent 拆除链：先拆 runtime 再清缓存）
   打包为 DisposerBag、作为单个 effect 登记 — 组内串行逆序契约不变。
   deactivate/forceClearState 只调 fiber.dispose() + bumpWorkspaceEpoch()，不再人肉枚举。
   没登记 = review 可见的错。new 一个全局状态却没有 effect 登记，就是漏网的雷。

❌ 禁止：新增工作区级全局状态却不登记进 fiber（切换后必泄漏/串味）。

✅ 模块级可变态四级归属（cordis-migration P4 立规，新模块态必须归入其一并在声明处注释）：
   1. **fiber effect / cordis Service** — 工作区级资源（样板：Workspace 获取点就地 effect、
      `ui/lsp-client.ts` 的 LspService）；
   2. **epoch 守卫** — 逃逸所有权的在途回调（见上）；
   3. **键控自清理 / 进程级单例** — 生命周期=进程或键控对称清理（bridge、catalog、
      i18n、queued-shell 的 streamId 表、subagent-activity 的 agentId 表），无跨工作区
      所有权问题；
   4. **冻结常量表** — 初始化后只读（STOPWORDS / DOMAIN_NAMES 等）。
   不属于任何一类的模块级 `let`/`Map`/`Set` = review 拦截对象。

✅ 跨工作区的 fire-and-forget 写共享态必须 epoch 校验：
   入口记 getWorkspaceEpoch()，async resolve 后 isCurrentEpoch(epoch) 校验，
   过期立即丢弃（LSP 在途 / autoRestore / autoSave / runCheck 同族）。
   Workspace 停用/强清时 bumpWorkspaceEpoch() 让所有在途回调生效过期。
   （epoch 不随 fiber 化消失：fiber 管所有权，epoch 管逃逸所有权的在途回调 —
   cordis-migration P4 收口定案：epoch 为**永久互补机制**，消费方 = lsp-client
   startLsp / agent memory / chat-session autoSave，全部是已出发的在途 promise 链，
   fiber dispose 无法撤销，代际校验是唯一正确防护。）
```

### 1.11 日志事件面（2026-09-27 立规；规格 = `docs/design/log-observability-spec.md`）

```
✅ 用户可见的失败必须留痕：墓碑 / error toast / 面板 fatal 出口 → `agent/obs.ts` 的
   `turn.failed`（唯一漏斗，按 (session,turn,phase) 去重）/ `ui.toast`
✅ 新增接缝 = 在 `agent/obs.ts` 加一个事件函数（事件名与字段表在文件头定死），
   不散点、不改旧 `log.*` 调用（旧面零迁移）
✅ 脱敏**只在** `agent/obs.ts` 一处（唯一审查点）：apiKey/token 明文、消息正文、
   请求体全文、请求头、URL query 永不落盘；只记长度/存在性/`host:port`/节数。
   端点一律把**整条 URL** 递给门面（`url` 字段），由门面削成 `host:port`
✅ `ids` 由**调用点显式给**（多卷并发下模块级 ambient 上下文会串卷——INVARIANTS #1 同族）
✅ 级别过滤**只有一处**（`agent/logger.ts` 的 `write`，`log.*` 与门面都从这里过）：默认
   `info`、`debug` **默认丢弃**；开关优先级 `LANTAI_LOG_LEVEL`（壳经 `log_level_hint`
   RPC 递进来）> `localStorage['lantai.log.level']` > 默认；级别与来源进 `boot` 的
   `log_level` / `log_level_source`（「这份 log 没 debug 行」必须能分出没发生还是被挡了）。
   认不出的值**不猜**（回空串 ⇒ 回落）
✅ 丢条必须可见：写失败计数 + 首次 `console.error`，下一条成功写入补 `log.self{dropped:N}`
   （生产者在 `logger.ts`——`obs.ts` 反向调用会成环）；通道未初始化时条目留在缓冲、不计丢条
✅ 被级别挡下的 debug **不丢**，进内存**前情环形缓冲**（定长 ≤2000 条 / 128K 字符）；
   用户可见的失败（错误级 **且带 `event`**）触发倒出（`log.self{ring_dumped:N}` 头 + 前情 + 失败）
   ——「要记得拧开关」这件事不成立（用户原话），故不靠开关靠缓冲；裸 `log.error` 不触发
✅ 产物域取门面经宿主面 `./host` + `host-modules.ts` 的 `faceDeps` 登记
   （漏登记 tsc 红；改 faceDeps 须同 commit 跑 `npm run gen:host-surface`）
❌ 禁止：在接缝里自己拼日志对象、自己抹凭据、用中文句子当事件名
❌ 禁止：绕开 `write()` 直接落盘（级别过滤与健康度都在那一层）
❌ 禁止：日志链路抛错打断用户动作（门面 `safeWrite` 兜底——丢条可见但不炸链路）
```

## 2. 后端 Rust（`engine/` + `src-tauri/`）

### 2.1 模块组织

```
✅ 根 Cargo.toml 是 workspace（五成员：engine / src-tauri / hologram-graph /
         hologram-storage / hologram-vector）——L5b crate 化（layering-rework-plan
         §4.3 欠账满偿）后 Rust 侧分四层 crate：
         hologram-graph（纯类型，零项目内依赖）→ hologram-vector（纯计算，依赖 graph）
         → hologram-storage（数据家，依赖 graph+vector，不依赖 engine）
         → engine（分析器，三门面再导出保持 crate::storage::vector:: 内部路径零改动）
✅ 壳层（src-tauri）引 storage/vector 类型一律直连独立 crate，
         禁经 engine 门面（守卫测试 shell_storage_vector_refs_use_dedicated_crates）
✅ 多文件领域：engine/src/{domain}/mod.rs + snake_case 子模块，领域公开 API 优先从 mod.rs 重导出
   现状：graph / adapter / analysis / community / pipeline / routing /
         storage（门面）/ engine / tools / scip_bridge / vector（门面）
✅ 单文件横切模块：engine/src/mcp.rs、lsp_manager.rs、logging.rs、path_utils.rs、stress.rs
✅ src-tauri 侧：RPC 单一入口 src-tauri/src/rpc.rs；命令实现在 src-tauri/src/commands/；
   锁/护栏等共享代码在 src-tauri/src/utils/ 子模块；应用层业务在 src-tauri/src/app/services/
✅ 文件命名 snake_case.rs
```

### 2.2 错误处理

```
✅ 公开边界 Result<T, String>（引擎当前事实标准；项目没有引入 anyhow）
✅ 可缺失值 Option<T>；可恢复失败用 ? 传播
✅ 生产代码零裸 .unwrap()（测试模块除外；2026-08-12 达成，新代码不得回潮）
✅ 锁中毒降级：
   engine 域   lock().unwrap_or_else(|e| e.into_inner())（先例 engine/src/graph/id.rs）
   src-tauri 域 lock_or_recover / read_or_recover / write_or_recover
              （定义在 src-tauri/src/utils/ipc_guard.rs）
✅ 静态不变量用 .expect("为什么这里不可能失败")，如静态正则/捕获组/初始化
✅ 失败必须可见：解析/读写失败不得用 None/默认值冒充成功；
   真正的 best-effort 副产物（timeline 记录、窗口标题等）可以丢弃，
   但写入/持久化类错误必须传播或 warn，不得静默吞
```

### 2.3 异步与 IPC

```
✅ tokio worker 只跑异步；文件 IO/加解密/子进程等待/引擎调用进 spawn_blocking
✅ 锁内不 await、不阻塞 IO；持锁只做内存操作
✅ 新增 IPC 响应必须有尺寸护栏：guard_ipc_size / truncate_output（32K，shell 全量走 spill）
✅ 用户级数据文件写入校验长度/类型，读取容忍毒化数据（见 INVARIANTS #11）
✅ 跨层数据禁止 Result<String, String> 传 JSON 再让对面 parse；序列化只在边界单点
   （历史遗留按 docs/landmine-map.md 拆除，新代码不得新增）
```

### 2.4 内核工具面与能力口（现状，2026-09-14 M5 核准；2026-09-16 自 AGENTS.md §7 迁入）

- **`tool_call` 信封已全线退役**：`src-tauri/src/adapter.rs` 的该类型**不是**待拆脚手架，而是强制层的闸构造形状；`src-tauri/src/tools/` 是内核能力层（`mod.rs` 的 ReadTool / EditTool / BashTool / GitTool / BrowserTool / DesktopTool / WebFetchTool …），各族另有 `*_cap.rs` **能力口直呼**入口（fs_cap / process_cap / search_cap / web_cap / git_cap / browser_cap / uia_cap / lsp_cap / pty_cap / editor_cap）——各文件头注一致声明「不经 tool_call 信封 / PluginRegistry / PluginToolAdapter」。
- **`src-tauri/src/tool_plugins/` 目录不存在**（kernel-plugin-runtime 的「新工具 = 插件目录 + manifest + ToolPlugin」已被能力口直呼取代），勿按旧描述新建；`docs/archive/kernel-tooling-line/kernel-plugin-runtime-plan.md` 是历史阶段记录，**不是现状依据**。
- **前端工具面真源** = ToolRegistry 装配产物（生成物 `docs/agents/model-tool-contract.md`）+ `src-ui/src/agent/tools/manifest-tools.ts`（search/web 两域 schema 的 zod 真源与编排，execute 经 `search_cap` 能力口直呼——**不是** manifest 生成的镜像表）。
- 新增模型工具 = `defineTool` + zod 入 `agent/tools/**`，装配面经行表/贡献通道（§1.7）——**不需要**新建 Rust 侧插件目录。

### 2.5 多 Agent 并发纪律（事故后立规，报告 `docs/agents/platform-bugs-2026-08-13.md`；2026-09-16 自 AGENTS.md §8/§9 迁入）

- 子 Agent 注册表必须 `convergeRegistry(subTools)` 重建领域工具；克隆来的 fs/shell 闭包绑父注册表，不重建会绕过所有权包装、构建禁令、plan 只读。
- 文件所有权（`file-ownership.ts`）覆盖 fresh 与隔离降级的 fork；claim 键斜杠归一。
- merge 据实三原则：无产出不报 ✅；清理失败 ≠ 合并失败；冲突保留 worktree（diff 有 32 KB 截断，worktree 是全量现场）。`agent(merge)` 进程内串行。
- `edit_file` 并发安全在 Rust 临界区（`editor.rs checked_write_atomic`：进程级锁 + fail-closed 重读校验）；TS 侧不得假设「返回成功 = 落盘」之外的时序。
- TTL 清理不得销毁无记录的工作：discard 前抓 diff 回 board，抓不到保留现场并通知父 Agent。
- 模型可见子 Agent ID `sub-{timestamp}-{random}`；worktree ID `agent-{timestamp}-{random}`；池内部 ID 不暴露给模型。
- **Plan 模式**：工具 schema 跨模式恒定（保护 DeepSeek 前缀缓存）；写约束由 `planGate` 在执行层拦截——只读动作放行，fs write/edit 计划文件豁免，agent spawn 豁免；plan 中 spawn 的子 Agent 静态只读（`planRegistry()`）。

## 3. 验证门禁与基线（2026-08-29 实测；数字会漂移，以重新实测为准）

| 改了什么 | 必须过 | 实测基线 |
|---|---|---|
| 前端 | `cd src-ui && npm run build` | tsc --noEmit + vite build 全绿 |
| 前端逻辑 | `cd src-ui && npx vitest run` | 330 文件 3362 passed / 3 skipped（2026-09-17 实测；**空载墙钟 132s**，机器被占满时 340-370s。跑前清 `NODE_ENV=production`，否则 specs 收集报 `No such built-in module: node:`。**默认环境 = node**——碰 DOM/localStorage/canvas 的 81 个文件自带 `// @vitest-environment jsdom` 头，缺头会红，不静默） |
| `src-ui/src/agent/**` | `cd src-ui && npm run verify:convergence` | exit 0（T0 静态 + 全部 phase specs 对拍 8 baseline；record 永不上 CI，baseline 变更走 change request 审批） |
| 前端格式 | `npx biome check --write <改动文件>` | 全仓 `npx biome ci .` 0 errors / 0 warnings（2026-08-24 清零，保持归零）；行尾 = LF（根 `.gitattributes`） |
| 引擎 | `cd engine && cargo test` | lib 592 + bin 0 + doc 0（bin 测试 27 个已随 Phase 3 TCP 拆除；storage/vector/graph 测试已随 L5b crate 拆出） |
| 壳 | `cd src-tauri && cargo test` | bins+lib 460 + 集成 1（引擎族 crate 依赖全摘 2026-09-08：hologram-graph/storage/vector 出 Cargo.toml，忽略语义壳内 ignored_paths.rs，守卫 shell_has_zero_hologram_crate_refs 零直连；cdp e2e 按环境偶现 ±1；pwsh 冒烟在无 pwsh 7 的环境自动跳过） |
| 桌面打包 | `cd src-tauri && cargo tauri build` | 会先跑前端构建；禁止用 `cargo build --release` 代替 |
| 生成物文档 | `cd src-ui && npm run doc-sync` | 五生成器全对拍（工具契约 / service·event 目录 / 开放面指纹 / 引擎契约） |

- CI（`.github/workflows/ci.yml`）**现只覆盖前端构建**（`npm ci` + `npm run build` = esbuild 产物域 + `tsc --noEmit` + `vite build`）。
  改动前须先问用户（不是禁止，是**不可擅自**）：2026-09-22 收敛为「必过的最简 CI」即经用户授权。
  三条被删的 job 之所以删，是**失败与代码质量无关**（推上去必红、红了没信息量）——若要把它们加回来，
  先确认该门禁在 CI 环境真能过（详见 `ci.yml` 头部与 CLAUDE.md「不可擅动」一条）。
  注：Rust 侧现已**无 CI 覆盖**；要补的干净入口是 `cargo check -p hologram-engine`（引擎 crate 不含
  tauri 的编译期资源校验，绕开 `bundle.resources` 需文件在场那个坑）。
- **中文文本批量改文件：禁用 PowerShell `Get-Content`/`Set-Content`（2026-09-18 实测事故）**：本机 `Get-Content -Raw` + `Set-Content -NoNewline` 往返会把全角左括号 `（`（U+FF08）写成 `六`（U+516D）——一次"批量改几处数字"把 8 份文档 591 行写坏（**识别指纹：`git diff --numstat` 增删行数 1:1 且文件几乎每行都变** = 编码事故，不是内容改动）。改文本一律走 Node（`fs.readFileSync(p,'utf8')` + `writeFileSync(p,txt,'utf8')`），并**逐条校验替换命中数**（未命中即报错退出，不静默）；改完第一眼看 `git diff --stat` 规模是否符合预期。修复 = `git checkout -- <文件>` 回已提交态重做（前提：先确认那些文件里没有他窗在途改动）。
- 修 INVARIANTS/landmine-map 里的雷，必须配回归测试，一颗雷一个 commit。
- **convergence 双轨纪律**：`npm run verify:convergence` 连跑 standard + minimal（单轨仍可用 `:standard` / `:minimal`）；只有 CI 的 `convergence.yml` 跑单轨 standard。**新增/改基线时两轨一起验**——教训：第二条轨不在默认门禁里就会静默腐烂（2026-09-14 审计发现的 minimal 漏录即此因）。
- **本机 `NODE_ENV=production` 注入的两刀（2026-08-29 实测）**：Cowork/codely 进程链给子 shell 注入 `NODE_ENV=production`——① vitest jsdom UI 测试大面积假红（`act is not a function` + `No such built-in module: node:`）；② **`npm install` / `npm uninstall` 同样中招：剥掉 devDependencies**（`Cannot find package 'vitest'`，`node_modules/.bin` shim 一并丢失）。恢复 = 清变量 → `npm install` → 必要时 `npm rebuild`。**纪律：本机凡 npm/vitest 命令一律先清该变量。**
- **测试环境的开销结构（2026-09-17 实测，回答「跑测试电脑要死」）**：① **jsdom 是最大单项**——vitest 自报同一批 60 个纯逻辑文件 jsdom `environment 180.6s` / 墙钟 61-100s，换 node 后 `environment 0.011s` / 墙钟 18.7s（断言本身只占 0.44-0.59s）；全量改默认 node 后剩下的 81 个 jsdom 文件仍占 `environment 176 CPU-s`（约占 worker CPU 三成）。② **待机红线是超时不是逻辑**——`asset-tools` / `paper-v3b` 两个用例隔离跑 2.7-2.8s（默认 `testTimeout` 5s），机器被占满时稳定报 `Test timed out in 5000ms / 15000ms`（复现方式：另开 6 个 CPU 燃烧进程再跑这两个文件；不加负载则全绿）。同理跑测试时**核对别的工作树没在跑门禁**：实测本机同时存在另一个 worktree 的 `tsc --noEmit` + scoped vitest，而测试进程只占 6 核里的 ~2.3 核。③ 本机只有 6 线程（i5-9400F 无超线程），`os.availableParallelism()-1 = 5` 个 fork worker 会和 Chrome/游戏/微信/Defender 实时扫描抢核；要让机器喘气跑 `npx vitest run --maxWorkers=2`（实测全量慢 ~40%，但整机不再满）。
- **`window` 不得当全局注册表用（2026-09-17 修）**：`src/state/scoped-store.ts` 原以 `window[key]` 存 store Map，而该文件经 `canvas-store.ts` → `app/chat/chat-core.ts` 在**模块装配期**求值——`window` 在 node 下未定义，一个词把 136 个测试文件连带绑死在 jsdom 上。已改 `globalThis`（浏览器/jsdom 下 `window === globalThis`，vitest jsdom 环境源码里就是 `global.window = global`，语义恒等）。新增全局注册表一律 `globalThis`。
- **测试运行纪律（2026-08-29 立规，实测踩坑 2 小时；2026-09-16 自 AGENTS.md §10 迁入）**：cargo 测试一律 `--no-run` 先链接 → 前台直跑测试二进制 → 输出直写文件；**禁止 `| tail` / `Select-String` 挂在长 cargo 命令尾部**（管道缓冲全程无输出 + 收尾假挂，会把「冷链接 2-10 分钟」误判成 hang）。最可靠姿势 = `Start-Process -RedirectStandardOutput log -NoNewWindow` + 独立命令轮询日志；小输出直接由工具捕获，大输出走 `cmd /c "exe > log 2>&1"`（PowerShell `>` 对原生命令另有「收尾假挂」变体）。**`hologram-engine.exe` 是用户 DSH 应用的子进程，绝不能 taskkill**（崩溃自动重启，杀了只会误导排障）。另三条续窗实测：① cdp e2e 报「端口 Ns 内未就绪」先清 `D:\tmp\hologram-browser-profile*` 僵尸 chrome + 残留 profile（失败 panic 不清浏览器树，自续污染后续每一轮）；② vitest 全量报 1 error（Worker exited unexpectedly / heap OOM）但计数全过 = 有测试文件在用例体内自旋，**别调大堆**，用文件列表二分（列表必须落盘后 `(Get-Content 列表)` 传参）；③ 构建报 os error 32（文件被占用）先查 IDE rust-analyzer 残留句柄（`handle.exe`）——它是语言服务器，杀进程会被 IDE 立刻重启并重新锁上，用 `handle.exe -c <句柄号> -p <pid> -y` 关句柄。

- **构建临时目录（2026-10-07 实测）**：`vite build` 报 `[commonjs--resolver] remove D:\Temp\user\esbuild-<hex>: Access is denied` **不是代码错**——esbuild 对 **>1MB 的 transform 输入**改走「Node 写临时文件 → Go 读后 `os.Remove`」（`esbuild/lib/main.js:774-777` 的 inputFS 路径），而本机沙箱只允许在**项目树内**删（实测：项目外临时目录 5/5 失败，`C:\Users\…\Temp` 同病；项目内 3/3 通过；给目标目录 Everyone 全开 ACL 也不翻绿 ⇒ 不是目标目录权限，node 自己删同一文件反而成功）。`src-ui/vite.config.ts` 已把构建期 `TEMP/TMP` 收进 `node_modules/.vite-tmp/` 根治（dev / build / vitest 三条 vite 入口一次覆盖）——**别再往系统 TEMP 迁就**；同族报错再现先看这条。

- **Rust 链接静默失败（2026-10-07 实测，上一条的 Rust 侧）**：`cargo build` / `cargo tauri build` 报 `could not execute process …build-script-build (never executed)` + `系统找不到指定的文件 (os error 2)`，或 `process didn't exit successfully: sccache … (exit code: 0xfffffffe)` —— **先查 TEMP，不要先怀疑代码**。取证链：那条 `--crate-type bin --emit=dep-info,link` 只留下 `.d`、`.exe` 不在盘上（rustc 退出 0，编译器一声不吭）；矩阵探针（各 3 轮）钉死 `TEMP=D:\Temp\user` + 经 `engine/grammars/gcc-wrap.exe` 链接 → **FAIL 3/3**，gcc 自报 `Cannot create temporary file in D:\Temp\user\: Permission denied`（**链接失败仍退出 0** ⇒ rustc 误判成功、cargo 在别处炸）；`TEMP=<项目内>` → OK 3/3；裸 gcc 两种 TEMP 都 OK ⇒ 分界是「进程树 × 临时目录位置」。治法已落 `.cargo/config.toml` 的 `[env]`：`TEMP/TMP = { value = "target", relative = true, force = true }`（**force 必须有**——TEMP 恒存在于环境，cargo 默认不覆盖已存在变量）；同批把 `SCCACHE_DIR` 挪到 `D:\Cache\sccache`（C 盘只剩 0.5 GB 时缓存写入会半截失败，那是 `0xfffffffe` 与「只有 .d 没有 .exe」的另一半来源）。

- **工作区完整性标签被外部沙箱改写 ⇒ 产物降权（2026-10-15 实测）**：设置保存全报 `write_atomic(tmp) … 拒绝访问 (os error 5)`、`[window] 窗口状态落盘失败` 且**重启无效**时，先看 `icacls <exe> | findstr "Mandatory Label"`——本机 DSH 的 `workspace-write` 沙箱给工作区**根目录**打的是**常驻 + 可继承**的 Low 标签（其实现 `buildLowLabelAcl` 明写 `dispose()` 不撤销；继承标志 OI/CI 让全树连同既有产物立刻被盖），目录里构建出的 exe 继承它 ⇒ Windows 按**镜像标签**把进程压成 Low ⇒ 写用户目录（`~/.lantai`、`%APPDATA%`）一律拒绝——**DACL 看着全对**（`BUILTIN\Users:(M)`、无 deny、无只读），拦写入的是强制完整性控制，所以「补权限」一类修法全部无效。抬标签需 `SeRelabelPrivilege`，**进程内无法自愈**（实测 Low 进程 icacls 退出码 1299）。治法已落地：`build.cmd` 收尾调 `scripts/fix-product-integrity.cmd` 把产物标签**显式**钉成 Medium（显式 ACE 不会被后续继承传播改写）；`src-tauri/src/integrity.rs` 启动自检，并把修复命令附进 os error 5 的文案。同族事故（方向相反：WebView2 profile **丢**标签）见`.lantai/memory/webview2-profile-integrity-label-2026-10-07.md`。

## 4. 文档维护

- **四层形态（2026-09-16 文档面重构立规；施工单 `docs/plans/doc-surface-refactor-plan.md`）**：
  **L0 注入层**（`CLAUDE.md` 唯一权威 + `AGENTS.md` 薄指针）= 只放规则 + 指针 + 门禁命令，字节数由
  `npm run doc-check` 的 budget 查守护（长表格/叙事/清单外移）；**L1 规则层**（本文件 / `INVARIANTS.md` /
  `docs/adr/`）= 每条事实只写一次；**L2 现状层**（`ARCHITECTURE.md` / `CONTEXT.md` / `docs/design/` 定稿 /
  `docs/plugins/README.md` / `docs/composition/README.md`）= **禁止复述机器可读数字**；**L3 生成层**
  （六份生成物，含 `docs/facts.generated.md`）= doc-sync 逐字节对拍；**L4 过程层**（`docs/plans/` 活在办项 →
  `docs/archive/` 竣工即移 · `docs/research/` 证据冻结）。
- **跨文档数字只准来自 `docs/facts.generated.md` 或写指针**：改真源 → `npm run gen:doc-facts` 重生成 → 同 commit。
  新增事实 = `scripts/doc-facts.cjs` 的 `FACTS` 表加解析器 + `scripts/doc-check.cjs` 的 `CLAIMS` 加断言
  （**宁窄勿宽**：误报会把门禁变噪声；先靠 `--report` 的「未登记候选」栏人工归并）。
- **文档面门禁**：`cd src-ui && npm run doc-check`（逐查清单见 `scripts/doc-check.cjs` 头注，禁在本文件复述计数）。
  在册豁免记在 `scripts/doc-check-exemptions.json`，每条必须写 `reason` + `payoff` 批次——**豁免是账，不是免罪符**，
  对应批次落地时同步删条目。

- 工具/RPC/领域动作清单变化时：更新 `tools/domains.ts` → 本文件 → `AGENTS.md` → `docs/README.md` 索引 → 生成类文档（frontend-rpc-contract.md；模型可见工具面另跑 `npm run gen:tool-contract` 重生成 model-tool-contract.md，vitest 守护测试会拦漂移）。
- 已竣工的 plan/handoff 应移入 `docs/archive/` 或加「历史」横幅，不要继续以现状口吻保留过期数字。
- **文档体量纪律（2026-09-16 立规，用户「我是真过载了」触发）**：文档是给人读的，**入口必须小**。
  体量失控同时是**决策负载**（§0.5）与**阅读负载**的来源——`docs/plans/README.md` 自称
  「人类优先 / 竣工即归档 / 详情勿读」，实际却出现**单个表格单元格 4979 字符**（实测：
  `docs/` 213 文件 3.19 MB，而计划索引 120 行 26 449 字符，一整行就是 5 KB——没法扫）。
  ```
  ✅ 计划索引的表格单元格 ≤ 500 字符：索引不是散文。竣工线只留「状态 + 关键结论 + 链接」，
     叙事归 HISTORY.md / 设计件 / 施工单。
  ✅ 设计件与施工单「决定放前面」：读者要能**不滚动**就看到「要裁什么 / 结论是什么」；
     过程叙事、逐条取证、历史沿革放后面或另文。
  ✅ 竣工即归档：已完成的线**不在索引里复述批次流水**（原文在 git 史 + 设计件里，不丢）。
  ❌ 禁止单行 > 1000 字符（那是排版事故，不是详尽）；禁止把「三万字施工单」当交付物。
  ❌ 禁止为留痕而复述已在别处成文的叙事——**重复即负债**：一处成文 + 其余只放链接。
  ```
  > 立项先例（2026-09-16）：组合线的索引单元格由 4979 字符瘦为 ~440 字符，**diff 恰 1 增 1 删**
  > （零附带改动），权威叙事留在设计件 §4/§8 + 四份施工单里。
- 规则与代码现状冲突时：停下来确认，以代码为准，并更新规则文档；不确定就问用户。
