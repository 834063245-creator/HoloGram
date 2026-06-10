// ═══════════════════════════════════════════════════════════════
// Terminal Panel — xterm.js 多标签页终端
// 支持新建/删除/切换标签页，收起时后台保持运行
// ═══════════════════════════════════════════════════════════════

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '../bridge';
import { iconSvg } from './icons';
import { bus } from './events';

// ── Terminal Session ──────────────────────────────────────────

interface TermSession {
  id: number;
  name: string;
  term: Terminal;
  fitAddon: FitAddon;
  el: HTMLElement;       // DOM container for this term
  history: string[];
  historyIdx: number;
  inputLine: HTMLInputElement;
  cwd: string;
}

let nextId = 1;

// ── Panel ─────────────────────────────────────────────────────

export class TerminalPanel {
  private panel!: HTMLElement;
  private tabBar!: HTMLElement;
  private body!: HTMLElement;       // wraps all term containers
  private sessions: TermSession[] = [];
  private activeId = -1;
  private openState = false;        // fully open
  private collapsed = false;        // collapsed to tab bar only
  private globalCwd = '';

  private static instance: TerminalPanel | null = null;
  static get(): TerminalPanel {
    if (!TerminalPanel.instance) TerminalPanel.instance = new TerminalPanel();
    return TerminalPanel.instance;
  }

  constructor() {
    this.buildDOM();
  }

  // ── DOM ───────────────────────────────────────────────────

  private buildDOM(): void {
    this.panel = document.createElement('div');
    this.panel.id = 'terminal-panel';
    Object.assign(this.panel.style, {
      position: 'absolute', bottom: '0', left: '0', right: '0', zIndex: '13',
      background: 'var(--void-deep, rgba(4, 8, 16, 0.98))',
      borderTop: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.5))',
      display: 'flex', flexDirection: 'column',
      transform: 'translateY(100%)',
      transition: 'transform var(--glide, 0.25s cubic-bezier(0.4, 0, 0.2, 1))',
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // ── Tab bar — always visible in collapsed mode ──
    this.tabBar = document.createElement('div');
    Object.assign(this.tabBar.style, {
      display: 'flex', alignItems: 'center', gap: '2px',
      padding: '3px 6px', flexShrink: '0', minHeight: '28px',
      borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.3))',
      overflowX: 'auto', overflowY: 'hidden',
    });
    this.panel.appendChild(this.tabBar);

    // ── Body — all terminal containers ──
    this.body = document.createElement('div');
    Object.assign(this.body.style, {
      flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      minHeight: '0',
    });
    this.panel.appendChild(this.body);

    document.body.appendChild(this.panel);
  }

  // ── Session management ────────────────────────────────────

  private createSession(name?: string): TermSession {
    const id = nextId++;
    const label = name || `终端 ${id}`;

    // Container
    const el = document.createElement('div');
    Object.assign(el.style, {
      flex: '1', overflow: 'hidden', padding: '0 4px',
      display: 'none',
    });
    this.body.appendChild(el);

    // xterm
    const term = new Terminal({
      cursorBlink: true, fontSize: 12,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: '#040810', foreground: '#c9d1d9', cursor: '#7eb8ff',
        selectionBackground: 'rgba(88, 120, 180, 0.3)',
        black: '#1a1a2e', red: '#e05555', green: '#55aa55', yellow: '#d29922',
        blue: '#7eb8ff', magenta: '#c098ff', cyan: '#55cccc', white: '#c9d1d9',
        brightBlack: '#4a5568', brightRed: '#ee6666', brightGreen: '#66cc66',
        brightYellow: '#eebb33', brightBlue: '#99ccff', brightMagenta: '#d0a0ff',
        brightCyan: '#66dddd', brightWhite: '#e6edf3',
      },
      allowProposedApi: true, scrollback: 2000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Welcome
    term.write('\x1b[36m🔮 全息观测站 终端\x1b[0m\r\n');
    term.write('输入命令后按 Enter 执行\r\n\r\n');

    // Resize observer
    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });
    observer.observe(el);

    // Input row
    const inputRow = document.createElement('div');
    Object.assign(inputRow.style, {
      display: 'flex', alignItems: 'center', gap: '0',
      borderTop: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.3))',
      flexShrink: '0',
    });

    const prompt = document.createElement('span');
    prompt.textContent = '>';
    Object.assign(prompt.style, {
      color: 'var(--signal, #7eb8ff)', fontSize: '13px', padding: '0 8px',
      fontFamily: 'var(--font-mono)', fontWeight: '600',
    });

    const inputLine = document.createElement('input');
    Object.assign(inputLine.style, {
      flex: '1', height: '28px', padding: '0 8px', fontSize: '13px',
      fontFamily: 'var(--font-mono)', background: 'transparent',
      border: 'none', color: 'var(--starlight-dim)', outline: 'none',
    });
    inputLine.placeholder = '输入命令… (Enter 执行)';
    inputLine.addEventListener('keydown', (e) => this.handleInputKey(e, inputLine, id));

    inputRow.appendChild(prompt);
    inputRow.appendChild(inputLine);
    el.appendChild(inputRow);

    const session: TermSession = {
      id, name: label,
      term, fitAddon, el, inputLine,
      history: [], historyIdx: -1,
      cwd: this.globalCwd,
    };

    this.sessions.push(session);
    return session;
  }

  private removeSession(id: number): void {
    if (this.sessions.length <= 1) return; // keep at least one
    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx < 0) return;

    const sess = this.sessions[idx];
    sess.term.dispose();
    sess.el.remove();

    this.sessions.splice(idx, 1);

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
      setTimeout(() => {
        try { active.fitAddon.fit(); } catch { /* ignore */ }
        active.inputLine.focus();
      }, 50);
    }
    this.renderTabs();
  }

  // ── Tab bar rendering ─────────────────────────────────────

  private renderTabs(): void {
    this.tabBar.innerHTML = '';

    for (const s of this.sessions) {
      const tab = document.createElement('div');
      const isActive = s.id === this.activeId;
      Object.assign(tab.style, {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '2px 8px', borderRadius: '4px', cursor: 'pointer',
        fontSize: '11px', fontFamily: 'var(--font-mono)',
        whiteSpace: 'nowrap', flexShrink: '0',
        background: isActive ? 'rgba(30, 55, 100, 0.45)' : 'transparent',
        color: isActive ? 'var(--starlight)' : 'var(--text-muted)',
        border: isActive ? '1px solid rgba(60, 100, 170, 0.3)' : '1px solid transparent',
      });
      tab.title = s.name;

      const label = document.createElement('span');
      label.textContent = s.name;
      tab.appendChild(label);

      // Close button (only if more than 1 terminal)
      if (this.sessions.length > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = iconSvg('close', 10);
        Object.assign(closeBtn.style, {
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'inherit', padding: '0', fontSize: '10px',
          display: 'flex', alignItems: 'center', opacity: '0.5',
        });
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.5'; });
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.removeSession(s.id);
        });
        tab.appendChild(closeBtn);
      }

      tab.addEventListener('click', () => this.switchTo(s.id));
      this.tabBar.appendChild(tab);
    }

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1';
    this.tabBar.appendChild(spacer);

    // + New terminal button
    const addBtn = document.createElement('button');
    addBtn.innerHTML = iconSvg('plus', 12);
    addBtn.title = '新建终端';
    Object.assign(addBtn.style, {
      background: 'none', border: 'none', cursor: 'pointer',
      color: 'var(--text-muted)', padding: '2px 4px',
      display: 'flex', alignItems: 'center', borderRadius: '3px',
    });
    addBtn.addEventListener('mouseenter', () => {
      addBtn.style.color = 'var(--starlight)';
      addBtn.style.background = 'rgba(255,255,255,0.05)';
    });
    addBtn.addEventListener('mouseleave', () => {
      addBtn.style.color = 'var(--text-muted)';
      addBtn.style.background = 'none';
    });
    addBtn.addEventListener('click', () => {
      const s = this.createSession();
      this.switchTo(s.id);
    });
    this.tabBar.appendChild(addBtn);

    // Collapse toggle button
    const collapseBtn = document.createElement('button');
    collapseBtn.innerHTML = iconSvg('chevron-down', 10);
    collapseBtn.title = '收起终端';
    Object.assign(collapseBtn.style, {
      background: 'none', border: 'none', cursor: 'pointer',
      color: 'var(--text-muted)', padding: '2px 4px',
      display: 'flex', alignItems: 'center', borderRadius: '3px',
    });
    collapseBtn.addEventListener('mouseenter', () => {
      collapseBtn.style.color = 'var(--starlight)';
      collapseBtn.style.background = 'rgba(255,255,255,0.05)';
    });
    collapseBtn.addEventListener('mouseleave', () => {
      collapseBtn.style.color = 'var(--text-muted)';
      collapseBtn.style.background = 'none';
    });
    collapseBtn.addEventListener('click', () => this.collapse());
    this.tabBar.appendChild(collapseBtn);
  }

  // ── Input handling ────────────────────────────────────────

  private handleInputKey(e: KeyboardEvent, input: HTMLInputElement, id: number): void {
    const sess = this.sessions.find(s => s.id === id);
    if (!sess) return;

    if (e.key === 'Enter') {
      const cmd = input.value.trim();
      if (cmd) this.executeCommand(id, cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (sess.history.length > 0) {
        sess.historyIdx = Math.min(sess.historyIdx + 1, sess.history.length - 1);
        input.value = sess.history[sess.history.length - 1 - sess.historyIdx] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (sess.historyIdx > 0) {
        sess.historyIdx--;
        input.value = sess.history[sess.history.length - 1 - sess.historyIdx] || '';
      } else {
        sess.historyIdx = -1;
        input.value = '';
      }
    }
  }

  // ── Public API ────────────────────────────────────────────

  setCwd(path: string): void {
    this.globalCwd = path;
    for (const s of this.sessions) {
      s.cwd = path;
    }
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

  private open(): void {
    // Lazy init first session
    if (this.sessions.length === 0) {
      const s = this.createSession();
      this.activeId = s.id;
      this.renderTabs();
    }

    this.openState = true;
    this.collapsed = false;
    this.body.style.display = 'flex';
    this.panel.style.transform = 'translateY(0)';
    this.panel.style.height = '260px';

    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.el.style.display = 'flex';
      setTimeout(() => {
        try { active.fitAddon.fit(); } catch { /* ignore */ }
        active.inputLine.focus();
      }, 280);
    }
    this.renderTabs();
    bus.emit('panel:toggle');
  }

  private close(): void {
    this.openState = false;
    this.collapsed = false;
    this.panel.style.transform = 'translateY(100%)';
    bus.emit('panel:toggle');
  }

  /** Collapse to just the tab bar — processes keep running. */
  collapse(): void {
    if (!this.openState) return;
    this.collapsed = true;
    this.body.style.display = 'none';
    this.panel.style.height = 'auto';
    this.panel.style.transform = 'translateY(0)'; // stays visible
    this.renderTabs();
  }

  /** Expand from collapsed state. */
  private expand(): void {
    this.collapsed = false;
    this.body.style.display = 'flex';
    this.panel.style.height = '260px';

    const active = this.sessions.find(s => s.id === this.activeId);
    if (active) {
      active.el.style.display = 'flex';
      setTimeout(() => {
        try { active.fitAddon.fit(); } catch { /* ignore */ }
        active.inputLine.focus();
      }, 50);
    }
    this.renderTabs();
    bus.emit('panel:toggle');
  }

  isOpen(): boolean { return this.openState && !this.collapsed; }

  // ── Command execution ─────────────────────────────────────

  private async executeCommand(id: number, cmd: string): Promise<void> {
    const sess = this.sessions.find(s => s.id === id);
    if (!sess) return;

    sess.history.push(cmd);
    sess.historyIdx = -1;
    sess.inputLine.value = '';
    sess.inputLine.disabled = true;

    const cwdDisplay = sess.cwd || '.';
    sess.term.write(`\r\n\x1b[36m${cwdDisplay}>\x1b[0m ${cmd}\r\n`);

    try {
      const output = await invoke<string>('exec_command', {
        command: cmd,
        cwd: sess.cwd || null,
      });
      if (output) {
        sess.term.write(output.trimEnd() + '\r\n');
      }
    } catch (err: any) {
      sess.term.write(`\x1b[31m错误: ${err}\x1b[0m\r\n`);
    }

    sess.inputLine.disabled = false;
    sess.inputLine.focus();
    sess.term.scrollToBottom();
  }
}
