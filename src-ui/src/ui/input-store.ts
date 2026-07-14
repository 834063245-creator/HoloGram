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

const stores = new Map<string, InputStoreApi>();
const DEFAULT_ID = '__default__';
stores.set(DEFAULT_ID, createInputStoreImpl());

export function getInputStore(storeId?: string): InputStoreApi {
  const id = storeId || DEFAULT_ID;
  let s = stores.get(id);
  if (!s) {
    s = createInputStoreImpl();
    stores.set(id, s);
  }
  return s;
}

// ── Non-reactive accessors ──

function _store(storeId?: string) { return getInputStore(storeId).getState(); }

export function getInputText(storeId?: string): string { return _store(storeId).inputText; }
export function getAttachedFiles(storeId?: string): Array<{ path: string; name: string; size: number }> {
  return _store(storeId).attachedFiles;
}
export function getInputHistory(storeId?: string): string[] { return _store(storeId).inputHistory; }
export function getInputHistoryIdx(storeId?: string): number { return _store(storeId).inputHistoryIdx; }
export function getDraftText(storeId?: string): string { return _store(storeId).draftText; }
