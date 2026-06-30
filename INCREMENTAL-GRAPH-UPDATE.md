# 增量星图更新 — 任务描述

## 现状

文件变更 → 后端全量重分析 → 吐完整 JSON → 前端 `clearGraph()` 全毁 → `render()` 重建 + progressive reveal。每次 watcher 触发都会闪烁并丢失所有交互状态（相机/选中/hover/blast/filter）。

`workspace.ts:522` `doGraphUpdate` 注释写 "incremental" 但从出生就是假的——实现就是全量 `render()`。

## 目标

Agent 编辑文件后，星图只更新变动的部分。不闪、不丢状态、不重算布局。

## 涉及文件

- `engine/src/engine.rs` — 后端，`get_full_graph` 在这里，需加 diff 输出
- `src-ui/src/workspace.ts` — 前端，`doGraphUpdate` 在这里，需改调度
- `src-ui/src/ui/graph.ts` — `StarGraph`，需加增量方法（`updateNodes`/`updateEdges`/`removeNodes` 等）

## 两阶段方案

### 阶段 1：后端吐 diff

当前 `graph-updated` event → `invoke('get_full_graph')` 返回全量 JSON。

改成 `graph-updated` event payload 直接带 diff：

```json
{
  "added_nodes": [ { "id": "...", "name": "...", ... } ],
  "removed_nodes": [ "id1", "id2" ],
  "changed_nodes": [ { "id": "...", "name": "...", ... } ],
  "added_edges": [ { "id": "...", "source": "...", "target": "...", ... } ],
  "removed_edges": [ "id1", "id2" ],
  "changed_edges": [ { ... } ]
}
```

或者保持全量 JSON 但加上 `_diff` 字段标注变化。这样 fallback 到全量 render 也容易。

### 阶段 2：前端增量渲染

`StarGraph` 加增量方法：

- `addNodes(nodes)` — 扩 `_glowRgba`/`_glowSizes` 等 Float32Array，追加到 `InstancedMesh`，重新创建 `Points` geometry（buffer 扩容需重建）
- `removeNodes(ids)` — `_overrideFlags[i] = 1` + `_setGlowAlpha(i, 0)` + `_setCoreVisible(i, false)`，不缩 buffer
- `updateNodes(nodes)` — 更新颜色/位置属性
- `addEdges/removeEdges` — 重建对应 `edgeLineGroups`

关键难点：`InstancedMesh` 不支持动态扩容——`count` 可以缩但不能超 construction 上限。追加节点需重建 InstancedMesh。`Points` 的 buffer geometry 同理。这仍然是 O(n) 操作但可以避免 `clearGraph()` 的全毁+重布局。

**布局**：节点数不变就不重算。新增少量节点可以插到现有布局的空隙（简单螺旋臂追加），不需要全图重跑力模拟。

**交互状态保持**：只要不调 `clearGraph()`，相机/controls/选中/hover/blast/filter 可以在增量 update 前后保持。

## 注意

- `InstancedMesh` 扩容 = 重建对象 + 拷贝旧 instanceMatrix/color。不算轻但比 `clearGraph()` + `layout3D()` + `buildNodes()` + `buildEdges()` + `progressiveReveal` 便宜几十倍。
- `Points` buffer 扩容同样。可以考虑预分配 buffer（多 20%），减少重建频率。
- 新增节点 layout：当前 `spiralGalaxies` 是 O(n) 过程式生成，插入新节点需要重新分配社区内部位置。可以简单处理——新节点放社区质心附近 jitter。
- 当前 `render()` 的 progressive reveal 逻辑需要在增量路径跳过。
- GPU shader 属性（phase/speed/baseHSL 等）也需要增量追加。

## 记号

增量更新的 `render()` 本身就是 O(n) 的 buffer 重建，但比 `clearGraph()` 少了：
- layout 计算（最大头——WebGPU n-body 或 CPU force sim）
- DOM 标签重建
- minimap 重建
- progressive reveal 动画

所以增量路径即使重建 buffer 也体感好十倍。
