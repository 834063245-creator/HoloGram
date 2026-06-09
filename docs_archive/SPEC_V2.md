# SPEC V2: 代码全息观测站 — 可落地的工程方案

> V1 定义了"要什么"。V2 定义"什么能做到、怎么做到、做不到什么"。
>
> 区分原则：**只有存在确定性工程路径的能力才进入 V2 正文。**
> 需要人类判断、需要 LLM 介入、需要运行时信息且静态分析拿不到的——归入 §X 已知盲区。
>
> **实现状态：Tier 1 ✅ / Tier 2 ✅ / Tier 3 📋** | 测试: 311 passed | MCP: 13 tools

---

## 目录

1. [V1 已覆盖的能力](#1-v1-已覆盖的能力)
2. [V2 新增：耦合深度计](#2-耦合深度计)
3. [V2 新增：线程交错图](#3-线程交错图)
4. [V2 新增：数据流环检测](#4-数据流环检测)
5. [V2 新增：因果审计时间线](#5-因果审计时间线)
6. [V2 新增：自然语言查询层](#6-自然语言查询层)
7. [V2 新增：多 Agent 冲突感知](#7-多-agent-冲突感知)
8. [已落地的 MCP 工具扩展](#8-mcp-工具扩展)
9. [Agent 与边界](#9-agent-与边界)
10. [X. 已知盲区](#x-已知盲区)

---

## 1. V1 已覆盖的能力

V2 不替代 V1。以下 V1 能力已存在明确的工程路径，照旧：

| V1 能力 | 状态 |
|---|---|
| 三种节点 × 三种边的图骨架 | Python 适配器已跑通 768 节点/754 边/0.34s |
| 社区聚类（Leiden 算法）| NetworkX + leidenalg，已实现 |
| 波及环（Proportional Editing）| BFS 分层着色，纯前端 |
| 交互范式（Pie Menu / Local View / 路径锚点）| Cytoscape.js 交互层 |
| 浮动文件窗口 + Monaco + Markdown 预览 | Tauri WebView |
| 终端嵌入（xterm.js）| WebView 嵌入 |
| 决策时间轴 | 星图右侧时间轴 + 快照对齐 |
| 变更回看（命中/漏判/过估）| diff 两张图 + 着色叠加 |
| MCP Server + CLI 双通道 | JSON-RPC stdio + CLI 子命令 |
| Agent 无关性 | MCP 协议 + CLI 兜底 |

---

## 2. 耦合深度计 ✅ 已实现 (`analysis/coupling.py`)

### 2.1 问题

V1 的星图上，所有结构边看起来一样——蓝色的实线。但你改 import 一个公开 API 和直接捅进 `_private` 属性，风险完全不同。

### 2.2 输入

代码仓的 AST（Python: `ast` 模块；TypeScript: ts-morph；Rust: syn）。

### 2.3 算法

对每条结构边，判定其耦合深度等级：

```
L1 — 公开 API 调用
  条件：被引用符号在模块的 __all__ 中，
        或被引用符号的 __init__.py 显式导出，
        或函数/类名不以 _ 开头
  颜色：蓝色实线

L2 — 内部模块导入
  条件：跨文件 import，但被引用符号不在公开 API 中，
        或是子模块的直接导入（from .submodule import X）
  颜色：浅蓝实线

L3 — 共享数据文件
  条件：两个模块读写同一个文件路径
        （字符串字面量匹配，去参数化后的路径相等）
  检测方式：
    - Python: ast.walk → 匹配 open()/Path()/.json/.db/.sqlite 字符串
    - TypeScript: ts-morph → 匹配 fs.readFileSync/readFile 字符串参数
  颜色：橙色虚线

L4 — 封装穿透
  条件：访问另一个模块中以 _ 或 __ 开头的属性/方法，
        或直接访问第三方库的内部对象
        （如 database_client._connection_pool）
  检测方式：
    - Python: ast.Attribute 节点，attr 以 _ 开头且 value 不是 self
    - TypeScript: ts-morph PropertyAccessExpression，name 以 _ 开头
  颜色：红色闪烁虚线
```

### 2.4 输出

星图上每条边按 L1-L4 着色。
侧边栏统计面板：

```
模块 X 的耦合深度分布：
  L1 公开 API      12 条  ████████
  L2 内部导入        5 条  ███
  L3 共享数据文件    3 条  ██
  L4 封装穿透        8 条  █████  ← 高亮警告
```

全局排序：按 L4 边密度排序 → Top 5 最脆弱模块。

### 2.5 工程依赖

- Python: 标准库 `ast`（已在适配器中使用）
- TypeScript: ts-morph 或直接用现有的正则模式匹配扩展
- 无新增外部依赖
- 图数据模型新增：边属性 `coupling_depth: int`（1-4）

### 2.6 确定性

**完全确定。** 纯静态分析，AST 遍历，输出是代码字面量的直接映射。
无误报：以 `_` 开头就是 private convention，这是 Python/TypeScript 的语言约定。
漏报：运行时动态 import / getattr 无法静态检测（归入 §X 盲区）。

---

## 3. 线程交错图 ✅ 已实现 (`analysis/threading.py`)

### 3.1 问题

一个后台任务调度器有多个线程同时操作共享缓存。etcd 单节点因异步持久化丢数据。并发竞争窗口是真实的故障源，但 V1 的星图完全不显示运行时结构。

### 3.2 能做什么

**保守的静态近似。** 不运行时追踪，从代码的字面量中提取线程和共享资源的声明。

### 3.3 算法

```
阶段 1：线程发现
  匹配模式（按语言）：
    Python:
      threading.Thread(target=...)       → 标记为线程创建点
      asyncio.create_task(...)           → 标记为异步任务
      Timer(interval, ...)              → 标记为定时器
      while ...: time.sleep(...)        → 标记为轮询循环
      @periodic / @repeat 装饰器        → 标记为周期任务

    TypeScript:
      new Worker(...)                   → Worker 线程
      setInterval(...)                  → 定时器
      setTimeout 递归                   → 轮询循环

阶段 2：共享资源发现
  匹配所有跨线程可见的可变状态：
    - 全局变量（模块级的 dict/list/set/对象）
    - 文件路径字符串（同一路径出现在两个以上线程的代码中）
    - 数据库连接字符串（同一 db 路径出现在两个以上线程中）
    - 显式锁对象（threading.Lock / RLock / _lock / Mutex）
    - 同一第三方库客户端实例（DatabaseClient / redis.Redis / etc.）

阶段 3：冲突矩阵
  对每一对 (线程, 共享资源)，判定访问模式：
    R   — 只读（保守假设：所有读都可能是读）
    W   — 有写入操作
    R/W — 同时有读和写

  输出 N×M 矩阵，N=线程数，M=共享资源数。
```

### 3.4 输出

```
线程交错图（叠加在星图上）：

  共享资源 cache_store
    ├── scheduler_thread    [R/W]  ← 读 + 写
    ├── flush_worker        [W]    ← 写
    ├── log_writer          [W]    ← 写
    ├── index_builder       [R/W]  ← 读 + 写
    └── request_handler     [R]    ← 读（请求线程）

  检测到锁：_cache_lock 保护 local_cache
  未检测到锁保护：cache_store 的并发写入
```

### 3.5 不确定性标注

```
每个检测结果的置信度标签：

  [确定]     — threading.Thread(target=...) 字面量匹配
  [高置信]   — 同一文件路径字符串出现在两个线程中
  [中等]     — 全局变量被两个线程引用，但无法静态确定是否真的并发访问
  [低置信]   — while+sleep 模式被识别为轮询，但可能是普通循环
  [未检测]   — 运行时动态创建的线程、反射调用、eval/exec
```

**不标注"安全"。** 只标注"检测到的风险"和"检测不到的区域"。没有红色标记不意味着安全——只意味着静态分析没找到。

### 3.6 工程依赖

- Python: 标准库 `ast`，扩展现有适配器
- TypeScript: ts-morph 或正则模式匹配
- 无新增外部依赖
- 图数据模型新增：节点类型 `TemporalNode`（V1 已有），边类型 `conflicts_with`

### 3.7 确定性

**保守近似。** 可能有漏报（运行时动态行为），但所有报告都是真实的代码字面量。
不声称完整。输出必须标注置信度。

---

## 4. 数据流环检测 ✅ 已实现 (`analysis/dataflow.py`)

### 4.1 问题

LLM 生成的回复 → 存为记忆 → 被检索回 prompt → LLM 再次生成。这是闭环。
闭环系统可能收敛（误差被稀释）或发散（误差被放大，模型自噬）。
静态分析不能判断收敛性。但可以**找到所有的环**。

### 4.2 算法

```
阶段 1：构建数据流图
  节点 = 符号节点 + 介质节点
  边   = 数据边（读/写）+ 结构边（调用链）

  规则：
    A 写入文件 F    → A --[write]--> F
    B 读取文件 F    → F --[read]-->  B
    A 调用 B        → A --[call]-->  B
    A 调用 LLM API  → A --[llm_call]--> LLM
    LLM 产出文本    → LLM --[generate]--> response_handler
    response_handler 写入 DB → response_handler --[write]--> DB

阶段 2：环检测
  在数据流图上运行 Johnson's algorithm 或 Tarjan's SCC
  找到所有包含介质节点或 LLM 节点的有向环。

阶段 3：环分类
  [纯代码环]    — 环上全是符号节点（A → B → A 调用环）
                 → 通常是设计问题，但可能是有意为之
  [数据持久环]  — 环上包含介质节点（文件/DB）
                 → 数据变更会影响未来的读取
  [LLM 参与环]  — 环上包含 LLM 节点
                 → 存在自噬风险
```

### 4.3 输出

```
星图上：
  数据流环用环形虚线高亮，套在参与节点周围。
  环的颜色：
    纯代码环    — 灰色
    数据持久环  — 橙色
    LLM 参与环  — 红色（自噬风险）

  环的标注：
    "环长 5 跳。经过：api_handler.py → shared_cache.db → query_builder.py
     → response_formatter.py → LLM API → api_handler.py"
    "LLM 参与环。自噬风险：静态分析无法评估收敛性。"
```

### 4.4 工程依赖

- NetworkX 已有 `simple_cycles()` 或 `strongly_connected_components()`
- 数据流图 = 现有图骨架的子集（过滤出数据边 + 调用链上的结构边）
- LLM API 调用检测：匹配已知 SDK 的调用模式（openai.ChatCompletion.create / deepseek.chat / anthropic.messages.create / httpx.post 目标 URL 包含 "api" 路径）

### 4.5 确定性

**环检测确定。自噬风险评估不确定。**

可以确定地找到所有的有向环。但环的"危险性"无法静态判断——需要运行时知道环上数据的误差是否在累积。

输出标注：
```
[确定] 检测到 3 个数据流环
[不确定] 这 3 个环的收敛/发散性
[不确定] 环 2 包含 LLM 节点，退化的速度取决于 LLM 的权重和用户纠正频率
```

---

## 5. 因果审计时间线 ✅ 已实现 (`timeline.py`)

### 5.1 问题

PostgreSQL #19449: 改 1 个 commit → 6 小时后查询退化。
另一个常见场景：改了调度器的优先级参数 → 几小时后任务积压。

开发者不会把 6 小时前的 commit 和现在的退化联系起来。因果链在时间中断裂。

### 5.2 能做什么

**自动记录，不自动推断。**

```
全息仓 watcher 监测：
  - 代码文件变更（已有：watchdog）
  - 共享数据文件变更（新增：scheduler_state.json 类的运行时数据文件）
  - git commit 事件

每条事件记录：
  {
    timestamp: "2026-06-08 14:02:33",
    event_type: "file_changed" | "data_file_changed" | "commit",
    file: "task_scheduler.py",
    changed_by: "git commit a1b2c3d" | "runtime_write",
    related_nodes: ["task_scheduler.SchedulerEngine.schedule_next_run"],
    data_file_diff: null | {key: "last_scheduled_run", old: 1718400000, new: 1718500000}
  }
```

### 5.3 输出

```
星图右侧时间轴（V1 已有）的扩展：

  ── 今天 ──
  14:02  代码变更  task_scheduler.py (commit a1b2c3d)
            └ 波及预测: 7 节点，含 1 个延迟（scheduler_state.json）
  18:00  数据变更  scheduler_state.json (运行时写入)
            └ last_scheduled_run 更新
  18:00  用户请求  "系统怎么变慢了"
            └ query_engine 读取 scheduler_state.json → 选择了与变更前不同的调度策略

  全息仓显示这条时间线，高亮 scheduler_state.json 作为共享热点。
  用户看到：14:02 的改动 → 18:00 的数据变更 → 18:00 的用户请求。
  全息仓不下结论说"因为调度器改动导致系统变慢"。
```

### 5.4 关键设计约束

```
全息仓不做的事：
  ✗ 不自动推断因果关系
  ✗ 不把"14:02 改了 task_scheduler.py"和"系统变慢"连起来
  ✗ 不声称"找到了 bug 的根源"

全息仓做的事：
  ✓ 记录所有共享数据文件的读写时间戳
  ✓ 在时间轴上对齐代码变更、数据变更、用户操作
  ✓ 高亮共享热点（被多个线程读写的文件）
  ✓ 展示时序，让人类自己判断因果关系
```

### 5.5 工程依赖

- V1 已有 watchdog（代码文件监听）
- 新增：数据文件监听（监控 *.json / *.db / *.sqlite 的 mtime 变更）
- 新增：时间轴数据库（SQLite，轻量，存事件记录）
- Tauri 命令：`record_data_event` / `query_timeline` / `get_data_file_history`

---

## 6. 自然语言查询层 ✅ 已实现 (MCP 13 tools → LLM 翻译)

### 6.1 问题

vibe coding 开发者看不懂代码。他们需要问：

```
"这个项目最脆弱的地方在哪里"
"改了 config.py 会炸什么"
"哪些模块的耦合最乱"
```

### 6.2 架构

```
用户自然语言
    ↓
LLM（Agent 侧，如 Claude Code）
    ↓ 翻译为结构化查询
MCP 工具调用（V1 已有的 7 工具 + V2 新增）
    ↓ 返回 JSON 图数据
LLM（Agent 侧）
    ↓ 翻译为自然语言
用户看到结果
```

**全息仓不调 LLM。** Agent 的 LLM 负责自然语言 → 结构化查询的翻译和结果 → 自然语言的翻译。全息仓只负责图查询的精确执行。

### 6.3 V2 新增的 MCP 查询工具

```
hologram_fragile(limit=5)
  → 按 L4 边密度排序，返回 Top N 最脆弱模块
  → 每条结果：模块名、L4 边数、涉及的共享资源、涉及的线程

hologram_cycle(mode="all" | "data" | "llm")
  → 返回所有检测到的数据流环 / LLM 参与环
  → 每条结果：环节点列表、环长、环类型

hologram_thread_conflicts(node_id)
  → 返回该节点涉及的线程 × 资源冲突矩阵
  → 标记无锁保护的并发写入

hologram_coupling_report(module_name)
  → 返回该模块的完整耦合深度分布（L1-L4 统计 + 每条边的详情）
```

### 6.4 使用示例

```
用户（对 Claude Code 说）：
  "这个项目最脆弱的地方在哪"

Claude Code 内部：
  1. 调 hologram_fragile(limit=5)
  2. 收到：
     - data_pipeline.py: 12 条 L4 边（封装穿透外部缓存库）
     - service_registry.py: 20 个内部导入 + 3 线程启动
     - shared_config.py: 7 个 L3 边（共享 scheduler_state.json）
  3. 翻译给用户：
     "三个最脆弱的模块：
      1. data_pipeline.py — 12 处直接捅进缓存库的私有属性，封装穿透率极高
      2. service_registry.py — 整个系统的接线面板，20 个模块依赖它，3 个后台线程在这里启动
      3. shared_config.py — 和 data_pipeline 共享 scheduler_state.json，改动会通过数据文件传递给其他模块"
```

### 6.5 确定性

**全息仓侧的查询完全确定。** 图查询是精确的数学运算。
自然语言翻译的准确性取决于 Agent 侧的 LLM 质量——不在全息仓的控制范围内。

---

## 7. 多 Agent 冲突感知 📋 Tier 3（依赖 git diff 轮询 + Agent 识别）

### 7.1 问题

vibe coding 的未来是多个 Agent 同时改一个代码仓。三个 Agent 分别改 request_handler.py、auth_middleware.py、session_store.py——它们在图上是紧耦合的。目前没有工具感知这种冲突。

### 7.2 算法

```
每 N 秒（或每次文件保存事件）：
  1. 获取当前工作区的未提交变更: git diff --name-only
  2. 按变更来源分组（不同 Agent = 不同的 commit author 或分支）
  3. 在星图的耦合矩阵中查询变更文件之间的边
  4. 计算冲突等级：

      无冲突     — 变更文件之间没有耦合边
      低冲突     — 仅在 L1 公开 API 上有边
      中冲突     — L2 内部导入或 L3 共享数据文件上有边
      高冲突     — L4 封装穿透或同一数据文件上有边

  5. 在星图上着色标记
```

### 7.3 输出

```
星图上：
  Agent A 正在编辑的文件 → 蓝色光晕
  Agent B 正在编辑的文件 → 绿色光晕
  Agent C 正在编辑的文件 → 紫色光晕

  两个 Agent 的文件之间有耦合边 → 边变粗，颜色取冲突等级：
    低冲突  — 黄色粗边
    高冲突  — 红色闪烁粗边

侧边栏警告面板：
  ⚠ 高冲突：Agent A 的 request_handler.py ↔ Agent C 的 session_store.py
     shared: session_cache.db (数据文件)
     建议：先让 A 完成 request_handler 的改动，C 在 A 合并后再改 session_store
```

### 7.4 工程依赖

- `git diff --name-only`（已有，V1 的变更影响分析已在用）
- 星图耦合矩阵（V1 已有的图数据）
- Agent 识别：通过 git author、分支名、或全息仓会话 ID
- 轮询间隔：可配置，默认文件保存事件驱动

---

## 8. MCP 工具扩展 ✅ 已实现 (13 tools)

V1 定义了 7 个 MCP 工具。V2 新增 6 个，共 13 个：

| 工具 | 输入 | 输出 | V |
|---|---|---|---|
| `hologram_fragile` | limit: int | 按 L4 密度排序的模块列表 | V2 |
| `hologram_cycle` | mode: "all"\|"data"\|"llm" | 数据流环列表 | V2 |
| `hologram_thread_conflicts` | node_id | 线程 × 资源冲突矩阵 | V2 |
| `hologram_coupling_report` | module_name | 模块的 L1-L4 分布 | V2 |
| `hologram_blindspots` | filter: "all"\|"L4"\|"thread"\|"cycle" | 边界列表 + 上下文数据 | V2 |
| `hologram_timeline` | limit: int, since: str | 因果审计时间线事件 | V2 |

MCP 和 CLI 底层是同一套 Python 函数，只暴露方式不同。

---

## 9. Agent 与边界

### 9.1 定位

全息仓的真正价值不是"画图"。是**精确标注代码与外部世界的接触面**。

程序层能从代码仓里穷举所有关系。但代码只是系统的骨架——系统行为从骨架与外部环境的相互作用中涌现。外部不可控：IR 语义可能漂移、集群规模可能爆炸、用户输入不可预测、LLM 回复不保证。

程序层的职责是**标注边界**——"此处触碰了代码仓之外的东西"。Agent 的职责是**跑前参谋**——用户看到边界标记，点一下按钮，把边界上下文丢给 Agent。Agent 自由回复：这个边界可能怎么被测出来、有什么常见的防御模式、值不值得现在处理。用户自己去跑。跑完的结果比 Agent 的任何分析都准确。

**Agent 不是法官。是跑前参谋。Agent 不下结论。人去跑。**

### 9.2 边界覆盖层

星图主视图上叠加边界覆盖层（可切换开/关，快捷键 `B`）：

```
边界标记：
  ● 红色脉冲  = L4 封装穿透（12 处，3 文件）
  ● 橙色脉冲  = 无锁并发窗口（2 处）
  ● 紫色脉冲  = LLM 参与环（1 处）
```

脉冲频率映射风险等级。没有"已裁决"/"已修复"状态——那些是人跑完之后的事，不归星图管。

### 9.3 交互

点击任意脉冲标记 → 弹出小型信息卡：

```
⚠ L4 封装穿透 — data_sync.py ↔ cache_store.py
  12 处私有属性访问：_internal_index (8)  _pending_writes (3)  _flush_queue (1)
  涉及线程：scheduler_thread, flush_worker

  [→ 发送给 Agent]
```

点击"发送给 Agent"→ 把边界上下文（模块名、边类型、涉及的文件和行号、共享资源列表）写入终端标准输入。Agent 收到后自由回复。Agent 想说什么说什么——没有格式约束，没有 verdict 协议。

### 9.4 MCP 工具

| 工具 | 输入 | 输出 |
|---|---|---|
| `hologram_blindspots` | filter: "all"\|"L4"\|"thread"\|"cycle" | 边界列表 + 每个边界的上下文数据 |

Agent 调用 `hologram_blindspots` 可以获得与星图上点击相同的上下文数据。

---

## X. 已知盲区

以下能力**不在全息仓程序层的工程范围内**，原因是所需信息不在代码仓的字面量中。

但这些边界会被自动检测并标注在星图上（见 §9）。程序层标注"此处触碰了代码仓之外的东西"，一键发送上下文给 Agent，Agent 做跑前参谋，人去跑。

### X.1 假设检测

```
问题：Bitcoin CVE-2018 的三层假设——
      "block 层会检查双重消费" / "这是冗余的" / "跳过就行"
      不存在于代码里，存在于开发者的脑子里。

全息仓能做的：无。
为什么：假设不是代码的字面量。它可能出现在 commit message、PR 讨论、
      或根本不出现。静态分析找不到不存在的东西。
```

### X.2 缺失保护检测

```
问题：etcd 单节点的异步持久化窗口——
      多节点有 Raft majority commit 保护，单节点没有。
      程序不知道"缺少保护"是 bug 还是设计。

全息仓能做的：标记并发写入窗口（线程交错图）。
不能做的：判断这个窗口是否被"应该存在但不存在的代码"保护了。
为什么："缺少某段代码"是开放世界问题——可能的保护代码有无限多种。
      只能报告存在的代码，不能推演不存在的代码。
```

### X.3 设计意图分类

```
问题：data_sync.py 的 12 处 _private 访问——
      是"懒得改接口"？还是"必要的性能优化"？
      代码字面量不包含这个答案。

全息仓能做的：标记为 L4 封装穿透（耦合深度计）。
不能做的：区分故意的穿透和意外的穿透。
为什么：意图不存在于代码的字面量中。
```

### X.4 语义质量评估

```
问题：改了 relevance_filter 的 SCORE_THRESHOLD 从 0.60 到 0.45——
      LLM 收到了不同的上下文 → 回复质量变了没有？
      没有程序能计算"回复质量"的定义。

全息仓能做的：检测阈值变更（代码 diff）。
不能做的：判断变更对 LLM 回复质量的影响。
为什么：回复质量不是程序可计算的属性。需要人判断。
```

### X.5 闭环收敛性

```
问题：LLM 参与的数据流环——
      自动补全 → LLM → 内容缓存 → 下次补全 → LLM
      这个环是收敛的还是发散的？
      取决于 LLM 的权重、prompt 的措辞、用户的纠正频率。

全息仓能做的：检测并标记 LLM 参与环（数据流环检测）。
不能做的：计算环的收敛性或退化的速度。
为什么：LLM 的权重不在代码仓里。用户的纠正行为不在代码仓里。
      收敛性分析需要数学建模而非静态分析。
```

### X.6 运行时动态行为

```
问题：Python 的 getattr(obj, some_string) / eval() / exec()
      TypeScript 的 obj[dynamicKey]
      这些调用的目标在静态分析时不可知。

全息仓能做的：标注"此处存在动态调用，静态分析受限"。
不能做的：解析动态调用的目标。
为什么：目标在运行时才知道。静态分析本质上有上限。
```

### X.7 盲区汇总表

| 盲区 | 全息仓能做的 | 全息仓不能做的 | 为什么不能 |
|---|---|---|---|
| 假设 | 无 | 检测未写明的模块间假设 | 假设不在代码里 |
| 缺失保护 | 标记并发窗口 | 判断窗口是否该被保护 | 无限可能保护方案 |
| 设计意图 | 标记 L4 穿透 | 区分故意/意外 | 意图不在代码里 |
| 语义质量 | diff 代码变更 | 判断 LLM 回复质量 | 质量无程序定义 |
| 闭环收敛性 | 检测 LLM 参与环 | 计算收敛/发散 | 依赖模型权重+用户行为 |
| 运行时动态 | 标注动态调用点 | 解析动态目标 | 目标在运行时才知道 |

---

## 附录：V2 实现优先级

按实现难度和独立价值排序。实现日期：2026-06-08。

```
第一梯队 ✅ 已完成（独立价值高，无新增依赖）：
  1. 耦合深度计          ✅ analysis/coupling.py      — 扩展 AST，边加 coupling_depth
  2. 数据流环检测         ✅ analysis/dataflow.py      — NetworkX simple_cycles + LLM API 匹配
  3. MCP 工具扩展         ✅ mcp_server.py (13 tools)  — 5 个新查询 + 1 个边界 + 1 个时间轴
  4. 边界数据层           ✅ analysis/blindspots.py    — 边界检测 + 上下文数据

第二梯队 ✅ 已完成（需要新增数据收集基础设施）：
  5. 线程交错图           ✅ analysis/threading.py     — AST 模式匹配 + 冲突矩阵
  6. 因果审计时间线       ✅ timeline.py               — SQLite 事件存储 + 文件快照

第三梯队 📋 待实现（依赖外部事件源）：
  7. 多 Agent 冲突感知    📋 — git diff 轮询 + Agent 识别机制
```
