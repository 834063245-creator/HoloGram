// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// dock-store — 六个 dock 面板的开合状态 + 数据推送的单一事实源（P3）。
// 替代旧 AppShell 的 isOpen 探针 + syncPanels 快照链，以及各 Controller 的私有 _open。
// 面板组件订阅本 store 渲染；main.ts / workspace.ts 经 getState() 写入。

import { create } from 'zustand';
import { cacheCheckResult } from '../agent/state-inject';
import type { CheckResult } from './react/CheckPanel';

export type DockPanelId = 'check' | 'constraints' | 'dataflow' | 'settings' | 'agents';

interface DockState {
  /** 面板开合（dataflow/settings 由 DockPanel 条件挂载；其余常驻 + class 切换保过渡动画） */
  open: Record<DockPanelId, boolean>;
  /** 当前工作区路径（constraints 共用；null = 无项目） */
  projectPath: string | null;
  /** 简报面板当前展示的结果（runCheck 推入；查看历史会临时替换，与旧行为一致） */
  checkResult: CheckResult | null;

  openPanel: (id: DockPanelId) => void;
  closePanel: (id: DockPanelId) => void;
  togglePanel: (id: DockPanelId) => void;
  isOpen: (id: DockPanelId) => boolean;
  setProjectPath: (p: string | null) => void;
  /** 旧 CheckPanel.update() 语义：喂 agent 状态注入缓存 + 失败时自动展开面板 */
  setCheckResult: (r: CheckResult) => void;
  /** 旧 CheckPanel.showHistory() 实际行为：展示该历史结果并展开面板（时间戳从未被消费） */
  showCheckHistory: (r: CheckResult) => void;
}

export const useDockStore = create<DockState>((set, get) => ({
  open: { check: false, constraints: false, dataflow: false, settings: false, agents: false },
  projectPath: null,
  checkResult: null,

  openPanel: (id) => set((st) => ({ open: { ...st.open, [id]: true } })),
  closePanel: (id) => set((st) => ({ open: { ...st.open, [id]: false } })),
  togglePanel: (id) => set((st) => ({ open: { ...st.open, [id]: !st.open[id] } })),
  isOpen: (id) => get().open[id],
  setProjectPath: (p) => set({ projectPath: p }),

  setCheckResult: (r) => {
    // Feed check result to state injection cache so the agent sees it
    cacheCheckResult({
      passed: r.passed,
      violationCount:
        (r.l5_violations?.length || 0) +
        (r.l4_violations?.length || 0) +
        (r.l3_violations?.length || 0) +
        (r.l2_violations?.length || 0),
      newCount: r.new_violations || 0,
      resolvedCount: r.resolved_violations || 0,
      persistentCount: r.persistent_violations || 0,
    });
    set((st) => ({ checkResult: r, open: r.passed ? st.open : { ...st.open, check: true } }));
  },

  showCheckHistory: (r) => set((st) => ({ checkResult: r, open: { ...st.open, check: true } })),
}));
