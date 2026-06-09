// Terminal Panel — xterm.js 嵌入式终端
// 底部面板，可执行 shell 命令

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '../bridge';

export class TerminalPanel {
  private panel!: HTMLElement;
  private termEl!: HTMLElement;
  private term!: Terminal;
  private fitAddon!: FitAddon;
  private inputLine!: HTMLInputElement;
  private history: string[] = [];
  private historyIdx = -1;
  private cwd = '';
  private openState = false;

  private static instance: TerminalPanel | null = null;

  static get(): TerminalPanel {
    if (!TerminalPanel.instance) {
      TerminalPanel.instance = new TerminalPanel();
    }
    return TerminalPanel.instance;
  }

  constructor() {
    this.buildDOM();
    this.initXterm();
  }

  private buildDOM(): void {
    // Panel
    this.panel = document.createElement('div');
    this.panel.id = 'terminal-panel';
    Object.assign(this.panel.style, {
      position: 'absolute',
      bottom: '28px',
      left: '0',
      right: '0',
      height: '260px',
      zIndex: '13',
      background: 'var(--void-deep, rgba(4, 8, 16, 0.98))',
      borderTop: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.5))',
      display: 'flex',
      flexDirection: 'column',
      transform: 'translateY(100%)',
      transition: 'transform var(--glide, 0.25s cubic-bezier(0.4, 0, 0.2, 1))',
    });

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Tab (always visible)
    const tab = document.createElement('div');
    tab.className = 'term-tab';
    tab.addEventListener('click', () => this.toggle());
    tab.innerHTML = '<span class="term-tab-icon">⬛</span><span class="term-tab-label">终端</span><span class="term-tab-arrow">▴</span>';
    this.panel.appendChild(tab);

    // Header bar
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '4px 8px',
      borderBottom: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.3))',
      flexShrink: '0',
    });

    const cwdLabel = document.createElement('span');
    cwdLabel.className = 'term-cwd';
    cwdLabel.textContent = '~';
    Object.assign(cwdLabel.style, {
      fontSize: '10px',
      color: 'var(--text-muted, #4a5568)',
      fontFamily: 'var(--font-mono, Cascadia Code, Fira Code, Consolas, monospace)',
      flex: '1',
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'term-clear';
    clearBtn.textContent = '清除';
    Object.assign(clearBtn.style, {
      fontSize: '10px', padding: '2px 8px',
      background: 'rgba(18, 30, 48, 0.6)', color: 'var(--text-muted, #8b949e)',
      border: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.4))', borderRadius: '4px',
      cursor: 'pointer',
    });
    clearBtn.addEventListener('click', () => this.term.clear());

    header.appendChild(cwdLabel);
    header.appendChild(clearBtn);
    this.panel.appendChild(header);

    // xterm container
    this.termEl = document.createElement('div');
    this.termEl.className = 'term-container';
    Object.assign(this.termEl.style, {
      flex: '1',
      overflow: 'hidden',
      padding: '0 4px',
    });
    this.panel.appendChild(this.termEl);

    // Input row
    const inputRow = document.createElement('div');
    Object.assign(inputRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '0',
      borderTop: '1px solid var(--panel-edge, rgba(48, 60, 80, 0.3))',
      flexShrink: '0',
    });

    const prompt = document.createElement('span');
    prompt.textContent = '>';
    Object.assign(prompt.style, {
      color: 'var(--signal, #7eb8ff)',
      fontFamily: 'var(--font-mono, Cascadia Code, Fira Code, Consolas, monospace)',
      fontSize: '13px',
      padding: '0 8px',
      fontWeight: '600',
    });

    this.inputLine = document.createElement('input');
    this.inputLine.className = 'term-input';
    Object.assign(this.inputLine.style, {
      flex: '1',
      height: '28px',
      padding: '0 8px',
      fontSize: '13px',
      fontFamily: 'var(--font-mono, Cascadia Code, Fira Code, Consolas, monospace)',
      background: 'transparent',
      border: 'none',
      color: 'var(--starlight-dim, #c9d1d9)',
      outline: 'none',
    });
    this.inputLine.placeholder = '输入命令… (Enter 执行)';
    this.inputLine.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = this.inputLine.value.trim();
        if (cmd) this.executeCommand(cmd);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.history.length > 0) {
          this.historyIdx = Math.min(this.historyIdx + 1, this.history.length - 1);
          this.inputLine.value = this.history[this.history.length - 1 - this.historyIdx] || '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.historyIdx > 0) {
          this.historyIdx--;
          this.inputLine.value = this.history[this.history.length - 1 - this.historyIdx] || '';
        } else {
          this.historyIdx = -1;
          this.inputLine.value = '';
        }
      }
    });

    inputRow.appendChild(prompt);
    inputRow.appendChild(this.inputLine);
    this.panel.appendChild(inputRow);

    document.body.appendChild(this.panel);
  }

  private initXterm(): void {
    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: {
        background: '#040810',
        foreground: '#c9d1d9',
        cursor: '#7eb8ff',
        selectionBackground: 'rgba(88, 120, 180, 0.3)',
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
      scrollback: 2000,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.termEl);

    // Fit on first open
    this.term.write('🔮 全息观测站 终端\r\n');
    this.term.write('输入命令后按 Enter 执行。例如: dir, python --version, git status\r\n\r\n');

    // Resize observer
    const observer = new ResizeObserver(() => {
      try { this.fitAddon.fit(); } catch { /* ignore */ }
    });
    observer.observe(this.termEl);
  }

  // ── Public API ──

  setCwd(path: string): void {
    this.cwd = path;
    const label = this.panel.querySelector('.term-cwd') as HTMLElement;
    if (label) {
      const short = path.length > 40 ? '...' + path.slice(-37) : path;
      label.textContent = short;
    }
  }

  toggle(): void {
    this.openState = !this.openState;
    if (this.openState) {
      this.panel.classList.add('term-open');
      setTimeout(() => {
        try { this.fitAddon.fit(); } catch { /* ignore */ }
        this.inputLine.focus();
      }, 290);
    } else {
      this.panel.classList.remove('term-open');
    }
  }

  open(): void {
    if (!this.openState) this.toggle();
  }

  private async executeCommand(cmd: string): Promise<void> {
    this.history.push(cmd);
    this.historyIdx = -1;
    this.inputLine.value = '';
    this.inputLine.disabled = true;

    const cwdDisplay = this.cwd || '.';
    this.term.write(`\r\n\x1b[36m${cwdDisplay}>\x1b[0m ${cmd}\r\n`);

    try {
      const output = await invoke<string>('exec_command', {
        command: cmd,
        cwd: this.cwd || null,
      });
      if (output) {
        // Strip trailing newlines but preserve internal ones
        this.term.write(output.trimEnd() + '\r\n');
      }
    } catch (err: any) {
      this.term.write(`\x1b[31m错误: ${err}\x1b[0m\r\n`);
    }

    this.inputLine.disabled = false;
    this.inputLine.focus();
    this.term.scrollToBottom();
  }
}
