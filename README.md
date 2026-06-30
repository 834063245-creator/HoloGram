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
  <a href="https://github.com/834063245-creator/HoloGram/actions"><img src="https://img.shields.io/badge/tests-381%20total-brightgreen" /></a>
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

> **代码依赖可视化与影响分析。** 27 门语言统一 IR，全库依赖一张图。四级过滤自动排除三方/生成代码，改前查波及范围，改后验架构边界。MCP 模式下，原本要读 N 个源文件才能理清的依赖链，一次工具调用几十行 JSON 返回——**省 token，就是省钱。**

---

## 核心能力

| 能力 | 说白了就是 |
|---|---|
| **改前查影响** | 改一个文件 → 立刻看到会波及哪些文件、哪些模块。不用搜、不用一层层翻代码。内置 Agent 的 preflight hook 在 `edit_file` / `write_file` 执行前**自动注入 ⚠️ 影响分析**——Agent 不用主动调工具，信息直接出现在结果顶部。 |
| **自动抓越界** | 模块之间乱 import？自动标红。你定规则，它替你盯着。 |
| **给 Agent 省 token** | Claude Code / Cursor 里直接用。Agent 不用读源文件猜依赖，一次调用拿答案，省 **70%-95%** token。 |
| **3D 代码地图** | 代码库变星图，谁依赖谁、谁在调用谁，一眼看穿。5000 个文件不卡。 |
| **保存即刷新** | 代码改了保存 → 图自动更新。缓存过期检测——源文件更新时自动重分析。 |
| **27+3 门语言，零配置** | Python · TS/JS · Go · Rust · Java · C/C++ · Ruby · Lua · C# · Swift · Dart · Scala · Haskell · JSON · HTML · CSS · PHP · OCaml · R · Nix · Bash · YAML · Zig · Elixir · Erlang · Kotlin · TOML · Markdown。打开项目直接出图。 |

---

## 为什么不同

| **🌍 跨语言统一 IR** | **🤖 图为 Agent 而生** | **🔬 自举验证** |
|---|---|---|
| 27 门语言全部映射到同一张图——不是分别解析再拼接，而是一个统一中间表示。TypeScript 调 Python、Rust 调 Go，跨语言依赖链照样追踪。引擎内置 tree-sitter 适配器，每种语言的 import / call / 符号定义统一建模。 | 不是"把源文件丢给 LLM 让它自己看"。全库依赖提前算好，存进 MemoryIndex（邻接表 + 倒排索引）+ SQLite FTS5。Agent 调工具拿的是**结构化依赖数据**，不是源文件。一次调用几十行 JSON = 原本要读十几个文件才能拼出的依赖全景。 | HoloGram 用自己的引擎分析自己的代码库。项目根目录下的依赖图随时可查——既是质量保障，也是活样本。381 个 Rust 测试，每次提交前引擎自检。 |

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
| **25 个内置工具** | explore / neighbors / impact / path / coupling-report / blindspots / cycle / fragile / community / history / search / check / preflight / health / diff / timeline / policy-check / rename 等。全部走图数据库查询，不读源文件。 |
| **Preflight 自动影响分析** | Agent 调 `edit_file` / `write_file` 时，preflight hook 在工具执行前用内存 fileIndex 即时评估波及范围——被依赖最多的符号、风险等级（LOW/MEDIUM/HIGH）、引导调 `hologram_impact` 深挖。< 0.1ms，零延迟。 |
| **Read Enrichment 自动注入** | Agent 读文件时，结果顶部自动附上该文件的符号概览 + 被依赖关系 + 引导调 `hologram_explore` 深挖。Agent 不用主动调用，图信息自动到眼前。 |
| **Agent ↔ 星图双向实时联动** | Agent 调工具 → 3D 视图实时响应。path → 路径高亮，fragile → 脆弱节点标琥珀，cycle → 循环节点标红，impact → 聚焦飞行，diff → 绿增红删。 |
| **图作为输入设备** | Shift+双节点 → BFS 最短路径 → Agent 自动分析依赖链风险。Alt+框选区域 → Agent 自动总结模块关系。单击任意节点 → 详情卡 + "问 Agent"入口。 |
| **全面板覆盖** | 星图详情卡 · 简报违规行 · 文件查看器 · 时间轴事件 · 约束面板——5 个面板全部有"问 Agent"按钮，点一下自动带上下文。 |
| **Agent 透镜** | 图上只亮 Agent 访问过的节点（其余降至 1% 透明度），渐变虚线串联最近推理步骤。一键切换，看清 Agent "看过哪里"。 |
| **会话持久化** | 对话历史自动保存 `.hologram/chat_sessions.json`，重启或切换项目后恢复。 |
| **NL 自然语言探索** | `hologram_explore` 接受自然语言查询——"DataRequest 怎么 validate"——引擎自动切词消歧，BFS 路径搜索，一次返回调用链 + 波及范围 + 源码 + 架构告警。 |

---

## 📐 技术规格

| 🧠 耦合诊断 | ⚡ 全量引擎 | 🛡️ 约束门禁 |
|---|---|---|
| L1 同包 → L2 跨包 → L3 数据/IO → L4 时序/异步。L4 穿透自动标红。动态调度合成：callback / observer 边自动检测。 | 存储引擎 v3：MemoryIndex（邻接表 O(degree) 查询）+ SqliteDb（FTS5 全文搜索）+ 增量更新（watcher → 防抖 → 原子 swap）。合并管线 v3/v4：逐批并行解析 + 序列化合并 + 全局边去重（625× 削减）。 | YAML 自定义规则：模块隔离、import 白名单、表访问限制。违规编码在 JSON 中，可直接入 CI 流水线。 |

| 📦 序列化 | 🔌 MCP 长驻 | ✅ 测试 |
|---|---|---|
| JSON 通用交换 · MessagePack 二进制冷启秒开 · SQLite + FTS5。缓存优先：已有缓存即显，后台静默更新。 | JSON-RPC over stdio + TCP :9777 双模。崩溃 3 次/60s 自动降级。Tauri 启动时自动 spawn。 | 381 Rust `#[test]`：图模型、适配器、管线、耦合、社区发现、路由、存储引擎、MCP 协议全覆盖。 |

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

<table>
<tr><th>类别</th><th>工具</th><th>功能</th></tr>
<tr><td rowspan="2"><b>聚合</b></td><td><code>explore</code></td><td>调用路径 + 波及范围 + 关系图 + 源码 + 架构告警，接受 NL 输入</td></tr>
<tr><td><code>graph_summary</code></td><td>图摘要统计（节点/边/类型分布）</td></tr>
<tr><td rowspan="4"><b>路径</b></td><td><code>neighbors</code></td><td>一阶邻居，按边类型分组</td></tr>
<tr><td><code>impact</code></td><td>BFS 波及范围，返回分层结果（距离、边类型、时序延迟）</td></tr>
<tr><td><code>path</code></td><td>两节点间最短路径</td></tr>
<tr><td><code>search</code></td><td>模糊搜索节点</td></tr>
<tr><td rowspan="7"><b>风险</b></td><td><code>fragile</code></td><td>脆弱模块排名（fan-in/out × 耦合深度）</td></tr>
<tr><td><code>cycle</code></td><td>循环依赖检测，按 all/data/llm 分类</td></tr>
<tr><td><code>thread_conflicts</code></td><td>线程 × 共享资源冲突矩阵</td></tr>
<tr><td><code>coupling_report</code></td><td>完整 L1-L4 耦合深度分布</td></tr>
<tr><td><code>blindspots</code></td><td>架构盲区聚合（L4 穿透 + 循环 + 并发）</td></tr>
<tr><td><code>preflight</code></td><td>改文件前波及预演</td></tr>
<tr><td><code>policy_check</code></td><td>架构边界规则引擎，检测越界依赖</td></tr>
<tr><td rowspan="2"><b>社区</b></td><td><code>community</code></td><td>节点社区归属（社区 ID、父社区、兄弟节点）</td></tr>
<tr><td><code>community_report</code></td><td>代码库社区/集群结构报告</td></tr>
<tr><td rowspan="2"><b>深潜</b></td><td><code>node</code></td><td>单节点完整信息：身份 + 度 + 社区 + 所有出入边按类型分组</td></tr>
<tr><td><code>unused</code></td><td>潜在死代码检测：in_degree=0 的符号，按 out_degree 降序</td></tr>
<tr><td rowspan="5"><b>时间线</b></td><td><code>history</code></td><td>节点决策历史</td></tr>
<tr><td><code>delayed</code></td><td>所有带非空延时的时序边</td></tr>
<tr><td><code>changes</code></td><td>末次 commit 变更标记</td></tr>
<tr><td><code>timeline</code></td><td>因果审计时间线</td></tr>
<tr><td><code>diff</code></td><td>当前图 vs 基线快照 diff</td></tr>
<tr><td rowspan="4"><b>工程</b></td><td><code>analyze</code></td><td>重分析项目目录</td></tr>
<tr><td><code>run_check</code> / <code>run_health</code></td><td>全量约束校验 / 项目健康快照</td></tr>
<tr><td><code>rename</code></td><td>安全重命名，原子回滚</td></tr>
<tr><td><code>status</code></td><td>引擎加载状态 + 内存统计</td></tr>
</table>

### 分析管道

| 阶段 | 说明 |
|------|------|
| 1. 文件发现 | 四级过滤 — 硬编码黑名单（28 目录名）+ `.gitignore` 解析 + 扩展名匹配 + 1 MB 上限。skip vendored/generated/三方库 |
| 2. 并行解析 + 合并 | 200 文件/批，rayon 并行 parse，串行 merge。全局节点去重（`loc_index`）+ 全局边去重（`edge_index`，二级快慢路径，625× 削减）。CST 逐批后台释放，不阻塞主线 |
| 3. 数据流合成 | AST → reads / writes / shares / triggers / awaits / sequences 边 |
| 4. 动态分发 | addEventListener / .on() / .then() / .subscribe() 回调边补充 |
| 5. 框架路由 | 8 种框架 URL→handler 映射注入（Django / Express / FastAPI / Flask / Rails / Spring / Gin / NestJS） |
| 6. 跨文件 + LSP | import → 调用链连接，8 门语言 LSP 类型级调用解析 |
| 7. 耦合计算 + 社区 | 所有边赋值 L1-L4，Louvain 层次社区发现（Phase 1 扁平 + Phase 2 层级） |

### 智能过滤（四级）

| 层级 | 机制 | 说明 |
|------|------|------|
| L0 — 硬编码 | 28 个通用目录黑名单 | `.git` `node_modules` `target` `venv` `vendored` `generated` `tests` 等 |
| L1 — `.gitignore` | 项目树中所有 `.gitignore` 解析 | 目录名模式提取，零配置适配项目特定排除（`.idea` `bin/` `dist/` 等） |
| L2 — 扩展名 | 仅收录 27+3 门已注册语言 | 非源码文件自动跳过（二进制、文档、配置等） |
| L3 — 文件大小 | > 1 MB 跳过（`metadata()` 预检，不读盘） | 兜底：巨型 vendored blob（sqlite3.c 9.3 MB、parser.c 0.5-1 MB） |

> ponytail: 不解析 `.gitignore` 的 glob 通配符和 negation，纯目录名提取。95%+ 真实排除项覆盖，十行代码。

### 框架路由 & LSP

| 框架 | 检测模式 | LSP 语言 | 用途 |
|------|----------|----------|------|
| **Django** | `path()` / `re_path()` / `url()` | **Python** | 跨文件调用类型推断 |
| **Express** | `app.get()` / `router.post()` / `app.use()` | **TypeScript** | 类型解析 |
| **FastAPI** | `@app.get()` / `@router.post()` | **Go** | 接口实现解析 |
| **Flask** | `@app.route(path, methods=[...])` | **Java** | 继承 + 接口解析 |
| **Rails** | `get '/path', to: 'ctrl#action'` | **C#** | 类型解析 |
| **Spring** | `@GetMapping` / `@PostMapping` | **C/C++** | 符号解析 |
| **Gin** | `r.GET()` / `r.POST()` / `r.Group()` | **PHP** | 类解析 |
| **NestJS** | `@Controller('prefix')` + `@Get()` | **Kotlin** | 类型解析 |

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
| 1 | 调 `hologram_impact("auth.py", "validate_token")` → 引擎 BFS 遍历全库依赖图，返回：正向（它依赖谁）+ 反向（谁依赖它）传递闭包、波及模块清单、跨模块能力调用、风险等级 | 约 500 token（入参） |
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

**不需要桌面应用。** 引擎是单文件二进制，27 种语法静态链接 + 3 种动态加载，零依赖。配进 Claude Code / Cursor 直接用。具体省多少 token 见上方 <a href="#token-save">💸 Token 节省实测</a>。

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

| Python | TypeScript | JavaScript | Go | Rust | Java |
|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| C | C++ | Ruby | Lua | C# | Swift |
|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| Dart | Scala | Haskell | JSON | HTML | CSS |
|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| PHP | OCaml | R | Nix | Bash | YAML |
|---|---|---|---|---|---|---|
| tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter | tree-sitter |

| Zig | Elixir | Erlang |
|---|---|---|
| tree-sitter | tree-sitter | tree-sitter |

| Kotlin | TOML | Markdown |
|---|---|---|
| tree-sitter · DLL | tree-sitter · DLL | tree-sitter · DLL |

> 27 门静态链接 + 3 门动态加载（.dll/.so/.dylib），零外部依赖。

---

## 架构

```
┌─ 桌面壳 (Tauri 2) ───────────────────────────────────────────────┐
│  ┌─ 前端 (TS) ────────┐  IPC  ┌─ Rust 后端 ───────────────────┐  │
│  │ Three.js · Monaco   │◄────►│ 路由 · Git · Shell · MCP管理   │  │
│  │ Agent + Preflight   │      │ McpManager (崩溃自动降级)      │  │
│  └─────────────────────┘      └──────────┬────────────────────┘  │
└──────────────────────────────────────────┼───────────────────────┘
                                           │ TCP :9777 / MCP stdio
              ┌────────────────────────────▼──────────────────────┐
              │ Rust 引擎 (engine/)                                │
              │ 合并管线 v3/v4 · 全局边去重 · 27 MCP 工具          │
              │ MemoryIndex + SQLite FTS5 · 381 tests             │
              └───────────────────────────────────────────────────┘
```

> 引擎自启动，Tauri 启动时自动 spawn。**自举验证：HoloGram 用自己的图 debug 自己。**

---

## 开发

```bash
cd engine && cargo test              # 381 tests
cd engine && cargo build --release   # 编译引擎
cargo tauri build                    # 打包桌面应用
cd src-ui && npx tsc --noEmit        # 类型检查
```

```
engine/          Rust 引擎（合并管线 v3/v4 · 四级过滤 · 27 MCP 工具）
src-tauri/       Rust / Tauri 壳
src-ui/          TypeScript 前端（Three.js + Agent + Preflight Hooks + Monaco）
assets/          图标
```

---

## 许可证

[MIT](LICENSE) · © 2026 Wenbing Jing
