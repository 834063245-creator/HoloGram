// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat store — thin registry over 4 domain stores.
//
//   msg   → messages-store.ts  — per-session messages, streaming flags
//   sess  → session-store.ts   — sessions[], activeIdx, tokens, nextId
//   panel → panel-store.ts     — panelMode, projectPath, toolSchemas, focus
//   input → input-store.ts     — inputText, attachedFiles, inputHistory
//
// Each is a real Zustand store. getState() returns live internal state.

import type { ChatMessage } from './message-model';

import {
  getMessagesStore,
  getStreamingAssistantId as _msg_streamingId,
  getUserScrolledUp as _msg_scrolledUp,
  getExpandedReasoningSet as _msg_expandedReasoning,
  bumpMessages,
  type MessagesStoreApi,
} from './messages-store';

import {
  getSessionStore,
  getSessions,
  getActiveIdx,
  getActiveSessionId,
  getSessionTokens,
  getNextSessionId,
  getMsgIdSeq,
  nextMsgId,
  type SessionStoreApi,
} from './session-store';

import {
  getPanelStore,
  getPanelMode,
  getActiveTab,
  getProjectPath,
  getTotalTokensUsed,
  isHistoryOpen,
  getToolFilter,
  getContextFilter,
  type PanelStoreApi,
} from './panel-store';

import {
  getInputStore,
  getInputText,
  getAttachedFiles,
  getInputHistory,
  getInputHistoryIdx,
  getDraftText,
  type InputStoreApi,
} from './input-store';

// ── Re-export types ──

export type { ChatSessionMeta } from './session-store';
export type { PanelMode, AgentTab, AgentState } from './panel-store';

// ── ChatStore handles — direct sub-store access ──

export interface ChatStoreHandles {
  msg: MessagesStoreApi;
  sess: SessionStoreApi;
  panel: PanelStoreApi;
  input: InputStoreApi;
}

/** Return the 4 domain stores for a given panel. */
export function getChatStore(storeId?: string): ChatStoreHandles {
  const id = storeId || '__default__';
  return {
    msg: getMessagesStore(id),
    sess: getSessionStore(id),
    panel: getPanelStore(id),
    input: getInputStore(id),
  };
}

// ── Per-session messages store ──
// ponytail: each session gets its own messages-store instance.
// This is the ONLY source of truth for a session's messages — no
// panel-level array, no sessionMessageModels cache, no manual sync.

/** Messages store for a specific session (not panel-level). */
export function msgStoreFor(storeId: string, sessionId: number): MessagesStoreApi {
  return getMessagesStore(`${storeId}:${sessionId}`);
}

/** Messages store for the active session. Returns null if no active session. */
export function msgStoreForActive(storeId: string): MessagesStoreApi | null {
  const sess = getSessionStore(storeId).getState();
  const sid = sess.sessions[sess.activeIdx]?.id;
  if (sid == null) return null;
  return msgStoreFor(storeId, sid);
}

/** Bump version on a specific session's messages store. */
export function bumpSession(storeId: string, sessionId: number): void {
  getMessagesStore(`${storeId}:${sessionId}`).getState().bump();
}

// ── Panel-level streaming flags (read from default msg store, migrated to per-session later) ──

export function bumpChat(storeId?: string): void { bumpMessages(storeId); }

// Streaming
export function getStreamingAssistantId(storeId?: string) { return _msg_streamingId(storeId); }
export function getUserScrolledUp(storeId?: string) { return _msg_scrolledUp(storeId); }
export function getExpandedReasoningSet(storeId?: string) { return _msg_expandedReasoning(storeId); }

// Session (re-exported)
export { getSessions, getActiveIdx, getActiveSessionId, getSessionTokens, getNextSessionId, getMsgIdSeq, nextMsgId };

// Panel (re-exported)
export { getPanelMode, getActiveTab, getProjectPath, getTotalTokensUsed, isHistoryOpen, getToolFilter, getContextFilter };

// Input (re-exported)
export { getInputText, getAttachedFiles, getInputHistory, getInputHistoryIdx, getDraftText };
