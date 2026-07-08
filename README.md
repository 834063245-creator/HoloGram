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
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-363%2B%20total-brightgreen" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/releases"><img src="https://img.shields.io/badge/platform-Windows-blue" /></a>
  <a href="https://github.com/834063245-creator/HoloGram/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
</p>

<br/>

> **代码依赖可视化与影响分析。** 26 门语言统一建模，全库依赖一张图。四级过滤自动排除三方/生成代码，改前查波及范围，改后验架构边界。一次工具调用几十行 JSON，Agent 不用逐层翻源文件——**省 token，就是省钱。**

---

## 核心能力

| 能力 | 说白了就是 |
|---|---|
| **改前查影响** | 改一个文件 → 立刻看到会波及哪些文件、哪些模块。不用搜、不用一层层翻代码。内置 Agent 的 preflight hook 在 `edit_file` / `write_file` 执行前**自动注入 ⚠️ 影响分析**——Agent 不用主动调工具，信息直接出现在结果顶部。 |
| **自动抓越界** | 模块之间乱 import？自动标红。你定规则，它替你盯着。 |
| **给 Agent 省 token** | Claude Code / Cursor 里直接用。Agent 不用读源文件猜依赖，一次调用拿答案，典型场景省 ~70% token。 |
| **3D 代码地图** | 代码库变星图，谁依赖谁、谁在调用谁，一眼看穿。5000 个文件不卡。 |
| **保存即刷新** | 代码改了保存 → 图自动更新。缓存过期检测——源文件更新时自动重分析。 |
| **26+3 门语言，零配置** | Python · TS/JS · Go · Rust · Java · C/C++ · Ruby · Lua · C# · Swift · Dart · Scala · Haskell · HTML · CSS · PHP · OCaml · R · Nix · Bash · YAML · Zig · Elixir · Erlang · Kotlin · TOML · Markdown。打开项目直接出图。 |

---

## 为什么不同

| **🌍 跨语言统一建模** | **🤖 图为 Agent 而生** | **🔬 自举验证** |
|---|---|---|
| 26 门语言全部解析进同一套节点/边 schema——一个统一中间表示。每种语言的 import / call / 符号定义统一建模，跨文件依赖自动标注 `cross_file`。 | 不是"把源文件丢给 LLM 让它自己看"。全库依赖提前算好，存进 MemoryIndex（邻接表 + 倒排索引）+ SQLite FTS5。Agent 调工具拿的是**结构化依赖数据**，不是源文件。一次调用几十行 JSON = 原本要读十几个文件才能拼出的依赖全景。 | HoloGram 用自己的引擎分析自己的代码库。项目根目录下的依赖图随时可查——既是质量保障，也是活样本。363 个 Rust 测试 + 37 个前端测试，每次提交前引擎自检。 |

---

## 截图

<p align="center">
  <img src="assets/screenshots/01.png" width="24%" />&nbsp;
  <img src="assets/screenshots/02.png" width="24%" />&nbsp;
  <img src="assets/screenshots/03.png" width="24%" />&nbsp;
  <img src="assets/screenshots/04.png" width="24%" />
</p>
<p align="center">
  <img src="assets/screenshots/05.png" width="24%" />&nbsp;
  <img src="assets/screenshots/06.png" width="24%" />&nbsp;
  <img src="assets/screenshots/07.png" width="24%" />&nbsp;
  <img src="assets/screenshots/08.png" width="24%" />
</p>

---

## Agent 详解

HoloGram 内置全功能编码 Agent——不是"接了个聊天框"。图和 Agent 是同一系统的两层：Hook 体系在工具调用时自动注入图上下文（preflight 影响分析、文件依赖度标注），Agent 不需要主动查图。

**核心能力：** 30 个图查询工具 | 并行工具执行 | 上下文自动压缩 | 子 Agent 分叉（git worktree 隔离）| 记忆系统（Markdown + AuraSDK 语义召回）| Storm Breaker 死循环检测 | 6 步权限裁决 | Web 搜索 | 5 面板联动提问

**Agent 的工具集和系统提示词都在代码里实时同步——README 不维护二手副本。** 完整功能列表和工具地图见 Agent 系统提示词：[`workspace.ts → buildSystemPrompt`](src-ui/src/workspace.ts#L845)。

---

## 📐 技术规格

| 🧠 耦合诊断 | ⚡ 全量引擎 | 🛡️ 约束门禁 |
|---|---|---|
| L1 同包 → L2 跨包 → L3 数据/IO → L4 时序/异步。L1/L2 由结构图预计算，L3/L4 由数据流引擎按需查询（17 门语言 .scm query）。L4 穿透自动标红。动态调度合成：callback / observer 边自动检测。 | 存储引擎 v3：MemoryIndex（邻接表 O(degree) 查询）+ SqliteDb（FTS5 全文搜索）+ 增量更新（watcher → 防抖 → 原子 swap）。合并管线 v3/v4：逐批并行解析 + 序列化合并 + 全局边去重（625× 削减）。 | YAML 自定义规则：模块隔离、import 白名单、表访问限制。违规编码在 JSON 中，可直接入 CI 流水线。 |

| 📦 序列化 | 🔌 MCP 长驻 | ✅ 测试 |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制冷启秒开 · SQLite + FTS5。缓存优先：已有缓存即显，后台静默更新。 | JSON-RPC over stdio + TCP :9777 双模。崩溃 3 次/60s 自动降级。Tauri 启动时自动 spawn。 | 363 Rust `#[test]`：图模型、适配器、管线、耦合、社区发现、路由、存储引擎、MCP 协议全覆盖。 |

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
| **结构边** | `imports` `calls` `inherits` `defines` | 导入、调用、继承、定义 — 管道预计算，存入图 |
| **数据边** | `reads` `writes` `shares` | 读/写/共享数据 — 数据流引擎按需查询（17 门语言 .scm query），不预存图 |
| **时序边** | `triggers` `awaits` `sequences` | 异步触发、等待、顺序执行 — 数据流引擎按需查询，带 `temporal_delay_sec` |

每条边附加 `coupling_depth`（L1-L4）、`cross_file`、`direction`、`lsp_resolved`。

### 30 个图工具

引擎通过 `hologram_call` (Tauri) 或 JSON-RPC 2.0 over stdio (MCP) 暴露 30 个工具（含 4 个 LSP 按需工具）。所有结构图工具走图数据库查询，不读源文件。

覆盖：聚合查询（`explore_deps` `graph_summary`）· 路径查询（`get_neighbors` `trace_impact` `find_dep_path` `search_symbols`）· 风险分析（`fragile_modules` `detect_cycles` `thread_conflicts` `coupling_report` `arch_blindspots` `preflight_check` `check_boundaries`）· 社区（`get_community` `cluster_report`）· LSP 按需（`resolve_call` `infer_type` `find_implementations` `find_references`）· 符号（`inspect_symbol` `find_unused` `trace_dataflow`）· 时间线（`symbol_history` `async_edges` `project_timeline` `graph_diff`）· 工程（`analyze_project` `validate_project` `project_health` `rename_symbol` `engine_status`）

**→ 完整参数说明和用法见 [Agent 系统提示词的工具地图](src-ui/src/workspace.ts#L870-L960)。** 别名指向、参数签名、调用示例都在那里——那是 Agent 自己看的权威来源，永远最新。

Agent 的工具集由两部分组成：引擎提供的 30 个图查询工具 + Agent 自身内置的 50+ 个操作工具（文件、Git、Shell、搜索、Web、记忆、任务、隔离等）。所有工具对 Agent 透明——Agent 不区分来源，统一调用。

> **引擎图工具**走图数据库（MemoryIndex + SQLite FTS5），不读源文件，省 token。**Agent 内置工具**走 Tauri IPC → Rust 后端。

### 分析管道

| 阶段 | 说明 |
|------|------|
| 1. 文件发现 | 四级过滤 — 硬编码黑名单（30 目录名）+ `.gitignore` 解析 + 扩展名匹配 + 1 MB 上限。skip vendored/generated/三方库 |
| 2. 并行解析 + 合并 | 200 文件/批，rayon 并行 parse，串行 merge。全局节点去重（`loc_index`）+ 全局边去重（`edge_index`，二级快慢路径，625× 削减）。CST 逐批后台释放，不阻塞主线 |
| 3. 类型感知调用解析 | 8 门语言手写 tree-sitter 类型级调用解析（独立于 LSP 工具），30s 超时熔断。跨文件类型级调用边补充 |
| 4. 跨文件解析 | import → 调用链连接，跨文件符号引用关系 |
| 5. 耦合分析 | 所有边赋值 L1-L4 耦合深度 |
| 6. 框架路由 | 8 种框架 URL→handler 映射注入（Django / Express / FastAPI / Flask / Rails / Spring / Gin / NestJS） |
| 7. 动态调度合成 | addEventListener / .on() / .then() / .subscribe() 回调边补充 |
| 8. 社区发现 + DB | Leiden 层次社区发现（Phase 1 扁平 + Phase 2 层级），MemoryIndex + SQLite 持久化 |

> 数据流追踪改为按需查询（`trace_dataflow` / `async_edges` / `coupling_report` / `fragile_modules` / `arch_blindspots` 调用时实时查询数据流引擎），不再在管道中预计算。

### 智能过滤（四级）

| 层级 | 机制 | 说明 |
|------|------|------|
| L0 — 硬编码 | 30 个通用目录黑名单 | `.git` `node_modules` `target` `venv` `vendored` `generated` `tests` 等 |
| L1 — `.gitignore` | 项目树中所有 `.gitignore` 解析 | 目录名模式提取，零配置适配项目特定排除（`.idea` `bin/` `dist/` 等） |
| L2 — 扩展名 | 仅收录 26+3 门已注册语言 | 非源码文件自动跳过（二进制、文档、配置等） |
| L3 — 文件大小 | > 1 MB 跳过（`metadata()` 预检，不读盘） | 兜底：巨型 vendored blob（sqlite3.c 9.3 MB、parser.c 0.5-1 MB） |

### 框架路由

支持 18 种框架的 URL→handler 模式检测（tree-sitter 图案匹配，非 LSP）。覆盖 Django / Express / FastAPI / Flask / Rails / Spring / Gin / NestJS / Koa / Fiber / Phoenix / Rocket / Laravel / ASP.NET / Fastify 等。
**→ 完整列表见 [`engine/src/analysis/framework_routes.rs`](engine/src/analysis/framework_routes.rs)。**

### LSP 工具（按需调用）

4 个 MCP 工具对接原生 LSP 服务器（`resolve_call` `infer_type` `find_implementations` `find_references`），返回精确类型级查询。没有 LSP 时自动降级到手写 fallback。引擎自动探测 PATH，不捆绑 LSP 二进制。

**→ LSP 安装指南和语言对应关系见 [Agent 系统提示词](src-ui/src/workspace.ts#L1030-L1080)。**

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
| 1 | 调 `explore_deps("validate_token auth")` → 引擎 BFS 遍历全库依赖图 + NL 搜索，返回：正向（它依赖谁）+ 反向（谁依赖它）传递闭包、波及模块清单、跨模块能力调用、风险等级 | 约 500 token（入参） |
| 2 | 引擎返回结构化 JSON：4 个直接调用者 + 1 个间接调用者 + 2 个被依赖文件 + 0 条越界违规 + 风险等级 LOW | 约 1,200 token（结果） |
| — | Agent 直接输出结论，不需要推理依赖链 | 0 token |
| — | `scheduler/tasks.py` 的间接调用 → 图里有 `capability_call` 边，静态可达路径全覆盖 | **零静态漏报** |

> **单次查询消耗：约 1,700 token。**
>
> 省 **~4,100 token / 次**（~70%）。静态可达路径不会漏；动态盲区（反射、字符串路由、动态 import）见下方已知局限。

---

### 拉长了算

| | 不用 HoloGram | 用 HoloGram | 省 |
|---|---|---|---|
| **单次依赖查询** | ~5,800 token | ~1,700 token | **~4,100 token (~70%)** |
| **一次编码会话（5 次查询）** | ~29,000 token | ~8,500 token | **~20,000 token** |
| **重度用户月均（30 次会话）** | ~870,000 token | ~255,000 token | **~600,000 token** |
| **十人团队月均** | ~8,700,000 token | ~2,550,000 token | **~6,000,000 token** |

按 Claude 均价 $20/MTok 估算：**单人月省 ~$12，十人团队月省 ~$120。**

> 上面是保守场景。实际使用中，依赖链更深（10-20 层常见）、调用者更多（几十个不稀奇）、模块边界合规要扫全库。
>
> **Token 省的是小头。大头是：弱模型推依赖容易漏，HoloGram 给的图是确定性静态分析——比靠读源文件猜依赖可靠得多。**

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
| **有没有循环依赖？** | `detect_cycles` → 200 token | 读完全仓 21 个 .py（~4,400 行），人工追踪所有 import + 调用关系，画图找环 | **~100K token** |
| **哪些模块最脆弱？** | `fragile_modules` → 300 token | 对 218 个符号逐个 grep 所有引用位置，按 fan-in 排序 | **~50K token** |
| **整体结构（社区聚类）** | `graph_summary` + `cluster_report` → 2,500 token | 读完所有文件后人工将 218 个符号分到 32 个社区——**基本不可行** | **~100K token** |
| **改 engine.close 一行会炸多少？** | `trace_impact` → 800 token 返回 63 节点 BFS 树（depth=3） | 从 engine.close 出发手动追踪 3 层调用链，涉及 8-10 个文件 | **~30K token** |
| **有时序耦合/盲区吗？** | `async_edges` + `arch_blindspots` → 200 token | grep 所有 threading/async/time.sleep 等异步模式，人工判断是否构成耦合 | **~8K token** |
| **给个健康分？** | `project_health` → 150 token | **无法手工计算**——健康分需要完整依赖图 + 历史快照对比 | **∞** |
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

## ⚠️ 已知局限

静态分析不是万能。以下是 tree-sitter 方案的天花板——这些不是 bug，是物理上限。诚实列出，每一项都是接下来要攻克的：

| 盲区 | 说明 | 状态 |
|------|------|------|
| **字符串路由** | Express/Django 等路由字符串 → handler 的映射 | ✅ 18 种框架已覆盖 |
| **动态 import / require** | `import(variable)`/`require(expr)` → 动态导入站点已标记 | ✅ 完成 — Py/JS/TS/C#/Ruby/PHP |
| **反射 / 依赖注入** | getattr/@Autowired/@Injectable 等 → 字符串/变量属性已解析或标记 | ✅ Phase 2 — 10 语言（Py/Java/TS/C#/Ruby/PHP/Go/Kotlin） |
| **跨语言调用边** | 子进程/FFI/HTTP client → 运行时桥接点已标记 | ✅ 完成 — 8 语言（Py/JS/Java/Go/C#/Ruby/PHP/Kotlin） |
| **`eval` / 动态代码生成** | eval/exec/new Function → 已诚实标记为不可达 | ✅ 完成 — 6 语言（Py/JS/C#/Ruby/PHP/Rust） |

> **从 ⚠️ 到 ✅。** 上面的五项盲区已全部完成。静态分析有天花板——我们选择诚实面对，一项一项解决。动态 import、eval、反射、跨语言调用、字符串路由，都通过合成边和标记节点给出了诚实的答案。

---

## 怎么用

<a id="install"></a>
### 🧩 MCP 模式（推荐，零界面）

**不需要桌面应用。** 引擎是单文件二进制，26 种语法静态链接 + 3 种动态加载，零依赖。配进 Claude Code / Cursor 直接用。

### 🤙 一句话安装

复制下面这段话，发给 Claude Code / Cursor，Agent 自己搞定：

```
请帮我安装 HoloGram MCP 服务。步骤：

1. 从 https://github.com/834063245-creator/HoloGram/releases 下载最新版 hologram-engine.exe
2. 放到用户主目录下的 .hologram 文件夹（没有就新建）
3. 在当前 AI 编程工具的 MCP 配置中注册：
   - Windows: ~/.hologram/hologram-engine.exe
   - macOS/Linux: ~/.hologram/hologram-engine（下载后 chmod +x）
      - 参数：serve
  4. 重启 AI 编程工具，调 `engine_status` 验证
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

26 门语言静态链接（tree-sitter）+ 3 门动态加载（DLL）——覆盖 Python · TS/JS · Go · Rust · Java · C/C++ · Ruby · Lua · C# · Swift · Dart · Scala · Haskell · HTML · CSS · PHP · OCaml · R · Nix · Bash · YAML · Zig · Elixir · Erlang · Kotlin · TOML · Markdown。
**→ 引擎内置的扩展名映射见 [`engine/src/adapter/grammar_loader.rs → supported_extensions()`](engine/src/adapter/grammar_loader.rs)。**

---

## 架构

```
┌─ 桌面壳 (Tauri 2) ───────────────────────────────────────────────────────────┐
│  ┌─ 前端 (TypeScript) ──────────────────────┐  IPC  ┌─ Rust 后端 ──────────┐ │
│  │ 3D 星图 (Three.js)  ·  Agent 面板        │◄────►│ 权限裁决 (6 步级联)   │ │
│  │ Monaco 编辑器 · 代码翻译器               │      │ OS 沙箱 (JobObject +   │ │
│  │ 数据流面板 · 热点面板 · 时间轴            │      │   AppContainer)       │ │
│  │ WebGPU 计算着色 · 布局 Worker             │      │ Agent 隔离 (git       │ │
│  │ 设置面板 · LSP 客户端(编辑器补全) · 透镜    │      │   worktree sandbox)   │ │
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
            │ 合并管线 v3/v4 · 全局边去重 (625×) · 30 图工具               │
            │ MemoryIndex + SQLite FTS5 · 增量更新 · StringArena 字符串池    │
            │ 数据流引擎 (.scm query · 17 语言) · 8 框架路由 · LSP (26 语言 · 按需)  │
            │ 动态调度合成 · 社区发现 (Leiden) · 四级过滤 · AuraSDK 语义记忆       │
            └────────────────────────────────────────────────────────────────┘
```

> 引擎自启动，Tauri 启动时自动 spawn。**自举验证：HoloGram 用自己的图 debug 自己。**

---

## 开发

```bash
cd engine && cargo test              # 363 tests
cd engine && cargo build --release   # 编译引擎
cargo tauri build                    # 打包桌面应用
cd src-ui && npm run build           # 类型检查 + 打包前端
```

```
engine/          Rust 引擎 — 合并管线 · 四级过滤 · 数据流引擎 · 框架路由 · LSP · 30 图工具
src-tauri/       Rust / Tauri 壳 — 权限系统 · OS 沙箱 · Agent 隔离 · PTY · 凭证 · 审计
src-ui/          TypeScript 前端 — Three.js · Monaco · Agent 循环 · WebGPU · 数据流面板
assets/          图标 · 截图
grammars/        动态语法 DLL (Kotlin / TOML / Markdown)
build/           构建脚本
```

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing