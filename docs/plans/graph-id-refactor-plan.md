# Graph ID 抽象重构 — R 阶段完整实现规格(供接手模型直接施工)

> 2026-08-06 v2 · 本文档是 R0~R10 的**实现规格书**,不是路线图。
> 设计决策已全部钉死,施工者不需要做架构判断,只做机械化落地+逐批验收。
> 背景与实测依据:docs/agents/perf-stress-handoff.md(第三/四轮优化节)。

> **施工进度(2026-08-06):R0~R9 已竣工并逐批提交,全部验收绿。**
> R0 `3049e7d` · R1 空批(adapter 为生产侧,无消费点) · R2 `c412c13` · R3 `bab1f9a` ·
> R4 `b09238b` · R5 `dc0a364` · R6 `5c7280c` · R7 `90221ef` · R8 `9b55c8c` · R9 `cca3e4e`。
> R1~R7 后 fs 契约:155518/426199/28284,resolved 271321,~35s;R8 后复跑同绿(36.5s)。
> R9 后 fs 契约同绿(35.6s,走 SQLite 旧路);drivers 压测(阈值 4M 强制快照):
> 快照写入 56.3s(2.44GB,<60s 达标,原 bulk 885.6s),总耗时 1697.6s → 778.2s。
> 剩余:R10-deep 已竣工(`66b3698`/`8d717e9`/`88149e0`,规格「容器 u32」修正为「全量句柄化」,
> 见 handoff「R10-deep 竣工」节)。R10 后全内核瓶颈:from_existing_graph intern 98s、
> community local-moving 74s(两次)、build_adjacency 27s(两次)、leiden K² 22s(超线性)。
> R8/R9 实施记录与偏离说明见 perf-stress-handoff.md「R 阶段进度」节。

## 0. 施工前必读(现状与硬约束)

**已完成前提(M 系列,全部已提交)**:M1 merger interning、M2 community 去克隆、
M3 parse_cache 门控、M4 resolver 超线性修复、M5 coupling 借用+并行、M6 flows 借用化。
全内核(51k 文件/17M 边)65 分钟无 OOM(RSS 8.6~10.5GB);drivers(12.6M 边)
完整跑完 1697s,瓶颈现为 db-save(M7c 在 R9 解决)。

**数字契约(每批完成后必须成立,违者 revert)**:
```
cargo test --lib                     # 570+ 全绿,只增不减
cd engine && cargo build --release
./target/release/hologram-engine.exe --stress-real D:/linux-7.1.0/fs 1
  → 155518 nodes / 426199 edges / 28284 communities   # 一个不许变
  → cross-file resolved = 271321                       # 解析语义不许变
  → 总耗时基线 ~48s,劣化 >10% 视为回归
  注: flows 数量 285-329 波动是已知噪声(resolver HashMap 迭代序),不作契约
```
中间规模验证(必要时):`--stress-real D:/linux-7.1.0/drivers 1`(~28 分钟,
做完 M7c/R10 必跑)。全内核验证只在 R10 后跑,必须带看门狗
(RSS>12GB 或剩余<2GB 自动停,跑法见 handoff 文档)。

**施工纪律**:
1. 一批一 commit,message 格式 `refactor(engine): [批号] 内容`,可独立 revert。
2. 本仓可能有其他 Agent/工具并行工作:改文件前先 `git status`,发现他人改动
   不要覆盖;自己的半成品被 stash 不要慌,内容用 Edit 工具重放即可恢复。
3. Windows + Git Bash 环境;cargo 命令都在 `engine/` 目录下执行。
4. 每批交接写清:改动文件、验证命令输出尾行、数字契约是否跑过。
5. **任何一批做完仓都处于可发布状态** —— 这是分批的核心意义。

---

## R0 newtype 与访问器引入(纯新增,零行为变化)

**改**:`engine/src/graph/`(新增 `id.rs`;`graph.rs`、`node.rs` 只加不改;
`graph/mod.rs` 加 re-export)。**禁止**:改任何消费方;改现有 pub 字段;改 serde 表现。

### id.rs 完整规格

```rust
// engine/src/graph/id.rs
use serde::{Deserialize, Serialize};

/// 节点 ID 的强类型句柄。R0~R9 内部为 String;R10 起 Graph 容器与热路径
/// 索引 u32 化,但 NodeId 本身**永远保持字符串句柄**——
/// 这保证 as_str() 签名全程稳定,消费方零感知。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]   // 序列化表现 = 纯字符串,磁盘/线格式零漂移
pub struct NodeId(String);

/// 边 ID 的强类型句柄。设计同 NodeId。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EdgeId(String);

macro_rules! impl_id {
    ($T:ident) => {
        impl $T {
            pub fn new(s: impl Into<String>) -> Self { Self(s.into()) }
            pub fn as_str(&self) -> &str { &self.0 }
            pub fn into_string(self) -> String { self.0 }
        }
        impl std::fmt::Display for $T {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl From<String> for $T { fn from(s: String) -> Self { Self(s) } }
        impl From<&str> for $T { fn from(s: &str) -> Self { Self(s.to_string()) } }
        impl AsRef<str> for $T { fn as_ref(&self) -> &str { &self.0 } }
        impl std::borrow::Borrow<str> for $T { fn borrow(&self) -> &str { &self.0 } }
    };
}
impl_id!(NodeId);
impl_id!(EdgeId);
```

**设计说明(施工者勿改)**:
- **不实现 `Deref<Target=str>`** —— 防止消费方绕过语义访问器继续做字符串手术;
  需要字符串就显式 `.as_str()`。
- `Borrow<str>` 让 `HashMap<NodeId, _>.get(name: &str)` 可用,迁移期关键。
- `serde(transparent)` 是 R9 的预埋:磁盘格式从第一天就是纯字符串。

### graph.rs 新增访问器(只加不改)

```rust
// 迭代器 —— 替代消费方直接访问 pub 字段。
// 当前容器仍是 HashMap<String, _>,故 yield &str;R8 换容器后签名不变。
pub fn nodes_iter(&self) -> impl Iterator<Item = (&str, &Node)> {
    self.nodes.iter().map(|(k, v)| (k.as_str(), v))
}
pub fn edges_iter(&self) -> impl Iterator<Item = (&str, &Edge)> {
    self.edges.iter().map(|(k, v)| (k.as_str(), v))
}
pub fn node_ids(&self) -> impl Iterator<Item = &str> {
    self.nodes.keys().map(|k| k.as_str())
}
pub fn edge_ids(&self) -> impl Iterator<Item = &str> {
    self.edges.keys().map(|k| k.as_str())
}
// get_node/get_edge/remove_node/remove_edge/add_node/add_edge* 已存在,不动
```

### node.rs 语义访问器(收口全仓的 ID 手撕解析)

```rust
impl Node {
    /// 所属文件路径(不含行号)。来自 location,无 location 返回 None。
    /// 语义 = flows.rs strip_line_suffix(统一搬到这里):
    /// 去掉末尾 ":行号" 段(处理 Windows 盘符,只剥纯数字后缀)。
    pub fn file(&self) -> Option<&str>;

    /// 短名 —— id 的最后一段,但若该段是已知代码扩展名则再往前取一段。
    /// 语义 = resolver.rs 的 short_name(原样搬入,含 is_common_extension 逻辑,
    /// 扩展名表复用 code_extension_set())。
    pub fn short_name(&self) -> &str;

    /// 模块路径 —— id 去掉最后一段。无 '.' 时返回整个 id。
    pub fn module(&self) -> &str;
}
```

**搬迁清单(语义源头,施工时逐个核对等价性)**:
- `resolver.rs:320-346` short_name/file_stem(扩展名感知)
- `flows.rs:25-33` strip_line_suffix(行号剥离)
- `merge.rs` node_key_parts(location 或 id 兜底规则)
- 消费方迁移在 R1~R7 进行,R0 只建访问器,不动消费方。

**验收**:`cargo test --lib` 绿(含为三个访问器各加 2-3 个边界用例:
带点 id、无点 id、Windows 盘符 location、无 location)。零行为变化,不跑压测。

---

## R1~R7 逐模块迁移消费点(AgentSwarm 并行,批间文件集互斥)

### 统一指令模板(每批原样下发)

```
把批内文件对 graph.nodes / graph.edges 的直接字段访问,迁移到 R0 访问器:
- for (k, v) in &graph.nodes        → for (k, v) in graph.nodes_iter()
- graph.nodes.get(&id)              → graph.get_node(&id)   (已存在)
- graph.nodes.contains_key(&id)     → graph.get_node(&id).is_some()
- graph.edges.get(&id) / 同理       → graph.get_edge(&id) / 同理
- node.id / edge.source 的语义解析(rfind('.')、rsplit、split('.').count()、
  strip_line_suffix、short_name 等) → node.file() / node.short_name() / node.module()
铁律:不改任何行为、不加新功能、不改批外文件、不改 graph/ 目录。
发现必须改 graph/ 才能继续时,记入交接「R8 缺口清单」,越级改 = 整批 revert。
验收:cargo test --lib 绿;批内 grep 自检 `\.nodes\b|\.edges\b` 直接访问清零
(测试模块内构造 fixture 除外,测试允许直接构造 HashMap)。
```

### 批次划分(文件集互斥,可同模板并行派发)

| 批 | 文件集 | 访问点规模(grep 实测) |
|---|---|---|
| R1 | `engine/src/adapter/`(18 语言) | .source/.target ~108 |
| R2 | `engine/src/graph/resolver.rs` | API 108 + .source/.target 44 |
| R3 | `engine/src/analysis/di_reflection/`、`dynamic_dispatch*.rs`、`bridge_rpc.rs` | ~120 |
| R4 | `engine/src/analysis/`(flows、framework_routes、coupling、explore、dataflow* 等其余) | ~80 |
| R5 | `engine/src/community/`、`engine/src/routing/` | ~45 |
| R6 | `engine/src/storage/`、`engine/src/tools/handlers.rs` | ~70 |
| R7 | `engine/src/main.rs`、`engine/src/mcp.rs`、`engine/src/engine/`、`engine/src/stress.rs` | ~60 |

**互斥约定**:任何批不得修改批外文件;resolver.rs 在 R2 独占(它刚被 M4 改过,
语义最敏感)。全部完成后统一跑一次 fs 数字契约再进 R8。

---

## R8 Graph 字段私有化 + 缺口收口(串行,不可并行)

**改**:`engine/src/graph/graph.rs` + R1~R7 交接的缺口清单。
**做法**:`nodes`/`edges` 改 `pub(crate)`(第一步)或全私有(最终态),
让编译器把所有漏网点指出来,逐个收口。以下公共面保留为方法,签名定型:

| 现有公共面 | R8 定型 | 位置 |
|---|---|---|
| `meta: serde_json::Value` | `meta()` / `meta_mut()` 访问器 | main.rs:616 baseline、store.rs |
| `from_json_file` | 保留,内部改走访问器 | graph.rs:49 |
| `diff`(GraphDiff 含克隆 Node/Edge) | 保留签名,返回类型加 newtype 包装 | graph.rs:188-235 |
| `outgoing_edges/incoming_edges`(O(E) 全扫) | 保留但标注 deprecated,新增 `outgoing(node) -> 迭代器`(仍 O(E),R10 容器换后自然变快) | graph.rs:159-171 |

**验收**:数字契约全项 + `pub(crate)` 警告清零。

---

## R9 serde/存储边界定型(吸收 M7c 快照持久化)

**改**:`engine/src/storage/sqlite.rs`、`engine/src/storage/memory.rs`、
`engine/src/storage/store.rs`、JSON 落盘路径。

### R9.1 serde 定型(小)
- 确认 NodeId/EdgeId `serde(transparent)` 全程生效;hologram.db、
  *.json 线格式零变化(加 roundtrip 测试:旧 fixture 库冷启动读回一致)。

### R9.2 M7c 快照持久化(核心,解决 db-save 规模墙)
**问题**:22M 边规模 bulk_replace_all 885s(drivers 4.8M 边已 1247.8s),
SQLite 全量重写路线在大图下无前途(handoff 第四轮 M7 节有分解数据)。

**规格**:
- **阈值**:env `HOLOGRAM_SNAPSHOT_MIN_EDGES`,默认 5_000_000。
  边数 < 阈值走现有 SQLite bulk_replace_all;≥ 阈值走快照。
- **格式**:`<project>/.hologram/graph.snapshot`(bincode 序列化
  MemoryIndex 全量:arena strings、CSR 数组、Node Vec、辅助索引;
  写 `.tmp` 后原子 rename)。
- **加载**:`GraphStore::open` 检测快照存在且 mtime ≥ hologram.db 时
  优先快照加载(秒级);否则走现有 SQLite 路径。
- **FTS 折中(钉死,勿自由发挥)**:快照模式下 fts_nodes 不预建;
  首次 FTS 查询时从 MemoryIndex 惰性重建(超 30s 预算则返回降级错误,
  提示用 hologram_explore 代替)。timeline_events 不受影响(独立表)。
- **回退**:快照反序列化失败 → 删快照,回退 SQLite 路径,记 warn。

**验收**:数字契约全项(fs 边数 42.6 万 < 阈值,走旧路,行为零变化);
drivers 压测(485 万边,阈值调 4M 强制走快照)验证写入从 1247.8s → <60s。

---

## R10 内部表示 u32 化(最后,可选)

**前提**:R0~R9 完成,所有消费点只依赖访问器与 NodeId API。
**改**:原则上只动 `engine/src/graph/` 内部。
**规格(钉死)**:
- NodeId/EdgeId **保持字符串句柄不变**(as_str() 签名稳定,消费方零感知);
- u32 interning 只作用于 Graph **容器内部**:`nodes/edges` 改
  `IndexMap<NodeId, _>` 或 arena+handle 双映射,热路径索引
  (resolver 三索引、merger 两索引、community 邻接)改 u32 键;
- 目标:**全内核(51k 文件)完整管线 < 15 分钟 @ 16GB**(当前 ~1.5h+ 且跑不完)。
**验收**:数字契约全项 + 全内核压测(带看门狗),耗时/RSS 写入 handoff 文档。

---

## 常见坑(前序批次实测)

1. **rayon 并行 HashMap**:用 `map.par_iter_mut().for_each(|(_, v)| ...)`,
   `values_mut()` 没有并行适配器。
2. **借用分裂**:要借用 edges 同时 mut nodes,把辅助索引入参定为
   `&HashMap<String, Edge>` 字段而非 `&Graph`(M6 已示范)。
3. **语义等价陷阱**:改迭代器/单遍扫描时,平票取首个、空集返回 None、
   match_len≥2 这类边界必须逐条对照原实现(resolver 批改时最要小心)。
4. **压测污染**:验收压测运行期间不要在同机编译,否则阶段耗时不具可比性
   (图数字仍有效,耗时无效)。
5. **flows/社区数跨轮微差**(±40/±7)是 resolver HashMap 迭代序非确定性,
   已记账,不是回归;要严格可复现性需另行立项(不在本方案范围)。
