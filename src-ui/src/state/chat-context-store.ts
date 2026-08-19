// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// chat-context-store — 用户焦点文件信号（P1 事件归零：替代 bus 'highlight:file' /
// 'navigate:file' 两事件——消费端行为完全一致，合并为单信号；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：app-shell 的 navigateToFile / highlightFile 命令。
// 唯一消费者：chat-core（订阅 → panel-store.setUserFocusFile，供 @ 上下文跟踪）。

import { create } from 'zustand';

export const useChatContextStore = create<{ focusFile: string | null; focusFileTick: number }>(() => ({
  focusFile: null,
  focusFileTick: 0,
}));

/** 广播用户当前焦点文件（导航/高亮同语义）。 */
export function setChatFocusFile(path: string): void {
  useChatContextStore.setState((s) => ({ focusFile: path, focusFileTick: s.focusFileTick + 1 }));
}
