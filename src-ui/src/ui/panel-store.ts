// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板存储 — UI 外壳：标签页、工具、指标、焦点、过滤。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';
import { createScopedStore } from './scoped-store';
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

// ── 每面板注册表 ──

const scoped = createScopedStore('__hologram_panel_stores__', createPanelStoreImpl);

export const getPanelStore = scoped.getStore;

/** 从注册表中移除面板的 store。
 *  （2026-08-04：生产暂未接线，但有单元测试保护 — disposePanelStores 的组成部分） */
export function disposePanelStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

// ── 非响应式访问器 ──
// （2026-08-04 清理：getPanelMode/getActiveTab/getTotalTokensUsed/isHistoryOpen/
//   getToolFilter/getContextFilter 全工程零调用，已删）
