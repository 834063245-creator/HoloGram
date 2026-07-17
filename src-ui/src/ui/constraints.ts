// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Constraints Panel — thin wrapper, rendering delegated to React ConstraintsPanel.tsx.
// Public API unchanged for main.ts compatibility.

import { ConstraintsPanelController } from './react/ConstraintsPanel';

export class ConstraintsPanel {
  private _ctrl: ConstraintsPanelController;

  private static instance: ConstraintsPanel | null = null;

  static get(): ConstraintsPanel {
    if (!ConstraintsPanel.instance) {
      ConstraintsPanel.instance = new ConstraintsPanel();
    }
    return ConstraintsPanel.instance;
  }

  constructor() {
    this._ctrl = new ConstraintsPanelController();
  }

  // ── Public API (unchanged) ──

  load(projectPath: string): void {
    this._ctrl.load(projectPath);
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
}
