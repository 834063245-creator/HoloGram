# HoloGram

HoloGram 是深空代码拓扑观测站：把代码库解析成可对话的依赖星图，并通过 AI 代理辅助分析。本词汇表是应用级统一语言，已锁定「模型接入」「会话与聊天」「任务与目标」「状态」「事件」五个簇；`kind` 与 `status` 是重载字段，用词时必须带簇前缀。

## Language

### 模型接入（Provider 域）

**Provider**:
Agent 可用来与模型对话的接入点，由端点、凭据与默认模型构成。代码标识符统一用 Provider；界面中文展示词为「信号源」。
_Avoid_: 信号源（代码标识符）、服务商、backend

**ProviderId**:
Provider 的身份标识，唯一且不可变；同时是系统凭据键与动态模型合并键（三合一）。它是身份，不是显示名。
_Avoid_: name（当身份使用时）、providerName、字符串

**Vendor**:
提供模型 API 的品牌或组织（如 DeepSeek、Anthropic、GLM）。一个 Provider 通常指向一个 Vendor，但 Vendor 是品牌，不是接入配置。
_Avoid_: provider、服务商、公司

**Protocol**:
模型 API 的线上方言：Anthropic Messages 或 OpenAI 兼容。决定请求如何构造与解析；与 Vendor 正交（同一 Vendor 可提供不同 Protocol 的端点）。
_Avoid_: kind、API 类型、厂商协议

**Model**:
Vendor 提供的具体模型，有唯一标识与能力元数据（上下文窗口、成本、是否支持推理）。
_Avoid_: 模型名、model id、LLM

**ModelId**:
标识具体模型的字符串（如 deepseek-v4-pro）。它是 Model 的身份，不是 Model 本身。
_Avoid_: model、模型名

**ThinkingPolicy**:
用户对「模型作答前推理多少」的配置。按 Protocol 分为 Anthropic 的 effort 等级与 OpenAI 兼容的深度思考开关；区别于模型能力（是否支持推理）与响应中的思维链内容。
_Avoid_: thinking、深度思考、reasoning（作设置名）

**ConnectionProbe**:
对 Provider 的一次最小连通性验证，产生结果：成功/失败、耗时、时间与消息。它是检查动作及其结果，不是 Provider 配置。
_Avoid_: 测试连接结果、lastTest、testStatus

**Credential**:
与 Provider 关联的 API Key。只存在于系统加密存储，本地持久化中永不明文。
_Avoid_: key、apiKey、密钥

**Catalog**:
内置模型注册表：静态目录条目与运行时从 Vendor 拉取的动态条目合并而成。
_Avoid_: 模型列表、registry

### 会话与聊天（Session & Chat 簇）

**Session**:
一次持久化的对话容器，有唯一 SessionId、消息数组与活动索引。会话与 Provider/Agent 运行周期正交，可切换、可恢复。
_Avoid_: 线程、面板、conversation

**ChatMessage**:
聊天流中的一条记录，按 role 分为用户消息（user）、助手消息（assistant）与通知（notice）。它是不可变记录，流式更新通过替换条目实现。
_Avoid_: 气泡、bubble（代码标识符）

**MessageId**:
ChatMessage 的身份标识，全局单调递增（如 m1、m2），跨会话不重用。
_Avoid_: id（裸用）、序号

**Turn**:
一个「用户消息 → 助手完整回复（可穿插多次工具调用）」的完整回合。工具调用属于 Turn，不单独算回合。
_Avoid_: 轮次、round

**AssistantPart**:
助手消息内的有序组成部分：推理（reasoning）、文本（text）、工具调用（tool）、子代理（subagent）、计划审查（plan）。
_Avoid_: 气泡、block、section

**Notice**:
系统通知消息，带 level（info/warn/error），展示为横幅或状态提示；不是用户或模型的对话内容。
_Avoid_: toast、log、消息（当指 notice 时）

### 任务与目标（Task & Goal 簇）

**Task**:
Agent 自管理的一次可跟踪工作项（hologram_task_* 工具），会话内生效，带 TaskStatus。用于跨轮次追踪多步工作。
_Avoid_: issue、todo、goal

**TaskStatus**:
Task 的状态机：pending → in_progress → completed / cancelled。
_Avoid_: status（裸用）、state

**Goal**:
`/goal` 模式下的长期目标记录（GoalRecord），独立于普通会话槽位持久化；崩溃后可迁移/收养恢复。
_Avoid_: task、mission、目标（代码标识符）

**GoalStatus**:
Goal 的状态机：active / paused / completed / failed / cancelled。
_Avoid_: status（裸用）

**SubAgent**:
由 Agent 派生的子代理，以 AgentId 标识，可输出独立事件流并在 board 上留痕。
_Avoid_: worker、子进程、agent（当指子代理时）

**SubAgentStatus**:
SubAgent 的生命周期状态：running / completed / failed / stopped。
_Avoid_: status（裸用）

**AgentRunStatus**:
Agent 会话/运行记录的状态。当前代码存在两处值域差异：agent-store 为 idle/running/done/failed，runtime 为 idle/running/paused/completed/failed/stopped——须收敛为单一事实源后锁定。
_Avoid_: status（裸用）、AgentStatus（在需要统一概念时）

**BoardEntry**:
任务板（TaskBoard）上的一条子代理记录，带 BoardStatus 与隔离 worktree 关联。
_Avoid_: task（当指 board 条目时）

**DiscoveryEntry**:
发现板（DiscoveryBoard）上的一条探索发现记录，带 DiscoveryStatus（active/archived）。
_Avoid_: 发现、note

### 状态（Status 簇）

**ProbeOutcome**:
ConnectionProbe 的结果：ok / fail。它是检查动作的产物，不是 Provider 的派生状态。
_Avoid_: status（裸用）、testStatus

**ProviderStatus**:
信号源列表/控制台展示的派生状态：unconfigured（无 Key）/ configured（有 Key 未测或结果丢失）/ ok（最近测试通过）/ fail（最近测试失败）。唯一事实源是 status.ts 的 providerStatus()。
_Avoid_: 状态点、status（裸用）

**ToolRunStatus**:
工具调用部分的执行状态：pending / running / done / error。
_Avoid_: status（裸用）

**MessageStreamStatus**:
助手消息整体的流式状态：streaming / done / error。
_Avoid_: status（裸用）

**PlanApprovalStatus**:
计划审查卡片的审批状态：pending / approved / revise / rejected。
_Avoid_: status（裸用）

`status` 字段重载速查（写代码/对话时带簇前缀，禁止裸用）：

| 载体 | 规范词 | 值域 |
| --- | --- | --- |
| ConnectionProbe.status | ProbeOutcome | ok / fail |
| providerStatus() 派生 | ProviderStatus | unconfigured / configured / ok / fail |
| AgentRecord.status / AgentStatus | AgentRunStatus | 两处值域，待收敛 |
| SubAgentHandle.status | SubAgentStatus | running / completed / failed / stopped |
| ToolCallPart.status | ToolRunStatus | pending / running / done / error |
| AssistantMessage.status | MessageStreamStatus | streaming / done / error |
| PlanPart.status | PlanApprovalStatus | pending / approved / revise / rejected |
| Task.status | TaskStatus | pending / in_progress / completed / cancelled |
| GoalRecord.status | GoalStatus | active / paused / completed / failed / cancelled |
| DiscoveryEntry.status | DiscoveryStatus | active / archived |
| BoardEntry.status | BoardStatus | running / completed / failed / stopped / merged |

HTTP status、git status 等外来状态不属于本项目词汇，不进入本表。

### 事件（Event 簇）

**AgentEvent**:
Agent 输出的事件流条目，以 EventKind 判别；经 EventSink 单向流向 UI。UI 不得反向写 Agent 事件流。
_Avoid_: message（当指事件时）、bus event

**EventKind**:
AgentEvent 的种类：turn_started / reasoning / text / message / tool_dispatch / tool_result / tool_progress / usage / notice / session_changed / plan_review。
_Avoid_: type、kind（裸用）

**Chunk**:
Provider 流式响应中的数据片，以 ChunkType 判别（Text/Reasoning/ToolCall/Usage/Done/Error 等）。
_Avoid_: 流片、stream piece、事件（Chunk 不是 AgentEvent）

**BusEvent**:
前端事件总线（events.ts，如 `agent:status`）上的一类 UI 级事件，与 AgentEvent 是两个通道。
_Avoid_: event（裸用）、AgentEvent（当指 bus 时）

`kind` 字段重载速查（五义）：

| 载体 | 规范词 | 值域/说明 |
| --- | --- | --- |
| ProviderSettings.kind / ModelDescriptor.kind / catalog JSON kind | Protocol | anthropic / openai（存储遗留名，改键需迁移） |
| AgentEvent.kind | EventKind | 事件种类（见上） |
| NodeBrief.kind / graph 节点 kind（graph-types / graph-analysis / graph-fold） | SymbolKind | 依赖图节点/边的符号类别（file/function/class…） |
| chat-utils diff 行 kind | DiffLineClass | diff-added / diff-removed 等 UI 样式类 |
| LSP CompletionItemKind | （外来词） | 第三方 LSP 枚举，不进入本项目词汇 |
