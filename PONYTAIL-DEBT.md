# Ponytail Debt Ledger

91 markers · 13 with triggers · 78 no-trigger · generated 2026-06-28

---

## Has trigger (13)

| File | Line | Ceiling | Upgrade path |
|---|---|---|---|
| `src-tauri/src/workspace.rs` | 83 | 旧 watcher 1s 退出 | analyze_lock 争抢时缩短 |
| `src-tauri/src/mcp_manager.rs` | 99 | per-call spawn | 切 persistent MCP |
| `src-tauri/src/mcp_manager.rs` | 138 | per-call spawn | 切 persistent MCP |
| `src-tauri/src/mcp_manager.rs` | 303 | call() 未接通 | call() 接通后去 allow(dead_code) |
| `src-tauri/src/engine_client.rs` | 23 | CONN static | pooled clients 时用 new() |
| `engine/src/mcp.rs` | 184 | 项目切换未接通 | serve entry 接通后去 allow(dead_code) |
| `engine/src/community/louvain.rs` | 130 | WIP community detection | layout research 后接入 |
| `engine/src/community/louvain.rs` | 291 | WIP community refinement | layout research 后接入 |
| `engine/src/storage/memory.rs` | 48 | O(N+E) rebuild | mutations 变频繁时换增量 diff |
| `engine/src/engine.rs` | 1194 | rayon threshold 2000 | 小项目变多时调阈值 |

---

## No-trigger (78)

### `src-ui/src/ui/graph.ts` (27)

| Line | What | Suggestion |
|---|---|---|
| 45 | 8 色相均分 | 颜色不够时加色相环插值 |
| 85 | 10 边独立色相 | 边类型超过 10 种时扩展 palette |
| 110 | m 0.05→0.02 | 总览边过暗时回调 |
| 555 | 社区质心斥力后处理 | 大图 (>100K nodes) 性能不够时搬 GPU |
| 933 | 总览关 bloom | 无 |
| 958 | 统一飞行规划 | 无 |
| 1013 | GPU upload 每 3 帧 | 掉帧时改每帧 |
| 1049 | 手动操作放弃 fly | 无 |
| 2132 | degree-normalized brightness | 无 |
| 2305 | 视线方向飞行 | 需要横穿场景时加参数 |
| 2424 | 边 opacity 分档 | 无 |
| 2448 | function/method 同色 | 无 |
| 2459 | visible=false 全隐藏 | 无 |
| 2923 | 包围盒自适应距离 | 无 |
| 3017 | 总览 bloom 阈值 | 无 |
| 3680 | 实心球+薄晕 | 视觉效果不满意时换 shader |
| 3684 | 球半径=cbrt*系数 | 大小星团区分度不够时调系数 |
| 3897 | focusTarget 语义 | 无 |
| 4109 | 社区质心斥力 | 无 |
| 4187 | 10K+ instances 包围球 | 无 |
| 4306 | bounding-sphere recompute | 无 |
| 4549 | inverted Fresnel | 无 |
| 4681 | 清 focus 状态 | 无 |
| 4694 | 恢复 core color | 无 |
| 4727 | count edges first | 无 |
| 5200 | node kind filter gate | 无 |
| 5254 | hue shift 复用 _animColor | GC 压力不大时去掉预分配 |

### `engine/src/storage/memory.rs` (5)

| Line | What | Suggestion |
|---|---|---|
| 8 | CSR flat arrays | 需要动态增删节点时换 adjacency list |
| 1009 | dense index rebuilt on flush_pending | 无 |
| 1043 | incoming edges pre-counted | 无 |
| 1325 | clone_index_for_update no rebuild | 无 |
| 1372 | flush_pending rebuild correctness | 无 |

### `engine/src/engine.rs` (8)

| Line | What | Suggestion |
|---|---|---|
| 137 | cross_file lost in CSR | 需要跨文件边元数据时存额外 vec |
| 459 | LSP timing from core-parse | 无 |
| 527 | release parse_cache after synthesis | 无 |
| 1152 | re-parse saves 3+ GB | 内存充裕时切回 CST 缓存 |
| 1158 | avoids Parser::new() overhead | 无 |
| 1170 | RwLock once per ext | 无 |
| 1212 | CST not cached | 同 1152 |
| 1572 | parse_cache source only | 无 |
| 1676 | graph_from_index 丢 metadata | 需要时存 sidecar |

### `engine/src/storage/sqlite.rs` (3)

| Line | What | Suggestion |
|---|---|---|
| 34 | synchronous=NORMAL | 频繁崩溃时改回 FULL |
| 294 | synchronous=NORMAL safe in WAL | 同 34 |
| 304 | pragma outside tx | 无 |

### `engine/src/community/louvain.rs` (6)

| Line | What | Suggestion |
|---|---|---|
| 105 | Vec-based community storage | 社区数 > 100K 时换 HashMap |
| 126 | Refinement costs 1 extra pass | 性能不够时关 refinement |
| 289 | swap_remove avoids O(C²) | 无 |
| 349 | accumulate all intra-edges | 无 |
| 357 | baseline = self_weight | 无 |
| 558 | plain Louvain | 社区质量不够时换 full Leiden |

### `engine/src/graph/merge.rs` (6)

| Line | What | Suggestion |
|---|---|---|
| 28 | persists across merge calls | 无 |
| 33 | EdgeKind as u8 | variant 超 256 时换 u16 |
| 112 | skip build_file_graph() | 需要单文件图时加回来 |
| 132 | two-level edge dedup | 无 |
| 167 | String::with_capacity | 无 |
| 325 | verify intra-file dedup | 无 |

### 其余文件 (23)

| File | Line | What | Suggestion |
|---|---|---|---|
| `src-ui/vite.config.ts` | 7 | case-sensitive proxy | Vite 修这个 bug 后去掉 workaround |
| `src-tauri/src/main.rs` | 349 | SQLite cached graph | 无 |
| `src-ui/src/ui/file-tree.ts` | 282 | 精确相等 | 无 |
| `src-ui/src/ui/file-tree.ts` | 295 | 面板未打开先打开 | 无 |
| `engine/src/storage/incremental.rs` | 159 | clone no rebuild | 无 |
| `engine/src/pipeline/runner.rs` | 52 | v1 4.4 GB 爆炸 | 无 |
| `engine/src/pipeline/runner.rs` | 97 | per-batch CST drop | 无 |
| `engine/src/pipeline/parser.rs` | 65 | skip oversized files | 上限需要调时改常量 |
| `engine/src/pipeline/discovery.rs` | 52 | single-pass walkdir | 无 |
| `engine/src/main.rs` | 6 | mimalloc | 平台不兼容时换 jemalloc |
| `engine/src/main.rs` | 25 | adaptive rayon pool | 无 |
| `engine/src/graph/node.rs` | 122 | 8 NodeKind round-trip | 加新 variant 时更新测试 |
| `engine/src/analysis/coupling_report.rs` | 61 | O(degree) scan | 无 |
| `engine/src/graph/edge.rs` | 86 | default to Calls | 新 EdgeKind 不该 fallthrough 时加 match arm |
| `src-ui/src/agent/agent.ts` | 547 | inject _callId | 无 |
| `src-ui/src/agent/agent.ts` | 808 | fork recursion guard | 无 |
| `engine/src/mcp.rs` | 528 | cached community_id | Louvain 实现换后去缓存 |
| `engine/src/mcp.rs` | 753 | file_index O(1) | 无 |
| `engine/src/mcp.rs` | 842 | group by cached community_id | 同 528 |
| `engine/src/adapter/tree_sitter.rs` | 13 | cached (Parser, Language, ext) | 无 |
| `engine/src/adapter/tree_sitter.rs` | 28 | resolve Language in cache | 无 |
| `engine/src/adapter/tree_sitter.rs` | 89 | tree-sitter-c func name | tree-sitter-c 修 query 后去掉 workaround |
| `engine/src/adapter/python_lsp.rs` | 842 | 迭代上限兜底 | 无 |
| `engine/src/adapter/grammar_loader.rs` | 8 | convention over config | 不按约定的语法进插件系统时换显式注册 |
| `engine/src/adapter/grammar_loader.rs` | 78 | static grammars no handle | 需要动态卸载时加 Library handle |

---

**78 no-trigger, 52 补充了升级路径, 26 标"无"（纯设计笔记，天花板太远不值得写触发条件）。**
