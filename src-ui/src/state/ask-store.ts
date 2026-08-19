// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-store — ask_user 工具的 UI 请求队列（P1 事件归零：替代 bus 'prompt:ask' 事件；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md）。
// 发射点：runtime-adapter 的 BuilderDeps.onAskUser（Agent ask_user 工具触发）。
// 唯一消费者：chat-core（订阅 seq → 消费 pending → PromptShelf.showAsk → callback）。
// callback-in-store 先例：overlay-store.TranslatorSession —— pending 请求跨
// chat-core 重建存活（构造时回放）；bus 时代 emit 早于订阅即静默丢失。
// 消费即清空：同一请求不会被第二个 chat-core 实例重复消费、callback 双答。

import { create } from 'zustand';

/** ask_user 的一次提问请求（callback 由 agent 侧持有，答案经其回传） */
export interface AskRequest {
  id: string;
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  batchIndex?: number;
  batchTotal?: number;
  callback: (answer: string[] | null) => void;
}

interface AskState {
  /** 待处理的最近一次请求（消费即清空；seq 单调递增区分先后） */
  pending: AskRequest | null;
  seq: number;
  /** 取走 pending 并清空（无请求返回 null）。 */
  consumeAsk: () => AskRequest | null;
}

export const useAskStore = create<AskState>((set, get) => ({
  pending: null,
  seq: 0,
  consumeAsk: () => {
    const p = get().pending;
    if (p) set({ pending: null });
    return p;
  },
}));

/** 推送一次提问请求（Agent 侧 ask_user 工具调用）。 */
export function pushAsk(req: AskRequest): void {
  useAskStore.setState((s) => ({ pending: req, seq: s.seq + 1 }));
}
