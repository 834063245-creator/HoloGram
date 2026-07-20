// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// overlay-store — 收编进单 React 树的覆盖层渲染目标（P3）：
// ContextMenu（原懒 root）与 FileTranslator（原 FileViewer 内独立 root）经 portal 渲染。

import { create } from 'zustand';
import type { ContextMenuItem } from './react/ContextMenu';

export interface ContextMenuRequest {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** FileTranslator 的一次渲染会话（file-translator wrapper 写入，App 侧 portal 消费） */
export interface TranslatorSession {
  /** portal 挂载点（FileViewer 内、.fv-grip 之前的面板元素） */
  el: HTMLElement;
  /** React key（旧 Controller 语义：filePath || Date.now()） */
  key: string | number;
  filePath: string | null;
  getEditorContent: () => string | null;
  onClose: () => void;
  onLayoutChange: () => void;
}

interface OverlayState {
  contextMenu: ContextMenuRequest | null;
  translator: TranslatorSession | null;
  showContextMenu: (req: ContextMenuRequest) => void;
  dismissContextMenu: () => void;
  setTranslator: (s: TranslatorSession | null) => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  contextMenu: null,
  translator: null,
  showContextMenu: (req) => set({ contextMenu: req }),
  dismissContextMenu: () => set({ contextMenu: null }),
  setTranslator: (s) => set({ translator: s }),
}));
