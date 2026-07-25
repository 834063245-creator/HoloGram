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
  /** Commit an in-place mutation of one message: swaps its array slot for a
   *  shallow copy and bumps version. See SINGLE WRITE PATH RULE below. */
  touchMessage: (id: MessageId) => void;
  /** Same as touchMessage, but locates the message by a part object it
   *  contains (identity match). Survives session rebuilds that re-attach the
   *  same part object to a new message. */
  touchMessageContaining: (part: object) => void;
  setStreamingAssistantId: (id: MessageId | null) => void;
  setUserScrolledUp: (v: boolean) => void;
  addExpandedReasoning: (idx: number) => void;
  deleteExpandedReasoning: (idx: number) => void;
  clearExpandedReasoning: () => void;
}

// ── SINGLE WRITE PATH RULE ────────────────────────────────
// The chat data model mutates message/part objects in place (streaming text
// does `part.text += chunk` — copying per token is too expensive). React,
// however, observes changes by REFERENCE. Bridging that gap is the store's
// job, not the caller's:
//
//   ⚠️ After ANY in-place mutation of an existing message or one of its
//   parts, you MUST commit through touchMessage / touchMessageContaining.
//   NEVER follow a mutation with a bare `bump()` or a manual
//   `setState({ messages: [...] })` — the array spread does not change
//   message references, and memoized bubbles silently skip the update
//   (this was the recurring "card stuck / last frame lost" bug class).
//
// Adding a new mutation path (new event kind, new lifecycle hook)? Mutate,
// then touch. That is the whole rule.

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

// ── Per-panel registry ──
// ⚠️ INVARIANT: Every panel must have its OWN store instance via this Map.
// NEVER add module-level `let`/`const` state outside this Map — that state
// would be shared across panels and cause cross-panel message leaks.
// BROKE BEFORE: 6+ commits (1f7fc04 → c927dd2) fixing cross-panel streaming leaks
// caused by agents adding global state instead of per-panel state.

const STORES_KEY = '__hologram_msg_stores__';
const DEFAULT_ID = '__default__';

function _storesMap(): Map<string, MessagesStoreApi> {
  const w = window as any;
  if (!w[STORES_KEY]) {
    const m = new Map<string, MessagesStoreApi>();
    m.set(DEFAULT_ID, createMessagesStoreImpl());
    w[STORES_KEY] = m;
  }
  return w[STORES_KEY] as Map<string, MessagesStoreApi>;
}

export function getMessagesStore(storeId?: string): MessagesStoreApi {
  const id = storeId || DEFAULT_ID;
  const stores = _storesMap();
  let s = stores.get(id);
  if (!s) {
    s = createMessagesStoreImpl();
    stores.set(id, s);
  }
  return s;
}

/** Remove all stores whose key starts with the given prefix (e.g. a panelId).
 *  Also removes per-session stores (panelId:sessionId). */
export function disposeMessagesStores(storeId: string): void {
  const stores = _storesMap();
  for (const key of Array.from(stores.keys())) {
    if (key === storeId || key.startsWith(`${storeId}:`)) {
      stores.delete(key);
    }
  }
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
