// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// Terminal Panel — xterm.js multi-tab terminal
// Real PTY shell via portable-pty (Rust backend)
// Clipboard · Search · Font scaling · Tab rename · GSAP morph
// ═══════════════════════════════════════════════════════════════

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { invoke, listen } from '../bridge';
import { iconSvg } from './icons';
import { bus } from './events';
import { shell } from './app-shell';
import gsap from 'gsap';

// ── Constants ──

const DEFAULT_HEIGHT = 280;
const COLLAPSED_HEIGHT = 34;
const MIN_HEIGHT = 120;
const MAX_HEIGHT_VH = 0.6;

const DEFAULT_FONT_SIZE = 12;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 22;

// ── Types ──

interface TermSession {
  id: number;
  name: string;
  term: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  clipboardAddon: ClipboardAddon;
  el: HTMLElement;
  ptySessionId: number;
  cwd: string;
  unlisten: () => void;
  observer: ResizeObserver | null;
}

let nextId = 1;

// ── Panel ──

export class TerminalPanel {
  // DOM
  private panel!: HTMLElement;
  private tabBar!: HTMLElement;
  private body!: HTMLElement;
  private resizeHandle!: HTMLElement;
  private searchBar!: HTMLElement;
  private searchInput!: HTMLInputElement;

  // State
  private sessions: TermSession[] = [];
  private activeId = -1;
  private openState = false;
  private collapsed = false;
  private currentHeight = DEFAULT_HEIGHT;
  private fontSize = DEFAULT_FONT_SIZE;
  private globalCwd = '';

  // Resize drag state
  private dragging = false;
  private dragStartY = 0;
  private dragStartH = 0;

  // Singleton
  private static instance: TerminalPanel | null = null;
  static get(): TerminalPanel {
    if (!TerminalPanel.instance) TerminalPanel.instance = new TerminalPanel();
    return TerminalPanel.instance;
  }

  constructor() {
    this.buildDOM();
    this.setupResizeDrag();
    this.setupKeyboardShortcuts();
    // Listen for Agent shell execution — stream output to terminal
    this.setupAgentIntegration();
  }

  // ── DOM construction ──────────────────────────────────────

  private buildDOM(): void {
    this.panel = document.createElement('div');
    this.panel.id = 'terminal-panel';
    this.panel.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 45;
      background: var(--void-deep, rgba(4, 8, 16, 0.98));
      border-top: 1px solid var(--panel-edge, rgba(48, 60, 80, 0.5));
      display: flex; flex-direction: column;
      transform: translateY(100%); height: ${DEFAULT_HEIGHT}px;
    `;

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Resize handle — drag up to resize
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.style.cssText = `
      position: absolute; left: 8px; right: 8px; top: -4px;
      height: 10px; cursor: row-resize; z-index: 6;
    `;
    this.panel.appendChild(this.resizeHandle);

    // ── Tab bar ──
    this.tabBar = document.createElement('div');
    this.tabBar.style.cssText = `
      display: flex; align-items: center; gap: 2px;
      padding: 2px 6px; flex-shrink: 0; min-height: 28px;
      border-bottom: 1px solid var(--panel-edge, rgba(48, 60, 80, 0.3));
      overflow-x: auto; overflow-y: hidden;
      user-select: none;
    `;
    this.tabBar.addEventListener('wheel', (e) => {
      // Horizontal scroll on mouse wheel
      this.tabBar.scrollLeft += e.deltaY;
      e.preventDefault();
    });
    this.panel.appendChild(this.tabBar);

    // ── Search bar ──
    this.searchBar = document.createElement('div');
    this.searchBar.style.cssText = `
      display: none; align-items: center; gap: 6px;
      padding: 3px 8px; flex-shrink: 0;
      border-bottom: 1px solid rgba(60, 100, 170, 0.2);
      background: rgba(8, 16, 28, 0.6);
    `;
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = '搜索… (Enter 下一个, Shift+Enter 上一个, Esc 关闭)';
    this.searchInput.style.cssText = `
      flex: 1; background: rgba(4, 8, 16, 0.8); color: var(--starlight);
      border: 1px solid rgba(40, 60, 100, 0.3); outline: none;
      font-size: 11px; font-family: var(--font-mono); padding: 3px 6px;
      border-radius: 0;
    `;
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.hideSearch(); e.preventDefault(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const active = this.sessions.find(s => s.id === this.activeId);
        if (active && this.searchInput.value) {
          if (e.shiftKey) {
            active.searchAddon.findPrevious(this.searchInput.value, { decorations: { matchOverviewRuler: '#7eb8ff', activeMatchColorOverviewRuler: '#eebb33', matchBackground: 'rgba(80, 140, 240, 0.15)', activeMatchBackground: 'rgba(180, 140, 40, 0.3)' } });
          } else {
            active.searchAddon.findNext(this.searchInput.value, { decorations: { matchOverviewRuler: '#7eb8ff', activeMatchColorOverviewRuler: '#eebb33', matchBackground: 'rgba(80, 140, 240, 0.15)', activeMatchBackground: 'rgba(180, 140, 40, 0.3)' } });
          }
        }
      }
    });
    this.searchBar.appendChild(this.searchInput);
    // Result count
    const searchCount = document.createElement('span');
    searchCount.style.cssText = 'font-size: 10px; color: var(--text-muted); white-space: nowrap; font-family: var(--font-mono);';
    searchCount.id = 'term-search-count';
    this.searchBar.appendChild(searchCount);
    this.panel.appendChild(this.searchBar);

    // ── Body ──
    this.body = document.createElement('div');
    this.body.style.cssText = `
      flex: 1; display: flex; flex-direction: column; overflow: hidden;
      min-height: 0;
    `;
    this.panel.appendChild(this.body);

    document.body.appendChild(this.panel);
  }

  // ── Resize drag ───────────────────────────────────────────

  private setupResizeDrag(): void {
    this.resizeHandle.addEventListener('mousedown', (e) => {
      if (!this.openState || this.collapsed) return;
      this.dragging = true;
      this.dragStartY = e.clientY;
      this.dragStartH = this.panel.offsetHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    const onMove = (e: MouseEvent) => {
      if (!this.dragging) return;
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_VH);
      const h = Math.max(MIN_HEIGHT, Math.min(maxH, this.dragStartH + (this.dragStartY - e.clientY)));
      this.currentHeight = h;
      this.panel.style.height = h + 'px';
      this.fitActive();
    };

    const onUp = () => {
      if (!this.dragging) return;
      this.dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Keyboard shortcuts ────────────────────────────────────

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (!this.openState) return;

      const mod = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // Only when terminal panel has focus context (any session active)
      if (mod && shift && e.key === 'F') {
        e.preventDefault();
        this.toggleSearch();
        return;
      }

      if (mod && e.key === '=') {
        // Ctrl+Plus (or Ctrl+= which is same key without shift)
        e.preventDefault();
        this.zoomIn();
        return;
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        this.zoomOut();
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        this.zoomReset();
        return;
      }
      if (mod && e.key === 'l') {
        // Ctrl+L → clear active terminal
        e.preventDefault();
        this.clearActive();
        return;
      }
      if (mod && e.key === 't') {
        e.preventDefault();
        this.newTab();
        return;
      }
      if (mod && e.key === 'w') {
        e.preventDefault();
        this.closeTab();
        return;
      }
    });
  }

  // ── Agent integration ─────────────────────────────────────

  private setupAgentIntegration(): void {
    // Listen for agent shell commands — open terminal and show output
    bus.on('agent:shell-output', (data: { sessionId?: number; output: string; done?: boolean }) => {
      if (!this.openState) {
        // Auto-open terminal when agent runs shell
        this.open();
      }
      // If agent provides a session, write to that session
      // Otherwise write to active terminal
      const active = this.sessions.find(s => s.id === this.activeId);
      if (active) {
        if (data.done) {
          active.term.write('\r\n');
        } else {
          active.term.write(data.output);
        }
      }
    });
  }

  // ── Session management ────────────────────────────────────

  private async createSession(name?: string): Promise<TermSession> {
    const id = nextId++;
    const label = name || this.defaultTabName();

    // Container
    const el = document.createElement('div');
    el.style.cssText = `
      flex: 1; overflow: hidden; padding: 0 4px;
      display: none;
    `;
    // Zero border-radius on container for clean xterm embed
    this.body.appendChild(el);

    // xterm
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: this.fontSize,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: '#040810',
        foreground: '#c9d1d9',
        cursor: '#7eb8ff',
        selectionBackground: 'rgba(88, 120, 180, 0.35)',
        black: '#1a1a2e',
        red: '#e05555',
        green: '#55aa55',
        yellow: '#d29922',
        blue: '#7eb8ff',
        magenta: '#c098ff',
        cyan: '#55cccc',
        white: '#c9d1d9',
        brightBlack: '#4a5568',
        brightRed: '#ee6666',
        brightGreen: '#66cc66',
        brightYellow: '#eebb33',
        brightBlue: '#99ccff',
        brightMagenta: '#d0a0ff',
        brightCyan: '#66dddd',
        brightWhite: '#e6edf3',
      },
      allowProposedApi: true,
      scrollback: 8000,
      allowTransparency: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    const clipboardAddon = new ClipboardAddon();
    term.loadAddon(clipboardAddon);

    term.open(el);

    // ResizeObserver on the panel body — fit when dimensions change
    const observer = new ResizeObserver(() => {
      if (el.style.display === 'none') return;
      try { fitAddon.fit(); } catch { /* container not ready */ }
      const s = this.sessions.find(x => x.id === id);
      if (s && s.ptySessionId) {
        invoke('pty_resize', {
          sessionId: s.ptySessionId,
          cols: term.cols || 80,
          rows: term.rows || 24,
        }).catch(() => {});
      }
    });
    observer.observe(el);

    // Spawn PTY
    const cwd = this.globalCwd || '.';
    let ptySessionId: number;
    try {
      ptySessionId = await invoke<number>('pty_spawn', {
        cwd,
        shell: null,
        cols: term.cols || 80,
        rows: term.rows || 24,
      });
    } catch (err) {
      term.write(`\r\n\x1b[31m[PTY spawn failed: ${err}]\x1b[0m\r\n`);
      ptySessionId = 0;
    }

    // Listen for PTY output
    const unlisten = await listen<{ session_id: number; data: number[] }>('pty-output', (event) => {
      const payload = (event as any).payload;
      if (payload.session_id === ptySessionId) {
        term.write(new Uint8Array(payload.data));
      }
    });

    // xterm input → PTY
    term.onData((data) => {
      if (ptySessionId) {
        invoke('pty_write', { sessionId: ptySessionId, data }).catch(() => {});
      }
    });

    // Update tab name when cwd changes (detect from OSC 7 or prompt)
    term.onTitleChange((title) => {
      const s = this.sessions.find(x => x.id === id);
      if (s && title && title.length > 0 && title.length < 60) {
        s.name = title;
        this.renderTabs();
      }
    });

    const session: TermSession = {
      id, name: label,
      term, fitAddon, searchAddon, clipboardAddon,
      el, ptySessionId, cwd,
      unlisten, observer,
    };

    this.sessions.push(session);
    return session;
  }

  private defaultTabName(): string {
    // Use last segment of cwd as name, or generic
    if (this.globalCwd) {
      const segs = this.globalCwd.replace(/\\/g, '/').split('/').filter(Boolean);
      const last = segs[segs.length - 1];
      if (last && last.length <= 24) return last;
    }
    return `term-${nextId}`;
  }

  private async removeSession(id: number): Promise<void> {
    if (this.sessions.length <= 1) return;
    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx < 0) return;

    const sess = this.sessions[idx];

    // Kill PTY
    if (sess.ptySessionId) {
      invoke('pty_kill', { sessionId: sess.ptySessionId }).catch(() => {});
    }

    // Cleanup
    sess.unlisten();
    sess.term.dispose();
    if (sess.observer) sess.observer.disconnect();
    sess.el.remove();

    this.sessions.splice(idx, 1);

    // Switch to neighbor
    if (this.activeId === id) {
      const newIdx = Math.min(idx, this.sessions.length - 1);
      this.activeId = this.sessions[newIdx].id;
      this.switchTo(this.activeId);
    }
    this.renderTabs();
  }

  private switchTo(id: number): void {
    this.activeId = id;
    for (const s of this.sessions) {
      s.el.style.display = s.id === id ? 'flex' : 'none';
    }
    const active = this.sessions.find(s => s.id === id);
    if (active) {
      requestAnimationFrame(() => {
        try { active.fitAddon.fit(); } catch { /* ignore */ }
        active.term.focus();
      });
    }
    this.renderTabs();
  }

  // ── Tab bar ───────────────────────────────────────────────

  private _editingTabId = -1;

  private renderTabs(): void {
    this.tabBar.innerHTML = '';

    for (const s of this.sessions) {
      const isActive = s.id === this.activeId;
      const isEditing = s.id === this._editingTabId;

      const tab = document.createElement('div');
      tab.style.cssText = `
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px; cursor: pointer;
        font-size: 11px; font-family: var(--font-mono, monospace);
        white-space: nowrap; flex-shrink: 0;
        background: ${isActive ? 'rgba(30, 55, 100, 0.45)' : 'transparent'};
        color: ${isActive ? 'var(--starlight, #e2edff)' : 'var(--text-muted, #6a7a94)'};
        border: 1px solid ${isActive ? 'rgba(60, 100, 170, 0.3)' : 'transparent'};
        border-radius: 0;
      `;
      tab.title = '双击重命名 · 中键关闭';

      if (isEditing) {
        const input = document.createElement('input');
        input.style.cssText = `
          background: rgba(8, 16, 32, 0.9); color: var(--starlight);
          border: 1px solid rgba(60, 100, 170, 0.4); outline: none;
          font-size: 10px; font-family: var(--font-mono); width: 100px; padding: 1px 4px;
          border-radius: 0;
        `;
        input.value = s.name;
        input.addEventListener('blur', () => this.finishRename(s.id, input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') this.finishRename(s.id, input.value);
          if (e.key === 'Escape') this.finishRename(s.id, s.name);
        });
        tab.appendChild(input);
        setTimeout(() => input.select(), 10);
      } else {
        const label = document.createElement('span');
        label.textContent = s.name;
        tab.appendChild(label);
      }

      // Close button
      if (this.sessions.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = `
          background: none; border: none; cursor: pointer;
          color: inherit; padding: 0; font-size: 13px; line-height: 1;
          opacity: 0.4; margin-left: 2px; border-radius: 0;
        `;
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; closeBtn.style.color = '#e05555'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.4'; closeBtn.style.color = 'inherit'; });
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeSession(s.id); });
        tab.appendChild(closeBtn);
      }

      // Click → switch
      tab.addEventListener('click', () => this.switchTo(s.id));
      // Double-click → rename
      tab.addEventListener('dblclick', () => { this._editingTabId = s.id; this.renderTabs(); });
      // Middle-click → close
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); this.removeSession(s.id); }
      });

      this.tabBar.appendChild(tab);
    }

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1;';
    this.tabBar.appendChild(spacer);

    // + New tab
    const addBtn = this.makeToolBtn('+', '新建终端 (Ctrl+T)', () => this.newTab());
    this.tabBar.appendChild(addBtn);

    // Search toggle
    const searchBtn = this.makeToolBtn('🔍', '搜索 (Ctrl+Shift+F)', () => this.toggleSearch());
    this.tabBar.appendChild(searchBtn);

    // Clear
    const clearBtn = this.makeToolBtn('▸', '清屏 (Ctrl+L)', () => this.clearActive());
    this.tabBar.appendChild(clearBtn);

    // Collapse/expand
    const collapseBtn = this.makeToolBtn(
      this.collapsed ? '▲' : '▼',
      this.collapsed ? '展开终端' : '收起终端',
      () => this.collapsed ? this.expand() : this.collapse(),
    );
    this.tabBar.appendChild(collapseBtn);
  }

  private makeToolBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.title = title;
    btn.style.cssText = `
      background: none; border: none; cursor: pointer;
      color: var(--text-muted, #6a7a94); padding: 2px 5px;
      font-size: 11px; display: flex; align-items: center;
      border-radius: 0; font-family: var(--font-mono);
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.color = 'var(--starlight, #e2edff)';
      btn.style.background = 'rgba(255,255,255,0.05)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.color = 'var(--text-muted, #6a7a94)';
      btn.style.background = 'none';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  private finishRename(id: number, newName: string): void {
    this._editingTabId = -1;
    const trimmed = newName.trim();
    if (trimmed) {
      const s = this.sessions.find(x => x.id === id);
      if (s) s.name = trimmed;
    }
    this.renderTabs();
  }

  // ── Actions ───────────────────────────────────────────────

  private toggleSearch(): void {
    if (this.searchBar.style.display === 'flex') {
      this.hideSearch();
    } else {
      this.showSearch();
    }
  }

  private showSearch(): void {
    this.searchBar.style.display = 'flex';
    this.searchInput.value = '';
    this.searchInput.focus();
    const countEl = document.getElementById('term-search-count');
    if (countEl) countEl.textContent = '';
  }

  private hideSearch(): void {
    this.searchBar.style.display = 'none';
    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.searchAddon.clearDecorations();
      active.searchAddon.clearActiveDecoration();
    }
    // Focus back to terminal
    if (active) active.term.focus();
  }

  private clearActive(): void {
    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.term.clear();
      // Send Ctrl+L to shell for clean prompt
      active.term.write('\x0c');
    }
  }

  private zoomIn(): void {
    this.fontSize = Math.min(MAX_FONT_SIZE, this.fontSize + 1);
    this.applyFontSize();
  }

  private zoomOut(): void {
    this.fontSize = Math.max(MIN_FONT_SIZE, this.fontSize - 1);
    this.applyFontSize();
  }

  private zoomReset(): void {
    this.fontSize = DEFAULT_FONT_SIZE;
    this.applyFontSize();
  }

  private applyFontSize(): void {
    for (const s of this.sessions) {
      s.term.options.fontSize = this.fontSize;
      this.fitSession(s);
    }
  }

  private fitSession(s: TermSession): void {
    try { s.fitAddon.fit(); } catch { /* ignore */ }
    if (s.ptySessionId) {
      invoke('pty_resize', {
        sessionId: s.ptySessionId,
        cols: s.term.cols || 80,
        rows: s.term.rows || 24,
      }).catch(() => {});
    }
  }

  private fitActive(): void {
    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) this.fitSession(active);
  }

  private async newTab(): Promise<void> {
    if (!this.openState) {
      await this.open();
      return;
    }
    const s = await this.createSession();
    this.switchTo(s.id);
  }

  private async closeTab(): Promise<void> {
    if (this.sessions.length <= 1) {
      this.close();
      return;
    }
    await this.removeSession(this.activeId);
  }

  // ── Public API ────────────────────────────────────────────

  setCwd(path: string): void {
    this.globalCwd = path;
  }

  /** Write text to the active terminal. For Agent shell output. */
  writeToActive(text: string): void {
    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.term.write(text);
    }
  }

  /** Get or create a session by ID. For Agent to write to a specific session. */
  async ensureSession(sessionId?: number): Promise<number> {
    if (sessionId && this.sessions.find(s => s.ptySessionId === sessionId)) {
      return sessionId;
    }
    if (!this.openState) await this.open();
    const active = this.sessions.find(s => s.id === this.activeId);
    return active?.ptySessionId || 0;
  }

  toggle(): void {
    if (this.collapsed) {
      this.expand();
      return;
    }
    if (this.openState) {
      this.close();
    } else {
      this.open();
    }
  }

  async open(): Promise<void> {
    // Lazy init first session
    if (this.sessions.length === 0) {
      const s = await this.createSession();
      this.activeId = s.id;
      this.renderTabs();
    }

    this.openState = true;
    this.collapsed = false;
    this.panel.style.height = this.currentHeight + 'px';
    this.body.style.display = 'flex';

    // GSAP slide-up
    gsap.killTweensOf(this.panel);
    gsap.to(this.panel, {
      transform: 'translateY(0%)',
      duration: 0.28,
      ease: 'power2.out',
    });

    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.el.style.display = 'flex';
      // Fit after animation completes
      setTimeout(() => {
        try { active.fitAddon.fit(); } catch { /* ignore */ }
        active.term.focus();
      }, 300);
    }
    this.renderTabs();
    shell.notifyPanelChanged();
  }

  close(): void {
    this.openState = false;
    this.collapsed = false;

    gsap.killTweensOf(this.panel);
    gsap.to(this.panel, {
      transform: 'translateY(100%)',
      duration: 0.22,
      ease: 'power2.in',
    });
    shell.notifyPanelChanged();
  }

  collapse(): void {
    if (!this.openState) return;
    this.collapsed = true;

    gsap.killTweensOf(this.panel);
    gsap.to(this.panel, {
      height: COLLAPSED_HEIGHT + 'px',
      duration: 0.2,
      ease: 'power2.out',
    });
    this.body.style.display = 'none';
    this.renderTabs();
  }

  expand(): void {
    if (!this.openState) return;
    this.collapsed = false;

    this.body.style.display = 'flex';
    gsap.killTweensOf(this.panel);
    gsap.to(this.panel, {
      height: this.currentHeight + 'px',
      duration: 0.2,
      ease: 'power2.out',
    });

    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.el.style.display = 'flex';
      setTimeout(() => {
        try { active.fitAddon.fit(); } catch { /* ignore */ }
        active.term.focus();
      }, 220);
    }
    this.renderTabs();
    shell.notifyPanelChanged();
  }

  isOpen(): boolean {
    return this.openState && !this.collapsed;
  }

  /** Cleanup all sessions — for workspace switch */
  destroy(): void {
    for (const s of this.sessions) {
      if (s.ptySessionId) {
        invoke('pty_kill', { sessionId: s.ptySessionId }).catch(() => {});
      }
      s.unlisten();
      s.term.dispose();
      if (s.observer) s.observer.disconnect();
      s.el.remove();
    }
    this.sessions = [];
    this.activeId = -1;
    this.openState = false;
    this.collapsed = false;
    gsap.killTweensOf(this.panel);
  }
}
