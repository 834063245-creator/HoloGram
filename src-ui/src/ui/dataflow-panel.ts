// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DataflowPanel — thin wrapper, rendering delegated to React DataflowPanel.tsx.
// Public API unchanged for main.ts compatibility.

import { DataflowPanelController } from './react/DataflowPanel';

export class DataflowPanel {
  private _ctrl: DataflowPanelController;

  constructor(container: HTMLElement) {
    this._ctrl = new DataflowPanelController(container);
  }

  // ── Callback delegate (set by main.ts) ──

  set onParseQuery(fn: ((nl: string) => Promise<string[]>) | undefined) {
    this._ctrl.onParseQuery = fn;
  }

  get onParseQuery(): ((nl: string) => Promise<string[]>) | undefined {
    return this._ctrl.onParseQuery;
  }

  // ── Public API (unchanged) ──

  toggle(): void {
    this._ctrl.toggle();
  }

  open(): void {
    this._ctrl.open();
  }

  close(): void {
    this._ctrl.close();
  }

  isOpen(): boolean {
    return this._ctrl.isOpen();
  }
}
