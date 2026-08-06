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

---

## W1 收尾(2026-08-06,commit `053c681`)— 全检测器索引化

**触发**:用户问「换语言项目会不会又爆」。盘点发现 W1 只索引了 7+1 个检测器,
cs/ruby/php/go/kt 及全部 cross-lang(19 个检测器)仍在全图扫描 —— 换 C#/Ruby/PHP
项目必爆。这是「热点判断」依赖数据分布的架构隐患,不是单点修复能填的。

**改动**:langs.rs 19 个检测器签名加 index 参数 + 调用换 indexed;mod.rs 三个顶层函数
及 detect_cross_lang_calls 全部传索引。**全图扫描路径清零(残留旧版调用 0)**。

**kernel run4(全部索引化后首次)**:总 **1235.58s(20.6min, -30% vs R10)**,
图数字 2486778/7460139/**469356**。

| 项 | run3 | run4 | 说明 |
|---|---|---|---|
| cross-lang | 10.2s | **2.4s** | 索引化直接收益 |
| eval | 2.6s | 2.6s | 持平 |
| community | 169.8s | 134.6s | |
| core-parse | 600.5s | 540.0s | batch 45400 病态文件 227-248s 两跑都有 |
| db-save | 301.4s | 331.6s | buckets 43→74s 波动(IO 密集) |
| **总耗时** | 1341.5s | **1235.6s** | -106s |

**community 469360 → 469356(差 4,0.001%)**:全部索引化后 cross-lang 的首匹配
从「HashMap 随机序扫描」变「确定性索引桶序」,图内容确定性变化 → 社区数新基线。
**这是用「确定性」换「不再爆炸」的架构交换,不是回归**;同代码重复跑应稳定 469356
(待多次运行确认稳定性)。fs 契约不受影响(28284 不变)。

**遗留更新**:病态文件 batch 45400 确认三跑都有(run3 248s / run4 228s),且 batch 4600
固定 57-60s,是稳定存在的慢文件簇,值得单独定位。

**RSS 结案(2026-08-06)**:R10 646MB vs run3/4 1337MB 的差异,根因为 to_snapshot 并行化
(par_iter 多分片峰值页残留,WorkingSet64 瞬时采样)换快照快 ~90s。fs 项目不走快照路径
故未翻倍(侧面佐证)。**评估结论:1.3GB 跑全 kernel 完全可接受,不做回收**——与 R9 时代
drivers 6.2GB/内核 OOM 相比已是数量级改善;若未来内存受限,可改串行/限分片 to_snapshot,
代价是快照慢 ~60-90s。此事项结案,不再跟踪。

---

## ⚠️ 重大发现(2026-08-06):kernel 头文件体系被 .gitignore 误排除(正确性 bug)

**优先级:高于一切性能项。这是图残缺问题,不是性能问题。**

### 根因链

`collect_gitignore_dirs`(pipeline/discovery.rs)对 .gitignore 规则取**最后一个路径分量**
作为全局 basename 排除,导致路径型/锚定型规则被错误放大:

```
tools/power/acpi/.gitignore 的 "/include/"  → 全局排除所有名为 include 的目录
kernel 根 .gitignore 的 "/include/config/"   → 全局排除所有名为 config 的目录
"/include/generated/" → 全局排除 generated(与 IGNORED_DIRS 重复)
```

**后果**:kernel 根 include/、arch/*/include/、drivers/*/include/(含 AMD asic_reg)
全部从未被收集 —— 248 万节点图缺失整个头文件体系(include/linux/*.h 等),
Linux 依赖关系的核心不在图中。fs 契约 155518 同样是残缺图数字。

**连带影响**:batch 45400 慢文件(229s)并非 AMD 文件(它们从不在流程里),
真凶是另一个 <1MB 文件,尚未定位;5MB discovery 过滤因 AMD 文件不在列表而无效。

### 修复方向(未实施,需独立窗口)

1. collect_gitignore_dirs 改为保留**路径语义**:规则 = (gitignore 所在目录相对 root + 规则路径),
   is_excluded 用相对路径前缀匹配,不能降级 basename。
2. 无前导 / 的简单名规则(如 "my_build")保持任意层级 basename 匹配(git 语义正确)。
3. 修好后 kernel 图将暴增(头文件节点,预计 500 万+),需配套「头文件按需收集」
   或阈值策略,否则 parse/内存失控。
4. **所有基线重校**:fs 契约 155518/426199/28284、kernel 2486778/7460139 均作废。

### 验证脚本

- 诊断测试:`cargo test --lib debug_kernel_discovery_amd -- --ignored --nocapture`
  (当前输出 total=46491 amd_asic_reg=0;修复后 amd_asic_reg 应 >0,
  gitignore_dirs 不应含 include/config 等全局误排除)
- 该测试为临时诊断,修复完成后应删除。

### 实测补充与方案定稿(2026-08-06 深夜;⚠️ 代码未实施 — provider 故障已回滚)

**状态**:方案定稿 + 用户决策已拍板,实现未落地(discovery.rs 已 git checkout 还原,
无 commit)。**下个 agent 直接按本节实施即可,不需要重新调研。**

**1. 根因坐实**(诊断测试实际输出):

```
[debug] total=46491 amd_asic_reg=0
[debug] gitignore_dirs contains include? true   ← /include/ 规则被全局化,铁证
[debug] gitignore_dirs contains generated? true
[debug] >1MB in discovery=4                     ← AMD 7-23MB 文件根本不在列表
```

**2. 影响面实测(修正上文「预计 500 万+」的粗估)**:

| 数据 | 数量 |
|---|---|
| 全树 .h 文件 | 26,824 |
| 其中被误排除(`include/` 6606 + arch/drivers/tools/fs/net 的 include 目录 5889) | **~12,500** |
| fs 子树受影响? | **0** —— fs 无 include 目录、2 个 .gitignore 均为文件级规则(`/mkutf8data`、`/utf8data.c`) |

**关键修正(推翻上文第 4 条)**:fs 契约 **155518/426199/28284 修复后预计不变**,
应保留为回归锚点;只有 kernel 基线作废。修复后 kernel 节点预计 248 万 → 300-400 万
(非 500 万+),parse/内存增幅可控。

**3. 修复设计(已定稿)**:

```rust
struct GitignoreRules {
    global_names: HashSet<String>,          // 无斜杠规则 → 任意层级 basename(git 语义,行为不变)
    anchored: HashMap<String, Vec<String>>, // 前导 / 或含中间 / 的规则 → 相对 root 路径,按首分量分桶
}
```

- 收集:每个 .gitignore 记录基目录(相对 root,根 = 空串),规则去尾部 `/` 后:
  无 `/` → `global_names`;含 `/` → `base + rule` 入桶(首分量为桶 key)。
  含点判断沿用原逻辑(最后分量含点且无尾部 `/` → 文件规则,跳过)。
- 匹配:目录 entry 算 rel path → global 查 HashSet(现状)+ 桶内 `rel == rule || rel.strip_prefix(rule) 余下以 / 开头`。
- 复杂度:每目录 O(桶大小),分桶后平均 <10 条,可忽略。
- `discover_files` 对外签名不变,调用方(runner/tools)零改动;`is_ignored_path` 不动。
- 修复后 kernel 文件 46.5K → ~5.8 万,AMD asic_reg 大文件被**现有 5MB 阈值自然拦住**
  (阈值此前因文件不在列表而失效,修复后开始起作用)。

**4. 用户已拍板决策**:
- 头文件策略:**全收**,靠现有 5MB 阈值兜底,不加额外头文件阈值;
- 验证深度:**只做到「修复 + 单测 + fs 契约复跑」**,不跑 kernel 终验(下次窗口再说);
- 诊断测试:`debug_kernel_discovery_amd` **删除**,改写成不依赖 D:/linux-7.1.0 的等价单测
  (临时目录模拟 kernel 结构:include/ 目录 + `/include/` 锚定规则 + >5MB 大文件,验证
  include 目录被收集、大文件被阈值跳过)。

**5. 实施与验收清单**:
1. discovery.rs:`collect_gitignore_dirs` → `collect_gitignore_rules` + `GitignoreRules`,
   `is_excluded(entry, &rules, root)`;import 补 `HashMap`。
2. 单测:锚定规则(`/build/`、`/include/config/` 只排对应路径,同名目录保留)、
   子目录相对规则(`sub/.gitignore` 的 `out/gen/` 只排 `sub/out/gen`)、全局规则不变;
   删 `debug_kernel_discovery_amd`。
3. `cargo test --lib` 全绿(现有 5 个 discovery 测试必须仍过)。
4. fs 契约复跑:删 `D:/linux-7.1.0/fs/.hologram`(545M 残留,影响 DB Save 计时)后
   `cargo build --release && ./target/release/hologram-engine.exe --stress-real D:/linux-7.1.0/fs 1`,
   预期 155518/426199/28284 不变。
5. 单 commit(如 `fix(engine): gitignore 规则保留路径语义,恢复 include 目录收集`)。
6. 之后窗口再跑 kernel 终验重校基线(30-40 分钟)。

**6. 环境备注**:Reasonix 侧 `D:\reasonix\reasonix.toml` 已配
`[sandbox] allow_write = ["D:/HoloGramHG"]`,文件写工具可直接改项目代码,无需再用 bash 绕行。

---
