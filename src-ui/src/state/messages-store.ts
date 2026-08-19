// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 消息存储 — 聊天消息数组 + 流式状态。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';
import type { AssistantMessage, ChatMessage, MessageId } from '../ui/message-model';
import { createScopedStore } from './scoped-store';

interface MessagesStore {
  messages: ChatMessage[];
  version: number;
  streamingAssistantId: MessageId | null;
  userScrolledUp: boolean;
  expandedReasoning: number[];

  setMessages: (msgs: ChatMessage[]) => void;
  bump: () => void;
  /** 提交对某条消息的原地变更：将其数组槽替换为浅拷贝并递增版本。
   *  见下方 SINGLE WRITE PATH RULE。 */
  touchMessage: (id: MessageId) => void;
  /** 同 touchMessage，但通过消息包含的 part 对象定位（引用匹配）。
   *  可在会话重建后将同一 part 对象重新挂载到新消息时生效。 */
  touchMessageContaining: (part: object) => void;
  setStreamingAssistantId: (id: MessageId | null) => void;
  setUserScrolledUp: (v: boolean) => void;
  addExpandedReasoning: (idx: number) => void;
  deleteExpandedReasoning: (idx: number) => void;
  clearExpandedReasoning: () => void;
}

// ── 单一写入路径规则 ────────────────────────────────
// 聊天数据模型就地变更消息/part 对象（流式文本执行 `part.text += chunk` —
// 逐 token 拷贝太昂贵）。但 React 通过引用观察变化。弥合这一差距
// 是 store 的职责，而非调用方的：
//
//   ⚠️ 对已有消息或其 part 进行任何原地变更后，必须通过
//   touchMessage / touchMessageContaining 提交。
//   切勿在变更后使用裸 `bump()` 或手动 `setState({ messages: [...] })` —
//   数组展开不改变消息引用，记忆化的气泡会静默跳过更新
//   （这是反复出现的"卡片卡住 / 丢失最后一帧"类 bug）。
//
// 新增变更路径（新事件类型、新生命周期钩子）？变更，然后 touch。
// 这就是全部规则。

export type MessagesStoreApi = ReturnType<typeof createMessagesStoreImpl>;

function createMessagesStoreImpl() {
  return create<MessagesStore>((set) => ({
    messages: [],
    version: 0,
    streamingAssistantId: null,
    userScrolledUp: false,
    expandedReasoning: [],

    setMessages: (messages) => set({ messages, version: Date.now() }),
    bump: () => set((s) => ({ version: s.version + 1 })),
    touchMessage: (id) =>
      set((s) => {
        const idx = s.messages.findIndex((m) => m._id === id);
        if (idx < 0) return s;
        const messages = s.messages.slice();
        messages[idx] = { ...messages[idx] };
        return { messages, version: s.version + 1 };
      }),
    touchMessageContaining: (part) =>
      set((s) => {
        const idx = s.messages.findIndex(
          (m) => m.role === 'assistant' && (m as AssistantMessage).parts.some((p) => p === part),
        );
        if (idx < 0) return s;
        const messages = s.messages.slice();
        messages[idx] = { ...messages[idx] };
        return { messages, version: s.version + 1 };
      }),
    setStreamingAssistantId: (streamingAssistantId) => set({ streamingAssistantId }),
    setUserScrolledUp: (userScrolledUp) => set({ userScrolledUp }),
    addExpandedReasoning: (idx) =>
      set((s) => {
        if (s.expandedReasoning.includes(idx)) return s;
        return { expandedReasoning: [...s.expandedReasoning, idx] };
      }),
    deleteExpandedReasoning: (idx) => set((s) => ({ expandedReasoning: s.expandedReasoning.filter((i) => i !== idx) })),
    clearExpandedReasoning: () => set({ expandedReasoning: [] }),
  }));
}

// ── 每面板注册表 ──
// ⚠️ 不变量：每个面板必须通过此 Map 拥有自己的 store 实例。
// 切勿在此 Map 外添加模块级 `let`/`const` 状态 — 该状态会跨面板
// 共享并导致跨面板消息泄露。
// 曾因此出问题：6+ 次提交（1f7fc04 → c927dd2）修复 agent 添加
// 全局状态而非每面板状态导致的跨面板流式泄露。

const scoped = createScopedStore('__hologram_msg_stores__', createMessagesStoreImpl);

export const getMessagesStore = scoped.getStore;

/** 移除所有 key 以给定前缀（如 panelId）开头的 store。
 *  也移除每会话 store（panelId:sessionId）。
 *  （2026-08-04：生产暂未接线，但有单元测试保护 — disposePanelStores 的组成部分） */
export function disposeMessagesStores(storeId: string): void {
  scoped.disposeStoresByPrefix(storeId);
}

export const useMessagesStore = getMessagesStore();

// ── 非响应式访问器 ──
// （2026-08-04 清理：getMessages/setMessages/findStreamingAssistant/useMessagesStore
//   全工程零调用，已删；bumpMessages/getStreamingAssistantId/getUserScrolledUp/
//   getExpandedReasoningSet 被 chat-store 使用，保留）

function _store(storeId?: string) {
  return scoped.getState(storeId);
}

export function bumpMessages(storeId?: string): void {
  getMessagesStore(storeId).getState().bump();
}
export function getStreamingAssistantId(storeId?: string): MessageId | null {
  return _store(storeId).streamingAssistantId;
}
export function getUserScrolledUp(storeId?: string): boolean {
  return _store(storeId).userScrolledUp;
}
export function getExpandedReasoningSet(storeId?: string): Set<number> {
  return new Set(_store(storeId).expandedReasoning);
}
