// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 输入存储 — 文本输入、文件附件、输入历史。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';
import { createScopedStore } from './scoped-store';

/** 单个会话的输入草稿快照 —— 会话切换时保存/恢复。 */
export interface SessionDraft {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  inputHistory: string[];
  inputHistoryIdx: number;
  draftText: string;
}

/** 从 live 输入 store 当前状态提取草稿快照（不含 sessionId）。 */
export function snapshotDraft(s: InputStore): SessionDraft {
  return {
    inputText: s.inputText,
    attachedFiles: s.attachedFiles,
    inputHistory: s.inputHistory,
    inputHistoryIdx: s.inputHistoryIdx,
    draftText: s.draftText,
  };
}

/** 空草稿（用于新建会话 / 清空缓冲槽）。 */
function emptyDraft(): SessionDraft {
  return {
    inputText: '',
    attachedFiles: [],
    inputHistory: [],
    inputHistoryIdx: -1,
    draftText: '',
  };
}

interface InputStore {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  inputHistory: string[];
  inputHistoryIdx: number;
  draftText: string;

  /** 非活跃会话的草稿槽：sessionId → 该会话未发送的输入。live 状态始终只属于活跃会话。 */
  sessionDrafts: Record<number, SessionDraft>;

  setInputText: (text: string) => void;
  setAttachedFiles: (files: Array<{ path: string; name: string; size: number }>) => void;
  addAttachedFile: (file: { path: string; name: string; size: number }) => void;
  removeAttachedFile: (idx: number) => void;
  clearAttachedFiles: () => void;
  pushInputHistory: (text: string) => void;
  setInputHistory: (history: string[]) => void;
  setInputHistoryIdx: (idx: number) => void;
  setDraftText: (text: string) => void;

  /** 把当前 live 草稿存入 sid 槽（会话切离前调用）。 */
  saveSessionDraft: (sid: number) => void;
  /** 把 sid 槽恢复为 live 草稿并删除槽；无槽则清空 live（新会话/未写过草稿）。 */
  restoreSessionDraft: (sid: number) => void;
  /** 删除 sid 槽（关闭会话 / 发送后清理，避免切回时复活已发送文本）。 */
  clearSessionDraft: (sid: number) => void;
  /** 清空全部草稿槽并重置 live 输入（整棵会话树重建，如项目重载）。 */
  clearSessionDrafts: () => void;
}

export type InputStoreApi = ReturnType<typeof createInputStoreImpl>;

function createInputStoreImpl() {
  return create<InputStore>((set) => ({
    inputText: '',
    attachedFiles: [],
    inputHistory: [],
    inputHistoryIdx: -1,
    draftText: '',
    sessionDrafts: {},

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

    saveSessionDraft: (sid) => set((s) => ({ sessionDrafts: { ...s.sessionDrafts, [sid]: snapshotDraft(s) } })),
    restoreSessionDraft: (sid) =>
      set((s) => {
        const saved = s.sessionDrafts[sid];
        const { [sid]: _dropped, ...rest } = s.sessionDrafts;
        return saved ? { ...saved, sessionDrafts: rest } : { ...emptyDraft(), sessionDrafts: rest };
      }),
    clearSessionDraft: (sid) =>
      set((s) => {
        if (!(sid in s.sessionDrafts)) return {};
        const { [sid]: _dropped, ...rest } = s.sessionDrafts;
        return { sessionDrafts: rest };
      }),
    clearSessionDrafts: () =>
      set((s) => ({
        ...emptyDraft(),
        sessionDrafts: {},
      })),
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
