// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// timeline-store — 时间轴刷新信号（P1d：替代 bus 'timeline:refresh' 事件；
// 见 docs/plans/ui-react-island-retirement-plan.md）。
// 发射点：workspace.ts（图更新合并/分页兜底/工具触发文件变更/runCheck 后）。
// 唯一消费者：TimelineHUD（订阅 tick，600ms 防抖后重拉）。

import { create } from 'zustand';

export const useTimelineStore = create<{ refreshTick: number }>(() => ({ refreshTick: 0 }));

/** 通知时间轴有新事件可拉。 */
export function bumpTimelineRefresh(): void {
  useTimelineStore.setState((s) => ({ refreshTick: s.refreshTick + 1 }));
}
