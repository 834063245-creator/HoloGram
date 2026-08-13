// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentPanelStore — Agent 可观测性面板的单一数据源。
// 参照 dock-store.ts 的模式（create<T>((set, get) => ({...}))）。
//
// 数据来源：
//   - agents / taskBoard：从 runtime 拉取（refresh）
//   - messageFlow：从 MessageBus.subscribe 推送（pushMessage）
//   - alerts：从 RuntimeNotifier.onSubAgentFinished 推送（pushAlert）

import { create } from 'zustand';
import type { AgentSummary } from '../agent/runtime/types';
import type { BoardEntry } from '../agent/task-board';
import type { DiscoveryEntry } from '../agent/discovery-board';
import type { AgentMessage } from '../agent/message-types';

export interface AgentPanelEntry extends AgentSummary {
  children: AgentPanelEntry[];
}

export interface MessageFlowEntry {
  msg: AgentMessage;
  ts: number;
}

export interface LifecycleAlert {
  id: string;
  level: 'warn' | 'info';
  text: string;
  ts: number;
}

interface AgentPanelState {
  agents: AgentSummary[];
  taskBoard: BoardEntry[];
  discoveries: DiscoveryEntry[];
  messageFlow: MessageFlowEntry[];
  alerts: LifecycleAlert[];

  /** runtime 引用 — 供组件轮询时调 refresh */
  runtimeRef: {
    listAgents: () => AgentSummary[];
    getTaskBoard: (sessionId?: string) => { getAllEntries: () => BoardEntry[] };
    getDiscoveryBoard: (sessionId?: string) => { getAll: () => DiscoveryEntry[] };
    setCurrentSession?: (sessionId: string) => void;
    /** 返回某 Agent 实例专属的待办 TaskManager（TasksPanel 订阅/读写当前会话主 Agent）。 */
    getAgentTaskManager?: (agentId: string) => import('../agent/task').TaskManager | null;
  } | null;

  /** 当前活跃会话 ID — 用于 session-scoped board 查询 */
  currentSessionId: string;

  setAgents: (agents: AgentSummary[]) => void;
  setTaskBoard: (entries: BoardEntry[]) => void;
  setDiscoveries: (entries: DiscoveryEntry[]) => void;
  pushMessage: (msg: AgentMessage) => void;
  pushAlert: (alert: Omit<LifecycleAlert, 'ts'>) => void;
  clearAlert: (id: string) => void;
  setRuntime: (rt: AgentPanelState['runtimeRef']) => void;
  setCurrentSessionId: (sid: string) => void;
  /** 全量刷新 — 从 runtime 拉取最新状态 */
  refresh: (runtime: NonNullable<AgentPanelState['runtimeRef']>) => void;
}

const MAX_MESSAGES = 50;
const MAX_ALERTS = 20;

export const useAgentPanelStore = create<AgentPanelState>((set, get) => ({
  agents: [],
  taskBoard: [],
  discoveries: [],
  messageFlow: [],
  alerts: [],
  runtimeRef: null,
  currentSessionId: 'default',

  setAgents: (agents) => set({ agents }),
  setTaskBoard: (entries) => set({ taskBoard: entries }),
  setDiscoveries: (entries) => set({ discoveries: entries }),

  pushMessage: (msg) => {
    const entry: MessageFlowEntry = { msg, ts: Date.now() };
    const flow = [...get().messageFlow, entry];
    if (flow.length > MAX_MESSAGES) flow.shift();
    set({ messageFlow: flow });
  },

  pushAlert: (alert) => {
    const full: LifecycleAlert = { ...alert, ts: Date.now() };
    const existing = get().alerts;
    // 相同 ID 则替换（内容哈希去重）— 防止重复告警堆积
    const idx = existing.findIndex((a) => a.id === alert.id);
    let alerts: LifecycleAlert[];
    if (idx >= 0) {
      alerts = [...existing];
      alerts[idx] = full;
    } else {
      alerts = [...existing, full];
      if (alerts.length > MAX_ALERTS) alerts.shift();
    }
    set({ alerts });
  },

  clearAlert: (id) => set({ alerts: get().alerts.filter((a) => a.id !== id) }),

  setRuntime: (rt) => set({ runtimeRef: rt }),

  setCurrentSessionId: (sid) => set({ currentSessionId: sid }),

  refresh: (runtime) => {
    const sid = get().currentSessionId;
    runtime.setCurrentSession?.(sid);
    set({
      agents: runtime.listAgents(),
      taskBoard: runtime.getTaskBoard(sid).getAllEntries(),
      discoveries: runtime.getDiscoveryBoard(sid).getAll(),
    });
  },
}));
