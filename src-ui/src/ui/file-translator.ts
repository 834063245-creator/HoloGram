// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// File Translator — thin wrapper, rendering delegated to React FileTranslatorPanel.tsx.
// Public API unchanged for FileViewer compatibility.

import { FileTranslatorController } from './react/FileTranslatorPanel';

export class FileTranslator {
  private _ctrl: FileTranslatorController;

  constructor(
    parentEl: HTMLElement,
    onLayoutChange: () => void,
    getEditor: () => any,
  ) {
    this._ctrl = new FileTranslatorController(parentEl, onLayoutChange, () => {
      try {
        const editor = getEditor();
        return editor?.getModel()?.getValue() ?? null;
      } catch {
        return null;
      }
    });
  }

  // ── Public API (unchanged) ──

  translateFile(filePath: string): void {
    this._ctrl.translateFile(filePath);
  }

  translateSelection(text: string, startLine: number, endLine: number): void {
    this._ctrl.translateSelection(text, startLine, endLine);
  }

  isTranslatingFile(filePath: string): boolean {
    return this._ctrl.isTranslatingFile(filePath);
  }

  get visible(): boolean {
    return this._ctrl.visible;
  }

  detach(): void {
    this._ctrl.detach();
  }

  destroy(): void {
    this._ctrl.destroy();
  }
}
