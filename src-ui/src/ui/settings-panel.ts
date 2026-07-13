// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings Panel — thin wrapper, rendering delegated to React SettingsPanel.tsx.
// Public API unchanged for main.ts compatibility.

import { SettingsPanelController } from './react/SettingsPanel';

export class SettingsPanel {
  private static instance: SettingsPanel | null = null;
  private _ctrl: SettingsPanelController;

  static get(): SettingsPanel {
    if (!SettingsPanel.instance) {
      SettingsPanel.instance = new SettingsPanel();
    }
    return SettingsPanel.instance;
  }

  private constructor() {
    this._ctrl = new SettingsPanelController();
  }

  // ── Public API (unchanged) ──

  setOnSave(fn: () => void): void { this._ctrl.setOnSave(fn); }
  isOpen(): boolean { return this._ctrl.isOpen(); }
  open(): void { this._ctrl.open(); }
  close(): void { this._ctrl.close(); }
  toggle(): void { this._ctrl.toggle(); }
}
