// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ExecutionState — 统一运行状态管理
//
// 收拢原本散落在 chat.ts / agent.ts / coordinator.ts / permission.ts 中的状态。
// ⚡ 重构：底层从手写 class 替换为 Zustand vanilla store。
//    - 自动订阅管理（不再手写 onChange / _listeners / _notify）
//    - 可序列化状态进 store，不可序列化对象（AbortController / Map）在模块闭包
//    - 对外 API 完全不变，零迁移成本
//    - 日后引入 React 时，store 可直接作为 hook 使用

import { createStore } from 'zustand/vanilla';

// ── Types ──

export type StateChangeListener = () => void;

export type SubAgentStatus = 'Running' | 'Completed' | 'Failed' | 'Stopped';

export interface SubAgentHandle {
  id: string;
  description: string;
  status: SubAgentStatus;
  startedAt: number;
  result?: string;
  error?: string;
}

interface PermCard {
  resolve: (r: { allow: boolean; remember: boolean }) => void;
  cleanup: () => void;
}

interface SubAgentEntry {
  handle: SubAgentHandle;
  abortController: AbortController;
}

// ── Zustand store — serialisable state only ──

interface ExecState {
  isRunning: boolean;
  sessionVersion: number;
  permCardCount: number;
  subAgentCount: number;
  subCompleted: SubAgentHandle[];
}

const MAX_COMPLETED = 20;

const store = createStore<ExecState>(() => ({
  isRunning: false,
  sessionVersion: 0,
  permCardCount: 0,
  subAgentCount: 0,
  subCompleted: [],
}));

// ── Module-level closures — non-serialisable mutable state ──

let _abortController: AbortController | null = null;
let _permQueue: Promise<void> = Promise.resolve();
let _permCards: PermCard[] = [];
let _subAgents = new Map<string, SubAgentEntry>();

function _set(s: Partial<ExecState>): void {
  store.setState(s);
}

function _cancelAllPermissions(): void {
  while (_permCards.length > 0) {
    const p = _permCards.pop()!;
    p.cleanup();
    p.resolve({ allow: false, remember: false });
  }
}

function _addCompleted(handle: SubAgentHandle): void {
  store.setState((s) => {
    const next = [...s.subCompleted, handle];
    return { subCompleted: next.length > MAX_COMPLETED ? next.slice(-MAX_COMPLETED) : next };
  });
}

// ── Public API — identical to the old class-based interface ──

export const execState = {
  // ── 只读属性 ──

  get isBusy(): boolean {
    const s = store.getState();
    return s.isRunning || _subAgents.size > 0 || s.permCardCount > 0;
  },

  get isRunning(): boolean {
    return store.getState().isRunning;
  },

  get abortSignal(): AbortSignal | undefined {
    return _abortController?.signal;
  },

  get sessionVersion(): number {
    return store.getState().sessionVersion;
  },

  get permCardCount(): number {
    return store.getState().permCardCount;
  },

  get subAgentCount(): number {
    return _subAgents.size;
  },

  // ── 主 Agent 生命周期 ──

  start(): AbortSignal {
    _abortController?.abort();
    _abortController = new AbortController();
    _set({ isRunning: true });
    return _abortController.signal;
  },

  done(): void {
    _abortController = null;
    _set({ isRunning: false });
  },

  stop(): void {
    if (_abortController) {
      _abortController.abort();
      _abortController = null;
    }
    for (const [, entry] of _subAgents) {
      entry.abortController.abort();
      entry.handle.status = 'Stopped' as any;
      entry.handle.error = 'stopped by user';
      _addCompleted(entry.handle);
    }
    _subAgents.clear();
    _cancelAllPermissions();
    _permQueue = Promise.resolve();
    _set({ isRunning: false, permCardCount: 0, subAgentCount: 0 });
  },

  forceReset(): void {
    _abortController?.abort();
    _abortController = null;
    _cancelAllPermissions();
    _permQueue = Promise.resolve();
    _set({ isRunning: false, permCardCount: 0 });
  },

  // ── 会话版本号 ──

  bumpVersion(): number {
    const next = store.getState().sessionVersion + 1;
    _set({ sessionVersion: next });
    return next;
  },

  // ── 权限队列 ──

  registerPermCard(resolve: (r: { allow: boolean; remember: boolean }) => void, cleanup: () => void): void {
    _permCards.push({ resolve, cleanup });
  },

  enqueuePerm<T>(fn: () => Promise<T>): Promise<T> {
    _set({ permCardCount: store.getState().permCardCount + 1 });

    const prev = _permQueue;
    const result = prev.then(() => fn());

    result.finally(() => {
      _set({ permCardCount: Math.max(0, store.getState().permCardCount - 1) });
    });

    _permQueue = result.catch(() => {}).then(() => {});
    return result;
  },

  resetPermQueue(): void {
    _cancelAllPermissions();
    _permQueue = Promise.resolve();
    _set({ permCardCount: 0 });
  },

  // ── 子Agent 管理 ──

  registerSubAgent(id: string, handle: SubAgentHandle): AbortController {
    const ac = new AbortController();
    _subAgents.set(id, { handle, abortController: ac });
    _set({ subAgentCount: _subAgents.size });
    return ac;
  },

  subAgentDone(id: string, status: 'Completed' | 'Failed' | 'Stopped', result?: string, error?: string): void {
    const entry = _subAgents.get(id);
    if (!entry) return;
    entry.handle.status = status as any;
    if (result !== undefined) entry.handle.result = result;
    if (error !== undefined) entry.handle.error = error;
    _addCompleted(entry.handle);
    _subAgents.delete(id);
    _set({ subAgentCount: _subAgents.size });
  },

  stopSubAgent(id: string): boolean {
    const entry = _subAgents.get(id);
    if (!entry) return false;
    entry.abortController.abort();
    entry.handle.status = 'Stopped' as any;
    entry.handle.error = 'stopped by user';
    _addCompleted(entry.handle);
    _subAgents.delete(id);
    _set({ subAgentCount: _subAgents.size });
    return true;
  },

  pollCompleted(): SubAgentHandle[] {
    const results = [...store.getState().subCompleted];
    store.setState({ subCompleted: [] });
    return results;
  },

  // ── 订阅（委托给 Zustand） ──

  onChange(fn: StateChangeListener): () => void {
    return store.subscribe(fn);
  },
};
