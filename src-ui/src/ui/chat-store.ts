// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Chat Zustand store — single source of truth for chat state.
//
// Holds three categories:
//   1. Messages (React rendering) — messages[], version
//   2. Sessions (lifecycle) — sessions[], activeIdx, tokens, models, nextId
//   3. Panel state (UI chrome) — mode, tabs, streaming, metrics, focus
//
// Non-serializable state (agent handles, DOM refs, callbacks, rAF handles,
// AbortControllers) stays in chat.ts / chat-session.ts.

import { create } from 'zustand';
import type { ChatMessage, AssistantMessage, MessageId } from './message-model';
import type { ToolSchema } from '../provider/types';

// ── Session descriptor (serializable subset) ──

export interface ChatSessionMeta {
  id: number;
  label: string;
}

export type PanelMode = 'pill' | 'input' | 'panel' | 'hud';
export type AgentTab = 'chat' | 'tools' | 'context';
export type AgentState = 'idle' | 'thinking' | 'running' | 'error';

interface ToolHistoryEntry { name: string; args: string; ts: number }

interface ChatStore {
  // ── Messages ──
  messages: ChatMessage[];
  version: number;

  // ── Sessions ──
  sessions: ChatSessionMeta[];
  activeIdx: number;
  sessionTokens: Record<number, number>;
  sessionMessageModels: Record<number, ChatMessage[]>;
  nextSessionId: number;
  msgIdSeq: number;

  // ── Panel chrome ──
  panelMode: PanelMode;
  activeTab: AgentTab;
  projectPath: string;
  toolSchemas: ToolSchema[];

  // ── Streaming ──
  streamingAssistantId: MessageId | null;
  userScrolledUp: boolean;
  /** Reasoning block indices that are manually expanded (kept as number[] — Set is non-serializable). */
  expandedReasoning: number[];

  // ── Metrics / counters ──
  totalTokensUsed: number;
  toolUsage: Record<string, number>;
  toolHistory: ToolHistoryEntry[];
  pillEventCount: number;
  lastAgentState: AgentState;
  lastUsageText: string;
  lastAgentDiag: string;

  // ── User context (injected into agent hooks) ──
  userFocusFile: string | null;
  userFocusNode: { name: string; location?: string } | null;

  // ── Actions ──
  setMessages: (msgs: ChatMessage[]) => void;
  bump: () => void;

  setSessions: (sessions: ChatSessionMeta[]) => void;
  setActiveIdx: (idx: number) => void;
  setSessionTokens: (id: number, count: number) => void;
  setSessionMessageModels: (id: number, models: ChatMessage[]) => void;
  removeSession: (id: number) => void;

  setPanelMode: (mode: PanelMode) => void;
  setActiveTab: (tab: AgentTab) => void;
  setProjectPath: (path: string) => void;
  setToolSchemas: (schemas: ToolSchema[]) => void;

  setStreamingAssistantId: (id: MessageId | null) => void;
  setUserScrolledUp: (v: boolean) => void;
  addExpandedReasoning: (idx: number) => void;
  deleteExpandedReasoning: (idx: number) => void;
  clearExpandedReasoning: () => void;

  setTotalTokensUsed: (n: number) => void;
  addToolUsage: (name: string, args: string) => void;
  clearToolUsage: () => void;
  clearToolHistory: () => void;
  setPillEventCount: (n: number) => void;
  bumpPillEventCount: () => void;
  setLastAgentState: (state: AgentState) => void;
  setLastUsageText: (s: string) => void;
  setLastAgentDiag: (s: string) => void;

  setUserFocusFile: (file: string | null) => void;
  setUserFocusNode: (node: { name: string; location?: string } | null) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  version: 0,
  sessions: [],
  activeIdx: -1,
  sessionTokens: {},
  sessionMessageModels: {},
  nextSessionId: 1,
  msgIdSeq: 0,

  panelMode: 'pill',
  activeTab: 'chat',
  projectPath: '',
  toolSchemas: [],

  streamingAssistantId: null,
  userScrolledUp: false,
  expandedReasoning: [],

  totalTokensUsed: 0,
  toolUsage: {},
  toolHistory: [],
  pillEventCount: 0,
  lastAgentState: 'idle',
  lastUsageText: '',
  lastAgentDiag: '',

  userFocusFile: null,
  userFocusNode: null,

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

  setPanelMode: (panelMode) => set({ panelMode }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setToolSchemas: (toolSchemas) => set({ toolSchemas }),

  setStreamingAssistantId: (streamingAssistantId) => set({ streamingAssistantId }),
  setUserScrolledUp: (userScrolledUp) => set({ userScrolledUp }),
  addExpandedReasoning: (idx) =>
    set((s) => {
      if (s.expandedReasoning.includes(idx)) return s;
      return { expandedReasoning: [...s.expandedReasoning, idx] };
    }),
  deleteExpandedReasoning: (idx) =>
    set((s) => ({ expandedReasoning: s.expandedReasoning.filter(i => i !== idx) })),
  clearExpandedReasoning: () => set({ expandedReasoning: [] }),

  setTotalTokensUsed: (totalTokensUsed) => set({ totalTokensUsed }),
  addToolUsage: (name, args) =>
    set((s) => {
      const next = { ...s.toolUsage };
      next[name] = (next[name] || 0) + 1;
      const hist = [...s.toolHistory, { name, args, ts: Date.now() }].slice(-50);
      return { toolUsage: next, toolHistory: hist };
    }),
  clearToolUsage: () => set({ toolUsage: {} }),
  clearToolHistory: () => set({ toolHistory: [] }),
  setPillEventCount: (pillEventCount) => set({ pillEventCount }),
  bumpPillEventCount: () => set((s) => ({ pillEventCount: s.pillEventCount + 1 })),
  setLastAgentState: (lastAgentState) => set({ lastAgentState }),
  setLastUsageText: (lastUsageText) => set({ lastUsageText }),
  setLastAgentDiag: (lastAgentDiag) => set({ lastAgentDiag }),

  setUserFocusFile: (userFocusFile) => set({ userFocusFile }),
  setUserFocusNode: (userFocusNode) => set({ userFocusNode }),
}));

// ── Non-reactive accessors ──

export function getChatMessages(): ChatMessage[] {
  return useChatStore.getState().messages;
}
export function setChatMessages(msgs: ChatMessage[]): void {
  useChatStore.getState().setMessages(msgs);
}
export function bumpChat(): void {
  useChatStore.getState().bump();
}
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

export function getSessions(): ChatSessionMeta[] { return useChatStore.getState().sessions; }
export function getActiveIdx(): number { return useChatStore.getState().activeIdx; }
export function getActiveSessionId(): number | null {
  const { sessions, activeIdx } = useChatStore.getState();
  return sessions[activeIdx]?.id ?? null;
}
export function getSessionTokens(): Record<number, number> { return useChatStore.getState().sessionTokens; }
export function getSessionMessageModels(): Record<number, ChatMessage[]> { return useChatStore.getState().sessionMessageModels; }
export function getNextSessionId(): number { return useChatStore.getState().nextSessionId; }

// ── Panel chrome accessors ──

export function getPanelMode(): PanelMode { return useChatStore.getState().panelMode; }
export function getActiveTab(): AgentTab { return useChatStore.getState().activeTab; }
export function getProjectPath(): string { return useChatStore.getState().projectPath; }

// ── Streaming accessors ──

export function getStreamingAssistantId(): MessageId | null { return useChatStore.getState().streamingAssistantId; }
export function getUserScrolledUp(): boolean { return useChatStore.getState().userScrolledUp; }
export function getExpandedReasoningSet(): Set<number> {
  return new Set(useChatStore.getState().expandedReasoning);
}
