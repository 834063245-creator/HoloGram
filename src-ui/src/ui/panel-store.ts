// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Panel store — UI chrome: tabs, tools, metrics, focus, filters.
// Split from chat-store.ts (god store → domain stores).

import { create } from 'zustand';
import type { GoalRecord } from '../agent/goal-manager';
import type { ToolSchema } from '../provider/types';

export type PanelMode = 'pill' | 'input' | 'panel' | 'hud';
export type AgentTab = 'chat' | 'tools' | 'context';
export type AgentState = 'idle' | 'thinking' | 'running' | 'error';
export type CollaborationMode = 'normal' | 'plan';
export type PermissionMode = 'ask' | 'auto' | 'yolo';

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
  collaborationMode: CollaborationMode;
  permissionMode: PermissionMode;
  /** P2′：goal 状态条记录（GoalStrip 组件数据源；active/paused 时有值） */
  goalRecord: GoalRecord | null;
  /** P2′：Agent 状态详情文本（如 '分析中…'；null 用默认标签） */
  lastAgentDetail: string | null;

  setPanelMode: (mode: PanelMode) => void;
  setCollaborationMode: (mode: CollaborationMode) => void;
  setPermissionMode: (mode: PermissionMode) => void;
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
  setGoalRecord: (r: GoalRecord | null) => void;
  setLastAgentDetail: (s: string | null) => void;
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
    collaborationMode: 'normal' as CollaborationMode,
    permissionMode: 'ask' as PermissionMode,
    goalRecord: null,
    lastAgentDetail: null,

    setPanelMode: (panelMode) => set({ panelMode }),
    setCollaborationMode: (collaborationMode) => set({ collaborationMode }),
    setPermissionMode: (permissionMode) => set({ permissionMode }),
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
    setGoalRecord: (goalRecord) => set({ goalRecord }),
    setLastAgentDetail: (lastAgentDetail) => set({ lastAgentDetail }),
  }));
}

// ── Per-panel registry ──

// ponytail: store Map on window so Vite HMR doesn't wipe it (module-level
// variables are re-initialized on hot reload, breaking React subscriptions).
const PANEL_STORES_KEY = '__hologram_panel_stores__';
const DEFAULT_ID = '__default__';

function _storesMap(): Map<string, PanelStoreApi> {
  const w = window as any;
  if (!w[PANEL_STORES_KEY]) {
    const m = new Map<string, PanelStoreApi>();
    m.set(DEFAULT_ID, createPanelStoreImpl());
    w[PANEL_STORES_KEY] = m;
  }
  return w[PANEL_STORES_KEY] as Map<string, PanelStoreApi>;
}

export function getPanelStore(storeId?: string): PanelStoreApi {
  const id = storeId || DEFAULT_ID;
  const stores = _storesMap();
  let s = stores.get(id);
  if (!s) {
    s = createPanelStoreImpl();
    stores.set(id, s);
  }
  return s;
}

/** Remove a panel's store from the registry. */
export function disposePanelStore(storeId: string): void {
  _storesMap().delete(storeId);
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
