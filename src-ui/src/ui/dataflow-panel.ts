// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// DataflowPanel — floating window for dataflow trace lifecycle management.
// Left: trace list (invoke dataflow_list). Right: trace detail (invoke dataflow_query).
// New-trace: spawns a dedicated Dataflow Agent via workspace.spawnDataflowTrace.

import { invoke } from '../bridge';
import { shell } from './app-shell';
import { iconHtml } from './icons';

const STATUS_ICON: Record<string, string> = {
  active: iconHtml('check-circle', 13), stale: iconHtml('alert-circle', 13),
  broken: iconHtml('close', 13), deprecated: iconHtml('block', 13),
};

export class DataflowPanel {
  private el!: HTMLElement;
  private header!: HTMLElement;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private grip!: HTMLElement;
  private openState = false;
  private traces: any[] = [];
  private currentTraceId: string | null = null;
  private abortCtrl: AbortController | null = null;

  private dragging = false;
  private resizing = false;
  private dragStart = { x: 0, y: 0, elX: 0, elY: 0, w: 0, h: 0 };

  private onNewTrace?: (query: string, onStatus: (line: string) => void, signal: AbortSignal) => Promise<void>;

  constructor(container: HTMLElement) {
    this.buildDOM(container);
  }

  setNewTraceHandler(h: typeof this.onNewTrace): void { this.onNewTrace = h; }

  // ── DOM ───────────────────────────────────────────────

  private buildDOM(container: HTMLElement): void {
    this.el = document.createElement('div');
    this.el.id = 'dataflow-panel';
    Object.assign(this.el.style, {
      position: 'fixed', zIndex: '78',
      left: '120px', top: '90px', width: '720px', height: '480px',
      display: 'none', flexDirection: 'column',
    });

    // header (drag handle)
    this.header = document.createElement('div');
    this.header.className = 'df-panel-header';
    Object.assign(this.header.style, { cursor: 'move', userSelect: 'none' });
    this.header.innerHTML = `<span class="df-panel-title">数据流追踪</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'df-panel-close';
    closeBtn.innerHTML = iconHtml('close', 15);
    closeBtn.onclick = () => this.close();
    closeBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
    this.header.appendChild(closeBtn);
    this.el.appendChild(this.header);

    // body: list | detail
    const body = document.createElement('div');
    body.className = 'df-panel-body';
    Object.assign(body.style, { display: 'flex', flexDirection: 'row', flex: '1', minHeight: '0' });

    // left: list
    const left = document.createElement('div');
    left.className = 'df-list';
    const toolbar = document.createElement('div');
    toolbar.className = 'df-list-toolbar';
    toolbar.innerHTML = `<button class="df-btn-new">${iconHtml('plus', 14)} 新建</button><button class="df-btn-refresh">${iconHtml('refresh', 14)}</button>`;
    this.listEl = document.createElement('div');
    this.listEl.className = 'df-list-items';
    left.appendChild(toolbar);
    left.appendChild(this.listEl);

    // new-trace form (hidden by default) — 自然语言输入
    const form = document.createElement('div');
    form.className = 'df-new-form';
    form.style.display = 'none';
    form.innerHTML = `
      <input class="df-input-query" placeholder="用自然语言描述要追的数据流（如：logBuffer 怎么从写入到落盘的）" autocomplete="off" />
      <div class="df-autocomplete" style="display:none"></div>
      <div class="df-form-actions">
        <button class="df-btn-start">开始追踪</button>
        <button class="df-btn-cancel">取消</button>
      </div>`;
    left.appendChild(form);

    // 自然语言输入时联想符号名（帮 Agent 解析 resource，用户也可忽略）
    const queryInput = form.querySelector('.df-input-query') as HTMLInputElement;
    const acBox = form.querySelector('.df-autocomplete') as HTMLElement;
    let acTimer: ReturnType<typeof setTimeout> | null = null;
    queryInput.addEventListener('input', () => {
      const q = queryInput.value.trim();
      if (acTimer) clearTimeout(acTimer);
      // 从输入里提取最后一个可能是符号名的词（字母/数字/下划线，≥2字符）
      const m = q.match(/[A-Za-z_][A-Za-z0-9_]{1,}$/);
      if (!m) { acBox.style.display = 'none'; return; }
      acTimer = setTimeout(async () => {
        try {
          const raw = await invoke<string>('hologram_search', { query: m[0], limit: 8 });
          const data = JSON.parse(raw);
          const results = data.results || [];
          if (results.length === 0) { acBox.style.display = 'none'; return; }
          acBox.innerHTML = results.map((r: any) =>
            `<div class="df-ac-item" data-name="${r.name}">${r.name} <span class="df-ac-kind">${r.kind}</span></div>`).join('');
          acBox.style.display = 'block';
          acBox.querySelectorAll('.df-ac-item').forEach((el) => {
            (el as HTMLElement).onclick = () => {
              // 用选中的符号名替换输入末尾的半截词
              const v = queryInput.value;
              queryInput.value = v.slice(0, v.length - m[0].length) + (el as HTMLElement).dataset['name']!;
              acBox.style.display = 'none';
            };
          });
        } catch { acBox.style.display = 'none'; }
      }, 200);
    });
    queryInput.addEventListener('blur', () => { setTimeout(() => { acBox.style.display = 'none'; }, 200); });

    // status log (for new-trace progress)
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'df-status-log';
    this.statusEl.style.display = 'none';
    left.appendChild(this.statusEl);

    // right: detail
    this.detailEl = document.createElement('div');
    this.detailEl.className = 'df-detail';

    body.appendChild(left);
    body.appendChild(this.detailEl);
    this.el.appendChild(body);

    // corner bracket decorations
    const corners = document.createElement('div');
    corners.className = 'df-corners';
    corners.innerHTML = '<span class="df-cb-bottom df-cb-bl"></span><span class="df-cb-bottom df-cb-br"></span>';
    this.el.appendChild(corners);

    // resize grip
    this.grip = document.createElement('div');
    this.grip.className = 'df-grip';
    this.el.appendChild(this.grip);

    container.appendChild(this.el);

    // wire buttons
    (toolbar.querySelector('.df-btn-new') as HTMLElement).onclick = () => {
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    };
    (toolbar.querySelector('.df-btn-refresh') as HTMLElement).onclick = () => this.refresh();
    (form.querySelector('.df-btn-cancel') as HTMLElement).onclick = () => { form.style.display = 'none'; };
    (form.querySelector('.df-btn-start') as HTMLElement).onclick = () => this.onStartTrace(form as HTMLElement);

    // drag + resize
    this.header.addEventListener('pointerdown', (e) => this.onDragStart(e));
    this.grip.addEventListener('pointerdown', (e) => this.onResizeStart(e));
    // 点击面板任意位置置顶
    this.el.addEventListener('pointerdown', () => this.bringToFront());
  }

  // ── New trace ─────────────────────────────────────────

  private async onStartTrace(form: HTMLElement): Promise<void> {
    const query = (form.querySelector('.df-input-query') as HTMLInputElement).value.trim();
    if (!query || !this.onNewTrace) return;
    form.style.display = 'none';
    this.statusEl.style.display = 'block';
    this.statusEl.innerHTML = `<div class="df-status-title">追踪中…</div>`;
    this.abortCtrl = new AbortController();
    try {
      await this.onNewTrace(query, (line) => {
        const row = document.createElement('div');
        row.className = 'df-status-line';
        row.textContent = line;
        this.statusEl.appendChild(row);
        this.statusEl.scrollTop = this.statusEl.scrollHeight;
      }, this.abortCtrl.signal);
      this.refresh();
    } catch (e: any) {
      const row = document.createElement('div');
      row.className = 'df-status-line df-status-err';
      row.textContent = `✕ ${e?.message || e}`;
      this.statusEl.appendChild(row);
    }
  }

  // ── List ──────────────────────────────────────────────

  async refresh(): Promise<void> {
    try {
      const raw = await invoke<string>('dataflow_list', { limit: 100 });
      const data = JSON.parse(raw);
      this.traces = data.traces || [];
      this.renderList();
    } catch (e: any) {
      this.listEl.innerHTML = `<div class="df-empty">加载失败: ${e?.message || e}</div>`;
    }
  }

  private renderList(): void {
    if (this.traces.length === 0) {
      this.listEl.innerHTML = `<div class="df-empty">暂无 trace。点 + 新建追踪一条数据流。</div>`;
      return;
    }
    this.listEl.innerHTML = this.traces.map((t) => {
      const icon = STATUS_ICON[t.status] || '❓';
      const active = t.trace_id === this.currentTraceId ? ' df-item-active' : '';
      return `<div class="df-item${active}" data-tid="${t.trace_id}">
        <span class="df-item-icon">${icon}</span>
        <span class="df-item-res">${t.resource}</span>
        <span class="df-item-status">${t.test_status || t.status}</span>
      </div>`;
    }).join('');
    this.listEl.querySelectorAll('.df-item').forEach((el) => {
      (el as HTMLElement).onclick = () => {
        const tid = (el as HTMLElement).dataset['tid']!;
        this.showDetail(tid);
      };
    });
  }

  // ── Detail ────────────────────────────────────────────

  private async showDetail(traceId: string): Promise<void> {
    this.currentTraceId = traceId;
    this.renderList();
    this.detailEl.innerHTML = `<div class="df-empty">加载 ${traceId}…</div>`;
    try {
      const raw = await invoke<string>('dataflow_query', { traceId });
      console.debug('[dataflow] query raw:', raw);
      const data = JSON.parse(raw);
      const trace = data.trace;
      if (!trace) {
        this.detailEl.innerHTML = `<div class="df-empty">未找到 ${traceId}（trace 字段为 null）</div>`;
        return;
      }
      this.renderDetail(trace);
    } catch (e: any) {
      this.detailEl.innerHTML = `<div class="df-empty">查询失败: ${e?.message || e}</div>`;
      console.error('[dataflow] showDetail failed:', e);
    }
  }

  private renderDetail(t: any): void {
    try {
      const snipObj = t.source_snippets && typeof t.source_snippets === 'object' && !Array.isArray(t.source_snippets)
        ? t.source_snippets : {};
      const snips = Object.entries(snipObj).map(([k, s]: [string, any]) =>
        `<div class="df-snip"><div class="df-snip-name">${k} · ${s?.file || ''}:${s?.line || ''}</div>
         <pre class="df-snip-code">${this.escapeHtml(s?.code || '')}</pre></div>`).join('');

      const nodes: any[] = Array.isArray(t.nodes) ? t.nodes : [];
      const edges: any[] = Array.isArray(t.edges) ? t.edges : [];

      // Confidence stats
      const confCounts: Record<string, number> = {};
      for (const e of edges) {
        const c = e.confidence || 'speculative';
        confCounts[c] = (confCounts[c] || 0) + 1;
      }
      const confBadges = [
        confCounts['verified'] ? `<span class="df-conf-badge df-conf-verified">✓ ${confCounts['verified']} verified</span>` : '',
        confCounts['static_match'] ? `<span class="df-conf-badge df-conf-static">~ ${confCounts['static_match']} match</span>` : '',
        confCounts['speculative'] ? `<span class="df-conf-badge df-conf-spec">? ${confCounts['speculative']} speculative</span>` : '',
      ].filter(Boolean).join(' ');

      // Nodes table
      const nodesHtml = nodes.length > 0 ? this.buildNodesTable(nodes) : '';
      // Edges table
      const edgesHtml = edges.length > 0 ? this.buildEdgesTable(edges) : '';

      this.detailEl.innerHTML = `
        <div class="df-detail-hdr">
          <span class="df-detail-tid">${t.trace_id || ''}</span>
          <span class="df-detail-status">${STATUS_ICON[t.status] || ''} ${t.status || ''}</span>
        </div>
        <div class="df-detail-meta">
          <div><b>资源:</b> ${this.escapeHtml(t.resource || '')}</div>
          <div><b>描述:</b> ${this.escapeHtml(t.description || '')}</div>
          <div>
            <b>语言:</b> ${t.language || '—'}
            · <b>节点:</b> ${nodes.length}
            · <b>边:</b> ${edges.length}
            · <b>测试:</b> ${t.test_status || '—'}
          </div>
          ${confBadges ? `<div class="df-conf-row">${confBadges}</div>` : ''}
        </div>
        ${nodesHtml ? `<div class="df-detail-section"><div class="df-section-hdr">节点 <span class="df-sect-count">${nodes.length}</span></div>${nodesHtml}</div>` : ''}
        ${edgesHtml ? `<div class="df-detail-section"><div class="df-section-hdr">边 <span class="df-sect-count">${edges.length}</span></div>${edgesHtml}</div>` : ''}
        ${snips ? `<div class="df-detail-section"><div class="df-section-hdr">源码片段</div>${snips}</div>` : ''}
        <div class="df-detail-actions">
          <button class="df-btn-verify" data-tid="${t.trace_id}">${iconHtml('check-circle', 13)} 重验证</button>
          <button class="df-btn-stale" data-tid="${t.trace_id}">${iconHtml('eye', 13)} 过期检查</button>
          <button class="df-btn-retrace" data-tid="${t.trace_id}">${iconHtml('refresh', 13)} 重追踪</button>
          <button class="df-btn-edit" data-tid="${t.trace_id}">${iconHtml('edit', 13)} 编辑</button>
          <button class="df-btn-diff" data-tid="${t.trace_id}">${iconHtml('diff', 13)} 版本对比</button>
          <button class="df-btn-del" data-tid="${t.trace_id}">${iconHtml('trash', 13)} 删除</button>
        </div>`;
      const delBtn = this.detailEl.querySelector('.df-btn-del') as HTMLElement | null;
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`确认删除 trace ${t.trace_id}? 此操作不可撤销。`)) return;
        await invoke<string>('dataflow_delete', { traceId: t.trace_id, hard: true });
        this.currentTraceId = null;
        this.refresh();
        this.detailEl.innerHTML = `<div class="df-empty">选择左侧 trace 查看详情</div>`;
      };
      const verifyBtn = this.detailEl.querySelector('.df-btn-verify') as HTMLElement | null;
      if (verifyBtn) verifyBtn.onclick = async () => {
        verifyBtn.textContent = '验证中…';
        try {
          const raw = await invoke<string>('dataflow_verify', { traceId: t.trace_id });
          const res = JSON.parse(raw);
          await this.showDetail(t.trace_id);
          this.refresh();
          this.showBanner(`${iconHtml('check-circle', 13)} 重验证完成 · 状态: ${res.status} · 锚点: ${res.snippets_ok ? iconHtml('check-circle', 11) : iconHtml('close', 11)} · 测试: ${res.test_status || '无'}`, 'ok');
        } catch (e: any) { verifyBtn.textContent = `✕ ${e?.message || e}`; }
      };
      const staleBtn = this.detailEl.querySelector('.df-btn-stale') as HTMLElement | null;
      if (staleBtn) staleBtn.onclick = async () => {
        staleBtn.textContent = '检查中…';
        try {
          const raw = await invoke<string>('dataflow_stale_check', { traceId: t.trace_id });
          const res = JSON.parse(raw);
          const r = res.results?.[0];
          await this.showDetail(t.trace_id);
          this.refresh();
          if (r) {
            this.showBanner(r.stale
              ? `${iconHtml('alert-circle', 13)} 已过期 · 锚点: ${r.snippets_ok ? iconHtml('check-circle', 11) : iconHtml('close', 11)} · 文件存在: ${r.files_exist ? iconHtml('check-circle', 11) : iconHtml('close', 11)}`
              : `${iconHtml('check-circle', 13)} 未过期 · 锚点: ${r.snippets_ok ? iconHtml('check-circle', 11) : iconHtml('close', 11)} · 文件存在: ${r.files_exist ? iconHtml('check-circle', 11) : iconHtml('close', 11)}`,
              r.stale ? 'warn' : 'ok');
          }
        } catch (e: any) { staleBtn.textContent = `✕ ${e?.message || e}`; }
      };
      // 重追踪：复用 resource + description，spawn 新 Agent，version 自动递增
      const retraceBtn = this.detailEl.querySelector('.df-btn-retrace') as HTMLElement | null;
      if (retraceBtn) retraceBtn.onclick = async () => {
        if (!this.onNewTrace) return;
        retraceBtn.textContent = '追踪中…';
        this.statusEl.style.display = 'block';
        this.statusEl.innerHTML = `<div class="df-status-title">重追踪 ${t.resource}…</div>`;
        const ctrl = new AbortController();
        try {
          await this.onNewTrace(`重新追踪 ${t.resource}：${t.description || '数据流追踪'}`, (line) => {
            const row = document.createElement('div');
            row.className = 'df-status-line';
            row.textContent = line;
            this.statusEl.appendChild(row);
            this.statusEl.scrollTop = this.statusEl.scrollHeight;
          }, ctrl.signal);
          await this.refresh();
          this.showBanner('✓ 重追踪完成', 'ok');
        } catch (e: any) {
          this.showBanner(`✗ 重追踪失败: ${e?.message || e}`, 'err');
        }
        retraceBtn.innerHTML = `${iconHtml('refresh', 13)} 重追踪`;
      };
      // 编辑：textarea 编辑 + 高亮预览双栏，保存调 dataflow_save
      const editBtn = this.detailEl.querySelector('.df-btn-edit') as HTMLElement | null;
      if (editBtn) editBtn.onclick = () => {
        const ta = document.createElement('textarea');
        ta.className = 'df-edit-area';
        ta.value = JSON.stringify(t, null, 2);
        const preview = document.createElement('pre');
        preview.className = 'df-edit-preview';
        preview.innerHTML = this.highlightJson(ta.value);
        const save = document.createElement('button');
        save.className = 'df-btn-save-edit'; save.textContent = '保存';
        const cancel = document.createElement('button');
        cancel.className = 'df-btn-cancel-edit'; cancel.textContent = '取消';
        const editorRow = document.createElement('div');
        editorRow.className = 'df-edit-row';
        editorRow.appendChild(ta);
        editorRow.appendChild(preview);
        const wrap = document.createElement('div');
        wrap.className = 'df-edit-wrap';
        wrap.appendChild(editorRow); wrap.appendChild(save); wrap.appendChild(cancel);
        this.detailEl.innerHTML = '';
        this.detailEl.appendChild(wrap);
        ta.addEventListener('input', () => { preview.innerHTML = this.highlightJson(ta.value); });
        ta.addEventListener('scroll', () => { preview.scrollTop = ta.scrollTop; preview.scrollLeft = ta.scrollLeft; });
        cancel.onclick = () => this.showDetail(t.trace_id);
        save.onclick = async () => {
          try {
            const parsed = JSON.parse(ta.value);
            await invoke<string>('dataflow_save', { traceJson: JSON.stringify(parsed) });
            this.showDetail(t.trace_id);
            this.refresh();
            this.showBanner(`${iconHtml('check-circle', 13)} 已保存`, 'ok');
          } catch (e: any) {
            this.showBanner(`${iconHtml('close', 13)} 保存失败: ${e?.message || e}`, 'err');
          }
        };
      };
      // 版本对比：取最新两个版本，逐字段 diff nodes/edges/元数据
      const diffBtn = this.detailEl.querySelector('.df-btn-diff') as HTMLElement | null;
      if (diffBtn) diffBtn.onclick = async () => {
        try {
          const listRaw = await invoke<string>('dataflow_list', { limit: 100 });
          const versions = (JSON.parse(listRaw).traces || [])
            .filter((x: any) => x.resource === t.resource)
            .sort((a: any, b: any) => a.trace_id.localeCompare(b.trace_id));
          if (versions.length < 2) {
            this.showBanner('只有 1 个版本，无需对比', 'warn');
            return;
          }
          const v1 = JSON.parse(await invoke<string>('dataflow_query', { traceId: versions[versions.length - 2].trace_id })).trace;
          const v2 = JSON.parse(await invoke<string>('dataflow_query', { traceId: versions[versions.length - 1].trace_id })).trace;
          const diffHtml = this.diffTraces(v1, v2, versions[versions.length - 2].trace_id, versions[versions.length - 1].trace_id);
          this.detailEl.innerHTML = `<div class="df-diff"><div class="df-section-hdr">${t.resource} 版本对比</div>${diffHtml}
            <button class="df-btn-back">← 返回</button></div>`;
          (this.detailEl.querySelector('.df-btn-back') as HTMLElement).onclick = () => this.showDetail(t.trace_id);
        } catch (e: any) { this.showBanner(`✗ 对比失败: ${e?.message || e}`, 'err'); }
      };
    } catch (e: any) {
      this.detailEl.innerHTML = `<div class="df-empty">渲染失败: ${e?.message || e}</div>`;
      console.error('[dataflow] renderDetail failed:', e, t);
    }
  }

  /** 节点 kind → SVG icon 名 */
  private nodeKindIcon(kind: string): string {
    const map: Record<string, string> = {
      function: 'code', method: 'code', class: 'code',
      variable: 'dot', constant: 'dot', parameter: 'dot',
      file: 'file', module: 'file',
      event: 'zap', trigger: 'zap', timer: 'clock',
      queue: 'layers', cache: 'layers', database: 'layers',
    };
    return iconHtml(map[kind] || 'dot', 12);
  }

  /** Compact trace nodes table */
  private buildNodesTable(nodes: any[]): string {
    const rows = nodes.slice(0, 50).map((n: any) => {
      const loc = n.file ? `${this.escapeHtml(n.file)}${n.line ? ':' + n.line : ''}` : '—';
      return `<div class="df-nodes-tr">
        <span class="df-nodes-kind">${this.nodeKindIcon(n.kind)} ${this.escapeHtml(n.kind || '')}</span>
        <span class="df-nodes-id">${this.escapeHtml(n.id || '')}</span>
        ${n.role ? `<span class="df-nodes-role">${this.escapeHtml(n.role)}</span>` : '<span></span>'}
        <span class="df-nodes-loc">${loc}</span>
      </div>`;
    }).join('');
    const more = nodes.length > 50
      ? `<div class="df-table-more">… 及其他 ${nodes.length - 50} 个节点</div>` : '';
    return `<div class="df-nodes-table">
      <div class="df-nodes-th"><span>Kind</span><span>ID</span><span>Role</span><span>位置</span></div>
      ${rows}${more}</div>`;
  }

  /** Compact trace edges table with confidence badges */
  private buildEdgesTable(edges: any[]): string {
    const CONF_CLASS: Record<string, string> = {
      verified: 'df-conf-verified', static_match: 'df-conf-static', speculative: 'df-conf-spec',
    };
    const rows = edges.slice(0, 100).map((e: any) => {
      const conf = e.confidence || 'speculative';
      const confCls = CONF_CLASS[conf] || 'df-conf-spec';
      return `<div class="df-edges-tr">
        <span class="df-edges-from">${this.escapeHtml(e.from || '')}</span>
        <span class="df-edges-arrow">→</span>
        <span class="df-edges-to">${this.escapeHtml(e.to || '')}</span>
        <span class="df-edges-kind">${this.escapeHtml(e.kind || '')}</span>
        <span class="df-edges-conf"><span class="${confCls}">${conf}</span></span>
      </div>`;
    }).join('');
    const more = edges.length > 100
      ? `<div class="df-table-more">… 及其他 ${edges.length - 100} 条边</div>` : '';
    return `<div class="df-edges-table">
      <div class="df-edges-th"><span>From</span><span></span><span>To</span><span>Kind</span><span>置信度</span></div>
      ${rows}${more}</div>`;
  }

  /** 逐字段 diff 两个 trace 版本：nodes（id 差集）、edges（from→to:kind 差集）、元数据变化。 */
  private diffTraces(v1: any, v2: any, id1: string, id2: string): string {
    const n1: Set<string> = new Set((v1?.nodes || []).map((n: any) => n.id));
    const n2: Set<string> = new Set((v2?.nodes || []).map((n: any) => n.id));
    const addedNodes: string[] = [...n2].filter(x => !n1.has(x));
    const removedNodes: string[] = [...n1].filter(x => !n2.has(x));
    const e1: Set<string> = new Set((v1?.edges || []).map((e: any) => `${e.from}→${e.to}:${e.kind}`));
    const e2: Set<string> = new Set((v2?.edges || []).map((e: any) => `${e.from}→${e.to}:${e.kind}`));
    const addedEdges: string[] = [...e2].filter(x => !e1.has(x));
    const removedEdges: string[] = [...e1].filter(x => !e2.has(x));
    const metaChanges: string[] = [];
    for (const k of ['status', 'test_status', 'language', 'description']) {
      const a = v1?.[k] || '', b = v2?.[k] || '';
      if (a !== b) metaChanges.push(`${k}: "${a}" → "${b}"`);
    }
    const row = (label: string, items: string[], cls: string) =>
      items.length ? `<div class="df-diff-row df-diff-${cls}"><span class="df-diff-label">${label}</span> ${items.map(this.escapeHtml).join(', ')}</div>` : '';
    return `<div class="df-diff-versions">${id1} → ${id2}</div>
      <div class="df-diff-section"><div class="df-diff-hdr">元数据</div>${metaChanges.length ? metaChanges.map(m => `<div class="df-diff-row">${this.escapeHtml(m)}</div>`).join('') : '<div class="df-empty">无变化</div>'}</div>
      <div class="df-diff-section"><div class="df-diff-hdr">节点 (+${addedNodes.length} -${removedNodes.length})</div>
        ${row('新增', addedNodes, 'add')}${row('移除', removedNodes, 'del')}${(!addedNodes.length && !removedNodes.length) ? '<div class="df-empty">无变化</div>' : ''}</div>
      <div class="df-diff-section"><div class="df-diff-hdr">边 (+${addedEdges.length} -${removedEdges.length})</div>
        ${row('新增', addedEdges, 'add')}${row('移除', removedEdges, 'del')}${(!addedEdges.length && !removedEdges.length) ? '<div class="df-empty">无变化</div>' : ''}</div>`;
  }

  private showBanner(text: string, kind: 'ok' | 'warn' | 'err'): void {
    const old = this.detailEl.querySelector('.df-banner');
    if (old) old.remove();
    const banner = document.createElement('div');
    banner.className = `df-banner df-banner-${kind}`;
    banner.innerHTML = text;
    this.detailEl.insertBefore(banner, this.detailEl.firstChild);
    setTimeout(() => { banner.style.opacity = '0'; setTimeout(() => banner.remove(), 500); }, 4000);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 轻量 JSON 语法高亮：key/string/number/boolean/null 着色。不依赖外部库。 */
  private highlightJson(s: string): string {
    const esc = this.escapeHtml(s);
    return esc.replace(
      /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+\.?\d*)/g,
      (m, _g1, isKey) => {
        if (m.startsWith('"')) {
          if (isKey) return `<span class="df-jk">${m}</span>`;
          return `<span class="df-js">${m}</span>`;
        }
        if (m === 'true' || m === 'false' || m === 'null') return `<span class="df-jb">${m}</span>`;
        return `<span class="df-jn">${m}</span>`;
      });
  }

  // ── Open / close ──────────────────────────────────────

  toggle(): void { this.openState ? this.close() : this.open(); }

  open(): void {
    if (this.openState) return;
    this.openState = true;
    this.el.style.display = 'flex';
    this.bringToFront();
    this.refresh();
    shell.notifyPanelChanged();
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.el.style.display = 'none';
    if (this.abortCtrl) this.abortCtrl.abort();
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
    this.dragStart.w = parseInt(this.el.style.width) || 720;
    this.dragStart.h = parseInt(this.el.style.height) || 480;
    this.dragStart.x = e.clientX; this.dragStart.y = e.clientY;
    this.grip.setPointerCapture(e.pointerId);
    this.grip.addEventListener('pointermove', this.onResizeMove);
    this.grip.addEventListener('pointerup', this.onResizeEnd);
  }

  private onResizeMove = (e: PointerEvent): void => {
    if (!this.resizing) return;
    const dw = e.clientX - this.dragStart.x;
    const dh = e.clientY - this.dragStart.y;
    this.el.style.width = `${Math.max(420, this.dragStart.w + dw)}px`;
    this.el.style.height = `${Math.max(280, this.dragStart.h + dh)}px`;
  };

  private onResizeEnd = (e: PointerEvent): void => {
    this.resizing = false;
    this.grip.releasePointerCapture(e.pointerId);
    this.grip.removeEventListener('pointermove', this.onResizeMove);
    this.grip.removeEventListener('pointerup', this.onResizeEnd);
  };

  destroy(): void { this.el.remove(); }
}
