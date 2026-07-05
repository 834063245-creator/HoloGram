// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// DataflowPanel — live dataflow explorer powered by hologram_explore.
// No trace storage, no Agent snapshots. Engine queries only.
// Type a natural-language query → engine resolves symbols → renders flow live.

import { invoke } from '../bridge';
import { shell } from './app-shell';
import { iconHtml } from './icons';

const HISTORY_KEY = 'hologram_dataflow_history';
const MAX_HISTORY = 50;

interface HistoryEntry {
  query: string;
  timestamp: number;
  symbolsFound: number;
}

export class DataflowPanel {
  private el!: HTMLElement;
  private header!: HTMLElement;
  private left!: HTMLElement;
  private right!: HTMLElement;
  private grip!: HTMLElement;
  private openState = false;
  private history: HistoryEntry[] = [];
  private resultData: any = null;

  private dragging = false;
  private resizing = false;
  private dragStart = { x: 0, y: 0, elX: 0, elY: 0, w: 0, h: 0 };

  constructor(container: HTMLElement) {
    this.loadHistory();
    this.buildDOM(container);
  }

  // ── DOM ───────────────────────────────────────────────

  private buildDOM(container: HTMLElement): void {
    this.el = document.createElement('div');
    this.el.id = 'dataflow-panel';
    Object.assign(this.el.style, {
      position: 'fixed', zIndex: '78',
      left: '120px', top: '90px', width: '800px', height: '520px',
      display: 'none', flexDirection: 'column',
    });

    // header
    this.header = document.createElement('div');
    this.header.className = 'df-panel-header';
    Object.assign(this.header.style, { cursor: 'move', userSelect: 'none' });
    this.header.innerHTML = `<span class="df-panel-title">数据流探索</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'df-panel-close';
    closeBtn.innerHTML = iconHtml('close', 15);
    closeBtn.onclick = () => this.close();
    closeBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    this.header.appendChild(closeBtn);
    this.el.appendChild(this.header);

    // body
    const body = document.createElement('div');
    body.className = 'df-panel-body';
    Object.assign(body.style, { display: 'flex', flex: '1', minHeight: '0', overflow: 'hidden' });

    // left: query + history
    this.left = document.createElement('div');
    this.left.className = 'df-left';
    Object.assign(this.left.style, { width: '240px', minWidth: '180px', display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(40,70,130,0.15)' });

    // query input area
    const inputArea = document.createElement('div');
    inputArea.className = 'df-query-area';
    const input = document.createElement('textarea');
    input.className = 'df-query-input';
    input.placeholder = '用自然语言描述要追踪的数据流…\n如: logBuffer 怎么写入落盘的';
    input.rows = 3;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.doExplore(input.value.trim()); }
    });
    const btn = document.createElement('button');
    btn.className = 'df-query-btn';
    btn.innerHTML = `${iconHtml('search', 13)} 探索`;
    btn.onclick = () => this.doExplore(input.value.trim());
    inputArea.appendChild(input);
    inputArea.appendChild(btn);
    this.left.appendChild(inputArea);

    // history
    const histHdr = document.createElement('div');
    histHdr.className = 'df-hist-hdr';
    histHdr.textContent = '历史';
    const clearHist = document.createElement('button');
    clearHist.className = 'df-hist-clear';
    clearHist.textContent = '清空';
    clearHist.onclick = () => { this.history = []; this.saveHistory(); this.renderHistory(); };
    histHdr.appendChild(clearHist);
    this.left.appendChild(histHdr);

    const histList = document.createElement('div');
    histList.className = 'df-hist-list';
    this.left.appendChild(histList);

    body.appendChild(this.left);

    // right: results
    this.right = document.createElement('div');
    this.right.className = 'df-right';
    Object.assign(this.right.style, { flex: '1', overflow: 'auto', padding: '12px' });
    this.right.innerHTML = `<div class="df-empty">输入查询，探索代码数据流。</div>`;
    body.appendChild(this.right);

    this.el.appendChild(body);

    // corner brackets
    const corners = document.createElement('div');
    corners.className = 'df-corners';
    corners.innerHTML = '<span class="df-cb-bottom df-cb-bl"></span><span class="df-cb-bottom df-cb-br"></span>';
    this.el.appendChild(corners);

    // resize grip
    this.grip = document.createElement('div');
    this.grip.className = 'df-grip';
    this.el.appendChild(this.grip);

    container.appendChild(this.el);

    // drag + resize
    this.header.addEventListener('pointerdown', (e) => this.onDragStart(e));
    this.grip.addEventListener('pointerdown', (e) => this.onResizeStart(e));
    this.el.addEventListener('pointerdown', () => this.bringToFront());

    this.renderHistory();
  }

  // ── Explore ───────────────────────────────────────────

  private async doExplore(query: string): Promise<void> {
    if (!query) return;
    this.right.innerHTML = `<div class="df-loading">探索中…</div>`;

    try {
      const raw = await invoke<string>('hologram_explore', {
        query,
        symbols: [],
        includeSource: true,
      });
      const data = JSON.parse(raw);
      this.resultData = data;
      this.renderResults(data);

      // save to history
      const symbolsFound = data.meta?.totalSymbolsFound || 0;
      this.history.unshift({ query, timestamp: Date.now(), symbolsFound });
      if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
      this.saveHistory();
      this.renderHistory();
    } catch (e: any) {
      this.right.innerHTML = `<div class="df-empty">探索失败: ${e?.message || e}</div>`;
    }
  }

  // ── Render results ────────────────────────────────────

  private renderResults(data: any): void {
    const meta = data.meta || {};
    const flow = data.flow;
    const relationships = data.relationships || {};
    const sourceCode = data.sourceCode || [];
    const blastRadius = data.blastRadius || {};
    const alerts = data.architectureAlerts || {};

    const parts: string[] = [];

    // Meta
    parts.push(`<div class="df-result-meta">
      <span>${iconHtml('search', 12)} ${meta.totalSymbolsFound || 0} 个符号</span>
      <span>${iconHtml('file', 12)} ${meta.totalFilesScanned || 0} 个文件</span>
      ${meta.hint ? `<span class="df-meta-hint">${this.esc(meta.hint)}</span>` : ''}
    </div>`);

    // Flow
    if (flow && flow.path) {
      parts.push(this.renderFlow(flow));
    }

    // Relationships
    const relKeys = Object.keys(relationships);
    if (relKeys.length > 0) {
      parts.push(this.renderRelationships(relationships, relKeys));
    }

    // Blast radius
    const deps = blastRadius.dependents || [];
    const tests = blastRadius.tests || [];
    if (deps.length > 0 || tests.length > 0) {
      parts.push(this.renderBlastRadius(deps, tests));
    }

    // Source code
    if (sourceCode.length > 0) {
      parts.push(this.renderSourceCode(sourceCode));
    }

    // Architecture alerts
    const alertKeys = Object.keys(alerts).filter(k => {
      const v = alerts[k];
      return v && (Array.isArray(v) ? v.length > 0 : true);
    });
    if (alertKeys.length > 0) {
      parts.push(this.renderAlerts(alerts, alertKeys));
    }

    // Node IDs for 3D linkage
    const nodeIds = data.nodeIds || [];
    if (nodeIds.length > 0) {
      parts.push(`<div class="df-node-ids">
        <span class="df-section-hdr">图谱节点 (${nodeIds.length})</span>
        <div class="df-node-id-list">${nodeIds.slice(0, 20).map((id: string) =>
          `<span class="df-node-id-chip">${this.esc(id)}</span>`).join('')}
          ${nodeIds.length > 20 ? `<span class="df-node-id-chip">…及其他 ${nodeIds.length - 20} 个</span>` : ''}
        </div>
      </div>`);
    }

    this.right.innerHTML = parts.join('') || `<div class="df-empty">未找到匹配的数据流。</div>`;
  }

  private renderFlow(flow: any): string {
    const steps = flow.path || [];
    if (steps.length === 0) return '';

    const rows = steps.map((s: any) => {
      if (s.edge) {
        return `<div class="df-flow-edge">
          <span class="df-flow-arrow">↓</span>
          <span class="df-flow-ekind">${this.esc(s.edge)}</span>
        </div>`;
      }
      const loc = s.file ? `${s.file}${s.line ? ':' + s.line : ''}` : '—';
      return `<div class="df-flow-node">
        <span class="df-flow-kind">${this.esc(s.kind || '')}</span>
        <span class="df-flow-name">${this.esc(s.name || '')}</span>
        <span class="df-flow-loc">${this.esc(loc)}</span>
      </div>`;
    }).join('');

    return `<div class="df-section">
      <div class="df-section-hdr">数据流路径 (${Math.floor(steps.length / 2) + 1} 节点, ${Math.floor(steps.length / 2)} 跳)</div>
      <div class="df-flow">${rows}</div>
    </div>`;
  }

  private renderRelationships(relationships: any, keys: string[]): string {
    const rows = keys.map(kind => {
      const edges = relationships[kind] || [];
      const items = edges.slice(0, 30).map((e: any) =>
        `<div class="df-rel-item"><span class="df-rel-src">${this.esc(e.source)}</span> → <span class="df-rel-tgt">${this.esc(e.target)}</span></div>`
      ).join('');
      const more = edges.length > 30 ? `<div class="df-table-more">…及其他 ${edges.length - 30} 条</div>` : '';
      return `<div class="df-rel-group">
        <div class="df-rel-kind">${this.esc(kind)} (${edges.length})</div>
        ${items}${more}
      </div>`;
    }).join('');

    return `<div class="df-section">
      <div class="df-section-hdr">关系</div>
      ${rows}
    </div>`;
  }

  private renderSourceCode(sources: any[]): string {
    const snippets = sources.slice(0, 8).map((s: any) =>
      `<div class="df-src-item">
        <div class="df-src-loc">${this.esc(s.file || '')}${s.line ? ':' + s.line : ''}</div>
        <pre class="df-src-code">${this.esc(s.code || '')}</pre>
      </div>`
    ).join('');
    const more = sources.length > 8 ? `<div class="df-table-more">…及其他 ${sources.length - 8} 个片段</div>` : '';

    return `<div class="df-section">
      <div class="df-section-hdr">源码 (${sources.length})</div>
      ${snippets}${more}
    </div>`;
  }

  private renderBlastRadius(dependents: any[], tests: any[]): string {
    const depItems = dependents.slice(0, 20).map((d: any) =>
      `<div class="df-br-item">${this.esc(d.name)} <span class="df-br-loc">${this.esc(d.file || '')}${d.line ? ':' + d.line : ''}</span></div>`
    ).join('');
    const testItems = tests.slice(0, 10).map((t: any) =>
      `<div class="df-br-item df-br-test">🧪 ${this.esc(t.name)} <span class="df-br-loc">${this.esc(t.file || '')}${t.line ? ':' + t.line : ''}</span></div>`
    ).join('');

    return `<div class="df-section">
      <div class="df-section-hdr">影响范围</div>
      ${dependents.length > 0 ? `<div class="df-br-sub">依赖者 (${dependents.length})</div>${depItems}${dependents.length > 20 ? `<div class="df-table-more">…及其他 ${dependents.length - 20} 个</div>` : ''}` : ''}
      ${tests.length > 0 ? `<div class="df-br-sub">相关测试 (${tests.length})</div>${testItems}${tests.length > 10 ? `<div class="df-table-more">…及其他 ${tests.length - 10} 个</div>` : ''}` : ''}
    </div>`;
  }

  private renderAlerts(alerts: any, keys: string[]): string {
    const rows = keys.map(k => {
      const v = alerts[k];
      const display = Array.isArray(v) ? `${v.length} 项` : String(v);
      return `<div class="df-alert-row"><span class="df-alert-key">${this.esc(k)}</span>: ${this.esc(display)}</div>`;
    }).join('');
    return `<div class="df-section">
      <div class="df-section-hdr">架构提醒</div>
      ${rows}
    </div>`;
  }

  // ── History ───────────────────────────────────────────

  private loadHistory(): void {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      this.history = raw ? JSON.parse(raw) : [];
    } catch { this.history = []; }
  }

  private saveHistory(): void {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch { /* quota exceeded */ }
  }

  private renderHistory(): void {
    const list = this.left.querySelector('.df-hist-list');
    if (!list) return;
    if (this.history.length === 0) {
      list.innerHTML = `<div class="df-empty">暂无历史</div>`;
      return;
    }
    list.innerHTML = this.history.map((h, i) => {
      const time = new Date(h.timestamp);
      const timeStr = `${time.getMonth() + 1}/${time.getDate()} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
      return `<div class="df-hist-item" data-idx="${i}">
        <div class="df-hist-query">${this.esc(h.query.length > 40 ? h.query.slice(0, 40) + '…' : h.query)}</div>
        <div class="df-hist-sub">${timeStr} · ${h.symbolsFound} 符号</div>
      </div>`;
    }).join('');
    list.querySelectorAll('.df-hist-item').forEach((el) => {
      (el as HTMLElement).onclick = () => {
        const idx = parseInt((el as HTMLElement).dataset['idx'] || '0');
        const entry = this.history[idx];
        if (entry) {
          const input = this.left.querySelector('.df-query-input') as HTMLTextAreaElement;
          if (input) input.value = entry.query;
          this.doExplore(entry.query);
        }
      };
    });
  }

  // ── Open / close ──────────────────────────────────────

  toggle(): void { this.openState ? this.close() : this.open(); }

  open(): void {
    if (this.openState) return;
    this.openState = true;
    this.el.style.display = 'flex';
    this.bringToFront();
    shell.notifyPanelChanged();
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.el.style.display = 'none';
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.openState; }

  private bringToFront(): void {
    this.el.style.zIndex = String(Math.max(78, Number(this.el.style.zIndex) + 1));
  }

  // ── Drag ──────────────────────────────────────────────

  private onDragStart(e: PointerEvent): void {
    this.dragging = true;
    this.dragStart = {
      x: e.clientX, y: e.clientY,
      elX: parseInt(this.el.style.left) || 0, elY: parseInt(this.el.style.top) || 0,
      w: 0, h: 0,
    };
    (this.header as HTMLElement).setPointerCapture(e.pointerId);
    this.header.addEventListener('pointermove', this.onDragMove);
    this.header.addEventListener('pointerup', this.onDragEnd);
  }

  private onDragMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    this.el.style.left = `${Math.max(0, this.dragStart.elX + dx)}px`;
    this.el.style.top = `${Math.max(0, this.dragStart.elY + dy)}px`;
  };

  private onDragEnd = (e: PointerEvent): void => {
    this.dragging = false;
    (this.header as HTMLElement).releasePointerCapture(e.pointerId);
    this.header.removeEventListener('pointermove', this.onDragMove);
    this.header.removeEventListener('pointerup', this.onDragEnd);
  };

  // ── Resize ────────────────────────────────────────────

  private onResizeStart(e: PointerEvent): void {
    e.stopPropagation();
    this.resizing = true;
    this.dragStart.w = parseInt(this.el.style.width) || 800;
    this.dragStart.h = parseInt(this.el.style.height) || 520;
    this.dragStart.x = e.clientX; this.dragStart.y = e.clientY;
    this.grip.setPointerCapture(e.pointerId);
    this.grip.addEventListener('pointermove', this.onResizeMove);
    this.grip.addEventListener('pointerup', this.onResizeEnd);
  }

  private onResizeMove = (e: PointerEvent): void => {
    if (!this.resizing) return;
    const dw = e.clientX - this.dragStart.x;
    const dh = e.clientY - this.dragStart.y;
    this.el.style.width = `${Math.max(480, this.dragStart.w + dw)}px`;
    this.el.style.height = `${Math.max(300, this.dragStart.h + dh)}px`;
  };

  private onResizeEnd = (e: PointerEvent): void => {
    this.resizing = false;
    this.grip.releasePointerCapture(e.pointerId);
    this.grip.removeEventListener('pointermove', this.onResizeMove);
    this.grip.removeEventListener('pointerup', this.onResizeEnd);
  };

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy(): void { this.el.remove(); }
}
