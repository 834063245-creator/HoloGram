# 阶段 2 — 3D 图谱内嵌 DSH web：设计定稿（recon 完成）

> 状态：两块已摸透，待用户定「挂法」。本文件是唯一事实来源。
> 结论先行：**复用 HoloGram 的渲染内核（graph-*.ts），只换数据源** —— 渲染观感不重写。

## 已确认的两块事实（本轮验证）

### A. 数据循环是通的（引擎 → GraphJSON → StarGraph.render）

引擎已经产出前端 3D 渲染需要的**精确数据结构**：

- `engine/src/main.rs`：
  - `handle_analyze()` → 完整 `GraphJSON`：`{ nodes[], edges[], communities[], hierarchical_communities[], meta… }`
  - `handle_get_graph()` → `{ nodes[], edges[] }`（TCP RPC 全图导出）
- 前端 `src-ui/src/ui/graph-types.ts` 的 `GraphJSON`/`GraphNode`/`EdgeData` 契约与引擎输出**逐字段对齐**（`community_id`、`coupling_depth`、`position`、`cross_file`…）
- 渲染入口：`new StarGraph(container).render(graphJSON)`（`graph.ts:141` 构造，`:550 render`）

=> 3D 渲染只需「引擎图数据 → StarGraph.render」，中间无不可逾越的缝。

### B. 渲染内核可复用，但带 HoloGram 应用耦合

	exttt{StarGraph} facade 导入了 HoloGram app 依赖：`../app/shell-store`（zustand）、`./events`（bus）、`../i18n`、`gpu-layout`。整类搬迁会把壳一起带进来。三条剥耦合路径待选：

1. **整类复用 + 提供桩**：为 `useShellStore`/`bus`/`i18n` 提供轻量 stub，原样 import `StarGraph`。最快，但寄生 HoloGram 壳形态。
2. **借 build 层抽内核**：只带 `graph-scene/graph-node-renderer/graph-edge-renderer/graph-layout` 等纯渲染模块，自己拼一个轻 `StarGraph`-like 门面。最干净，工作量中等。
3. **等 HoloGram 自己把内核做成可独立包**（`runtime-adapter.ts` 已是这类接缝）。

## 挂法（用户决定 A / B）

| | A 原生 slot 面板 | B 独立 3D 视图 + DSH 面板座 |
|---|---|---|
| 构建位置 | DSH checkout 内写 `dsh.client` 包（用 `clientBundle`/tsdown.client rig，closure-factory + `__ModuleLoader__`） | `dsh-bundle` 内自包含 viewer（Vite/ESM），经 `ctx.slots` 或独立路由挂进 DSH web |
| 布局约束 | DSH 三栏对话优先，无通用 dock 塞大画布 | 不受三栏约束，面板座是轻壳 |
| 渲染观感 | 你的内核 | 你的内核 |
| 成本 | 高（动 DSH 仓 + 里应外合） | 中 |

## 建议

用户最关心「观感」。推荐 **B**：先做出「内核 + 独立 3D 视图」给你验渲染效果对不对味；验过了再谈要不要深嵌（A）。
