# 性能压测与优化交接 — 2026-08-06

> 背景:一次完整的压测驱动优化会话。引擎全量分析在 Reasonix 上 457.7s → 16.6s(27.6×),
> 内核 fs 子树 128.8s → 91.0s(同日第二轮优化后 → ~48s)。本文档记录已完成的修复、当前瓶颈和下一步。

## 压测工具用法(engine 内置)

```bash
cd engine && cargo build --release
BIN=./target/release/hologram-engine.exe

$BIN --stress-real <项目路径> [轮数]    # 真实项目基准,默认 3 轮,报告每阶段 min/mean/max
$BIN --stress-full <路径> [轮数] [ext]  # 结构 + Dataflow + LSP 完整管线
$BIN --stress small|medium|large|<N>    # 合成 Python 项目(seed=42 可复现)
$BIN --stress-suite                     # small→large 缩放对比
```

- 压测模式 rayon 用满全部核;报告 RSS 已修复(之前测的是 powershell 子进程,恒 ~60MB)
- 大项目跑法:后台任务 + 每 3 分钟 cron 看门狗(RSS>12GB 或剩余<2GB 自动停),16GB 机器必须带
- 引擎分析会在目标项目下写 `.hologram/`(hologram.db 等);保存时清表重写(sqlite.rs:334),无需手动清

## 已完成修复(3 个 commit,全部有回归测试)

| commit | 内容 | 效果 |
|---|---|---|
| `fc551ef` | di_reflection Go/Java 分支 find_or_create 挪进命中分支(此前每个调用点无条件造 di_syn 孤立节点,Go 项目灌入 6.6 万垃圾节点);louvain 层次压缩 O(1) 索引 + MAX_LEVELS=8 + 孤立社区剔除;LSP warm 跳过已运行;RSS 统计修复 | Reasonix 458s→37.5s |
| `3910abc` | flows.rs 入口检测入度计算改反向索引(原每节点全扫所有边,O(N×E)) | flows 22.5s→2.0s,Reasonix →16.6s |
| `ecb33e8` | C 查询删 throw_statement(非法节点导致整个 C 查询编译失败,C 提取从未工作);extract_def_name 支持 C/C++ declarator 链(就算查询能编译,函数名也取不到);QUERY_CACHE 全局缓存(原逐文件 Query::new);resolver resolve_name 记忆化 + 候选语言预算表 | fs 子树 cross-file 58.5s→2.55s(23×),总 128.8→91.0s |

**教训(同型 bug 模式,review 新代码时警惕)**:
1. 对集合 A 每个元素全扫集合 B(O(N×E)/O(E×K))——三次事故的同一个根型
2. "先建节点后判断"——必须命中后再创建,否则产生孤立垃圾节点毒害下游所有阶段
3. 逐文件重复编译(tree-sitter Query::new、正则等)——编译结果必须缓存
4. 未修:resolver 候选顺序依赖 HashMap 迭代序 → 跨轮结果微差(社区数 1481/1482/1488),不影响性能,影响严格可复现性

## 第二轮优化(2026-08-06 下午,未提交)

分段计时揭穿一个误判:**"DB Save" 阶段 ≠ SQLite 写入**,它包含 MemoryIndex 构建(3.3s)+ 边收集(0.4s)+ bulk_replace_all。52.3s 里真正的 SQLite 写入是 45.9s,拆分:edges 插入 23.4s(5 个二级索引逐行维护 + FK 每边 2 次查 nodes)+ DELETE 9.1s(FTS 触发器对 155k 旧节点逐行 'delete' 插入)+ nodes 7.5s + commit 5.0s。FTS rebuild 只有 0.8s(原头号嫌疑洗清)。

| 修复 | 文件 | 效果 |
|---|---|---|
| bulk_replace_all 重构:先删 FTS 触发器再 DELETE;先删 9 个二级索引、插入后批量 CREATE INDEX;加载期 foreign_keys=OFF + synchronous=OFF(连接级,事后恢复;DDL 随事务回滚不留半残 schema) | storage/sqlite.rs(bulk_replace_inner) | bulk 45.9s→18s,DB Save 52s→22s |
| extract_snippet 改字节级 `str::find`(原逐行 contains + 命中后全量 collect 行 Vec);snippet 阶段 rayon 并行 + 去掉全量 source clone(改借用) | vector/mod.rs:346, engine/pipeline.rs:240 | Snippet Extract 17.9s→1.3s(14×),并消掉一次全源码语料克隆 |

**fs 子树总计:91.0s → 43.1s/53.8s 两轮(mean 48.4s)**。回归:`cargo test --lib` 569 通过(新增 test_bulk_replace_all_twice_restores_schema 覆盖二次替换后触发器/索引/FK/pragma 恢复)。存档 `stress-real-linux-fs-v4-instrumented.txt`(定位用)/`-v5-dbsave.txt`/`-v6-snippet.txt`。

## 当前瓶颈(fs 子树 ~48s 内,按优先级)

| 阶段 | 耗时 | 占比 | 备注 |
|---|---|---|---|
| DB Save | 21.6s | 45% | bulk 内 18s:edges 插入 7.5s + nodes 4.2s + 索引重建 3.5s。再压榨方向:prepared statement 复用(现每 chunk 重新解析 900 参数 SQL)、边按 source 有序插入(B-tree 局部性)。收益递减,建议先不动 |
| Core Parse | 9.0s | 19% | 2169 文件,~240 文件/s,健康 |
| Community | 8.4s | 17% | 155k 节点 hold 住 |
| Snippet Extract | 1.3s | 3% | 已解决 |

**教训补充(第 5 条)**:阶段名会骗人——"DB Save" 里藏着内存索引构建;给阶段内部加分段计时再动手,别凭阶段名猜瓶颈。

## 内存天花板(全内核跑不了的根因)

- 全 Linux 内核(6.4 万文件)真实 C 图 ≈ **200 万节点 / 1400 万边**,推算 RSS 10~20GB,16GB 机器在解析 62% 时耗尽(实测 7.3GB @ 1.3M 节点 + 9M 边)
- 根因:`Graph` 用 `HashMap<String, Node/Edge>`(graph.rs:30-32),每条边的 id/source/target 三份长字符串各自堆分配,~700B/图元素
- 解法(大工程,未做):字符串 ID interning(u32 符号表)+ 边压缩存储,内存可砍 5~10 倍。动之前先评估:值得为全内核规模做这次重构吗

## 基准数据存档(test-results/,gitignored)

- `stress-full-reasonix.txt` / `-after.txt` / `-flows.txt`:Reasonix 三轮全量(前/修 di_syn 后/修 flows 后)
- `stress-real-linux-kernel.txt`:全内核首轮(C 提取失效版,165.9s 但图是假的)
- `stress-real-linux-fs.txt` / `-v2.txt`:fs 子树(resolver 优化前/后)
- `stress-suite-synthetic.txt`:合成套件(只跑完 small;medium 因超线性被手动停)

## 已知未修小项(不紧急)

- `--stress-real` 结束后进程偶发不退出(LSP 后台线程未回收)
- `find_or_create_di_node` 仍是全图线性扫描(调用量已从 6.6 万次降到百次级,暂不疼)
- dataflow_engine.rs:421 同样逐文件 Query::new 未缓存(该阶段仅 ~1s)
- 合成压测生成器边密度 ~5 倍于真实项目,suite 适合暴露超线性,不代表真实体验

## 第三轮优化(2026-08-06 晚,Phase M 已提交:M1/M2/M3)

按 `docs/plans/graph-id-refactor-plan.md` 执行内存救场,全部一批一 commit:

| 批 | 内容 | commit |
|---|---|---|
| M1 | GraphMerger 的 edge_index/loc_index 全 interning 化(内置 StringArena,索引只存 u32 句柄)——消除解析期 ~2.3GB 字符串重复,这是全内核 OOM 的最大头 | `perf(engine): [M1]` |
| M2 | detect_hierarchical_from_base 的 leaf_edges 改 &[(&str,&str)] 借用 + dense 索引一次性预映射(原每层循环对全边做 HashMap 查找 ×最多 8 层) | `perf(engine): [M2]` |
| M3 | parse_cache 字节预算门控(env HOLOGRAM_PARSE_CACHE_MB 默认 512MB),超预算文件记 cache_skipped_files,snippet 阶段补盘读回退(只认清单,未触发时行为逐位不变) | `perf(engine): [M3]` |

fs 子树验收:图数字 155518/426199/28284 三轮不变,总计 91.0s → **38.8s**,community 8.4s→5.9s(M2 的 CPU 红利),1MB 小预算强制走盘读回退仍产出完全相同的图和 155518 条 snippet。

### 全内核实测(D:/linux-7.1.0,51k 文件)——内存墙已翻,算法墙现身

跑法:`--stress-real D:/linux-7.1.0 1` 后台 + RSS>12GB 看门狗。
**结果:全程 ~65 分钟未 OOM(RSS 8.6~10.5GB),最终被 1 小时任务超时在 community 阶段终止。**
存档 `test-results/stress-real-linux-kernel-v3.txt`(gitignored)。

阶段实录(对照 fs 子树):

| 阶段 | 内核 | fs | 结论 |
|---|---|---|---|
| Core Parse | 1283s(249万节点/1736万边) | 9s | 线性(137× 边,143× 文件),健康 |
| **Cross-File Resolver** | **1268s** | 2.5s | **超线性,实测指数 ~2.3**(未解析边 14.35×,耗时 507×)。818 万未解析(687 万 bare extern + 96 万多候选),解析出 501 万新边 |
| **Coupling** | **197s** | 0.19s | **超线性,1035×**——同型 bug(fs 规模下绝对值太小一直隐身) |
| 合成阶段合计 | ~178s(eval 79s、coupling-incr 83s) | ~0.3s | 也偏大,待查 |
| Snippet Extract | 69s(249万条,含 1.5万文件盘读) | 0.9s | 可接受 |
| Community | 被终止,未完成 | 5.9s | **未知**,2240 万边规模无数据 |
| Flows / DB Save | 未到达 | 0.4s / 21.6s | 无数据;flows 的 build_calls_adjacency 字符串克隆是已知未修项 |

**Phase M 毕业判定:内存目标达成(16GB 可建全内核结构图,看门狗全程未动);
但总耗时进入不可用区域(~1.5h 量级),瓶颈从内存转为三个算法级超线性。**

## 下一步(优先级重排:M4+ 算法瓶颈 > R 阶段架构重构)

**R 阶段实现规格已定稿,见 `docs/plans/graph-id-refactor-plan.md`(2026-08-06 v2)** —
设计决策全部钉死(NodeId 永为字符串句柄、serde transparent、快照阈值 5M 边、
FTS 惰性重建折中、R10 目标 全内核<15min),接手模型按规格机械施工即可。

1. ~~M4 resolver 超线性~~ → 已修复(2026-08-06,已提交)。根因不是候选扫描平方
   (实测 cand_scans 仅 141 万 @ drivers),而是逐边常数(端点 clone×2、全串
   lowercase、逐候选 Vec 分配)在换页压力下放大。修:Cow 借用 + infer_language
   记忆化 + 三处评分零分配 + 分段计时/计数器。**drivers(12.6M 边)cross-file
   36.9s,回归线性;全内核外推 ~50s(原 1268s)**
2. ~~M5 coupling 超线性~~ → 已修复(借用化 + rayon)。注:drivers 旧代码实测仅
   3.1s,内核 197s 主要是换页抖动;常数砍量级后换页敏感性同步下降
3. ~~M6 flows 字符串克隆~~ → 已修复(借用化,同 M2 模式)
4. ~~M7 db-save 规模墙~~ → **已解决(2026-08-06,R9.2 快照持久化,drivers 写入
   885.6s → 56.3s,见下文「R 阶段进度」)**。原始分解:
   - MemoryIndex::from_existing_graph 353s(fs 3.2s)——intern+桶排序在大边数下劣化
   - bulk_replace_all 885.6s:edges 插入 228s(21k 行/s)、索引重建 242.5s、
     commit 292s(数 GB WAL fsync)、nodes 94s、fts 28s
   - 候选方向(需设计决策):prepared statement 复用+边有序插入(小修);
     图大时改快照式持久化(跳过 SQLite 全量重写,架构级);增量保存
5. 修完 M7 再重跑全内核验证;R0~R10 架构主线在此之后排期
   → **更新(2026-08-06):R0~R8 已竣工(见下文「R 阶段进度」),M7 以 M7c 快照
   持久化形式并入 R9.2,剩余 R9/R10。**
6. (未测量维度)Dataflow/LSP 不在 --stress-real 内:Dataflow 按需计算不占管线内存;
   LSP warm 对 51k C 文件的 clangd 后台索引是独立课题,未测

### drivers 中间规模基准(2026-08-06,M4 后,存档 stress-real-linux-drivers-m4.txt)

| 阶段 | 耗时 | 备注 |
|---|---|---|
| Core Parse | 163.8s | 33.6k 文件,186 万节点/1259 万边 |
| Cross-File | 36.9s | loop 20.8 + writeback 7.5 + orphan 5.0(M4 后线性) |
| Coupling | 3.1s | M5 前旧代码 |
| Snippet Extract | 29.1s | 186 万条(含盘读回退) |
| Community | 154.7s | 384653 社区,轻微超线性可接受 |
| Flows | 5.3s | M6 后 |
| **DB Save** | **1247.8s** | MemoryIndex 353s + bulk 885.6s(M7 目标) |
| 总计 | 1697.6s | RSS 峰值 9.3GB |

## R 阶段进度(2026-08-06,R0~R9 竣工,全部逐批提交)

按 `docs/plans/graph-id-refactor-plan.md` v2 施工。R0~R8 每批 `cargo test --lib` 579 passed
(R0 净增 9 个访问器边界用例后只增不减),R9 后 594 passed(净增 15)。
R1~R7 后与 R8 后各跑一次 fs 数字契约,两次全绿:**155518 nodes / 426199 edges /
28284 communities,resolved 271321,总耗时 ~35-36.5s(基线 ~48s,无劣化)**;
R9 后 fs 契约第三次全绿(35.6s,42.6 万边 < 5M 阈值走 SQLite 旧路,逐位不变)。

| 批 | commit | 内容 |
|---|---|---|
| R0 | `3049e7d` | `graph/id.rs`:NodeId/EdgeId newtype(serde transparent、Borrow<str>,无 Deref);Graph 加 nodes_iter/edges_iter/node_ids/edge_ids;Node 加 file()/short_name()/module() 语义访问器(扩展名表与 resolver 同源 GRAMMAR_LOADER)。纯新增零行为变化 |
| R1 | (空批) | adapter/ 实测为 Graph 生产侧(返回 (Vec<Node>,Vec<Edge>,Tree) 元组),无任何 Graph 消费点,零改动 |
| R2 | `c412c13` | resolver 容器访问迁移;私有 short_name/file_stem 调用点输入均为 node.name/edge.target(非 node.id),按规格全部保留 |
| R3 | `bab1f9a` | di_reflection/dynamic_dispatch/bridge_rpc 迁移 nodes_iter/node_ids/get_node |
| R4 | `b09238b` | analysis 其余模块;flows 文件收集改 Node::file();strip_line_suffix 标 #[allow(dead_code)] 留 R8(测试保留) |
| R5 | `dc0a364` | community/routing 迁移 |
| R6 | `5c7280c` | handlers find_references 图回退迁移 |
| R7 | `90221ef` | main/engine 迁移;graph_from_index cross_file 推导改 Node::file()(见下注) |
| R8 | `9b55c8c` | Graph.nodes/edges 改 pub(crate);新增 get_node_mut/get_edge_mut、nodes_map/edges_map(+_mut)、into_parts、take_nodes/take_edges、meta()/meta_mut()、outgoing()/incoming() 迭代器(旧 Vec 版标 deprecated 且调用点迁净);R1~R7 缺口清单 9 项全部收口 |
| R9 | `cca3e4e` | serde 定型 roundtrip 测试(旧 JSON 双格式零漂移 + SQLite 冷启动读回)+ M7c 快照持久化:新模块 storage/snapshot.rs(bincode 1.3 全量 MemoryIndex,.tmp 原子 rename),阈值 HOLOGRAM_SNAPSHOT_MIN_EDGES 默认 5M 边,GraphStore::save 漏斗分流、open 优先快照、损坏删快照回退 SQLite;FTS 惰性重建(见下注) |
| R9b | `0399444` | 快照加载判定 mtime 启发式 → 代际 token(文件头 peek + db meta snapshot_token);to_sqlite 全量保存自动失效快照,FTS/timeline 写 db 不再误伤;新增 5 测试含 checkpoint 核心回归 |

**R9 drivers 验收(阈值 4M 强制快照,存档 stress-real-linux-drivers-r9-snapshot.txt)**:
图数字与 M4 基线逐项一致(1859750 nodes / 4846727 edges / 384653 communities);
**快照写入 56.3s(2.44GB,<60s 达标,原 bulk_replace_all 885.6s,15.7×)**;
db-save 阶段 1247.8s → 382.4s(memory-index build 312.7s + swap+snapshot 69.7s);
**总耗时 1697.6s → 778.2s(2.2×)**,RSS 峰值 6.2GB(原 9.3GB)。

**R9 两处机制性发现**:
- fts_nodes 实为 external-content 表(content=nodes),「只直插 FTS 表」实测 0 命中;
  最终实现为单事务双写 nodes 内容表 + fts_nodes(同 rowid,DROP/重建同步触发器,
  DDL 随事务回滚),规格钉死点(事务/分批/30s 预算/降级文案含 hologram_explore)全保留。
- bincode 不支持 serde_json::Value 的 deserialize_any,Node.properties 以 JSON 文本
  进快照(SnapshotNode 镜像,into_node 解析失败回退空对象)。

**R9 残留风险(已于 R9b 修复,commit `0399444`)**:原 mtime 启发式(快照模式下
db 写入经 WAL checkpoint 推快 db mtime → 下次启动误走 SQLite 读 nodes-only 旧图)
已由**代际 token** 取代:快照文件头(8B 长度 + token,不必读 2.4GB payload)与
db meta 表 `snapshot_token` 比对;token 生成式 `{nodes}:{edges}:{millis}`。
FTS 惰性重建/timeline 写 db 零补偿(核心回归测试:快照后写 db + drop 触发
checkpoint,重开仍走快照);唯一失效点是 to_sqlite 全量保存成功(含 incremental
直调),自动清空 token。旧无头部 R9 快照按损坏处理(删除回退 SQLite,可再分析重建)。
测试 594 → 599。另:engine/mod.rs:503 的 `.unwrap_or_default()` 会吞掉 FTS 降级
Err 变空结果(批外未动);watcher 增量路径 from_existing_graph → dirty=true,
首个 FTS 查询会触发一次惰性重建(30s 预算兜底,正确但冗余)。

**R7 行为边缘注记**:engine/mod.rs cross_file 推导从「无条件剥冒号尾段」改为
Node::file()(只剥纯数字行号)。规范 path:line 下完全等价;fs 契约 resolved
271321 不变,裁决通过。

**R8 两处借用检查迫使的等价重构(已审 diff)**:
- coupling.rs:节点表 take_nodes() 到局部建借用索引 → edges_map_mut().par_iter_mut()
  → 放回原表(闭包内无 panic 路径)
- flows.rs:Flow 元数据改延迟写回(循环内只读,循环后统一 get_node_mut;
  循环体从不回读 properties["flow"],逐元素等价)

**R8 偏离记录**:
- 规格「diff 返回类型加 newtype 包装」经核无可包装对象(GraphDiff 字段均为
  Node/Edge 克隆,无裸 String id),未动。
- 清单外发现:src-tauri 是 engine 的 path 依赖,utils.rs 6 处只读访问随
  pub(crate) 用 nodes_map()/edges_map() 迁移。
- src-tauri `cargo check` 在 R7 提交态即失败(commands/shell.rs:323/333 E0631,
  Graph 无关的既有问题),未修。

**R8 后残留死代码**:flows.rs strip_line_suffix(#[allow(dead_code)],测试保留)。

**R10-deep 竣工(2026-08-06,commit `66b3698` id.rs / `8d717e9` 全量句柄化 / `88149e0` 分段计时)**:
- **方案修正**:规格原版「容器 u32 + 现有 StringArena」经核算为**内存回退**(StringArena 每串存两份,
  叠加 Node.id 第三份);handoff 原始解法(字符串 interning u32 符号表 + 边压缩存储)才是真目标。
  据此改做 **R10-deep**:Node.id/Edge.id/Edge.source/target 全量改全局驻留 u32 句柄
  (graph/id.rs 全局驻留器,Arc<str> 共享字节;serde 线格式仍是纯字符串,零漂移)。
- **drivers 压测(阈值 4M 快照,存档 stress-real-linux-drivers-r10.txt)**:
  图数字 1859750/4846727/384653 与 R9 **逐项一致**;
  **总耗时 778.2s → 667.8s(-14%)**;db-save 382.4s → 260.8s(-32%),
  from_existing_graph 312.7s → ~138s(intern 98s + buckets 39s + sort 0.3s + flatten 0.75s);
  **RSS 峰值 6.2GB → 964 MB(-84%)** —— u32 句柄让图在内存瘦 6 倍,全内核换页墙基本消失。
- **fs 契约三次全绿**:155518/426199/28284,resolved 271321,37.6s(基线 ~48s 内);
  R10b 后 607 测试全绿(净增 8:id.rs 句柄 10 测 - 旧 2 测),0 warning。
- **R10 副作用**:cross-file 45.2s vs R9 34.7s(+30%,get_node 句柄两跳);community 156.7s vs
  141.7s(+11%,见下)。core-parse 146.0s(-11%)。
- **R10 后全内核瓶颈(分段计时拆分,drivers 实测)**:
  1. from_existing_graph ~138s(最大单块:intern 98s 是字符串重驻留,MemoryIndex 未共享全局句柄);
  2. community local-moving ~74s(louvain 核心串行跑两遍 + retain 线性扫描);
  3. community build_adjacency ~27s(两次字符串→u32 重映射,句柄可直接复用);
  4. leiden step3 K² 22s(超线性,内核最大风险,fs 0.4s → drivers 22.4s)。
- **R10 偏离/遗留**:规格「IndexMap<NodeId,_> 或 arena+handle 双映射」实际走全局驻留句柄(更强);
  MemoryIndex 仍持独立 StringArena(快照序列化需要),未共享全局驻留器(下一步可消 intern 98s);
  src-tauri shell.rs 既有 E0631 已顺手修复(R10b 内)。

**全内核终审(2026-08-06,存档 stress-real-linux-kernel-r10.txt,RSS-only 看门狗)**:
**1770.5s(29.5min)全程跑完,RSS 峰值 646 MB** —— R9 时代 1 小时超时死在 community、
RSS 8.6-10.5GB 换页;现图数字 2486778/7460139/469360,阶段拆分:
core-parse 432.7s(24%)· db-save 564.0s(32%,from_existing_graph ~311s=intern 244s+buckets 65s,
快照 ~253s)· **eval 304.5s(17%,drivers 仅 0.7s,超线性 435×,新挖出的隐身墙,528 markers)**
· community 218.3s(12%,adjacency 59s+local-moving 92s+step3 K² 34s+hierarchy 29s)
· snippet 37.1s · flows 13.9s。规格「全内核 <15min」未达(29.5min),剩余三座墙:
db-save(intern 共享+快照)、eval(超线性待查)、community(两次 louvain+adjacency)。
**W 阶段攻坚作战文档**:docs/agents/perf-handoff-walls.md(eval 根因+修复方案定稿 / db-save / community 方向)。
