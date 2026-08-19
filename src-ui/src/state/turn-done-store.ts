// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// turn-done-store — 聊天轮次完成信号（P1 事件归零：替代 bus 'chat:turn-done' 事件；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：chat-core（_runAgentTurn / sendMessage 的 finally）。
// 唯一消费者：main.ts（订阅 tick — 增量持久化 appendLastMessage + scheduleAutoSave）。

import { create } from 'zustand';

export const useTurnDoneStore = create<{ turnDoneTick: number }>(() => ({ turnDoneTick: 0 }));

/** 通知聊天轮次已结束（成功/失败/中止皆算）。 */
export function bumpTurnDone(): void {
  useTurnDoneStore.setState((s) => ({ turnDoneTick: s.turnDoneTick + 1 }));
}
