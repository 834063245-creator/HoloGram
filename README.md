<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <strong>HoloGram — 深空代码拓扑观测站</strong>：把代码库编译成可对话的 3D 依赖星图，并内置多 Agent 编码工作台
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://whyihaveyou.github.io/dsh-suite/"><img src="https://img.shields.io/badge/featured%20on-dsh--suite-4d6bfe" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange&style=flat-square" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-2200%2B-brightgreen?style=flat-square" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux-blue?style=flat-square" /></a>
</p>

---

## 定位

HoloGram 把代码库解析成一张**统一 IR 依赖图**（节点 = 符号/函数/类/模块，边 = 调用/继承/读写/时序/数据流），通过 MCP 协议向 AI Agent 暴露 **35 个默认图查询工具**（注册表共 36 个 schema），并提供 Tauri 2 桌面应用（3D 星图 + 内置多 Agent 编码工作台）与 DeepSeek Harness（DSH）插件集成。

**核心主张：依赖推理应当是确定性的，而不是猜的。**

LLM 分析"改 A 会炸什么"时，靠逐文件读源码推测依赖——弱模型会漏，大项目会翻不动。HoloGram 用 tree-sitter 静态分析预先算好整张依赖图：Agent 一次工具调用拿到结构化事实（影响面、循环、脆弱模块、数据流路径），而不是源文件文本。单点查询省 ~70% token，全局分析省 90%+；省 token 是次要的，**可靠性**是主要的。

引擎是单文件二进制，本地运行、零配置、代码不出机器。它同时服务三种形态，共享同一份内存图与 watcher 增量更新：

- **MCP 服务**（`hologram-engine serve`）—— 接入 Claude Code / Cursor 等任意 MCP 客户端；
- **桌面应用**（Tauri 2 壳）—— 3D 星图 + Monaco 编辑器 + 内置 Agent 工作台；
- **DSH 插件**（`@a834063245/hologram-dsh`）—— 引擎 + 星图打包进 DeepSeek Harness。

---

## 特性总览

| 能力域 | 说明 |
|---|---|
| **多语言静态分析** | 27 种 tree-sitter 语法静态链接，18 族/19 种语言有手工调校的结构与数据流查询（`engine/queries/` 共 38 个 .scm），Kotlin / Markdown / TOML 动态加载 |
| **确定性依赖图** | 9 种节点 / 12 种边，边带 L1–L4 耦合深度、跨文件、时序延迟、LSP 已解析等属性 |
| **深度分析** | 耦合 / 循环依赖 / 脆弱模块 / 架构盲点 / 边界违规 / 执行流 / 语法级数据流 / 社区检测（Leiden + Louvain）/ 24 个框架路由 / gRPC 服务映射 |
| **35 个分析工具** | 影响面、改前预检、死代码、线程冲突、语义向量搜索、SCIP 导入、符号重命名……全部以结构化 JSON 返回 |
| **精确解析** | 按需启动原生 LSP（rust-analyzer / gopls / pyright 等 9 个），`resolve_call` / `infer_type` / `find_implementations` / `find_references` |
| **内置 Agent 编码工作台** | 13 个领域工具（fs / shell / git / search / web / agent / task / memory / browser / desktop / graph / ops / lsp），多 Agent 协作、Plan / Goal 模式、事件溯源会话日志、token 治理 |
| **多厂商 LLM** | 9 个静态模型目录共 73 个模型 + 运行时动态发现，Anthropic / OpenAI 兼容 / DeepSeek / GLM / Qwen / MiniMax / Moonshot / Ollama / opencode；thinking 档位按厂商适配；本地反向代理绕 CORS |
| **Harness 工程模式** | 约束治理（constraints.yaml）、权限引擎（Allow / Deny / Ask / Passthrough）、三层沙箱、git worktree 隔离、审计日志、系统级加密凭证 |
| **3D 星图可视化** | Three.js WebGL + WebGPU 布局 + 星系折叠导航，万节点秒开；Monaco 编辑器点节点即开源码 |
| **增量与自举** | watcher 驱动增量更新（保存即刷新）；HoloGram 用自己的引擎分析自己的代码库 |

---

## 快速开始

### MCP 模式（推荐，1 分钟）

引擎随 [Releases](https://github.com/834063245-creator/HoloGram/releases) 发布（Windows / Linux），安装脚本一键完成。也可以把下面这段话直接发给你的 AI 编程工具，让它自己装：

```text
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载：
   - Windows: hologram-engine-windows-x64.zip
   - Linux:   hologram-engine-linux-x64.tar.gz
2. 解压后运行安装脚本：
   - Windows: 双击 install.cmd
   - Linux:   ./install.sh --user
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - command: hologram-engine
   - args: serve
4. 重启 AI 编程工具，调 engine_status 验证
```

<details>
<summary>手动配置</summary>

**Claude Code** — `~/.claude/mcp.json`：

```json
{
  "mcpServers": {
    "hologram": {
      "command": "hologram-engine",
      "args": ["serve"]
    }
  }
}
```

**Cursor** — Settings → MCP → Add new MCP server：command `hologram-engine`，args `serve`。

</details>

MCP 服务默认暴露 35 个工具；注册表里全部的 36 个 schema（含 legacy 的 `symbol_history`）可通过环境变量 `HOLOGRAM_MCP_TOOLS=*` 放开。

### CLI

引擎自带一站式 CLI，复用与 MCP/桌面端完全相同的引擎逻辑：

```bash
hologram run --list                          # 列出所有工具
hologram run graph_summary .                 # 项目概览（节点/边/解析率）
hologram run trace_impact . --node_id src/main.rs:main   # 影响面
hologram run preflight_check . --files a.rs,b.rs         # 改前检查（exit code 表达结果）
hologram run detect_cycles .                 # 循环依赖
hologram run list_flows .                    # 执行流（按安全敏感度排序）
hologram serve --project-root . --tcp        # MCP stdio 服务（可同时开 TCP :9777）
hologram --stress <path> <iters>             # 压力测试 / 基准
```

### 桌面应用

[Releases](https://github.com/834063245-creator/HoloGram/releases) → 下载 `.msi`（Windows）→ 选项目 → 自动出图。桌面端与 MCP 模式共用同一个引擎进程与数据。

### DeepSeek Harness 集成（hologram-dsh）

引擎 + 3D 星图打包为 DSH bundle 插件 [`@a834063245/hologram-dsh`](https://www.npmjs.com/package/@a834063245/hologram-dsh)：

```sh
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
# 重启后：mcp__hologram__* 工具进工具箱 + 侧边栏「3D 星图」入口
```

- **MCP 图分析工具**直接注入 DSH agent（与桌面/MCP 模式同一引擎、同一份数据）
- **3D 星图**：DSH web 侧边栏入口，全屏渲染项目依赖图（同源自托管，无独立端口）
- **单一数据生命周期**：引擎单进程双入口（MCP stdio + TCP 9777），存量秒开 + watcher 增量更新
- 安装说明与数据模型见 [`dsh-bundle/README.md`](dsh-bundle/README.md)

---

## 图分析引擎

### 数据模型

- **节点**（9 种）：`Symbol`（通用/未分类）· `Function`（函数/方法/构造）· `Class`（类/结构体/枚举）· `Module`（命名空间/包）· `File`（源文件模块）· `Interface`（接口/trait/类型别名）· `Variable`（变量/常量/字段）· `Medium`（存储/IO）· `Temporal`（异步/定时器）
- **边**（12 种）：`Imports` · `Calls` · `Inherits` · `Defines` · `Reads` · `Writes` · `Shares` · `Triggers` · `Awaits` · `Sequences` · `Usage` · `Throws`
- **边属性**：耦合深度 `L1–L4`、跨文件标记、时序延迟（秒）、`lsp_resolved`、`is_synthesized`（启发式合成边）、溯源 metadata

### 分析管线

```
文件发现 → 分批并行解析（200 文件/批，rayon）→ 串行合并（内存有界、无锁、线性）
→ 跨文件引用解析 → L1-L4 耦合分析 → 24 框架路由 → 动态分发/DI/反射/React JSX 合成边
→ 数据流合成（函数级读写 + 共享状态 + async trigger/await 链）→ 社区检测（Leiden/Louvain）
→ 落库（MemoryIndex CSR + SQLite/FTS5 + 语义向量索引）
```

- **Engine 状态机**：`Uninitialized → Loading → Ready ↔ Analyzing → Error`，panic 守卫，重新分析可抢占在途任务
- **增量更新**：watcher（2s 防抖）只重解析变更文件并增量合图，失败自动回退全量；桌面端"保存即刷新"
- **存储**：内存 CSR 索引（高并发读）+ SQLite WAL 持久化 + FTS5 全文 + usearch HNSW 语义向量（MiniLM ONNX 384 维 与 n-gram 双后端自动选择）
- **诚实标记**：eval/动态代码标为不可达，动态 import 标为动态站点，跨语言调用（子进程/HTTP/FFI）以合成边标记运行时桥接点——不假装知道运行时才知道的事

### 语言支持

27 种 tree-sitter 语法静态链接；其中 **18 族适配器有手工调校的查询式结构抽取**（js/ts/tsx 一族、c/cpp 各一族）：

Python · JavaScript/TypeScript/TSX · Rust · Go · Java · C/C++ · C# · Ruby · PHP · Swift · Dart · Scala · Zig · Elixir · Lua · Bash · R

其余静态链接语言（OCaml · Haskell · Nix · HTML · CSS · YAML · Erlang）走 tree-sitter 通用兜底遍历；**JSON 语法在代码中禁用**（数据文件不产生图节点，不浪费解析）；**Kotlin / Markdown / TOML** 通过 `.dll`/`.so` 动态加载（`grammars/`），无需重新编译引擎即可扩展语言。

### MCP 工具面（36 schema，默认 35）

| 域 | 工具 |
|:--|:--|
| 依赖探索（首选） | `explore_deps` `search_symbols` `get_neighbors` `inspect_symbol` `find_dep_path` `graph_summary` `get_community` `cluster_report` `grpc_services` |
| 风险分析 | `trace_impact` `preflight_check` `fragile_modules` `detect_cycles` `thread_conflicts` |
| 架构诊断 | `coupling_report` `arch_blindspots` `check_boundaries` `find_unused` |
| 执行流 | `list_flows` `get_flow` `get_affected_flows` |
| 数据流（语法级启发式，非语义污点） | `trace_dataflow` `async_edges` |
| 框架路由 | 24 种框架 URL → handler 映射（Express / Django / Rails / Spring / Next.js / SvelteKit …），动态 import / 反射 / DI 合成边 |
| LSP 精确（按需启动） | `resolve_call` `infer_type` `find_implementations` `find_references` |
| 工程 | `analyze_project` `validate_project` `project_health` `project_timeline` `rename_symbol` `import_scip` `graph_diff` `engine_status` |
| legacy | `symbol_history`（默认不暴露，`HOLOGRAM_MCP_TOOLS=*` 放开） |

每个工具返回结构化 JSON（不是源文件），并附带推荐的下一步工具；失败时返回带 `guidance`/`fallback` 的降级响应而非硬错误。

### 精确解析：LSP 与 SCIP

- **LSP 管理器**按需拉起 9 个原生语言服务器（rust-analyzer / gopls / pyright / typescript-language-server / clangd / jdtls / omnisharp / intelephense / kotlin-language-server），自研 JSON-RPC 帧协议（字节流定界、快速失败、死壳自愈），提供精确的调用解析 / 类型推断 / 接口实现 / 引用查询
- **SCIP 导入**（`import_scip`）：导入 SCIP 索引提升符号级引用精度，带自动钩子与诚实的跳过统计

---

## 内置 Agent 编码工作台

桌面应用内置完整的多 Agent 运行时（与 DSH 集成共用引擎数据）。改代码前先问图：`graph(symbols → impact → preflight)` 是工作流入口。

### 领域工具（13 个，旧细粒度名已淘汰）

模型可见面上只有 13 个高内聚领域工具，每个工具内部是 `action` 判别联合：

| 领域 | 动作（示例） |
|---|---|
| `fs` | read / write / edit / list / glob / mkdir / move / rename / delete / constraints |
| `shell` | run（bundled bash，构建/测试命令；Windows 原生任务用 pwsh）/ output / wait / kill |
| `git` | status / diff / log / stage / commit / push / pull / checkout / branch / stash / unstash / discard / init / blame |
| `search` | content（源码文本搜索） |
| `web` | fetch（URL 抓取转可读文本） |
| `agent` | spawn / status / kill / message / request / reply / inbox / ack / list / merge / discover / lookup / isolate_*（worktree 隔离全流程） |
| `task` | create / get / list / update / stop / board（TaskBoard） |
| `memory` | save / read / search / list / delete（项目记忆） |
| `browser` | 37 个动作：launch / connect / navigate / snapshot / content / click / type / eval / network / HAR / screenshot / audit …（CDP 控制，多账号会话隔离） |
| `desktop` | probe（进程/窗口探测）· screenshot（需审批） |
| `graph` | 24 个只读动作：symbols / neighbors / impact / path / inspect / explore / community / clusters / summary / cycles / coupling / fragile / blindspots / boundaries / conflicts / async / unused / flows / flow / affected_flows / dataflow / preflight / grpc / diff |
| `ops` | analyze / validate / health / status / timeline / rename / import_scip |
| `lsp` | resolve_call / infer_type / implementations / references |

旧细粒度名（`run_shell`、`write_file`、`git_*`、`search_symbols` 等）保留在注册表但对模型隐藏，调用会被 `retireRedirect` 拦截并返回 `[已淘汰] → 领域动作` 重定向。新增工具必须 `defineTool` + zod v4（一个 schema 同时产出 JSON Schema / 运行时校验 / 类型化参数）。

### Agent 运行时内核

- **声明式装配（agent-core-convergence Phase 6）**：`AgentBlueprint` capability 表驱动装配——新增工具/hook 走 capability 组合，`AgentConfig` 冻结 31 字段不再扩张；capability 表序 = 工具面字节契约（保护 DeepSeek 前缀缓存与 effective 快照）
- **会话事件溯源（Phase 5）**：session 变异只走 `_appendMessage` / `_replaceSession` / `_retractSessionRange` 三个入口，`SessionLog` 事件日志支撑差分对拍、回放与审计
- **生命周期原语（Phase 1–4）**：`Disposer` / `DisposerBag` / workspace epoch 代际防护——工作区级资源获取即登记，切换/退出只调 `_bag.dispose()` + epoch bump，杜绝跨项目串台（发生过的事故见 `INVARIANTS.md`）
- **流式执行**：tool_use 完成即 dispatch（不等整条 stream），同轮只读工具并发执行；工具输出 50KB/2000 行截断；可重试错误指数退避（最多 3 次）；AbortSignal 贯穿，卡死工具不挂死循环
- **token 治理**：工具结果滚动折叠、成本模型驱动的 auto-compact（`compactRatio` 默认 0.55，压缩只作用于发送载荷，session 永为完整历史）

### 多 Agent 协作

- `SubAgentPool`：并发上限 5、队列 20、**默认超时 30 分钟**；`fork`（继承上下文）/ `fresh`（干净启动）两种模式；async spawn 完成后经 MessageBus 通知父 Agent
- **通信层**：有界 inbox（100 条，满了 drop 防背压）、peek + ack、主题拓扑（Tree/Mesh/Star），消息持久化 `.hologram/agents/{id}/inbox.json`
- **共享状态板**：TaskBoard（任务状态 / filesTouched / diff）与 DiscoveryBoard（探索发现，TTL 2h）——均按会话隔离，防跨会话串扰
- **隔离执行**：子 Agent 的编辑在独立 git worktree 中运行（见下文"隔离"），`agent_merge` 进程内串行合并
- 模型可见的子 Agent ID：`sub-{timestamp}-{random}`；worktree ID：`agent-{timestamp}-{random}`

### Plan 与 Goal 模式

- **Plan 模式**：只读探索 + 写计划文件，`exit_plan_mode` 提交方案（可带多选项）给用户审批；写约束由 `planGate` 在执行层拦截，工具 schema 跨模式恒定（保护前缀缓存）
- **Goal 模式**：持久化目标状态（`.hologram/goals/{id}/`，goal/session/index 三文件），跨会话恢复，与普通对话完全隔离；完成靠 `goal_report` 工具

### 记忆体系

| 层 | 实现 |
|---|---|
| 会话记忆 | Agent session JSON（`.hologram/agents/{id}/`） |
| 项目记忆 | `MemoryManager` → `.hologram/memory/*.md`，MEMORY.md 索引 + confidence 四档分级（fact / reference / background / suppressed） |
| Aura 记忆 | `aura.dll` FFI（SDR + MinHash 语义召回），跨会话语义记忆 |
| Memory Bundle | 独立进程 `memory-bundle.exe` + HTTP 客户端（127.0.0.1:9600），进程隔离的记忆服务 |
| 技能系统 | `.hologram/skills/<name>/SKILL.md` 热加载，无需重启 |

### LLM Provider 体系

- **模型目录**：9 个静态 catalog JSON（anthropic 14 / openai 29 / moonshotai 10 / qwen 5 / deepseek 4 / glm 3 / minimax 3 / ollama 3 / opencode 2，共 73 个模型）+ 运行时 `fetchModels()` 拉取 `/models` 动态合并（静态目录同 ID 优先）
- **协议适配**：统一 `Provider` trait 抹平 Anthropic Messages 与 OpenAI 兼容两大协议；流式 chunk 类型 Text / Reasoning / ToolCallStart / ToolCall / Usage / Done / Error
- **thinking 档位**：自动 / low / medium / high / max / off，wire 参数按厂商适配（Anthropic budget_tokens：4k/8k/16k/32k；DeepSeek reasoning_effort：high/max；OpenAI 官方 low/medium/high）
- **本地反向代理**：壳侧起 loopback-only 的 HTTP 代理（127.0.0.1:14570）转发 LLM 请求并强加 CORS 头，绕开浏览器直连 API 的跨域限制，SSE 逐块透传
- **连接探针**：ConnectionProbe 最小连通性验证（成功/失败/耗时），结果持久化
- **凭据**：系统级加密存储（Windows DPAPI / macOS Keychain / Linux secret-tool），本地永不明文

### 一致性门禁

`npm run verify:convergence`（src-ui）：T0 静态断言（AgentConfig 冻结、session 变异入口、capability 序）+ 8 个 frozen baseline 对拍，任何变更破坏契约即失败。record 模式需显式 `CONVERGENCE_RECORD=1`，baseline 变更走审批（`docs/plans/agent-core-convergence/baseline-change-request.md`）。

---

## Harness Engineering（桌面端）

### 约束治理

`hologram.constraints.yaml` 定义不可逾越的架构边界（L5 永远路由、L4 静默破溃默认路由、波及半径阈值、跨社区边容忍、黑白名单）；Agent 编辑文件前必须过 `preflight_check`，引擎按图拓扑计算波及半径/跨社区影响/L4 穿透决定放行或路由人工确认。前端另有内存 fileIndex 的 preflight hook（<0.1ms 零延迟），编辑前把 ⚠️ 警告注入工具结果顶部。

### 权限引擎

- 规则三来源合并：系统 / 项目（`.hologram/permissions.json`）/ 会话，裁决结果四态：`Allow` / `Deny` / `Ask`（danger 红卡）/ `Passthrough`；模式 Ask / Auto / Yolo（Yolo 不旁路 Deny，auto 白名单只放行编辑类工具）
- **Bash 危险命令引擎**：13 类危险模式（rm -rf /、curl|sh、eval/exec/source、sudo/su、写 /dev/*、git push -f main、mkfs、shutdown …）+ PowerShell 特判（Invoke-Expression、iwr|iex、FromBase64String）+ 管道解码检测与可疑命令启发式
- 路径规则对 worktree 自动 reverse-map 回主仓库逻辑路径；`_agent_id` 每次调用显式传递，杜绝并行子 Agent 身份串扰

### 沙箱（三层）

- **OS 层**：Windows Job Object（进程树随父死亡、64 进程 / 1 GiB 上限）；macOS sandbox-exec；Linux bubblewrap；shell 走捆绑 MSYS2 bash（vendor，标准 MSYS2 根布局 `usr/bin` + `tmp`），Windows 原生任务才用 pwsh
- **路径层**：canonicalize + 符号链接/junction 检测，读写边界校验；边界外不静默拒绝，升级为 Ask 弹窗
- **受限文件系统**：统一 I/O 包装（100 MiB 读写上限、30s 超时、3 次瞬态重试、原子写）

### 隔离（git worktree）

每个子 Agent 一个 `git worktree add --detach` 独立工作区：正反向路径映射、范围 cherry-pick 串行合并（清失败≠合并失败）、重启后孤儿 worktree 收养、大 diff（>8K 字符）溢写 `.hologram/spill/` 回传；TTL 清理与合并队列由前端 agent 层纪律保证（见 AGENTS.md）。

### 审计

全部工具调用落 `.hologram/audit.jsonl`（allowed / denied / user_approved / user_denied），配合 `project_timeline` 工具按时间线回溯分析历史。

---

## 桌面端

<p align="center">
  <img src="assets/screenshots/01.png" width="32%" />&nbsp;
  <img src="assets/screenshots/02.png" width="32%" />&nbsp;
  <img src="assets/screenshots/03.png" width="32%" />
</p>

### 3D 星图

- Three.js WebGL 渲染（ACES 色调映射 + UnrealBloom 辉光），每节点 3 个 draw call（Fresnel 内核 + 双层辉光），万节点级瞬时渲染
- **GPU 布局**：WebGPU WGSL 三趟力导向计算，设备不可用时优雅降级 CPU（布局参数锁定，勿改）
- **星系折叠导航**：社区 → 星系 → 星座 → 子星团无限下钻，跨星系边流
- **图数据分页**：`get_graph_page` 逐页拉取（12000/页），全量到齐原子换入单次渲染；watcher diff 增量渲染（无重布局、无相机重置）
- **交互**：hover 屏幕空间拾取、点击详情、Alt 框选、B 键 Blast 波及半径、路径查找、Agent 工具执行透镜/轨迹/热点高亮、diff 绿红覆盖、legend 可点击过滤、聚焦相机飞行

### 编辑器

点节点即开源码：Monaco（懒加载，~5MB 不入初始 bundle）+ 原生 LSP（补全 / 悬停 / 定义 / 引用 / 诊断，诊断缓存按工作区隔离）；浮动标签页、拖拽缩放、Ctrl+S 保存、并排 Diff。

### 聊天与面板

- 虚拟列表聊天（万条消息流畅）：流式渲染、reasoning 块自动折叠、工具调用卡片、子 Agent 消息、Plan 审批卡、权限卡（PromptShelf）
- 工作台面板：简报（Check）/ 约束 / 数据流 / 设置（Provider/Agent/Display/Languages/About）/ 智能体 / 待办；左缘时间轴 HUD（commit/违规/简报脉冲点阵）
- 顶栏 CommandBar + Ctrl+K 命令面板、左右 DockRail 停靠轨、状态栏遥测（节点/边/星座统计）

### 视觉系统

全 UI 统一 `--obs-*` 设计 token（24 个，唯一定义于 `src/app/tokens.css`）：void/glass/line/brass/pass/warn/fail + 字体栈；自托管字体（Fraunces 展示 / JetBrains Mono 数据 / LXGW 文楷正文 / Noto Serif SC）；"墨与黄铜"视觉语言：铅笔=未定稿、墨水=已定稿、烫金=完成、朱砂=风险，全 UI 仅金/朱砂/墨绿三有彩色（见 [`docs/design/visual-language-ink-brass.md`](docs/design/visual-language-ink-brass.md)）。

### 状态管理

面板级状态走 `createScopedStore` 注册表（messages / session / panel / input 四件套 + chat-store 聚合），app 级单例走 shell/dock/overlay store；`ui/events.ts` 旧总线已冻结（存量 ~20 个 import，新代码禁 import）。Workspace 统一状态容器原子化切换（deactivate → open → 注入），`DisposerBag` + epoch 防旧项目串台。

---

## 架构

```
┌─────────────── src-ui (TypeScript) ─────────────────┐
│  React 19 · Three.js 星图 · Monaco · Agent 运行时    │
│  zustand stores · Workspace 统一状态容器             │
└───────────────────────┬─────────────────────────────┘
                        │ typedRpc / typedListen（134 个方法，单一契约）
┌─────────────── src-tauri (Rust / Tauri 2) ──────────┐
│  权限引擎 · 三层沙箱 · worktree 隔离 · ResourceLedger │
│  LLM 反向代理 · 加密凭证 · 审计 · PTY · CDP 浏览器     │
└───────────────────────┬─────────────────────────────┘
                        │ TCP 127.0.0.1:9777
┌───────────────────────▼─────────────────────────────┐
│  engine (Rust，单二进制 hologram-engine)             │
│  tree-sitter AST → 并行管线 → 9 节点/12 边依赖图      │
│  MemoryIndex (CSR) + SQLite/FTS5 + 语义向量          │
│  36 MCP schema（默认 35）· stdio / CLI / TCP 三入口   │
└─────────────────────────────────────────────────────┘
```

| 层 | 目录 | 职责 |
|:--|:--|:--|
| 引擎 | `engine/` | 解析 · 图构建 · 耦合/数据流/社区/脆弱性分析 · 存储 · MCP/CLI/TCP |
| 壳 | `src-tauri/` | Tauri 2 · 权限裁决 · 沙箱 · 隔离 · 生命周期（ResourceLedger 10 服务）· 凭证 · 代理 |
| 前端 | `src-ui/` | 星图渲染 · Agent 运行时 · 多 Agent 编排 · Provider 体系 |

架构决策（为什么引擎独立二进制、为什么权限在壳层、为什么 Agent 在前端、为什么用 worktree 隔离）见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

---

## 工程事实

- **测试**（2026-08-17 实测）：引擎 **697 用例**（lib 669 + bin 27 + doc 1，696 passed / 1 ignored）· 壳 **322 用例**（bin 308 + 集成 14，全绿；pwsh 冒烟在无 pwsh 7 的环境自动跳过）· 前端 **1201 用例 / 116 文件**（1200 passed / 1 skipped；首次全量在并行构建环境下偶发 1 失败，重跑通过）
- **自举**：HoloGram 用自己的引擎分析自己的代码库——当前图快照 **18,119 节点 / 65,508 边**（2026-08-17）
- 实测（Linux kernel 全量，历史基准）：全量分析 1,770s 全程跑完，RSS 646MB；快照写入 2.44GB / 56.3s
- 并行解析 200 文件/批，边去重 625×；增量更新由 watcher 驱动（保存即刷新）
- 三端独立验证：`engine cargo test` · `src-tauri cargo test` · `src-ui vitest run`；前端另有 `npm run verify:convergence` 契约门禁
- 已知盲区以"诚实标记"处理：eval/动态代码标记不可达、动态 import 标记动态站点，不假装知道运行时才知道的事

---

## 从源码构建

```bash
# 引擎（MCP / CLI / DSH 只需要这个；Linux / Windows 均可）
cd engine && cargo build --release

# 桌面应用（Windows；会自动先跑前端构建）
cd src-tauri && cargo tauri build

# DSH 插件（做本地开发用，见 dsh-bundle/README.md）
cd dsh-bundle && npm install --ignore-scripts && npm run pack:bin && npm run build && npm run build:client
```

## 开发

```bash
cd engine && cargo test        # 引擎用例
cd src-tauri && cargo test     # 壳用例（权限/生命周期/隔离）
cd src-ui && npx vitest run    # 前端用例
cd src-ui && npm run build     # tsc --noEmit + vite build
cd src-ui && npm run verify:convergence   # Agent 运行时契约门禁
cd src-ui && npx biome check --write <改动文件>   # 格式（全仓存量基线勿顺手清）
```

项目理解与工作纪律见 [`AGENTS.md`](AGENTS.md)（Codex）与 [`CLAUDE.md`](CLAUDE.md)（内置 Agent）；提交流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；文档总索引见 [`docs/README.md`](docs/README.md)（`docs/archive/` 为已竣工施工稿，勿作现状依据）。

---

## 许可

HoloGram © 2026 Wenbing Jing — [MIT](LICENSE)。第三方组件（tree-sitter 语法库、SQLite、USearch、onnxruntime、mimalloc 等）版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；安全策略见 [SECURITY.md](SECURITY.md)。