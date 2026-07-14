// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat store — thin registry over 4 domain stores. No shim, no merged snapshots.
//
//   msg   → messages-store.ts  — messages[], version, streamingAssistantId
//   sess  → session-store.ts   — sessions[], activeIdx, sessionTokens, nextId
//   panel → panel-store.ts     — panelMode, projectPath, toolSchemas, focus
//   input → input-store.ts     — inputText, attachedFiles, inputHistory
//
// Each is a real Zustand store. getState() returns the live internal state;
// direct mutation works as Zustand intends. No temporary snapshot traps.

import type { ChatMessage, AssistantMessage, MessageId } from './message-model';

import {
  getMessagesStore,
  getMessages,
  setMessages,
  bumpMessages,
  getStreamingAssistantId as _msg_streamingId,
  getUserScrolledUp as _msg_scrolledUp,
  getExpandedReasoningSet as _msg_expandedReasoning,
  findStreamingAssistant as _findStreaming,
  type MessagesStoreApi,
} from './messages-store';

import {
  getSessionStore,
  getSessions,
  getActiveIdx,
  getActiveSessionId,
  getSessionTokens,
  getSessionMessageModels,
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

// ── ChatStore handles — direct sub-store access, no shim ──

export interface ChatStoreHandles {
  msg: MessagesStoreApi;
  sess: SessionStoreApi;
  panel: PanelStoreApi;
  input: InputStoreApi;
}

/** Return the 4 domain stores for a given panel. Each is a real Zustand store.
 *  Use `.getState()` for reads, `.setState()` for writes, `.subscribe()` to watch.
 */
export function getChatStore(storeId?: string): ChatStoreHandles {
  const id = storeId || '__default__';
  return {
    msg: getMessagesStore(id),
    sess: getSessionStore(id),
    panel: getPanelStore(id),
    input: getInputStore(id),
  };
}

// ── Convenience accessors (forward storeId to domain stores) ──

export function getChatMessages(storeId?: string) { return getMessages(storeId); }
export function setChatMessages(msgs: ChatMessage[], storeId?: string) { setMessages(msgs, storeId); }
export function bumpChat(storeId?: string) { bumpMessages(storeId); }
export function findStreamingAssistant(storeId?: string) { return _findStreaming(storeId); }

// Streaming
export function getStreamingAssistantId(storeId?: string) { return _msg_streamingId(storeId); }
export function getUserScrolledUp(storeId?: string) { return _msg_scrolledUp(storeId); }
export function getExpandedReasoningSet(storeId?: string) { return _msg_expandedReasoning(storeId); }

// Session (re-exported)
export {
  getSessions,
  getActiveIdx,
  getActiveSessionId,
  getSessionTokens,
  getSessionMessageModels,
  getNextSessionId,
  getMsgIdSeq,
  nextMsgId,
};

// Panel (re-exported)
export {
  getPanelMode,
  getActiveTab,
  getProjectPath,
  getTotalTokensUsed,
  isHistoryOpen,
  getToolFilter,
  getContextFilter,
};

// Input (re-exported)
export {
  getInputText,
  getAttachedFiles,
  getInputHistory,
  getInputHistoryIdx,
  getDraftText,
};
