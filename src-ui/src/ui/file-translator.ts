// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// File Translator — thin wrapper, rendering delegated to React FileTranslatorPanel.tsx.
// Public API unchanged for FileViewer compatibility.
// P3：不再自建 React root —— 渲染会话写入 overlay-store，
// 由 App 树的 FileTranslatorPortal 经 createPortal 挂到 _panelEl（挂载点不变）。

import { useOverlayStore } from './overlay-store';

export class FileTranslator {
  private _panelEl: HTMLDivElement;
  private _dividerEl: HTMLDivElement;
  private _visible = false;
  private _filePath: string | null = null;
  private _onLayoutChange: () => void;
  private _getEditorContent: () => string | null;

  constructor(parentEl: HTMLElement, onLayoutChange: () => void, getEditor: () => any) {
    this._onLayoutChange = onLayoutChange;
    this._getEditorContent = () => {
      try {
        const editor = getEditor();
        return editor?.getModel()?.getValue() ?? null;
      } catch {
        return null;
      }
    };

    this._dividerEl = document.createElement('div');
    this._panelEl = document.createElement('div');

    // Insert before resize handle（挂载点与旧 Controller 一致）
    const resizeHandle = parentEl.querySelector<HTMLElement>('.fv-grip');
    if (resizeHandle) {
      resizeHandle.before(this._dividerEl, this._panelEl);
    } else {
      parentEl.appendChild(this._dividerEl);
      parentEl.appendChild(this._panelEl);
    }
  }

  // ── Public API (unchanged) ──

  translateFile(filePath: string): void {
    // Toggle: if same file, close
    if (this._visible && this._filePath === filePath) {
      this.destroy();
      return;
    }
    this._visible = true;
    this._filePath = filePath;
    this._pushSession(filePath, filePath, this._getEditorContent);
    this._onLayoutChange();
  }

  translateSelection(text: string, _startLine: number, _endLine: number): void {
    this._visible = true;
    this._filePath = null;
    this._pushSession(Date.now(), null, () => text);
    this._onLayoutChange();
  }

  isTranslatingFile(filePath: string): boolean {
    return this._filePath === filePath;
  }

  get visible(): boolean {
    return this._visible;
  }

  detach(): void {
    if (!this._visible) return;
    this._clear();
  }

  destroy(): void {
    this._clear();
  }

  // ── Internal ──

  private _pushSession(key: string | number, filePath: string | null, getContent: () => string | null): void {
    useOverlayStore.getState().setTranslator({
      el: this._panelEl,
      key,
      filePath,
      getEditorContent: getContent,
      onClose: () => this.destroy(),
      onLayoutChange: this._onLayoutChange,
    });
  }

  private _clear(): void {
    this._visible = false;
    this._filePath = null;
    useOverlayStore.getState().setTranslator(null);
    this._onLayoutChange();
  }
}
