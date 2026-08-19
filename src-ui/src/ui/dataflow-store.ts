// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// dataflow-store — 数据流追踪保存信号（P1e：替代 bus 'dataflow:saved' 事件；
// 见 docs/plans/ui-react-island-retirement-plan.md）。
// 发射点：runtime-adapter 的 BuilderDeps.onDataflowSaved（Agent 保存 dataflow trace 后）。
// 唯一消费者：DataflowPanel（订阅 tick 重载追踪列表）。

import { create } from 'zustand';

export const useDataflowStore = create<{ savedTick: number }>(() => ({ savedTick: 0 }));

/** 通知数据流面板有新 trace 落盘。 */
export function bumpDataflowSaved(): void {
  useDataflowStore.setState((s) => ({ savedTick: s.savedTick + 1 }));
}
