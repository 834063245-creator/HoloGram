// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：壳状态 — 全局唯一的 zustand store，新 chrome（CommandBar/StatusBar/DockRail/
// CommandPalette/ShortcutsOverlay）的唯一数据源。
// 旧代码（main.ts / graph.ts）通过 getState() 写入；新组件通过 hook 订阅。
// 约定（src/app/README.md）：app/** 不 import ui/events.ts。

import { create } from 'zustand';

/** 星图统计 — 由 StarGraph.updateStatus 写入，StatusBar 遥测区展示 */
export interface GraphStats {
  nodes: number;
  edges: number;
  /** structural / data / temporal 边计数 */
  s: number;
  d: number;
  t: number;
  /** L3 / L4 耦合信号（>0 时显示徽标） */
  l3: number;
  l4: number;
  /** 折叠模式下的星座数（0 = 非折叠） */
  galaxies: number;
}

export type AnalyzingKind = 'open' | 'reanalyze' | null;

interface ShellState {
  /** 当前工作区路径（空 = 未打开） */
  projectPath: string;
  /** 状态栏左侧文本 */
  statusText: string;
  /** 状态日志（环形，上限 15；id 单调递增供 React key 使用） */
  statusLog: Array<{ id: number; msg: string }>;
  /** 星图统计（render 后由 graph.ts 写入） */
  graphStats: GraphStats | null;
  /** 简报违规徽标数（0 = 无） */
  violations: number;
  /** 分析进行中（打开=open / 重分析=reanalyze） */
  analyzing: AnalyzingKind;
  /** 变更回看着色激活 */
  diffActive: boolean;
  /** 社区折叠激活 */
  folded: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;

  /** 写状态文本并压入日志环 */
  pushStatus: (msg: string) => void;
  /** 仅写状态文本（不进日志） */
  setStatusText: (msg: string) => void;
  setProjectPath: (p: string) => void;
  setGraphStats: (g: GraphStats) => void;
  setViolations: (n: number) => void;
  setAnalyzing: (k: AnalyzingKind) => void;
  setDiffActive: (b: boolean) => void;
  setFolded: (b: boolean) => void;
  setPaletteOpen: (b: boolean) => void;
  setShortcutsOpen: (b: boolean) => void;
}

const STATUS_LOG_MAX = 15;
let _logSeq = 0;

export const useShellStore = create<ShellState>((set) => ({
  projectPath: '',
  statusText: '就绪',
  statusLog: [],
  graphStats: null,
  violations: 0,
  analyzing: null,
  diffActive: false,
  folded: false,
  paletteOpen: false,
  shortcutsOpen: false,

  pushStatus: (msg) =>
    set((st) => ({
      statusText: msg,
      statusLog: [...st.statusLog, { id: ++_logSeq, msg }].slice(-STATUS_LOG_MAX),
    })),
  setStatusText: (msg) => set({ statusText: msg }),
  setProjectPath: (p) => set({ projectPath: p }),
  setGraphStats: (g) => set({ graphStats: g }),
  setViolations: (n) => set({ violations: n }),
  setAnalyzing: (k) => set({ analyzing: k }),
  setDiffActive: (b) => set({ diffActive: b }),
  setFolded: (b) => set({ folded: b }),
  setPaletteOpen: (b) => set({ paletteOpen: b }),
  setShortcutsOpen: (b) => set({ shortcutsOpen: b }),
}));
