// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ExecutionState — 统一运行状态管理
//
// 收拢原本散落在 chat.ts / agent.ts / coordinator.ts / permission.ts 中的状态。
// ⚡ 重构：底层从手写 class 替换为 Zustand vanilla store。
//    - 自动订阅管理（不再手写 onChange / _listeners / _notify）
//    - 可序列化状态进 store，不可序列化对象（AbortController / Map）在工厂闭包
//    - 对外 API 完全不变，零迁移成本
//    - 日后引入 React 时，store 可直接作为 hook 使用
// ⚡ 多窗口重构：单例 → 工厂模式。 createExecState() 每次返回独立实例。
//    保留默认 execState 向后兼容。

import { createStore } from 'zustand/vanilla';

// ── Types ──

export type StateChangeListener = () => void;

interface PermCard {
  resolve: (r: { allow: boolean; remember: boolean }) => void;
  cleanup: () => void;
}

// ── Zustand store — serialisable state only ──

interface ExecState {
  isRunning: boolean;
  sessionVersion: number;
  permCardCount: number;
}

// ── Public API type — what createExecState() returns ──

export interface ExecStateInstance {
  // ── 只读属性 ──
  readonly isBusy: boolean;
  readonly isRunning: boolean;
  readonly abortSignal: AbortSignal | undefined;
  readonly sessionVersion: number;
  readonly permCardCount: number;
  // ── 主 Agent 生命周期 ──
  start(): AbortSignal;
  done(): void;
  stop(): void;
  forceReset(): void;

  // ── 会话版本号 ──
  bumpVersion(): number;

  // ── 权限队列 ──
  registerPermCard(resolve: (r: { allow: boolean; remember: boolean }) => void, cleanup: () => void): void;
  enqueuePerm<T>(fn: () => Promise<T>): Promise<T>;
  resetPermQueue(): void;

  // ── 订阅（委托给 Zustand） ──
  onChange(fn: StateChangeListener): () => void;
}

// ── Factory ──

export function createExecState(): ExecStateInstance {
  const store = createStore<ExecState>(() => ({
    isRunning: false,
    sessionVersion: 0,
    permCardCount: 0,
  }));

  // ── Per-instance closures — non-serialisable mutable state ──

  let _abortController: AbortController | null = null;
  let _permQueue: Promise<void> = Promise.resolve();
  let _permCards: PermCard[] = [];

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

  // ── Public API ──

  const self: ExecStateInstance = {
    // ── 只读属性 ──

    get isBusy(): boolean {
      const s = store.getState();
      return s.isRunning || s.permCardCount > 0;
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
      _cancelAllPermissions();
      _permQueue = Promise.resolve();
      _set({ isRunning: false, permCardCount: 0 });
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

    // ── 订阅（委托给 Zustand） ──

    onChange(fn: StateChangeListener): () => void {
      return store.subscribe(fn);
    },
  };

  return self;
}

// ── Default global singleton — backward compatible until all consumers migrate ──

export const execState: ExecStateInstance = createExecState();
