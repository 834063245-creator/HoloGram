<p align="center">
  <img src="assets/banner.png" alt="HoloGram" />
</p>

<p align="center">
  <strong>© 2026 Wenbing Jing. Licensed under MIT.</strong><br/>
  <em>This software is free for any use. Attribution required.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/github/v/release/834063245-creator/HoloGram?color=orange" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-417%2B%20total-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows-blue" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

<br/>

<table align="center" style="border-collapse: collapse; border: none;">
<tr>
<td align="center" valign="middle" style="padding: 18px 40px; background: #000000; color: #ffffff; border: none;">
  <h1 style="margin:0;font-size:28px;font-weight:900;color:#ffffff;">▍MCP 服务 · 不是桌面应用</h1>
  <p style="margin:6px 0 0 0;font-size:15px;color:#cccccc;">单文件引擎 &nbsp;·&nbsp; 零依赖 &nbsp;·&nbsp; 配进 Claude Code / Cursor 直接用 &nbsp;·&nbsp; 省 token = 省钱<br/>桌面端只是可选的可视化壳，<strong style="color:#ffffff;">不开桌面应用完全不影响使用</strong></p>
	  <p style="margin:10px 0 0 0;font-size:16px;"><a href="#install" style="color:#ffcc00;font-weight:bold;">👇 点这里直接跳到"一句话安装"</a><span style="color:#ffcc00;">，复制粘贴发给 Agent，自动装好。</span></p>
</td>
</tr>
</table>

<br/>

> **代码依赖可视化与影响分析。** 26 门语言统一 IR，全库依赖一张图。四级过滤自动排除三方/生成代码，改前查波及范围，改后验架构边界。MCP 模式下，原本要读 N 个源文件才能理清的依赖链，一次工具调用几十行 JSON 返回——**省 token，就是省钱。**

---

## 核心能力

| 能力 | 说白了就是 |
|---|---|
| **改前查影响** | 改一个文件 → 立刻看到会波及哪些文件、哪些模块。不用搜、不用一层层翻代码。内置 Agent 的 preflight hook 在 `edit_file` / `write_file` 执行前**自动注入 ⚠️ 影响分析**——Agent 不用主动调工具，信息直接出现在结果顶部。 |
| **自动抓越界** | 模块之间乱 import？自动标红。你定规则，它替你盯着。 |
| **给 Agent 省 token** | Claude Code / Cursor 里直接用。Agent 不用读源文件猜依赖，一次调用拿答案，省 **70%-95%** token。 |
| **3D 代码地图** | 代码库变星图，谁依赖谁、谁在调用谁，一眼看穿。5000 个文件不卡。 |
| **保存即刷新** | 代码改了保存 → 图自动更新。缓存过期检测——源文件更新时自动重分析。 |
| **26+3 门语言，零配置** | Python · TS/JS · Go · Rust · Java · C/C++ · Ruby · Lua · C# · Swift · Dart · Scala · Haskell · HTML · CSS · PHP · OCaml · R · Nix · Bash · YAML · Zig · Elixir · Erlang · Kotlin · TOML · Markdown。打开项目直接出图。 |

---

## 为什么不同

| **🌍 跨语言统一 IR** | **🤖 图为 Agent 而生** | **🔬 自举验证** |
|---|---|---|
| 26 门语言全部映射到同一张图——不是分别解析再拼接，而是一个统一中间表示。TypeScript 调 Python、Rust 调 Go，跨语言依赖链照样追踪。引擎内置 tree-sitter 适配器，每种语言的 import / call / 符号定义统一建模。 | 不是"把源文件丢给 LLM 让它自己看"。全库依赖提前算好，存进 MemoryIndex（邻接表 + 倒排索引）+ SQLite FTS5。Agent 调工具拿的是**结构化依赖数据**，不是源文件。一次调用几十行 JSON = 原本要读十几个文件才能拼出的依赖全景。 | HoloGram 用自己的引擎分析自己的代码库。项目根目录下的依赖图随时可查——既是质量保障，也是活样本。380 个 Rust 测试 + 37 个前端测试，每次提交前引擎自检。 |

---

## 截图

<p align="center">
  <img src="assets/screenshots/01-star-graph.png" width="32%" />&nbsp;
  <img src="assets/screenshots/02-galaxy-fold.png" width="32%" />&nbsp;
  <img src="assets/screenshots/03-agent-chat.png" width="32%" />
</p>
<p align="center">
  <img src="assets/screenshots/04-impact-analysis.png" width="32%" />&nbsp;
  <img src="assets/screenshots/05-constraint-check.png" width="32%" />&nbsp;
  <img src="assets/screenshots/08-detail-card.png" width="32%" />
</p>
<p align="center">
  <img src="assets/screenshots/10-translator.png" width="65%" />
  <br/><sub>🔄 代码翻译器 — 选中源文件，LLM 逐行翻译，三栏并排审计</sub>
</p>

---

## Agent 详解

HoloGram 的 Agent 不是"接了个聊天框"——图和 Agent 是同一系统的两层，天然联动。

| 能力 | 说明 |
|---|---|
| **27 个内置 MCP 工具** | explore / neighbors / impact / path / coupling-report / blindspots / cycle / fragile / community / history / search / check / run_preflight / health / graph_diff / timeline / policy-check / rename / clusters / node / unused / dataflow / analyze / run_health / delayed / status / graph_summary / thread_conflicts。全部走图数据库查询，不读源文件。 |
| **Preflight 自动影响分析** | Agent 调 `edit_file` / `write_file` 时，preflight hook 在工具执行前用内存 fileIndex 即时评估波及范围——被依赖最多的符号、风险等级（LOW/MEDIUM/HIGH）、引导调 `hologram_impact` 深挖。< 0.1ms，零延迟。 |
| **Read Enrichment 自动注入** | Agent 读文件时，结果顶部自动附上该文件的符号概览 + 被依赖关系 + 引导调 `hologram_explore` 深挖。Agent 不用主动调用，图信息自动到眼前。 |
| **Agent ↔ 星图双向实时联动** | Agent 调工具 → 3D 视图实时响应。path → 路径高亮，fragile → 脆弱节点标琥珀，cycle → 循环节点标红，impact → 聚焦飞行，diff → 绿增红删。 |
| **图作为输入设备** | Shift+双节点 → BFS 最短路径 → Agent 自动分析依赖链风险。Alt+框选区域 → Agent 自动总结模块关系。单击任意节点 → 详情卡 + "问 Agent"入口。 |
| **全面板覆盖** | 星图详情卡 · 简报违规行 · 文件查看器 · 时间轴事件 · 约束面板——5 个面板全部有"问 Agent"按钮，点一下自动带上下文。 |
| **Agent 透镜** | 图上只亮 Agent 访问过的节点（其余降至 1% 透明度），渐变虚线串联最近推理步骤。一键切换，看清 Agent "看过哪里"。 |
| **NL 自然语言探索** | `hologram_explore` 接受自然语言查询——"DataRequest 怎么 validate"——引擎自动切词消歧，BFS 路径搜索，一次返回调用链 + 波及范围 + 源码 + 架构告警。 |
| **子 Agent 分叉** | `spawnSubAgent` — `fork` 模式继承父上下文 + fork 指令（子 Agent 在 git worktree 隔离环境执行），`fresh` 模式干净起跑。子 Agent 完成后自动 diff 并回传结果。 |
| **上下文窗口管理** | 窗口使用率 70% 时自动压缩：LLM 生成结构化摘要（目标 / 决策 / 文件 / 错误 / TODO），释放上下文空间。支持手动 `/compact`。 |
| **Storm Breaker 死循环检测** | 连续 3 次相同工具 + 相同错误 → 自动注入循环预警到工具结果中，防止 Agent 陷入死循环。 |
| **并行工具执行** | 只读工具（`hologram_*` / `read_file` 等）并行执行，破坏性工具（`edit_file` / `bash` 等）串行执行。按 `tool.readOnly()` 自动分批。 |
| **记忆系统** | 跨会话持久记忆，四档置信度（fact / reference / background / suppressed），7 个管理工具（`memory_add` / `memory_search` / `memory_get` / `memory_list` / `memory_update` / `memory_delete` / `memory_refresh`）。项目级 `.hologram/memory/*.md` + 全局 `~/.hologram/global_memory/*.md`，自动注入系统提示词。 |
| **任务管理** | Agent 自管理 5 个工具：`task_create` / `task_update` / `task_list` / `task_get` / `task_stop`。状态生命周期：pending → in_progress → completed / cancelled。会话内追踪。 |
| **权限系统** | 全息式审批弹窗（脉动指示器 + 终端风格参数展示 + allow/deny/remember）。6 步裁决级联：工具 Deny → 工具 Ask → 工具自检 → 模式检查 → 工具 Allow → 默认放行。4 层安全：Tool 规则 + Bash 危险检测（11 种）/ 文件安全 / Git 子命令 + 旁路免疫层 + 审计日志。 |
| **工具输出截断** | 每个工具返回上限 32KB，超出部分截断并附工具专属建议（如"用 offset/limit 翻页"、"缩窄路径"）。防止上下文污染。 |
| **提示缓存追踪** | 双提供商按 1M token 计价，累计会话缓存命中/未命中统计。 |
| **Web 搜索集成** | `web_search` 工具 → LLM 自动总结原始搜索结果 → 结构化结论。 |
| **会话恢复** | 对话历史自动保存到 `.hologram/sessions/`（每个会话独立 JSON），重启或切换项目后恢复。支持消息插入和回合撤回。 |
| **Agent 隔离** | 子 Agent 在 git worktree 沙箱中运行（`.hologram/worktrees/agent-{id}`），双向路径映射（主仓库 ↔ worktree）。完成后自动 cherry-pick 合并或丢弃清理。 |

---

## 📐 技术规格

| 🧠 耦合诊断 | ⚡ 全量引擎 | 🛡️ 约束门禁 |
|---|---|---|
| L1 同包 → L2 跨包 → L3 数据/IO → L4 时序/异步。L4 穿透自动标红。动态调度合成：callback / observer 边自动检测。 | 存储引擎 v3：MemoryIndex（邻接表 O(degree) 查询）+ SqliteDb（FTS5 全文搜索）+ 增量更新（watcher → 防抖 → 原子 swap）。合并管线 v3/v4：逐批并行解析 + 序列化合并 + 全局边去重（625× 削减）。 | YAML 自定义规则：模块隔离、import 白名单、表访问限制。违规编码在 JSON 中，可直接入 CI 流水线。 |

| 📦 序列化 | 🔌 MCP 长驻 | ✅ 测试 |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制冷启秒开 · SQLite + FTS5。缓存优先：已有缓存即显，后台静默更新。 | JSON-RPC over stdio + TCP :9777 双模。崩溃 3 次/60s 自动降级。Tauri 启动时自动 spawn。 | 380 Rust `#[test]`：图模型、适配器、管线、耦合、社区发现、路由、存储引擎、MCP 协议全覆盖。 |

### 图数据模型

**节点（8 种，统一 IR）：**

| 节点 | 说明 | 节点 | 说明 |
|------|------|------|------|
| `Symbol` | 通用符号 | `Function` | 函数 / 方法 / 构造器 |
| `Class` | 类 / 结构体 / 枚举 | `Module` | 命名空间 / 包 |
| `File` | 源文件 | `Interface` | 接口 / trait / 类型别名 |
| `Medium` | 存储 / IO 介质 | `Temporal` | 异步任务 / 定时器 |

> 每个节点携带 `location`（文件:行号）、`out_degree` / `in_degree`（O(1) 度查询）、`community_id`、`position`（3D 坐标）。

**边（10 种，分三大类）：**

| 类 | 包含 | 说明 |
|---|---|---|
| **结构边** | `imports` `calls` `inherits` `defines` | 导入、调用、继承、定义 |
| **数据边** | `reads` `writes` `shares` | 读/写/共享数据，自动追踪 → Medium 节点 |
| **时序边** | `triggers` `awaits` `sequences` | 异步触发、等待、顺序执行，带 `temporal_delay_sec` |

每条边附加 `coupling_depth`（L1-L4）、`cross_file`、`direction`、`lsp_resolved`。

### 27 个 MCP 工具

引擎通过 JSON-RPC 2.0 over stdio 暴露 27 个工具。所有工具走图数据库查询，不读源文件。别名 `hologram_preflight` / `hologram_community_report` / `hologram_diff` 也可用。

#### 聚合类

| 工具 | 参数 | 说明 |
|------|------|------|
| **explore** | `query` 自然语言或符号名<br/>`symbols` 符号名数组（二选一）<br/>`includeSource` 是否返回源码（默认 true） | 统一聚合查询，一次返回 6 部分：Flow（双向 BFS 调用路径，含文件:行号） + Blast Radius（波及范围，区分依赖方/测试） + Relationships（符号间边，按类型分组） + Source Code（声明行 ±30 行上下文，28000 字符预算） + Architecture Alerts（循环/脆弱/L4/线程冲突） + Metadata。NL 输入自动分词消歧。 |
| **graph_summary** | 无参数 | 图摘要：节点总数 / 边总数 / 各类型数量分布。 |

#### 路径类

| 工具 | 参数 | 说明 |
|------|------|------|
| **neighbors** | `node_id` 节点 ID（必填） | 一阶邻居，返回邻居节点列表 + 所有出入边（含 `coupling_depth`）。 |
| **impact** | `node_id` 源节点（必填）<br/>`depth` BFS 最大深度（默认 3） | BFS 分层波及分析，返回每层节点列表。 |
| **path** | `from_id` + `to_id`（必填）<br/>`depth` 搜索深度（默认 20） | 两节点间最短路径，含跳数和边类型。 |
| **search** | `query` 部分名称或 ID（必填）<br/>`limit` 最大结果数（默认 20） | 模糊搜索节点，FTS5 优先，回退线性扫描。 |

#### 风险类

| 工具 | 参数 | 说明 |
|------|------|------|
| **fragile** | `limit` 返回条数（默认 5） | Top N 脆弱模块，按 L4 封装穿透密度排名。 |
| **cycle** | `mode` 过滤器：`all` / `data` / `llm`（默认 all） | 循环依赖检测，按模式分类返回。 |
| **thread_conflicts** | `node_id` 可选 | 线程 × 共享资源冲突矩阵。扫描项目 + 图 Medium 节点。 |
| **coupling_report** | `module_name` 模块文件路径（必填） | 完整 L1-L4 耦合深度分布（L1/L2 来自结构图，L3/L4 来自数据流引擎）+ fragility score。 |
| **blindspots** | `filter` 边界类型过滤（默认 all） | 架构盲区聚合：L4 封装穿透 + 未加锁并发 + 循环依赖。 |
| **run_preflight** | `files` 文件路径数组（必填） | 改前三步预演：① 结构波及（BFS impact）② 数据流分析（共享变量→L3，时序边→L4）③ 综合风险等级（LOW/MEDIUM/HIGH）。 |
| **policy_check** | `rules` 规则数组 或 `source` + `target` 快捷模式<br/>`edge_kinds` 边类型过滤（默认 `["imports"]`） | 架构边界规则引擎。支持 glob 和 regex 模式自动识别，10 种边类型。违规去重，每条规则独立通过/失败/违规数，支持自定义 message。可直接接入 CI。 |

#### 社区类

| 工具 | 参数 | 说明 |
|------|------|------|
| **community** | `node_id` 节点 ID（必填） | 节点社区归属（社区 ID、标签、成员数、兄弟节点列表）。 |
| **clusters** | `min_size` 最小社区规模（默认 3）<br/>`max_nodes` 输出截断（默认 20，最大 200） | 代码库社区/集群结构报告，社区标签按最常见文件词干自动派生。 |

#### 深潜类

| 工具 | 参数 | 说明 |
|------|------|------|
| **node** | `node_id` 节点 ID（必填） | 单节点完整信息：身份 + 出入度 + 社区 + 所有出入边按 `coupling_depth`/`cross_file`/`temporal_delay_sec` 分组。`hologram_neighbors` + `hologram_community` 的合体版。 |
| **unused** | `limit` 最大结果（默认 20，最大 200）<br/>`kind_filter` 节点类型，逗号分隔（默认 `"function,class"`） | 潜在死代码：in_degree=0 的符号，按 out_degree 降序排列——影响最大的排最前。 |
| **dataflow** | `files` 文件路径数组（必填） | **走 tree-sitter 重解析，不走图数据库。** 按函数追踪变量读写 + 跨函数共享状态（含读写者列表）+ 异步触发 + 调用序列。 |

#### 时间线类

| 工具 | 参数 | 说明 |
|------|------|------|
| **history** | `node_id` 节点 ID（必填） | 全局时间线（最近 20 条）+ 该节点出入度统计。 |
| **delayed** | `files` 文件路径数组（可选） | 查询数据流引擎，返回异步代码模式：triggers、awaits、sequence_calls 及延迟值。 |
| **timeline** | `limit` 最大事件数（默认 100） | 因果审计时间线，含末次变更记录。 |
| **graph_diff** | `before_path` 基线 JSON 路径（必填） | 当前图 vs 基线快照 diff——增/删/改节点和边。基线不存在时自动创建。 |

#### 工程类

| 工具 | 参数 | 说明 |
|------|------|------|
| **analyze** | `path` 项目根目录（必填） | 后台异步重分析项目，非阻塞，立即返回"已启动"。 |
| **run_check** | `path` 项目根目录（必填） | 全量约束校验：保存基线 → 重分析（**同步阻塞**）→ diff → 约束验证 → 时间线记录。 |
| **run_health** | `path` 项目根目录（必填）<br/>`days` 回溯天数（默认 30） | 健康评分 0-100：图密度 40 分 + 耦合健康 30 分（L4 比）+ 脆弱评分 20 分 + 循环评分 10 分。含各维度明细。 |
| **rename** | `oldName` + `newName`（必填）<br/>`dryRun` 仅预览（默认 false） | 图内安全重命名（节点名 + 持久化存储），预览模式显示匹配节点/文件。 |
| **status** | 无参数 | 引擎状态（phase / store / 节点数 / 边数 / 辅助索引 / 文件监听）。 |

#### MCP 工具 vs Agent 内置工具

Agent 的工具集由两部分组成：MCP 引擎提供的 27 个图查询工具 + Agent 自身内置的 51 个操作工具。所有工具对 Agent 透明——Agent 不区分来源，统一调用。

| 来源 | 数量 | 类别 | 工具 |
|---|---|---|---|
| **MCP 引擎** | **27** | 图查询 / 风险 / 社区 / 深潜 / 时间线 / 工程 | `hologram_explore` `hologram_neighbors` `hologram_impact` `hologram_path` `hologram_search` `hologram_fragile` `hologram_cycle` `hologram_thread_conflicts` `hologram_coupling_report` `hologram_blindspots` `hologram_run_preflight` `hologram_policy_check` `hologram_community` `hologram_clusters` `hologram_node` `hologram_unused` `hologram_dataflow` `hologram_history` `hologram_delayed` `hologram_timeline` `hologram_graph_diff` `hologram_analyze` `hologram_run_check` `hologram_run_health` `hologram_rename` `hologram_status` `hologram_graph_summary` |
| **Agent 内置** | **51** | | |
|  | 9 | 文件操作 | `read_file` `write_file` `edit_file` `list_directory` `create_directory` `delete_file` `move_file` `rename_file` `read_constraints` |
|  | 13 | Git | `git_status` `git_diff` `git_log` `git_stage` `git_commit` `git_push` `git_pull` `git_init` `git_checkout` `git_create_branch` `git_discard` `git_stash_push` `git_stash_pop` |
|  | 3 | Shell | `run_shell` `bash_output` `bash_kill` |
|  | 6 | 数据流追踪 | `dataflow_save` `dataflow_query` `dataflow_list` `dataflow_delete` `dataflow_verify` `dataflow_stale_check` |
|  | 5 | Agent 隔离 | `agent_isolation_create` `agent_isolation_diff` `agent_isolation_merge` `agent_isolation_discard` `agent_isolation_status` |
|  | 5 | 任务管理 | `task_create` `task_update` `task_list` `task_get` `task_stop` |
|  | 4 | 记忆系统 | `hologram_memory_save` `hologram_memory_read` `hologram_memory_list` `hologram_memory_delete` |
|  | 2 | 代码搜索 | `search_content` `glob` |
|  | 2 | Web | `web_search` `web_fetch` |
|  | 1 | 子 Agent | `agent_spawn` |
|  | 1 | 交互 | `ask_user` |
|  | 4 | 别名 | `hologram_history`→`hologram_node`（Agent 侧） `hologram_preflight` `hologram_community_report` `hologram_diff`（MCP 侧） |

> **MCP 工具**走图数据库（MemoryIndex + SQLite FTS5），不读源文件，省 token。**Agent 内置工具**走 Tauri IPC → Rust 后端，直接操作文件系统、Git、Shell 等。

### 分析管道

| 阶段 | 说明 |
|------|------|
| 1. 文件发现 | 四级过滤 — 硬编码黑名单（30 目录名）+ `.gitignore` 解析 + 扩展名匹配 + 1 MB 上限。skip vendored/generated/三方库 |
| 2. 并行解析 + 合并 | 200 文件/批，rayon 并行 parse，串行 merge。全局节点去重（`loc_index`）+ 全局边去重（`edge_index`，二级快慢路径，625× 削减）。CST 逐批后台释放，不阻塞主线 |
| 3. LSP 类型感知调用解析 | 8 门语言 LSP 类型级调用解析，30s 超时熔断。跨文件类型级调用边补充 |
| 4. 跨文件解析 | import → 调用链连接，跨文件符号引用关系 |
| 5. 耦合分析 | 所有边赋值 L1-L4 耦合深度 |
| 6. 框架路由 | 8 种框架 URL→handler 映射注入（Django / Express / FastAPI / Flask / Rails / Spring / Gin / NestJS） |
| 7. 动态调度合成 | addEventListener / .on() / .then() / .subscribe() 回调边补充 |
| 8. 社区发现 + DB | Leiden 层次社区发现（Phase 1 扁平 + Phase 2 层级），MemoryIndex + SQLite 持久化 |

> 数据流追踪改为按需查询（`hologram_dataflow`），不再在管道中预计算。

### 智能过滤（四级）

| 层级 | 机制 | 说明 |
|------|------|------|
| L0 — 硬编码 | 30 个通用目录黑名单 | `.git` `node_modules` `target` `venv` `vendored` `generated` `tests` 等 |
| L1 — `.gitignore` | 项目树中所有 `.gitignore` 解析 | 目录名模式提取，零配置适配项目特定排除（`.idea` `bin/` `dist/` 等） |
| L2 — 扩展名 | 仅收录 26+3 门已注册语言 | 非源码文件自动跳过（二进制、文档、配置等） |
| L3 — 文件大小 | > 1 MB 跳过（`metadata()` 预检，不读盘） | 兜底：巨型 vendored blob（sqlite3.c 9.3 MB、parser.c 0.5-1 MB） |

### 框架路由

8 种框架的 URL→handler 模式检测（tree-sitter 图案匹配，非 LSP）：

| 框架 | 检测模式 |
|------|----------|
| **Django** | `path()` / `re_path()` / `url()` |
| **Express** | `app.get()` / `router.post()` / `app.use()` |
| **FastAPI** | `@app.get()` / `@router.post()` |
| **Flask** | `@app.route(path, methods=[...])` |
| **Rails** | `get '/path', to: 'ctrl#action'` |
| **Spring** | `@GetMapping` / `@PostMapping` |
| **Gin** | `r.GET()` / `r.POST()` / `r.Group()` |
| **NestJS** | `@Controller('prefix')` + `@Get()` |

### LSP 后端

8 门语言 LSP 类型级调用解析（独立于框架路由）：

| 语言 | LSP 后端 |
|------|----------|
| Python | Pyright / Pylance |
| TypeScript / JavaScript | TypeScript 语言服务 |
| Go | Gopls |
| Java | JDTLS |
| C# | OmniSharp / Dev Kit |
| C / C++ | Clangd |
| PHP | Intelephense |
| Kotlin | Kotlin 语言服务 |

### 存储引擎

| 组件 | 特点 |
|------|------|
| **MemoryIndex** | 邻接表（出边 + 入边）+ 倒排索引（name_index + file_index），O(degree) 查询 |
| **SqliteDb** | hologram.db 持久化 + FTS5 全文搜索 + timeline 事件合并 |
| **GraphStore** | MemoryIndex + SqliteDb，`parking_lot::RwLock` N 路并发读 |
| **图形合并器** | v3 逐批并行解析 + 序列化合并，v4 全局边去重（`edge_index` 二级快慢路径，625× 削减） |
| **IncrementalUpdater** | watcher → 防抖 → 增量（重解析 → diff → 边修复 → validate → 原子 swap），失败回退全量 |

---

<a id="token-save"></a>
## 💸 Token 节省实测

**场景：改 `auth.py` 里的 `validate_token()` 函数，要查波及哪些文件、会不会越界。**

---

### 不用 HoloGram：Agent 逐层翻文件

Agent 没有全局依赖图，只能像人一样一层层读源码推依赖链。

| 步骤 | Agent 在干什么 | 实际消耗 |
|---|---|---|
| 1 | 读 `auth.py`，找到 `validate_token` 的定义和它 import 了谁 | 约 800 token（源文件 + 推理） |
| 2 | 发现 import 了 `models.py` → 读 `models.py`，确认哪些被 `validate_token` 用到 | 约 700 token |
| 3 | 发现 import 了 `utils.py` → 读 `utils.py` | 约 600 token |
| 4 | 全局搜索谁调了 `validate_token`（grep/读引用列表） | 约 400 token |
| 5 | 搜到 `middleware/auth_mw.py` 调了 → 读它 | 约 800 token |
| 6 | 搜到 `api/users.py` 调了 → 读它 | 约 700 token |
| 7 | 搜到 `api/admin.py` 调了 → 读它 | 约 600 token |
| 8 | Agent 综合推理、判断哪些是真正会被波及的、输出结论 | 约 1,200 token |
| 9 | 漏了：`scheduler/tasks.py` 通过 `call_capability` 间接调用 — Agent 没翻到 | **漏报** |

> **单次查询消耗：约 5,800 token。** 这还只是 7 层深、3 个直接调用者的简单情况。依赖链更深、调用者更多时，轻松破万。
>
> **更大的问题：弱模型容易翻漏。** 第 9 步那种间接调用，Agent 没全局索引根本发现不了——漏一个，后面改了就炸。

---

### 用 HoloGram：一次工具调用

全库依赖提前算好，Agent 不读源文件，不推理依赖链。

| 步骤 | Agent 在干什么 | 实际消耗 |
|---|---|---|
| 1 | 调 `hologram_explore("validate_token auth")` → 引擎 BFS 遍历全库依赖图 + NL 搜索，返回：正向（它依赖谁）+ 反向（谁依赖它）传递闭包、波及模块清单、跨模块能力调用、风险等级 | 约 500 token（入参） |
| 2 | 引擎返回结构化 JSON：4 个直接调用者 + 1 个间接调用者 + 2 个被依赖文件 + 0 条越界违规 + 风险等级 LOW | 约 1,200 token（结果） |
| — | Agent 直接输出结论，不需要推理依赖链 | 0 token |
| — | `scheduler/tasks.py` 的间接调用 → 图里有 `capability_call` 边，**没有漏** | **零漏报** |

> **单次查询消耗：约 1,700 token。**
>
> 省 **4,100 token / 次**（<strong style="color:#ff3333;font-size:18px;">70%</strong>），且不会漏。

---

### 拉长了算

| | 不用 HoloGram | 用 HoloGram | 省 |
|---|---|---|---|
| **单次依赖查询** | ~5,800 token | ~1,700 token | **4,100 token（<strong style="color:#ff3333;font-size:18px;">70%</strong>）** |
| **一次编码会话（5 次查询）** | ~29,000 token | ~8,500 token | **~20,000 token** |
| **重度用户月均（30 次会话）** | ~870,000 token | ~255,000 token | **~600,000 token** |
| **十人团队月均** | ~8,700,000 token | ~2,550,000 token | **~6,000,000 token** |

按 Claude 均价 $20/MTok 估算：**单人月省 ~$12，十人团队月省 ~$120。**

> 上面是保守场景。实际使用中，依赖链更深（10-20 层常见）、调用者更多（几十个不稀奇）、模块边界合规要扫全库（Agent 传统做法根本不可行）——**省 80% 是常态。**
>
> **Token 省的是小头。大头是：弱模型推依赖不可靠，漏一个修一天。HoloGram 给的是确定答案。**

---

### 🧪 真实案例：FirstBeat Ultimate 项目体检

**2026-06-21，一次完整的项目健康检查。**

- 项目规模：**218 个符号、322 条边、~4,400 行 Python**（21 个源文件）
- 任务：全面体检——循环依赖、脆弱模块排名、社区聚类、波及分析、架构盲区、健康评分
- 共调 **15 次工具**（HoloGram 13 次 + 代码验证 2 次）

| | 不用 HoloGram | 用 HoloGram | 倍数 |
|---|---|---|---|
| **总消耗** | **~300,000 token** | **~14,000 token** | **21x** |

不是估算，不是假想场景。下面拆到每次操作。

---

#### 逐项拆解

| 你想知道的 | HoloGram 1 次调用 | 不用 HoloGram 要怎么做 | 省多少 |
|---|---|---|---|
| **有没有循环依赖？** | `hologram_cycle` → 200 token | 读完全仓 21 个 .py（~4,400 行），人工追踪所有 import + 调用关系，画图找环 | **~100K token** |
| **哪些模块最脆弱？** | `hologram_fragile` → 300 token | 对 218 个符号逐个 grep 所有引用位置，按 fan-in 排序 | **~50K token** |
| **整体结构（社区聚类）** | `graph_summary` + `community_report` → 2,500 token | 读完所有文件后人工将 218 个符号分到 32 个社区——**基本不可行** | **~100K token** |
| **改 engine.close 一行会炸多少？** | `hologram_impact` → 800 token 返回 63 节点 BFS 树（depth=3） | 从 engine.close 出发手动追踪 3 层调用链，涉及 8-10 个文件 | **~30K token** |
| **有时序耦合/盲区吗？** | `delayed` + `blindspots` → 200 token | grep 所有 threading/async/time.sleep 等异步模式，人工判断是否构成耦合 | **~8K token** |
| **给个健康分？** | `run_health` → 150 token | **无法手工计算**——健康分需要完整依赖图 + 历史快照对比 | **∞** |
| | | **手工合计** | **≈ 300,000 token** |

---

#### 最大的三个节省点

| 操作 | 单次调用 vs 手工 | 省多少倍 | 为什么 |
|---|---|---|---|
| 🔍 循环依赖检测 | 200 token vs 100,000 token | **~500x** | 读完 4,400 行代码 + 画拓扑图 vs 一次图数据库查询 |
| 📊 脆弱模块排名 | 300 token vs 50,000 token | **~150x** | 218 个符号逐个 grep fan-in vs 预计算好的 fragility score |
| 🗂️ 社区聚类 | 2,500 token vs 100,000 token | **~40x** | 图算法自动分 vs 人肉读完全仓再试着分组——老实说后者根本做不准 |

---

#### 为什么不是"省 70%"而是"省 95%"

前面 `auth.py` 例子是**单次依赖查询**——查一个函数被谁调用。省 70% 是那个场景的保守估计。

这次体检是**全库级别的综合诊断**：循环检测、脆弱排名、社区聚类、健康评分——这些任务的共同特征是**答案不能靠读一个文件得出，必须遍历全库依赖图**。不用 HoloGram，Agent 得先把 4,400 行代码全部读进上下文、在推理中建图、再跑分析。光是"把代码读进去"就要烧 **100K token**，分析还没开始。

**单点查询省 70%，全局分析省 95%（20 倍以上）。** 项目越大，差距越悬殊。

> **这是真实数据，不是营销文案。拿去给同事看、给老板看——随便验证。**

---

## 怎么用

<a id="install"></a>
### 🧩 MCP 模式（推荐，零界面）

**不需要桌面应用。** 引擎是单文件二进制，26 种语法静态链接 + 3 种动态加载，零依赖。配进 Claude Code / Cursor 直接用。具体省多少 token 见上方 <a href="#token-save">💸 Token 节省实测</a>。

<h3 style="font-size:22px;font-weight:900;">🤙 一句话安装：复制下面这段话，发给 Claude Code / Cursor，Agent 自己搞定——</h3>

```
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载最新版 hologram-engine.exe
2. 放到用户主目录下的 .hologram 文件夹（没有就新建）
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - Windows: ~/.hologram/hologram-engine.exe
   - macOS/Linux: ~/.hologram/hologram-engine（下载后 chmod +x）
   - 参数：serve
4. 重启 AI 编程工具，调 hologram_status 验证
```

**不用懂技术。复制、粘贴、回车。**

> 引擎单文件零依赖，下载即用。想自己编译？见下方"从源码构建"。

### 桌面应用（可选）

从 [Releases](https://github.com/834063245-creator/HoloGram/releases) 下载 `.msi`，双击安装。

打开 → 选项目目录 → 自动分析 → 3D 星图渲染。单击节点看详情，聊天面板问 Agent。引擎同款，加了可视化。

---

## 从源码构建

```bash
git clone https://github.com/834063245-creator/HoloGram.git
cd HoloGram

# 引擎
cd engine && cargo build --release    # → engine/target/release/hologram-engine.exe

# 桌面应用
cd src-tauri && cargo tauri build     # → src-tauri/target/release/bundle/
```

---

## 支持语言

| 语言 | 引擎 |
|---|---|
| Python | tree-sitter |
| TypeScript | tree-sitter |
| JavaScript | tree-sitter |
| Go | tree-sitter |
| Rust | tree-sitter |
| Java | tree-sitter |
| C | tree-sitter |
| C++ | tree-sitter |
| Ruby | tree-sitter |
| Lua | tree-sitter |
| C# | tree-sitter |
| Swift | tree-sitter |
| Dart | tree-sitter |
| Scala | tree-sitter |
| Haskell | tree-sitter |
| HTML | tree-sitter |
| CSS | tree-sitter |
| PHP | tree-sitter |
| OCaml | tree-sitter |
| R | tree-sitter |
| Nix | tree-sitter |
| Bash | tree-sitter |
| YAML | tree-sitter |
| Zig | tree-sitter |
| Elixir | tree-sitter |
| Erlang | tree-sitter |
| Kotlin | tree-sitter · DLL |
| TOML | tree-sitter · DLL |
| Markdown | tree-sitter · DLL |
> 26 门静态链接 + 3 门动态加载（.dll/.so/.dylib），零外部依赖。

---

## 架构

```
┌─ 桌面壳 (Tauri 2) ───────────────────────────────────────────────────────────┐
│  ┌─ 前端 (TypeScript) ──────────────────────┐  IPC  ┌─ Rust 后端 ──────────┐ │
│  │ 3D 星图 (Three.js)  ·  Agent 面板        │◄────►│ 权限裁决 (6 步级联)   │ │
│  │ Monaco 编辑器 · 代码翻译器               │      │ OS 沙箱 (JobObject +   │ │
│  │ 数据流面板 · 热点面板 · 时间轴            │      │   AppContainer)       │ │
│  │ WebGPU 计算着色 · 布局 Worker             │      │ Agent 隔离 (git       │ │
│  │ 设置面板 · LSP 客户端 · 透镜模式          │      │   worktree sandbox)   │ │
│  │ Agent 循环 (子Agent · 记忆 · 任务 ·       │      │ PTY 终端 · 凭证       │ │
│  │   权限弹窗 · 并行执行 · 上下文压缩)        │      │   (DPAPI 加密)       │ │
│  └───────────────────────────────────────────┘      │ 工作区管理 · LSP ·    │ │
│                                                     │ MCP 管理 (崩溃降级)   │ │
│                                                     │ 审计日志 (JSONL)      │ │
│                                                     └───────┬──────────────┘ │
└─────────────────────────────────────────────────────────────┼────────────────┘
                                                              │ TCP :9777 / MCP stdio
            ┌─────────────────────────────────────────────────▼──────────────┐
            │ Rust 引擎 (engine/)                                             │
            │ 合并管线 v3/v4 · 全局边去重 (625×) · 27 MCP 工具               │
            │ MemoryIndex + SQLite FTS5 · 增量更新 · StringArena 字符串池    │
            │ 数据流引擎 (1055 行) · 8 框架路由 · 8 LSP 后端 · 动态调度合成  │
            │ 社区发现 (Leiden) · 四级过滤 · 380 tests                       │
            └────────────────────────────────────────────────────────────────┘
```

> 引擎自启动，Tauri 启动时自动 spawn。**自举验证：HoloGram 用自己的图 debug 自己。**

---

## 开发

```bash
cd engine && cargo test              # 380 tests
cd engine && cargo build --release   # 编译引擎
cargo tauri build                    # 打包桌面应用
cd src-ui && npm run build           # 类型检查 + 打包前端
```

```
engine/          Rust 引擎 — 合并管线 · 四级过滤 · 数据流引擎 · 框架路由 · LSP · 27 MCP 工具
src-tauri/       Rust / Tauri 壳 — 权限系统 · OS 沙箱 · Agent 隔离 · PTY · 凭证 · 审计
src-ui/          TypeScript 前端 — Three.js · Monaco · Agent 循环 · WebGPU · 数据流面板
assets/          图标 · 截图
grammars/        动态语法 DLL (Kotlin / TOML / Markdown)
build/           构建脚本
```

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing
