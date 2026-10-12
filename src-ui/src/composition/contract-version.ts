// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 开放面契约版本（平台化 Phase 3 · P3-C4，2026-08-27）——对齐 DSH
// SESSION_FORMAT_VERSION 机制：seam 接口面是三方（插件/动态插件/MCP 之上的
// provider 层）共同依赖的契约，变更必须显式升版 + 记录，不得静默改约。
//
// 机制三件（单一真源都在本文件 + 对拍文档）：
//   1. OPEN_SURFACE_CONTRACT_VERSION——契约当前版本（整数递增）；
//   2. OPEN_SURFACE_CONTRACT_FILES——契约面的物理载体清单（这些源文件里的
//      公开类型形状 / 注册契约 / 事件载荷 / manifest schema 就是「开放面」）；
//   3. 指纹对拍——docs/agents/open-surface-contract.md 记录当前版本与
//      文件清单的 sha256 指纹；guard 测试（tests/seam-contract-version.test.ts）
//      重算对拍：**文件变更未升版/未更新指纹 = 红**。
//
// 变更流程（guard 红时的修复路径）：
//   ① 改契约文件 → ② bump OPEN_SURFACE_CONTRACT_VERSION →
//   ③ docs/agents/open-surface-contract.md 变更记录加一行 →
//   ④ npm run gen:contract-fingerprint 更新指纹 → 同 commit。
//
// 指纹是粗粒度的（原文 sha256，注释改动也会变）——契约面宁可多升版，
// 不静默漂移；这是刻意取舍不是缺陷。

/** 开放面契约当前版本（变更即 +1，历史见 open-surface-contract.md 变更记录）。 */
export const OPEN_SURFACE_CONTRACT_VERSION = 55;

/** 契约面载体文件（相对 src-ui/；fingerprint 生成器与 guard 消费同一份）。
 *  v55（2026-10-13）**步前裁决贡献面（agent-hooks-plan 一期）**：新增贡献通道
 *  `ctx.preStep`（`composition/pre-step-service.ts`，内核 service 表尾追加第 19 位）
 *  与内核裁决件 `src/agent/pre-step.ts`（`PreStepHook` / `PreStepDecision` /
 *  `PreStepPayload` / `PreStepRegistry`）——每步进入前可 `enter`（附注入批，
 *  落会话 user/message）/ `reject`（拦下本步：不开步、不发请求，reason 只给 UI
 *  可见）；`AgentLoopHost` 增只读成员 `preStep`（第三方 loop 不读 = 零影响）+
 *  default-loop 两处消费点；`BlueprintScope` 增 `preStep`（capability 注册面）；
 *  动态插件沙箱白名单补 `preStep`（嵌套形状由 SHAPE_CHECKS 承担）。
 *  **对外可感知**：第三方产物从此能贡献「每步进入前的裁决与注入」；**无注册者 =
 *  循环逐字节零行为变化**（直通 enter，回归门 tests/pre-step.test.ts）。
 *  v54（2026-09-28）**无 Key 放行 + 鉴权文案分岔**（`provider/types.ts`）：
 *  `classifyError` 新增**可选**第 5 参 `keyless`（= 本次请求没带凭据头）。为 true 且
 *  401/403 时返回专用文案（「本行没有 API Key」：本地端点请核对地址/端口，云端请去
 *  设置填 Key），不再把「没配 Key」误报成「Key 无效」；缺省 false = 既有文案逐字不变。
 *  **动机（真机事故 2026-09-27）**：用户报「本地模型（`127.0.0.1:8080/v1`）配好了却
 *  一直无法调用」——`provider/live.ts` 的凭据闸把空 Key 拦在请求前，本地端点因此
 *  永远用不了（用户唯一出路是填个假占位符）。本版同批把闸门改成「照发、不发凭据头」，
 *  于是「这个 401 是不是因为没配 Key」必须由文案回答（判据 = `shared.ts::sentCredential`
 *  读实际发出的头表，不靠各方言另传标志）。
 *  **对外可感知**：第三方 adapter 只要经 `classifyError` 造文案即自动继承；不传第 5 参
 *  行为逐字不变；空 Key 的行从此发出请求（不再抛 `MISSING_CREDENTIAL`，该标记随之退役）。
 *  v53（2026-09-26）**宿主生命周期贡献面**（批 10 同窗，用户 2026-09-25 裁定 A）：新增两条内核
 *  service 契约载体——`composition/workspaces-service.ts`（`ctx.workspaces`：产物 apply 期
 *  `onActivate(hook)` 登记，工作区激活点按注册序串行 await、失败隔离不阻断打开、`scope.ctx` =
 *  工作区 fiber ctx）与 `composition/shell-rows-service.ts`（`ctx.shellRows`：产物登记 boot 期
 *  壳行，`bootShell` 追加在内核行之后——首消费者 `shell-update-check` 恰为原末位行 ⇒ 引导序
 *  逐位复现）。**对外可感知**：第三方产物从此能贡献「工作区打开时要接的线」与「boot 期副作用」；
 *  无贡献者 = 两条路径零行为变更（无服务环境 = 空贡献面）。内核 service 16 → 18，第一方清单
 *  54 → 56。
 *  v52（2026-09-26）**token 计量升为内核第 16 个 service `ctx.tokenMeter`**（§4-6 A，
 *  用户 2026-09-25 裁定；总账 §4-6 分类缺口）：新增契约载体
 *  `agent/token-meter/contract.ts`——`TokenLedger`（每卷一本账的形状，
 *  实现 = `meter.ts` 的 `SessionTokenMeter`）· `TokenAlgebra`（分桶代数形状，
 *  实现 = `usage.ts`）· `TokenMeterImplementation`（造账本 / 恢复账本 / 代数），
 *  并把 `types.ts` 的六个读数类型在本文件重出口（对外类型入口唯一）。
 *  **对外可感知**：Agent 侧每卷账本改由 `ctx.tokenMeter.createLedger()` /
 *  `restoreLedger()` 制造（缺 service = 具名 `TOKEN_METER_UNAVAILABLE` fail-loud，
 *  不静默建游离账本）；产品读用量读数经 `ctx.tokenMeter.usage` 或自家宿主桥取
 *  唯一实例（创作坞墨量册同批改道，此前直接 import 内核实现文件 = 构建期内联第二
 *  份副本）。**录入点仍唯一 = `Agent.streamOnce`**，口径不变：四桶互不重叠且加总恒
 *  等于提供方 `prompt_tokens`、压力只算 prompt 侧、缓存部分命中不四舍五入成 100%
 *  ——本版对读数逐字无影响（读数只换了制造者）。service 表序追加末位（内核 service
 *  全部先于产物装载）。
 *  v51（2026-09-26）**出厂默认 agent loop 归产物包**（批 9h-2，契约形状零变更）：
 *  `agent/agent-loop/default-loop.ts` 整件移入 `plugins/builtin/agent-loop-service/`
 *  （与注册表 `AgentLoopService` 同包、同一次装载），本清单该行随之改指新路径；
 *  内核 `agent/agent-loop/agent-loop-active.ts` 去掉 `defaultAgentLoop` 兜底 ——
 *  `resolveAgentLoop()` 无服务时具名 fail-loud（该产物同批标 `required`，生产中不会缺席）。
 *  **对外可感知**：第三方 loop 实现（`ctx.agentLoop.register`）零影响；`AgentLoop` /
 *  `AgentLoopHost` 形状逐字未动，`builtin/default` 仍是可寻址的出厂实现。
 *  v50（2026-09-24）**子代理运行时归产物包**（批 7c-2，契约形状零变更）：池 / 生命周期
 *  巡检 / 派生（`SubAgentPool` / `AgentLifecycleManager` / `spawnSubAgent`）三件进
 *  `plugins/builtin/subagent-in-process/`，形状上收内核契约
 *  `agent/subagent-runtime-contract.ts`（`SubAgentStatus` / `SubAgentHandle` /
 *  `SpawnedAgent` / `SubAgentPool` / `AgentLifecycleManager` / `SubAgentSpawnHost` /
 *  `SpawnAgentFn` / `SubagentRuntimeImplementation`），运行时登记表扩三个工厂成员
 *  （service 语义：缺实现 fail-loud）。本清单里只有 `composition/subagent-service.ts`
 *  动了一行——`SubAgentSpawnHost` 类型导入改指新契约文件，**成员与形状逐字未动**；
 *  指纹因原文 sha256 粗粒度而变（刻意取舍）。
 *  v49（2026-09-24）**通信族归产物包**（批 7b，契约形状零变更）：`MessageBus` 实现
 *  （总线 / JSON 存储 / 三种拓扑 / 通信与请求工具族）进 `plugins/builtin/multiagent-comm/`，
 *  类型与四个错误类升格为内核契约 `agent/message-contract.ts`（原 `message-types.ts`），
 *  并新增 `MessageBus` 接口 + `MultiagentCommImplementation` 工厂面（内核查表造会话级
 *  bus/store）。本清单里只有 `agent-loop/types.ts` 动了一行——`MessageBus` 类型导入改指
 *  新契约文件，**成员与形状逐字未动**；指纹因原文 sha256 粗粒度而变（刻意取舍）。
 *  v48（2026-09-24）**压缩域结构切分**（批 6d-1，行为零变更）：记账面
 *  （`CompactionTracker` + 三个账类型 + 费率常量）从 `agent/compaction-model.ts`
 *  切到新 `agent/compaction-tracker.ts`，策略面留原文件；宿主接口 `CompactionHost`
 *  与两个跨层常量（`COMPACTION_NOTICE_MARK` / `SUMMARY_OUTPUT_BUDGET`）上收新
 *  `agent/compaction-contract.ts`（UI 不再直引实现文件）。本清单里只有
 *  `agent-loop/types.ts` 动了一行——`CompactionTracker` 类型导入改指新记账面文件，
 *  **契约形状零变更**；指纹因原文 sha256 粗粒度而变（刻意取舍：宁可多升版）。
 *  v47（2026-09-23）**Responses 方言合规批次**（思考链回传的第二半 + 三处不合
 *  schema 的请求形状）。① `provider/types.ts`：`Message` 新增可选 `responses_items`
 *  （`ResponsesOutputItem[]`，原样留档本轮 `response.output`），`ChunkType` 新增
 *  `ResponsesItems`(=8) 且 `Chunk` 增同名字段。② `agent-loop/types.ts`：
 *  `LoopStreamResult` 新增可选 `responses_items`（第三方 loop 不提供 = 该方言不写
 *  留档，其它方言零变化）。③ `default-loop.ts`：两处 assistant 轮落盘把留档写进
 *  `Message.responses_items`（与 `reasoning_content`/签名同址——显示与回放共用
 *  一份事实）。**动机**：官方对话状态指引要求手工管理上下文时把上一轮
 *  `response.output` **原样拼回** `input`；漏掉 `type:"reasoning"` 项时带 tools 的
 *  请求被服务端拒（OpenAI「Item 'fc_…' of type 'function_call' was provided without
 *  its required 'reasoning' item」/ DeepSeek Responses「The `reasoning_text` in the
 *  thinking mode must be passed back to the API.」）——与 Chat 的 `reasoning_content`、
 *  Messages 的 thinking 块是**同一条规则的三种字段名**。同批 `provider/responses.ts`
 *  （不在本清单）修正三处不合官方 schema 的形状：assistant 的 tool_calls 由
 *  `message.output`（schema 无此字段）改为顶层 `function_call` item；工具结果
 *  `output_text` → `output`（schema 必填）；配对键改用 `call_id`（`call_…`）而非
 *  item id（`fc_…`）；请求体补 `store:false` + `include:['reasoning.encrypted_content']`
 *  （Codex 客户端同款——本适配器自己重放全部历史，无状态端点需要加密推理体）。
 *  **对外可感知**：Responses 方言历史从此自带思考链留档；
 *  无留档（旧卷/别的方言）走既有合成路径；**非 Responses 方言请求体逐字节不变**。
 *  v46（2026-09-23）**思考链回传**（`agent-loop/default-loop.ts` 落盘注释同步；
 *  行为变更发生在 `provider/openai.ts`，该文件不在本清单）：OpenAI 兼容 chat 的
 *  assistant 轮现在把历史 `reasoning_content` 原样回传。规则真源 = DeepSeek 官方
 *  `guides/thinking_mode` · Tool Calls 节：**带 `tools` 参数的请求里历史思考必须
 *  完整回传，否则 400**（不带 tools 时官方忽略该字段）；Anthropic 侧本就重放带签名
 *  的 thinking 块（`anthropic.ts`，须在 `tool_use` 之前）。**动机（真机病象）**：
 *  兰台带 tools 是常态，此前一律不回传 ⇒ 直连 `api.deepseek.com` 时第一轮工具调用
 *  之后每个请求都撞 400，而缺字段的 assistant 消息已落卷 ⇒ 整卷持续重放失败
 *  （DSH 同类事故 deepseek-harness#3857；参照实现 = DSH `llm-deepseek` 的
 *  `serializeAssistant`）。**契约形状零变更**（`Message.reasoning_content` 早已在册，
 *  `provider/types.ts` 的注释写的就是「多轮对话中原样往返」——本版让实现追上它）；
 *  **对外可感知**：模型从此看得见自己上一轮的推理；第三方 adapter 不受影响；
 *  **无思考的轮次请求体逐字节不变**（不编造空串）。
 *  v45（2026-09-23）**错误文案与重试判据**（`provider/types.ts`）：`classifyError` 的
 *  未知分支新增「网关点名了模型、却没给原因」判据（4xx + body 是 JSON 对象且带非空
 *  string `model` + body 内无任何原因文本）——命中时把 body 里唯一可行动的事实写成
 *  人话（该模型 id 可能已下线/改名，请在设置里换用当前可用的模型 id），不再只回
 *  「请截图联系开发者」。**动机（真机事故 2026-09-23）**：opencode GO 对某个模型 id
 *  回 400，body 只有 `{"object":"error","model":"deepseek-v4-flash"}`（无 message/
 *  type/code），用户拿到的唯一信息是「请截图联系开发者」。**对外可感知**：第三方
 *  adapter 只要经 `classifyError` 造文案（本 seam 既有约定）即自动获得该提示；
 *  判据宁窄勿宽 ⇒ body 另有原因文本的错误文案逐字不变。同批两处文件不入本清单：
 *  `agent/retry.ts` 的 `isRetryable` 改读 `providerErrorKind`（显式 4xx +
 *  kind=`auth_or_param` ⇒ 不重试——此前按文案判「[未知错误] 可重试」，同一 400
 *  每轮白烧 3 次尝试）；`provider/vendor-templates.ts` 的 opencode 默认模型改
 *  `deepseek-flash`（与 deepseek 模板同源，legacy `deepseek-v4-flash` 被网关拒）。
 *  v44（2026-09-20）**运行看门狗**（landmine L3 拆弹）：`AgentLoopHost` 新增三个成员
 *  ——`stepBoundary(signal): boolean`（步骤边界：记一次脉搏 + 栅栏裁决；返回 false =
 *  本轮已被硬截止作废，loop 必须立刻停步）、`abandonedError(signal): Error`（具名
 *  `RunDeadlineExceededError`，调用方按类型落墓碑）、`isAbandoned(signal): boolean`
 *  （栅栏纯读法，给「不该再产生新事实」的写入点用）。同版 `events.ts` 新增 emit 域
 *  事件 `run/abandoned`（载荷 RunAbandonedPayload：agentId/runId/kind/noProgressMs/
 *  lastPulse）——本轮被作废后**不会**再有正常收尾，故作废事实单独成事件。
 *  **动机（真机病象）**：模型请求链上唯一的活性守卫是 `provider/idle-stream.ts` 的
 *  30s 空闲计时器，而它只 abort 一个 controller ——等待方不认 signal（本机 IPC /
 *  凭据解析 / 吞掉 abort 的适配器与 SSE 读）时 `for await` 永不返回 ⇒ 连「停滞错误」
 *  都产不出来 ⇒ `provider/retry.ts` 的 15 分钟停滞预算永不生效 ⇒ `agent.run()` 永不
 *  settle（停止钮无效；v43 之后变「幽灵轮」：账注销了、loop 永留栈上）。
 *  同版 `Agent.run()` 把 `runLoop` 与 **硬截止** 和 **signal 中止** 竞速：
 *  无进展 20min → 作废该轮（栅栏 + abort + 具名错误 settle，迟到事实不进投影）；
 *  用户停止 → 同一竞速立刻 settle（停止因此真解旋，`_loopDepth` 归零）。
 *  **对外可感知**：第三方 loop 不调 `stepBoundary` 照旧跑（脉搏少一路，误判方向是
 *  「更晚作废」而非误杀）；读 `signal.aborted` 的 loop 若想识别「被作废 vs 用户停止」，
 *  用 `host.isAbandoned(signal)`。阈值参数**不扩 AgentConfig**（23 字段冻结）。
 *  v43（2026-09-20）**运行态收口**：`AgentLoopHost` 去掉 `isRunning` 成员（get/set 一对）
 *  ——「这卷/这轮在不在跑」的唯一事实改为**运行账**（`agent/execution-state.ts` 的
 *  RunRecord；`Agent.isRunning` 派生自它，UI 全域读 `agentSessionState.runStateOf`）。
 *  同版 `default-loop` 不再写 `host.isRunning`，并把「本轮结束时 inbox 还有未注入消息 ⇒
 *  补唤醒」上移到 `Agent.run()` 的 finally（**在运行记录注销之后**）。
 *  **动机（真机病象，三周内同族修了四次：994c4c4d / 32bc8dd4 / b67ac7e8 / 54981624）**：
 *  旧模型把「在跑」建模成**靠约定同步的声明**——`isRunning` 布尔 + 可选令牌
 *  `done(runSignal?)` + 多处各自持有的账本实例。每个新异步路径（延迟唤醒 / 停后立刻重发 /
 *  压缩在途开新轮 / 句柄重建）都能把它撕开一条缝，而撕开时**无声**（违宪法四）。
 *  新模型：运行记录是可加的事实，isRunning 是派生值，注销按记录身份（清不掉别人的运行）。
 *  **对外可感知**：第三方 loop 若写 `host.isRunning` = 给宿主对象挂无主属性（no-op），
 *  运行态不再受其影响；第三方若**读**该字段需改读运行账（`host` 无此成员）。
 *  同版运行账 API 破坏性变更：`start()` / `done()` / `stop()` / `forceReset()` 退役，
 *  改为 `beginRun(kind)` → `RunHandle{signal,end}` / `runFor(signal)` / `stopAll()` /
 *  `discardRuns(ids)`；`ExecStateInstance.isRunning` 变只读派生值。
 *  同版新增运行态**唯一读面**（会话注册表）：`runStateOf` / `runningSessions` / `stopRuns`，
 *  以及装配绑定点 `bindExec`（账是卷级恒定的那一本——装配只绑定、绝不换账）。
 *  事件序列/载荷零变更（convergence 双轨零漂移）；`tool/call` 落点未动。
 *  v42（2026-09-19）斜杠命令面重做（command-surface-rework）：`CommandContribution`
 *  的 `shortcut: string` 拆为 `slash?: string` + `kbd?: string`——旧字段一名两义
 *  （'/dock' 斜杠触发词与 'ctrl P' 键位提示同处一栏），命令面板把键位当命令陈列、
 *  斜杠面板把斜杠词当快捷键显示。同版 `CommandAction` 由内联联合提升为具名导出，
 *  且 `local` 的 handler 收斜杠参数（`(arg: string) => void`；无参 = 空串）——
 *  `/goal resume` · `/remember <事实>` 一类带参命令不再需要在发送面硬编码分支。
 *  **对外可感知**：第三方插件贡献命令必须改字段名（`shortcut: '/x'` → `slash: '/x'`），
 *  旧名不留别名；两字段皆缺省 = 只进 Ctrl+K 面板（不再强制每条命令都有触达词）。
 *  同版命令清单唯一真源收归本通道——旧 `ui/command-registry` 单例与裸表整文件退役，
 *  消费合流点 = `src/app/commands/command-catalog.ts`（内建 + 贡献 + 技能候选）。
 *  v41（2026-09-17）ctx.llm seam：连接怪癖的**用户可编辑面**——`ProviderRuntimeArgs`
 *  新增可选 `headers`（自定义请求头，源头 = `ProviderSettings.headers`）：三方言
 *  stream/prewarm/fetchModels 一并携带，合并序「自定义头在前、内核必需头与凭据头
 *  在后」且按键（小写）剔除冲突（HTTP 头名大小写不敏感，大小写不同的同名会被
 *  Fetch 合并成 "a, b" 污染凭据头——实测钉住）。动机：OpenCode GO 强制
 *  `x-opencode-session` 一类网关怪癖此前只能改代码发版，exe 用户无路可走。
 *  **缺省 = 未配置 ⇒ 请求头逐字节不变**（老行零迁移；第三方 adapter 不读即可）。
 *  同批设置页新增「高级」面：请求头编辑 + 该行配方（非敏感 JSON，密钥剥除）。
 *  v40（2026-09-17）工具附图通道 P0a（agent 眼睛环）：`Message.images` 合法角色
 *  从「仅 user」扩到「user + tool」——工具产出的截图（browser screenshot）由此
 *  进模型上下文（此前模型只能拿到 PNG 路径，自立看不见自己的产出）。两协议走
 *  原生形态（anthropic tool_result.content 数组 / responses function_call_output
 *  .output 数组），OpenAI 兼容 chat 在 tool 组尾补合成 user 消息；**无图路径三
 *  协议 wire 形态逐字节不变**（D-6），`tool/result` 事件形状零变更（data 本就是
 *  整个 Message）⇒ convergence 双轨零漂移。default-loop 两处写入点挂引用。
 *  依据 docs/plans/tool-image-context-plan.md（裁定 3/4）。
 *  v39（2026-09-15）S6 P3b 组合**依赖与独占**声明：`CompositionPatchSchema` 新增
 *  两个可选顶层键——`requires: [插件名]`（该组合依赖的插件；缺任一 ⇒ 组合不可用，
 *  原因**具名**：「组合 X 需要插件 Y，但它未装载」——比行 id 写错的报错可读）
 *  与 `exclusive: [资源实例名]`（该组合要独占的资源，如 `port:9310` / `stdio`）。
 *  `ResolvedComposition` 新增 `activationDecl`（两键的**纯聚合**，判定不在解析层）；
 *  `ActivationSpec` 的 `exclusive` 与组合层声明同等参与**装配期冲突检测**——
 *  同一资源被两个插件声明且都在位 ⇒ 后装配者被拒（fail loud，原因含双方 id），
 *  拒绝后装配者不留账（整体回滚）。**对外可感知**：用户 preset 可声明依赖与独占，
 *  失败面从「未知行 id」变成「缺插件 X」；**缺省 = 不写两键 ⇒ 现语义逐字节不变**
 *  （出厂两轨零声明 ⇒ 该判据在热路径不求值，零新增开销）。诊断第四栏「被跳过」
 *  （`activationSkipped`：激活失败的插件 + 原因）经设置面板「组合」节呈现 |
 *  S6-per-agent-composition.md P3b（施工单 WO-S6P3 §2.4-§2.6/§7-B·C·D）
 *  v38（2026-09-15）S6 P3a 插件**激活声明**（登记 ≠ 激活）：manifest 新增可选块
 *  `activation: { lazy?, resources?, exclusive? }`（plugins/types.ts）——`lazy:true`
 *  的插件把副作用启动从 apply 期挪到**组合装配期**（引用计数：首次 start /
 *  归零 stop，见 composition/activation.ts）；`lazy:true` 与
 *  `mcpServers[].lifecycle="eager"` 互斥（manifest 级 refine，装载期拒载）。
 *  **对外可感知**：插件可声明资源型副作用并拿到按组合的生命周期；**缺省 =
 *  无 `activation` 块 ⇒ P3 前语义（登记即激活）逐字节不变**（kill switch，
 *  设计件 §5）。同版新增第五个组合层 service `ctx.activation`
 *  （composition/activation-service.ts）——插件面（apply 期 declare）与装配面
 *  （retain/release）的契约载体。**本版起契约面口径统一**：用户 preset 的写法
 *  契约 `composition/roster.ts` 与新服务文件一并登记（用户 2026-09-15 裁定 F：
 *  此前靠「文件不在清单里」逃过指纹）| S6-per-agent-composition.md P3a
 *  （施工单 WO-S6P3-plugin-activation.md §2.1/§2.3/§7-A/§7-F）
 *  v37（2026-09-15）S6 P2b llm seam **装配期值注入**：`activeLlmAdapters(view?)`
 *  收可选 view；`createProvider(settings, options)` 的 `CreateProviderOptions` 新增
 *  可选 `seamView`——方言解析（`resolveProviderDialect`）按它裁剪 `seam/llm`。
 *  **对外可感知**：同一份 settings，两卷可落不同 adapter（每卷 provider 由
 *  workspace 会话工厂 / 热切换按该卷组合构建）；**缺省 = 全局当前选择** ⇒
 *  无组合上下文的构建点（设置面板连通性测试 / 翻译压缩旁路 / 第三方自测）行为
 *  逐字不变。工作区默认 provider 有意不传（其组合上下文 = 工作区装配组合，
 *  已由 composition-store 灌成全局当前选择）| S6-per-agent-composition.md P2b
 *  （施工单 WO-S6P2 §2 消费点 4 + §7-F 两笔切分的第二笔）
 *  v36（2026-09-15）S6 P2a seam 裁剪面**装配期值注入**：`seamDisabled(domain, view?)`
 *  新增可选 view —— **缺省 = 全局当前选择**（无组合上下文的旧路径逐字保持 P2 前
 *  语义）；`activeFsProviders` / `activeShellProviders` / `activeSubagentProviders`
 *  同款收可选 view；`AgentEventBus` 新增 `setSeamView()`（每 Agent 一条总线，
 *  emitLoopEvent 读本总线视图——emit 调用点零改动）。**对外可感知**：seam provider
 *  的可见面从此可按 Agent 的不同（两份裁剪面并存互不串味）；未传 view 的旧调用面
 *  （UI 直调 / 无 agent 工具路径 / 第三方 provider 自测）行为逐字不变 ⇒ convergence
 *  双轨快照零漂移（出厂 standard/minimal 的 seamDisabled 构造性为空）。新增携带层
 *  `composition/seam-scope.ts` 是**键控叶模块**，不入本清单（非三方面；叶性由
 *  tests/composition-import-cycle.test.ts 钉住） | S6-per-agent-composition.md P2a
 *  （施工单 WO-S6P2 §2/§7-A 用户裁定：携带路径取 owner 键控表而非 rowCtx 扩字段
 *  ——fs/shell 族实例经 familyContributions 锁存首次装配 rowCtx，扩字段结构性无效）
 *  v35（2026-09-15）	ool/call 前移到分发时落（触发点 B 收官，用户已批准
 *  phase-5 基线变更）：默认 loop 注入的检查点钩子现在**先 append 	ool/call、
 *  再 lushPersistence()**，让「模型宣布了什么」在副作用发生前就落盘；default-loop
 *  两处流收尾的重复追加删除（单一写入点）。**契约形状零变更**（AgentLoopHost 未动）；
 *  模型可见面零变化（	ool/call 无消息投影）；事件**序列**变化 ⇒ phase-5 事件序列
 *  基线两轨重录（CR 见 docs/archive/agent-core-convergence/baseline-change-request.md）。
 *  v34（2026-09-15）工具副作用前检查点（换轨触发点 B 的兰台形）：默认 loop
 *  构造 StreamingToolExecutor 时注入第 7 参钩子 = host.sessionLog.flushPersistence()
 *  ——args 解析完成、闸/预检之前 await 一次「会话事实落盘屏障」，失败 fail-open 且
 *  executor 内 warn 可见。**契约形状零变更**（AgentLoopHost 成员未动；新参数在
 *  执行器构造上，第三方 loop 自管工具执行不受影响）；同版 SessionLog 增
 *  setPersistenceSink / lushPersistence 两个方法（日志自己回答「我落盘了吗」，
 *  避免 agent 层 import app 层——分层纪律）。**仍未做**：把 	ool/call 审计事件
 *  提前到分发时落（那会改事件顺序 ⇒ phase-5 基线漂移 ⇒ 需 baseline-change-request）。
 *  v33（2026-09-15）会话持久化 seam 权威翻转（Phase 3b）：delete_volume 退役
 *  （墓碑重写 deleted:true 是「快照即存储」时代的占位手段——权威翻转后
 *  「文件不在 = 卷不存在」），新增 delete_log（真删日志 + 投影缓存）。
 *  **对外可感知**：第三方会话后端 provider 应实现 delete_log 并退役 delete_volume；
 *  同版消费面：.ndjson 成为卷本体（list/scan/剪枝/删除 全按日志认卷），
 *  .json 降级为带 {seq, ver} 的 UI 投影缓存（陈旧即重建，不再当权威读）。
 *  v32（2026-09-15）会话持久化 seam 动作面扩展（DSH 参照换轨 Phase 1）：
 *  `SESSION_PERSIST_ACTIONS` 由四动作（read/list/save/delete_volume）扩为八动作
 *  ——新增事件日志四动作 `read_log` / `write_log` / `append_events`（durable：
 *  append + fsync，返回即已落盘）/ `truncate_log`（断尾修复）。**对外可感知**：
 *  第三方会话后端 provider 需实现四新动作才算完整实现（文本持久化的后端最简单
 *  的实现 = 四动作转发到同一份文件读写；不改后端也能跑——事件日志面缺席即
 *  「旧行为逐字不变」）。同版消费面：`app/chat/session-log-store.ts`（写后队列 +
 *  最小加载器）+ `shell/rows/persistence.ts` 的检查点从「落全量快照」改为
 *  「排空日志队列」。
 *  v31（2026-09-15）S6 P1b 选择集语义：`ToolContribution` 新增可选
 *  `defaultOff?: boolean`——插件可出货「**登记但默认不进任何组合**」的行
 *  （重装备/实验性），组合解析把它初始置 disabled，用户在自己的 preset 里写
 *  `disabled: false` 回开（roster 侧既有语义，零新语法）。**对外可感知**：
 *  第三方插件从此能出货默认关的行面；不声明 = 行为逐字不变（出厂面零声明
 *  ⇒ convergence 双轨快照零漂移，本版实测）。同版诊断面按**原因**分栏
 *  （未选中 / 被禁用 / seam 裁剪——`CompositionDiagnostics` 新增
 *  `unselected` / `seamCapped`，seam id 不再混进 `disabled`；该类型在
 *  roster.ts，不属契约面载体，随本版一并记录）。
 *  v30（2026-09-14）动态插件守卫注册面校准（`dynamic-runner/sandbox.ts`）：
 *  `GUARDED_SERVICES` 此前漂移已久——仍列着 2026-09-09 全量退役的 `graph`
 *  （死条目：模型照它写 `ctx.graph.register` 必报「服务不可解析」），且缺
 *  `overlays` / `hooks` / `agentLoop`；同文件 `validateDef` 还按服务特判
 *  `needId='key'`，在 v29 把行身份统一成 `id` 之后，**动态插件注册 capability
 *  整条路恒失败**（给正确 id 被守卫拒，给旧 key 被通道形状校验拒）。
 *  本版：白名单 = 九条贡献通道 + 五条 seam 全量 14 面；`needId` 统一 `id`；
 *  `hooks` 的嵌套形状（`{ id, kind, hook }`，函数成员在 hook 内且随 kind 变）
 *  由新增的 `SHAPE_CHECKS` 承担装载期校验。**对外可感知**：动态插件从此能贡献
 *  overlays / hooks / agentLoop，capability 必须用 `id`。同版补上文件自注承诺
 *  却缺席的守护——白名单 ↔ 真装配对拍（tests/dynamic-runner.test.ts ⑩）。
 *  v29（2026-09-14）M1 插件化收口（通道内核单层化）：注册表内核从
 *  `services.ts` 的 `ContributionRegistry` 上收为 `contribution-channel.ts` 的
 *  `ContributionChannel`——**类名变更 = 破坏性契约变更**（该名字经宿主桥
 *  faceDeps 与 `host.aliased.ts` 暴露给产物插件；五个手抄副本
 *  Renderer/Prompt/HookContribution/CapabilityContribution/Overlay 随之退役）。
 *  行为面零变更（id 寻址/重名拒绝/幂等 disposer/陈旧性守卫/贡献序逐字保持），
 *  新增两件声明式数据：`timing`（四档生效时机，历史上是隐式的「传没传回调」）
 *  与 `subscribe`（统一订阅面，收编 OverlayRegistry 的自成一格 API）。
 *  **同版破坏性变更**：`AgentCapability.key` 更名为 `.id`（capabilities 是九条
 *  通道里唯一行身份不叫 id 的，M1 统一为 id；`AgentBlueprint.keys()` 随之更名
 *  `ids()`）——外部插件若贡献 capability 必须改字段名，旧名不保留别名。
 *  v28（2026-09-13）：`manifest.app` 入口二态——`entry`（资产 HTML）与 `url`
 *  （**环回** http(s) 远端页，白名单 127.0.0.1/localhost/::1、禁凭据）互斥必给其一；
 *  url 形态禁 `fullscreen`。远端形态的窗口帧给 `allow-same-origin`（跨源文档保住
 *  自己 origin，同源 SSE/fetch 才通）且**不绑宿主桥**。契约形状变更（entry 由必填
 *  转为「二态之一」），向后兼容：只声明 entry 的既有插件行为零变化。
 *  v27（2026-09-13）：`manifest.mcpServers[]` 新增可选 `readOnly`（MCP 工具只读
 *  语义归真——P0，见 office-cli-integration-plan.md §5）：判定真源落在
 *  `agent/mcp/registry.resolveMcpToolReadOnly`（条目声明 > 远端 annotations.
 *  readOnlyHint > 缺省 false）。types.ts 是 manifest schema 载体，故本版升号。
 *  v26（2026-09-13）：`LoopStreamResult` 新增可选 `token`（token 计量记录）——
 *  默认 loop 把它随 Usage 事件投给 UI；第三方 loop 不提供即 UI 计量面缺一条，
 *  执行语义零变更。同版 default-loop 的 Usage sink 增携带该字段。
 *  v25（2026-09-12）：补登记 `provider/types.ts`——`ctx.llm` 的
 *  `LlmAdapterContribution.create` 返回的 `Provider` 形状就是该 seam 的契约面，
 *  此前未入册（本版给 Provider 加 `model()` 时差点从指纹下溜过去）；
 *  同版 events.ts 载荷 provider/model 分账。
 *  v24（2026-09-09）：graph-service.ts（ctx.graph seam）随图谱功能全量退役移除。 */
export const OPEN_SURFACE_CONTRACT_FILES: readonly string[] = [
  // 贡献通道内核（M1 收口：九通道 + 五 seam 的唯一注册表实现——ContributionChannel
  // 本身是插件面（经宿主桥 faceDeps 暴露），形状变更即对外契约变更）
  'src/composition/contribution-channel.ts',
  // 六个 seam 注册表（provider 接口 + 动作枚举 + 消费单点签名）
  'src/composition/services.ts', // ctx.llm + 四通道 def（M1 起内核移出本文件）
  'src/provider/types.ts', // ctx.llm seam 的实现面形状真源（Provider/Chunk/Request——v25 补登记）
  'src/composition/fs-service.ts', // ctx.fs
  'src/composition/shell-service.ts', // ctx.shell（subprocess 并入）
  'src/composition/session-persistence-service.ts', // ctx.sessionPersistence
  'src/composition/subagent-service.ts', // ctx.subagents
  // seam 裁剪面（组合域寻址契约）
  'src/composition/seam-resolution.ts',
  // 事件面（D4 表 + 载荷形状）
  'src/agent/events.ts',
  // 动态插件运行时（D7——define/run/stop/undefine/inspect + 沙箱承诺）
  'src/agent/dynamic-runner/dynamic-runner-service.ts',
  'src/agent/dynamic-runner/sandbox.ts',
  // agent loop seam（D13——AgentLoop/AgentLoopHost 契约 + 默认实现 + 活动面）
  'src/agent/agent-loop/types.ts',
  'src/plugins/builtin/agent-loop-service/default-loop.ts',
  'src/agent/agent-loop/agent-loop-active.ts',
  // 插件 manifest 契约（loader 装载面；v38 起含 activation 块）
  'src/plugins/types.ts',
  // 用户 preset 写法契约（v38 补登记——用户裁定 F：patch schema 此前靠
  // 「文件不在清单里」逃过指纹；内容 = CompositionPatchSchema 的四行域 + 七
  // seam 裁剪域键，用户手写在 ~/.lantai/composition/presets/<id>/roster.patch.yml）
  'src/composition/roster.ts',
  // 激活账（v38 新增第五个组合层 service；插件面 = apply 期 declare(spec) 的
  // ActivationSpec 形状，装配面 = retainForComposition/releaseAll；v39 增
  // exclusive 持有表与冲突检测 + 诊断读面 activationSkipped/activationConflict）
  'src/composition/activation.ts',
  'src/composition/activation-service.ts',
  // token 计量契约（v52 §4-6 A：`ctx.tokenMeter` 第 16 个内核 service 的消费面
  // ——每卷账本形状 TokenLedger + 分桶代数 TokenAlgebra + 实现面；录入点仍唯一 =
  // Agent.streamOnce，service 只出「造账本 / 恢复账本 / 读代数」）
  'src/agent/token-meter/contract.ts',
  // 宿主生命周期贡献面（批 10 同窗，2026-09-26；用户 2026-09-25 裁定 A）：两条新内核 service
  // ——工作区接线贡献面（产物 apply 期 onActivate 登记 → 激活点按注册序串行回调、失败隔离）
  // 与壳行贡献通道（产物登记 boot 期壳行 → bootShell 追加在内核行之后）。第三方产物可经
  // ctx.* 贡献（裁定：敏感面 = MCP 桥，走 faceDeps 留第一方）。
  'src/composition/workspaces-service.ts',
  'src/composition/shell-rows-service.ts',
  // 步前裁决面（agent-hooks-plan 一期，2026-10-13）：贡献形状载体（PreStepHook /
  // PreStepDecision / PreStepPayload / PreStepRegistry）+ 通道 service（ctx.preStep）。
  'src/agent/pre-step.ts',
  'src/composition/pre-step-service.ts',
];
