// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Messages store — chat messages array + streaming state.
// Split from chat-store.ts (god store → domain stores).

import { create } from 'zustand';
import type { AssistantMessage, ChatMessage, MessageId } from './message-model';

interface MessagesStore {
  messages: ChatMessage[];
  version: number;
  streamingAssistantId: MessageId | null;
  userScrolledUp: boolean;
  expandedReasoning: number[];

  setMessages: (msgs: ChatMessage[]) => void;
  bump: () => void;
  setStreamingAssistantId: (id: MessageId | null) => void;
  setUserScrolledUp: (v: boolean) => void;
  addExpandedReasoning: (idx: number) => void;
  deleteExpandedReasoning: (idx: number) => void;
  clearExpandedReasoning: () => void;
}

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

// ── Per-panel registry ──
// ⚠️ INVARIANT: Every panel must have its OWN store instance via this Map.
// NEVER add module-level `let`/`const` state outside this Map — that state
// would be shared across panels and cause cross-panel message leaks.
// BROKE BEFORE: 6+ commits (1f7fc04 → c927dd2) fixing cross-panel streaming leaks
// caused by agents adding global state instead of per-panel state.

const stores = new Map<string, MessagesStoreApi>();
const DEFAULT_ID = '__default__';
stores.set(DEFAULT_ID, createMessagesStoreImpl());

export function getMessagesStore(storeId?: string): MessagesStoreApi {
  const id = storeId || DEFAULT_ID;
  let s = stores.get(id);
  if (!s) {
    s = createMessagesStoreImpl();
    stores.set(id, s);
  }
  return s;
}

export const useMessagesStore = getMessagesStore();

// ── Non-reactive accessors ──

function _store(storeId?: string) {
  return getMessagesStore(storeId).getState();
}

export function getMessages(storeId?: string): ChatMessage[] {
  return _store(storeId).messages;
}
export function setMessages(msgs: ChatMessage[], storeId?: string): void {
  getMessagesStore(storeId).getState().setMessages(msgs);
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

export function findStreamingAssistant(storeId?: string): { msg: AssistantMessage; idx: number } | null {
  const msgs = _store(storeId).messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && (m as AssistantMessage).status === 'streaming') {
      return { msg: m as AssistantMessage, idx: i };
    }
  }
  return null;
}
