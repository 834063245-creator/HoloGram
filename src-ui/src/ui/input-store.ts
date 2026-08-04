// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 输入存储 — 文本输入、文件附件、输入历史。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';
import { createScopedStore } from './scoped-store';

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

const scoped = createScopedStore('__hologram_input_stores__', createInputStoreImpl);

export const getInputStore = scoped.getStore;

/** 从注册表中移除面板的输入存储。
 *  （2026-08-04：生产暂未接线，但有单元测试保护 — disposePanelStores 的组成部分） */
export function disposeInputStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

// ── 非响应式访问器 ──
// （2026-08-04 清理：getInputText/getAttachedFiles/getInputHistory/getInputHistoryIdx/
//   getDraftText 全工程零调用，已删）
