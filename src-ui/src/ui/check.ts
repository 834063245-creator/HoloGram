// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Check Panel — thin wrapper, rendering delegated to React CheckPanel.tsx.
// Public API unchanged for main.ts compatibility.

export type { CheckResult } from './react/CheckPanel';
import { CheckPanelController } from './react/CheckPanel';

export class CheckPanel {
  private _ctrl: CheckPanelController;

  constructor(container: HTMLElement) {
    this._ctrl = new CheckPanelController(container);
  }

  // ── Public API (unchanged) ──

  update(result: import('./react/CheckPanel').CheckResult): void {
    this._ctrl.update(result);
  }

  showHistory(data: import('./react/CheckPanel').CheckResult, timestamp: string): void {
    this._ctrl.showHistory(data, timestamp);
  }

  getLastResult(): import('./react/CheckPanel').CheckResult | null {
    return this._ctrl.getLastResult();
  }

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

  async loadAndRenderGate(path: string): Promise<void> {
    this._ctrl.open(path);
  }
}
