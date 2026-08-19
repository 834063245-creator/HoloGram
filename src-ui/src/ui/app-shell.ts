// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AppShell — 应用级 UI 外壳
// 跨面板的命令式操作（导航、高亮、Agent 查询）。
// 不负责项目级状态（那归 Workspace），不负责纯通知（那归 store 信号）。
// P3：面板开合状态已迁 dock-store，本类只保留导航/高亮/查询命令。
//
// 使用方式：
//   import { shell } from './app-shell';
//   shell.navigateToNode(name);   // 替代 bus.emit('navigate:node', name)
//   shell.highlightFile(path);    // 替代 bus.emit('highlight:file', path)
//
// 每条命令执行后同步写 chat-context-store 焦点信号，供 chat-core 做上下文跟踪
//（P1 总线归零：原 bus 'navigate:file' / 'highlight:file' 广播）。

import { setChatFocusFile } from '../state/chat-context-store';

/**
 * shell 本身是模块级单例——跟 bus 一样的 import 模式。
 * 所有面板 import { shell } 即可，不需要构造传参。
 */
class AppShell {
  // ── Wiring slots (set by main.ts) ──
  private _navigateToNode: ((name: string) => void) | null = null;
  private _navigateToFile: ((path: string, line?: number) => void) | null = null;
  private _highlightFile: ((path: string) => void) | null = null;
  private _highlightFolder: ((path: string) => void) | null = null;
  private _clearHighlight: (() => void) | null = null;
  private _queryAgent: ((question: string) => void) | null = null;

  // ═══════════════════════════════════════════════════════════════
  // Wiring (called once by main.ts during init)
  // ═══════════════════════════════════════════════════════════════

  /** 注入导航/高亮/查询处理函数 — 由 main.ts 在 starGraph/chatPanel 创建后调用 */
  wire(opts: {
    navigateToNode: (name: string) => void;
    navigateToFile: (path: string, line?: number) => void;
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
  // Navigation commands (replace bus.emit('navigate:*'))
  // ═══════════════════════════════════════════════════════════════

  navigateToNode(name: string): void {
    this._navigateToNode?.(name);
  }

  navigateToFile(path: string, line?: number): void {
    this._navigateToFile?.(path, line);
    setChatFocusFile(path); // chat 上下文跟踪（P1 总线归零：state/chat-context-store）
  }

  // ═══════════════════════════════════════════════════════════════
  // Highlight commands (replace bus.emit('highlight:*'))
  // ═══════════════════════════════════════════════════════════════

  highlightFile(path: string): void {
    this._highlightFile?.(path);
    setChatFocusFile(path); // chat 上下文跟踪（P1 总线归零：state/chat-context-store）
  }

  highlightFolder(path: string): void {
    this._highlightFolder?.(path);
  }

  clearHighlight(): void {
    this._clearHighlight?.();
  }

  // ═══════════════════════════════════════════════════════════════
  // Agent query (replaces bus.emit('agent:query'))
  // ═══════════════════════════════════════════════════════════════

  queryAgent(question: string): void {
    this._queryAgent?.(question);
  }
}

export const shell = new AppShell();
