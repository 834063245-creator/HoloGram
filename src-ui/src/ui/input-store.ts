// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 输入存储 — 文本输入、文件附件、输入历史。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';

interface InputStore {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  inputHistory: string[];
  inputHistoryIdx: number;
  draftText: string;

  setInputText: (text: string) => void;
  setAttachedFiles: (files: Array<{ path: string; name: string; size: number }>) => void;
  addAttachedFile: (file: { path: string; name: string; size: number }) => void;
  removeAttachedFile: (idx: number) => void;
  clearAttachedFiles: () => void;
  pushInputHistory: (text: string) => void;
  setInputHistory: (history: string[]) => void;
  setInputHistoryIdx: (idx: number) => void;
  setDraftText: (text: string) => void;
}

export type InputStoreApi = ReturnType<typeof createInputStoreImpl>;

function createInputStoreImpl() {
  return create<InputStore>((set) => ({
    inputText: '',
    attachedFiles: [],
    inputHistory: [],
    inputHistoryIdx: -1,
    draftText: '',

    setInputText: (inputText) => set({ inputText }),
    setAttachedFiles: (attachedFiles) => set({ attachedFiles }),
    addAttachedFile: (file) => set((s) => ({ attachedFiles: [...s.attachedFiles, file] })),
    removeAttachedFile: (idx) => set((s) => ({ attachedFiles: s.attachedFiles.filter((_, i) => i !== idx) })),
    clearAttachedFiles: () => set({ attachedFiles: [] }),
    pushInputHistory: (text) =>
      set((s) => {
        const filtered = s.inputHistory.filter((t) => t !== text);
        if (filtered.length >= 50) filtered.shift();
        return { inputHistory: [...filtered, text] };
      }),
    setInputHistory: (inputHistory) => set({ inputHistory }),
    setInputHistoryIdx: (inputHistoryIdx) => set({ inputHistoryIdx }),
    setDraftText: (draftText) => set({ draftText }),
  }));
}

// ── 每面板注册表 ──

// ponytail: 将 store Map 存在 window 上，这样 Vite HMR 不会清除它
// （模块级变量在热重载时重新初始化，会破坏 React 订阅）。
const INPUT_STORES_KEY = '__hologram_input_stores__';
const DEFAULT_ID = '__default__';

function _storesMap(): Map<string, InputStoreApi> {
  const w = window as any;
  if (!w[INPUT_STORES_KEY]) {
    const m = new Map<string, InputStoreApi>();
    m.set(DEFAULT_ID, createInputStoreImpl());
    w[INPUT_STORES_KEY] = m;
  }
  return w[INPUT_STORES_KEY] as Map<string, InputStoreApi>;
}

export function getInputStore(storeId?: string): InputStoreApi {
  const id = storeId || DEFAULT_ID;
  const stores = _storesMap();
  let s = stores.get(id);
  if (!s) {
    s = createInputStoreImpl();
    stores.set(id, s);
  }
  return s;
}

/** 从注册表中移除面板的输入存储。 */
export function disposeInputStore(storeId: string): void {
  _storesMap().delete(storeId);
}

// ── 非响应式访问器 ──

function _store(storeId?: string) {
  return getInputStore(storeId).getState();
}

export function getInputText(storeId?: string): string {
  return _store(storeId).inputText;
}
export function getAttachedFiles(storeId?: string): Array<{ path: string; name: string; size: number }> {
  return _store(storeId).attachedFiles;
}
export function getInputHistory(storeId?: string): string[] {
  return _store(storeId).inputHistory;
}
export function getInputHistoryIdx(storeId?: string): number {
  return _store(storeId).inputHistoryIdx;
}
export function getDraftText(storeId?: string): string {
  return _store(storeId).draftText;
}
