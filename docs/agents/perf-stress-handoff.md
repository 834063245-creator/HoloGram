# 性能压测与优化交接 — 2026-08-06

> 背景:一次完整的压测驱动优化会话。引擎全量分析在 Reasonix 上 457.7s → 16.6s(27.6×),
> 内核 fs 子树 128.8s → 91.0s。本文档记录已完成的修复、当前瓶颈和下一步。

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

## 当前瓶颈(fs 子树 91.0s 内,按优先级)

| 阶段 | 耗时 | 占比 | 备注 |
|---|---|---|---|
| **DB Save** | 52.3s | 57% | **下一个目标,未调查**。疑点:同代码两轮跑出 35.2s 和 52.3s,先排除噪声再定位。嫌疑方向:FTS 触发器、逐行 INSERT、snippet 文本写入 |
| Snippet Extract | 17.9s | 20% | 15.5 万个节点逐个切片源码,轻度超线性 |
| Core Parse | 9.0s | 10% | 2169 文件,~240 文件/s,健康 |
| Community | 8.4s | 9% | 155k 节点hold住 |

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

1. **DB Save 调查**:先连跑两轮确认 35s vs 52s 哪个是真实值;profile sqlite.rs 的写入路径(FTS 触发器、事务粒度、prepared statement 复用)
2. Snippet Extract:看是否逐节点重复读文件/重复切片
3. 决定是否启动内存 interning 重构(全内核规模的入场券)
