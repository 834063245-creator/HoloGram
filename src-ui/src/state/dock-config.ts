// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// dock-config — 面板外部依赖的注入槽（main.ts 启动时写入，组件在使用点读取）。
// 模块级槽位而非注册句柄/props：规避「组件尚未挂载、句柄尚不存在」的时序竞态。

import type { StarGraph } from '../scene/graph';

/** DataflowPanel：启发式符号解析失败时的 NL→符号 Agent 兜底（main.ts 注入闭包） */
let _dataflowQueryParser: ((nl: string) => Promise<string[]>) | null = null;
export function setDataflowQueryParser(fn: (nl: string) => Promise<string[]>): void {
  _dataflowQueryParser = fn;
}
export function getDataflowQueryParser(): ((nl: string) => Promise<string[]>) | null {
  return _dataflowQueryParser;
}

/** HotspotsPanel：图高亮联动（main.ts 注入 starGraph） */
let _dockStarGraph: StarGraph | null = null;
export function setDockStarGraph(sg: StarGraph): void {
  _dockStarGraph = sg;
}
export function getDockStarGraph(): StarGraph | null {
  return _dockStarGraph;
}
