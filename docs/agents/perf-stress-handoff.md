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

## 下一步建议

1. ~~DB Save 调查~~ → 已完成(见上"第二轮优化"),35s vs 52s 噪声结论:52s 是真实值
2. ~~Snippet Extract~~ → 已完成
3. ~~内存 interning 全量重构~~ → **已否决**(String→u32 波及 ~35 文件/上千访问点,性价比不成立);
   替代方案见 `docs/plans/graph-id-refactor-plan.md`:M1~M3 内存救场(merger 索引 interning、
   community 去克隆、parse_cache 门控)+ R0~R10 newtype 分阶段主线,全部按 Agent 可派发批次设计
4. (可选)bulk_replace 余量:prepared statement 复用 + 边有序插入,预计 18s→12s 量级
