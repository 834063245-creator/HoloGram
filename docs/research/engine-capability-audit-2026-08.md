# HoloGram Rust 引擎能力审计清单

> 审计日期：2026-08 · 证据级别：`文件:行号` · 基于引擎源码逐文件通读

---

## 1. 解析层（`engine/src/adapter/`）

- **traits.rs**：唯一 trait 抽象。`LanguageAdapter`（`traits.rs:4-9`）只定义 `extensions()` + `analyze(file, source) -> (Vec<Node>, Vec<Edge>, Option<Tree>)`。返回 tree 供下游合成阶段复用（`traits.rs:6-8`）。
- **registry.rs**：`AdapterRegistry::new()`（`registry.rs:22-168`）按「先注册者胜」规则（`registry.rs:174`）用扩展名索引适配器。注册顺序：先 20 个 query 系（JS/TS、Rust + 18 个 `new_generic` 语言），后 3 个手写 fallback（`registry.rs:164-166` PythonAdapter/TypeScriptAdapter/TreeSitterAdapter）。
- **grammar_loader.rs**：`GrammarLoader` 进程级单例。静态语法 `register_static`（`grammar_loader.rs:74-85`）；动态语法惰性 `get()` 经 `libloading` 从 `<grammar_dir>/tree-sitter-{name}.dll|.so` 加载符号 `tree_sitter_{name}`（`grammar_loader.rs:98-137`）。`scan_dir` 扫描目录（`:154-193`），`find_grammar_dir` 查找顺序 = env → exe 旁 → cwd（`:212-228`）。
- **tree_sitter.rs**：通用 fallback 适配器。thread-local parser 缓存 + 单文件 30s 超时（`PARSE_TIMEOUT_MICROS=30_000_000`，`:23`）。`generic_walk`（`:186-291`）手写遍历，硬编码 func/class/import/call kind 名单（`:200-205`），生成 Defines/Inherits/Imports/Calls 边。
- **python.rs / typescript.rs**：两套被 registry 覆盖的旧手写适配器（作为 fallback 仍注册）。python 处理 import/import_from/call/class bases（`python.rs:96-213`）；typescript 有相对 import 路径解析 `resolve_import_target`（`typescript.rs:118-131`）。
- **query_adapter.rs**（核心，2005 行）：`QueryStructureAdapter`（`:121-186`）。每个语言一个 `*_structure.scm`，`process_query`（`:258-712`）分两阶段：Phase 1 收集 scope 边界（`:286-348`），Phase 2 跑编译缓存的 query（`QUERY_CACHE`，`:30`），按 capture 名分发处理：`fn/class/interface/call/import/inherit/var/write/throws/usage`（`:388-705`）。import 路径解析 `resolve_import_path`（`:83-103`）。
- **structure 与 dataflow 两类查询的区别**：
  - **structure**（`*_structure.scm`，captures `@fn/@class/@interface/@call/@import/@inherit/@var/@write/@throws/@usage`）→ 在**图构建时**由 query_adapter 跑，产出持久化 Node + 结构 Edge。例 `python_structure.scm:3-15`。
  - **dataflow**（`*_dataflow.scm`，captures `@write/@read/@global_var/@trigger_call/@await_cb/@await_fn/@sequence`）→ 由 dataflow_engine 在**按需**（`trace_dataflow` 工具）时跑，产出 `FileDataflow` 结构体，**不落图**。例 `python_dataflow.scm:3-22`。
  - **诚实评价**：query 方案是这套代码最扎实的部分——把「加语言 = 加 .scm + 一行注册」工程化落地了，且 query 编译做了全局缓存避免逐文件重编译（`query_adapter.rs:30-52`）。但它仍是**语法级（CST）启发式**，不是语义解析；大量名字提取是 kind/field 名硬编码 + 文本 fallback（`extract_call_target` `:903-1021` 上百行 kind 分支就是明证）。

## 2. 图构建管线（`engine/src/pipeline/` + `engine/engine/pipeline.rs`）

主流程 `Engine::run_pipeline`（`engine/pipeline.rs:34-479`），实际阶段为：

1. **Core Parse** `analyze_project`（`pipeline/runner.rs:58-200`：发现→`BATCH=200` 并行解析→串行合并）
2. **Cross-File** `CrossFileResolver::resolve`（`engine/pipeline.rs:84`）
3. **Coupling** `compute_coupling`（`:100`）
4. **Framework Routes**（`:115`）
5. **Dynamic Dispatch**（`:131`）+ 5.1 React / 5.2 Vue / 5.3 Bridge-RPC / 5.4 gRPC / 5.5 DI-Reflection / 5.6 Dynamic-Import / 5.7 Eval / 5.8 Cross-Lang（`:141-234`）
6. **Dataflow** — 已注释掉，改按需（`:236-238`）
6.1 **Coupling (incr)**（`:244`）
5.9 **Snippet Extract**（`:260-314`）
7. **Community (Leiden)**（`:337`）+ 7.6 Flow Detection（`:371`）+ 7.5 Vector index（异步，`:384-406`）
8. **DB Save**（`:411-448`）

- 解析器 `ParallelParser`（`pipeline/parser.rs:49-119`）：rayon 并行，>1MB 跳过（`:75`），no-adapter 跳过。
- 发现 `discover_files`（`pipeline/discovery.rs:16-65`）：walkdir + gitignore（无 glob、无反规则，`:161-163`）+ 硬编码 `IGNORED_DIRS`（`:204-213`），>5MB 跳过。
- **诚实评价**：管线编排成熟、内存有界（分批+后台释放 CST，`runner.rs:127-142`）、带取消令牌与 panic 守卫（`engine/mod.rs:398`）。但它不是「10 阶段」，实际是 1 个大阶段 + 9 个合成子阶段，注释与 doc 的「10 阶段」「27 工具」数字均滞后于代码。

## 3. 解析器质量（`graph/resolver.rs` 全文已读）

`resolve_name`（`resolver.rs:456-576`）6 条策略顺序：
1. 精确 ID（`:466`）
2. 短名匹配 `short_name`（`:365-379` 剥扩展名）→ `best_qualified_match`（`:582-606`，后缀段数匹配，`match_len>=2`，选路径最长）
3. 文件主干匹配 `file_stem`（`:493-512`，import 边 → File 节点）
4. 规范化 `::`/`/`/`\`（`:517-535`）
5. 点分 import 追加扩展名（`:539-546`）
6. `obj.method()` 渐进剥离前缀（`:552-573`）

裸名多候选回退 `best_bare_match`（`:619-665`）：评分 `lang_match*100000 + kind_prio*1000 + path_depth`，同分=歧义返回 None。语言过滤 `filter_by_language`（`:443-453`）保证同语言优先。未解析跨文件边作孤儿清理，歧义边打 `ambiguous` 标记保留（`:285-319`）。

**imports 边生成**：
- query_adapter `"import"` 处理器（`query_adapter.rs:533-592`）：只读 `source` 字段（JS/TS）、`module_name`（Python from）、dotted_name（Python import）、use 全文（Rust）。
- tree_sitter `import_kinds`（`tree_sitter.rs:263-277`）、python（`python.rs:154-189`）、typescript（`typescript.rs:199-210`）。

**关键结论**：
- **基于 import 路径的解析**：有，但极浅。import 边 target 是**模块/文件名**，解析靠 `file_stem` 策略 3 + 策略 5 追加扩展名匹配 File 节点（`resolver.rs:493-546`）。**没有模块图，没有符号级 import 绑定传播**——`from x import y` 只建 `file → x` 的 Imports 边，`y` 不进入任何绑定关系。
- **纯名字匹配为主**：Calls/Usage 边一律是裸名/点分名，靠 `best_qualified_match`/`best_bare_match` 按字符串后缀+语言+kind 优先级猜测。
- **aliased import**：完全没处理。`import { foo as bar }` 只提取 `source` 字段，`bar` 别名与 `foo` 无关联；usage 的 `bar` 是裸名走名字匹配。
- **lsp_resolved 置真处**：**全仓 0 处**。grep `lsp_resolved\s*=\s*true` 无匹配；所有 42 处出现均为 `lsp_resolved: false`（`edge.rs:128` 定义字段，`:155` 默认 false）。字段是死字段——LSP 解析已移出图构建（`engine/pipeline.rs:77-79`），改由 `resolve_call` 工具按需执行。

## 4. 数据流（`analysis/dataflow_engine.rs` 全文已读）

`query_file_dataflow`（`dataflow_engine.rs:414-596`）Phase 1 收 scope（`:428-444`）→ Phase 2 收 captures（`:446-487`）→ Phase 3 按 scope 归桶（`:489-531`）→ Phase 5 共享检测（`:533-561`）。

- **writes**：`@write` capture 直接入 `scope_writes`（`:502-505`）。
- **reads**：`@read` = **全部 identifier 减法式**——`CapKind::Read` 跳过 `write_offsets` 命中、`skip_names`、非小写开头（`:509-514`）。`.scm` 里就是 `(identifier) @read`（`python_dataflow.scm:20`）。
- **shares**：纯**同名字符串碰撞**——变量名出现在模块级或「被 >1 个 scope 写 / 被非自身 scope 写」即判共享（`:545-549`）。
- **triggers/awaits/sequences**：`@trigger_call`（await 的 call/identifier）、`@await_cb`/`@await_fn`、`@sequence`（连续 call 按行排序）（`:515-528`）。

**诚实评价（严苛）**：
- **无跨函数传播**：读/写按「最近的词法 scope」归因（`find_scope` `:696-703`），不追踪参数传递、返回值、调用边界。
- **无别名分析、无污点源/汇**：没有 source→sink 概念，没有对象/引用追踪。
- **角色**：`dataflow.rs`（88 行）只是把 Tarjan SCC 分类为 pure/data/llm；`dataflow_synthesis.rs` 是 **no-op 桩**，`synthesize_dataflow_edges` 永远 `return 0`（`dataflow_synthesis.rs:20-27`）；`flows.rs` 是执行流（入口点→沿 CALLS 前向 BFS→关键性评分），**不是数据流**。
- **决定性证据**：`EdgeKind::Reads/Shares/Triggers/Awaits/Sequences` 五种边在**生产代码中从不被创建**（grep 只在 test/edge 枚举定义处出现）；`async_edges` 工具注释明写 `"_note": "from dataflow engine (on-demand query, no graph storage)"`（`handlers/graph.rs:276`）。所以「数据流环」「L4 时序边」作为**存储图边**基本是空壳——`Writes/Usage/Throws` 来自 structure 查询，其余全是按需内存结果。

## 5. 分析算法

- **coupling.rs**（`:20-67`）：L1=同包 import/call/inherit/defines，L2=跨包，L3=Reads/Writes/Shares/Usage，L4=Triggers/Awaits/Sequences/Throws。O(E) rayon 并行。**纯图统计**。
- **cycles.rs**（`:57-86`）：**Tarjan 强连通分量**（`strongconnect`），SCC size>1 报环，自环（size=1）被滤掉。
- **fragility.rs**（`:17-31`）：`score = fan_in+fan_out 之和 × (1 + Σ(coupling_depth²)/fan)`。**纯图统计公式**，无语义。
- **blindspots.rs**（`:7-42`）：只是把 L4 计数/环计数/冲突计数**三合一的聚合函数**，按阈值写 severity。**不是检测器**，是报告器。
- **policy_check.rs**（`:76-122` 编译 glob/regex；`:198-299` 主逻辑）：用户定义 source/target 文件模式 + edge_kinds，扫 MemoryIndex 出边匹配。是**真正的规则引擎**，但匹配对象是「文件路径 regex + 边类型」，不是语义。
- **dynamic_dispatch.rs**（`:108-158`）：硬编码回调方法名集合（addEventListener/on/then/subscribe…），tree-sitter 找 call + 第一个非字符串参数当回调，建合成 Calls 边。**字符串模式启发式**。
- **dynamic_boundaries.rs**（`:40-88`）：8 个**正则表达式**扫源码行（computed-call/reflection/proxy/getattr…）。**纯文本 regex**。
- **framework_routes/mod.rs + frameworks/**：24 个框架检测器（22 调用式 + Next.js/SvelteKit 文件系统式），每个是 tree-sitter 遍历 + 硬编码方法名/装饰器模式（例 `fastapi.rs` 硬编码 `get/post/put/...` 方法集）。**语法模式匹配，无类型信息**。
- **总结**：全部是**图统计 + 语法模式/正则启发式**，零语义分析（无类型推断、无数据流求解、无指向分析）。

## 6. LSP（`lsp_manager.rs`，1366 行）

- 架构：惰性单例 `LspManager → ServerPool → 每语言一个 LSP 子进程`（`:10-21`）。stdio JSON-RPC，Content-Length 帧协议（`:62-69`）。
- 覆盖 9 语言：rust-analyzer/gopls/pyright/typescript-language-server/clangd/jdtls/omnisharp/intelephense/kotlin-language-server（`SERVER_CONFIGS` `:476-539`）。
- 超时 5s（`:40`），超时丢 reader、下次重建（`:142`）；服务器请求（workspace/configuration）回 null（`:112-126`）。
- **接入方式**：**完全独立，不参与图构建/边解析**。`warm()` 在分析完成后台异步启动（`engine/pipeline.rs:450-457`）；边解析已从流水线移除（`engine/pipeline.rs:77-79`），LSP 只服务 4 个按需工具（resolve_call/infer_type/find_implementations/find_references）。**启动成本**：warm 是 `std::thread::spawn` 后台非阻塞（`:601+`），失败静默降级到手写适配器（`:19-21`）。

## 7. 查询接口（`tools/mod.rs`）

- `all_schemas()`（`:412-742`）实际定义 **35 个 schema**（含 legacy `symbol_history`）；`DEFAULT_MCP_TOOLS`（`:75-110`）默认激活 **34 个**（不含 symbol_history）。**「33 工具」（AGENTS.md）与「27 工具」（`tools/mod.rs:4` 头注释）均滞后**，准确数是 34 默认 + 1 legacy。
- **没有自定义查询语言**，只有固定工具。`graph/query.rs`（164 行）是**已弃用**的 O(E) 传统实现（`:1-6` 头注释明确 "已弃用"），生产走 `storage::query`/`MemoryIndex`。
- 34 个默认工具一句话功能（含 dispatch 映射 `:132-177`）：
  - `explore_deps`（NL 依赖探索）、`search_symbols`（FTS 名字搜索）、`get_neighbors`（1 跳邻域）、`trace_impact`（下游 BFS 爆炸半径）、`find_dep_path`（A→B 路径）、`inspect_symbol`（单符号全量进出边）、`get_community`（社区归属）、`cluster_report`（全局社区图）、`fragile_modules`（脆弱度 topN）、`detect_cycles`（Tarjan 环）、`thread_conflicts`（共享变量多写冲突）、`coupling_report`（L1-L4 剖面）、`project_timeline`（审计时间线）、`arch_blindspots`（盲点聚合）、`grpc_services`（.proto 服务/实现状态）、`preflight_check`（改动预演）、`graph_summary`、`graph_diff`、`analyze_project`、`validate_project`、`project_health`、`rename_symbol`、`engine_status`、`check_boundaries`（边界规则）、`find_unused`（死代码候选）、`trace_dataflow`（按需数据流）、`list_flows`/`get_flow`/`get_affected_flows`（执行流）、`resolve_call`/`infer_type`/`find_implementations`/`find_references`（LSP）。
- **handlers**（9 个文件 34 个 handler，全返回 `ToolResponse`）：`graph.rs`(neighbors/impact/path/community/delayed/node)、`analysis.rs`(fragile/cycle/thread_conflicts/coupling_report/timeline/blindspots/grpc_services)、`overview.rs`(graph_summary/clusters/diff/analyze/run_check/run_health)、`flows.rs`(list/get/affected)、`search.rs`(search/explore)、`audit.rs`(status/policy_check/unused)、`resolve.rs`(resolve_call/resolve_type/find_implementations/find_references/dataflow)、`preflight.rs`、`rename.rs`。

## 8. 增量分析 / 存储

- **incremental.rs**（`IncrementalUpdater::update` `:67-207`）三阶段：Phase1 单文件 tree-sitter 重解析（`:108-120`）→ Phase2 文件内 diff（`:122-142`，按 `(name,kind)` 匹配 + 位置容差 ≤3 行 `:309-336`）→ Phase3 跨文件边修复（`:146-164`，按 name_index 重推）。**是文件级 diff，不依赖编译器语义**，就是「重解析 + 字符串键匹配」。**已知差距自认**（`:13-26`）：耦合/社区/动态合成/框架路由/snippet 全不重跑。验证守卫 = 边数跌 >5% 拒绝交换（`:167-175`）。
- **snapshot.rs**：bincode 快照（≥5M 边默认，`:32`），头部 token + payload（`:55-95`），原子 rename（`:183-204`）。
- **sqlite.rs**：`hologram.db` 存 nodes/edges（+coupling_depth/temporal/metadata 列）、`timeline_events`、`meta`（schema_version/snapshot_token）、`name_segment_vocab`、FTS5 `fts_nodes`（`CREATE VIRTUAL TABLE fts_nodes USING fts5` `:217`）。
- **staleness.rs**：只读检查 pending_changes 与响应中 `file/location` 字段子串匹配，渲染警告横幅（`:12-61`）。纯提示，不重算。

## 9. 向量/语义

- **minilm.rs**：`sentence-transformers/all-MiniLM-L6-v2` ONNX，384 维（`:4,18`），ort 动态加载 `onnxruntime.dll`（不下载二进制，`:7-8`），WordPiece 分词 + 均值池化 + L2 归一化（`pool_normalize` `:216-230`）。
- **vector/mod.rs**：`CodeVectorIndex` 用 **usearch HNSW**（Cos metric，`:49-57`），嵌入函数/类源码 snippet（`extract_snippet` `:346-362`，字节搜名字取 30 行）。fallback = n-gram 哈希（`embed.rs`）。用途：**语义搜索**（explore_deps/搜索的向量召回），后台异步构建（`engine/pipeline.rs:384-406`）。索引带后端标识，后端不匹配自动判废（`:226-231`）。

## 10. 测试与证据

- **fixtures**：`engine/fixtures/` 有 6 组——`test_project`(py+js 混合)、`pipeline_test`、`gap_probe`、`grpc_services`(proto+4 语言 client)、`framework_routes_p1`(chi/echo/express/actix)、`framework_routes_nextjs`、`framework_routes_sveltekit`。
- **Rust 测试**：665 个 `#[test]`，覆盖单元 + 集成（`test_fixture_full_pipeline` `engine/mod.rs:1181` 是唯一全管线集成测试）。
- **Python 测试**：**根目录 `tests/` 不存在**（AGENTS.md 提到「遗留 Python 测试」已删）。仅存第三方语法绑定的 `test_binding.py`。
- **解析正确率/召回率测试**：**没有**。全是 smoke/行为断言（「找到 N 个节点」「该有某边」），无任何 gold-standard 召回/精确率基准。

## 11. 社区检测（`community/louvain.rs`，1545 行）

- **实现**：经典 **Louvain 局部移动（Phase 1）** + **Leiden Phase 2 精化**（split/merge，`:480-660`），`detect_communities`（`:679-694`）。层次版 `detect_hierarchical_from_base` 迭代压缩、`MAX_LEVELS=8` 上限（`:346`），种子 `seed=42`（`engine/pipeline.rs:337`），所有边权重统一 `1.0`（`:65,96`）。
- **规模迹象**：无节点数硬上限；性能靠密集索引 + 边借用（`:323-332`）扛内核级 14M 边。社区 ID 跨次分析稳定匹配 `match_communities_to_previous`（`:842`）。

---

## 诚实评估：哪些扎实，哪些是名字唬人的启发式

**扎实（有实打实的机制，不是空壳）**：
- **tree-sitter 解析 + .scm 查询管线**：`grammar_loader.rs`（动态 DLL）+ `query_adapter.rs`（query 缓存 + scope 追踪）是真实工程，20 种语言结构提取可工作，且测试密集（`query_adapter.rs:1360-2005` 上百个断言）。
- **Tarjan 环检测**：`cycles.rs:57-86` 是教科书正确实现，跨文件环测试齐全（`resolver.rs:901-962`）。
- **Louvain/Leiden 社区检测**：`louvain.rs` 是真正的 Leiden 精化实现，非桩。
- **policy_check 边界规则引擎**：`policy_check.rs` glob→regex + 边类型匹配是真规则引擎，测试覆盖充分。
- **存储层**：`snapshot.rs`（bincode 快照 + 原子替换）、`sqlite.rs`（FTS5 + timeline + meta）、`incremental.rs`（三阶段 diff）都是真实现。
- **MiniLM 向量索引**：`minilm.rs` 真实 ONNX 推理（非假模型），有 batch/单条一致性 + 语义区分度测试（`:262-339`）。

**名字唬人 / 启发式（代码证据）**：
- **「L1-L4 耦合」= 按边 kind 查表 + 按文件首段判同包**：`coupling.rs:50-61` 就是 `match edge.kind { Imports/Calls/Inherits/Defines => 同包?1:2, Reads/Writes/... => 3, Triggers/... => 4 }`，与「耦合深度」语义无关。
- **「脆弱性评分」= 度数 × (1+深度²均值)**：`fragility.rs:24` 一行公式，纯图统计。
- **「盲点检测」= 三个计数器的 if/else 报告器**：`blindspots.rs:7-42` 只是把 L4 数/环数/冲突数拼成 JSON。
- **「数据流」= 同名字符串匹配，且不落图**：`dataflow_engine.rs:545-549`（共享=同名碰撞）；`dataflow_synthesis.rs:20-27`（管线 no-op）；`handlers/graph.rs:276`（明写 no graph storage）。**Reads/Shares/Triggers/Awaits/Sequences 五种边生产从不创建**——所谓「数据流环/线程冲突/异步依赖」全部是**按需对源码重跑 query 的临时结果**，不是持久图边。
- **「LSP 解析」= 独立按需子进程，图内 `lsp_resolved` 恒 false**：全仓 0 处置真（`edge.rs:128` 字段定义，其余全 `:false`）；`engine/pipeline.rs:77-79` 明示移出管线。
- **「跨文件解析」= 名字后缀 + 语言 + kind 优先级的猜测**：`resolver.rs:619-665` `best_bare_match` 自认「这是启发式而非保证，精确请用 LSP」（`:617-618`）。import 是「文件名 stem 匹配」，**无模块图、无符号绑定、无别名处理**。
- **「动态调度/DI/反射/framework 路由」= 硬编码方法名集合 + 正则**：`dynamic_dispatch.rs:108-114`（12 个方法名）、`dynamic_boundaries.rs:40-88`（8 条 regex）、`di_reflection/langs.rs`（getattr/setattr 等字面量判断）。合成边 `is_synthesized=false`（`dynamic_dispatch.rs:141`，注意：本应是合成边却标 false，元数据缺失，是笔误级别的证据）。
- **文档数字滞后**：「33/27 工具」vs 实际 34 默认 + 35 schema；「10 阶段管线」vs 实际 1 核心 + 9 合成子阶段。

**一句话总评**：这是一个**「语法级依赖星图 + 图统计 + 模式启发式」引擎**，扎实的是解析/存储/图算法/向量检索这层基础设施；名字里带「语义」的分析能力（数据流、脆弱性、盲点、动态调度、LSP 解析）绝大多数是**名字匹配、正则、计数器与按需重跑**的组合，`lsp_resolved` 死字段与 `dataflow_synthesis` no-op 是最刺眼的两个「宣传与实现脱节」证据。
