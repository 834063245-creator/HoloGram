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

1. ~~M4 resolver 超线性~~ → 已修复(2026-08-06,已提交)。根因不是候选扫描平方
   (实测 cand_scans 仅 141 万 @ drivers),而是逐边常数(端点 clone×2、全串
   lowercase、逐候选 Vec 分配)在换页压力下放大。修:Cow 借用 + infer_language
   记忆化 + 三处评分零分配 + 分段计时/计数器。**drivers(12.6M 边)cross-file
   36.9s,回归线性;全内核外推 ~50s(原 1268s)**
2. ~~M5 coupling 超线性~~ → 已修复(借用化 + rayon)。注:drivers 旧代码实测仅
   3.1s,内核 197s 主要是换页抖动;常数砍量级后换页敏感性同步下降
3. ~~M6 flows 字符串克隆~~ → 已修复(借用化,同 M2 模式)
4. **M7 db-save 规模墙(新发现,drivers 实测 1247.8s 为全程最大单块)**:
   - MemoryIndex::from_existing_graph 353s(fs 3.2s)——intern+桶排序在大边数下劣化
   - bulk_replace_all 885.6s:edges 插入 228s(21k 行/s)、索引重建 242.5s、
     commit 292s(数 GB WAL fsync)、nodes 94s、fts 28s
   - 候选方向(需设计决策):prepared statement 复用+边有序插入(小修);
     图大时改快照式持久化(跳过 SQLite 全量重写,架构级);增量保存
5. 修完 M7 再重跑全内核验证;R0~R10 架构主线在此之后排期
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
