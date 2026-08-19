# src/scene — 星图 Three.js scene

> 2026-08-19 ui/ 拆分 P2 迁入（graph.ts 本体 + 21 graph-* + gpu-layout），23 文件。
> `ui/graph.ts` 仅存 3 行 re-export shim（冻结文件 chat-stream 的 type import 走此层）。

## 要点

- 入口 `graph.ts`（StarGraph facade：scene 组装 + renderer 循环 + 子系统编排）。
- `graph-layout.ts` / `gpu-layout.ts` 的**布局参数禁改**（AGENTS §11）。
- 各子系统以 Host 接口解耦（AnalysisHost / DiffOverlayHost / FocusHost / FoldHost …）。
- scene 内部引用 ui/ 残余锚点（icons / debug / app-shell）与 `state/scene-signal-store`（render/click 信号）为既定方向。
- 修改本目录前先问图：`graph(preflight)` / 外部 MCP `preflight_check`。
