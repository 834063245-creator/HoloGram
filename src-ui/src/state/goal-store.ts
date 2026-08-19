// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal-store — Goal 状态广播（P1 事件归零：替代 bus 'goal:state' 事件；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：GoalManager 构造回调注入（workspace 初始化 + chat-core 的 /goal 命令族）。
// 唯一消费者：chat-core（订阅 → _updateGoalRecord → panel-store.goalRecord 状态条）。

import { create } from 'zustand';
import type { GoalRecord } from '../agent/goal-manager';

export const useGoalStore = create<{ record: GoalRecord | null; tick: number }>(() => ({
  record: null,
  tick: 0,
}));

/** 广播一条 goal 状态记录（GoalManager 回调注入点调用）。 */
export function broadcastGoalRecord(record: GoalRecord): void {
  useGoalStore.setState((s) => ({ record, tick: s.tick + 1 }));
}
