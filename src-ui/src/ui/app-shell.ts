// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AppShell — 应用级 UI 外壳
// 管理面板生命周期、dock tab 更新、以及跨面板的命令式操作（导航、高亮、Agent 查询）。
// 不负责项目级状态（那归 Workspace），不负责纯通知（那归 bus）。
//
// 使用方式：
//   import { shell } from './app-shell';
//   shell.notifyPanelChanged();       // 替代 bus.emit('panel:toggle')
//   shell.navigateToNode(name);   // 替代 bus.emit('navigate:node', name)
//   shell.highlightFile(path);    // 替代 bus.emit('highlight:file', path)
//
// 每条命令执行后同时通过 bus 广播通知，供 chat.ts 等模块做上下文跟踪。

import { bus } from './events';

export interface AppPanel {
  readonly id: string;
  isOpen(): boolean;
}

/**
 * shell 本身是模块级单例——跟 bus 一样的 import 模式。
 * 所有面板 import { shell } 即可，不需要构造传参。
 */
class AppShell {
  // ── Panel registry ──
  private _panels = new Map<string, AppPanel>();

  // ── Wiring slots (set by main.ts) ──
  private _onPanelChanged: (() => void) | null = null;
  private _navigateToNode: ((name: string) => void) | null = null;
  private _navigateToFile: ((path: string) => void) | null = null;
  private _highlightFile: ((path: string) => void) | null = null;
  private _highlightFolder: ((path: string) => void) | null = null;
  private _clearHighlight: (() => void) | null = null;
  private _queryAgent: ((question: string) => void) | null = null;

  // ═══════════════════════════════════════════════════════════════
  // Panel registry (main.ts registers each panel)
  // ═══════════════════════════════════════════════════════════════

  register(panel: AppPanel): void {
    this._panels.set(panel.id, panel);
  }

  isOpen(id: string): boolean {
    return this._panels.get(id)?.isOpen() ?? false;
  }

  /** 获取已注册的面板 ID 列表 */
  get panelIds(): string[] {
    return [...this._panels.keys()];
  }

  // ═══════════════════════════════════════════════════════════════
  // Wiring (called once by main.ts during init)
  // ═══════════════════════════════════════════════════════════════

  /** 面板开关后调用 → 驱动 dock tab 更新 */
  set onPanelChanged(fn: () => void) {
    this._onPanelChanged = fn;
  }

  /** 注入导航/高亮/查询处理函数 — 由 main.ts 在 starGraph/chatPanel 创建后调用 */
  wire(opts: {
    navigateToNode: (name: string) => void;
    navigateToFile: (path: string) => void;
    highlightFile: (path: string) => void;
    highlightFolder: (path: string) => void;
    clearHighlight: () => void;
    queryAgent: (question: string) => void;
  }): void {
    this._navigateToNode = opts.navigateToNode;
    this._navigateToFile = opts.navigateToFile;
    this._highlightFile = opts.highlightFile;
    this._highlightFolder = opts.highlightFolder;
    this._clearHighlight = opts.clearHighlight;
    this._queryAgent = opts.queryAgent;
  }

  // ═══════════════════════════════════════════════════════════════
  // Panel change notification (replaces bus.emit('panel:toggle'))
  // ═══════════════════════════════════════════════════════════════

  /** 面板在 open()/close() 后调用，触发 dock tab 刷新 */
  notifyPanelChanged(): void {
    this._onPanelChanged?.();
  }

  // ═══════════════════════════════════════════════════════════════
  // Navigation commands (replace bus.emit('navigate:*'))
  // ═══════════════════════════════════════════════════════════════

  navigateToNode(name: string): void {
    this._navigateToNode?.(name);
  }

  navigateToFile(path: string): void {
    this._navigateToFile?.(path);
    bus.emit('navigate:file', path); // broadcast for chat.ts context tracking
  }

  // ═══════════════════════════════════════════════════════════════
  // Highlight commands (replace bus.emit('highlight:*'))
  // ═══════════════════════════════════════════════════════════════

  highlightFile(path: string): void {
    this._highlightFile?.(path);
    bus.emit('highlight:file', path); // broadcast for chat.ts context tracking
  }

  highlightFolder(path: string): void {
    this._highlightFolder?.(path);
    bus.emit('highlight:folder', path); // broadcast for graph listeners
  }

  clearHighlight(): void {
    this._clearHighlight?.();
    bus.emit('highlight:clear'); // broadcast for graph listeners
  }

  // ═══════════════════════════════════════════════════════════════
  // Agent query (replaces bus.emit('agent:query'))
  // ═══════════════════════════════════════════════════════════════

  queryAgent(question: string): void {
    this._queryAgent?.(question);
  }
}

export const shell = new AppShell();
