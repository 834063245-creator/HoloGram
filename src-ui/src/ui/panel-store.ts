// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Panel store — UI chrome: tabs, tools, metrics, focus, filters.
// Split from chat-store.ts (god store → domain stores).

import { create } from 'zustand';
import type { ToolSchema } from '../provider/types';

export type PanelMode = 'pill' | 'input' | 'panel' | 'hud';
export type AgentTab = 'chat' | 'tools' | 'context';
export type AgentState = 'idle' | 'thinking' | 'running' | 'error';

interface ToolHistoryEntry {
  name: string;
  args: string;
  ts: number;
}

interface PanelStore {
  panelMode: PanelMode;
  activeTab: AgentTab;
  projectPath: string;
  toolSchemas: ToolSchema[];
  totalTokensUsed: number;
  toolUsage: Record<string, number>;
  toolHistory: ToolHistoryEntry[];
  pillEventCount: number;
  lastAgentState: AgentState;
  lastUsageText: string;
  lastAgentDiag: string;
  userFocusFile: string | null;
  userFocusNode: { name: string; location?: string } | null;
  historyOpen: boolean;
  toolFilter: string;
  contextFilter: string;

  setPanelMode: (mode: PanelMode) => void;
  setActiveTab: (tab: AgentTab) => void;
  setProjectPath: (path: string) => void;
  setToolSchemas: (schemas: ToolSchema[]) => void;
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
  setHistoryOpen: (open: boolean) => void;
  setToolFilter: (filter: string) => void;
  setContextFilter: (filter: string) => void;
}

export type PanelStoreApi = ReturnType<typeof createPanelStoreImpl>;

function createPanelStoreImpl() {
  return create<PanelStore>((set) => ({
    panelMode: 'pill' as PanelMode,
    activeTab: 'chat' as AgentTab,
    projectPath: '',
    toolSchemas: [],
    totalTokensUsed: 0,
    toolUsage: {},
    toolHistory: [],
    pillEventCount: 0,
    lastAgentState: 'idle' as AgentState,
    lastUsageText: '',
    lastAgentDiag: '',
    userFocusFile: null,
    userFocusNode: null,
    historyOpen: false,
    toolFilter: '',
    contextFilter: '',

    setPanelMode: (panelMode) => set({ panelMode }),
    setActiveTab: (activeTab) => set({ activeTab }),
    setProjectPath: (projectPath) => set({ projectPath }),
    setToolSchemas: (toolSchemas) => set({ toolSchemas }),
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
    setHistoryOpen: (historyOpen) => set({ historyOpen }),
    setToolFilter: (toolFilter) => set({ toolFilter }),
    setContextFilter: (contextFilter) => set({ contextFilter }),
  }));
}

// ── Per-panel registry ──

const stores = new Map<string, PanelStoreApi>();
const DEFAULT_ID = '__default__';
stores.set(DEFAULT_ID, createPanelStoreImpl());

export function getPanelStore(storeId?: string): PanelStoreApi {
  const id = storeId || DEFAULT_ID;
  let s = stores.get(id);
  if (!s) {
    s = createPanelStoreImpl();
    stores.set(id, s);
  }
  return s;
}

// ── Non-reactive accessors ──

function _store(storeId?: string) {
  return getPanelStore(storeId).getState();
}

export function getPanelMode(storeId?: string): PanelMode {
  return _store(storeId).panelMode;
}
export function getActiveTab(storeId?: string): AgentTab {
  return _store(storeId).activeTab;
}
export function getProjectPath(storeId?: string): string {
  return _store(storeId).projectPath;
}
export function getTotalTokensUsed(storeId?: string): number {
  return _store(storeId).totalTokensUsed;
}
export function isHistoryOpen(storeId?: string): boolean {
  return _store(storeId).historyOpen;
}
export function getToolFilter(storeId?: string): string {
  return _store(storeId).toolFilter;
}
export function getContextFilter(storeId?: string): string {
  return _store(storeId).contextFilter;
}
