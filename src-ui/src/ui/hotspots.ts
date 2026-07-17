// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Hotspots Panel — thin wrapper, rendering delegated to React HotspotsPanel.tsx.
// Public API unchanged for main.ts compatibility.

import type { StarGraph } from './graph';
import { HotspotsPanelController } from './react/HotspotsPanel';

export class HotspotsPanel {
  private _ctrl: HotspotsPanelController;

  constructor(container: HTMLElement) {
    this._ctrl = new HotspotsPanelController(container);
  }

  // ── Public API (unchanged) ──

  setGraph(sg: StarGraph): void {
    this._ctrl.setGraph(sg);
  }

  setProjectPath(path: string | null): void {
    this._ctrl.setProjectPath(path);
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

  getHotspots(): any[] {
    return this._ctrl.getHotspots();
  }
}
