# HoloGram 数据流架构全景

> 生成日期：2026-06-18
> 涵盖：全系统 21 条数据流、6 种存储、2 套传输协议、2 个图结构
> 状态：CACHED_GRAPH 退役 & watcher 合并正在进行中（另一个窗口）

---

## 一、系统三层结构

```
┌──────────────────────────────────────────────┐
│  前端 (src-ui/)                               │
│  TypeScript · Three.js 3D 星图 · ChatPanel   │
│  invoke() → Tauri 命令                        │
└──────────────┬───────────────────────────────┘
               │ Tauri IPC
┌──────────────▼───────────────────────────────┐
│  Tauri 后端 (src-tauri/src/)                  │
│  Rust · 桥接层 · EngineClient (TCP :9777)     │
│  McpManager (子进程管理)                       │
└──────┬───────────────────┬───────────────────┘
       │ TCP :9777          │ spawn 子进程
       │ (自定义协议)        │ (MCP stdio)
┌──────▼──────────┐ ┌──────▼──────────────────┐
│ 引擎 TCP Server  │ │ 引擎 MCP Server          │
│ (main.rs)        │ │ (McpServer::run_stdio)   │
│ 4字节长度+JSON   │ │ JSON-RPC 2.0 每行一条     │
└──────┬──────────┘ └──────┬──────────────────┘
       │                   │
       └───────┬───────────┘
               │ 共享内存
    ┌──────────▼──────────┐
    │ GRAPH_STORE (主)     │ ← MemoryIndex + SQLite
    │ CACHED_GRAPH (遗留)  │ ← HashMap Graph (退役中)
    └─────────────────────┘
```

**两套协议是故意设计：**
- **TCP :9777** → Tauri 桌面端内部通信
- **MCP stdio** → 纯 CLI 用户，不需要装桌面端就能用 `engine.exe serve`

---

## 二、存储清单（6 种）

| # | 存储 | 路径 | 格式 | 读写 | 生命周期 |
|---|------|------|------|------|----------|
| 1 | `hologram.db` | `<项目>/.hologram/` | SQLite (WAL) | 引擎写、MCP 查 | 持久 |
| 2 | `hologram_graph.json` | `<项目>/` | JSON | Tauri 写、前端读 | 每次分析覆盖 |
| 3 | `hologram_graph_files.json` | `<项目>/` | JSON | `regenerate_file_graph` 写 | 每次分析覆盖 |
| 4 | `hologram_before.json` | `<项目>/` | JSON | `hologram_diff` 写 | 首次 diff 创建 |
| 5 | `baseline.json` | `<项目>/.hologram/` | JSON | `hologram_run_check` 写 | 检查通过后更新 |
| 6 | `.last_project` | `<HoloGramHG 根>/` | 纯文本 | Tauri 写、冷启动读 | 每次打开项目覆盖 |

### `hologram.db` 内部结构

```
表:
  nodes (id, name, kind, location, properties, in_degree, out_degree, ...)
  edges (id, source, target, kind, coupling_depth, cross_file, ...)
  timeline_events (id, timestamp, event_type, file, summary, properties)
  meta (key, value)

虚拟表:
  fts_nodes (FTS5 全文索引, 自动同步 nodes 表)

触发器:
  nodes_ai / nodes_ad / nodes_au → 自动维护 FTS5 索引
```

### `hologram_graph.json` 结构

```json
{
  "meta": { "source_root": "...", "node_count": N, "edge_count": M },
  "nodes": [{ "id": "路径::符号名", "name": "...", "kind": "symbol", "location": "文件:行号", ... }],
  "edges": [{ "id": "...", "source": "...", "target": "...", "kind": "calls", "coupling_depth": 2, ... }],
  "communities": [["node_id_1", "node_id_2", ...], ...]
}
```

---

## 三、图结构对比（退役前）

| | GRAPH_STORE (主力) | CACHED_GRAPH (退役中) |
|---|---|---|
| **类型** | `RwLock<Option<Mutex<GraphStore>>>` | `Mutex<Option<Graph>>` |
| **内部存储** | `MemoryIndex` (邻接表) + `SqliteDb` | `Graph` (HashMap) |
| **并发** | `parking_lot::RwLock` N 路读 | `Mutex` 串行 |
| **查询性能** | O(degree) 邻接表 | O(E) 全表扫 |
| **持久化** | `hologram.db` (SQLite) | `hologram_graph.json` (JSON dump) |
| **全文搜索** | FTS5 (SQLite) | 线性 O(N) 扫描 |
| **谁写** | MCP analyze、watcher | `direct_analyze` (Tauri) |
| **谁读** | MCP 工具（优先路径） | Tauri 命令、MCP 回退路径 |
| **项目隔离** | ✅ 刚修：按 project_root 切换 | ❌ 无隔离，全局单例 |

### MemoryIndex 内部四张表

```
nodes:     HashMap<节点ID, Node>
out_adj:   HashMap<源节点, Vec<(目标, 边类型, 耦合深度, 延迟)>>
in_adj:    HashMap<目标节点, Vec<(源, 边类型, 耦合深度, 延迟)>>
name_index: HashMap<符号名, Vec<节点ID>>
file_index: HashMap<文件路径, Vec<节点ID>>
```

---

## 四、两条核心协议路径

### 路径 A：桌面端（Tauri → TCP :9777）

```
前端 invoke('analyze_and_load')
  → Tauri analyze_and_load → direct_analyze
    → analyze_project (引擎 pipeline)
    → 后处理 (cross-file, coupling, routes, dynamic, dataflow, communities)
    → 序列化写入 hologram_graph.json + hologram_graph_files.json
    → 写入 CACHED_GRAPH (退役后将移除)
    → 返回 JSON 给前端 → 星图渲染
```

### 路径 B：CLI 用户 / MCP 客户端（stdio JSON-RPC）

```
外部进程 spawn: engine.exe serve --project-root <path>
  → McpServer::run_stdio
    → 监听 stdin JSON-RPC 请求
    → 写入 stdout JSON-RPC 响应
  → 用户调用 hologram_analyze
    → analyze_project
    → 写入 GRAPH_STORE (MemoryIndex + hologram.db)
    → 更新 CACHED_GRAPH (退役后将移除)
```

**两者共享：** GRAPH_STORE、CACHED_GRAPH、ANALYZE_LOCK

---

## 五、21 条数据流详解

### 数据流 1：用户打开文件夹（全量分析）

```
触发：前端点击"打开文件夹"
路径：main.ts → switchWorkspace(path)
     → invoke('analyze_and_load', { path })

Tauri analyze_and_load:
  1. ACTIVE_PROJECT = path
  2. 写 .last_project
  3. emit("analyze-phase")
  4. direct_analyze(&path)
     ├─ analyze_project (tree-sitter 解析所有源文件)
     ├─ CrossFileResolver (跨文件 import 边)
     ├─ compute_coupling (L1-L4 耦合深度)
     ├─ detect_framework_routes (Django/Express/...)
     ├─ synthesize_dynamic_edges (callback/observer)
     ├─ synthesize_dataflow_edges (Reads/Writes/Shares)
     ├─ detect_communities (社区发现)
     ├─ 写 hologram_graph.json
     └─ CACHED_GRAPH = Some(graph)
  5. regenerate_file_graph → 写 hologram_graph_files.json
  6. serialize_cached_graph → 返回 JSON 给前端

前端接收：ws.graphData = JSON → starGraph.render()
```

### 数据流 2：冷启动（恢复上次项目）

```
触发：App 启动，main.ts init()

前端 → invoke('load_graph_json')

Tauri load_graph_json 优先级:
  1. 显式参数 path
  2. ACTIVE_PROJECT/hologram_graph.json
  3. .last_project → <path>/hologram_graph.json (恢复 ACTIVE_PROJECT)
  4. <HoloGramHG 根>/hologram_graph.json (全局回退)

成功：switchWorkspace(root, { skipAnalysis: true, cachedGraph })
      → 后台踢 hologram_analyze 预热 CACHED_GRAPH

失败：显示欢迎页
```

### 数据流 3：后台分析

```
触发：冷启动后自动，或前端调用 analyze_in_background

Tauri analyze_in_background(path):
  → spawn 线程 → direct_analyze(path)
  → 完成 → emit("analysis-complete") 或 emit("analysis-failed")

前端监听：
  'analysis-complete' → invoke('get_full_graph')
    → serialize_cached_graph → ws.graphData 更新
    → ws.doGraphUpdate(starGraph)
```

### 数据流 4：MCP Server 启动

```
触发：前端或外部调用 start_mcp_server  /  手动 engine.exe serve

Tauri McpManager::start(project_root, engine_path):
  1. kill 旧子进程
  2. Command: engine.exe serve --project-root <path>
     stdin=piped, stdout=piped, stderr=inherit
  3. 等待 ready 信号: {"jsonrpc":"2.0","method":"ready"}
     超时: 600 秒
  4. 发送 tools/list → 返回工具列表

引擎端 engine.exe serve:
  1. parse_serve_args() → project_root
  2. init_graph_store(&root)
     ├─ GraphStore::open → SqliteDb::open (创建/打开 hologram.db)
     ├─ 尝试 MemoryIndex::from_sqlite (快速路径)
     └─ 失败则 JSON 迁移 (hologram_graph.json → SQLite)
  3. println!(ready signal)
  4. McpServer::run_stdio()
     → 循环: 读 stdin 一行 → handle_request → 写 stdout 一行

崩溃安全: 60秒内3次崩溃 → degraded = true → 永久回退到 CLI
```

### 数据流 5：引擎 TCP Server (:9777)

```
触发：engine.exe 不带 serve 参数  /  Tauri 自动 start_engine()

TcpListener::bind("127.0.0.1:9777")
  → Accept 循环，每个连接 spawn 线程

协议格式：
  请求: 4字节 LE 长度前缀 + JSON payload
  响应: 4字节 LE 长度前缀 + JSON payload

命令:
  "analyze:<path>"          → 全量分析
  "check:<path>\n[files]"   → 约束检查
  "neighbors:<node_id>"     → 邻居查询
  "search:<query>:<limit>"  → FTS5 搜索
  "fragile:<limit>"         → 脆弱模块
  "diff:<baseline_path>"    → 图差异
  "timeline"                → 时间轴事件
  "get_graph"               → 序列化当前图
  "ping"                    → {"ok":true}

EngineClient (Tauri 侧):
  → 持久 Mutex<Option<TcpStream>>
  → 断线自动重连
```

### 数据流 6：MCP hologram_analyze（通过 MCP 重分析）

```
触发：MCP 客户端调用 hologram_analyze { path }

McpServer::tool_analyze:
  1. ANALYZE_LOCK.try_lock() (非阻塞，分析中拒绝)
  2. init_graph_store(&root)
     └─ 项目切换检测 → 重开 hologram.db (2026-06-18 修)
  3. analyze_project(&root)
  4. 全部后处理 (CrossFile, coupling, routes, dynamic, dataflow, communities)
  5. MemoryIndex::from_existing_graph(&graph)
  6. store.swap_index(idx)    → 更新 GRAPH_STORE
  7. store.save()             → 写 hologram.db (全量)
  8. CACHED_GRAPH = Some(graph)
  9. watcher::stop → watcher::start(root)
  10. set_project_root(&root)
  11. 返回 { status, total_nodes, total_edges, communities, elapsed_secs }
```

### 数据流 7：MCP hologram_search（全文搜索）

```
触发：MCP 客户端调用 hologram_search { query, limit }

McpServer::tool_search:
  优先路径 (GRAPH_STORE 可用):
    → store.read(|idx| idx.fts_search(&store.db, query, limit))
    → SQLite FTS5: SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ?
    → 对每个结果 idx.nodes.get(id) → 返回 Node
    → 返回 { results, count, engine: "fts5" }

  回退路径 (无 GRAPH_STORE):
    → query::search_nodes(g, query)  // O(N) 全表扫
    → 返回 { results, count, engine: "linear" }
```

### 数据流 8：MCP hologram_explore（聚合查询）

```
触发：MCP 客户端调用 hologram_explore { symbols, query, includeSource }

McpServer::tool_explore:
  优先路径:
    → 从 MemoryIndex 重建临时 Graph
    → explore(&g, &project_root, &symbols, query, include_source)
    → 返回:
        flow: { path }              ← 符号间最短路径
        relationships: { calls, imports, inherits }
        blastRadius: { dependents, dependencies }
        sourceCode: [sections]      ← includeSource=true 时读磁盘
        architectureAlerts: {}
        nodeIds: [...]              ← 前端 3D 联动
        meta: { totalSymbolsFound }
```

### 数据流 9：时间轴事件

```
写入源:
  - direct_analyze → record_timeline("analyze", ...)
  - hologram_run_check → record_timeline("commit_clean"/"commit_violation", ...)
  - start_watching (Tauri) → record_timeline("file_changed", ...)
  - edit_file → record_timeline("agent_edit", ...)

SQLite 表: timeline_events
  (id, timestamp, event_type, file, summary, properties JSON)
  自动裁剪: 保留最新 10000 条

读取:
  前端 TimelinePanel → invoke('hologram_timeline', { limit, since })
    → store.db.query_timeline(limit)
  MCP hologram_timeline → 同上
  MCP hologram_changes → store.db.query_timeline(100)
  TCP "timeline" → 同上
```

### 数据流 10：MCP hologram_run_check（约束验证）

```
触发：MCP 客户端调用 hologram_run_check { path }

McpServer::tool_run_check:
  1. 保存当前 CACHED_GRAPH 作为 "before"
  2. ANALYZE_LOCK.try_lock()
  3. 全量重分析 (完整 pipeline)
  4. 更新 GRAPH_STORE + CACHED_GRAPH
  5. run_full_check(before, after, &[], path)
     → 检测: L2/L3/L4/L5 违规, 新循环, 线程冲突, API 签名变更
  6. record_timeline (check 结果 + 全部属性)
  7. 返回 { passed, violation_count, ... }

Tauri 变体:
  → 从 .hologram/baseline.json 读基线
  → 合并 LAST_CHANGED_FILES (watcher/edit_file 填充)
  → 通过则写回 baseline.json
```

### 数据流 11：MCP hologram_preflight（变动预演）

```
触发：MCP 客户端调用 hologram_preflight { files }

McpServer::tool_preflight:
  → 对每个文件，找 location 包含此路径的节点
  → 对每个受影响节点，BFS impact (深度 3)
  → 返回:
      file_reports: [{ file, direct_nodes, blast_radius, risk }]
      risk_level: high / medium / low

只读，不写任何存储。
```

### 数据流 12：引擎端 Watcher 增量更新

```
触发：notify 文件系统事件 (引擎 serve 模式)

start_watcher(project_root):
  → notify::recommended_watcher (递归)
  → channel 防抖: 2000ms 窗口
  → 触发: do_update(root, changed_files)

do_update:
  1. ANALYZE_LOCK.try_lock() (分析中跳过)
  2. 如果有 GRAPH_STORE:
     ├─ IncrementalUpdater::update (三阶段)
     │   Phase 1: 单文件 tree-sitter 重解析
     │   Phase 2: 文件内 diff (按 name+kind 匹配)
     │   Phase 3: 跨文件边修复 (通过 name_index 重导 import)
     ├─ store.swap_index(new_idx)  → 内存替换
     └─ sync_cached_graph_from_store (退役前)
  3. 增量失败 → full_reanalyze(root)
     └─ 完整 pipeline + store.swap_index + store.save()

注意：增量路径不立即写 SQLite，只写 MemoryIndex。
      全量回退路径写 SQLite。
```

### 数据流 13：Tauri 端 Watcher 轮询（遗留）

```
触发：前端调用 start_watching(path) Tauri 命令

main.rs start_watching:
  → spawn 线程
  → 每 1 秒: collect_file_mtimes(root)
  → 比较上次 mtime → 检测新增/修改/删除
  → 检测到变更:
      run_engine_analysis(path, &changed_files)
      → direct_analyze(path)  ← 每次全量重分析！
      → 更新 LAST_CHANGED_FILES
      → record_timeline("file_changed", ...)
      → emit("graph-updated", json)

前端监听 'graph-updated' → invoke('get_full_graph')

注意：此 watcher 与引擎端 watcher.rs 不会同时运行。
      退役计划：合并到引擎端 watcher (另一个窗口进行中)。
```

### 数据流 14：图查询工具

```
这是 14 个 MCP 工具的通用模式：

查询类:
  hologram_neighbors    → BFS 邻居 (深度 1)
  hologram_impact       → BFS 波及范围 (可配深度)
  hologram_path         → 两节点间最短路径
  hologram_history      → 节点决策历史 + 依赖/被依赖计数
  hologram_community    → 节点所属社区

分析类:
  hologram_fragile      → 脆弱度排名 (L4 封装违规密度)
  hologram_cycle        → 循环依赖检测
  hologram_thread_conflicts → 线程×资源冲突矩阵
  hologram_coupling_report  → L1-L4 耦合分布
  hologram_blindspots   → 架构盲区 (L4+线程+循环)

摘要类:
  hologram_graph_summary    → { edge_types, nodes_total, edges_total }
  hologram_community_report → 社区/集群结构

路径优先级:
  1. GRAPH_STORE → store.read(|idx| ...) → MemoryIndex
  2. CACHED_GRAPH (回退) → CACHED_GRAPH.lock() → HashMap Graph

全部只读，不写任何存储。
```

### 数据流 15：图差异

```
触发：前端 Diff 按钮 / MCP hologram_diff { before_path }

McpServer::tool_diff:
  1. Graph::from_json_file(before_path)  // 读取基线
  2. 如果基线不存在:
     → 保存当前图为基线 (hologram_before.json)
     → 返回 { is_empty: true, message: "基线已创建" }
  3. before.diff(&after)
     → 比较节点增删改 + 边增删
     → 返回 { added_nodes, removed_nodes, modified_nodes, ... }

前端: starGraph.showDiff(diff)
```

### 数据流 16：Agent 代码工具

```
search_code:  walkdir → grep 每行 → 返回 { results: [{file, line, content}] }
edit_file:    读文件 → 匹配 old_string (容错空白) → 原子写(temp+rename)
              → record_timeline("agent_edit") → 更新 LAST_CHANGED_FILES
glob:          walkdir + glob::Pattern → 返回 { results: [{path, name}] }
web_fetch:     ureq HTTP GET → SSRF 防护 → 1 MiB 上限 → 返回纯文本
```

### 数据流 17：GraphStore 打开路径

```
GraphStore::open(project_root):
  ├─ SqliteDb::open(project_root)
  │   ├─ mkdir .hologram/
  │   ├─ Connection::open(.hologram/hologram.db) [WAL 模式]
  │   └─ ensure_schema() → 表不存在则创建
  │
  ├─ 快速路径: MemoryIndex::from_sqlite(&db)
  │   ├─ load_all_nodes() → O(N)
  │   ├─ load_all_edges() → O(E)
  │   └─ 构建邻接表 + name_index + file_index
  │
  ├─ 回退 1: JSON 迁移
  │   ├─ 读 .hologram/hologram_graph.json
  │   ├─ Graph::from_json_file → MemoryIndex::from_existing_graph
  │   └─ idx.to_sqlite(&db) [非致命，失败继续]
  │
  └─ 回退 2: 空 store (用户必须运行 hologram_analyze)
```

### 数据流 18：分析管线（核心引擎）

```
analyze_project(root) → PipelineResult:

  Step 1: discover_files(root)
    → walkdir 过滤源文件扩展名
    → 跳过 .git, node_modules, .hologram, target, ...
    → 返回 Vec<PathBuf>

  Step 2: ParallelParser::parse_files(&files)
    → rayon 并行
    → tree-sitter 解析每个文件
    → 返回 Vec<FileData { nodes, edges }>

  Step 3: GraphMerger::merge()
    → 按 name+kind+file 去重节点
    → 累加边
    → 返回合并后的 Graph

后处理 (6 步，始终在 analyze_project 之后执行):
  A. CrossFileResolver::resolve()      → 跨文件 import 边
  B. compute_coupling()                → L1-L4 耦合深度
  C. detect_framework_routes()         → Django/Express/... 路由
  D. synthesize_dynamic_edges()        → callback/observer 边
  E. synthesize_dataflow_edges()       → Reads/Writes/Shares/Triggers/Awaits
  F. detect_communities(graph, 42)     → Louvain 社区发现
```

### 数据流 19：Unity 事件服务 (:9776)

```
触发：Tauri setup

TcpListener::bind("127.0.0.1:9776")
  → Accept 循环
  → 读行: "event:payload"
  → emit("unity-event", { event, payload })

前端监听:
  "node_double_clicked" → 导航到文件
  "path_selected" → ChatPanel 提问

独立端口，与 :9777 引擎 TCP 无关。
```

### 数据流 20：轻量图生成

```
触发：前端 generate_lightweight_graph(path)

→ direct_analyze(&path)  // 直接调用引擎 pipeline
  → 写 hologram_graph.json (带 meta)
  → regenerate_file_graph(path) → 写 hologram_graph_files.json
  → 返回 { ok, file_count, edge_count }
```

### 数据流 21：文件图重建

```
触发：direct_analyze / analyze_and_load 结束后

regenerate_file_graph(project_path):
  1. 读 hologram_graph.json
  2. 解析 JSON
  3. 按文件分组节点: 从 node.location 提取文件路径
  4. 统计文件对之间的边权重
  5. 构建文件级图:
     - nodes: [{ id: 文件路径, name: 文件名, symbol_count: N }]
     - edges: [{ source: 文件A, target: 文件B, weight: 连接数 }]
  6. 写 hologram_graph_files.json
```

---

## 六、已知架构问题

| 问题 | 状态 | 说明 |
|------|------|------|
| GRAPH_STORE 项目隔离 | ✅ 已修复 | `init_graph_store` 现在检测项目切换，重开 SQLite |
| CACHED_GRAPH 冗余 | 🔧 退役中 | 另一个窗口进行中，完成后只剩 GRAPH_STORE |
| 双 Watcher 并存 | 🔧 合并中 | Tauri 端轮询 watcher 合并到引擎端增量 watcher |
| FTS5 索引不同步 | ⚠️ 待查 | `hologram_search` 返回 0 但节点在图中 |
| 两套协议写后不一致 | ⚠️ 注意 | TCP analyze 不写 GRAPH_STORE 的 SQLite，MCP analyze 写 |
| 无工作区层 | ⚠️ 待做 | 前端"打开文件夹"没有工作区抽象，引擎按单项目设计 |

---

## 七、关键常量

| 常量 | 值 | 位置 |
|------|-----|------|
| TCP 引擎端口 | 9777 | `engine/src/main.rs` |
| Unity 事件端口 | 9776 | `src-tauri/src/main.rs` |
| MCP 启动超时 | 600 秒 | `src-tauri/src/mcp_manager.rs` |
| Watcher 防抖 | 2000ms | `engine/src/watcher.rs` |
| 大项目阈值 | >500 源文件 | `src-tauri/src/main.rs` |
| 崩溃降级阈值 | 60秒内3次 | `src-tauri/src/mcp_manager.rs` |
| 时间轴裁剪 | 10000 条 | `engine/src/storage/sqlite.rs` |
| FTS5 搜索限制 | 默认 20，可配 | `engine/src/mcp.rs` |

---

## 八、数据流速查表

| # | 触发 | 写什么 | 读什么 |
|---|------|--------|--------|
| 1 | 打开文件夹 | hologram_graph.json, files.json, .hologram.db timeline, .last_project | 源文件 (tree-sitter) |
| 2 | 冷启动 | 无 | hologram_graph.json, .last_project |
| 3 | 后台分析 | 同 #1 | 同 #1 |
| 4 | MCP 启动 | .hologram.db schema | .hologram.db (或 JSON 迁移) |
| 5 | TCP 连接 :9777 | .hologram.db timeline | CACHED_GRAPH / GRAPH_STORE |
| 6 | MCP analyze | .hologram.db 全量 | 源文件 |
| 7 | MCP search | 无 | .hologram.db FTS5, MemoryIndex |
| 8 | MCP explore | 无 | MemoryIndex, 源文件 |
| 9 | 时间轴查询 | 无 | .hologram.db timeline_events |
| 10 | 约束检查 | .hologram.db timeline, baseline.json | baseline.json, CACHED_GRAPH |
| 11 | 变动预演 | 无 | MemoryIndex |
| 12 | 引擎 watcher | MemoryIndex (增量), .hologram.db (回退) | 源文件 (重解析) |
| 13 | Tauri watcher | hologram_graph.json, .hologram.db timeline | 文件 mtime |
| 14 | 图查询工具 | 无 | CACHED_GRAPH / MemoryIndex |
| 15 | 图 diff | hologram_before.json (首次) | hologram_before.json |
| 16 | Agent 工具 | 源文件 (edit), .hologram.db timeline | 源文件, 目录 |
| 17 | GraphStore open | .hologram.db schema | .hologram.db 或 JSON |
| 18 | 分析 pipeline | 无 (内存 Graph) | 源文件 |
| 19 | Unity 事件 | 无 | TCP listen |
| 20 | 轻量图 | 同 #1 | 同 #1 |
| 21 | 文件图重建 | hologram_graph_files.json | hologram_graph.json |
