// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// scene-signal-store — 星图 scene → 状态层的信号（P1 事件归零：替代 bus
// 'graph:rendered' / 'graph:node-clicked' 两事件；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：graph.ts（render 完成后）/ graph-interaction-controller（节点点击拾取后）。
// 消费者：chat-core（@ 自动补全喂节点名 / 用户焦点节点）、graph-interaction（调试日志）。
// 方向先例：graph.ts 早已订阅 app 层 useLangStore —— scene ↔ state 互访无环
//（state/ 只依赖 zustand，不反向依赖 scene）。

import { create } from 'zustand';

/** 节点点击载荷（类型随状态走：原 bus 'graph:node-clicked' payload） */
export interface GraphNodeClicked {
  nodeName: string;
  nodeType: string;
  nodeId: string;
  degree: number;
  location: string;
}

interface SceneSignalState {
  /** 完整渲染完成次数（含首次渲染与重建） */
  renderedTick: number;
  /** 最近一次节点点击（tick 递增——同节点重复点击也能触发订阅者） */
  nodeClicked: GraphNodeClicked | null;
  nodeClickedTick: number;
}

export const useSceneSignalStore = create<SceneSignalState>(() => ({
  renderedTick: 0,
  nodeClicked: null,
  nodeClickedTick: 0,
}));

/** 通知一次完整渲染完成（可见节点集已更新）。 */
export function bumpGraphRendered(): void {
  useSceneSignalStore.setState((s) => ({ renderedTick: s.renderedTick + 1 }));
}

/** 广播一次节点点击。 */
export function setGraphNodeClicked(data: GraphNodeClicked): void {
  useSceneSignalStore.setState((s) => ({ nodeClicked: data, nodeClickedTick: s.nodeClickedTick + 1 }));
}
