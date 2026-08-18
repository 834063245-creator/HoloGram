# HoloGram — 核心能力与技术架构

> © 2026 Wenbing Jing. MIT License.
> 最后更新：2026-08-17（按当前 HEAD 与实测基线校准）

HoloGram 不是一个单纯的"代码图谱可视化工具"。它的本质是一个 **Harness Engineering 平台**——将多种成熟软件工程模式（依赖分析、约束治理、变更预演、沙箱隔离、Agent 自主执行等）编排为统一 Harness，并通过内置 Agent 与对外 MCP 服务将这些能力开放给人和 AI。

代码图谱分析引擎是目前体量最大、最核心的组件，但它是 Harness 体系的一个支柱，而非全部。

---

## 1. 核心能力总览

| 能力域 | 定位 | 当前实现深度 |
|--------|------|-------------|
| **代码图谱分析引擎** | 多语言 AST 解析 → 依赖拓扑图 → 耦合/社区/数据流分析 + 语义向量索引 | ★★★★★ 最完整 |
| **Agent 自主执行系统** | LLM 驱动的多轮工具调用循环，含多 Agent 协作、上下文压缩、Plan 模式、目标管理 | ★★★★☆ |
| **Harness Engineering 模式** | 约束治理、变更预演、沙箱隔离、权限引擎、审计日志 | ★★★★☆ |
| **MCP 对外服务** | 36 个 schema、默认暴露 35 个工具，通过 JSON-RPC 服务任意 MCP 客户端 | ★★★★★ |
| **3D 图谱可视化** | GPU 加速的交互式依赖星图（Three.js / WebGL） | ★★★★☆ |

---

## 2. 架构分层

```
┌─────────────────────────────────────────────────────┐
│                    外部 MCP 客户端                     │
│            (Claude Code / Cursor / 任意 MCP 客户端)      │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC over stdin/stdout
┌──────────────────────┴──────────────────────────────┐
│              Engine (Rust 库 + CLI 二进制)             │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 统一 API  │  │ MCP 服务  │  │ 36 schema/35 默认    │  │
│  │ Engine.rs │  │ JSON-RPC │  │  ToolRegistry     │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       └─────────────┴─────────────────┘              │
│   全局实例 ENGINE (LazyLock<RwLock<Option<Engine>>>)  │
└──────────────────────┬──────────────────────────────┘
                       │ 进程管理 (McpManager) + IPC
┌──────────────────────┴──────────────────────────────┐
│              Tauri 桌面 Shell (Rust)                  │
│  ┌──────────┐ ┌─────────┐ ┌────────┐ ┌───────────┐  │
│  │ 权限引擎  │ │ 沙箱    │ │ 隔离   │ │ 生命周期   │  │
│  │Permission│ │ 双层沙箱 │ │worktree │ │Ledger     │  │
│  └──────────┘ └─────────┘ └────────┘ └───────────┘  │
│         单一 RPC 入口 (rpc.rs 134 个方法)              │
└──────────────────────┬──────────────────────────────┘
                       │ Tauri IPC (invoke)
┌──────────────────────┴──────────────────────────────┐
│              前端 (TypeScript / React 19)             │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐  │
│  │ Agent 循环│ │ 工具注册表 │ │多Agent池│ │ 3D 星图   │  │
│  │ streaming│ │ ToolReg  │ │Coord.  │ │ Three.js  │  │
│  └──────────┘ └──────────┘ └────────┘ └───────────┘  │
│   Workspace (统一状态容器) + Zustand stores + React   │
└─────────────────────────────────────────────────────┘
```

三层各自独立编译，通过明确边界通信：
- **Engine** 是纯 Rust 库 + CLI 二进制，零外部运行时进程，可独立 `serve` 作为 MCP 服务器
- **Tauri Shell** 是进程管理者和权限守卫，不做分析逻辑
- **前端** 是 Agent 运行时和用户界面，通过 `typedRpc()` / `typedListen()`（`rpc-contract.ts`）与后端通信

### 2.1 关键运行时事实

- **Engine 全局实例**：`engine::ENGINE`（`LazyLock<RwLock<Option<Engine>>>`）持有全部图状态；`engine_init / engine_read / engine_write / engine_analyze` 是唯一入口。Engine 用状态机管理生命周期：`Uninitialized → Loading → Ready ↔ Analyzing → Error`。
- **WorkspaceHandle（Rust）**：持有单个打开项目的所有后端状态（权限上下文、watcher、审计），替代分散的 `ACTIVE_PROJECT / SANDBOX / AUDIT_LOGGER` 全局变量。
- **ResourceLedger**：统一生命周期管理。所有有生命周期需求的后端服务（UnityEvent、LlmProxy、BgJobs、Mcp、Unity、Pty、Lsp、UiaWorker、Aura、MemoryBundle、Logging 共 11 个）实现 `LifecycleService` trait 并注册，退出时按序 drain（总预算 2s + 3s 强退）。
- **Workspace（前端）**：统一状态容器，替代 18+ 个模块级全局变量；原子化工作区切换（`old.deactivate()` → `Workspace.open()` → 注入）。

---

## 3. Harness Engineering 模式

HoloGram 将以下软件工程模式编排为统一的 Harness 体系：

### 3.1 约束治理 (Constraint Governance)

通过 `hologram.constraints.yaml` 定义不可逾越的架构边界：

```yaml
constraints:
  routing:        # L1-L5 耦合深度路由开关
    l5_irreversible: true   # L5 永远路由（不可关闭）
    l4_silent: true         # L4 静默破溃默认路由
  thresholds:     # 触发阈值
    blast_radius_max: 20        # 波及节点上限
    cross_community_tolerance: 0 # 跨社区边新增容忍
  allowlist:      # 白名单（不触发路由）
  denylist:       # 黑名单（含关键词的变量变更永远路由）
```

Agent 在执行文件编辑前必须经过 `preflight_check`，引擎根据图谱拓扑计算波及半径、跨社区影响、L4 穿透等指标，决定放行还是路由到人工确认。前端另有 `PreflightHookRegistry`（内存 fileIndex 即时计算，<0.1ms 零延迟），编辑前注入 ⚠️ 警告到工具结果顶部，Agent 无法忽略。

### 3.2 变更预演 (Change Preflight)

`preflight_check` 工具接受待修改文件列表，返回：
- **波及半径**：BFS 遍历下游依赖，给出影响树
- **风险等级**：low / medium / high / critical
- **共享变量影响**：哪些 dataflow 共享状态会被波及
- **时序边信号**：async trigger/await 链是否受影响

这是一个"改之前先看会炸哪里"的 Harness 模式，避免盲目修改高扇入符号。

### 3.3 沙箱隔离 (Sandboxed Agent Execution)

三层隔离机制：

**OS 层沙箱** (`os_sandbox.rs`，跨平台)：
- Windows：Job Object（子进程随父进程死亡，64 进程 / 1 GiB 内存上限；AppContainer 已移除）
- macOS：sandbox-exec；Linux：bubblewrap
- 所有 Engine 进程、Memory Bundle 进程纳入 OS 沙箱

**路径层沙箱** (`sandbox.rs`)：
- 路径 canonicalize + 边界校验，`resolve_read / resolve_write` 返回 `Allowed / Denied`
- 不再硬拒绝边界外路径——交给权限引擎路由到 Ask（降级策略）

**统一受限文件系统** (`confined_fs.rs`)：
- 所有文件 I/O 的统一 confine 层（100 MiB 读写上限、30s 超时、3 次瞬态重试、原子写）；"ACL"式路径控制实际由权限引擎承担

**Agent Worktree 隔离** (`agent_isolation.rs`)：
- `git worktree add --detach` 为每个 Agent 创建独立工作树
- 路径双向映射：forward（逻辑→物理）+ reverse（物理→逻辑），权限检查、shell cwd、git repo 路径全部经映射
- 完成后 cherry-pick 合并回主仓库；冲突时返回 diff 供人工处理
- TTL 30 分钟自动清理；`force_purge` 兜底；git 操作经 `isolation-queue.ts` 串行化

### 3.4 权限引擎 (Permission Engine)

v4 起为**两层自治架构**（Sandbox 降级，权限系统升级为 `PermissionContext`）：

```
has_permission_to_use_tool(ctx, agent_id) → PermissionResult
  ├── Allow           → 直接执行
  ├── Deny            → 拒绝并返回原因
  ├── Ask { danger }  → 路由到用户确认（critical 显示红色警告卡）
  └── Passthrough     → 交由引擎兜底
```

- **Tool trait** 七类实现：`ReadTool / EditTool / BashTool / GitTool / WebFetchTool / BrowserTool / DesktopTool`
- **规则**（`PermissionRules`）：system / project / session 三来源合并，持久化到 `permissions.json`；路径 glob、读写分类、危险操作标记
- **bash 启发式**（`permissions/bash.rs`，1237 行）：命令 tokenize + 危险命令清单
- **worktree 感知**：规则匹配时物理路径 reverse-map 回主仓库逻辑路径，`Edit("src/**")` 在隔离环境下同样生效
- **agent_id 显式传递**：所有涉路径命令接受 `_agent_id: Option<String>` 并 `.as_deref()` 传递，杜绝并行子 Agent 身份串扰

### 3.5 审计日志 (Audit Trail)

`AuditLogger` 记录所有 Agent 工具调用的完整审计轨迹（allowed / denied 条目），配合 `project_timeline` 工具提供按时间线回溯的分析历史。会话消息以 NDJSON 增量持久化（`session_append` → `.hologram/sessions/{id}.ndjson`）。

### 3.6 技能系统 (Hot-Loading Skills)

Agent 支持从 `.hologram/skills/<name>/SKILL.md` 热加载技能。技能格式为 YAML frontmatter + Markdown body，每次调用时重新加载（零依赖 frontmatter 解析器），无需重启即可新增技能。

### 3.7 Computer-Use（CDP 浏览器 + UIA 桌面，2026-08 Agent 优先改造）

两条通道共享同一套 Agent-first 交互范式：**snapshot/tree + ref 引用 → pattern 优先操作 → world-diff 反馈 → 分层授权 → 逐动作审计 + `[CODE]` 结构化错误**。

**browser（CDP，src-tauri/src/cdp/）**：受控 Chrome 启动/外部实例连接、按 agent 键控多账号会话（slot + 空闲租约）、snapshot（AX 优先）+ ref、console/network/dialog 观察、世界变化反馈、敏感目标单独 Ask、审计 jsonl。

**desktop（UIA，src-tauri/src/uia/）**：进程内 COM——`hologram-uia` 专用线程（MTA + catch_unwind + mpsc/oneshot + 15s 超时）独占全部 COM 对象；线程内树缓存（hwnd → generation + controls + 元素句柄），ref = 全量树下标，失效自动重建一次。

- **反馈闭环**：写动作返回 world-diff（窗口标题/焦点/value/toggle/滚动百分比 前后对比）+ IsPassword 掩码
- **读路径零打扰**：tree/find/read/wait 不抢前台不动光标；pattern 动作（Invoke/SetValue/Select/Expand/Scroll）同样无需前台
- **权限分层**（tools/mod.rs DesktopTool）：只读放行 → 窗口级授权（DesktopGrant，agent+hwnd 键控滑动 TTL 10min，接管 Ask 一次后 pattern 放行）→ 敏感目标（sensitive.rs 共享词表）每次 Ask → 物理输入路径每次 Ask + 全局输入租约 → screenshot 高隐私 Ask
- **DesktopInputLease**：SetCursorPos/SendInput/剪贴板/SetForegroundWindow 全进程串行化，拿不到回 `[UIA_LEASE_BUSY]` + 持有者（INVARIANTS #13）
- **通道路由**：desktop_probe 每窗口带 route 建议——chromium→cdp / UIA 探测≥3 interactive→uia / 自绘→vision
- **审计**：desktop 写动作逐条落 `hologram-desktop-audit-*.jsonl`（7 天轮转），desktop_audit 可查
- **错误码**：`[UIA_WINDOW_NOT_FOUND/STALE_REF/NO_PATTERN/TIMEOUT/LEASE_BUSY/ACCESS_DENIED/ARG_INVALID/INTERNAL]`，TS 侧 parseStructuredError 与 browser 共用
- **生命周期**：UiaService 注册 ResourceLedger（未用过不启动线程，退出 Quit + 带限 join）
- **e2e**：`HOLOGRAM_UIA_E2E=1` + 交互桌面会话（记事本真实窗口全流程）

---

## 4. 内置 Agent 系统

Agent 系统是 Harness 与 LLM 之间的桥梁，将上述工程模式自主地应用于实际编码任务。

### 4.1 Agent 循环

```
User Input → System Prompt + Tools → LLM Stream
  ↓ (流式解析)
StreamingToolExecutor (并发执行 tool calls, 支持 AbortSignal)
  ↓
Tool Results → 注入会话 → 下一轮 LLM Stream
  ↓ (循环直到模型给出最终回答)
```

核心特性：
- **流式工具执行**：不等整条 stream 结束，`tool_use` block 完成就立即 dispatch
- **并发执行**：同一轮的多个只读工具并发运行
- **输出截断**：单个工具输出上限 50KB / 2000 行，超出则头尾保留 + 中间省略
- **重试与退避**：可重试错误按指数退避重试，最多 3 次
- **Abort 传播**：executor 的每个 pending promise 与 AbortSignal 竞速，杜绝卡死的工具调用挂起循环
- **上下文压缩**：成本模型驱动（见 4.6）

### 4.2 多 Agent 编排

`SubAgentPool`（coordinator.ts）管理子 Agent 生命周期：
- **并发上限**：默认 5 个子 Agent 同时运行（队列 20）；**超时兜底**：默认 30 分钟 abort
- **两种模式**：`fork`（继承父上下文）/ `fresh`（干净启动）
- **异步 spawn**：`async: true` 立即返回 agentId，完成后经 MessageBus 发 `result` 消息通知父 Agent
- **独立 execState**：子 Agent 不互相 abort；async 模式不被用户下一条消息杀掉
- **隔离执行**：文件编辑在独立 git worktree 中运行，`agent_merge` 串行合并

**Agent 通信层**（`message-bus.ts`）：
- 有界 inbox + 背压控制（满了 drop，防 OOM）；peek + ack 模型；msgIndex O(1) 查找
- 拓扑策略注入（TreeTopology 默认 / Mesh / Star）；传输层可替换（当前 InProcess）
- 5 个通信工具：`agent_message / agent_reply / agent_ack / agent_inbox / agent_list`
- 消息持久化到 `.hologram/agents/{id}/inbox.json`（debounced flush 2 秒批量写）

**共享状态板**：
- `TaskBoard`：子 Agent 任务状态（status / filesTouched / diff），`BoardFileTrackingHook` 自动追踪写文件；合并后转 `merged`
- `DiscoveryBoard`：探索发现共享（TTL 2h，同 key 覆盖）
- 两者均**按 session 隔离**（`.hologram/{taskboard,discoveries}/{sessionId}.json`），防跨会话串扰

**生命周期管理**（`lifecycle-manager.ts`）：全局空闲判定 + worktree 泄漏检测（60s 巡检）+ TTL 清理 + 启动恢复（restore inbox/board + 孤儿检测 + 崩溃孤儿 worktree 清理）。

### 4.3 Plan 模式

`agent/plan/` 实现分层提醒工作流：
- 只读工具 + 写计划文件权限，`exit_plan_mode` 提交计划给用户审批（可带多方案 options）
- 图引擎自动注入影响面数据（读文件时显示下游依赖和脆弱度）
- 每 5 轮刷新完整工作流提醒

### 4.4 目标管理

`GoalManager` 将 Agent 从"一轮轮循环 + 正则标记"提升为显式生命周期对象：
- 目标状态：active → paused → completed / failed / cancelled
- 迭代计数与停滞检测；存储隔离于 `.hologram/goals/{id}/`，不与会话历史混淆；旧 GoalState 自动迁移

### 4.5 上下文记忆

| 层 | 实现 | 用途 |
|----|------|------|
| **会话记忆** | Agent session JSON（`.hologram/agents/{id}/`） | 当前对话上下文，支持压缩 |
| **项目记忆** | `MemoryManager` → `.hologram/memory/*.md` + 全局 `~/.hologram/global_memory/`，MEMORY.md 索引 + confidence 分级（fact/reference/background/suppressed） | 跨会话项目知识 |
| **Aura 记忆** | `aura_memory.rs` FFI 到 `aura.dll`（SDR + MinHash 语义召回） | 跨会话语义记忆，稀疏分布式表征 |
| **Memory Bundle** | 外部进程 `memory-bundle.exe` + 前端 HTTP 客户端（127.0.0.1:9600，Dockerized FirstBeat 记忆服务） | 进程隔离的记忆服务（ingest 已接线，health/analyze/recall/portrait 待集成） |

### 4.6 上下文压缩（成本模型驱动）

`compaction-model.ts` 以可测量成本模型决定何时压缩：

```
NetBenefit = |R|·c_in·(T-1) − |S|·c_out − L·avg_turn_cost
  R = 被替换消息, S = 摘要, T = 剩余轮次, L = 摘要后的轮次
```

- 压缩只作用于**发送载荷**，session 永为完整历史（发往 LLM 前截断）
- 分块摘要 + 机械兜底 + 摘要模型自动选择；`CompactionEvent` 结果类型：summary / digest / truncated / stuck
- 摘要模型自动选择（模型目录动态解析，无 200K 硬封顶）

### 4.7 Hooks 系统

两类 Hook 在 Agent 循环中注入 Harness 逻辑：

**Post-Tool Hooks**（工具执行后注入上下文，`HookRegistry`）：
- `GraphContextHook`：读文件/搜索/glob 后自动注入符号概览（<800 字符，结果接近 50KB 截断上限时跳过）
- `BoardTrackingHook`：write/edit 后追踪到 TaskBoard
- `StateReadHook`：每轮开始注入 Git 状态、诊断信息

**Preflight Hooks**（工具执行前拦截，`PreflightHookRegistry`）：
- `GraphPreflightHook`：编辑前检查图谱波及范围（内存 fileIndex，零延迟）
- `StatePreflightHook`：检查 LSP 诊断状态

### 4.8 LLM Provider 抽象

统一 `Provider` trait 抹平各厂商 API 差异：
- `provider/` 目录：`types.ts`（统一 Message / ToolCall / Chunk 类型）+ `anthropic.ts` + `openai.ts`（兼容 Ollama）+ `catalog.ts` 模型目录合并层 + `thinking.ts`（档位 → 厂商 wire 参数唯一事实源）
- **9 个静态模型目录** JSON（73 个模型）：anthropic / openai / moonshotai / qwen / deepseek / glm / minimax / ollama / opencode
- **动态模型发现**：`fetchModels()` 拉取 `/models`（OpenAI）/ `/v1/models`（Anthropic）并合并，静态目录同 ID 优先（元数据更丰富）
- **thinking 档位适配（EffortVendor）**：Anthropic budget_tokens（low4k/medium8k/high16k/max32k）、DeepSeek reasoning_effort（high/max）、OpenAI 官方 low/medium/high
- **本地反向代理**（`llm_proxy.rs` + `transport.ts`）：loopback-only HTTP 代理（127.0.0.1:14570）转发 LLM 请求并强加 CORS 头，SSE 逐块透传；`spawn_llm_proxy` 不 join 防启动挂起，停机标志保证退出干净
- 流式 chunk 类型：Text / Reasoning / ToolCallStart / ToolCall / Usage / Done / Error；支持 reasoning_content round-trip

### 4.9 Agent 工具体系

模型可见工具已收敛为领域工具（`src-ui/src/agent/tools/domains.ts` 的 `DOMAIN_SPECS`）：

- **领域工具**：`fs / shell / git / search / web / agent / task / memory / browser / desktop / graph / ops / lsp`，加常驻 `ask_user / Skill / wait / enter_plan_mode / exit_plan_mode`。
- **图谱三域**：`graph`（24 个只读动作：symbols/neighbors/impact/preflight/cycles/…）、`ops`（analyze/validate/health/status/timeline/rename/import_scip）、`lsp`（resolve_call/infer_type/implementations/references）。底层仍是引擎 36 schema / 默认 35 的 MCP 工具。
- **旧细粒度名**（`search_symbols`、`run_shell`、`write_file`、`git_*`、`agent_spawn` 等）保留在 `ToolRegistry` 但 `hide()`；模型调用由 `retireRedirect` 拦截并返回 `[已淘汰] → 领域动作` 重定向。内部代码/测试仍可直调。
- **新工具必须 `defineTool` + zod v4**：一个 schema 同时产出 JSON Schema、运行时校验和 `z.infer` 类型化参数；meta key（`_forceGate` / `_callId` / `_agent_id`）经 `.passthrough()` 透传。
- 新增领域动作须同步 `DOMAIN_SPECS` + `collectHiddenToolNames()` + 测试 + `AGENTS.md`。

### 4.10 Agent 运行时收敛（agent-core-convergence Phase 0–6，已并入 main）

2026-08 的收敛工程把自有运行时的生命周期/会话契约全部原语化并门禁化（详见 `docs/plans/agent-core-convergence/`）：

- **声明式装配（Phase 6）**：`agent/blueprint.ts` 的 `AgentBlueprint` capability 表驱动装配——新增模型工具/hook 走 capability 组合，**`AgentConfig` 冻结 31 字段**不再扩张；capability 表序 = 工具面字节契约（DeepSeek 前缀缓存与 effective 快照依赖此序）；teardown 走 `ctx.effect`
- **会话事件溯源（Phase 5）**：`session-log.ts` 事件日志 + session 变异三入口（`_appendMessage` / `_replaceSession` / `_retractSessionRange`）；工具折叠逻辑同步 `derivePayload`
- **生命周期原语（Phase 1–4）**：`Disposer` / `startOwned` / `DisposerBag`（`Workspace._bag`）+ workspace-scope epoch（`getWorkspaceEpoch()` / `bumpWorkspaceEpoch()`）——资源获取即登记进 bag，工作区切换/退出只调 `_bag.dispose()` + epoch bump，杜绝跨项目串台
- **门禁**：`npm run verify:convergence`（T0 静态断言 + 8 个 frozen baseline 对拍）失败即返工；record 需显式 `CONVERGENCE_RECORD=1`，baseline 变更走审批

---

## 5. 代码图谱分析引擎

引擎是整个 Harness 体系的数据基础，将源代码转化为可查询的依赖拓扑图。

### 5.1 统一 Engine API

`engine/src/engine/mod.rs` 用单一 `Engine` 结构体替换了分散全局变量（CACHED_GRAPH / GRAPH_STORE / ANALYZE_LOCK）：

- **状态机**：`Uninitialized → Loading → Ready ↔ Analyzing → Error`，UI 据此渲染
- **并发**：`RwLock` 读写分离；timeline 用专用 SQLite 连接（永不阻塞图锁）
- **取消令牌**：新 analyze() 抢占旧运行（阶段边界中止），"重新分析"按钮秒响应
- **panic 守卫**：`catch_unwind` 包裹流水线，任何 panic 都重置状态 + 释放锁，杜绝卡死在 Analyzing
- **工作区切换**：旧 watcher 停止 → 新 store 打开 → watcher 重启
- **增量更新**：`engine_try_incremental` 先试增量（IncrementalUpdater），失败回退全量

### 5.2 分析流水线

`pipeline/` 拆为 discovery → parser → runner：

| 阶段 | 说明 |
|------|------|
| 1. 文件发现 | 按 GRAMMAR_LOADER 支持的扩展名遍历项目 |
| 2. 分批并行解析 | **200 文件/批** rayon 并行解析，串行合并（v3 批式：内存有界、无锁、线性合并；64K 文件不炸内存） |
| 3. 解析缓存 | file_path → (source, tree) 传递给后续合成阶段（消除 3 次重复 walkdir） |
| 4. Cross-File Resolution | 解析跨文件的 import / call 关系（含裸名目标，GraphMerger 用 add_edge_unchecked） |
| 5. Coupling Analysis | 计算 L1-L4 耦合深度 |
| 6. Framework Routes | 24 个框架的路由检测 |
| 7. Dynamic Dispatch | 多态调用的合成边 + React 组件 / JSX + Vue template + DI/反射 + 动态 import + eval + 跨语言调用 + bridge/rpc 间接调用 |
| 8. Dataflow Synthesis | 函数级读写分析 + 共享状态 + async trigger/await 链 |
| 9. Community Detection | Leiden（扁平）+ Louvain（层级）社区检测 |
| 10. DB Save | 持久化到 MemoryIndex + SQLite + 向量索引 |

特性：进度报告、AtomicBool 取消、每阶段计时（StageTiming）、LSP 后台预热。

### 5.3 图谱数据模型

**节点** (9 种类型)：`Symbol | Function | Class | Module | File | Interface | Variable | Medium | Temporal`

每个节点携带：id, name, kind, location, snippet（供向量搜索的源码片段）, properties, in/out_degree, 3D position, community_id

**边** (12 种类型)：`Imports | Calls | Inherits | Defines | Reads | Writes | Shares | Triggers | Awaits | Sequences | Usage | Throws`

每条边携带：coupling_depth (L1-L4), cross_file 标记, temporal_delay_sec, lsp_resolved 标记, is_synthesized 标记（启发式合成边）, metadata（溯源追踪）

### 5.4 语义向量索引（MiniLM ONNX）

`engine/src/vector/` 实现代码语义搜索：

- **双后端自动选择**（`embed.rs`）：
  1. **MiniLM**（`minilm.rs` + `wordpiece.rs`）—— sentence-transformers/all-MiniLM-L6-v2 ONNX 模型（384 维），经 `ort` crate 动态加载项目自带的 `onnxruntime.dll` + 模型目录 `src-tauri/models/all-MiniLM-L6-v2/`，语义区分度高
  2. **n-gram 哈希**—— 零依赖兜底，词法相似性
- **索引存储**：usearch HNSW（Cos 度量），`slots.json` 记录节点 id 列表
- **一致性保障**：slots.json 带嵌入后端标识，后端不匹配的旧索引自动判废（防跨嵌入空间垃圾结果）；slots 数与索引向量数必须一致；原子落盘（tmp + rename）
- **进程级缓存**：mtime 变化自动失效重载；重建并发守卫 `BUILD_RUNNING`
- 索引位置：`.hologram/vectors.usearch`；后台线程构建（流水线 7.5 阶段）
- **暴露方式**：挂在前端 `search_code` 工具的 `vector_hits` 字段（与文本/FTS 命中合并返回），并带 `vector_backend` 标识

### 5.5 分析能力

| 模块 | 能力 |
|------|------|
| `coupling.rs` + `coupling_report.rs` | L1-L4 四级耦合深度计算 + 报告 |
| `cycles.rs` | 循环依赖检测（all / data / llm 模式） |
| `dataflow_engine.rs` + `dataflow_synthesis.rs` | 函数级变量读写分析、跨函数共享状态、async trigger |
| `flows.rs` | 数据流聚合查询 |
| `fragility.rs` | 结构脆弱性排行（扇入/扇出 + 耦合深度） |
| `blindspots.rs` | 架构盲区扫描（L4 穿透、未锁并发、LLM 反馈环） |
| `dynamic_boundaries.rs` | 动态边界检测 |
| `policy_check.rs` | 约束规则检查（配合 constraints.yaml） |
| `graph_stats.rs` + `explore.rs` | 图统计 + NL 聚合查询 |
| `bridge_rpc.rs` | bridge / rpc 间接调用补全 |
| `community/` | Leiden + Louvain 社区检测 |
| `vector/` | 语义向量索引（usearch + MiniLM ONNX） |

### 5.6 语言适配

通过 `LanguageAdapter` trait 抽象，支持动态语法加载：

27 种语言通过 tree-sitter 静态链接（其中 18 个适配器族有专用 .scm 结构/数据流查询，js/ts/tsx 一族、c/cpp 各一族）：Python, TypeScript, TSX, JavaScript, Go, Rust, Java, C, C++, Ruby, Lua, C#, PHP, Swift, Dart, Scala, OCaml, Haskell, R, Nix, Bash, HTML, CSS, YAML, Zig, Elixir, Erlang（JSON 语法在 `grammar.rs` 中注释禁用——数据文件不解析）

动态语法通过 `grammar_loader.rs`（`engine::GRAMMAR_LOADER`）+ `libloading` 加载 DLL，无需重新编译即可扩展语言。`engine_supported_extensions()` 始终与已装 DLL 同步。

### 5.7 LSP 集成

`LspManager` 管理原生 LSP 服务器（rust-analyzer / gopls / pyright 等），提供 `resolve_call`（多态分发解析）、`infer_type`、`find_implementations`、`find_references`。

**手写协议纪律**（见 INVARIANTS.md #6）：LSP 客户端是自研 JSON-RPC 帧解析（非现成库）——
- 帧边界按**字节流扫描定界**，不能用 read_line（JSON body 内可能含 \n）
- 解析失败时把原始字节带进错误（`raw=...`）便于诊断
- 超时 30s → 5s 快速失败；回复服务器请求；死壳自愈
- 教训：手写协议必须配协议级测试（模拟服务器发粘连帧/异常帧）

### 5.8 增量更新与存储层

**增量更新**：`IncrementalUpdater` 监听文件变更（`notify` crate），仅重新解析变更文件并增量更新图谱（解析缓存复用），失败自动回退全量。

**双层存储**：
- **MemoryIndex**：CSR 格式内存图索引，高并发读
- **SQLite**：持久化（WAL），FTS5 全文搜索，timeline 事件

**压力测试**：`stress.rs` 合成项目生成器 + 基准运行器，4 级规模（500 / 2000 / 10000 / 50000 文件），输出每阶段计时和吞吐量。

---

## 6. MCP 对外服务

Engine 作为独立 MCP Server 运行，通过 JSON-RPC over stdin/stdout 对外暴露工具（注册表共 36 个 schema，默认暴露 35 个——含 `symbol_history` 在内的全部 36 个需 `HOLOGRAM_MCP_TOOLS=*`）。

### 6.1 接入方式

```json
// .mcp.json
{
  "mcpServers": {
    "hologram": {
      "command": "./engine/target/release/hologram-engine",
      "args": ["serve", "--project-root", "."]
    }
  }
}
```

复制到 Claude Code / Cursor / 任意 MCP 客户端即可使用，零额外配置。

### 6.2 工具分类

| 分类 | 工具 |
|------|------|
| **图导航** | `explore_deps`（NL 聚合查询，首选项）, `search_symbols`, `get_neighbors`, `inspect_symbol`, `find_dep_path`, `graph_summary` |
| **社区/结构** | `get_community`, `cluster_report`, `grpc_services` |
| **影响分析** | `trace_impact`, `preflight_check`, `graph_diff` |
| **架构分析** | `fragile_modules`, `detect_cycles`, `thread_conflicts`, `coupling_report`, `arch_blindspots`, `check_boundaries`, `find_unused` |
| **数据流（语法级启发式）** | `trace_dataflow`, `async_edges`, `list_flows`, `get_flow`, `get_affected_flows` |
| **LSP** | `resolve_call`, `infer_type`, `find_implementations`, `find_references` |
| **操作/时序** | `analyze_project`, `validate_project`, `project_health`, `rename_symbol`, `import_scip`, `project_timeline`, `engine_status` |

### 6.3 降级策略

工具执行遇到错误时返回 `Degraded` 响应（非 JSON-RPC error），包含：
- `guidance`：给 LLM 的引导信息
- `fallback`：降级建议
- `_stalenessBanner`：文件变更过期提醒（`staleness.rs`）

这确保 MCP 客户端始终收到可操作的信息，而非硬错误。

---

## 7. 生命周期与进程管理（Tauri Shell）

### 7.1 RPC 单一入口

`rpc.rs` 一个 `#[tauri::command] rpc(method, params)` + 149 个方法分支是全部前端能力的单一 IPC 入口。分类（由生成物 `docs/agents/frontend-rpc-contract.md` 实测为准，`scripts/gen-rpc-contract-md.cjs` 再生）：Engine 调度(3)、Graph(5)、Git(16)、文件系统(12)、搜索(2)、Web(2)、CDP 浏览器控制(39，含 desktop 2)、Shell(10，含协议桥 3)、编辑器(1)、身份认证/权限(6)、Agent 隔离(6)、外部服务(6)、Hologram 遗留(3)、工作区(3)、会话持久化(2)、约束(2)、数据流(3)、Aura 记忆(7)、PTY(4)、LSP(2)、desktop/UIA(17：probe/screenshot/tree/find/read/wait/click/right_click/type/select/expand/scroll/keys/activate/window_shot/audit/status)。

### 7.2 ResourceLedger（统一生命周期）

`lifecycle.rs`：`LifecycleService` trait + `ResourceLedger` 中央注册表。注册的服务：UnityEvent、LlmProxy、BgJobs、Mcp、Unity、Pty、Lsp、UiaWorker、Aura、MemoryBundle、Logging 共 11 个。退出时按注册顺序 drain，每服务带截止时间（Clean / Forced / Failed / NotApplicable 状态）。替代 main.rs Destroyed 里分散的清理逻辑 + `process::exit(0)`。

### 7.3 凭证与外部进程

- **credential.rs**：加密凭证存储（libloading FFI 模式，同 aura_memory），`credential_store/get/delete/clear` + `permission_ask_response` 校验 allow/remember/rule_to_add/rule_behavior
- **McpManager**：Engine 子进程管理——ready 信号等待（最长 600s，大项目布局计算）、崩溃追踪（60s 内 3 次 → 永久降级 CLI）、Job Object 随父退出
- **memory-bundle.exe**：独立进程，主进程 setup 时 spawn，ResourceLedger 关停
- **Unity（可选）**：3D 可视化后端（事件服务器），`unity_manager.rs` 管理

---

## 8. 技术栈

### Engine (Rust)

| 依赖 | 用途 |
|------|------|
| `tree-sitter` + 27 语言语法 | 多语言 AST 解析（18 种专用结构查询 + 通用兜底） |
| `libloading` | 动态语法 DLL + Aura SDK FFI 加载 |
| `rusqlite` (bundled) | SQLite 持久化 + FTS5 全文搜索 |
| `parking_lot` | 高性能 RwLock |
| `rayon` | 并行文件解析 |
| `usearch` | 语义向量索引（ANN 搜索） |
| `ort` + onnxruntime.dll | MiniLM ONNX 推理（语义嵌入） |
| `notify` | 文件系统监听（增量更新） |
| `serde` / `serde_json` / `serde_yaml` | 序列化 |
| `tracing` + `tracing-subscriber` | 结构化日志 |
| `chrono` | 时间线记录 |
| `mimalloc` | 内存分配器 |
| `regex` / `walkdir` | 模式匹配 / 文件遍历 |

### Tauri Shell (Rust)

| 依赖 | 用途 |
|------|------|
| `tauri` 2.x (feature "wry") | 桌面应用框架 |
| `tauri-plugin-dialog` / `tauri-plugin-updater` / `tauri-plugin-window-state` | 对话框 / 自动更新 / 窗口状态 |
| `portable-pty` | PTY 终端管理 |
| `ureq` / `url` / `regex` / `glob` | HTTP / URL / 模式 |
| `libloading` | Aura SDK + 凭证库 FFI 加载 |
| `tokio` (sync/time) | 异步通道、超时 |
| `hologram-engine` (path 依赖) | 引擎集成 |
| `base64` | 编码 |

### 前端 (TypeScript / React 19)

| 依赖 | 用途 |
|------|------|
| `react` 19.x + `react-dom` | UI 框架（React 迁移完成，`src/app/` 单根） |
| `zustand` 5.x | 状态管理（react-hook stores + vanilla stores） |
| `three` / `@types/three` | 3D 图谱渲染（WebGL） |
| `@webgpu/types` | WebGPU 类型定义（布局计算） |
| `monaco-editor` | 代码编辑器（lazy-loaded） |
| `@fontsource/*` | 自托管字体（Fraunces / JetBrains Mono / Noto / LXGW） |
| `react-markdown` + `remark-gfm` | Markdown 渲染（marked/DOMPurify 路径已删除） |
| `highlight.js` | 代码高亮 |
| `zod` 4.x | 工具 schema 单一事实源（`defineTool`） |
| `gpt-tokenizer` | token 计数（压缩成本模型） |
| `@tanstack/react-virtual` | 虚拟列表（消息长列表） |
| `vite` 6.x | 构建工具 |
| `vitest` + `jsdom` | 测试框架 |
| `biome` | 代码格式化 + lint |
| `typescript` 6.x | 类型系统 |

### Provider 抽象

| Provider | 实现 |
|----------|------|
| Anthropic | `provider/anthropic.ts`（Claude 系列，支持 thinking） |
| OpenAI | `provider/openai.ts`（GPT 系列 + Ollama 兼容） |
| 模型目录 | 9 个 JSON 静态目录（73 模型）+ `/models` 动态发现合并 |

### 外部组件

| 组件 | 用途 |
|------|------|
| `aura.dll` (AuraSDK) | SDR + MinHash 语义记忆（FFI 加载） |
| `memory-bundle.exe` | 进程隔离的记忆服务（FirstBeat） |
| `onnxruntime.dll` + MiniLM 模型 | 本地语义嵌入（384 维） |
| Unity (可选) | 3D 可视化后端（事件服务器） |
| LSP 服务器 | 原生类型解析（rust-analyzer / gopls / pyright 等） |

---

## 9. 项目结构

```
HoloGram/
├── engine/                      # 代码图谱分析引擎 (Rust 库 + CLI)
│   ├── src/
│   │   ├── engine/              # 统一 API (Engine 结构体 + 状态机 + GRAMMAR_LOADER + watcher + pipeline)
│   │   ├── graph/               # 图数据模型 (Node, Edge, Graph, merge, query)
│   │   ├── adapter/             # 语言适配器 (LanguageAdapter trait + 27 静态语法 + 动态加载)
│   │   ├── analysis/            # 分析模块 (coupling, cycles, dataflow, fragility, blindspots, flows, explore)
│   │   │   ├── framework_routes/frameworks/  # 24 个框架路由检测
│   │   │   ├── di_reflection/   # DI/反射检测 (多语言)
│   │   │   ├── dynamic_dispatch*.rs  # 动态分发/React/Vue 合成边
│   │   │   └── bridge_rpc.rs    # bridge/rpc 间接调用
│   │   ├── community/           # 社区检测 (Leiden + Louvain)
│   │   ├── pipeline/            # 流水线 (discovery / parser / runner 分批并行)
│   │   ├── routing/             # 框架路由检测
│   │   ├── storage/             # 存储层 (MemoryIndex CSR + SQLite)
│   │   │   └── incremental.rs   # 增量更新器
│   │   ├── vector/              # 语义向量索引 (minilm ONNX + ngram + wordpiece + usearch)
│   │   ├── tools/               # MCP 工具注册表 + 处理器 (36 schema / 默认暴露 35)
│   │   ├── mcp.rs               # MCP JSON-RPC 服务端
│   │   ├── lsp_manager.rs       # 原生 LSP 管理 (手写帧协议)
│   │   ├── stress.rs            # 压力测试合成项目生成器
│   │   └── lib.rs               # 库入口
│   └── Cargo.toml
│
├── src-tauri/                   # Tauri 桌面 Shell (Rust)
│   ├── src/
│   │   ├── commands/            # 16 个命令模块 (engine_dispatch/graph/shell/filesystem/git/isolation/…)
│   │   ├── permissions/         # 权限引擎 (mod: PermissionContext + rule + bash/filesystem/git/web/safety)
│   │   ├── tools/               # Tool trait 实现 (Read/Edit/Bash/Git/WebFetch/Browser/Desktop)
│   │   ├── lifecycle.rs         # ResourceLedger + LifecycleService (11 个服务)
│   │   ├── workspace.rs         # WorkspaceHandle (权限上下文 + watcher + 审计)
│   │   ├── agent_isolation.rs   # git worktree 生命周期管理
│   │   ├── mcp_manager.rs       # MCP 子进程管理
│   │   ├── sandbox.rs           # 路径沙箱 (resolve_read/write)
│   │   ├── confined_fs.rs       # 统一受限文件系统 (读写上限/超时/重试/原子写)
│   │   ├── os_sandbox.rs        # OS 层沙箱 (Job Object/sandbox-exec/bubblewrap)
│   │   ├── aura_memory.rs       # Aura SDK FFI 桥接
│   │   ├── credential.rs        # 加密凭证存储
│   │   ├── pty_manager.rs       # PTY 终端管理
│   │   ├── unity_manager.rs     # Unity 集成
│   │   ├── llm_proxy.rs         # LLM 本地反向代理 (绕 CORS, SSE 透传)
│   │   ├── audit.rs             # 审计日志
│   │   ├── rpc.rs               # 单一 RPC 入口 (134 个方法)
│   │   └── main.rs              # Tauri 应用入口 (模块声明权威清单)
│   └── Cargo.toml
│
├── src-ui/                      # 前端 (TypeScript / React 19)
│   ├── src/
│   │   ├── app/                 # React 根 (App.tsx + CommandBar/Palette + DockRail + StatusBar + chat/)
│   │   ├── agent/               # Agent 系统 (50 文件)
│   │   │   ├── agent.ts          # Agent 主循环
│   │   │   ├── coordinator.ts    # SubAgentPool (并发/超时/中断)
│   │   │   ├── message-bus.ts    # 多 Agent 通信层 (inbox/ack/背压)
│   │   │   ├── task-board.ts     # 任务共享状态板
│   │   │   ├── lifecycle-manager.ts  # 泄漏检测 + TTL 清理
│   │   │   ├── streaming-executor.ts  # 流式工具执行器 (AbortSignal)
│   │   │   ├── tool.ts           # Tool 接口 + ToolRegistry
│   │   │   ├── blueprint.ts      # AgentBlueprint capability 表驱动装配 (Phase 6)
│   │   │   ├── session-log.ts    # SessionLog 事件溯源日志 (Phase 5)
│   │   │   ├── lifecycle.ts      # Disposer 原语 (Phase 1/4) + Workspace._bag (DisposerBag)
│   │   │   ├── hooks.ts          # Hook/PreflightHook 系统
│   │   │   ├── goal-manager.ts   # 目标生命周期管理
│   │   │   ├── skills.ts         # 技能热加载
│   │   │   ├── memory.ts / aura-memory.ts / memory-bundle-client.ts  # 记忆三层
│   │   │   ├── compaction-model.ts  # 上下文压缩成本模型
│   │   │   ├── runtime/          # AgentRuntime + AgentBuilder (零 UI 依赖)
│   │   │   ├── plan/             # Plan 模式
│   │   │   └── tools/            # coding/communication/discovery/merge/request/subagent
│   │   ├── provider/           # LLM Provider 抽象 + catalog (9 模型目录/73 模型 + 动态发现) + thinking 档位适配
│   │   ├── ui/                 # UI 层 (~75 文件: 图渲染/聊天/zustand stores/EventBus)
│   │   │   ├── react/           # React 组件 (16 文件: AgentsPanel/ChatMessages/…)
│   │   │   ├── graph*.ts        # Three.js 星图渲染管线 (scene/renderers/shaders/layout)
│   │   │   ├── events.ts        # EventBus (冻结——新 app 代码禁 import)
│   │   │   └── *-store.ts       # Zustand stores (createScopedStore 注册表模式)
│   │   ├── workspace.ts        # Workspace 统一状态容器 (替代 18+ 全局变量)
│   │   ├── workspace-scope.ts  # workspace epoch 代际防护原语
│   │   ├── bridge.ts           # Tauri IPC 桥接
│   │   ├── lifecycle/          # WorkspaceStateMachine + timeout
│   │   └── settings.ts         # 设置与凭证
│   └── package.json
│
├── docs/                        # 活动文档（入口 docs/README.md；agents/adr/design/plans/research）
├── docs/archive/                # 已竣工施工稿与历史设计，勿作现状依据
├── hologram.constraints.yaml   # 约束配置
├── ARCHITECTURE.md             # 本文档
├── INVARIANTS.md               # 踩碎必炸的规则 (改 ui/agent 前必读)
├── CONVENTIONS.md              # 编码约定 (状态管理/通信/命名)
└── build.cmd                   # 构建脚本
```

---

## 10. 关键设计决策

### 10.1 为什么 Engine 是独立二进制

Engine 编译为独立的 `hologram-engine.exe`，既可作为 Tauri 的子进程运行，也可独立 `serve` 作为 MCP 服务器。这保证了：
- 外部 MCP 客户端无需安装桌面应用即可使用图谱能力
- Engine 崩溃不影响 Tauri Shell，Shell 可重启 Engine
- Engine 的性能不受 Tauri 的 WebView 开销影响

### 10.2 为什么 Tauri 只做转发

Tauri Shell 的 `rpc.rs` 有 134 个方法但几乎不含分析逻辑。所有图谱操作转发给 Engine，Shell 专注于进程管理、权限削决、沙箱隔离。这种分离使得：
- 权限引擎在 Engine 不可用时仍然生效
- Engine 的测试可以完全不涉及 Tauri
- 非 Tauri 的 Engine 消费者（纯 MCP 客户端）也能获得完整图谱能力

### 10.3 为什么 Agent 在前端

Agent 循环在 TypeScript 中运行（而非 Rust），因为：
- LLM streaming 在 JS 生态中更成熟
- UI 更新与 Agent 循环同线程，避免跨语言状态同步
- 工具调用的 UI 反馈（权限卡片、进度条）天然低延迟

后端通过 `typedRpc()` 单一契约入口提供所有能力，前端通过 `ToolRegistry` 动态组装工具列表（图谱工具从 MCP `tools/list` 动态加载，编码/领域工具静态注册）。

### 10.4 为什么用 git worktree 做 Agent 隔离

相比虚拟机或容器，git worktree：
- 零开销：共享同一仓库的 .git，只创建工作目录
- 原生合并：cherry-pick 提供标准的三方合并
- 可审计：worktree 的每个 commit 都是审计点
- 冲突安全：合并失败时返回 diff，不破坏主仓库状态

### 10.5 为什么状态全部走 Zustand store + createScopedStore 注册表

（INVARIANTS.md #1）模块顶层全局变量 = 跨面板串流。面板级 store（messages/session/panel/input）统一走 `createScopedStore`（`src-ui/src/ui/scoped-store.ts`）：

```
const scoped = createScopedStore('__hologram_xxx_stores__', createImpl);
export const getXxxStore = scoped.getStore; // 按 storeId 取实例
```

app 级单例（shell/dock/overlay）用普通 `create()`。新状态必须走注册表或单例 store，否则多面板/多会话共享全局状态必出 bug（已炸 6 次）。

### 10.6 为什么 ui/events.ts 冻结

EventBus 只覆盖不到一半通信，存在 5 个孤儿 emit、三层通信混用。新 `src/app/` 代码禁止 import `ui/events.ts`，UI 状态只走 Zustand stores；Agent 层内部用新 MessageBus（多 Agent 通信，带背压）。迁移完成后 EventBus 退役。

### 10.7 为什么压缩只作用于发送载荷

（commit eadd2e0）session 永为完整历史，压缩只在发往 LLM 前对载荷执行。这保证 UI 显示、恢复、重放永远基于完整上下文，压缩决策可逆且可度量（成本模型），避免"压缩后上下文永久丢失"的不可逆破坏。

---

## 11. 测试与验证基线

| 层 | 命令 | 规模 |
|----|------|------|
| Engine | `cd engine && cargo test` | 697 用例（lib 669 + bin 27 + doc 1；696 passed / 1 ignored；状态机/取消/增量/向量/盲点合成/图合并） |
| Tauri Shell | `cd src-tauri && cargo test` | 322 用例（bin 308 + 集成 14，全绿；pwsh 冒烟在无 pwsh 7 的环境自动跳过） |
| 前端 | `cd src-ui && npx vitest run` | 1201 用例 / 116 文件（1200 passed / 1 skipped；首次全量在并行构建环境下偶发 1 失败，重跑通过） |
| 前端契约 | `cd src-ui && npm run verify:convergence` | T0 静态 + 8 baseline 对拍 |
| Agent 运行时 | 同上 + `agent/blueprint.ts` capability 表 | AgentConfig 冻结 31 字段，T0 断言 |
| 前端构建 | `cd src-ui && npm run build` | tsc --noEmit + vite build 零错误 |
| 引擎构建 | `cd engine && cargo build` | CI 强制 -D warnings 零警告 |
| 全量 | `cd src-tauri && cargo tauri build` | 发布构建 |

CI（`.github/workflows/ci.yml`）只做编译+测试，不可修改。
