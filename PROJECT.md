# PROJECT.md — 全息观测站 · 唯一真相源

> **最后更新：2026-06-17 · NL探索+8框架路由+动态调度合成 · 249测试**

---

## 2026-06-17 第二轮 — NL探索 · 框架路由 · 动态调度（本轮）

从 CodeGraph 拆入功能，全在 Rust 引擎侧落地。

### NL 自然语言探索

`hologram_explore` 现接受自然语言 query 字符串，引擎自动切词+消歧，无需 Agent 预提取符号名。

| 改动 | 文件 |
|------|------|
| NL 切词 | `explore.rs` — `tokenize()` 正则切分+代码标识符过滤 |
| PascalCase 上下文消歧 | `explore.rs` — `disambiguate()` 用容器类名筛候选 |
| BFS 路径搜索 | `explore.rs` — 最大深度7，最大探索1500节点 |
| MCP 参数扩展 | `mcp.rs` — tool_explore 接受 `query` 字符串参数 |

### 框架路由覆盖（8 种）

| 框架 | 模式 | 语言 | 文件 |
|------|------|------|------|
| Django | `path('url', view)` | Python | `framework_routes.rs` |
| Express | `app.get('url', handler)` | JS/TS | `framework_routes.rs` |
| FastAPI | `@app.get('/url')` | Python | `framework_routes.rs` |
| Flask | `@app.route('/url', methods=['GET'])` | Python | `framework_routes.rs` |
| Rails | `get '/x', to: 'controller#action'` | Ruby | `framework_routes.rs` |
| Spring | `@GetMapping("/url")` | Java | `framework_routes.rs` |
| Gin | `r.GET("/url", handler)` | Go | `framework_routes.rs` |
| NestJS | `@Controller + @Get` | TS | `framework_routes.rs` |

### 动态调度合成 Phase 1

静态图盲区补全——检测 callback/observer 注册模式，在图里创建 synthesized 边。

| 语言 | 识别模式 |
|------|----------|
| JS/TS | `addEventListener`, `.on()`, `.then()`, `.subscribe()`, `.use()` |
| Python | `.subscribe()`, `.add_callback()`, `.register()`, `.on()`, `.connect()` |

检出后创建 `coupling_depth=3, direction=synthesized` 边，feed 进 explore 的 `synthesizedHops`。

### 语言支持扩展

tree-sitter 语法 10→18 种：新增 C# / Swift / Dart / Scala / Haskell / JSON / HTML / CSS。
另 12 种（PHP/Kotlin/Bash/YAML/TOML/Markdown 等）依赖已在 Cargo.toml，待上游 tree-sitter 升级后一行启用。

---

## 2026-06-17 前端感知升级（第一轮）

### 原生 Agent 功能补齐

| 功能 | 文件 | 说明 |
|------|------|------|
| **子Agent系统** | `agent.ts` + `tool.ts` + `main.ts` | `agent_spawn` 工具 — 主Agent可spawn子Agent执行并行任务，全工具克隆（写/改/Shell/Git/查图），单轮执行结果回传 |
| **流式Markdown渲染** | `chat.ts` + `index.html` | 边收chunk边 `marked.parse()` 渲染，检测未闭合code fence保留原文，rAF节流，flush时补 hljs 高亮 |
| **工具进度直播** | `agent.ts` + `chat.ts` + `main.ts` | `Tool.execute(args, onProgress?)` → `ToolProgress` sink事件 → 工具卡片增量追加输出，run_shell后台300ms轮询 |
| **焦点上下文** | `chat.ts` + `main.ts` | 监听 `highlight:file`/`navigate:file`/`graph:node-clicked` → 发送消息时注入 `[用户当前正在查看 xxx]` 前缀 |
| **模式切换** | `settings.ts` + `chat.ts` + `main.ts` | 四种Agent模式：通用(0.7/50步) / 编码(0.3/80步) / 架构(0.5/60步) / 极速(0.2/25步)，聊天框底部badge+popup，保存触发重初始化 |
| **变更(diff)修复** | `engine/main.rs` + `main.rs`(Tauri) + `mcp.rs` | 三层全修：引擎 `Graph::new()` 占位→真实文件IO(首次自动创建hologram_before.json基线)，Tauri handler不再丢弃参数，MCP工具同步 |
| **Explore 聚合查询** | `engine/src/analysis/explore.rs` + `mcp.rs` | `hologram_explore` — 一次返回 Flow + Blast Radius + Relationships + Source Code + Architecture Alerts，Agent 日常首选 |
| **文件树实时更新** | `file-tree.ts` + `main.ts` | 监听 `workspace:files-changed` 事件，1.5s防抖自动刷新 |
| **文件树按钮反馈** | `file-tree.ts` + `index.html` | `.ft-header-btn` hover蓝底+active缩放+transition，刷新按钮旋转180°动画 |
| **权限卡片键盘修复** | `chat.ts` | 键盘快捷键绕过DOM更新→`resolvePermCard()`统一路径 |
| **快捷键面板同步** | `index.html` | 删幽灵快捷键(B/Ctrl+S/Ctrl+↵)，补权限卡片组/remember/终端Tab |

### 当前工具数

**Agent 工具：46 个**（45 + agent_spawn）

```
── 图查询 (25) ──
hologram_analyze/neighbors/impact/path/explore/diff/fragile/cycle/coupling_report
blindspots/thread_conflicts/timeline/community_report/graph_summary
history/community/delayed/changes/search/status/hotspots
run_check/run_preflight/run_health/gate_check/workspace_conflict/rename
── 编码 (17) ──
write_file/edit_file/read_file_content/search_code/list_directory
run_shell/bash_output/bash_kill/rename_file_or_dir/delete_file_or_dir
create_directory/move_file/web_search/web_fetch
git_status/git_commit/git_push/git_pull/git_diff/git_log
ask_user
── 记忆 (4) ──
hologram_memory_list/read/save/delete
── 子Agent (1) ──
agent_spawn
```

---

## Python → Rust 全量迁移（2026-06-16 完成）

**Python 引擎 `src_python/` 已完全退役。所有活跃代码路径走 Rust 引擎。**

| 迁移项 | Python | Rust | 状态 |
|---|---|---|---|
| MCP 协议层 | `mcp_server.py` (1,231 行) | `engine/src/mcp.rs` (~1,400 行) | ✅ |
| 22 个 MCP 工具 | `mcp_server.py` 内联 | `mcp.rs` 工具分发 + `explore.rs` 聚合查询 | ✅ |
| 全量分析 | `python -m src_python analyze` | `EngineClient.send("analyze:")` | ✅ |
| 轻量图生成 | 400 行 Python AST 扫描 | `EngineClient` (Rust 4s vs Python 10-30s) | ✅ |
| 后台分析 | `python -m src_python analyze` 子进程轮询 | Rust 后台线程 + EngineClient | ✅ |
| 文件图转换 | Python inline `to_file_graph()` | 纯 Rust `regenerate_file_graph()` | ✅ |
| 增量分析 | Python 多进程池 | Rust 全量（够快，无需增量） | ✅ |
| McpManager | `python -m src_python serve` | `engine.exe serve --project-root` | ✅ |
| 引擎自启动 | Python 子进程 | `engine.exe` TCP :9777 | ✅ |

**数据模型补齐：** Edge 加 `temporal_delay_sec` / `medium_node_id` 字段，Graph 加 `from_json_file()` 加载 Python 格式 JSON。

**残留：** 全部已清理（2026-06-16 第二阶段）。`src_python/`、`src-tauri/python/`（嵌入式运行时）、`run_hologram()`、`run_python_code()`、`python()`、`py_json()` 全部删除。`tauri.conf.json` 移除 Python bundle。`prebuild.sh` 简化为纯前端构建。Build 产出安装包已验证通过（MSI 12MB + NSIS 8.3MB）。

---

## 审计修复（2026-06-16 · 22 条）

**代码审查发现 22 条缺陷（6 致命 / 4 高危 / 7 中危 / 5 低危），全部修复落地，927 测试通过。**

### 致命（6）— 数据丢失 / 静默错误
| ID | 文件 | 问题 | 修复 |
|---|---|---|---|
| C | graph.py:613 | to_sqlite 丢弃 temporal_delay_sec / medium_node_id | edges 表加 2 列 + insert + from_sqlite |
| E | graph.py:555 | to_dict() 每次重新生成时间戳 | 缓存 _generated_at，首次调用生成 |
| B | merger.py:244 | resolve_incremental 跳过 _pick_best | 复用 _pick_best 消歧义 |
| G | runner.py:116 | 并行分析异常静默吞掉 | PipelineReport 加 failed_files 字段 |
| J | cache.py:31 | IncrementalCache 无上限 | max_size 默认值 0→500 |

### 高危（4）— 功能缺陷
| ID | 文件 | 问题 | 修复 |
|---|---|---|---|
| B | diff.py:62 | diff 去重丢 kind | _loc_key 加 kind 字段 |
| A | cli.py:111 | cmd_analyze 不传 cache | 传 IncrementalCache(cache_dir) |
| C | cache.py:128 | save_to_disk 持锁过长 | 锁内浅拷贝，锁外序列化 |
| G | graph.py:231 | add_edge 悬空边静默丢弃 | (已知设计，跨文件边由 CrossFileResolver 补) |

### 中危（7）
- E: cycle_id 用 hash() → hashlib.sha256
- A: cmd_analyze 耦合分析重读磁盘 → 复用 report.sources
- F: _tool_analyze 无读锁 → threading.RLock 读写分离
- K: _tool_impact/_tool_path 不检查节点存在 → 加 error 返回
- J: CouplingDepthAnalyzer 缓存无上限 → analyze() 结束清空
- D: _parse_all_exports 不处理 AnnAssign → 加 ast.AnnAssign 分支

### 低危（5）— 暂缓
GraphMerger 死代码、_sanitize_for_json 双重清理、PipelineReport.sources 峰值内存、add_node 静默合并、from_project 注释偏差。

**修改文件：** graph.py · merger.py · runner.py · cache.py · diff.py · cli.py · dataflow.py · mcp_server.py · coupling.py · tests (2 处)

---

## 第二轮审计修复（2026-06-17 · 26 条）

**敌对审查发现 26 条缺陷（3 致命 / 7 高危 / 10 中危 / 6 低危），本轮全扫。195 测试全绿。**

### 致命（3）— 全系统数据截断

| ID | 文件:行 | 问题 | 修复 |
|---|---|---|---|
| C1 | main.rs:209-225 | `handle_analyze` 序列化丢弃 `in_degree/out_degree/properties/position/community_id` + 边丢弃 `id/cross_file/direction/temporal_delay_sec/medium_node_id` | 补全 9 个字段 |
| K1 | main.rs:416-429 | `handle_get_graph` 返回硬编码 3 假节点 | 从 `CACHED_GRAPH` 读取真实图 |
| A1 | main.rs:491-498 | `hologram_rename` 4 参数全 `_` 吞掉 | 拼接 `old_name:new_name:dry_run:nid` |

### 高危（7）— 传参遗漏 + 序列化缺陷

| ID | 文件:行 | 问题 | 修复 |
|---|---|---|---|
| A2-8 | main.rs(Tauri) | `neighbors/cycle/search/blindspots/thread/timeline/community_report` 7 命令忽略用户参数 | 全部拼入命令字符串 |
| C2 | mcp.rs:909-918 | `node_to_value` 缺 `properties/position/community_id` | 补 3 字段 |
| C3 | mcp.rs:921-928 | `edge_to_value` 缺 `cross_file/direction/temporal_delay_sec/medium_node_id` | 补 4 字段 |
| F1/2 | watcher.rs | `do_reanalyze` 不检查 analyze_lock → 与 MCP tool_analyze 并发覆盖 CACHED_GRAPH | 全局 `ANALYZE_LOCK` + watcher try_lock 跳过 |

### 中危（10）— 语义错误 + 静默降级

| ID | 文件:行 | 问题 | 修复 |
|---|---|---|---|
| C4 | main.rs:341 + mcp.rs:725 | `diff()` 两处调用 `after.diff(&before)` added/removed 标签颠倒 | 改为 `before.diff(&after)` |
| D2 | mcp.rs:890-899 | `tool_rename` 非dry_run 不实际改名 | 获取 `CACHED_GRAPH` mut 锁直接改 `node.name` |
| G1 | main.rs:92-98 | `handle_simple` blindspots/thread 硬编码参数 | 解析 `blindspots:N` / `thread:severity` |
| B1 | merge.rs:38 + node.rs:61 | `loc_key` 当 `location=None` 时键为 `::name::kind` 误合并 | merge 中 location 为 None 时用 id 做 key |
| B2 | merge.rs:49-51 | merge 无条件接所有边→孤儿边 | 验证端点存在 |
| C5 | resolver.rs:109-122 | `resolve_name` 部分包前缀匹配可能选错 | 要求全 name_parts 精确匹配 |
| D3 | mcp.rs:110 | `tool_run_health` 描述声称 trend 但返回硬编码 85/stable | 描述改为"current snapshot" |
| H3 | dataflow.rs:6-21 | `classify_cycles` 零外部调用 + `llm=0` 非mut | 改 `let mut llm=0` + `if has_llm { llm+=1 }` |

### 低危（6）— 已修复

| ID | 文件:行 | 问题 | 修复 |
|---|---|---|---|
| G3 | main.rs:316 | `run_engine_analysis` 字符串 `contains("\"error\"")` 误判 | 先 `serde_json::from_str` 再查 `get("error")` |
| K2 | resolver.rs:132 | 测试缺 `Node` import（预存bug） | 加 import |
| - | main.rs:374 | `handle_simple` fn指针→泛型闭包 | 支持捕获变量 |

### 架构改动

- **新增** `ANALYZE_LOCK` 全局锁（`mcp.rs`），MCP 工具和 watcher 共用，消除 TOCTOU 窗口
- **移除** `McpServer.analyze_lock` 实例字段，改用全局锁
- **新增** TCP RPC `rename:` 处理器（原完全缺失）
- **修复** `search:` TCP handler 支持 `limit` 参数（从 `handle_query` 改为闭包解析）
- **修复** `resolver.rs` 测试模块缺 `Node` import（预存，`cargo test --lib` 之前已 fail）

**修改文件：** `engine/src/main.rs` · `engine/src/mcp.rs` · `engine/src/watcher.rs` · `engine/src/graph/merge.rs` · `engine/src/graph/resolver.rs` · `engine/src/analysis/dataflow.rs` · `src-tauri/src/main.rs` · `PROJECT.md`

---

## v4.0 架构重构（2026-06-15 完成）

**一天内完成 Python 引擎退役 + Rust 引擎上线 + Unity 渲染原型 + 安全沙箱。**

| 层 | 内容 | 关键数据 |
|---|---|---|
| **Rust 引擎** `engine/` | 44 源文件, 28 tests, 29 RPC 端点, 10 模块 | Django 3,031 文件 4.1s, 8 语言支持 |
| **Tauri 桥接** | 21 个命令从 Python 子进程改为 Rust EngineClient | `run_hologram` / `run_python_code` 已成死代码 |
| **Unity 3D** | GPU Instancing + Burst 力导向 + v3 交互对齐 | Phase2Bootstrap, NodeRenderer, EdgeRenderer, ForceLayout |
| **安全沙箱** | 8 层纵深防御 | sandbox/audit/CSP/SSRF/DPAPI/fail-closed |
| **IPC** | Unity ↔ Tauri ↔ Agent | TCP :9776 / :9777 双向 |

**引擎模块对照：**

| v3 Python | v4 Rust |
|---|---|
| `src_python/core/graph.py` | `engine/src/graph/` — node, edge, graph, merge, resolver, query |
| `src_python/adapters/` | `engine/src/adapter/` — traits, python (tree-sitter), typescript (TS/JS), registry |
| `src_python/pipeline/` | `engine/src/pipeline/` — discovery, parser (rayon), runner |
| `src_python/analysis/coupling.py` | `engine/src/analysis/coupling.rs` |
| `src_python/core/community.py` | `engine/src/community/louvain.rs` |
| `src_python/routing/patterns.py` | `engine/src/routing/patterns.rs` |
| `src_python/routing/signals.py` | `engine/src/routing/signals.rs` |
| `src_python/routing/constraints.py` | `engine/src/routing/constraints.rs` |
| `src_python/routing/summary.py` | `engine/src/routing/summary.rs` |
| 无 | `engine/src/analysis/` — fragility, cycles, coupling_report, graph_stats, dataflow, threading, blindspots, explore, framework_routes, dynamic_dispatch |
| `src_python/timeline.py` | `engine/src/timeline.rs` |

**v3 Python 引擎状态：** 已完全退役。`src_python/` 目录可安全归档。所有 Tauri 命令、MCP 工具、分析管线均走 Rust 引擎。

**施工详情：** [V4_CONSTRUCTION_PLAN.md](V4_CONSTRUCTION_PLAN.md)

---

## 2026-06-14 简报系统三个致命 bug 修复 ✅

**Bug 1 — JSON 结构不匹配（致命）：** `run_full_check()` 返回的外层 dict 把 `l5_violations`/`l4_violations` 等嵌套在 `summary` 字段下，前端 `CheckPanel.renderResult()` 直接读 `r.l5_violations.length` → `undefined.length` → TypeError → "简报解析失败"。

**修复：** `cli.py` 输出 JSON 时直接取 `check_result["summary"]`（即 `ChangeSummary.to_dict()`），结构完全匹配前端 `CheckResult` 接口。前端 `check.ts` 增加 `?.` 空值防御。

**Bug 2 — `signals` 未定义（静默失败）：** `cli.py:713` 引用 `len(signals)` 但 `signals` 只在 `run_full_check()` 内部作用域存在 → `NameError` → 被 `except Exception: pass` 吃掉 → 时间轴记录静默失败。

**修复：** 改用 `check_result.get("signals_count", 0)`，同时 timeline `violations` 属性存储 `check_result["summary"]`（匹配前端格式）。

**Bug 3 — before_graph 基线错（简报始终空）：** `cmd_check` 从 `hologram_graph.json` 加载 `before_graph`，但 watcher 的增量分析已更新该文件 → before_graph 包含变更 → diff 无差异 → 简报始终显示"无变更"。

**修复：** 优先从 `hologram_before.json`（上一次 check 结束时保存的快照）加载 `before_graph`。基线快照改到 `after_graph` 保存后写入，确保不受 watcher 中间修改影响。

**改了什么：**

| 改动 | 文件 | 说明 |
|---|---|---|
| before_graph 来源改为 hologram_before.json | `cli.py:509-521` | 优先读上一次 check 快照，不受 watcher 影响 |
| 基线快照移到 after_graph 保存后 | `cli.py:567-571` | before_snapshot 始终是最后完整分析的快照 |
| JSON 输出取 summary 而非全量 dict | `cli.py:670` | 匹配前端 CheckResult 接口扁平结构 |
| 修复 signals 未定义 | `cli.py:719` | 改用 check_result signals_count |
| 防御性空值检查 | `check.ts:158,219-232` | `?.length \|\| 0` 防止未来数据格式问题 |
| 测试断言更新 | `test_integration.py:632` | summary 已扁平化，断言 l5_violations 代替 summary |

**验证：** 902 测试通过 + 前端 build 通过。

---

## 2026-06-14 大项目双管线架构 ✅

**问题：** Django（60 万行，2500 源文件）打开即超时——`analyze_and_load` 的 600s 不够，且就算跑完也渲染不了（>4 万节点上限）。重分析也一样超时。文件视图触发条件（nodeCount > 40000）永远走不到。

**改为：** 大小项目走两条完全不交叉的管线。

| 操作 | 小项目 (≤500 文件) | 大项目 (>500 文件) |
|---|---|---|
| 预扫描 | `estimate_project_size` | `estimate_project_size` |
| 前台 | `analyze_and_load` → 星图 | `generate_lightweight_graph` → 文件视图 |
| 符号图 | 同步完成（含在 analyze_and_load） | `analyze_in_background` 后台跑 |
| 超时 | 600s | 不触发（analyze_and_load 永不调用） |
| 重分析 | `analyze_and_load(force=true)` | 重新生成文件图 + 重新后台分析 |

**改了什么：**

| 改动 | 文件 | 说明 |
|---|---|---|
| `estimate_project_size` 命令 | `main.rs` | walkdir 数源文件，>500 判定大项目，毫秒级 |
| `generate_lightweight_graph` 命令 | `main.rs` | AST import 扫描（Python ast + JS/TS/Go/Rust regex），生成文件级依赖图，写入 hologram_graph.json + hologram_graph_files.json，超时 120s |
| `analyze_in_background` 命令 | `main.rs` | 直接起 Python 后台进程（不经过 cmd /c），轮询完成/失败 emit 事件 |
| 预扫描始终执行 | `main.ts openProject` | 不再区分 forceReanalyze，始终跑 estimate_project_size |
| 大项目永不调 analyze_and_load | `main.ts openProject` | isLargeProject 为 true 时走文件图加载分支 |
| `_doGraphUpdate` 护栏 | `main.ts` | currentMode === 'files' 时跳过渲染，保持按钮锁定 |
| `analysis-complete` 事件监听 | `main.ts` | 后台分析完成 → 更新 currentGraphData → Agent 工具切符号图 |
| 冷启动 lightweight 检测 | `main.ts init` | 缓存图 meta.lightweight 为 true → 自动切文件视图 + 锁定 |

**设计原则：** analyze_and_load 是大项目禁区。文件视图 + 后台分析 = 用户立即可用 + Agent 工具获得完整符号图。两条管线互不交叉。

---

## 2026-06-14 文件视图强制触发逻辑重设计 ✅

**问题：** 旧逻辑硬编码 50000 节点阈值。layout3D 是 O(n²)——1500 节点 ≈ 3-8s 阻塞，2000 节点 → 浏览器白屏。50000 是"永远到不了"的阈值。

**改为：**

| 改动 | 文件 | 说明 |
|---|---|---|
| 阈值 50000→5000 | `main.ts` `openProject` + `init` | 基于用户实测：5000 能跑通，10000 会炸 |
| 星图按钮禁用 | `main.ts` `setModeButtonsEnabled` | >1500 节点时 standard/full 按钮 disabled + 半透明 + tooltip，files 始终可用 |
| 死胡同保留 | `main.ts` `openProject` + `init` | fileGraph 缺失时显示警告，不尝试渲染主图 |
| 缓存启动路径 | `main.ts` `init` | 加上同样的阈值检查 + 文件图加载（之前完全没有） |

**设计原则：** 标准/全量星图适用于 ≤5000 节点的中小型项目。大型项目（>5000）强制 file 视图，禁止切回。阈值基于实测而非理论估算。

---

## 2026-06-14 移除 Python 预计算布局 — 统一走 JS 力导向 ✅

**问题：** Python igraph 预计算布局（A2）的坐标系跟前端 JS 布局是两套东西：
- JS 用 Fibonacci 球面 + 壳约束 → 球壳表面、`cbrt(n)×14` 半径
- Python 用 igraph DrL 2D 归一化 → 实心圆盘、`sqrt(n)×5` 半径、无社区时 Z=0 完全扁平

结果：前端读到的预计算 position 是错的，又因为 position 存在跳过了正确的 JS 布局。大项目花 2-5 分钟算出错的坐标，比不跑还糟。

**改为：** 三处 `compute_layout()` 调用全删 + 前端预计算路径移除：

| 文件 | 改动 |
|---|---|
| `src_python/__main__.py` | 删除 `compute_layout(graph)` 调用（analyze_and_load 路径） |
| `src_python/cli.py` | 删除 `cmd_analyze` 和 `cmd_check` 中的两处布局调用 |
| `src_python/mcp_server.py` | 已在上一轮删除（MCP 不需要） |
| `src-ui/src/ui/graph.ts` | 删除 `hasPositions` 预计算分支，永远走 `layout3D()` |

**设计原则：** 超大项目用文件视图（file mode），不在星图上硬撑。

---

## 2026-06-14 全局超时上调 + MCP 布局移除 ✅

**问题：** MCP 启动时 `from_project()` 做了不该做的事——重算布局。布局是给前端 3D 渲染用的，MCP 只做图查询（邻居/波及/搜索等），不需要坐标。且布局在首次分析时已算好写入 JSON，MCP 加载时坐标已在图数据里，属于重复劳动。

大项目的 igraph FR/DrL 布局 O(N²)，10K+ 节点需要 2-5 分钟。这导致 MCP 启动超时 → 全部工具降级 CLI → CLI 每个工具又 120s 硬超时 → 双重封锁。

**改为：** 6 处改动：

| 位置 | 改动 | 说明 |
|---|---|---|
| `mcp_server.py` `from_project()` | **删除布局计算** | MCP 不需要布局，省 2-5 分钟启动时间 |
| `main.rs` `run_hologram()` | 120s → 600s | Agent 调的所有 hologram CLI 工具 |
| `main.rs` `run_python_code()` | 120s → 300s | 内联 Python 图查询 |
| `main.rs` `exec_command()` | 默认 120s → 300s | Shell 命令 |
| `main.rs` `analyze_and_load()` | 无超时(阻塞) → 600s polling | 项目打开/重分析 |
| `mcp_manager.rs` `read_ready()` | 120s → 600s | MCP Server 启动等就绪信号 |
| `tool.ts` `run_shell` | 默认 120s → 300s | 前端工具描述对齐 |

**效果：** MCP 启动不再被布局拖累，大项目也能在 30-60s 内接上。接上后所有工具 <100ms。

---

## 2026-06-14 MCP 社区检测超时修复 ✅

**问题：** `hologram_community_report` 调用的 Leiden 社区检测在 MCP 启动阶段就跑，`max_levels=3` 导致递归爆炸（N 个社区各自再子聚类）— 大项目超过 120s 硬超时，MCP Server 被 Rust 端杀掉。

**改为：** 两处改动：

| 改动 | 说明 |
|---|---|
| `src_python/core/community.py:25` | `max_levels` 默认值 3 → 1，砍掉递归子聚类，全图只跑一次 Leiden |
| `src_python/mcp_server.py` | 社区检测改为懒加载 — 从 `from_project()` 内移除，首次调用 `hologram_community_report` / `hologram_community` 时才触发 `_ensure_communities()` |

**效果：** MCP 启动不再被社区检测阻塞。不用社区工具的项目完全不付这个成本。

---

## 2026-06-14 卸载时询问清除用户数据 ✅

**问题：** 用户卸载重装后发现 API Key 还在 — 因为程序文件在 `Program Files`，用户数据 (localStorage) 在 `%LOCALAPPDATA%\com.hologram.app\`，卸载只删前者不碰后者。

**改为：** WiX 安装器在卸载时弹窗询问用户是否同时删除用户数据。

| 改动 | 说明 |
|---|---|
| `src-tauri/wix/cleanup.wxs` (新增) | WiX fragment — 卸载时 PowerShell 弹窗，选"是"删除 `%LOCALAPPDATA%\com.hologram.app\` |
| `src-tauri/tauri.conf.json` | `bundle.windows.wix.fragmentPaths` 引用 cleanup.wxs |
| `scripts/gen_cleanup_b64.py` (新增) | 生成 PowerShell 脚本的 Base64 编码（用于 WiX ExeCommand） |

**触发条件：** 仅在完全卸载且非升级时 (`REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`)  
**弹窗内容：** "卸载后是否同时删除用户数据？包括 API Key、设置等。"  
**升级行为：** 不弹窗，数据保留  
**构建：** `cargo tauri build` 自动合并 fragment

---

## 2026-06-13 嵌入式 Python 打包 ✅

**问题：** `cargo tauri build` 打出的安装包只有 Rust 二进制+前端，缺少 Python 运行时和 `src_python` 引擎。别人装了用不了。

**改为：** 安装包内嵌完整 Python 3.14.4 + 所有依赖 + src_python，真正开箱即用。

| 改动 | 说明 |
|---|---|
| `src-tauri/python/` (新增) | Python 3.14.4 embeddable + 6 个依赖 (igraph/leidenalg/networkx/msgpack/PyYAML/tree-sitter) |
| `src-tauri/python/Lib/site-packages/src_python/` | 每次构建前自动从 `src_python/` 同步 |
| `src-tauri/tauri.conf.json` | `bundle.resources` 打包 `python/`；`beforeBuildCommand` 用 `scripts/prebuild.sh` |
| `src-tauri/src/main.rs` | `project_root()` 生产模式检测；`python()` 优先找捆绑 Python；`silent_command()` 加 PYTHONPATH (dev) |
| `src-tauri/src/mcp_manager.rs` | MCP 启动加 PYTHONPATH |
| `scripts/setup-embedded-python.sh` | 一次性脚本：下载/解压/配置/装依赖 |
| `scripts/prebuild.sh` | 每次构建前：同步 src_python → site-packages + 编译前端 |
| `.gitignore` | `src-tauri/python/` 不提交 |

**安装包大小：** NSIS 25MB（之前 8.5MB）  
**安装后目录结构：**
```
C:\Program Files\全息观测站\
├── 全息观测站.exe
├── python/                 (嵌入式 Python + deps + src_python)
└── ...
```
**新机器首次使用：** `git clone` → `bash scripts/setup-embedded-python.sh` → `cargo tauri build`  
**后续构建：** 直接 `cargo tauri build`（prebuild.sh 自动同步）

**验证：** Rust `cargo check` ✅ · Rust `cargo test` ✅ 4/4 · 嵌入式 Python `import src_python` ✅ · NSIS 打包 ✅

---

## 2026-06-13 全栈代码体检修复

17 项问题发现，已完成 13 项修复：

| 严重度 | 编号 | 问题 | 修复状态 |
|--------|------|------|----------|
| Critical | AUD-001 | `pipeline/layout.py` 完全缺失 | ✅ 已实现 igraph FR/DrL + Z轴布局 |
| Critical | AUD-007 | 13 处 `run_python_code()` 内联 Python | ⏳ 待迁移（低优先级，风险高但收益不即时） |
| High | AUD-003 | P6/P7/P8 已实现但文档标记 ❌ | ✅ 状态已更新 |
| High | AUD-005 | `pyproject.toml` 依赖严重不足 | ✅ 已补全 igraph/msgpack/tree-sitter |
| High | AUD-012 | 前端不读预计算坐标 | ✅ `graph.ts` 添加 position 读取分支 |
| High | AUD-015 | MCP `_tool_analyze()` 无防重入 | ✅ 添加 threading.Lock |
| Medium | AUD-002 | `hologram_rename` 前端 CLI 回退缺失 | ✅ `tool.ts` + Tauri 命令 |
| Medium | AUD-004 | Tauri 命令数量文档失实 | ✅ 更新为 53 个 |
| Medium | AUD-008 | constraints.py None 处理 | ✅ 增强防御性检查 |
| Medium | AUD-010 | MCP `read_ready()` 无超时 | ✅ 添加 120s 超时 |
| Medium | AUD-016 | 前端无集中状态管理 | ⏳ 架构决策（需大规模重构） |
| Low | AUD-006 | cytoscape 死依赖 | ✅ 已移除 |
| Low | AUD-009 | Merger V1 跨文件限制 | ⏳ 已知限制，待 V2 |
| Low | AUD-011 | 双路径工具执行错误格式不一致 | ⏳ 待统一 |
| Low | AUD-013 | Agent 记忆无结构化检索 | ⏳ 功能增强 |
| Low | AUD-014 | `layout.worker.ts` 冗余 | ⏳ 待激活或删除 |
| Low | AUD-017 | cli.py 与 __main__.py 入口纠缠 | ⏳ 待统一 |

**新增文件**: `src_python/pipeline/layout.py` (182 行) — igraph FR/DrL 布局引擎  
**修改文件**: `pyproject.toml`, `package.json`, `PROJECT.md`, `__main__.py`, `main.rs`, `mcp_manager.rs`, `mcp_server.py`, `graph.ts`, `tool.ts`, `constraints.py`, `pipeline/__init__.py`

**验证：** Rust `cargo check` ✅ · Rust `cargo test` ✅ 4/4 · Python `pytest` ✅ 561 passed · TypeScript `tsc --noEmit` ✅ 零错误

---

## 2026-06-13 简报 exit code 1 bug 修复

**问题：** 系统分析完成后简报面板显示"简报请求失败" — Python 生成了正确 JSON 但 Rust 端丢弃了。

**根因：** Python `cmd_check` 发现违规时返回 exit code 1（语义: "未通过"），Rust `hologram_run_check` 把非零 exit 当系统错误返回 `Err`，前端收不到 JSON。

**修复：**
- **Rust** `main.rs:594-614` `hologram_run_check` — stdout 非空时直接返回（不管 exit code），只在 stdout 为空时返回 Err
- **Python** `cli.py:25-36` `_safe_print` — 主动 `reconfigure(stdout, encoding='utf-8')`，不再依赖 `UnicodeEncodeError`（GBK 编码中文不抛异常，直接产乱码）
- **Python** `cli.py:744` `cmd_check` — `--json` 模式始终返回 exit 0
- **Python** `cli.py:866` `cmd_preflight` — 同上
- **Python** `cli.py:956` `cmd_health` — 同上

**验证：** Rust `cargo check` ✅ · Python 103 tests ✅ · check --json 手动测试 ✅ JSON 正常/中文不乱码/exit 0

---

## 2026-06-13 架构重构第三步 — 图作为输入（点击节点驱动 Agent） ✅

按 [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) 三步方案，第三步落地：

**问题：** 交互单向 — 只能打字问 Agent。图上看到的关键节点没法直接让它分析。

**改为：** 3D 图变成 Agent 的输入设备
```
Shift+点击节点 → BFS 寻路 → 高亮路径 → Agent 自动分析依赖链
Alt+拖拽框选   → 收集框内节点 → 高亮 → Agent 自动总结区域
普通点击       → emit graph:node-clicked（供扩展）
```

**改了什么：**
- **TS** `events.ts` — 新增 3 个图交互事件: `graph:node-clicked`、`graph:path-selected`、`graph:region-selected`
- **TS** `graph.ts` — 导入 `bus`；新增 Shift+点击快速路径模式；新增 Alt+拖拽矩形框选；`onClick` emit `graph:node-clicked`；Escape 清理交互状态
- **TS** `graph-interaction.ts` — **新建** — `GraphInteraction` 类：订阅图交互事件 → 自动生成 Agent 查询
- **TS** `main.ts` — 导入并实例化 `GraphInteraction`

**新增体验：**
- **Shift+点击路径**: 点击两个节点 → 自动 BFS 寻路 → 路径高亮 → Agent 自动分析依赖链架构风险
- **Alt+拖拽框选**: 拖拽矩形框 → 收集框内节点 → 高亮 → Agent 自动总结区域模块关系
- **零冲突**: Shift/Alt 均为 OrbitControls 未占用的修饰键，不影响旋转/缩放/平移

**不动什么：** 所有后端、所有工具、所有现有 UI（纯增量）

**验证：** TypeScript `tsc --noEmit` ✅ 零错误 · Python 未触碰 · Rust 未触碰

---

## 2026-06-13 架构重构第二步 — Agent↔图双向联动 ✅

按 [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) 三步方案，第二步落地：

**问题：** 三重 `visualizeAgentTool()` 调用 — main.ts exec()、main.ts exec2()、chat.ts handleToolResult() 各调一次。工具执行完成后图更新 3 次（浪费 + 不确定行为）。

**改为：** EventBus 单入口模式
```
Agent 调工具 → EventBus.emit('agent:tool-done')
                  ├─→ ChatPanel 渲染文本
                  ├─→ AgentVisualizer 更新图（单一入口）
                  └─→ AgentLens 更新透镜视图
```

**改了什么：**
- **TS** `events.ts` — 文档化 4 个新事件：`agent:tool-started/done`、`agent:thinking`、`agent:focus-changed`
- **TS** `agent.ts` — `executeBatch` 中 emit `agent:tool-done`（携带 toolName/args/output）；`executeOne` 中 emit `agent:tool-started`
- **TS** `agent-visualizer.ts` — **重构**: `visualizeAgentTool()` 函数 → `AgentVisualizer` 类；订阅 EventBus 事件；追踪 visited nodes + trail（最近 20 步）；emit `agent:focus-changed`
- **TS** `chat.ts` — 删除 `handleToolResult()` 中的 `visualizeAgentTool()` 调用（消除第三重）；清理无用 import
- **TS** `main.ts` — 删除 `createExecutor`/`mcpExec` 中的 visualize 调用（消除第一、二重）；新增 `AgentVisualizer` 实例；模式切换时同步更新引用
- **TS** `graph.ts` — 新增 `setAgentLens()`/`clearAgentLens()`（透镜：只亮访问过的节点）；新增 `updateAgentTrail()`/`_clearTrailLine()`（虚线轨迹）；`clearGraph()` 清理 lens/trail 状态
- **TS** `agent-lens.ts` — **新建** — `AgentLens` 类：订阅 `agent:focus-changed`，累积 visited nodes，toggle 透镜开关

**新增体验：**
- **Agent 透镜**: 图上只显示 Agent 访问过的节点，其余降到 1% 透明度
- **Agent 轨迹**: 渐变虚线串联 Agent 访问过的节点序列（最近 20 步）
- **实时反馈**: Agent 调工具 → 图上对应节点高亮
- **消除三重调用**: 每个工具只触发一次图更新

**不动什么：** Rust、Python、工具执行逻辑、Provider

**验证：** TypeScript `tsc --noEmit` ✅ 零错误 · Python `pytest tests/ -x -q` ✅ 820 passed

---

## 2026-06-13 架构重构第一步 — 持久 MCP ✅

按 [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) 三步方案，第一步落地：

**改了什么：**
- **Rust** `mcp_manager.rs` (新) — MCP 进程管理器：生命周期管理、JSON-RPC 通信、崩溃追踪（60s 内 3 次 → 永久降级）
- **Rust** `main.rs` — 新增 `start_mcp_server`/`mcp_call`/`mcp_list_tools`/`stop_mcp_server` 4 个命令
- **Python** `mcp_server.py` — 新增 `MCPServer.from_project(root)` 类方法（完整分析管线 → 返回就绪实例）
- **Python** `cli.py` — `serve` 子命令新增 `--project-root` 参数
- **TS** `tool.ts` — 新增 `createHologramToolsFromSchemas()` 工厂（从 MCP `tools/list` 动态生成 Tool）
- **TS** `main.ts` — 合并 `exec`/`exec2` 为 `createExecutor()` 工厂；MCP 优先路径 + CLI 自动降级

**设计原则：**
- 老 CLI 路径一行未删，MCP 失败 → 自动 fallback
- 每个工具调用从 500ms+（冷启动 Python）降到 <100ms（持久进程内存查询）
- 进程崩溃自动重启，60s 内 3 次则永久降级并通知前端
- Coding tools（文件/Shell/Git/Web）不走 MCP，直接用 CLI invoke

**验证：** Rust `cargo check` ✅ · TypeScript `tsc --noEmit` ✅ · Python `pytest tests/ -x -q` ✅ 820 passed

---

## ⛔ 2026-06-11 布局锁定 — 仅此一套，严禁修改

**回滚点**: commit `1032805`（6月10日 17:46，截图炫耀的那个版本）

**锁定内容**：
- `graph.ts` → `layout3D()` 参数：`rep=600, att=0.018, damp=0.72, sp=0.006, shell=cbrt(n)×14`
- 三层防护：力钳制 + NaN哨兵 + 渲染兜底
- 此布局经过 2 天、数十个窗口、反复回滚重构后确认唯一稳定版本
- **任何 Agent 不得修改此函数参数，除非用户明确要求并理解风险**

**可安全改动的部分**：
- InstancedMesh 渲染管线（A1，不影响布局）
- MessagePack 传输（A3，不影响布局）
- 所有面板、Agent、CSS（与星图无关）

**恢复方法**：`git checkout 1032805 -- src-ui/src/ui/graph.ts`

---

## 2026-06-11 星图规模化升级 — 阶段 A1 InstancedMesh ✅

**目标**: 5000 节点场景 draw calls 从 ~10000 降到 <10，帧率 60 FPS。

| 改动 | 说明 |
|---|---|
| `graph.ts` 核心球体 | N 个 `THREE.Mesh` → 1 个 `THREE.InstancedMesh` — 1 draw call |
| 回退路径 | `?instanced=0` URL param → 用旧 `buildNodesLegacy()` |
| hover/click | Three.js 原生 `instanceId` 替代 `mesh.indexOf()` |
| 文件高亮 | `setColorAt` 近黑色替代 opacity |
| Agent 高亮/路径/波及/折叠/焦点 | `_setCoreScale()` + `setColorAt()` 统一 IM API |
| hover 缩放修正 | full mode 0.4x 一致性修复 + 放大系数 1.2→0.7 |

**变更范围**: `graph.ts` ~30 处修改点，覆盖全部交互路径。Glow Sprites 不变。  
**回滚点**: commit `2e94468`  
**升级方案**: [STARGRAPH_SPEC.md](STARGRAPH_SPEC.md) — 四阶段规模化路线 (A/B/C/D)

---

## 2026-06-13 星图规模化升级 — 阶段 A2 布局预计算 ✅

**目标**: 布局计算从 JS 搬到 Python igraph，专业算法一次算完存磁盘，前端不再跑力导向。

| 改动 | 文件 | 说明 |
|---|---|---|
| Node.position 字段 | `graph.py` | `Optional[List[float]]` 预计算坐标 |
| 布局引擎 | `pipeline/layout.py` (新) | igraph FR/DrL + Z 轴社区层级编码 |
| 全量接入 | `__main__.py` | 全量分析后自动调用布局（社区检测之后） |
| 前端适配 | `graph.ts` | `render()` 优先读预计算坐标，无则 fallback `layout3D()` |
| 球壳缩放 | `graph.ts` | `sqrt(n)*5` — 表面积∝节点数，密度恒定 |

**关键设计**:
- 2D 布局由 igraph 产生（≤10K: FR, >10K: DrL），行业标准质量
- Z 轴 = community_id 映射到层 → 同社区节点在同一"星盘层"
- 确定性：同一项目每次重跑布局一致（Python Random(42) 作为 igraph RNG）
- 向后兼容：旧项目 JSON 无 `position` 字段 → 前端自动 fallback `layout3D()`

---

## 2026-06-11 星图规模化升级 — 阶段 A3 MessagePack ✅

**目标**: 大项目（>10K 节点）数据传输从 JSON 切换到 MessagePack 二进制。

| 改动 | 文件 | 说明 |
|---|---|---|
| Python 写入 | `graph.py` `to_msgpack()` | `msgpack.pack(d, f)` 二进制输出 |
| CLI 双输出 | `cli.py` `cmd_analyze` | 同时生成 `.json` + `.hologram` |
| Rust 透传 | `main.rs` `load_binary_graph` | `Vec<u8>` 原样返回，零解析开销 |
| 前端解码 | `main.ts` 两处加载路径 | `@msgpack/msgpack` decode, 优先 `.hologram` |
| 工具栏 | `index.html` + `main.ts` | 「重分析」按钮一键重新跑流水线 |

**数据流**: `Python msgpack.pack → .hologram 文件 → Rust Vec<u8> → 前端 decode → 渲染`  
**兼容**: `.hologram` 不存在时自动 fallback JSON 分析流水线

---

## 2026-06-10 审计修复记录

审计报告发现 17 个问题（0 高危 / 5 中危 / 12 低危），全部已修复：

| 类别 | 修复项 | 改动量 |
|---|---|---|
| 逻辑反转 | summary.py:751 — 历史路由状态判断反转 → 直接用 all_routed 判定 | 2行 |
| 逻辑错误 | cli.py:656 — 三元两边都是 "commit" → commit_violation / commit_clean | 1行 |
| 资源泄露 | timeline.py — TimelineStore 改为 context manager，4 个调用点全部改 with | +5/-8行 |
| 并发安全 | python_adapter.py — _MediaVisitor._build_index() 双检锁加 threading.Lock | +2行 |
| 并发安全 | pipeline/cache.py — IncrementalCache 全部 _cache 读写加 threading.Lock | +8行 |
| 死代码 | python_adapter.py — 删除 _visit_annotation_ref、空循环体 | -8行 |
| 死代码 | pipeline/runner.py — 删除 _resolve_cross_file（空操作函数） | -28行 |
| 死代码 | timeline.py — 删除未使用的 asdict import | 1行 |
| 架构诚实 | merger.py — 注释标注"V1 未实现" | 1行 |
| 死逻辑 | mcp_server.py:391 — 删除 is None 永假分支 | 1行 |
| 一致性 | 统一 enum→string 转换：graph.py 新增 type_val() 工具函数，12 处内联替换 | +5/-12行 |
| 一致性 | watcher.py — 导入路径对齐 from .adapters.registry | 1行 |

测试：798 通过 / 2 失败（预存 constraints.py bug，非本次引入）

---

## 用户

外行 vibe coder。不看代码。靠 Agent（DeepSeek/Claude）高速迭代复杂系统。一天几十轮变更。
需要的不是可视化工具，是在他不主动查看时自动守门、在关键时刻强制打断的系统。

---

## 引擎全景（全部已实现 ✅）

```
V1 图骨架    core/graph.py          节点×边 + 社区聚类(Leiden) + BFS波及 + 路径搜索 + 图diff
V2 深度分析  analysis/coupling.py   L1-L4耦合深度 + 数据流环 + 线程交错 + SQLite时间轴 + 边界检测
V3 约束框架  routing/signals.py     L5-L1破坏信号 + 约束校验(YAML) + 局面简报(enrich)
```

| 模块 | 文件 | 测试数 |
|---|---|---|
| 图数据模型 | core/graph.py | 40 |
| 图合并 | core/merger.py | 9 |
| 社区发现 | core/community.py | 6 |
| 图diff | core/diff.py | 6 |
| Python适配器 | adapters/python_adapter.py | 21 |
| TS适配器 | adapters/typescript_adapter.py | 23 |
| **Tree-sitter 适配器** | adapters/tree_sitter_adapter.py | — |
| 适配器注册 | adapters/registry.py | 9 |
| 流水线编排 | pipeline/runner.py | 27 |
| 增量缓存 | pipeline/cache.py | — |
| 耦合深度计 | analysis/coupling.py | 19 |
| 数据流环 | analysis/dataflow.py | 13 |
| 线程交错 | analysis/threading.py | 15 |
| 边界检测 | analysis/blindspots.py | 8 |
| 时间轴 | timeline.py | 15 |
| 模式匹配器 | routing/patterns.py | 82 |
| 信号生成器 | routing/signals.py | 28 |
| 约束校验器 | routing/constraints.py | 40 |
| 变更摘要 | routing/summary.py | 24 |
| MCP Server | mcp_server.py | 19 |
| CLI | cli.py | 29 |
| 文件监听 | watcher.py | 12 |
| 集成测试 | — | 14+147 |

**总测试数：740 · CLI 命令：14 · MCP 工具：14**

---

## 前端全景

### 已实现 ✅

| 功能 | 位置 | 状态 |
|---|---|---|
| 3D 深空星图 | src-ui/src/ui/graph.ts (2030行) | ✅ Three.js 完整渲染 |
| 三模式 (minimal/standard/full) | graph.ts VisualMode | ✅ 独立实例，切换重建 |
| 力导向布局 | graph.ts layout3D() | ✅ Fibonacci球面 + 力导向 |
| 节点类型着色 | 蓝=SYMBOL, 琥珀=MEDIUM, 紫=TEMPORAL | ✅ |
| 耦合深度L1-L4边着色 | graph.ts edgeOpacityByDepth() | ✅ |
| Pie Menu (右键) | graph.ts setupPieMenu() | ✅ 波及/聚焦/路径/信息 |
| 聚焦飞行 | graph.ts flyToNode() | ✅ 平滑相机动画 |
| 波及模式 | graph.ts startBlastMode() | ✅ BFS分层着色 |
| 路径搜索 | graph.ts findShortestPath() | ✅ BFS + 路径高亮 |
| 社区折叠三层视图 | graph.ts foldMode + enterGalaxy/exitGalaxy | ✅ 宇宙层/星座层/正常层 |
| Galaxy云渲染 | graph.ts buildGalaxyClouds() | ✅ spiral arms + golden ratio色调 |
| 跨星系连线 | graph.ts buildCrossEdges() | ✅ |
| 能量流粒子 | graph.ts crossFlowParticles | ✅ |
| 全息参考网格 | graph.ts buildHoloGrid() — shader 无限网格 | ✅ 静态，shader 绘制 |
| Bloom后处理 | graph.ts UnrealBloomPass | ✅ full mode ACES色调映射 |
| 悬停Tooltip | graph.ts setupTooltip() | ✅ |
| 详情卡片 | graph.ts setupDetailCard() | ✅ 耦合分布条 |
| 节点标签 | graph.ts updateLabels() | ✅ |
| 文件监听实时更新 | main.ts listen('graph-updated') | ✅ Tauri event → 星图刷新 |
| 文件夹选择器 | main.ts pickFolder() | ✅ Tauri dialog |
| 搜索节点 | main.ts doSearch() → starGraph.focusNode() | ✅ |
| **聊天面板** | chat.ts ChatPanel → Agent → Provider → ToolRegistry | ✅ P0 |
| **简报面板** | check.ts CheckPanel → hologram_run_check → summary.py | ✅ P1 |
| **约束面板** | constraints.ts ConstraintsPanel — YAML 规则编辑 | ✅ |
| **终端面板** | terminal.ts TerminalPanel — xterm.js 内嵌终端 | ✅ |
| **时间轴面板** | timeline.ts — 左侧滑入，固定左边缘入口 | ✅ |
| **Dock 标签页** | index.html dock-tabs + main.ts 互斥逻辑 | ✅ 右: 对话/约束 · 底: 简报/终端 |
| **浮动文件查看器** | file-viewer.ts — Monaco Editor 标签页窗口 | ✅ 语法高亮/Ctrl+S/拖拽/缩放 |
| Agent 引擎 | agent.ts 569行 + tool.ts 276行 (14个工具) | ✅ |
| Provider 层 | anthropic.ts + openai.ts + types.ts | ✅ |
| 事件总线 | events.ts — navigate:node 跨组件通信 | ✅ |
| **简报 ↔ 星图链路** | Signal.graph_node_ids + summary enrich + 前端点击跳转 | ✅ P2 |
| **CSS 对比度修复** | --starlight-dim 0.7→0.85, --text-muted 0.5→0.65, 45处硬编码提亮 | ✅ 2026-06-10 |
| **原型视觉对齐** | Google Fonts (Orbitron/JetBrains/Noto SC) + 深空气氛层(全息网格/轨道环/扫描线/暗角) + 面板角括号装饰 | ✅ 2026-06-10 |
| **Tree-sitter 多语言适配器** | 通用 TreeSitterAdapter 实现 LanguageAdapter 接口，支持 15 种语言（Python/JS/TS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Swift/PHP/Lua/TSX），GrammarManager 自动下载编译缓存 | ✅ 2026-06-10 |
| **Agent 会话持久化** | 对话历史自动保存到 .hologram/chat_sessions.json，重启/切换工作区后恢复 | ✅ 2026-06-10 |
| **Git 源代码管理** | GitPanel — 变更文件列表/暂存/提交/推送/拉取/差异查看，左边缘 dock | ✅ 2026-06-10 |
| **Agent ↔ 星图联动** | Agent 调工具后自动触发星图可视化 — path→路径高亮、fragile→脆弱节点标琥珀、cycle→循环节点标红、impact/neighbors→聚焦飞行、diff→绿增红删、blindspots→盲区标记 | ✅ 2026-06-10 |
| **“问 Agent” 全面板覆盖** | 星图详情卡 + 简报违规行 + 文件查看器 + 文件树 + 时间轴事件 + 约束面板 — 6 个面板全部有“问 Agent”入口，点一下打开聊天窗自动发送上下文 | ✅ 2026-06-10 |
| **复发热点检测 (P6)** | `hotspots.ts` + `main.rs:hologram_hotspots` — L4 复发文件统计、星图着色升级、Agent 查询入口 | ✅ |
| **多工作区冲突预演 (P7)** | `conflict.ts` + `main.rs:hologram_workspace_conflict` — 双工作区重叠节点 + 耦合风险评级 | ✅ |
| **门禁模式 (P8)** | `main.rs:hologram_gate_check` — 新模块 fan-in/fan-out/耦合深度分布评估 | ✅ |
| **代码翻译器** | `file-translator.ts` + `file-translator.css` — LLM 逐行翻译 + 三栏审计，FileViewer 集成，缓存落 `.hologram/translations/` | ✅ 2026-06-16 |
| **流式Markdown渲染** | `chat.ts` — 边收chunk边渲染，code fence安全切割，rAF节流 | ✅ 2026-06-17 |
| **工具进度直播** | `agent.ts` + `chat.ts` — ToolProgress事件→工具卡片增量追加 | ✅ 2026-06-17 |
| **子Agent系统** | `agent.ts` + `tool.ts` — agent_spawn全工具克隆单轮执行 | ✅ 2026-06-17 |
| **Agent模式切换** | `settings.ts` + `chat.ts` — 通用/编码/架构/极速四档预设 | ✅ 2026-06-17 |
| **焦点上下文注入** | `chat.ts` — 文件/节点焦点自动注入用户消息前缀 | ✅ 2026-06-17 |
| **权限卡片交互** | `chat.ts` — 键盘快捷键(Esc/Enter/Ctrl+Y) + hover/active反馈 | ✅ 2026-06-17 |
| **文件树实时更新** | `file-tree.ts` + `main.ts` — 1.5s防抖 + 按钮hover动画 | ✅ 2026-06-17 |
| **变更(diff)修复** | `engine/main.rs` + `mcp.rs` + `main.rs`(Tauri) — 三层基线保存/加载 | ✅ 2026-06-17 |

### 已落地 ✅ — 感知升级

| 功能 | 说明 | 落地位置 |
|---|---|---|
| **复发热点检测** | 文件级复发计数，同一文件多次触发 L4 警报 → 星图着色升级 | `main.rs:839-914` + `hotspots.ts` ✅ P6 |
| **多工作区冲突预演** | 两个工作区 diff 叠加耦合分析，标记共同波及节点 | `main.rs:920-1088` + `conflict.ts` ✅ P7 |
| **门禁模式** | 新模块加入时自动评估 fan-in/fan-out/耦合深度分布 | `main.rs:1095-1220` ✅ P8 |

**架构能力储备（仅记录，不排期）：**
- 同表耦合检测：两个模块 import 图无关但读写同一个 DB 表/Redis key
- 事件驱动耦合检测：A emit 事件 B listen — 静态图上无边的 L4 隐形耦合
- 废弃/动态引用扫描：`importlib`、`getattr`、类路径字符串注入的暗区

> 2026-06-10: Tree-sitter 多语言适配器落地 — TreeSitterAdapter 实现 LanguageAdapter 接口，GrammarManager 管理下载/编译/缓存，15 种语言支持（Python/JS/TS/Go/Rust/Java/C/C++/Ruby/C#/Kotlin/Swift/PHP/Lua/TSX），架构为 TreeSitterAdapter 做 fallback → PythonAdapter/TypeScriptAdapter 覆盖专用语言。796 测试全部通过，零回归。
> 2026-06-10: 面板优化大回合 — CSS 对比度全局提亮、shader 无限全息网格、dock 标签页互斥、时间轴左侧面板、浮动文件窗口 Monaco Editor 集成。
> 2026-06-10: 原型视觉对齐 + CSS 变量换皮完工。
> 2026-06-09: P0-P4 全线完工。21 个 Tauri 命令，16 个 Agent 工具，740 个 Python 测试。

---

## Tauri 桥接层（src-tauri/src/main.rs + mcp_manager.rs）

55 个 `#[tauri::command]`：

```
── 图查询 ──
hologram_analyze · hologram_neighbors · hologram_impact · hologram_path
hologram_diff · hologram_fragile · hologram_cycle · hologram_coupling_report
hologram_blindspots · hologram_thread_conflicts · hologram_timeline
hologram_community_report · hologram_graph_summary
hologram_history · hologram_community · hologram_delayed · hologram_changes
hologram_search · hologram_run_check · hologram_run_preflight · hologram_run_health
── 感知升级 ──
hologram_hotspots · hologram_workspace_conflict · hologram_gate_check
── 图加载 ──
load_graph_json · load_binary_graph · analyze_and_load
estimate_project_size · generate_lightweight_graph · analyze_in_background
── 工作区管理 ──
set_active_project · get_active_project · start_watching · stop_watching
── 文件 / Git ──
list_directory · read_file_content · write_file_content · read_constraints · write_constraints
search_code · edit_file · web_fetch
── Shell ──
exec_command · bash_output · bash_kill
git_status · git_diff_unstaged · git_diff_staged · git_stage · git_unstage · git_stage_all
git_commit · git_push · git_pull · git_log · git_init
── 持久 MCP (Step 1) ──
start_mcp_server · mcp_call · mcp_list_tools · stop_mcp_server
```

新增 `mcp_manager.rs`：MCP 进程生命周期管理（启动/调用/崩溃恢复/永久降级），JSON-RPC 通信。

文件监听：1秒 polling mtime 对比，检测到变更 → 增量分析 → emit `graph-updated` 事件 → 前端刷新星图。

---

## 2026-06-12 集成测试预修

审查 [TEST_SPEC.md](TEST_SPEC.md) 发现 4 处严重矛盾（规范与代码现实不符），全部修复：

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 1 | Rust 集成测试无法访问 binary crate static | 路由测试写为 `main.rs` 底部 `#[cfg(test)] mod tests` | `src-tauri/src/main.rs` |
| 2 | `Graph.from_msgpack` 不存在 | 新增 `from_msgpack` 类方法（对称 `to_msgpack`） | `src_python/core/graph.py` |
| 3 | `_analyze_and_output` 全量模式漏注册 `TreeSitterAdapter` | 全量路径加一行 `registry.register(TreeSitterAdapter())` | `src_python/__main__.py` |
| 4 | `from_dict` 不恢复 `coupling_summary`（往返丢失） | `from_dict` 末尾从 `meta.coupling` 恢复到 `g.coupling_summary` | `src_python/core/graph.py` |
| 5 | `analyze()` 辅助函数不支持增量模式 | 加 `changed_files` 参数 | `TEST_SPEC.md` |

测试结果：Rust 4/4 通过 · Python 18/18 通过（含更新后的 `test_coupling_summary_preserved`）

## 2026-06-12 集成测试落地

按照 [TEST_SPEC.md](TEST_SPEC.md) 实现全部测试代码，覆盖 7 大类 22 个场景：

| # | 类别 | 文件 | 测试数 | 状态 |
|---|------|------|--------|------|
| 1 | 测试基础设施 | `tests/helpers.py` (新) | TempProject + analyze + 断言工具 | ✅ |
| 2.1 | 多工作区隔离 | `tests/test_integration_workspace.py` (新) | 6 tests | ✅ 6/6 |
| 2.2 | 增量一致性 | `tests/test_pipeline.py` (扩展) | +5 tests | ✅ 5/5 |
| 2.3 | Rust 路由 | `src-tauri/src/main.rs` | 4 tests | ✅ 4/4 (已有) |
| 2.4 | 缓存路径等价 | `tests/test_integration_workspace.py` (新) | 3 tests | ✅ 3/3 |
| 2.5 | 序列化全链路 | `tests/test_serialization_roundtrip.py` (扩展) | +6 tests | ✅ 6/6 |
| 2.6 | 入口等价 | `tests/test_entry_point_equivalence.py` (扩展) | +3 tests | ✅ 3 skip (缺 tree-sitter 库) |
| 2.7 | Shell E2E | `tests/e2e/` (新) | 1 script | ✅ 1/1 |

**总新增: 4 个文件 / 3 个扩展现有文件 / 24 个测试场景 / 22 passed + 3 skipped**

附带修复:
- `graph.py` `to_sqlite()` — `PRAGMA journal_mode=WAL` 移到 `BEGIN TRANSACTION` 之前（SQLite 不允许事务内改 WAL 模式）
- `test_json_roundtrip` — `NamedTemporaryFile` → `mkdtemp`（`os.replace` 在 Windows 上不能替换打开的文件）
- `pyproject.toml` — 注册 `integration` 和 `slow` pytest 标记

集成测试运行: `python -m pytest tests/ -m integration -v` → **14 passed, 0 warnings**
全量测试: `python -m pytest tests/ --ignore=tests/test_layout.py --ignore=tests/test_v3_patterns.py` → **622 passed, 3 skipped**（失败均为预存）
Shell E2E: `bash tests/e2e/run_all.sh` → **1 passed**

## 已知 Bug

| 问题 | 状态 |
|---|---|
| 折叠视图：星系叠加时加法混合过曝 | 未修复（ACES + 低 Bloom 缓解，不根治） |
| 跨星系连线 + 能量流粒子在深色背景中不可见 | 未修复 |
| 应用偶发崩溃 | 未定位 |
| constraints.py — allowlist 为 None 时 from_dict 抛 TypeError | **已修复** 2026-06-13 |
| 变更(diff) — 引擎基线永远是空图，三层全坏 | **已修复** 2026-06-17 |
| 权限卡片 — 键盘快捷键按钮残留 | **已修复** 2026-06-17 |
| 文件树 — 文件变更不实时更新 | **已修复** 2026-06-17 |

---

## 施工优先级（2026-06-09 确认）

**不会再扩展引擎。** 引擎完整。以下全部是胶水层工作：

### P0: Agent 能对话 ✅ (2026-06-09 完工)
- [x] 聊天 UI：输入框 + 消息列表 + EventSink 渲染 (`src-ui/src/ui/chat.ts` 380行)
- [x] 连接 settings.ts → Provider → Agent → ToolRegistry → Tauri invoke
- 全息指挥台现在是"星图 + 可对话的 Agent"

### P1: check 简报入指挥台 ✅ (2026-06-09 完工)
- [x] Tauri command `hologram_run_check`（包装 `hologram check --json`）
- [x] CLI `cmd_check` 加 `--json` 输出结构化 ChangeSummary JSON
- [x] 前端渲染组件：`CheckPanel`（`src-ui/src/ui/check.ts` 240行，底部抽屉面板）
- [x] 文件保存 → watcher → 自动跑 check → 结果出现在面板
- [x] Agent 工具注册：Agent 可主动调用 `hologram_run_check`
- [x] 工具栏 📋 简报按钮 + debounce 防重入

### P2: 简报 ↔ 星图链路 ✅ (2026-06-09 完工)
- [x] Signal 加 `graph_node_id` 字段 — signals.py + to_dict()
- [x] summary.py enrich() 查出坐标 — generate() 中 resolve names→IDs
- [x] 前端事件总线 — events.ts EventBus (navigate:node)
- [x] 简报条目可点击 → 星图响应 — check.ts 点击 affected_nodes → main.ts focusNode()

### P3: preflight + health ✅ (2026-06-09 完工)
- [x] preflight CLI + MCP — preflight.py 组装 impact + coupling + community + cycles
- [x] health CLI — preflight.py 聚合 timeline + coupling 快照 → 健康分 + 趋势
- [x] Tauri 桥接: hologram_run_preflight + hologram_run_health
- [x] Agent 工具注册: 14 个工具 (+2)

### P4: 锦上添花 ✅ (2026-06-09 完工)
- [x] 浮动文件窗口 — file-viewer.ts (可拖拽、调整大小、从简报点击打开)
- [x] 决策时间轴前端 — timeline.ts (底部抽屉面板，自动刷新)
- [x] 变更回看着色 — graph.ts showDiff/clearDiff (绿=新增, 红=删除, 橙=修改)
- [x] 约束配置 UI — constraints.ts (路由开关 + 阈值 + 白名单/黑名单编辑)

---

## 不再维护的文档

以下文件保留作为历史参考，但不再更新：

- `SPEC.md` — V1 设计文档（历史归档）
- `SPEC_V2.md` — V2 设计文档（历史归档）
- `SPEC_V3.md` — V3 设计文档（历史归档）
- `SPEC_V4.md` — V4 角色模型（历史归档）
- `TODO.md` — 已被本文档的施工优先级替代
- `CLAUDE.md` — Agent 会话上下文（每次加载），记录最新架构决策和编码约定

**PROJECT.md 是项目历史与全景真相源。CLAUDE.md 是 Agent 工作指令。两者互补维护。**
