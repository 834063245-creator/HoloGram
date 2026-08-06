# W 阶段交接 — R10 后的时间墙攻坚

> 2026-08-06 · 本窗口因工具调用截断无法继续大段编辑,新窗口接手的作战文档。

## 现状(R10-deep 已竣工并验证)

commit 链:`66b3698`(id.rs 全局驻留器)· `8d717e9`(Node/Edge 全量句柄化)· `88149e0`(分段计时)· `0a4ae8b`/`4f180d1`/`8b460b6`(文档)。

**drivers 压测**:总 778.2s→667.8s(-14%),RSS 6.2GB→964MB(-84%),图数字 1859750/4846727/384653 与 R9 一致。
**全内核终审**(stress-real-linux-kernel-r10.txt):**1770.5s(29.5min)全程跑完,RSS 646MB**;
R9 时代 1 小时超时死在 community。图数字 2486778/7460139/469360。
fs 契约三次全绿,607 测试,0 warning。

## 三座墙(kernel 实测拆分)

| 墙 | 耗时 | 占比 | 分账 |
|---|---|---|---|
| **W1 eval** | **304.5s** | 17% | drivers 仅 0.7s → 超线性 435×(528 markers) |
| **W2 db-save** | 564.0s | 32% | from_existing_graph ~311s(intern 244s+buckets 65s+sort 0.5s+flatten 1.2s)+ 快照 ~253s |
| **W3 community** | 218.3s | 12% | adjacency ×2 59s + local-moving ×2 92s + leiden step3 K² 34s + hierarchy 29s |

## W1 eval 305s — 根因已定位,修复方案完整

**根因**:`di_reflection/mod.rs::find_or_create_di_node`(约 249 行)每次调用最多做 **4 次全图 O(N) 扫描**
(2 精确匹配 + 2 末尾组件匹配,各分同语言/不限语言)。kernel 2.49M 节点 × ~500 次调用(eval 528 markers
每 marker 建 src+tgt)→ 数亿次节点迭代,每次还带 `infer_language(id)` 字符串判定。正是 handoff 教训#1
「对集合 A 每个元素全扫集合 B」的同一根型;fc551ef 曾以为「百次级,暂不疼」,但节点数 18 万→249 万,不疼变 305s。

**修复(已设计定稿,未落地)**:
1. mod.rs 加 `type NameIndex = HashMap<String, Vec<NodeId>>` + `build_name_index(graph)`(遍历
   `graph.nodes_iter()` 一次,桶内保持遍历序 → 与旧全图扫描的首匹配语义完全一致)。
2. `find_or_create_di_node(graph, index: &mut NameIndex, name, file, line)`:精确匹配和末尾组件匹配
   都改 `index.get(name)` / `index.get(last_part)` → 遍历候选 `cands`(同名节点数,通常 0-3),保留
   同语言优先;创建占位节点后 `index.entry(name).or_default().push(node.id)` 保持索引同步。
3. 线程化:mod.rs 三个顶层函数 detect_di_reflection / detect_dynamic_imports / detect_eval 各建一次索引,
   传给 langs.rs 7 个用 find_or_create_di_node 的检测器(detect_python_reflection、detect_java_di、
   detect_ts_di、detect_python_dynamic_import、detect_js_ts_dynamic_import、detect_python_eval、
   detect_js_ts_eval),其余检测器(cs/ruby/php/go/kt/rust 等)签名不动。
4. 检测器只 `add_edge_unchecked` 不直接 `add_node`,所以索引只在 find_or_create 创建时更新即保持一致。

**注意(工具截断坑)**:本窗口直接 Edit/Write 大段含反斜杠内容会触发「tool input truncated」;新窗口若复现,
用 **Write 小内容 + Edit 逐段追加**、或 `echo '...' >> file` 逐行追加可靠。eval 内部未加计时器
(本次只给 louvain/mem-idx 加了),若想先确认再改可在 detect_eval 加分段计时;before 值已知(304.5s)。

**验收**:cargo test --lib 绿 + fs 契约不变 + 全内核重跑 eval 应从 304.5s 大幅下降(预期 <10s)。

## W2 db-save 564s — 数据与方向

- **from_existing_graph intern 244s**:MemoryIndex 有自己的 StringArena(为快照序列化),from_existing_graph
  拿到 u32 句柄图后仍把 node.id/edge.source/target **重新驻留进自己的 arena**(每个字符串重新哈希)。
  方向:让 MemoryIndex 复用全局驻留器的句柄(MemoryIndex 已是 u32 句柄 + arena 结构,可在 from_existing_graph
  里直接传全局句柄而非重新 intern),或懒驻留。这是最大单块,砍掉可省 ~200s。
- **buckets 65s**:每节点一个 Vec 的建桶,11M 边逐条 push。方向:按度预留容量/双缓冲,或改单 Vec + 偏移。
- **快照 ~253s**:bincode 序列化 2.4GB MemoryIndex 全量。方向:待查(可能与 arena 字符串表序列化有关)。

## W3 community 218s — 数据与方向

- **build_adjacency ×2 59s**:detect_communities + detect_communities_louvain 各建一次字符串邻接,
  pipeline.rs:324 的 detect_communities_and_hierarchy 里冗余。方向:复用一次构建;R10-deep 后句柄可直通
  (build_adjacency_from_index 已存在,但 pipeline 走 graph 路径)。
- **local-moving ×2 92s**:两次 louvain 核心各 46s。方向:detect_communities 内部已含 louvain,
  detect_communities_and_hierarchy 又单独调 detect_communities_louvain,可复用第一次的 local-moving 结果。
- **leiden step3 K² 34s**:`vec![0.0; p1_count]` 每个子社区全量归零(drivers 22s,kernel 34s,超线性)。
  方向:sparse accumulator(touched-list + epoch 数组,同 local_moving 的 weight_buf 模式)。

## 整体策略

优先级建议:W1(eval 超线性,根因明确,收益 305s→<10s)> W2-intern(~200s)> W3(零散,但 local-moving ×2
复用 + step3 稀疏化各省 ~50-90s)。每改一批跑 fs 契约(快,~37s)保正确;kernel 终验(29.5min)只在批量完成后跑。

---

## W 阶段竣工(2026-08-06,commit `c243d76`)

三座墙全部落地。cargo test 609 绿(fs 契约全绿),kernel 终验(run3):**1341.5s(22.4min, -24.2%)**,
图数字 **2486778/7460139/469360 与 R10 逐位一致**。

### 实测对账(kernel)

| 阶段 | R10 | 竣工 | 收益 | 对应改动 |
|---|---|---|---|---|
| Eval Detection | 304.5s | **2.6s** | -302s | W1 NameIndex(含 rust_eval) |
| Community (Leiden) | 218.3s | **169.8s** | -49s | W3(step3 34→9s) |
| DB Save | 564.0s | **301.4s** | -263s | W2(memory build 311→61s, snapshot 237→173s) |
| **总耗时** | **1770.5s** | **1341.5s** | **-429s** | RSS 1339MB(见遗留) |

### 文档原方案的偏差与实战修正(重要)

1. **W1 热点语言判断错误**:文档假设 eval 热点在 py/js,实际 kernel 528 markers 大头在
   **detect_rust_eval**(kernel 有 473 个 .rs 文件、0 个 js/ts;rust/ 362 + drivers 87)。第一次终验
   eval 350.9s 未降,补上 rust_eval 索引后才归零。**教训:超线性根因要先确认热点调用点语言分布**。
2. **W2 句柄直通牵连快照协议**:MemoryIndex 句柄统一到全局驻留器后,快照字符串表从稠密 `Vec<String>`
   改 **(u32,String) 句柄对 + version 字段**(v2);读回时 `intern_with_handle` 按写入句柄精确重建
   (全局驻留器支持稀疏槽,句柄 0 = 空哨兵)。旧 v1 快照按损坏回退 SQLite(既有机制)。
3. **StringArena 全局化引入锁回归**:GraphMerger 用 StringArena(改全局驻留后),解析期并行 merge
   全走全局 RwLock 抢锁 → core-parse 432→539s。修复:GraphMerger 改本地无锁 `LocalIntern`
   (句柄只做去重 key,无需全局一致)。**教训:共享驻留器只给真正需要跨实例共享的消费者**。
4. **community 差 3 真相**:run2 曾 469357,补 rust_eval 索引后 run3 回到 469360(R10 一致)。
   super 数仍波动(40814/41089/40927),与 flows 285-329 同类 HashMap 迭代序噪声,不在契约内。
5. **fs 契约耗时波动**:删预驻留 + buckets 预留 + 快照并行化后 fs DB Save 32.7→23.4s;但带残留
   快照状态时回到 32s(init 读快照 + SQLite 全量双路径),测前应清 .hologram。

### 遗留问题(下一窗口候选)

1. **batch 45400 病态文件**:tree-sitter 解析某文件 200s+(R10 同文件 223s,run3 248s),core-parse
   波动主因(432/539/600 三跑不同)。独立性能问题,不在三座墙范围,值得单独定位是哪个文件。
2. **RSS 翻倍**:646MB(R10) → 1339MB(run3)。可能是快照峰值口径差异或全局驻留累积,待观察。
3. **super 数波动**:HashMap 迭代序噪声,已知问题。
4. **cross-lang 6.9s/10.2s**:detect_cross_lang_calls 仍走旧版全图扫描(28 markers,非大头),
   若 kernel 继续扩大可考虑接入索引。

### 验证脚本与文件

- 终验报告:`test-results/stress-real-linux-kernel-w11-run3.txt`(stdout+stderr 分离捕获)
- 长任务监控:Start-Process 落文件 + subagent 盯梢回传(本会话验证可行,不再依赖 tty transcript)
- 快照 token 校验:`{nodes}:{edges}:{millis}` 读文件头 8B 长度 + token,可离线验证图数字
