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

### 后端：Tauri command（`src-tauri/src/main.rs`）

| command | 参数 | 说明 | Phase |
|---------|------|------|-------|
| `dataflow_save` | `trace_json: String` | 验证 schema → Layer 1 snippet 锚点 → Layer 2 引擎交叉验证 → 计算 confidence → INSERT/UPDATE | 1 |
| `dataflow_query` | `trace_id` 或 `resource` (二选一) | 返回完整 trace JSON 字符串。resource 模式返回最新 version | 1 |
| `dataflow_list` | `language?`, `status?`, `limit?` | 返回 `Vec<DataflowSummary>`（id, resource, description, status, test_status） | 1 |
| `dataflow_delete` | `trace_id: String` | 软删除（status=deprecated）或硬删除 | 1 |
| `dataflow_verify` | `trace_id: String` | 重跑 Layer 1-2 验证 + 关联测试，更新 verified_at / test_status | 2 |
| `dataflow_stale_check` | `trace_id?`（不传=全量） | Layer 3 符号引用完整性检测，更新 status | 2 |

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

### Agent 实例化方式

```typescript
// 在 DataflowPanel 初始化时
import { Agent } from '../agent/agent';
import { toolRegistry } from '../agent/tool';

const dataflowAgent = new Agent(
  provider,           // 共享 Provider（同 API key + model）
  toolRegistry,       // 共享 ToolRegistry（同一套工具）
  DATAFLOW_SYSTEM_PROMPT,
  {
    temperature: 0.3,  // 更低温度，数据流分析不需要创造性
    maxSteps: 20,       // 比主 Agent 更多步数（复杂链路需要更多跳）
  },
  dataflowEventSink    // 专用 EventSink → 面板状态日志，不进主 chat
);
```

### Dataflow Agent system prompt 要点

- 角色：数据流分析专家，不是通用编程助手。只追踪数据移动和变换。
- 工作流：搜索 resource → 读源文件 → 调 hologram_dataflow 交叉验证 → 写测试 → 调 dataflow_save 落盘
- 输出约束：必须产出符合 trace schema 的 JSON；必须附带 source_snippets（每段标 file + line）；confidence 标记优先级（verified > speculative > dynamic）
- 禁止：闲聊、偏离追踪任务、修改与 trace 无关的代码

### 前端文件变更

| 文件 | 说明 |
|------|------|
| `src-ui/src/agent/tool.ts` | 注册 6 个内置工具定义（dataflow_save/query/list/delete/verify/stale_check），映射到 Tauri invoke |
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
 用户直接操作                    Tauri command (main.rs)           工具链 (chat 复用)
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

### Phase 1 — 存储 + 面板（本 sprint）

1. `dataflow_traces` 表建在 `ensure_schema()`
2. `hologram_dataflow_save` / `query` / `list` / `delete` 四个工具，save 时自动跑 Layer 1+2
3. 前端 dataflow-panel.ts（浮动窗口 + 列表 + 详情）
4. app-shell 注册面板

### Phase 2 — 验证 + 维护

5. `hologram_dataflow_verify`（Layer 1-2 重跑 + 测试重跑）
6. `hologram_dataflow_stale_check`（Layer 3 符号引用检测）
7. Git hook / watcher 联动：相关文件变更时自动标记 stale

### Phase 3 — 面板增强

8. 新建 trace 的引导对话框（resource + 描述 → 注入 chat prompt）
9. 面板内嵌编辑器：编辑 trace 的 nodes/edges/description（手动微调）
10. trace 版本 diff：同一 resource 的 v1 vs v2 对比

---

## 风险矩阵

| 风险 | 等级 | 缓解 |
|------|------|------|
| Agent 追丢数据流（遗漏关键路径） | 中 | Layer 2 交叉验证指出引擎能看到但 trace 没覆盖的边；Layer 3 定期扫新引用 |
| Agent 推测的边是错的 | 中 | confidence 三级标记；speculative 边在面板用虚线/半透明渲染，跟 verified 边视觉区分 |
| trace 数量膨胀后维护成本高 | 低 | 只对关键路径建 trace（鉴权、配置、状态、权限、日志），不对每段代码建 |
| 代码大量变更后 trace 批量失效 | 低 | Layer 1 snippet 锚点最快发现失效；批量 stale 时一次性让 Agent 重追 |
| static_match 误匹配 | 低 | 引擎输出和 trace 边用 (from, to, kind) 三元组精确比对，不模糊匹配 |
