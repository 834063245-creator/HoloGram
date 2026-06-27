# Handoff — HoloGram（2026-06-28 session 5）

## 当前状态

- **引擎**：27 门语言；合并管线 v3 分批 + v4 全局边去重；已编译通过，20/20 核心测试 passed
- **前端**：节点核心球视觉效果修复（session 4）
- **未验证**：本次改动尚未用 `cargo tauri dev` 完整跑通 1468 文件项目

---

## 本次变更（2026-06-28 session 5）

### 根因：边数爆炸 + Tree 同步释放

**问题 1 — 边数爆炸**：`generic_walk` 对每个 `call_expression` AST 节点生成一条边。React/TS 项目里一个组件调用 `console.log` 100 次 = 100 条边，全部打入全局 `HashMap<String, Edge>`。600 个 TS 文件产生 **8.5M 条边**，HashMap 从预分配 220K 一路 rehash 到千万级，每次 rehash 对所有 key 重算哈希 + 搬家。

**问题 2 — Tree 同步释放**：`drop(result.tree)` 在主线程 merge 循环里同步执行。`ts_tree_delete()` 是 O(tree.nodes)，大文件（`grammar.json` 52KB, `node-types.json` 81KB）的 CST 含几十万节点，逐个释放阻塞 merge 循环 10s+/批。

### 修复

#### 1. 全局边去重（`merge.rs`）

`GraphMerger` 新增持久 `edge_index: HashSet<(String, String, u8)>`，对标已有的 `loc_index`。去重维度：`(source, target, edge_kind)`。

```rust
pub struct GraphMerger {
    graph: Graph,
    loc_index: HashMap<String, String>,       // 节点去重
    edge_index: HashSet<(String, String, u8)>, // 边去重（新增）
}
```

**二级去重**：
- **Level 1（快）**：`merge_slices` 内 `HashSet<(&str, &str, u8)>` — 借用引用，零 clone。同文件内同一函数重复调同一目标 → 99% 在此跳过。
- **Level 2（慢）**：`add_edge_deduped()` → clone source/target 查全局 `edge_index`。仅每文件 ~200 条唯一边到达此层。

**效果**：边数 8.5M → 13.6K（**625×** 减少）。

#### 2. 逐批后台 Tree 释放（`runner.rs`）

```rust
// 每批收集 Tree，后台线程释放，不阻塞 merge 循环
let mut batch_trees: Vec<tree_sitter::Tree> = Vec::with_capacity(BATCH);
// ... merge loop: batch_trees.push(result.tree) ...
if !batch_trees.is_empty() {
    std::thread::spawn(move || drop(batch_trees));
}
```

之前同步 `drop(result.tree)` 在 merge 循环内阻塞 → 改为收集后批量后台释放。

#### 3. `edge_kind_id()` 辅助函数

`EdgeKind` 枚举 → u8 判别值（0-9），Hash 比 `&EdgeKind` 指针更稳定（跨平台/编译器版本）。

### 改动文件清单

| 文件 | 改动 |
|------|------|
| `engine/src/graph/merge.rs` | 全局 `edge_index` 持久去重 + 二级快路径 + `edge_kind_id()` + `add_edge_deduped()` |
| `engine/src/pipeline/runner.rs` | 移除全局 `trees_to_drop` → 逐批后台线程释放 + 移除末尾 `std::thread::spawn(drop)` |

### 历史变更（session 1-4 已合并）

- Node 核心球视觉修复（Fresnel 反向 + spike 纹理）
- 静默吞错修复（discovery/runner 失败计数 + 健康告警）
- GrammarLoader RwLock 性能回归修复（TL_PARSER 缓存 Language）
- 合并管线 v3 分批架构（200 文件/批，entry API，`merge_slices`，`node_key` 优化）

---

## 测试

- **graph::merge: 14/14 passed**（含 5 个边去重测试：同调用内、跨调用、不同 source、不同 kind、跨文件全局）
- **pipeline::runner: 6/6 passed**
- `cargo check` 零错误零警告

---

## 下一步

1. `cargo tauri dev` 打开 `D:\codebase\codebase-memory-mcp`，观察终端输出：
   - merge 时间是否回到秒级（不再 56s/批）
   - 边数是否稳定（~3K-4K/批，总计 ~20K 而非 8.5M）
   - 总时间是否可接受（预计 < 120s 全量 1468 文件）
2. 如果 merge 仍然慢 → 问题可能在 `add_edge()` 的 `HashMap::insert`。考虑边存储从 `HashMap<String, Edge>` 改为 `Vec<Edge>`（边 ID 已唯一，不需要 HashMap key）
3. 如果 parse 仍然慢（大批文件 >30s/批）→ 问题在这些文件本身确实大（JSON grammar 文件），非 bug
