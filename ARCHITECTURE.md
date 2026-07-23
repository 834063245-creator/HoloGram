# HoloGram — 核心能力与技术架构

> © 2026 Wenbing Jing. MIT License.

HoloGram 不是一个单纯的"代码图谱可视化工具"。它的本质是一个 **Harness Engineering 平台**——将多种成熟软件工程模式（依赖分析、约束治理、变更预演、沙箱隔离、Agent 自主执行等）编排为统一 Harness，并通过内置 Agent 与对外 MCP 服务将这些能力开放给人和 AI。

代码图谱分析引擎是目前体量最大、最核心的组件，但它是 Harness 体系的一个支柱，而非全部。

---

## 1. 核心能力总览

| 能力域 | 定位 | 当前实现深度 |
|--------|------|-------------|
| **代码图谱分析引擎** | 多语言 AST 解析 → 依赖拓扑图 → 耦合/社区/数据流分析 | ★★★★★ 最完整 |
| **Agent 自主执行系统** | LLM 驱动的多轮工具调用循环，含子 Agent 编排、上下文压缩、目标管理 | ★★★★☆ |
| **Harness Engineering 模式** | 约束治理、变更预演、沙箱隔离、权限引擎、审计日志 | ★★★★☆ |
| **MCP 对外服务** | 30+ 工具通过 JSON-RPC 暴露给任意 MCP 客户端 | ★★★★★ |
| **3D 图谱可视化** | GPU 加速的交互式依赖星图（Three.js / WebGL） | ★★★☆☆ |

---

## 2. 架构分层

```
┌─────────────────────────────────────────────────────┐
│                    外部 MCP 客户端                     │
│            (Claude Code / Cursor / 任意 MCP 客户端)      │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC over stdin/stdout
┌──────────────────────┴──────────────────────────────┐
│              Engine (Rust 单文件二进制)                │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 图谱引擎  │  │ MCP 服务  │  │  30+ 工具注册表    │  │
│  │ Pipeline │  │ JSON-RPC │  │  ToolRegistry     │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       └─────────────┴─────────────────┘              │
│                    Engine 全局实例                     │
└──────────────────────┬──────────────────────────────┘
                       │ 进程管理 (McpManager)
┌──────────────────────┴──────────────────────────────┐
│              Tauri 桌面 Shell (Rust)                  │
│  ┌──────────┐ ┌─────────┐ ┌────────┐ ┌───────────┐  │
│  │ 权限引擎  │ │ 沙箱    │ │ Agent  │ │  Audit    │  │
│  │ 削决编排  │ │ Sandbox │ │隔离worktree│ │ Logger  │  │
│  └──────────┘ └─────────┘ └────────┘ └───────────┘  │
│         单一 RPC 入口 (rpc.rs ~99 个方法)             │
└──────────────────────┬──────────────────────────────┘
                       │ Tauri IPC (invoke)
┌──────────────────────┴──────────────────────────────┐
│              前端 (TypeScript / React)                │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐  │
│  │ Agent 循环│ │ 工具注册表│ │子Agent池│ │ 3D 星图   │  │
│  │ streaming│ │ ToolReg  │ │Coord.  │ │ Three.js  │  │
│  └──────────┘ └──────────┘ └────────┘ └───────────┘  │
│              Workspace (统一状态容器)                  │
└─────────────────────────────────────────────────────┘
```

三层各自独立编译，通过明确边界通信：
- **Engine** 是纯 Rust 库 + CLI 二进制，零外部依赖，可独立 `serve`
- **Tauri Shell** 是进程管理者和权限守卫，不做分析逻辑
- **前端** 是 Agent 运行时和用户界面，通过单一 `rpc()` 函数与后端通信

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

Agent 在执行文件编辑前必须经过 `preflight_check`，引擎根据图谱拓扑计算波及半径、跨社区影响、L4 穿透等指标，决定放行还是路由到人工确认。

### 3.2 变更预演 (Change Preflight)

`preflight_check` 工具接受待修改文件列表，返回：
- **波及半径**：BFS 遍历下游依赖，给出影响树
- **风险等级**：low / medium / high / critical
- **共享变量影响**：哪些 dataflow 共享状态会被波及
- **时序边信号**：async trigger/await 链是否受影响

这是一个"改之前先看会炸哪里"的 Harness 模式，避免盲目修改高扇入符号。

### 3.3 沙箱隔离 (Sandboxed Agent Execution)

两层隔离机制：

**OS 层沙箱** (`os_sandbox.rs`)：
- Windows Job Object：子进程随父进程死亡
- 所有 Engine 进程、Memory Bundle 进程纳入 Job Object

**Agent Worktree 隔离** (`agent_isolation.rs`)：
- `git worktree add --detach` 为每个 Agent 创建独立工作树
- 路径双向映射：forward（逻辑→物理）+ reverse（物理→逻辑）
- 完成后 cherry-pick 合并回主仓库；冲突时返回 diff 供人工处理
- 超时自动清理过期 worktree

### 3.4 权限引擎 (Permission Engine)

每个 Tauri command 对应一个 `Tool` trait 实现，执行前经过削决：

```
Tool.check_permissions(ctx) → PermissionResult
  ├── Allow           → 直接执行
  ├── Deny            → 拒绝并返回原因
  ├── Ask { danger }  → 路由到用户确认（critical 显示红色警告卡）
  └── Passthrough     → 交由引擎兜底
```

权限规则 (`PermissionRules`) 支持路径 glob、读写分类、危险操作标记。规则匹配时会将 worktree 物理路径 reverse-map 到主仓库逻辑路径，确保用户定义的规则如 `Edit("src/**")` 在隔离环境下同样生效。

### 3.5 审计日志 (Audit Trail)

`AuditLogger` 记录所有 Agent 工具调用的完整审计轨迹，配合 `project_timeline` 工具提供按时间线回溯的分析历史。

### 3.6 技能系统 (Hot-Loading Skills)

Agent 支持从 `.hologram/skills/<name>/SKILL.md` 热加载技能。技能格式为 YAML frontmatter + Markdown body，每次调用时重新加载，无需重启即可新增技能。

---

## 4. 内置 Agent 系统

Agent 系统是 Harness 与 LLM 之间的桥梁，将上述工程模式自主地应用于实际编码任务。

### 4.1 Agent 循环

```
User Input → System Prompt + Tools → LLM Stream
  ↓ (流式解析)
StreamingToolExecutor (并发执行 tool calls)
  ↓
Tool Results → 注入会话 → 下一轮 LLM Stream
  ↓ (循环直到模型给出最终回答)
```

核心特性：
- **流式工具执行**：不等整条 stream 结束，`tool_use` block 完成就立即 dispatch
- **并发执行**：同一轮的多个只读工具并发运行
- **输出截断**：单个工具输出上限 32KB，超出则头尾保留 + 中间省略
- **重试与退避**：可重试错误按指数退避重试，最多 3 次
- **上下文压缩**：当 token 接近窗口上限时自动压缩历史消息

### 4.2 子 Agent 编排

`SubAgentPool` 管理子 Agent 生命周期：

- **并发上限**：默认 5 个子 Agent 同时运行
- **超时兜底**：默认 10 分钟，超时 abort
- **中断传播**：`stop/stopAll` 通过 `AbortController` 杀死子 Agent
- **两种模式**：
  - `fork`（默认）：继承父 Agent 上下文
  - `fresh`：干净启动，无历史上下文
- **工具白名单**：可限制子 Agent 只使用指定工具（如只读研究 Agent）
- **隔离执行**：子 Agent 的文件编辑在独立 git worktree 中运行，成功后自动合并

### 4.3 目标管理

`GoalManager` 将 Agent 从"一轮轮循环 + 正则标记"提升为显式生命周期对象：
- 目标状态：active → paused → completed / failed / cancelled
- 迭代计数与停滞检测
- 存储隔离于 `.hologram/goals/{id}/`，不与会话历史混淆

### 4.4 上下文记忆

三层记忆系统：

| 层 | 实现 | 用途 |
|----|------|------|
| **会话记忆** | Agent session JSON | 当前对话上下文，支持压缩 |
| **Aura 记忆** | `aura.dll` FFI（SDR + MinHash 语义召回） | 跨会话语义记忆，基于稀疏分布式表征 |
| **Memory Bundle** | 独立进程 `memory-bundle.exe` | 进程隔离的记忆服务 |

### 4.5 Hooks 系统

两类 Hook 在 Agent 循环中注入 Harness 逻辑：

**Post-Tool Hooks**（工具执行后注入上下文）：
- `GraphContextHook`：Agent 调用图谱工具后，自动注入相关节点/边信息到后续上下文
- `StateReadHook`：每轮开始注入 Git 状态、诊断信息

**Preflight Hooks**（工具执行前拦截）：
- `GraphPreflightHook`：编辑前检查图谱波及范围
- `StatePreflightHook`：检查 LSP 诊断状态

### 4.6 LLM Provider 抽象

统一 `Provider` trait 抹平 Anthropic 和 OpenAI 的 API 差异：
- 统一 `Message` / `ToolCall` / `Chunk` 类型
- 流式 chunk 类型：Text / Reasoning / ToolCallStart / ToolCall / Usage / Done / Error
- 支持 reasoning_content（思维链）round-trip

### 4.7 Agent 工具体系

Agent 可调用的工具分为三大类：

**图谱工具**（30+ 个，从 Engine MCP 动态加载）：
`explore_deps`, `search_symbols`, `get_neighbors`, `trace_impact`, `find_dep_path`, `inspect_symbol`, `get_community`, `cluster_report`, `fragile_modules`, `detect_cycles`, `thread_conflicts`, `coupling_report`, `arch_blindspots`, `preflight_check`, `trace_dataflow`, `resolve_call`, `infer_type`, `find_implementations`, `find_references` 等

**编码工具**（33 个，前端定义）：
- 文件操作：`read_file_content`, `write_file`, `edit_file`, `delete_file`, `move_file`, `glob`, `search_content`
- Shell：`run_shell`, `bash_output`, `bash_kill`
- Git：`git_status`, `git_diff`, `git_log`, `git_stage`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_create_branch`, `git_discard`, `git_stash_push`, `git_stash_pop`
- 隔离：`agent_isolation_create`, `agent_isolation_diff`, `agent_isolation_merge`, `agent_isolation_discard`, `agent_isolation_status`
- Web：`web_fetch`
- 用户交互：`ask_user`
- 约束：`read_constraints`

**编排工具**：
- `agent_spawn`：派发子 Agent
- `skill`：加载并执行技能

---

## 5. 代码图谱分析引擎

引擎是整个 Harness 体系的数据基础，将源代码转化为可查询的依赖拓扑图。

### 5.1 十阶段分析流水线

| 阶段 | 说明 |
|------|------|
| 1. Core Parse | Tree-sitter 解析所有源文件 → 节点 + 边 |
| 2. Cross-File Resolution | 解析跨文件的 import / call 关系 |
| 3. Coupling Analysis | 计算 L1-L4 耦合深度 |
| 4. Framework Routes | 检测 18+ 框架的路由（Express, Django, Rails, Spring, FastAPI, Flask, ASP.NET, NestJS, Gin, Koa, Phoenix, Rocket, Sinatra, Slim, Laravel, Fastify, Fiber, Actix） |
| 5. Dynamic Dispatch | 多态调用的合成边 |
| 5.1 | React 组件 / JSX 边合成 |
| 5.2 | Vue 组件 / template 边合成 |
| 5.5 | DI / 反射边检测（多语言） |
| 5.6 | 动态 import() / dynamic require 检测 |
| 5.7 | eval() / 动态代码检测 |
| 5.8 | 跨语言调用检测 |
| 6.1 | 增量耦合更新 |
| 5.9 | 源码片段提取（供向量索引） |
| 7. Community Detection | Leiden（扁平）+ Louvain（层级）社区检测 |
| 7.5 | 语义向量索引构建（后台线程） |
| 8. DB Save | 持久化到 MemoryIndex + SQLite |

特性：进度报告、AtomicBool 取消、每阶段计时、LSP 后台预热。

### 5.2 图谱数据模型

**节点** (9 种类型)：`Symbol | Function | Class | Module | File | Interface | Variable | Medium | Temporal`

每个节点携带：id, name, kind, location, snippet（供向量搜索的源码片段）, properties, in/out_degree, 3D position, community_id

**边** (12 种类型)：`Imports | Calls | Inherits | Defines | Reads | Writes | Shares | Triggers | Awaits | Sequences | Usage | Throws`

每条边携带：coupling_depth (L1-L4), cross_file 标记, temporal_delay_sec, lsp_resolved 标记, is_synthesized 标记（启发式合成边）, metadata（溯源追踪）

### 5.3 分析能力

| 模块 | 能力 |
|------|------|
| `coupling.rs` | L1-L4 四级耦合深度计算 |
| `cycles.rs` | 循环依赖检测（all / data / llm 模式） |
| `dataflow_engine.rs` | 函数级变量读写分析、跨函数共享状态、async trigger |
| `fragility.rs` | 结构脆弱性排行（扇入/扇出 + 耦合深度） |
| `blindspots.rs` | 架构盲区扫描（L4 穿透、未锁并发、LLM 反馈环） |
| `dynamic_boundaries.rs` | 动态边界检测 |
| `policy_check.rs` | 约束规则检查（配合 constraints.yaml） |
| `community/louvain.rs` | Leiden + Louvain 社区检测 |
| `vector/` | 语义向量索引（usearch），代码语义搜索 |

### 5.4 语言适配

通过 `LanguageAdapter` trait 抽象，支持动态语法加载：

26+ 种语言通过 tree-sitter 静态链接：Python, TypeScript, JavaScript, Go, Rust, Java, C, C++, Ruby, Lua, C#, PHP, Swift, Dart, Scala, OCaml, Haskell, R, Nix, Bash, JSON, HTML, CSS, YAML, Zig, Elixir, Erlang

动态语法通过 `grammar_loader.rs` + `libloading` 加载 DLL，无需重新编译即可扩展语言。

### 5.5 LSP 集成

`LspManager` 管理原生 LSP 服务器（rust-analyzer / gopls / pyright 等），提供：
- `resolve_call`：多态分发解析
- `infer_type`：精确类型推断
- `find_implementations`：接口/trait 实现查找
- `find_references`：全代码库引用查找

LSP 在分析完成后后台预热，按需查询。图谱边在索引阶段使用短名称，LSP 解析在查询时按需进行。

### 5.6 增量更新

`IncrementalUpdater` 监听文件变更（`notify` crate），仅重新解析变更文件并增量更新图谱，避免全量重分析。`Engine` 全局实例通过 `RwLock` 管理读写并发，`AtomicBool` 实现可取消的分析。

### 5.7 存储层

双层存储：
- **MemoryIndex**：CSR 格式的内存图索引，支持高并发读
- **SQLite**：持久化存储，含 FTS5 全文搜索

### 5.8 压力测试

`stress.rs` 提供合成项目生成器 + 基准测试运行器，支持 4 级规模（500 / 2000 / 10000 / 50000 文件），输出每阶段计时和吞吐量指标。

---

## 6. MCP 对外服务

Engine 作为独立 MCP Server 运行，通过 JSON-RPC over stdin/stdout 对外暴露全部 30+ 工具。

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
| **图导航** | `explore_deps`（NL 聚合查询，首选项）, `search_symbols`, `get_neighbors`, `inspect_symbol` |
| **影响分析** | `trace_impact`, `find_dep_path`, `preflight_check` |
| **社区** | `get_community`, `cluster_report` |
| **架构分析** | `fragile_modules`, `detect_cycles`, `thread_conflicts`, `coupling_report`, `arch_blindspots`, `check_boundaries`, `find_unused` |
| **数据流** | `trace_dataflow`, `async_edges` |
| **LSP** | `resolve_call`, `infer_type`, `find_implementations`, `find_references` |
| **操作** | `analyze_project`, `graph_diff`, `validate_project`, `project_health`, `rename_symbol`, `engine_status` |
| **时序** | `project_timeline` |
| **概览** | `graph_summary` |

### 6.3 降级策略

工具执行遇到错误时返回 `Degraded` 响应（非 JSON-RPC error），包含：
- `guidance`：给 LLM 的引导信息
- `fallback`：降级建议
- `_stalenessBanner`：文件变更过期提醒

这确保 MCP 客户端始终收到可操作的信息，而非硬错误。

### 6.4 Tauri Shell 的 MCP 进程管理

`McpManager` 持久化 Engine 子进程：
- 首次启动时等待 ready 信号（最长 600 秒，大项目需要布局计算时间）
- 崩溃追踪：10 秒内 3 次崩溃 → 永久降级到 CLI 模式
- 进程纳入 OS Job Object，随父进程退出

---

## 7. 技术栈

### Engine (Rust)

| 依赖 | 用途 |
|------|------|
| `tree-sitter` + 26 语言语法 | 多语言 AST 解析 |
| `libloading` | 动态语法 DLL 加载 |
| `rusqlite` (bundled) | SQLite 持久化 + FTS5 全文搜索 |
| `parking_lot` | 高性能 RwLock |
| `rayon` | 并行文件解析 |
| `usearch` | 语义向量索引（ANN 搜索） |
| `notify` | 文件系统监听（增量更新） |
| `serde` / `serde_json` / `serde_yaml` | 序列化 |
| `tracing` + `tracing-subscriber` | 结构化日志 |
| `chrono` | 时间线记录 |
| `mimalloc` | 内存分配器 |
| `regex` | 模式匹配 |
| `walkdir` | 文件遍历 |

### Tauri Shell (Rust)

| 依赖 | 用途 |
|------|------|
| `tauri` 2.x | 桌面应用框架 |
| `tauri-plugin-dialog` | 原生对话框 |
| `tauri-plugin-updater` | 自动更新 |
| `portable-pty` | PTY 终端管理 |
| `libloading` | Aura SDK FFI 加载 |
| `hologram-engine` (path 依赖) | 引擎集成 |

### 前端 (TypeScript / React)

| 依赖 | 用途 |
|------|------|
| `react` 19.x | UI 框架 |
| `zustand` | 状态管理 |
| `three` / `@types/three` | 3D 图谱渲染（WebGL） |
| `@webgpu/types` | WebGPU 类型定义 |
| `monaco-editor` | 代码编辑器 |
| `@xterm/xterm` + addons | 内嵌终端 |
| `marked` / `react-markdown` / `remark-gfm` | Markdown 渲染 |
| `highlight.js` | 代码高亮 |
| `gsap` | 动画 |
| `dompurify` | XSS 防护 |
| `vite` 6.x | 构建工具 |
| `vitest` | 测试框架 |
| `biome` | 代码格式化 + lint |
| `typescript` 5.6 | 类型系统 |

### Provider 抽象

| Provider | 实现 |
|----------|------|
| Anthropic | `provider/anthropic.ts`（Claude 系列，支持 thinking） |
| OpenAI | `provider/openai.ts`（GPT 系列） |

### 外部组件

| 组件 | 用途 |
|------|------|
| `aura.dll` (AuraSDK) | SDR + MinHash 语义记忆（FFI 加载） |
| `memory-bundle.exe` | 进程隔离的记忆服务 |
| Unity (可选) | 3D 可视化后端（事件服务器） |
| LSP 服务器 | 原生类型解析（rust-analyzer / gopls / pyright 等） |

---

## 8. 项目结构

```
HoloGramHG/
├── engine/                      # 代码图谱分析引擎 (Rust 库 + CLI)
│   ├── src/
│   │   ├── graph/               # 图数据模型 (Node, Edge, Graph, query)
│   │   ├── adapter/             # 语言适配器 (LanguageAdapter trait + 26 语言)
│   │   ├── analysis/            # 分析模块 (coupling, cycles, dataflow, fragility, blindspots)
│   │   │   └── di_reflection/   # DI/反射检测 (多语言)
│   │   ├── community/           # 社区检测 (Leiden + Louvain)
│   │   ├── pipeline/            # 十阶段分析流水线
│   │   ├── routing/             # 框架路由检测 (18+ 框架)
│   │   ├── storage/             # 存储层 (MemoryIndex CSR + SQLite)
│   │   │   └── incremental.rs   # 增量更新器
│   │   ├── vector/              # 语义向量索引 (usearch)
│   │   ├── engine/              # Engine 统一 API + 状态机 + watcher
│   │   ├── tools/               # MCP 工具注册表 + 处理器 (30+ 工具)
│   │   ├── mcp.rs               # MCP JSON-RPC 服务端
│   │   ├── lsp_manager.rs       # 原生 LSP 管理
│   │   ├── stress.rs            # 压力测试合成项目生成器
│   │   └── lib.rs               # 库入口
│   └── Cargo.toml
│
├── src-tauri/                   # Tauri 桌面 Shell (Rust)
│   ├── src/
│   │   ├── commands/            # RPC 命令处理 (99 个方法)
│   │   │   ├── engine_dispatch.rs  # Engine 工具转发
│   │   │   ├── graph.rs           # 图谱命令
│   │   │   ├── shell.rs           # Shell 命令
│   │   │   ├── filesystem.rs      # 文件系统命令
│   │   │   ├── git_cmds.rs        # Git 命令
│   │   │   ├── isolation.rs       # Agent 隔离命令
│   │   │   └── ...
│   │   ├── permissions/         # 权限引擎
│   │   │   ├── mod.rs             # Tool trait + PermissionContext + 削决
│   │   │   ├── filesystem.rs      # 读写权限检查
│   │   │   ├── bash.rs            # Shell 权限
│   │   │   ├── git.rs             # Git 权限
│   │   │   ├── web.rs             # Web 权限
│   │   │   ├── rule.rs            # 规则定义
│   │   │   └── safety.rs          # 安全检查
│   │   ├── tools/               # Tool trait 实现 (每个命令一个)
│   │   ├── agent_isolation.rs   # git worktree 生命周期管理
│   │   ├── mcp_manager.rs       # MCP 子进程管理
│   │   ├── sandbox.rs           # 路径验证 + symlink 检测
│   │   ├── os_sandbox.rs        # Windows Job Object
│   │   ├── aura_memory.rs      # Aura SDK FFI 桥接
│   │   ├── pty_manager.rs       # PTY 终端管理
│   │   ├── unity_manager.rs     # Unity 集成
│   │   ├── audit.rs             # 审计日志
│   │   ├── credential.rs       # 凭证管理
│   │   ├── rpc.rs              # 单一 RPC 入口 (99 个方法)
│   │   └── main.rs             # Tauri 应用入口
│   └── Cargo.toml
│
├── src-ui/                      # 前端 (TypeScript / React)
│   ├── src/
│   │   ├── agent/              # Agent 系统
│   │   │   ├── agent.ts          # Agent 主循环
│   │   │   ├── coordinator.ts    # 子 Agent 池 (并发/超时/中断)
│   │   │   ├── streaming-executor.ts  # 流式工具执行器
│   │   │   ├── tool.ts           # Tool 接口 + ToolRegistry
│   │   │   ├── hooks.ts          # Graph/State Hook 系统
│   │   │   ├── goal-manager.ts   # 目标生命周期管理
│   │   │   ├── skills.ts         # 技能热加载
│   │   │   ├── memory.ts         # 记忆管理
│   │   │   ├── aura-memory.ts    # Aura 语义记忆
│   │   │   ├── compaction-model.ts  # 上下文压缩
│   │   │   ├── execution-state.ts   # 执行状态机
│   │   │   ├── retry.ts          # 重试与退避
│   │   │   ├── state-inject.ts   # 状态注入 (Git/时间线)
│   │   │   ├── agent-store.ts    # Agent 状态持久化
│   │   │   └── tools/
│   │   │       ├── coding.ts     # 33 个编码工具
│   │   │       ├── hologram.ts   # 图谱工具 (从 MCP 动态加载)
│   │   │       └── subagent.ts   # agent_spawn 工具
│   │   ├── provider/           # LLM Provider 抽象
│   │   │   ├── types.ts          # 统一 Message/Chunk/ToolCall 类型
│   │   │   ├── anthropic.ts      # Anthropic 实现
│   │   │   └── openai.ts         # OpenAI 实现
│   │   ├── ui/                 # UI 组件 (3D 星图/聊天/面板)
│   │   ├── workspace.ts        # Workspace 统一状态容器
│   │   ├── bridge.ts           # Tauri IPC 桥接
│   │   └── settings.ts         # 设置与凭证
│   └── package.json
│
├── hologram.constraints.yaml   # 约束配置
├── .mcp.json.example          # MCP 接入示例
└── build.cmd                  # 构建脚本
```

---

## 9. 关键设计决策

### 9.1 为什么 Engine 是独立二进制

Engine 编译为独立的 `hologram-engine.exe`，既可作为 Tauri 的子进程运行，也可独立 `serve` 作为 MCP 服务器。这保证了：
- 外部 MCP 客户端无需安装桌面应用即可使用图谱能力
- Engine 崩溃不影响 Tauri Shell，Shell 可重启 Engine
- Engine 的性能不受 Tauri 的 WebView 开销影响

### 9.2 为什么 Tauri 只做转发

Tauri Shell 的 `rpc.rs` 有 99 个方法但几乎不含分析逻辑。所有图谱操作转发给 Engine，Shell 专注于进程管理、权限削决、沙箱隔离。这种分离使得：
- 权限引擎在 Engine 不可用时仍然生效
- Engine 的测试可以完全不涉及 Tauri
- 非 Tauri 的 Engine 消费者（纯 MCP 客户端）也能获得完整图谱能力

### 9.3 为什么 Agent 在前端

Agent 循环在 TypeScript 中运行（而非 Rust），因为：
- LLM streaming 在 JS 生态中更成熟
- UI 更新与 Agent 循环同线程，避免跨语言状态同步
- 工具调用的 UI 反馈（权限卡片、进度条）天然低延迟

后端通过 `rpc()` 单入口提供所有能力，前端通过 `ToolRegistry` 动态组装工具列表（图谱工具从 MCP `tools/list` 动态加载，编码工具静态注册）。

### 9.4 为什么用 git worktree 做 Agent 隔离

相比虚拟机或容器，git worktree：
- 零开销：共享同一仓库的 .git，只创建工作目录
- 原生合并：cherry-pick 提供标准的三方合并
- 可审计：worktree 的每个 commit 都是审计点
- 冲突安全：合并失败时返回 diff，不破坏主仓库状态
