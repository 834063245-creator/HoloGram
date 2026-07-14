// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat store — backward-compatible shim over 4 domain stores.
//
// State is split across:
//   messages-store.ts — messages[], version, streamingAssistantId, expandedReasoning
//   session-store.ts  — sessions[], activeIdx, sessionTokens, sessionMessageModels, nextId, msgIdSeq
//   panel-store.ts    — panelMode, activeTab, projectPath, tool schemas, metrics, focus, filters
//   input-store.ts    — inputText, attachedFiles, inputHistory, inputHistoryIdx, draftText
//
// This file merges them into a combined getState()/setState()/subscribe() interface
// so that all existing consumers work unchanged. New code should import directly
// from the domain store it needs.

import { useStore } from 'zustand';
import type { ChatMessage, AssistantMessage, MessageId } from './message-model';
import type { ToolSchema } from '../provider/types';

import {
  getMessagesStore,
  useMessagesStore,
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

// ── Re-export types (backward compat) ──

export type { ChatSessionMeta } from './session-store';
export type { PanelMode, AgentTab, AgentState } from './panel-store';

// ── Combined state type (for type inference) ──

type MessagesState = ReturnType<MessagesStoreApi['getState']>;
type SessionState = ReturnType<SessionStoreApi['getState']>;
type PanelState = ReturnType<PanelStoreApi['getState']>;
type InputState = ReturnType<InputStoreApi['getState']>;

// ⚡ ponytail: merged type — manually maintained to match the 4 sub-stores.
// If you add a field to a sub-store, add it here too or the TS compiler will
// catch mismatched selectors at the consumer.
export interface ChatStore extends MessagesState, SessionState, PanelState, InputState {}

export type ChatStoreApi = ReturnType<typeof getChatStore>;

// ── Field → store routing tables ──

const MSG_KEYS = new Set([
  'messages', 'version', 'streamingAssistantId', 'userScrolledUp', 'expandedReasoning',
  'setMessages', 'bump', 'setStreamingAssistantId', 'setUserScrolledUp',
  'addExpandedReasoning', 'deleteExpandedReasoning', 'clearExpandedReasoning',
]);

const SESS_KEYS = new Set([
  'sessions', 'activeIdx', 'sessionTokens', 'sessionMessageModels', 'nextSessionId', 'msgIdSeq',
  'setSessions', 'setActiveIdx', 'setSessionTokens', 'setSessionMessageModels',
  'removeSession', 'setNextSessionId', 'setMsgIdSeq',
]);

const PANEL_KEYS = new Set([
  'panelMode', 'activeTab', 'projectPath', 'toolSchemas', 'totalTokensUsed',
  'toolUsage', 'toolHistory', 'pillEventCount', 'lastAgentState', 'lastUsageText',
  'lastAgentDiag', 'userFocusFile', 'userFocusNode', 'historyOpen', 'toolFilter', 'contextFilter',
  'setPanelMode', 'setActiveTab', 'setProjectPath', 'setToolSchemas', 'setTotalTokensUsed',
  'addToolUsage', 'clearToolUsage', 'clearToolHistory', 'setPillEventCount',
  'bumpPillEventCount', 'setLastAgentState', 'setLastUsageText', 'setLastAgentDiag',
  'setUserFocusFile', 'setUserFocusNode', 'setHistoryOpen', 'setToolFilter', 'setContextFilter',
]);

const INPUT_KEYS = new Set([
  'inputText', 'attachedFiles', 'inputHistory', 'inputHistoryIdx', 'draftText',
  'setInputText', 'setAttachedFiles', 'addAttachedFile', 'removeAttachedFile',
  'clearAttachedFiles', 'pushInputHistory', 'setInputHistory', 'setInputHistoryIdx',
  'setDraftText',
]);

// ── Merge helper ──

function mergeState(storeId?: string): ChatStore {
  return {
    ...getMessagesStore(storeId).getState(),
    ...getSessionStore(storeId).getState(),
    ...getPanelStore(storeId).getState(),
    ...getInputStore(storeId).getState(),
  } as ChatStore;
}

function routePartial(partial: Record<string, unknown>, storeId?: string): void {
  const msgPart: Record<string, unknown> = {};
  const sessPart: Record<string, unknown> = {};
  const panelPart: Record<string, unknown> = {};
  const inputPart: Record<string, unknown> = {};

  for (const k of Object.keys(partial)) {
    if (MSG_KEYS.has(k)) msgPart[k] = partial[k];
    else if (SESS_KEYS.has(k)) sessPart[k] = partial[k];
    else if (PANEL_KEYS.has(k)) panelPart[k] = partial[k];
    else if (INPUT_KEYS.has(k)) inputPart[k] = partial[k];
  }

  if (Object.keys(msgPart).length) getMessagesStore(storeId).setState(msgPart as any);
  if (Object.keys(sessPart).length) getSessionStore(storeId).setState(sessPart as any);
  if (Object.keys(panelPart).length) getPanelStore(storeId).setState(panelPart as any);
  if (Object.keys(inputPart).length) getInputStore(storeId).setState(inputPart as any);
}

// ── Shim registry — one combined facade per panel ──

const shims = new Map<string, ReturnType<typeof createShim>>();

function createShim(storeId: string) {
  const getState = () => mergeState(storeId);

  const setState = (partial: any, _replace?: boolean) => {
    if (typeof partial === 'function') {
      partial = partial(getState());
    }
    routePartial(partial, storeId);
  };

  const subscribe = (listener: (state: any, prevState: any) => void) => {
    let prev = getState();
    const u1 = getMessagesStore(storeId).subscribe((s) => {
      const next = getState();
      listener(next, prev);
      prev = next;
    });
    const u2 = getSessionStore(storeId).subscribe((s) => {
      const next = getState();
      listener(next, prev);
      prev = next;
    });
    const u3 = getPanelStore(storeId).subscribe((s) => {
      const next = getState();
      listener(next, prev);
      prev = next;
    });
    const u4 = getInputStore(storeId).subscribe((s) => {
      const next = getState();
      listener(next, prev);
      prev = next;
    });
    return () => { u1(); u2(); u3(); u4(); };
  };

  return { getState, setState, subscribe };
}

// ── Public API — backward-compatible with old chat-store.ts ──

/** Combined store facade — delegates to the 4 domain stores.
 *  @deprecated New code should import from the specific domain store:
 *    messages-store.ts, session-store.ts, panel-store.ts, input-store.ts */
export function getChatStore(storeId?: string) {
  const id = storeId || '__default__';
  let shim = shims.get(id);
  if (!shim) {
    shim = createShim(id);
    shims.set(id, shim);
  }
  return shim;
}

// ponytail: useStore types require StoreApi<ChatStore> but our shim is {getState,setState,subscribe}.
// Cast through unknown — the runtime API is compatible.
/** Zustand-compatible hook for the combined store.
 *  @deprecated Prefer useMessagesStore / individual domain hooks. */
export function useChatStore<T>(selector: (state: ChatStore) => T): T {
  return (useStore as any)(getChatStore(), selector);
}

// ── Accessor re-exports (all delegate to domain stores) ──

// ponytail: wrapper functions forward storeId so callers can isolate per-panel.
// Direct re-exports would lose the storeId param and fall back to default store.
export function getChatMessages(storeId?: string) { return getMessages(storeId); }
export function setChatMessages(msgs: ChatMessage[], storeId?: string) { setMessages(msgs, storeId); }
export const bumpChat = bumpMessages; // storeId already forwarded by bumpMessages
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
