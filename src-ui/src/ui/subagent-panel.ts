// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SubAgentPanel — 子Agent 独立任务面板
// 汇总所有运行中/已完成的子Agent，支持展开日志、状态监控

import { iconHtml } from './icons';
import { bus } from './events';

interface SubAgentEntry {
  id: string;
  description: string;
  mode: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  elapsedMs?: number;
  hasError?: boolean;
  output: string; // accumulated progress text
}

export class SubAgentPanel {
  private el!: HTMLElement;
  private header!: HTMLElement;
  private body!: HTMLElement;
  private grip!: HTMLElement;
  private open = false;
  private statusBtn!: HTMLElement;

  private agents = new Map<string, SubAgentEntry>();
  private completedOrder: string[] = []; // keep insertion order for completed list

  // ── Drag / resize ──
  private dragging = false;
  private dragStart = { x: 0, y: 0, elX: 0, elY: 0 };

  constructor(container: HTMLElement) {
    this.buildDOM(container);
    this.listen();
  }

  // ═══════════════════════════════════════════════════════════
  // DOM
  // ═══════════════════════════════════════════════════════════

  private buildDOM(container: HTMLElement): void {
    // Status bar indicator
    this.statusBtn = document.createElement('span');
    this.statusBtn.id = 'subagent-status-btn';
    this.statusBtn.style.cssText =
      'cursor:pointer;margin-left:8px;color:var(--text-faint);font-family:var(--font-hud);font-size:calc(10px*var(--font-scale));letter-spacing:0.5px;transition:color 0.2s;';
    this.statusBtn.title = '点击打开子Agent任务面板';
    this.statusBtn.addEventListener('click', () => this.toggle());
    const statusBar = document.getElementById('status');
    if (statusBar) {
      const right = statusBar.querySelector('.right');
      if (right) right.prepend(this.statusBtn);
    }
    this.updateStatusBtn();

    // Panel
    this.el = document.createElement('div');
    this.el.id = 'subagent-panel';
    Object.assign(this.el.style, {
      position: 'fixed', zIndex: '79',
      right: '16px', bottom: '50px', width: '500px', height: '400px',
      background: 'var(--panel-bg)',
      border: '1px solid var(--panel-edge)',
      borderRadius: '8px',
      display: 'none',
      flexDirection: 'column',
      overflow: 'hidden',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      backdropFilter: 'var(--blur)',
    });

    // Header (draggable)
    this.header = document.createElement('div');
    this.header.id = 'subagent-panel-header';
    Object.assign(this.header.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 12px',
      cursor: 'move',
      borderBottom: '1px solid rgba(40,70,130,0.15)',
      fontFamily: 'var(--font-hud)', fontSize: 'calc(11px*var(--font-scale))',
      letterSpacing: '0.8px', color: 'var(--signal)',
      userSelect: 'none',
      flexShrink: '0',
    });
    this.header.innerHTML = `${iconHtml('puzzle', 12)} SUB‑AGENT TASK PANEL`;
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = iconHtml('close', 12);
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', cursor: 'pointer',
      color: 'var(--text-faint)', padding: '0 4px', fontSize: '14px',
    });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.hide(); });
    this.header.appendChild(closeBtn);

    // Drag logic
    this.header.addEventListener('pointerdown', (e: PointerEvent) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY, elX: this.el.offsetLeft, elY: this.el.offsetTop };
      this.el.style.transition = 'none';
      e.preventDefault();
    });
    window.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.dragging) return;
      this.el.style.left = `${this.dragStart.elX + e.clientX - this.dragStart.x}px`;
      this.el.style.top = `${this.dragStart.elY + e.clientY - this.dragStart.y}px`;
      // Remove right/bottom so they don't conflict
      this.el.style.right = 'auto'; this.el.style.bottom = 'auto';
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });

    // Body
    this.body = document.createElement('div');
    this.body.id = 'subagent-panel-body';
    Object.assign(this.body.style, {
      flex: '1', overflowY: 'auto', padding: '8px 12px',
      fontFamily: 'var(--font-mono)', fontSize: 'calc(10px*var(--font-scale))',
    });

    this.el.appendChild(this.header);
    this.el.appendChild(this.body);
    container.appendChild(this.el);
  }

  // ═══════════════════════════════════════════════════════════
  // Events
  // ═══════════════════════════════════════════════════════════

  private listen(): void {
    bus.on('agent:sub-spawn', (data: any) => {
      this.agents.set(data.id, {
        id: data.id, description: data.description, mode: data.mode,
        status: 'running', startedAt: Date.now(), output: '',
      });
      this.updateStatusBtn();
      if (this.open) { this.render(); this.attachHandlers(); }
    });

    bus.on('agent:sub-progress', (data: any) => {
      const entry = this.agents.get(data.parentToolId);
      if (entry) {
        entry.output += data.text;
        if (this.open) { this.render(); this.attachHandlers(); }
      }
    });

    bus.on('agent:sub-done', (data: any) => {
      const entry = this.agents.get(data.parentToolId);
      if (entry) {
        entry.status = data.summary?.hasError ? 'failed' : 'completed';
        entry.elapsedMs = data.summary?.elapsedMs;
        entry.hasError = data.summary?.hasError;
        this.completedOrder.push(data.parentToolId);
        this.updateStatusBtn();
        if (this.open) { this.render(); this.attachHandlers(); }
      }
    });

    bus.on('agent:sub-pool-update', () => {
      this.updateStatusBtn();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Status bar
  // ═══════════════════════════════════════════════════════════

  private updateStatusBtn(): void {
    const running = [...this.agents.values()].filter(a => a.status === 'running').length;
    if (running > 0) {
      this.statusBtn.innerHTML = `${iconHtml('puzzle', 10)} ${running} running`;
      this.statusBtn.style.color = 'var(--signal)';
      this.statusBtn.style.display = '';
    } else if (this.agents.size > 0) {
      this.statusBtn.innerHTML = `${iconHtml('puzzle', 10)} idle`;
      this.statusBtn.style.color = 'var(--text-faint)';
      this.statusBtn.style.display = '';
    } else {
      this.statusBtn.style.display = 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Show / hide
  // ═══════════════════════════════════════════════════════════

  toggle(): void { this.open ? this.hide() : this.show(); }

  show(): void {
    this.open = true;
    this.el.style.display = 'flex';
    this.render();
    this.attachHandlers();
  }

  hide(): void {
    this.open = false;
    this.el.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════

  private render(): void {
    const running = [...this.agents.values()].filter(a => a.status === 'running');
    const completed = this.completedOrder
      .map(id => this.agents.get(id))
      .filter(Boolean) as SubAgentEntry[];

    if (running.length === 0 && completed.length === 0) {
      this.body.innerHTML =
        `<div style="text-align:center;padding-top:40px;color:var(--text-faint)">
          ${iconHtml('puzzle', 20)}<br><br>无运行中或已完成的子Agent
        </div>`;
      return;
    }

    let html = '';

    // Running section
    if (running.length > 0) {
      html += `<div style="font-family:var(--font-hud);font-size:calc(9px*var(--font-scale));color:var(--signal);margin-bottom:8px;letter-spacing:0.5px;">
        ⚡ RUNNING · ${running.length}
      </div>`;
      for (const a of running) {
        html += this.renderAgent(a);
      }
    }

    // Completed section
    if (completed.length > 0) {
      html += `<div style="font-family:var(--font-hud);font-size:calc(9px*var(--font-scale));color:var(--text-faint);margin:12px 0 8px;letter-spacing:0.5px;">
        ✅ RECENT · ${completed.length}
      </div>`;
      for (const a of completed.slice(-10)) {
        html += this.renderAgent(a);
      }
    }

    this.body.innerHTML = html;
  }

  private renderAgent(a: SubAgentEntry): string {
    const elapsed = a.elapsedMs
      ? (a.elapsedMs / 1000).toFixed(1) + 's'
      : Math.round((Date.now() - a.startedAt) / 1000) + 's';

    const icon = a.status === 'running' ? '⚡'
      : a.status === 'completed' ? '✅'
      : a.status === 'failed' ? '❌'
      : '⏹️';

    const color = a.status === 'running' ? 'var(--signal)'
      : a.status === 'failed' ? 'var(--anomaly-red)'
      : 'var(--anomaly-green)';

    const outputPreview = a.output.length > 200
      ? a.output.slice(-200)
      : a.output;

    return `<div class="sa-entry" style="margin-bottom:10px;border:1px solid rgba(40,70,130,0.12);border-radius:4px;overflow:hidden;">
      <div class="sa-header" data-sa-id="${a.id}" style="display:flex;justify-content:space-between;align-items:center;padding:5px 8px;background:rgba(15,30,55,0.3);cursor:pointer;user-select:none;">
        <span style="color:${color};font-size:calc(10px*var(--font-scale));">${icon} ${escapeHtml(a.description)}</span>
        <span style="color:var(--text-faint);font-size:calc(9px*var(--font-scale));">${elapsed} · ${a.mode}</span>
      </div>
      <div class="sa-body" data-sa-id="${a.id}" style="display:${a.status === 'running' ? '' : 'none'};padding:6px 8px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;color:var(--text-dim);font-size:calc(9.5px*var(--font-scale));line-height:1.5;background:rgba(2,6,16,0.3);">
        ${escapeHtml(outputPreview)}${a.output.length > 200 ? '\n…[截断，仅显示最后200字符]' : ''}
      </div>
    </div>`;
  }

  /** Called after DOM render to attach toggle handlers. */
  attachHandlers(): void {
    this.body.querySelectorAll('.sa-header').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const id = (hdr as HTMLElement).dataset['saId']!;
        const body = this.body.querySelector(`.sa-body[data-sa-id="${id}"]`) as HTMLElement;
        if (body) {
          body.style.display = body.style.display === 'none' ? '' : 'none';
          // Refresh output when expanding
          const entry = this.agents.get(id);
          if (entry && body.style.display !== 'none') {
            const preview = entry.output.length > 200 ? entry.output.slice(-200) : entry.output;
            body.textContent = preview + (entry.output.length > 200 ? '\n…[截断，仅显示最后200字符]' : '');
          }
        }
      });
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
