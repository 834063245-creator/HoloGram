// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Zustand store — single source of truth for chat messages.
// Replaces the manual bumpMessages?.() / shared array reference pattern
// with reactive subscriptions. ChatMessagesApp reads via hook; non-React
// code (chat-session, chat.ts) mutates via getState()/setState().

import { create } from 'zustand';
import type { ChatMessage, AssistantMessage } from './message-model';

interface ChatStore {
  messages: ChatMessage[];
  /** Monotonic version — bumped on every mutation so auto-scroll can react. */
  version: number;

  setMessages: (msgs: ChatMessage[]) => void;
  /** Call after in-place mutations (push to array, part append) to trigger re-render. */
  bump: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  version: 0,

  setMessages: (msgs) => set({ messages: msgs, version: Date.now() }),
  bump: () => set((s) => ({ version: s.version + 1 })),
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
