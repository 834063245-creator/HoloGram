# Agent 驱动数据流追踪方案（v2）

> 2026-07-01 · HoloGram v5.x · 基于 v1（2025-07-15）全量修订

---

## 现状

| 能力 | 状态 | 说明 |
|------|------|------|
| 结构引擎 (tree-sitter) | ✅ 常驻 | 文件变更自动触发，产出全量 AST 图，存 MemoryIndex + SQLite |
| 数据流引擎 (按需) | ✅ 按需 | Agent 调 `hologram_dataflow` 时单文件解析，18 语言，产出 per-function reads/writes + cross-function shared state |
| MCP 工具集 | ✅ 27 工具 | 含 search / node / neighbors / impact / dataflow / thread_conflicts / preflight / explore |
| SQLite | ✅ | `hologram.db`，含 nodes / edges / timeline_events / meta 表 |
| Git 集成 | ✅ | git_diff / git_log / git_status |
| 数据流卡片 | ✅ | chat 内 `hologram_dataflow` 工具结果自动渲染为结构化流卡片（reads/writes 标签 + sequence chain + shared state） |
| **数据流面板** | ❌ 待建 | 独立浮动窗口，管理 trace 完整生命周期 |
| **trace 持久化** | ❌ 待建 | dataflow_traces 表 + save/query/list/delete/verify 工具 |

---

## 核心理念

**不是"全自动建图"，也不是"Agent 手工描边"。**

是 **"Agent 自动追踪 → 结构化落盘 → 交叉验证 → 持久复用"**。

用户只给 resource name + 描述，Agent 全自动用现有工具追完整条链路，产出一条带溯源、测试、置信度的结构化 trace，存进 SQLite，之后一键查询。

---

## 与自动化数据流引擎的关系

```
┌──────────────────────────────┐  ┌──────────────────────────────┐
│  hologram_dataflow (已有)     │  │  Agent 建 trace (本方案)      │
│  ────────────────────────────│  │  ────────────────────────────│
│  • 按需、单文件、瞬间         │  │  • Agent 驱动、多文件、端到端 │
│  • 纯静态 tree-sitter 查询    │  │  • 语义理解 + 动态模式推理    │
│  • 回答：这个函数读写了什么    │  │  • 回答：鉴权数据怎么从请求    │
│    变量？谁跟谁共用状态？     │  │    一路流到数据库的？          │
│  • 18 语言，零配置             │  │  • 产出一条可复用的 trace      │
│  ────── 互补，不竞争 ──────   │  │  ────────────────            │
│  快速诊断、Agent 工具链一环    │  │  关键路径深度分析              │
└──────────────────────────────┘  └──────────────────────────────┘
```

Agent 建 trace 时可以（也应该）调 `hologram_dataflow` 作为辅助验证——拿引擎输出跟自己的推理交叉比对。

---

## 建筑架构

### 数据流面板（浮动窗口）

```
┌──────────────────────────────────────────────────────────┐
│  [Graph 3D]  [Chat]  [Editor]  [Dataflow]  ← 新 panel    │
│                                                          │
│  ┌─ 工具栏 ───────────────────────────────────────────┐  │
│  │ [+ 新建追踪]  [🔄 刷新列表]  [🔍 搜索 resource...]   │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ 左侧：trace 列表 ────┐  ┌─ 右侧：trace 详情 ───────┐  │
│  │                       │  │                          │  │
│  │ ● logBuffer      ✅   │  │ trace_id: logBuffer_v1   │  │
│  │   UI 日志缓冲流       │  │ resource: logBuffer      │  │
│  │   TS · 4/4 passed    │  │ status: active           │  │
│  │                       │  │                          │  │
│  │ ● auth_flow      ⚠️   │  │ ┌─ 数据流图 ─────────┐  │  │
│  │   鉴权链路追踪        │  │ │                    │  │  │
│  │   TS · 2/3 passed    │  │ │ login → hash → db  │  │  │
│  │                       │  │ │         ↓          │  │  │
│  │ ● config_loader  ❌   │  │ │     session_store  │  │  │
│  │   配置热加载流        │  │ │                    │  │  │
│  │   Go · 0/0 wip       │  │ └────────────────────┘  │  │
│  │                       │  │                          │  │
│  │                       │  │ confidence: verified     │  │
│  │                       │  │ [✏ 编辑] [🔁 重验证]    │  │
│  │                       │  │ [🗑 删除]                │  │
│  └───────────────────────┘  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**交互流：**

1. 用户点 `+ 新建追踪` → 弹出对话框填 resource name + 一句话描述
2. 面板创建专用 `Agent(dataflow)` 实例，注入构造好的 prompt：*"追踪 `<resource>` 的完整数据流：`<描述>`。搜索所有引用，读取源文件，交叉验证，写测试，完成后调用 dataflow_save 落盘。"*
3. 专用 Agent 在独立 context 中执行，面板显示步骤日志（非完整对话）
4. Agent 调 `dataflow_save` 落盘后 → 面板左侧列表自动刷新

**不在主 chat 里执行。** 专用 Agent 的 tool call / result 对不污染主对话 context。

### 数据流卡片复用

chat 中的 `formatDataflowCard()` 渲染 `hologram_dataflow` MCP 工具的结果。面板右侧详情区和 chat 共用同一渲染函数——`hologram_dataflow` 的输出结构（scopes + shared）和 trace JSON 里的数据流信息是同构的。

---

## 产出数据结构（单条 trace）

```json
{
  "trace_id": "logBuffer_v1",
  "resource": "logBuffer",
  "description": "UI 日志缓冲区：四个入口 → write → logBuffer → flush → 文件落盘",
  "language": "typescript",
  "files_involved": ["src-ui/src/agent/logger.ts"],
  "created_at": "2026-07-01T13:13:45Z",
  "verified_at": "2026-07-01T13:13:45Z",
  "test_file": "src-ui/tests/logger-dataflow.test.ts",
  "test_status": "4/4 passed",
  "commit_hash": "abc1234",
  "status": "active",

  "nodes": [
    {"role": "entry",      "id": "log.error",    "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 77},
    {"role": "entry",      "id": "log.warn",     "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 73},
    {"role": "entry",      "id": "log.info",     "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 70},
    {"role": "entry",      "id": "log.debug",    "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 67},
    {"role": "transform",  "id": "write",        "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 50},
    {"role": "buffer",     "id": "logBuffer",    "kind": "medium",   "file": "src-ui/src/agent/logger.ts", "line": 18},
    {"role": "consumer",   "id": "flush",        "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 55},
    {"role": "sink",       "id": "appendToFile", "kind": "function", "file": "src-ui/src/agent/logger.ts", "line": 41}
  ],

  "edges": [
    {"from": "log.error",   "to": "write",        "kind": "calls",   "confidence": "verified"},
    {"from": "log.warn",    "to": "write",        "kind": "calls",   "confidence": "verified"},
    {"from": "log.info",    "to": "write",        "kind": "calls",   "confidence": "verified"},
    {"from": "log.debug",   "to": "write",        "kind": "calls",   "confidence": "verified"},
    {"from": "write",       "to": "logBuffer",    "kind": "shares",  "confidence": "verified"},
    {"from": "write",       "to": "flush",        "kind": "calls",   "confidence": "verified"},
    {"from": "flush",       "to": "logBuffer",    "kind": "shares",  "confidence": "verified"},
    {"from": "flush",       "to": "appendToFile", "kind": "triggers", "confidence": "verified"}
  ],

  "conflicts": [
    {"resource": "logBuffer", "accessors": ["write", "flush"], "risk": "medium"}
  ],

  "source_snippets": {
    "logBuffer_decl": {"code": "const logBuffer: string[] = [];", "file": "src-ui/src/agent/logger.ts", "line": 18},
    "write_body":    {"code": "function write(entry: LogEntry): void {\n  logBuffer.push(JSON.stringify(entry));\n  if (logBuffer.length >= MAX_BUFFER) flush();\n}", "file": "src-ui/src/agent/logger.ts", "line": 50},
    "flush_body":    {"code": "async function flush(): Promise<void> {\n  if (logBuffer.length === 0 || !logPath) return;\n  const batch = logBuffer.splice(0).join('\\n') + '\\n';\n  await appendToFile(logPath, batch);\n}", "file": "src-ui/src/agent/logger.ts", "line": 55}
  }
}
```

### 字段约束

- **trace_id**：`{resource}_v{N}` 格式，同 resource 多版本用数字后缀
- **nodes[].role**：entry | transform | buffer | consumer | sink | observer
- **edges[].confidence**：`verified`（有测试）| `static_match`（数据流引擎交叉验证通过）| `speculative`（Agent 推测，无验证）
- **source_snippets**：每条 trace 必须附带 ≥1 个关键源码片段。片段不是全文，是记录该 trace 核心逻辑的那几行——不存档，仅作溯源锚点
- **status**：active | stale | broken | deprecated

---

## 可靠性：四重保险

```
┌────────────────────────────────────────────────────────┐
│  Layer 1: source_snippets 锚点验证                      │
│  ───────────────────────────────────────────────────── │
│  保存时：Agent 必须附带关键源码片段。                     │
│  验证时：用 search_content 搜每个片段 →                 │
│    搜不到 或 行号不匹配 or 内容不匹配 → trace 当场报 stale│
│  成本：≈0（一次 search_content）                        │
│  兜底：代码被人改过，核心逻辑变了，trace 失效             │
├────────────────────────────────────────────────────────┤
│  Layer 2: 数据流引擎交叉验证                             │
│  ───────────────────────────────────────────────────── │
│  保存时：对 trace 涉及的每个文件调 hologram_dataflow，   │
│    比对引擎输出的 reads/writes 和 trace 里的边 →        │
│  Agent 推测但引擎也看到 → 标记 static_match               │
│  Agent 推测但引擎没看到 → 标记 speculative               │
│  成本：≈0（数据流引擎是纯 tree-sitter 查询，瞬间完成）    │
│  兜底：Agent 推测了一条引擎没看到的边，可能对可能错        │
├────────────────────────────────────────────────────────┤
│  Layer 3: 符号引用完整性检测                             │
│  ───────────────────────────────────────────────────── │
│  定期（手动触发或 git hook）：取 trace 里的所有 resource， │
│    用 hologram_search 全项目搜 → 对比上次保存时的引用集   │
│  任何新出现的引用者（文件不在 files_involved 里）→ stale  │
│  成本：min（search 每个 resource）                       │
│  兜底：新增了使用同一 resource 的代码，trace 可能不完整    │
├────────────────────────────────────────────────────────┤
│  Layer 4: 测试验证                                      │
│  ───────────────────────────────────────────────────── │
│  Agent 建图时写测试，hologram_dataflow_verify 重跑。      │
│  全通过 → verified；部分失败 → test_status 标记失败       │
│  成本：高（需要 Agent 写靠谱的测试）                      │
│  兜底：行为级验证，最可靠但最慢                           │
└────────────────────────────────────────────────────────┘
```

Layer 1-2 在 **保存时自动执行**，Agent 无需额外操作。Layer 3-4 按需触发。

---

## SQLite 表设计

```sql
CREATE TABLE dataflow_traces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id     TEXT NOT NULL UNIQUE,
    resource     TEXT NOT NULL,
    description  TEXT DEFAULT '',
    language     TEXT DEFAULT '',
    files_json   TEXT DEFAULT '[]',     -- JSON array of file paths
    created_at   TEXT NOT NULL,
    verified_at  TEXT,
    test_file    TEXT DEFAULT '',
    test_status  TEXT DEFAULT '',       -- "N/M passed" or "wip" or "broken"
    commit_hash  TEXT DEFAULT '',
    status       TEXT DEFAULT 'active', -- active | stale | broken | deprecated
    trace_json   TEXT NOT NULL          -- 完整 trace JSON
);

CREATE INDEX idx_dt_resource ON dataflow_traces(resource);
CREATE INDEX idx_dt_status   ON dataflow_traces(status);
```

### 索引策略

`trace_json` 存完整 JSON 后，`resource`、`status`、`language` 三个字段被提权为列并建索引——列表查询不解析 JSON。

---

## 需要新实现的工具（Agent 内置工具，非 MCP）

这些不是通过 MCP 协议暴露给外部客户端的工具（`hologram_dataflow` 已经是 MCP 工具了，它不需要改）。它们是内置在 Agent 工具注册表里的，Agent 在对话流程中直接调用，Dataflow 面板通过 Tauri `invoke` 层走同样的后端逻辑。

### 后端：Tauri command（新建 `src-tauri/src/commands/dataflow.rs` 模块）

> **main.rs 拆分后落点说明。** 原方案写于拆分前，当时所有 Tauri command 都堆在 `main.rs`。拆分后 `main.rs` 只剩入口 + `invoke_handler` 注册 + tests，命令实现按业务域分散到 `commands/` 模块（`hologram.rs` 图查询、`tools.rs` 文件/git/IPC、`workspace.rs` 工作区）。dataflow 这 6 个命令自成体系，新建 `src-tauri/src/commands/dataflow.rs`，与 `hologram.rs`/`workspace.rs` 平级。

| command | 参数 | 说明 | Phase |
|---------|------|------|-------|
| `dataflow_save` | `trace_json: String` | 验证 schema → Layer 1 snippet 锚点 → Layer 2 引擎交叉验证 → 计算 confidence → INSERT/UPDATE | 1 |
| `dataflow_query` | `trace_id` 或 `resource` (二选一) | 返回完整 trace JSON 字符串。resource 模式返回最新 version | 1 |
| `dataflow_list` | `language?`, `status?`, `limit?` | 返回 `Vec<DataflowSummary>`（id, resource, description, status, test_status） | 1 |
| `dataflow_delete` | `trace_id: String` | 软删除（status=deprecated）或硬删除 | 1 |
| `dataflow_verify` | `trace_id: String` | 重跑 Layer 1-2 验证 + 关联测试，更新 verified_at / test_status | 2 |
| `dataflow_stale_check` | `trace_id?`（不传=全量） | Layer 3 符号引用完整性检测，更新 status | 2 |

**后端文件变更清单：**

| 文件 | 变更 |
|------|------|
| `engine/src/storage/sqlite.rs` | `ensure_schema()` 里加 `dataflow_traces` 表 + 两个索引（跟 nodes/edges/timeline_events 同一处声明，engine 打开 db 时自动建表） |
| `src-tauri/src/commands/dataflow.rs` | **新建**。6 个 `#[tauri::command]` 实现。db 访问用 `engine::storage::SqliteDb::open_aux_connection(<workspace>/.hologram/hologram.db)` 拿独立连接直接读写 `dataflow_traces`——复用现有 timeline 的 aux connection 模式，避免阻塞 graph store 主连接。Layer 2 交叉验证在同模块内直接调 `hologram_engine` 的 dataflow API（同进程，非 IPC）。 |
| `src-tauri/src/commands/mod.rs` | 加 `pub mod dataflow;` |
| `src-tauri/src/main.rs` | `invoke_handler` 里注册 `commands::dataflow::dataflow_save` 等 6 个命令（只加注册行，不写实现） |

> **为什么不走 engine_client IPC。** src-tauri 已 `use hologram_engine as engine` 把 engine 作为 Rust 库直接链接进来（`commands/hologram.rs`、`utils.rs` 都是同进程直调）。`engine_client`/`engine_*` 那套 IPC 是给独立 engine 进程的 fallback 通道，dataflow 命令不需要走它——直接调 engine 的 dataflow API + 直接开 aux sqlite 连接即可，跟 timeline 命令一个层级。

### 前端：Agent 内置工具定义（`src-ui/src/agent/tool.ts`）

| 工具名 | type | 说明 |
|--------|------|------|
| `dataflow_save` | builtin → invoke | Agent 建完 trace 后落盘。read_only=false，纳入权限白名单。 |
| `dataflow_query` | builtin → invoke | Agent 追问已有 trace 时调。read_only=true。 |
| `dataflow_list` | builtin → invoke | Agent 列出项目所有 trace 时调。read_only=true。 |
| `dataflow_delete` | builtin → invoke | Agent 清理过时 trace 时调。read_only=false。 |
| `dataflow_verify` | builtin → invoke | Agent 重验证 trace。read_only=true（不改 trace 内容，只改 verified_at/test_status 元数据）。 |
| `dataflow_stale_check` | builtin → invoke | Agent 检查哪些 trace 过期。read_only=true。 |

这些工具不出现在 MCP 工具列表中，仅供内置 Agent 使用。Dataflow 面板直接通过 `invoke()` 调同名 Tauri command，不经过 Agent。

---

## Agent 架构

### 专用 Dataflow Agent（非复用主 Agent）

```
┌──────────────────────────────────────────────┐
│  Main Chat (ChatPanel)                       │
│  ─────────────────────────                   │
│  Agent (chat)                                │
│  systemPrompt: coding / general assistance   │
│  session: 用户对话上下文                       │
│  职责：日常编码、回答问题、解释代码             │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  Dataflow Panel (浮动窗口)                    │
│  ─────────────────────────                   │
│  Agent (dataflow)  ← 专用实例，独立生命周期    │
│  systemPrompt: dataflow tracing              │
│  session: 仅当前 trace 任务                   │
│  职责：追踪数据流、写测试、落盘               │
│                                              │
│  ┌─ 执行状态（非完整对话 UI）────────────┐   │
│  │ 🔍 搜索 logBuffer 引用...              │   │
│  │ 📖 读取 logger.ts (行 40-80)           │   │
│  │ 📊 hologram_dataflow 分析 2 文件       │   │
│  │ ✏️ 写测试 logger-dataflow.test.ts      │   │
│  │ ✅ vitest 4/4 passed                  │   │
│  │ 💾 dataflow_save 完成                  │   │
│  └──────────────────────────────────────┘   │
└──────────────────────────────────────────────┘

共享：ToolRegistry · Provider · hooks · permissions (Rust 后端)
独立：Agent 实例 · systemPrompt · session · EventSink · maxSteps · temperature
```

### 为什么不能复用主 Agent

1. **context 污染。** 一条 trace 需要 12-20 轮 tool call（user → assistant → tool_call → tool_result → assistant → ...）。这些中间结果永久占据主 Agent 的 context window。用户在 chat 里聊代码重构，中间塞 12 轮数据流追踪的记录，后续对话质量直接下降。

2. **中断风险。** 数据流追踪是原子任务——要么跑完落盘，要么不开始。主 Agent 的对话随时可能被用户切话题，追了一半的 trace 无法恢复，之前几步白费 token。

3. **system prompt 冲突。** 主 Agent 的 prompt 是为通用编程辅助优化的。数据流追踪需要不同的行为模式——结构化输出、只关心数据移动、被要求产出特定 JSON 格式。硬塞进同一个 prompt 会让 Agent 在对话模式和任务模式之间摇摆。

4. **并行隔离。** 用户可以一边跟主 Agent 聊重构方案，一边让数据流 Agent 在后台追 `auth_flow`。两个 Agent 互不干扰，各自消费自己的 context，各自独立 stream。

### 工具分配矩阵

| 工具 | Dataflow Agent | 主 Agent | 理由 |
|------|:---:|:---:|------|
| `search_content` | ✅ | ✅ | 两个都需要 |
| `read_file` | ✅ | ✅ | |
| `glob` | ✅ | ✅ | |
| `hologram_dataflow` | ✅ | ✅ | 一个交叉验证，一个快速诊断 |
| `hologram_node` | ✅ | ✅ | |
| `hologram_search` | ✅ | ✅ | |
| `hologram_neighbors` | ✅ | ✅ | |
| `hologram_thread_conflicts` | ✅ | ✅ | 检测共享状态并发风险 |
| `write_file` | ✅ 仅test | ✅ | dataflow Agent 只写 test 文件 |
| `run_shell` | ✅ 仅vitest | ✅ | dataflow Agent 只跑测试 |
| `dataflow_save` | ✅ | ❌ | 只有 worker 写，主 Agent 不负责建 trace |
| `dataflow_query` | ❌ | ✅ | 用户问"logBuffer 的数据流是什么" |
| `dataflow_list` | ❌ | ✅ | 用户问"有哪些数据流" |
| `dataflow_delete` | ❌ | ✅ | 用户操作，非 worker 职责 |
| `dataflow_verify` | ❌ | ✅ | 用户操作 |
| `dataflow_stale_check` | ❌ | ✅ | 维护操作 |
| `edit_file` | ❌ | ✅ | dataflow Agent 绝不修改源码 |
| `agent_spawn` | ❌ | ✅ | 防止嵌套 |

Dataflow Agent 有效工具：~10 个（只保留分析和数据流保存能力）。

### Dataflow Agent 完整 system prompt

```
你是 HoloGram 数据流追踪引擎。你的唯一职责是：接收一个 resource 名称和
一句描述，在项目代码中追踪它的完整数据流链路，产出结构化 trace JSON，落盘保存。

──── 工作流（严格按序执行） ────

1. 确认参数。
   提取 resource_name 和 description。缺失任何一项 → 拒绝执行，告知用户。

2. 搜索引用。
   调 search_content 搜 resource_name 在项目中的所有出现位置。
   同时调 hologram_search 在结构图中搜索该符号。
   合并两个来源，去重，生成候选文件列表。

3. 筛选文件。
   从搜索结果中选出包含该 resource 定义或关键使用的源文件。
   只选应用代码文件，跳过测试文件、vendor、node_modules。

4. 读取源码。
   调 read_file 读取每个关键文件的相关代码段。
   重点关注：resource 的声明/初始化位置、所有读写该 resource 的函数、
   该 resource 被传递到的下游函数。

5. 静态交叉验证。
   对每个关键文件调 hologram_dataflow。
   对比引擎输出的 per-function reads/writes 与你的推理结果：
   - 引擎看到但你没覆盖的 → 补充到 trace，标记 confidence: static_match
   - 你推理出但引擎没看到的 → 保留，标记 confidence: speculative
   - 两者一致 → 标记 confidence: verified（下一步写测试后最终确认）
   同时调 hologram_thread_conflicts 检测该 resource 的并发访问风险。

6. 写测试。
   为数据流关键路径写测试文件，命名规则 {resource}_dataflow.test.{ext}，
   写入项目对应测试目录。测试应验证：
   - 每个入口函数的输出是否正确写入 resource
   - resource 是否按预期流向 consumer/sink
   - 并发场景下是否存在非预期的交错写入（如有）
   使用项目已有的测试框架（vitest/pytest/go test 等）。

7. 执行测试。
   调 run_shell 执行对应测试框架的命令。确认全部通过。
   如部分失败 → 修复测试后重试。全败 → 仍保存，status 标 broken。

8. 构建 trace JSON。
   按 dataflow_traces 表的 schema 组装完整 JSON：
   - trace_id: {resource}_v1（调 dataflow_list 检查，如已存在则递增版本号）
   - resource: resource_name
   - description: 用户给的描述
   - language: 主要涉及文件的编程语言
   - files_involved: 涉及的文件路径列表
   - nodes: 每个参与函数的节点，标注 role（entry/transform/buffer/consumer/sink/observer）
   - edges: 函数间的数据流关系，每条标注 confidence
   - source_snippets: 至少 1 个关键源码片段，每段附 file + line
   - conflicts: 如检测到并发共享状态，记录 risk 级别

9. 落盘。
   调 dataflow_save 保存 trace JSON。工具执行后会自动运行 Layer 1（snippet 锚点）
   和 Layer 2（引擎交叉验证），结果写入 verified_at 和 test_status。

──── 置信度标记规则 ────

- verified：测试全部通过 且 hologram_dataflow 结果一致
- static_match：hologram_dataflow 结果一致，但未写测试（函数太简单或纯 getter/setter）
- speculative：只有你的推理，无任何验证手段支撑。必须注明推测依据

──── 行为约束 ────

- 绝不修改项目源码。test 文件是唯一例外。
- 绝不闲聊。不回应数据流追踪以外的问题。
- 工具调用失败 → 重试 1 次。两次都失败 → 跳过该项，
  在 trace JSON 中标明原因并在 description 字段附注 "⚠ 部分路径未验证: ..."
- 每个关键步骤完成后，向 sink 发一条简短状态更新。
- 状态消息格式：单行纯文本，不超过 80 字符。
  示例："[搜索完成] 找到 7 处引用，涉及 3 个文件"
        "[分析完成] 2 个文件，5 个函数，3 个共享变量"
        "[测试完成] 4/4 passed · src/log Buffer_dataflow.test.ts"
        "[保存完成] logBuffer_v1 → SQLite"

──── 终止条件 ────

- 搜索结果为 0 → 返回 "❌ 未找到 {resource} 的任何引用。请确认 resource 名称正确。"
- 所有引用均为外部/第三方 → 返回 "❌ {resource} 的所有引用均在 node_modules/外部依赖中，无法建立项目内 trace。"
- 测试全部失败 → 仍然保存 trace，但 test_status 标为 "0/N passed"，status 标为 "broken"
```

### 主 Agent 新增工具定义

`src-ui/src/agent/tool.ts` 中为主 Agent 新增 5 个内置工具（全部 read_only）：

```typescript
// ── Dataflow trace management (read-only, internal) ──
{
  name: 'dataflow_query',
  read_only: true,
  description: '查询一条已保存的数据流 trace。参数 trace_id 或 resource（二选一）。返回完整 trace JSON，包含 nodes、edges、source_snippets、test_status 等。',
}
{
  name: 'dataflow_list',
  read_only: true,
  description: '列出项目中所有已保存的数据流 trace。可选过滤：language、status。返回 id、resource、description、status、test_status。',
}
{
  name: 'dataflow_verify',
  read_only: true,
  description: '重新验证一条 trace：重跑 source_snippets 锚点检测 + hologram_dataflow 静态交叉验证 + 关联测试文件。更新 verified_at 和 test_status 字段。',
}
{
  name: 'dataflow_stale_check',
  read_only: true,
  description: '检查一条或全部 trace 是否因代码变更而过期。对每个 res_ource 调 hologram_search 全项目搜符号 → 对比上次保存时的引用集 → 新出现的引用者标记状态为 stale。',
}
```

`dataflow_delete` 是唯一的写操作工具：

```typescript
{
  name: 'dataflow_delete',
  read_only: false,
  description: '删除（软删除）一条数据流 trace。将 status 设为 deprecated。',
}
```

主 Agent 调用这些工具的场景示例：

```
用户: "有哪些数据流？"
→ Agent 调 dataflow_list → 返回 6 条 trace，3 active，1 stale，2 broken
→ Agent: "项目中有 6 条数据流 trace。3 条活跃：logBuffer、auth_flow、session_mgr。
   1 条过期：config_loader 需要重新追踪。2 条已损坏：..."

用户: "logBuffer 的完整数据流是什么？"
→ Agent 调 dataflow_query(resource: "logBuffer")
→ 拿到完整 trace JSON → 解读并回答

用户: "auth 代码改了，之前那个 trace 还准吗？"
→ Agent 调 dataflow_stale_check(trace_id: "auth_flow_v1")
→ 返回 stale → Agent 建议重新追踪
```

### Agent 实例化方式

```typescript
// 在 DataflowPanel 初始化时
import { Agent } from '../agent/agent';
import { toolRegistry } from '../agent/tool';

// Dataflow Agent 只用工具的子集 —— 筛选出以 analytics/dataflow 为主的工具
// 实际实现中，可以在 ToolRegistry 上加一个 .subset(names: string[]) 方法
const dataflowTools = toolRegistry.subset([
  'search_content', 'read_file', 'glob',
  'hologram_dataflow', 'hologram_search', 'hologram_node',
  'hologram_neighbors', 'hologram_thread_conflicts',
  'write_file', 'run_shell',
  'dataflow_save',
]);

const dataflowAgent = new Agent(
  provider,              // 共享 Provider
  dataflowTools,         // 精简版 ToolRegistry（~10 工具）
  DATAFLOW_SYSTEM_PROMPT, // 上面的完整 prompt
  {
    temperature: 0.3,    // 低温度，输出更确定
    maxSteps: 20,        // 复杂链路需要更多步
  },
  dataflowEventSink      // 专用 EventSink → 面板状态日志
);
```

### 前端文件变更

| 文件 | 说明 |
|------|------|
| `src-ui/src/agent/tool.ts` | 新增 6 个内置工具定义。Dataflow Agent 用 subset 取出 ~10 个，主 Agent 用完整注册表 + 新增的 5 个管理工具。 |
| `src-ui/src/ui/dataflow-panel.ts` | 浮动面板 + 专用 Agent 实例。左侧 trace 列表（调 `invoke("dataflow_list")`）+ 右侧详情（调 `invoke("dataflow_query")`）+ 新建时创建 `Agent(dataflow)` 实例驱动追踪 |
| `src-ui/index.html` | 面板 div + CSS |
| `src-ui/src/ui/app-shell.ts` | 注册 dataflow panel |

### 数据流路径

```
Dataflow Panel ──invoke()──→ dataflow_traces 表 ←──内置工具── Dataflow Agent
     │                                                              │
     │ 列表/详情/删除                  save 写入                     │ 搜索/读取/分析/测试
     │                                                              │
     ▼                                                              ▼
 用户直接操作                    Tauri command (commands/dataflow.rs)           工具链 (chat 复用)
                                       │
                                       │ SqliteDb::open_aux_connection()
                                       ▼
                                 engine/src/storage/sqlite.rs (hologram.db)
```

---

## 与全量自动分析的关系

| | hologram_dataflow (已有) | Agent 建 trace (本方案) |
|---|---|---|
| 触发 | Agent 按需调 | 用户发起 → Agent 自动执行 |
| 范围 | 单文件 | 跨文件、端到端 |
| 深度 | 静态可见的 reads/writes | 语义推理，动态模式（DI、回调、事件） |
| 可靠性 | tree-sitter 解析，所见即所得 | source_snippets + 引擎交叉验证 + 测试 ≠ 出错时能自纠 |
| 持久化 | 不存（每次重新算） | SQLite 持久，按 resource 查询 |
| 生命周期 | 瞬态 | 建 → 验证 → 维护 → 过期/删除 |
| 适用场景 | 开发时快速诊断、Agent 工具链一环 | 关键路径归档：鉴权流、配置流、状态流、权限流、日志流 |

两者是互补关系，不是竞争关系。Agent 建 trace 时可以（也建议）调 `hologram_dataflow` 作为交叉验证数据源。

---

## 实施路径

### Phase 1 — 存储 + 面板 + 专用 Agent（目标：能追一条 trace 并落盘）

**后端：**

1. `dataflow_traces` 表建在 `engine/src/storage/sqlite.rs` 的 `ensure_schema()`（跟 nodes/edges/timeline_events 同一处声明，engine 打开 db 时自动建表），含索引
2. 新建 `src-tauri/src/commands/dataflow.rs`，`commands/mod.rs` 加 `pub mod dataflow;`。实现 `dataflow_save`：验证 trace schema → Layer 1 snippet 锚点 → Layer 2 引擎交叉验证 → 计算节点/边的 confidence → INSERT/UPDATE。db 读写用 `SqliteDb::open_aux_connection(<workspace>/.hologram/hologram.db)`（复用 timeline 的 aux connection 模式），Layer 2 直接调 `hologram_engine` 的 dataflow API（同进程直调，非 IPC）
3. 同模块实现 `dataflow_query`、`dataflow_list`、`dataflow_delete`：按 trace_id/resource 查询、列表、软删除。完成后在 `main.rs` 的 `invoke_handler` 注册这 4 个命令

**前端引擎侧：**

4. `src-ui/src/agent/tool.ts`：
   - Dataflow Agent 的 `dataflow_save` 工具注册（read_only=false）
   - 主 Agent 的 `dataflow_query` / `dataflow_list` / `dataflow_delete` / `dataflow_verify` / `dataflow_stale_check` 工具注册
   - `ToolRegistry` 加 `subset(names: string[])` 方法，从完整注册表裁剪出 ~10 个工具的子集
5. Dataflow Agent system prompt 写入常量（上一节完整 prompt）

**前端 UI：**

6. `src-ui/index.html`：面板 div + CSS（浮动窗口、左侧列表、右侧详情、状态日志区）
7. `src-ui/src/ui/dataflow-panel.ts`：
   - 浮动面板类（跟 chat 同级，可拖拽 resize）
   - 左侧 TraceList：调 `invoke("dataflow_list")` 渲染列表，带 status 图标
   - 右侧 TraceDetail：调 `invoke("dataflow_query")`，复用 `formatDataflowCard()` 渲染
   - 新建按钮：弹出对话框 → 创建 `Agent(dataflow)` 实例 → 注入构造好的 prompt → 状态日志实时更新
8. `src-ui/src/ui/app-shell.ts`：注册 dataflow panel 到面板切换

**验证目标：** 手动触发一次 logBuffer 追踪，Agent 自动追完整条链路 → 落盘 → 面板左侧显示 ✅ active。

---

### Phase 2 — 验证 + 维护（目标：trace 不会悄悄变旧）

9. 在 `src-tauri/src/commands/dataflow.rs` 实现 `dataflow_verify`：重跑 Layer 1-2 + 重跑关联测试文件（如存在），更新 `verified_at` / `test_status`。注册到 `main.rs` 的 `invoke_handler`
10. 同模块实现 `dataflow_stale_check`：Layer 3 符号引用完整性检测。对每个 resource 调 `hologram_search` → 对比上次保存的引用集 → 新出现引用者 → status 标 stale。注册到 `main.rs`
11. Watcher 联动：engine watcher 检测到 `files_involved` 中的文件变更 → 自动调 `dataflow_stale_check(trace_id)` → 更新状态

---

### Phase 3 — 面板增强（目标：便利性）

12. 新建 trace 引导优化：resource 输入框加自动补全（从 `hologram_search` 拿候选符号名）
13. 重追踪：对 stale trace 点"重追"，复用原有 resource + description，Agent 自动重新建 trace（version 号递增）
14. 面板内嵌编辑器：手动微调 trace 的 nodes/edges/description（语法高亮 JSON）
15. trace 版本 diff：同一 resource 的 v1 vs v2 对比

---

## 风险矩阵

| 风险 | 等级 | 缓解 |
|------|------|------|
| Agent 追丢数据流（遗漏关键路径） | 中 | Layer 2 交叉验证指出引擎能看到但 trace 没覆盖的边；Layer 3 定期扫新引用 |
| Agent 推测的边是错的 | 中 | confidence 三级标记；speculative 边在面板用虚线/半透明渲染，跟 verified 边视觉区分 |
| trace 数量膨胀后维护成本高 | 低 | 只对关键路径建 trace（鉴权、配置、状态、权限、日志），不对每段代码建 |
| 代码大量变更后 trace 批量失效 | 低 | Layer 1 snippet 锚点最快发现失效；批量 stale 时一次性让 Agent 重追 |
| static_match 误匹配 | 低 | 引擎输出和 trace 边用 (from, to, kind) 三元组精确比对，不模糊匹配 |
