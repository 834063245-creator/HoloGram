# Graph ID 抽象重构 — Agent 分批施工方案

> 2026-08-06 · 缘起:全内核规模评估(docs/agents/perf-stress-handoff.md)发现 String ID 全仓耦合
> (~35 文件/上千访问点)。本方案是给 Agent 直接派发用的作战地图,不是人类阅读版路线图。
> 每批:边界清晰、可独立验收、行为零变化(除 M 阶段)、单 commit 可 revert。

## 数字契约(每批完成后必须成立)

```
cargo test --lib                     # 569+ 全绿,只增不减
fs 子树压测(D:/linux-7.1.0/fs):     # M 阶段每步、R10 后必跑;R 阶段中间批可免
  155518 nodes / 426199 edges / 28284 communities   # 图数字一个不许变
  总耗时基线 ~48s                                     # 劣化 >10% 视为回归
```

## 总序

```
M1 → M2 → M3 → [全内核验证] → R0 → R1~R7(可并行)→ R8 → R9 → R10
└─ 救场:16GB 跑全内核 ─┘   └────────── 架构主线:newtype 化 ──────────┘
```

M 与 R 正交(M 改算法级临时结构,R 改 ID 表示),M 必须先做——架构重构不自动
消除临时结构,且全内核是当下硬需求。R 阶段任何时刻可暂停,仓始终处于可发布态。

---

## Phase M — 内存救场(3 批,串行,约 2~3 天)

### M1 merger 索引 interning 化
- **改**:`engine/src/graph/merge.rs` 一个文件
- **现状**:`edge_index: HashSet<(String,String,u8)>`(merge.rs:30,9M 边第二份字符串克隆,
  ~2.0GB @ 62% 解析点);`loc_index: HashMap<String,String>`(merge.rs:26,~0.35GB)
- **做法**:merger 内部挂一个局部 StringArena(复用 `storage/string_arena.rs`),
  `edge_index` 改 `HashSet<(u32,u32,u8)>`,`loc_index` 改 `HashMap<u32,u32>`。
  merge 完成后 arena 随 merger drop,不影响下游任何类型。
- **验收**:数字契约全项;全内核压测 62% 点 RSS 7.3GB → 预期 ~5GB
- **禁止**:改 Graph/MemoryIndex 公共类型;改 merge 语义(去重判定必须逐位等价)

### M2 community leaf_edges 去克隆
- **改**:`engine/src/community/louvain.rs`(+ 调用方签名适配,限 pipeline.rs 社区段)
- **现状**:louvain.rs:741-743 `leaf_edges: Vec<(String,String)>` 克隆全部边端点
  (14M 边 ≈ 2.3GB 瞬时);`detect_hierarchical_from_base` 内部 edge_pairs/sorted_edges 同理
- **做法**:build_adjacency 已产 `owned_ids: Vec<String>` + usize 邻接——leaf_edges
  改传 `(u32,u32)` 索引对,字符串只在最终写回 community_id 时按索引查一次。
- **验收**:数字契约全项(社区数 28284 不变是关键)

### M3 parse_cache 预算门控
- **改**:`engine/src/pipeline/runner.rs`、`engine/src/engine/pipeline.rs`
- **现状**:全部源码常驻到 snippet 阶段(pipeline.rs:285 才 clear);全内核 ~1.5GB
- **做法**:runner 累计缓存字节数,超预算(默认 512MB,env 可调)则后续文件不缓存,
  只记路径。所有 parse_cache 消费点(bridge_rpc.rs:67、di_reflection/mod.rs:72、
  dynamic_dispatch_vue.rs:37、snippet 阶段等)走统一的 `get_source(path)` 助手:
  命中返回缓存,miss 则 fs::read_to_string 盘读。先盘点全部消费点(miss 时各自
  现在是什么行为,保持等价)。
- **验收**:数字契约全项;加一个小预算单元测试(超限后 miss 路径结果与缓存一致)

### M 阶段毕业标准(2026-08-06 实测结论)

~~16GB 机器全内核压测跑完不 OOM~~ → **内存目标达成**:全程 ~65 分钟 RSS 8.6~10.5GB,
看门狗未动,最终被 1h 任务超时终止于 community 阶段(非内存原因)。
但暴露三个算法级超线性(fs 规模隐身):**M4 resolver(1268s,指数~2.3)、
M5 coupling(197s,1035×)、M6 flows 字符串克隆(已知未修)**。
M4~M6 已插入总序,先于 R 阶段执行——全内核「能跑」但「跑不完」就没有实用价值。
详见 docs/agents/perf-stress-handoff.md 第三轮优化节。

---

## Phase R — newtype 主线(架构重构)

### R0 newtype 与访问器引入(纯新增,零风险)
- **改**:`engine/src/graph/`(新增 id.rs;graph.rs 只加方法不改字段)
- **做法**:
  ```rust
  pub struct NodeId(String);   // 内部表示本阶段不换,只建抽象
  pub struct EdgeId(String);
  ```
  给 Graph 加:`iter_nodes()` / `iter_edges()` / `get_node(&NodeId)` /
  `node_by_idx` 等访问器;给 Node 加语义访问器 `file()` / `module()` /
  `short_name()`(封装点分拆解析,替代各处的 `rfind('.')` 手撕)。
- **验收**:`cargo test --lib` 绿;为零行为变化,不跑压测
- **禁止**:改任何消费方;改 Graph 现有 pub 字段

### R1~R7 逐模块迁移消费点(可 AgentSwarm 并行,批间文件集互斥)

每批同一指令模板:**把批内对 `graph.nodes`/`graph.edges` 的直接访问和
`node.id`/`edge.source`/`edge.target` 的裸 String 操作,迁移到 R0 的 newtype +
访问器;ID 语义解析(rfind('.')、split、拼接 key)一律改用语义访问器;
不改任何行为,不加新功能。**

| 批 | 文件集 | 访问点规模 |
|---|---|---|
| R1 | `engine/src/adapter/`(18 语言) | .source/.target ~108 |
| R2 | `engine/src/graph/resolver.rs` | API 108 + .source/.target 44 |
| R3 | `engine/src/analysis/di_reflection/`、`dynamic_dispatch*.rs`、`bridge_rpc.rs` | ~120 |
| R4 | `engine/src/analysis/`(flows、framework_routes、coupling、explore 等其余) | ~80 |
| R5 | `engine/src/community/`、`engine/src/routing/` | ~45 |
| R6 | `engine/src/storage/`、`engine/src/tools/handlers.rs` | ~70 |
| R7 | `engine/src/main.rs`、`engine/src/mcp.rs`、`engine/src/engine/` 其余 | ~60 |

- **互斥约定**:每批只许动自己文件集;发现必须改 graph.rs 才能继续时,
  在交接里记录缺口,留给 R8 统一处理,不越界改。
- **验收(每批)**:`cargo test --lib` 绿 + 批内 grep 自检:`graph.nodes`/
  `graph.edges` 直接访问清零。
- **派发方式**:AgentSwarm,R1~R7 七个 item 同模板并行;全部完成后统一
  跑一次压测数字契约再进 R8。

### R8 Graph 字段私有化 + 缺口收口
- **改**:`engine/src/graph/graph.rs` + R1~R7 记录的缺口
- **做法**:`nodes`/`edges` 改 pub(crate) 或全私有,编译器把漏网点全部指出来,
  逐个收口。处理 `meta`、`from_json_file`、`diff`、`outgoing_edges/incoming_edges`
  这些被 main.rs/handlers 依赖的残留公共面(保留为方法,签名用 newtype)。
- **验收**:数字契约全项

### R9 serde/存储边界定型
- **改**:`engine/src/storage/sqlite.rs`、`engine/src/storage/memory.rs`、JSON 落盘路径
- **做法**:定义 newtype 的 serde 表现=纯字符串(磁盘格式与线格式零变化,
  hologram.db 不需要迁移);MemoryIndex 与 Graph 的 ID 转换收口为单一入口。
- **验收**:数字契约全项;加一个旧库冷启动兼容测试(用现网 hologram.db fixture)

### R10 内部表示换 u32 + arena(可选,最后才做)
- **前提**:R0~R9 完成,所有消费点只依赖 newtype API
- **改**:原则上只动 `engine/src/graph/` 内部;若仍有渗漏,说明 R8 没收干净,回头补
- **做法**:NodeId 内部 String→u32,Graph 容器 Vec/IndexMap 化,arena 入 Graph。
  参考 MemoryIndex 的 StringArena 既有实现。
- **验收**:数字契约全项 + 全内核压测,RSS 与耗时写入交接文档

---

## 派发与执行规则

1. **一批一 commit**,commit message 格式 `refactor(engine): [批号] 内容` — 每批可独立 revert。
2. 每批交接里写清:改动文件、grep 自检结果、测试输出尾行、数字契约是否跑过。
3. R1~R7 并行派发时,任何批不得修改批外文件;冲突缺口记录不修补。
4. 压测跑法见 docs/agents/perf-stress-handoff.md「压测工具用法」节;
   全内核必须带看门狗(RSS>12GB 或剩余<2GB 自动停)。
5. 本方案任何一批做完,仓都处于可发布状态——这是与人类分阶段的核心区别:
   停在哪一批都不是半成品。
