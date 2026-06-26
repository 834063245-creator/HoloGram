# HoloGram 卡点修复方案 v2 — 真正的根因

## 根因

**社区检测的 condensation 算法是 O(C²×size²) 四重循环，而非正确的 O(E) 遍历边。**

日志铁证（`debug-5a7212.log`）：
```
"phase: 动态调度合成",  elapsed_ms: 7817      ← 1.9s
"phase: 社区检测",      elapsed_ms: 141470    ← 133.6s ★ 占 94%
"phase: 写入数据库",    elapsed_ms: 141784    ← 0.3s
analyze_lock_wait_ms: 0                      ← 锁没争用，v1 方案方向错了
```

5007 节点 / 9448 边的项目花了 141 秒，94% 花在社区检测。
用户的大项目（19716 边 / 4109 社区）会更久——这就是"一直分析中"的真因。

## 三个性能杀手

### 杀手 1（致命）：condensation 四重循环

`louvain.rs:190-201`：

```rust
for ci in 0..n {                    // n = 社区数 ~1478
    for nid in &current_communities[ci] {       // 社区内节点 ~3.4
        for cj in (ci + 1)..n {                 // 又遍历所有社区
            for onid in &current_communities[cj] {  // 又遍历社区内节点
                let w = edge_weight(nid, onid);  // HashMap 字符串键查找
```

复杂度 = O(C² × avg_size²) = 1478²/2 × 3.4² ≈ **12.5M 次 HashMap 查找**。
每次查找做字符串比较，~500ns-1μs → **6-12 秒/层**，多层累加 → 133 秒。

正确做法：遍历图的边，每条边查两端属于哪个社区，不同社区就累加。
复杂度 = O(E) = 9448 次 → **< 1ms/层**。差三个数量级。

### 杀手 2（重要）：detect_communities 重复调用

`engine.rs:436` 调 `detect_communities(graph, 42)`（Phase 1 Louvain，5007 节点）。
`engine.rs:447` 调 `detect_hierarchical_communities(graph, 42)`，**内部又调了一次 `detect_communities`**（`louvain.rs:109`）。

Phase 1 跑了两遍，完全浪费。

### 杀手 3（重要）：serialize_cached_graph 重跑层次社区检测

`main.rs:472`：每次 `get_full_graph` / `analyze_and_load` 序列化时都调 `detect_hierarchical_communities(g, 42)`——又跑一遍 Phase 1 + Phase 2。

这在 `engine_read_graph` 闭包里执行，**持有 store 锁**，阻塞所有读操作。

### 附带 bug：reanalyze 竞态导致 workspace 变 null

控制台报错：`TypeError: Cannot set properties of null (setting 'graphData')`

reanalyze 的 `await invoke` 花了 2+ 分钟，期间用户点了"打开文件夹" → `switchWorkspace` 把 `workspace = null` → reanalyze 返回后写到 null 上崩溃。

---

## 修复 A（核心）：condensation 从 O(C²×size²) 改为 O(E)

**文件**：`engine/src/community/louvain.rs`

### A-1. 改 `detect_hierarchical_from_base` 签名和 condensation

```rust
// 改前（约 149-153 行）
fn detect_hierarchical_from_base(
    base: &[Community],
    seed: u64,
    edge_weight: &dyn Fn(&str, &str) -> f64,
) -> Vec<HierarchicalCommunity> {
```

```rust
// 改后
fn detect_hierarchical_from_base(
    base: &[Community],
    seed: u64,
    leaf_edges: &[(String, String)],
) -> Vec<HierarchicalCommunity> {
```

### A-2. 替换 condensation 四重循环

```rust
// 改前（约 189-201 行）
        // Sum cross-community edge weights
        for ci in 0..n {
            for nid in &current_communities[ci] {
                for cj in (ci + 1)..n {
                    for onid in &current_communities[cj] {
                        let w = edge_weight(nid.as_str(), onid.as_str());
                        if w > 0.0 {
                            *edge_counts.entry((ci, cj)).or_default() += w;
                        }
                    }
                }
            }
        }
```

```rust
// 改后
        // Sum cross-community edge weights — O(E), not O(C²×size²).
        // Walk leaf edges once; each edge's endpoints map to communities
        // via node_to_ci. Cross-community edges accumulate into edge_counts.
        for (src, dst) in leaf_edges {
            let ci = node_to_ci.get(src.as_str()).copied();
            let cj = node_to_ci.get(dst.as_str()).copied();
            if let (Some(ci), Some(cj)) = (ci, cj) {
                if ci != cj {
                    let (a, b) = if ci < cj { (ci, cj) } else { (cj, ci) };
                    *edge_counts.entry((a, b)).or_default() += 1.0;
                }
            }
        }
```

### A-3. 改 `detect_hierarchical_communities` 调用者

```rust
// 改前（约 108-124 行）
pub fn detect_hierarchical_communities(graph: &Graph, seed: u64) -> Vec<HierarchicalCommunity> {
    let base = detect_communities(graph, seed);
    // Build adjacency set for O(1) edge lookup during condensation
    let mut edge_set: HashMap<(&str, &str), f64> = HashMap::new();
    for edge in graph.edges.values() {
        let (a, b) = if edge.source < edge.target {
            (edge.source.as_str(), edge.target.as_str())
        } else {
            (edge.target.as_str(), edge.source.as_str())
        };
        *edge_set.entry((a, b)).or_default() += 1.0;
    }
    detect_hierarchical_from_base(&base, seed, &|a: &str, b: &str| {
        let (x, y) = if a < b { (a, b) } else { (b, a) };
        edge_set.get(&(x, y)).copied().unwrap_or(0.0)
    })
}
```

```rust
// 改后
pub fn detect_hierarchical_communities(graph: &Graph, seed: u64) -> Vec<HierarchicalCommunity> {
    let base = detect_communities(graph, seed);
    let leaf_edges: Vec<(String, String)> = graph.edges.values()
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}
```

### A-4. 改 `detect_hierarchical_communities_from_index` 调用者

```rust
// 改前（约 127-144 行）
pub fn detect_hierarchical_communities_from_index(
    idx: &MemoryIndex,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_from_index(idx, seed);
    // Build adjacency set from MemoryIndex for O(1) edge lookup
    let mut edge_set: HashMap<(&str, &str), f64> = HashMap::new();
    for (src, targets) in idx.edges_iter() {
        for (tgt, _, _, _) in targets {
            let (a, b) = if src < tgt.as_str() { (src, tgt.as_str()) } else { (tgt.as_str(), src) };
            *edge_set.entry((a, b)).or_default() += 1.0;
        }
    }
    detect_hierarchical_from_base(&base, seed, &|a: &str, b: &str| {
        let (x, y) = if a < b { (a, b) } else { (b, a) };
        edge_set.get(&(x, y)).copied().unwrap_or(0.0)
    })
}
```

```rust
// 改后
pub fn detect_hierarchical_communities_from_index(
    idx: &MemoryIndex,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let base = detect_communities_from_index(idx, seed);
    let leaf_edges: Vec<(String, String)> = idx.edges_iter()
        .flat_map(|(src, targets)| {
            let src = src.to_string();
            targets.iter().map(move |(tgt, _, _, _)| (src.clone(), tgt.clone()))
        })
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}
```

### A-5. 新增 `detect_hierarchical_communities_with_base`（避免重复 Phase 1）

在 `detect_hierarchical_communities` 函数后面加：

```rust
/// Hierarchical Louvain with pre-computed base communities.
/// Skips Phase 1 (detect_communities) — use when base communities are already known.
pub fn detect_hierarchical_communities_with_base(
    graph: &Graph,
    base: Vec<Community>,
    seed: u64,
) -> Vec<HierarchicalCommunity> {
    let leaf_edges: Vec<(String, String)> = graph.edges.values()
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    detect_hierarchical_from_base(&base, seed, &leaf_edges)
}
```

---

## 修复 B：engine.analyze 复用 communities，避免重复 Phase 1

**文件**：`engine/src/engine.rs`（约 447 行）

```rust
// 改前
    // Hierarchical communities for multi-level fold layout
    let hierarchical = detect_hierarchical_communities(&result.graph, 42);
```

```rust
// 改后
    // Hierarchical communities for multi-level fold layout.
    // Reuse the communities we just detected — avoids a redundant Phase 1
    // run_louvain pass that was doubling the community detection cost.
    let hierarchical = detect_hierarchical_communities_with_base(&result.graph, communities.clone(), 42);
```

> 注意 `communities` 变量在 436 行定义，439-445 行被借用设 community_id，447 行在循环之后。`communities.clone()` 不会有借用冲突。

---

## 修复 C：serialize_cached_graph 从 community_id 重建 base，不重跑 Phase 1

**文件**：`src-tauri/src/main.rs` 的 `serialize_cached_graph`（约 471-481 行）

```rust
// 改前
        // Hierarchical communities (Level 0 + Level 1+ super-communities)
        let hcommunities = detect_hierarchical_communities(g, 42);
        let hcommunities_json: Vec<serde_json::Value> = hcommunities.iter()
            .map(|hc| serde_json::json!({
                "id": hc.id,
                "label": hc.label,
                "node_ids": hc.node_ids,
                "level": hc.level,
                "parent_id": hc.parent_id,
            }))
            .collect();
```

```rust
// 改后
        // Hierarchical communities — rebuild base from node.community_id
        // (already set during analyze), then run only Phase 2 condensation.
        // Avoids re-running Phase 1 detect_communities on every serialize.
        let mut base_map: std::collections::HashMap<usize, Vec<String>> = std::collections::HashMap::new();
        for n in g.nodes.values() {
            if let Some(cid) = n.community_id {
                base_map.entry(cid).or_default().push(n.id.clone());
            }
        }
        let base: Vec<Vec<String>> = base_map.values().cloned().collect();
        let hcommunities = crate::engine::community::detect_hierarchical_communities_with_base(g, base, 42);
        let hcommunities_json: Vec<serde_json::Value> = hcommunities.iter()
            .map(|hc| serde_json::json!({
                "id": hc.id,
                "label": hc.label,
                "node_ids": hc.node_ids,
                "level": hc.level,
                "parent_id": hc.parent_id,
            }))
            .collect();
```

> 需要确认 `detect_hierarchical_communities_with_base` 是 `pub` 的（修复 A-5 已声明 `pub`）。
> 还需要确认 `engine::community` 模块路径可从 main.rs 访问。看 main.rs 顶部已有：
> `use hologram_engine as engine;`
> 所以路径应为 `engine::community::detect_hierarchical_communities_with_base`。

如果编译器报路径不对，用：
```rust
let hcommunities = engine::community::detect_hierarchical_communities_with_base(g, base, 42);
```

---

## 修复 D：reanalyze handler 竞态保护

**文件**：`src-ui/src/main.ts`（约 640-663 行）

```ts
// 改前
  btnReanalyze.addEventListener('click', async () => {
    if (!workspace?.path) { statusText.textContent = '请先打开项目'; return; }
    btnReanalyze.disabled = true;
    btnReanalyze.textContent = '分析中…';
    statusText.textContent = '重新分析中…';
    try {
      console.log('[reanalyze] step 1: calling analyze_and_load', workspace.path);
      const raw = await invoke<string>('analyze_and_load', { path: workspace.path, force: true });
      console.log('[reanalyze] step 2: analyze_and_load returned, length:', raw?.length);
      workspace.graphData = JSON.parse(raw);
      console.log('[reanalyze] step 3: JSON parsed, nodes:', Object.keys(workspace.graphData.nodes || {}).length);
      starGraph.render(workspace.graphData);
      console.log('[reanalyze] step 4: render done');
      const nc = Array.isArray(workspace.graphData.nodes) ? workspace.graphData.nodes.length : Object.keys(workspace.graphData.nodes || {}).length;
      statusText.textContent = `✨ ${nc} 节点已就绪`;
      console.log('[reanalyze] step 5: done');
    } catch (e: any) {
      console.error('[reanalyze] FAILED:', e);
      statusText.textContent = `重分析失败: ${e}`;
    } finally {
      btnReanalyze.disabled = false;
      btnReanalyze.textContent = '重分析';
    }
  });
```

```ts
// 改后
  btnReanalyze.addEventListener('click', async () => {
    if (_switching) { statusText.textContent = '正在切换工作区，请稍候…'; return; }
    const ws = workspace;
    if (!ws?.path) { statusText.textContent = '请先打开项目'; return; }
    btnReanalyze.disabled = true;
    btnReanalyze.textContent = '分析中…';
    statusText.textContent = '重新分析中…';
    try {
      console.log('[reanalyze] step 1: calling analyze_and_load', ws.path);
      const raw = await invoke<string>('analyze_and_load', { path: ws.path, force: true });
      console.log('[reanalyze] step 2: analyze_and_load returned, length:', raw?.length);
      // Guard against workspace switch during the long await.
      if (workspace !== ws) {
        console.log('[reanalyze] workspace switched during analysis — discarding result');
        statusText.textContent = '工作区已切换，重分析已取消';
        return;
      }
      ws.graphData = JSON.parse(raw);
      console.log('[reanalyze] step 3: JSON parsed, nodes:', Object.keys(ws.graphData.nodes || {}).length);
      starGraph.render(ws.graphData);
      console.log('[reanalyze] step 4: render done');
      const nc = Array.isArray(ws.graphData.nodes) ? ws.graphData.nodes.length : Object.keys(ws.graphData.nodes || {}).length;
      statusText.textContent = `✨ ${nc} 节点已就绪`;
      console.log('[reanalyze] step 5: done');
    } catch (e: any) {
      console.error('[reanalyze] FAILED:', e);
      statusText.textContent = `重分析失败: ${e}`;
    } finally {
      btnReanalyze.disabled = false;
      btnReanalyze.textContent = '重分析';
    }
  });
```

---

## 改动文件清单

| # | 文件 | 改动 | 影响 |
|---|------|------|------|
| A | `engine/src/community/louvain.rs` | condensation O(E) + 新增 with_base | **141s → <5s** |
| B | `engine/src/engine.rs` | analyze 复用 communities | **省一倍 Phase 1** |
| C | `src-tauri/src/main.rs` | serialize 从 community_id 重建 | **序列化不再重跑 Phase 1** |
| D | `src-ui/src/main.ts` | reanalyze 竞态保护 | **不再 null crash** |

## 预期效果

| 项目 | 改前 | 改后 |
|------|------|------|
| HoloGramHG (5007 节点 / 9448 边) | 141 秒 | < 5 秒 |
| FirstBeat Ultimate (19716 边 / 4109 社区) | 估计 10+ 分钟 | < 15 秒 |

核心改动是修复 A：把四重循环换成遍历边，三个数量级的差距。

## 验证

```powershell
# 后端编译
cargo check --manifest-path engine/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
# 前端类型检查
npm --prefix src-ui run build
```

## 手测

1. 打开项目 → 分析应该在几秒内完成（不再"一直分析中"）
2. 点"重分析" → 同样几秒完成，控制台应该走到 step 5
3. 分析中点"打开文件夹" → 不会崩溃，状态显示"工作区已切换"
4. 控制台 `[bridge] invoke failed` 应大幅减少（之前是超时导致的连锁失败）

## 为什么 v1 方案没解决问题

v1 聚焦在 `analyze_lock` 争用和 watcher 阻塞，但日志 `analyze_lock_wait_ms: 0` 证明锁没争用。真正的瓶颈是 `detect_hierarchical_from_base` 的 condensation 算法复杂度错误——O(C²×size²) 而非 O(E)。watcher 的改动（v1 修复 1-4）本身没错，但不是卡点的主因。可以保留 v1 的改动作为防御性改进，但 v2 才是性能修复。
