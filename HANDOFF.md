# Handoff — HoloGram（2026-06-27）

## 当前状态

- **引擎**：全量分析首次 ~420s，后续 <1s（SQLite 缓存命中）；增量更新边完整性已修复
- **前端**：InstancedMesh + Points 渲染，draw call 210K→3；交互全恢复（hover/click/filter/fold）
- **构建**：引擎 `cargo build --release` 通过，前端 `npm run build` 通过，测试 14/14 相关新增+修改全绿

---

## 本次变更（2026-06-27 session 2）

### 前端：交互修复 + 视觉调优

**文件：`src-ui/src/ui/graph.ts`**

1. **Fresnel 效果**：白中心在小球体上不可行（可见像素全在 NdotV≈1，全白）。改为 rim lighting：
   - `outgoingLight * (1.0 + pow(1.0 - NdotV, 4.0) * 0.4)` — 中心本色，边缘微亮

2. **辉光被核心球盖死**：renderOrder 修正
   - `nodeGlowsPoints.renderOrder = 1`、`nodeGlows2Points.renderOrder = 1`（核心球默认 0，辉光在核心之后叠加）

3. **hover/click 全部不响应**：`InstancedMesh.boundingSphere` 在 count=0 时首次计算并永久缓存（空球）
   - 渐进 revel 完成后 `boundingSphere = null` 强制重算

4. **筛选面板不生效**：
   - `_setCoreScale` 补 `instanceMatrix.needsUpdate = true`（GPU 永远看不到 scale 变化）
   - `animate()` per-node 循环加 `_nodeKindFilter` gate，防帧循环覆盖筛选的 alpha=0

5. **折叠视图 hover 不生效**：`&& false /* batched */` 硬关 → 恢复（galaxy glows 是独立 Sprite）

6. **hub 节点 hover 边过曝**：`rebuildHighlightEdges` + `_buildFocusSubgraphEdges`
   - degree 归一化：`bright /= edgeCount^0.25`（5 条边 ×1.67，500 条边 ×0.53）
   - 近暗远亮渐变：hover 端 30% 亮度，远端 100%（星芒/喷泉效果）

### 引擎：SQLite 缓存完整性

**文件：`engine/src/storage/sqlite.rs`**
- `load_all_nodes` NodeKind 解析补全 8 种（原只映射 3 种：symbol/medium/temporal，function/class/module/file/interface 全掉进 Symbol）

**文件：`engine/src/storage/incremental.rs`**
- `to_sqlite` 前加 `new_index.flush_pending()`。clone 从不调 `rebuild_dense_index`，`node_by_idx` 为空 → `to_sqlite` 遍历空 vec 收集 0 条边 → `DELETE FROM edges` 后插入空集 → 边全部丢失

**文件：`engine/src/engine.rs`**
- `graph_from_index` 从 node location 反推 `cross_file`（MemoryIndex CSR 不存此字段，缓存命中时丢失 → 全部默认 false → 所有边同色）

**文件：`engine/src/storage/memory.rs`**
- 补 `test_temporal_delay` 预存测试的 `flush_pending`（同一根因）

### 引擎：缓存命中跳过全量流水线

**文件：`src-tauri/src/main.rs`**
- `direct_analyze(path, force)`：`engine_init()` 后检测 `node_count > 0 && !force` → 直接从 SQLite 序列化返回
- `analyze_and_load` 透传 `force` → `run_analyze_with_progress` → `direct_analyze`
- "重分析" 按钮传 `force: true` → 走完整流水线
- watcher fallback + MCP 工具调用 `force: true`

---

## 测试

| 测试 | 覆盖 |
|------|------|
| `test_node_kind_as_str_roundtrip` | 8 种 NodeKind 写→读一致性 |
| `test_all_node_kinds_survive_sqlite_roundtrip` | SQLite 读写 8 种 kind |
| `test_edge_fields_survive_sqlite_roundtrip` | coupling_depth + delay 读写 |
| `test_clone_and_flush_preserves_edges` | clone → flush → edge_count 不丢 |
| `test_edges_queryable_after_flush_pending` | flush 后 CSR outgo​ing 可查 |
| `test_graph_from_index_cross_file` | 同文件 false / 跨文件 true / 无 location 不崩 |
| `test_temporal_delay`（预存修复） | 补 flush_pending |

- `cargo test --release`：相关 14 测试全绿
- ⚠️ MCP 测试有预存的全局 ENGINE 状态并行污染（单独跑全过，合跑部分挂），与本次改动无关
- TypeScript: `npx tsc --noEmit` 零错误
- 前端构建: `npm run build` 通过

---

## 文件变动

| 文件 | 变更 |
|------|------|
| `src-ui/src/ui/graph.ts` | Fresnel rim light + glow renderOrder + boundingSphere 重算 + needsUpdate + filter gate + 自适应边亮度 + fold hover 恢复 |
| `engine/src/storage/sqlite.rs` | NodeKind 8种映射补全 + SQLite 读写测试 |
| `engine/src/storage/incremental.rs` | flush_pending 修复增量更新丢边 |
| `engine/src/storage/memory.rs` | clone/flush 测试 + 预存测试修复 |
| `engine/src/engine.rs` | graph_from_index cross_file + 测试 |
| `src-tauri/src/main.rs` | direct_analyze cache skip + force 透传 |
| `src-tauri/src/workspace.rs` | direct_analyze force 传参 |
| `engine/src/graph/node.rs` | test_node_kind_as_str 补全 + roundtrip 测试 |

---

## 下一步

1. **视觉验证**：启动 app，hover hub 节点验证边亮度自适应，筛选节点类型，折叠视图 hover
2. **缓存验证**：打开已分析项目第二次，终端应显示 `[direct_analyze] Using cached graph`，秒开
3. **重分析验证**：点"重分析"按钮 → 不走缓存，全流水线重跑
4. **增量更新验证**：修改源文件后等待 watcher → 重启 app 验证边数不丢失
5. **Leiden refinement 调优（可选）**：`louvain.rs` 中 refinement 代码保留但未启用
6. **LSP 优化（低优先级）**：LSP 阶段 ~140s 还有空间
