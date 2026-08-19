// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-switch-store — 工作区切换信号（P1 事件归零：替代 bus 'workspace:switched'
// 事件；见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：main.ts notifyAllPanels（新工作区就绪、面板全部通知后）。
// 唯一消费者：chat-core（订阅 tick → _refreshGoalRecord 重载 goal 状态条）。
// 消费端是跨工作区触发：_refreshGoalRecord 在途结果必须 epoch 守卫（INVARIANTS #12）。

import { create } from 'zustand';

export const useWorkspaceSwitchStore = create<{ switchedTick: number }>(() => ({ switchedTick: 0 }));

/** 通知工作区切换完成。 */
export function bumpWorkspaceSwitched(): void {
  useWorkspaceSwitchStore.setState((s) => ({ switchedTick: s.switchedTick + 1 }));
}
