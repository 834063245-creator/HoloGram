// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Zustand store — single source of truth for chat state.
// Holds: messages, version (auto-scroll), sessions, activeIdx, session tokens,
// and per-session message model cache.
//
// Non-serializable state (agent handles, DOM refs, callbacks) stays
// in module-level Maps/vars in chat-session.ts — only pure data lives here.

import { create } from 'zustand';
import type { ChatMessage, AssistantMessage } from './message-model';

// ── Session descriptor (serializable subset) ──

export interface ChatSessionMeta {
  id: number;
  label: string;
}

interface ChatStore {
  // ── Messages (current session) ──
  messages: ChatMessage[];
  /** Monotonic version — bumped on every mutation so auto-scroll can react. */
  version: number;

  // ── Sessions ──
  sessions: ChatSessionMeta[];
  activeIdx: number;
  /** Per-session token count — keyed by session id. */
  sessionTokens: Record<number, number>;
  /** Per-session message model cache — keyed by session id. */
  sessionMessageModels: Record<number, ChatMessage[]>;
  nextSessionId: number;

  // ── Actions ──
  setMessages: (msgs: ChatMessage[]) => void;
  /** Call after in-place mutations (push to array, part append) to trigger re-render. */
  bump: () => void;

  setSessions: (sessions: ChatSessionMeta[]) => void;
  setActiveIdx: (idx: number) => void;
  setSessionTokens: (id: number, count: number) => void;
  setSessionMessageModels: (id: number, models: ChatMessage[]) => void;
  removeSession: (id: number) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  version: 0,
  sessions: [],
  activeIdx: -1,
  sessionTokens: {},
  sessionMessageModels: {},
  nextSessionId: 1,

  setMessages: (msgs) => set({ messages: msgs, version: Date.now() }),
  bump: () => set((s) => ({ version: s.version + 1 })),

  setSessions: (sessions) => set({ sessions }),
  setActiveIdx: (activeIdx) => set({ activeIdx }),
  setSessionTokens: (id, count) =>
    set((s) => ({ sessionTokens: { ...s.sessionTokens, [id]: count } })),
  setSessionMessageModels: (id, models) =>
    set((s) => ({ sessionMessageModels: { ...s.sessionMessageModels, [id]: models } })),
  removeSession: (id) =>
    set((s) => {
      const { [id]: _, ...restTokens } = s.sessionTokens;
      const { [id]: __, ...restModels } = s.sessionMessageModels;
      return { sessionTokens: restTokens, sessionMessageModels: restModels };
    }),
}));

// ── Non-reactive accessors (for chat-session, chat.ts) ──

export function getChatMessages(): ChatMessage[] {
  return useChatStore.getState().messages;
}

export function setChatMessages(msgs: ChatMessage[]): void {
  useChatStore.getState().setMessages(msgs);
}

export function bumpChat(): void {
  useChatStore.getState().bump();
}

/** Find the currently streaming assistant message (if any). */
export function findStreamingAssistant(): { msg: AssistantMessage; idx: number } | null {
  const msgs = useChatStore.getState().messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && (m as AssistantMessage).status === 'streaming') {
      return { msg: m as AssistantMessage, idx: i };
    }
  }
  return null;
}

// ── Session accessors ──

export function getSessions(): ChatSessionMeta[] {
  return useChatStore.getState().sessions;
}
export function getActiveIdx(): number {
  return useChatStore.getState().activeIdx;
}
export function getActiveSessionId(): number | null {
  const { sessions, activeIdx } = useChatStore.getState();
  return sessions[activeIdx]?.id ?? null;
}
export function getSessionTokens(): Record<number, number> {
  return useChatStore.getState().sessionTokens;
}
export function getSessionMessageModels(): Record<number, ChatMessage[]> {
  return useChatStore.getState().sessionMessageModels;
}
export function getNextSessionId(): number {
  return useChatStore.getState().nextSessionId;
}
