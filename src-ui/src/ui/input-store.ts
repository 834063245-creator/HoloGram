// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Input store — text input, file attachments, input history.
// Split from chat-store.ts (god store → domain stores).

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

// ── Per-panel registry ──

// ponytail: store Map on window so Vite HMR doesn't wipe it (module-level
// variables are re-initialized on hot reload, breaking React subscriptions).
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

/** Remove a panel's input store from the registry. */
export function disposeInputStore(storeId: string): void {
  _storesMap().delete(storeId);
}

// ── Non-reactive accessors ──

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
