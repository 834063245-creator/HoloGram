// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// DataflowPanel — trace browser. Agent produces traces → dataflow_save → panel renders.
// Quick explore (engine-powered) available as secondary fallback.

import { invoke } from '../bridge';
import { shell } from './app-shell';
import { iconHtml } from './icons';

interface TraceSummary {
  traceId: string;
  query: string;
  createdAt: string;
  hasContent: boolean;
}

export class DataflowPanel {
  private el!: HTMLElement;
  private header!: HTMLElement;
  private left!: HTMLElement;
  private right!: HTMLElement;
  private grip!: HTMLElement;
  private openState = false;

  /** Called when NL query fails heuristic symbol resolution. Agent resolves NL→symbols. */
  onParseQuery?: (nl: string) => Promise<string[]>;

  private traces: TraceSummary[] = [];
  private selectedTraceId: string | null = null;
  private selectedTrace: any = null;
  private tracesLoaded = false; // ponytail: in-memory cache, re-read only on save/refresh

  private dragging = false;
  private resizing = false;
  private dragStart = { x: 0, y: 0, elX: 0, elY: 0, w: 0, h: 0 };

  constructor(container: HTMLElement) {
    this.buildDOM(container);
    // Auto-refresh when Agent saves a new trace (browser-native, no bus dep)
    window.addEventListener('dataflow:saved', () => {
      this.tracesLoaded = false;
      if (this.openState) this.loadTraceList();
    });
    // Reset on workspace switch — traces are scoped per workspace
    window.addEventListener('workspace:switched', () => {
      this.tracesLoaded = false;
      this.selectedTraceId = null;
      this.selectedTrace = null;
      if (this.openState) this.loadTraceList();
    });
  }

  // ── DOM ───────────────────────────────────────────────

  private buildDOM(container: HTMLElement): void {
    this.el = document.createElement('div');
    this.el.id = 'dataflow-panel';
    Object.assign(this.el.style, {
      position: 'fixed', zIndex: '78',
      left: '120px', top: '90px', width: '900px', height: '560px',
      display: 'none', flexDirection: 'column',
    });

    // header
    this.header = document.createElement('div');
    this.header.className = 'df-panel-header';
    Object.assign(this.header.style, { cursor: 'move', userSelect: 'none' });
    this.header.innerHTML = `<span class="df-panel-title">数据流</span>`;
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

    // left: trace list + quick explore
    this.left = document.createElement('div');
    this.left.className = 'df-left';
    Object.assign(this.left.style, { width: '260px', minWidth: '180px', display: 'flex', flexDirection: 'column', borderRight: '1px solid rgba(40,70,130,0.15)' });
    body.appendChild(this.left);

    // right: trace content
    this.right = document.createElement('div');
    this.right.className = 'df-right';
    Object.assign(this.right.style, { flex: '1', overflow: 'auto', padding: '14px' });
    this.right.innerHTML = `<div class="df-empty">加载已存追踪…</div>`;
    body.appendChild(this.right);

    this.el.appendChild(body);

    // resize grip
    this.grip = document.createElement('div');
    this.grip.className = 'df-grip';
    this.el.appendChild(this.grip);

    container.appendChild(this.el);

    // drag + resize
    this.header.addEventListener('pointerdown', (e) => this.onDragStart(e));
    this.grip.addEventListener('pointerdown', (e) => this.onResizeStart(e));
    this.el.addEventListener('pointerdown', () => this.bringToFront());
  }

  // ── Open / close ──────────────────────────────────────

  toggle(): void { this.openState ? this.close() : this.open(); }

  open(): void {
    if (this.openState) return;
    this.openState = true;
    this.el.style.display = 'flex';
    this.bringToFront();
    shell.notifyPanelChanged();
    if (!this.tracesLoaded) this.loadTraceList();
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

  // ── Trace list ────────────────────────────────────────

  private async loadTraceList(): Promise<void> {
    try {
      const raw = await invoke<string>('dataflow_query', { list: true });
      const data = JSON.parse(raw);
      this.traces = data.traces || [];
      this.tracesLoaded = true;
    } catch {
      this.traces = [];
    }
    this.renderTraceList();
    if (!this.selectedTraceId && this.traces.length === 0) {
      this.renderRightEmpty();
    }
  }

  private renderTraceList(): void {
    this.left.innerHTML = '';
    this.left.style.cssText = 'width:260px; min-width:180px; display:flex; flex-direction:column; border-right:1px solid rgba(40,70,130,0.15);';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'df-trace-list-hdr';
    hdr.innerHTML = `<span>已存追踪 (${this.traces.length})</span>`;
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'df-hist-clear';
    refreshBtn.innerHTML = `${iconHtml('search', 11)} 刷新`;
    refreshBtn.onclick = () => this.loadTraceList();
    hdr.appendChild(refreshBtn);
    this.left.appendChild(hdr);

    // Trace list
    const list = document.createElement('div');
    list.className = 'df-hist-list';
    if (this.traces.length === 0) {
      list.innerHTML = `<div class="df-empty" style="padding:16px 12px; line-height:1.6;">
        暂无已存追踪。<br><br>
        在对话中让 Agent 追踪数据流，<br>
        结果会出现在这里。
      </div>`;
    } else {
      list.innerHTML = this.traces.map((t) => {
        const time = new Date(t.createdAt);
        const timeStr = `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
        const badge = t.hasContent ? ' <span class="df-trace-agent-badge">Agent</span>' : ' <span class="df-trace-engine-badge">引擎</span>';
        const sel = t.traceId === this.selectedTraceId ? ' df-hist-item-sel' : '';
        return `<div class="df-hist-item${sel}" data-tid="${t.traceId}">
          <div class="df-hist-query">${this.esc(t.query.length > 50 ? t.query.slice(0, 50) + '…' : t.query)}${badge}</div>
          <div class="df-hist-sub">${timeStr}</div>
          <button class="df-hist-del" data-tid="${t.traceId}" title="删除此追踪">${iconHtml('close', 10)}</button>
        </div>`;
      }).join('');

      list.querySelectorAll('.df-hist-item').forEach((el) => {
        (el as HTMLElement).onclick = () => {
          const tid = (el as HTMLElement).dataset['tid'];
          if (tid) this.selectTrace(tid);
        };
      });
      list.querySelectorAll('.df-hist-del').forEach((btn) => {
        (btn as HTMLElement).onclick = async (e) => {
          e.stopPropagation();
          const tid = (btn as HTMLElement).dataset['tid'];
          if (tid) await this.deleteTrace(tid);
        };
      });
    }
    this.left.appendChild(list);

    // Quick explore (引擎直查，不落盘；Agent 追踪在聊天面板里做)
    const exploreArea = document.createElement('div');
    exploreArea.className = 'df-query-area';
    const lbl = document.createElement('div');
    lbl.className = 'df-hist-sub';
    lbl.style.cssText = 'margin-bottom:4px;';
    lbl.textContent = '引擎直查（不保存）';
    exploreArea.appendChild(lbl);
    const input = document.createElement('textarea');
    input.className = 'df-query-input';
    input.placeholder = '符号名或查询…';
    input.rows = 2;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.doExplore(input.value.trim()); }
    });
    const btn = document.createElement('button');
    btn.className = 'df-query-btn';
    btn.innerHTML = `${iconHtml('search', 13)} 探索`;
    btn.onclick = () => this.doExplore(input.value.trim());
    exploreArea.appendChild(input);
    exploreArea.appendChild(btn);
    this.left.appendChild(exploreArea);
  }

  private async deleteTrace(traceId: string): Promise<void> {
    try {
      await invoke<string>('dataflow_delete', { traceId });
      // Remove from local cache
      this.traces = this.traces.filter(t => t.traceId !== traceId);
      if (this.selectedTraceId === traceId) {
        this.selectedTraceId = null;
        this.selectedTrace = null;
        this.renderRightEmpty();
      }
      this.renderTraceList();
    } catch (e: any) {
      console.error('[dataflow] delete failed:', e);
    }
  }

  // ── Select & render trace ─────────────────────────────

  private async selectTrace(traceId: string): Promise<void> {
    this.selectedTraceId = traceId;
    this.right.innerHTML = `<div class="df-loading">加载中…</div>`;
    // Re-render list to highlight selected
    this.renderTraceList();

    try {
      const raw = await invoke<string>('dataflow_query', { traceId });
      this.selectedTrace = JSON.parse(raw);
      this.renderTraceContent(this.selectedTrace);
    } catch (e: any) {
      this.right.innerHTML = `<div class="df-empty">加载失败: ${e?.message || e}</div>`;
    }
  }

  private renderTraceContent(trace: any): void {
    const content = trace.content;
    const exploreResult = trace.exploreResult ? (typeof trace.exploreResult === 'string' ? JSON.parse(trace.exploreResult) : trace.exploreResult) : null;
    const dataflowResult = trace.dataflowResult ? (typeof trace.dataflowResult === 'string' ? JSON.parse(trace.dataflowResult) : trace.dataflowResult) : null;

    const parts: string[] = [];

    // Meta bar
    const time = trace.createdAt ? new Date(trace.createdAt) : null;
    const timeStr = time ? `${time.getMonth() + 1}/${time.getDate()} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}` : '未知';
    parts.push(`<div class="df-trace-meta-bar">
      <span class="df-trace-meta-q">${this.esc(trace.query || '')}</span>
      <span class="df-trace-meta-t">${timeStr}</span>
      <span class="df-trace-meta-id">${this.esc(trace.traceId || '')}</span>
    </div>`);

    // Primary: Agent content (markdown)
    if (content) {
      parts.push(`<div class="df-trace-body">${this.renderMd(content)}</div>`);
    }

    // Secondary: engine data (collapsed by default)
    if (exploreResult || dataflowResult) {
      parts.push(`<details class="df-engine-data">
        <summary class="df-engine-summary">引擎原始数据</summary>
        <div class="df-engine-body">`);
      if (exploreResult) {
        parts.push(this.renderEngineExplore(exploreResult));
      }
      if (dataflowResult) {
        parts.push(this.renderEngineDataflow(dataflowResult));
      }
      parts.push(`</div></details>`);
    }

    if (!content && !exploreResult && !dataflowResult) {
      parts.push(`<div class="df-empty">此追踪内容为空。</div>`);
    }

    this.right.innerHTML = parts.join('');
  }

  private renderRightEmpty(): void {
    this.right.innerHTML = `<div class="df-empty df-empty-welcome">
      <div class="df-empty-icon">◈</div>
      <div>选择左侧已存追踪查看数据流。</div>
      <div class="df-empty-sub">或使用底部快速探索查询引擎。</div>
    </div>`;
  }

  // ── Markdown renderer (minimal) ───────────────────────

  private renderMd(text: string): string {
    if (!text) return '';
    const blocks = text.split(/\n\n+/);
    return blocks.map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      const lines = trimmed.split('\n');
      const first = lines[0].trim();

      // Code block
      if (first.startsWith('```')) {
        const lang = first.slice(3).trim();
        const codeLines = lines.slice(1);
        // Remove trailing ```
        const lastIdx = codeLines.findIndex(l => l.trim() === '```');
        const code = lastIdx >= 0 ? codeLines.slice(0, lastIdx) : codeLines;
        return `<pre class="df-md-code">${this.esc(code.join('\n'))}</pre>`;
      }

      // Heading
      if (first.startsWith('## ')) {
        return `<h3 class="df-md-h3">${this.inlineMd(first.slice(3))}</h3>`;
      }
      if (first.startsWith('### ')) {
        return `<h4 class="df-md-h4">${this.inlineMd(first.slice(4))}</h4>`;
      }

      // HR
      if (first === '---' || first === '***' || first === '___') {
        return '<hr class="df-md-hr">';
      }

      // List
      if (first.match(/^[-*]\s/)) {
        const items = lines.filter(l => l.trim()).map(l =>
          `<li>${this.inlineMd(l.replace(/^[-*]\s*/, ''))}</li>`
        ).join('');
        return `<ul class="df-md-ul">${items}</ul>`;
      }

      // Numbered list
      if (first.match(/^\d+\.\s/)) {
        const items = lines.filter(l => l.trim()).map(l =>
          `<li>${this.inlineMd(l.replace(/^\d+\.\s*/, ''))}</li>`
        ).join('');
        return `<ol class="df-md-ol">${items}</ol>`;
      }

      // Table (simple: pipe-separated)
      if (first.startsWith('|') && first.endsWith('|')) {
        return this.renderMdTable(lines);
      }

      // Blockquote
      if (first.startsWith('> ')) {
        const text = lines.map(l => l.replace(/^>\s?/, '')).join('\n');
        return `<blockquote class="df-md-bq">${this.inlineMd(text)}</blockquote>`;
      }

      // Paragraph (join all lines)
      return `<p class="df-md-p">${this.inlineMd(trimmed.replace(/\n/g, ' '))}</p>`;
    }).join('');
  }

  private inlineMd(text: string): string {
    return this.esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/`(.+?)`/g, '<code class="df-md-inline-code">$1</code>')
      .replace(/→/g, '<span class="df-md-arrow">→</span>');
  }

  private renderMdTable(lines: string[]): string {
    if (lines.length < 2) return '';
    // Header row
    const headerCells = lines[0].split('|').filter(c => c.trim());
    const thead = `<thead><tr>${headerCells.map(c => `<th>${this.inlineMd(c.trim())}</th>`).join('')}</tr></thead>`;
    // Body (skip separator line like |---|)
    const bodyRows = lines.slice(1).filter(l => !l.match(/^\|[\s\-:|]+\|$/));
    const tbody = bodyRows.length > 0
      ? `<tbody>${bodyRows.map(row => {
          const cells = row.split('|').filter(c => c.trim());
          return `<tr>${cells.map(c => `<td>${this.inlineMd(c.trim())}</td>`).join('')}</tr>`;
        }).join('')}</tbody>`
      : '';
    return `<table class="df-md-table">${thead}${tbody}</table>`;
  }

  // ── Legacy engine renderers (fallback for old traces) ─

  private renderEngineExplore(explore: any): string {
    const parts: string[] = [];
    const meta = explore.meta || {};
    const flow = explore.flow;
    const relationships = explore.relationships || {};
    const sourceCode = explore.sourceCode || [];
    const blastRadius = explore.blastRadius || {};
    const alerts = explore.architectureAlerts || {};

    parts.push(`<div class="df-result-meta">
      <span>${iconHtml('search', 12)} ${meta.totalSymbolsFound || 0} 符号</span>
      <span>${iconHtml('file', 12)} ${meta.totalFilesScanned || 0} 文件</span>
    </div>`);

    if (flow && flow.path) parts.push(this.renderFlow(flow));
    if (Object.keys(relationships).length) parts.push(this.renderRelationships(relationships, Object.keys(relationships)));
    if (sourceCode.length) parts.push(this.renderSourceCode(sourceCode));
    if ((blastRadius.dependents || []).length || (blastRadius.tests || []).length) parts.push(this.renderBlastRadius(blastRadius.dependents || [], blastRadius.tests || []));
    const alertKeys = Object.keys(alerts).filter(k => alerts[k] && (Array.isArray(alerts[k]) ? alerts[k].length > 0 : true));
    if (alertKeys.length) parts.push(this.renderAlerts(alerts, alertKeys));

    return parts.join('');
  }

  private renderEngineDataflow(dfResult: any): string {
    const results: any[] = dfResult.results || [];
    if (results.length === 0) return '';
    let html = `<div class="df-section"><div class="df-section-hdr">数据流引擎 (tree-sitter)</div>`;
    for (const r of results) {
      if (r.error) {
        html += `<div class="df-df-file"><span class="df-df-fname">${this.esc(r.file)}</span> <span class="df-meta-hint">${this.esc(r.error)}</span></div>`;
        continue;
      }
      const scopes: any[] = r.scopes || [];
      const shared: any[] = r.shared || [];
      if (scopes.length === 0 && shared.length === 0) continue;
      html += `<div class="df-df-file"><div class="df-df-fname">${this.esc(r.file)}</div>`;
      if (scopes.length > 0) {
        html += `<table class="df-df-table"><thead><tr><th>函数</th><th>读取</th><th>写入</th><th>触发</th><th>异步/回调</th><th>调用序列</th></tr></thead><tbody>`;
        for (const s of scopes) {
          html += `<tr><td class="df-df-scope">${this.esc(s.name)}</td>
            <td>${(s.reads || []).map(this.esc).join(', ') || '—'}</td>
            <td>${(s.writes || []).map(this.esc).join(', ') || '—'}</td>
            <td>${(s.triggers || []).map(this.esc).join(', ') || '—'}</td>
            <td>${(s.awaits_callbacks || []).map(this.esc).join(', ') || '—'}</td>
            <td>${(s.sequence_calls || []).map(this.esc).join(', ') || '—'}</td></tr>`;
        }
        html += `</tbody></table>`;
      }
      if (shared.length > 0) {
        html += `<div class="df-df-shared-hdr">共享变量</div>`;
        for (const sh of shared) {
          html += `<div class="df-df-shared"><span class="df-df-var">${this.esc(sh.var)}</span>
            <span class="df-df-rw">读: ${(sh.readers || []).map(this.esc).join(', ') || '—'}</span>
            <span class="df-df-rw">写: ${(sh.writers || []).map(this.esc).join(', ') || '—'}</span></div>`;
        }
      }
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  private renderFlow(flow: any): string {
    const steps = flow.path || [];
    if (steps.length === 0) return '';
    const rows = steps.map((s: any) => {
      if (s.edge) {
        return `<div class="df-flow-edge"><span class="df-flow-arrow">↓</span><span class="df-flow-ekind">${this.esc(s.edge)}</span></div>`;
      }
      const loc = s.file ? `${s.file}${s.line ? ':' + s.line : ''}` : '—';
      return `<div class="df-flow-node"><span class="df-flow-kind">${this.esc(s.kind || '')}</span><span class="df-flow-name">${this.esc(s.name || '')}</span><span class="df-flow-loc">${this.esc(loc)}</span></div>`;
    }).join('');
    return `<div class="df-section"><div class="df-section-hdr">数据流路径 (${Math.floor(steps.length / 2) + 1} 节点, ${Math.floor(steps.length / 2)} 跳)</div><div class="df-flow">${rows}</div></div>`;
  }

  private renderRelationships(relationships: any, keys: string[]): string {
    const rows = keys.map(kind => {
      const edges = relationships[kind] || [];
      const items = edges.slice(0, 30).map((e: any) =>
        `<div class="df-rel-item"><span class="df-rel-src">${this.esc(e.source)}</span> → <span class="df-rel-tgt">${this.esc(e.target)}</span></div>`).join('');
      const more = edges.length > 30 ? `<div class="df-table-more">…及其他 ${edges.length - 30} 条</div>` : '';
      return `<div class="df-rel-group"><div class="df-rel-kind">${this.esc(kind)} (${edges.length})</div>${items}${more}</div>`;
    }).join('');
    return `<div class="df-section"><div class="df-section-hdr">关系</div>${rows}</div>`;
  }

  private renderSourceCode(sources: any[]): string {
    const snippets = sources.slice(0, 8).map((s: any) =>
      `<div class="df-src-item"><div class="df-src-loc">${this.esc(s.file || '')}${s.line ? ':' + s.line : ''}</div><pre class="df-src-code">${this.esc(s.code || '')}</pre></div>`).join('');
    const more = sources.length > 8 ? `<div class="df-table-more">…及其他 ${sources.length - 8} 个片段</div>` : '';
    return `<div class="df-section"><div class="df-section-hdr">源码 (${sources.length})</div>${snippets}${more}</div>`;
  }

  private renderBlastRadius(dependents: any[], tests: any[]): string {
    const depItems = dependents.slice(0, 20).map((d: any) =>
      `<div class="df-br-item">${this.esc(d.name)} <span class="df-br-loc">${this.esc(d.file || '')}${d.line ? ':' + d.line : ''}</span></div>`).join('');
    const testItems = tests.slice(0, 10).map((t: any) =>
      `<div class="df-br-item df-br-test">🧪 ${this.esc(t.name)} <span class="df-br-loc">${this.esc(t.file || '')}${t.line ? ':' + t.line : ''}</span></div>`).join('');
    return `<div class="df-section"><div class="df-section-hdr">影响范围</div>
      ${dependents.length > 0 ? `<div class="df-br-sub">依赖者 (${dependents.length})</div>${depItems}${dependents.length > 20 ? `<div class="df-table-more">…及其他 ${dependents.length - 20} 个</div>` : ''}` : ''}
      ${tests.length > 0 ? `<div class="df-br-sub">相关测试 (${tests.length})</div>${testItems}${tests.length > 10 ? `<div class="df-table-more">…及其他 ${tests.length - 10} 个</div>` : ''}` : ''}</div>`;
  }

  private renderAlerts(alerts: any, keys: string[]): string {
    const rows = keys.map(k => {
      const v = alerts[k];
      const display = Array.isArray(v) ? `${v.length} 项` : String(v);
      return `<div class="df-alert-row"><span class="df-alert-key">${this.esc(k)}</span>: ${this.esc(display)}</div>`;
    }).join('');
    return `<div class="df-section"><div class="df-section-hdr">架构提醒</div>${rows}</div>`;
  }

  // ── Quick explore (engine, secondary) ─────────────────

  private async doExplore(query: string): Promise<void> {
    if (!query) return;
    this.selectedTraceId = null;
    this.selectedTrace = null;
    this.right.innerHTML = `<div class="df-loading">探索中…</div>`;

    try {
      let raw = await invoke<string>('hologram_call', { tool: 'explore_deps', args: { query, symbols: [], includeSource: true } });
      let explore = JSON.parse(raw);

      if ((explore.meta?.totalSymbolsFound || 0) === 0 && this.onParseQuery) {
        try {
          const symbols = await this.onParseQuery(query);
          if (symbols.length > 0) {
            raw = await invoke<string>('hologram_call', { tool: 'explore_deps', args: { query, symbols, includeSource: true } });
            explore = JSON.parse(raw);
          }
        } catch { /* Agent unavailable */ }
      }

      const fileSet = new Set<string>();
      (explore.flow?.path || []).forEach((s: any) => { if (s.file) fileSet.add(s.file); });
      (explore.sourceCode || []).forEach((s: any) => { if (s.file) fileSet.add(s.file); });
      (explore.blastRadius?.dependents || []).forEach((d: any) => { if (d.file) fileSet.add(d.file); });

      let dfResult: any = null;
      const files = Array.from(fileSet);
      if (files.length > 0) {
        try {
          const dfRaw = await invoke<string>('hologram_call', { tool: 'trace_dataflow', args: { files } });
          dfResult = JSON.parse(dfRaw);
        } catch { /* optional */ }
      }

      this.right.innerHTML = this.renderEngineExplore(explore) + (dfResult ? this.renderEngineDataflow(dfResult) : '');
    } catch (e: any) {
      this.right.innerHTML = `<div class="df-empty">探索失败: ${e?.message || e}</div>`;
    }
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

  // ── Util ──────────────────────────────────────────────

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy(): void { this.el.remove(); }
}
