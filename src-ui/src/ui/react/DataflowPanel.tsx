// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DataflowPanel — React rewrite of dataflow-panel.ts.
// Floating trace browser: left panel = trace list + quick explore, right = trace content.
// Supports drag (header) and resize (grip).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../bridge';
import { getDataflowQueryParser } from '../dock-config';
import { useDockStore } from '../dock-store';
import { bus } from '../events';
import { escapeHtml } from './helpers';
import { iconHtml } from '../icons';

interface TraceSummary {
  traceId: string;
  query: string;
  createdAt: string;
  hasContent: boolean;
}

// ── Helpers ──

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso.slice(0, 16);
  }
}

function inlineMd(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/`(.+?)`/g, '<code class="df-md-inline-code">$1</code>')
    .replace(/→/g, '<span class="df-md-arrow">→</span>');
}

// ── Markdown renderer (minimal, kept as html string builder) ──

function renderMd(text: string): string {
  if (!text) return '';
  const blocks = text.split(/\n\n+/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      const lines = trimmed.split('\n');
      const first = lines[0].trim();

      if (first.startsWith('```')) {
        const codeLines = lines.slice(1);
        const lastIdx = codeLines.findIndex((l) => l.trim() === '```');
        const code = lastIdx >= 0 ? codeLines.slice(0, lastIdx) : codeLines;
        return `<pre class="df-md-code">${escapeHtml(code.join('\n'))}</pre>`;
      }
      if (first.startsWith('## ')) return `<h3 class="df-md-h3">${inlineMd(first.slice(3))}</h3>`;
      if (first.startsWith('### ')) return `<h4 class="df-md-h4">${inlineMd(first.slice(4))}</h4>`;
      if (first === '---' || first === '***' || first === '___') return '<hr class="df-md-hr">';
      if (first.match(/^[-*]\s/)) {
        const items = lines.filter((l) => l.trim()).map((l) => `<li>${inlineMd(l.replace(/^[-*]\s*/, ''))}</li>`).join('');
        return `<ul class="df-md-ul">${items}</ul>`;
      }
      if (first.match(/^\d+\.\s/)) {
        const items = lines.filter((l) => l.trim()).map((l) => `<li>${inlineMd(l.replace(/^\d+\.\s*/, ''))}</li>`).join('');
        return `<ol class="df-md-ol">${items}</ol>`;
      }
      if (first.startsWith('|') && first.endsWith('|')) {
        if (lines.length < 2) return '';
        const hCells = lines[0].split('|').filter((c) => c.trim());
        const thead = `<thead><tr>${hCells.map((c) => `<th>${inlineMd(c.trim())}</th>`).join('')}</tr></thead>`;
        const bodyRows = lines.slice(1).filter((l) => !l.match(/^\|[\s\-:|]+\|$/));
        const tbody = bodyRows.length > 0
          ? `<tbody>${bodyRows.map((row) => {
              const cells = row.split('|').filter((c) => c.trim());
              return `<tr>${cells.map((c) => `<td>${inlineMd(c.trim())}</td>`).join('')}</tr>`;
            }).join('')}</tbody>`
          : '';
        return `<table class="df-md-table">${thead}${tbody}</table>`;
      }
      if (first.startsWith('> ')) {
        const text = lines.map((l) => l.replace(/^>\s?/, '')).join('\n');
        return `<blockquote class="df-md-bq">${inlineMd(text)}</blockquote>`;
      }
      return `<p class="df-md-p">${inlineMd(trimmed.replace(/\n/g, ' '))}</p>`;
    })
    .join('');
}

// ── Engine data renderers (kept as html string builders, same logic) ──

function renderEngineExplore(explore: any): string {
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

  if (flow?.path) {
    const steps = flow.path || [];
    const rows = steps.map((s: any) => {
      if (s.edge) return `<div class="df-flow-edge"><span class="df-flow-arrow">↓</span><span class="df-flow-ekind">${escapeHtml(s.edge)}</span></div>`;
      return `<div class="df-flow-node"><span class="df-flow-kind">${escapeHtml(s.kind || '')}</span><span class="df-flow-name">${escapeHtml(s.name || '')}</span><span class="df-flow-loc">${escapeHtml(s.file ? `${s.file}${s.line ? ':' + s.line : ''}` : '—')}</span></div>`;
    }).join('');
    parts.push(`<div class="df-section"><div class="df-section-hdr">数据流路径 (${Math.floor(steps.length / 2) + 1} 节点, ${Math.floor(steps.length / 2)} 跳)</div><div class="df-flow">${rows}</div></div>`);
  }

  const relKeys = Object.keys(relationships);
  if (relKeys.length) {
    const rows = relKeys.map((kind) => {
      const edges = relationships[kind] || [];
      const items = edges.slice(0, 30).map((e: any) => `<div class="df-rel-item"><span class="df-rel-src">${escapeHtml(e.source)}</span> → <span class="df-rel-tgt">${escapeHtml(e.target)}</span></div>`).join('');
      const more = edges.length > 30 ? `<div class="df-table-more">…及其他 ${edges.length - 30} 条</div>` : '';
      return `<div class="df-rel-group"><div class="df-rel-kind">${escapeHtml(kind)} (${edges.length})</div>${items}${more}</div>`;
    }).join('');
    parts.push(`<div class="df-section"><div class="df-section-hdr">关系</div>${rows}</div>`);
  }

  if (sourceCode.length) {
    const snippets = sourceCode.slice(0, 8).map((s: any) => `<div class="df-src-item"><div class="df-src-loc">${escapeHtml(s.file || '')}${s.line ? ':' + s.line : ''}</div><pre class="df-src-code">${escapeHtml(s.code || '')}</pre></div>`).join('');
    const more = sourceCode.length > 8 ? `<div class="df-table-more">…及其他 ${sourceCode.length - 8} 个片段</div>` : '';
    parts.push(`<div class="df-section"><div class="df-section-hdr">源码 (${sourceCode.length})</div>${snippets}${more}</div>`);
  }

  const deps = blastRadius.dependents || [];
  const tests = blastRadius.tests || [];
  if (deps.length || tests.length) {
    const depItems = deps.slice(0, 20).map((d: any) => `<div class="df-br-item">${escapeHtml(d.name)} <span class="df-br-loc">${escapeHtml(d.file || '')}${d.line ? ':' + d.line : ''}</span></div>`).join('');
    const testItems = tests.slice(0, 10).map((t: any) => `<div class="df-br-item df-br-test">🧪 ${escapeHtml(t.name)} <span class="df-br-loc">${escapeHtml(t.file || '')}${t.line ? ':' + t.line : ''}</span></div>`).join('');
    parts.push(`<div class="df-section"><div class="df-section-hdr">影响范围</div>
      ${deps.length ? `<div class="df-br-sub">依赖者 (${deps.length})</div>${depItems}${deps.length > 20 ? `<div class="df-table-more">…及其他 ${deps.length - 20} 个</div>` : ''}` : ''}
      ${tests.length ? `<div class="df-br-sub">相关测试 (${tests.length})</div>${testItems}${tests.length > 10 ? `<div class="df-table-more">…及其他 ${tests.length - 10} 个</div>` : ''}` : ''}</div>`);
  }

  const alertKeys = Object.keys(alerts).filter((k) => alerts[k] && (Array.isArray(alerts[k]) ? alerts[k].length > 0 : true));
  if (alertKeys.length) {
    const rows = alertKeys.map((k) => {
      const v = alerts[k];
      const display = Array.isArray(v) ? `${v.length} 项` : String(v);
      return `<div class="df-alert-row"><span class="df-alert-key">${escapeHtml(k)}</span>: ${escapeHtml(display)}</div>`;
    }).join('');
    parts.push(`<div class="df-section"><div class="df-section-hdr">架构提醒</div>${rows}</div>`);
  }

  return parts.join('');
}

function renderEngineDataflow(dfResult: any): string {
  const results: any[] = dfResult.results || [];
  if (results.length === 0) return '';
  let html = `<div class="df-section"><div class="df-section-hdr">数据流引擎 (tree-sitter)</div>`;
  for (const r of results) {
    if (r.error) {
      html += `<div class="df-df-file"><span class="df-df-fname">${escapeHtml(r.file)}</span> <span class="df-meta-hint">${escapeHtml(r.error)}</span></div>`;
      continue;
    }
    const scopes: any[] = r.scopes || [];
    const shared: any[] = r.shared || [];
    if (scopes.length === 0 && shared.length === 0) continue;
    html += `<div class="df-df-file"><div class="df-df-fname">${escapeHtml(r.file)}</div>`;
    if (scopes.length > 0) {
      html += `<table class="df-df-table"><thead><tr><th>函数</th><th>读取</th><th>写入</th><th>触发</th><th>异步/回调</th><th>调用序列</th></tr></thead><tbody>`;
      for (const s of scopes) {
        html += `<tr><td class="df-df-scope">${escapeHtml(s.name)}</td>
          <td>${(s.reads || []).map(escapeHtml).join(', ') || '—'}</td>
          <td>${(s.writes || []).map(escapeHtml).join(', ') || '—'}</td>
          <td>${(s.triggers || []).map(escapeHtml).join(', ') || '—'}</td>
          <td>${(s.awaits_callbacks || []).map(escapeHtml).join(', ') || '—'}</td>
          <td>${(s.sequence_calls || []).map(escapeHtml).join(', ') || '—'}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    if (shared.length > 0) {
      html += `<div class="df-df-shared-hdr">共享变量</div>`;
      for (const sh of shared) {
        html += `<div class="df-df-shared"><span class="df-df-var">${escapeHtml(sh.var)}</span>
          <span class="df-df-rw">读: ${(sh.readers || []).map(escapeHtml).join(', ') || '—'}</span>
          <span class="df-df-rw">写: ${(sh.writers || []).map(escapeHtml).join(', ') || '—'}</span></div>`;
      }
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

// ── Component（P3：DockPanel 条件挂载 — 关闭即卸载重置，对齐旧 Controller 语义）──

export function DataflowPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  const onClose = useCallback(() => closePanel('dataflow'), [closePanel]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [tracesLoaded, setTracesLoaded] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [rightHtml, setRightHtml] = useState('');
  const [exploreQuery, setExploreQuery] = useState('');
  const [zIndex, setZIndex] = useState(78);

  // Position / size
  const [pos, setPos] = useState({ x: 120, y: 90 });
  const [size, setSize] = useState({ w: 900, h: 560 });

  const elRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const resizingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, elX: 0, elY: 0, w: 0, h: 0 });

  // ── Trace loading ──

  const loadTraceList = useCallback(async () => {
    try {
      const raw = await rpc<string>('dataflow_query', { list: true });
      const data = JSON.parse(raw);
      setTraces(data.traces || []);
      setTracesLoaded(true);
    } catch {
      setTraces([]);
    }
  }, []);

  // Load on mount + event bus
  useEffect(() => {
    loadTraceList();

    const onSaved = () => {
      setTracesLoaded(false);
      loadTraceList();
    };
    const onSwitched = () => {
      setTracesLoaded(false);
      setSelectedTraceId(null);
      setRightHtml('');
      loadTraceList();
    };

    bus.on('dataflow:saved', onSaved);
    bus.on('workspace:switched', onSwitched);
    return () => {
      bus.off('dataflow:saved', onSaved);
      bus.off('workspace:switched', onSwitched);
    };
  }, [loadTraceList]);

  // ── Select trace ──

  const selectTrace = useCallback(async (tid: string) => {
    setSelectedTraceId(tid);
    setRightHtml('<div class="df-loading">加载中…</div>');
    try {
      const raw = await rpc<string>('dataflow_query', { traceId: tid });
      const trace = JSON.parse(raw);
      const content = trace.content;
      const exploreResult = trace.exploreResult
        ? typeof trace.exploreResult === 'string' ? JSON.parse(trace.exploreResult) : trace.exploreResult
        : null;
      const dataflowResult = trace.dataflowResult
        ? typeof trace.dataflowResult === 'string' ? JSON.parse(trace.dataflowResult) : trace.dataflowResult
        : null;

      const parts: string[] = [];
      const timeStr = fmtTime(trace.createdAt);
      parts.push(`<div class="df-trace-meta-bar">
        <span class="df-trace-meta-q">${escapeHtml(trace.query || '')}</span>
        <span class="df-trace-meta-t">${timeStr}</span>
        <span class="df-trace-meta-id">${escapeHtml(trace.traceId || '')}</span>
      </div>`);
      if (content) parts.push(`<div class="df-trace-body">${renderMd(content)}</div>`);
      if (exploreResult || dataflowResult) {
        parts.push(`<details class="df-engine-data"><summary class="df-engine-summary">引擎原始数据</summary><div class="df-engine-body">`);
        if (exploreResult) parts.push(renderEngineExplore(exploreResult));
        if (dataflowResult) parts.push(renderEngineDataflow(dataflowResult));
        parts.push(`</div></details>`);
      }
      if (!content && !exploreResult && !dataflowResult) parts.push('<div class="df-empty">此追踪内容为空。</div>');
      setRightHtml(parts.join(''));
    } catch (e: any) {
      setRightHtml(`<div class="df-empty">加载失败: ${e?.message || e}</div>`);
    }
  }, []);

  // ── Delete trace ──

  const deleteTrace = useCallback(async (e: React.MouseEvent, tid: string) => {
    e.stopPropagation();
    try {
      await rpc<string>('dataflow_delete', { traceId: tid });
      setTraces((prev) => prev.filter((t) => t.traceId !== tid));
      if (selectedTraceId === tid) {
        setSelectedTraceId(null);
        setRightHtml('');
      }
    } catch (err) {
      console.error('[dataflow] delete failed:', err);
    }
  }, [selectedTraceId]);

  // ── Quick explore ──

  const doExplore = useCallback(async (query: string) => {
    if (!query) return;
    setSelectedTraceId(null);
    setRightHtml('<div class="df-loading">探索中…</div>');

    try {
      let raw = await rpc<string>('hologram_call', { tool: 'explore_deps', args: { query, symbols: [], includeSource: true } });
      let explore = JSON.parse(raw);

      const onParseQuery = getDataflowQueryParser();
      if ((explore.meta?.totalSymbolsFound || 0) === 0 && onParseQuery) {
        try {
          const symbols = await onParseQuery(query);
          if (symbols.length > 0) {
            raw = await rpc<string>('hologram_call', { tool: 'explore_deps', args: { query, symbols, includeSource: true } });
            explore = JSON.parse(raw);
          }
        } catch { /* Agent unavailable */ }
      }

      const fileSet = new Set<string>();
      (explore.flow?.path || []).forEach((s: any) => { if (s.file) fileSet.add(s.file); });
      (explore.sourceCode || []).forEach((s: any) => { if (s.file) fileSet.add(s.file); });
      (explore.blastRadius?.dependents || []).forEach((d: any) => { if (d.file) fileSet.add(d.file); });

      let dfPart = '';
      const files = Array.from(fileSet);
      if (files.length > 0) {
        try {
          const dfRaw = await rpc<string>('hologram_call', { tool: 'trace_dataflow', args: { files } });
          dfPart = renderEngineDataflow(JSON.parse(dfRaw));
        } catch { /* optional */ }
      }

      setRightHtml(renderEngineExplore(explore) + dfPart);
    } catch (e: any) {
      setRightHtml(`<div class="df-empty">探索失败: ${e?.message || e}</div>`);
    }
  }, []);

  // ── Drag ──

  const onDragStart = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY, elX: pos.x, elY: pos.y, w: 0, h: 0 };
    headerRef.current?.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      setPos({
        x: Math.max(0, dragStartRef.current.elX + ev.clientX - dragStartRef.current.x),
        y: Math.max(0, dragStartRef.current.elY + ev.clientY - dragStartRef.current.y),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      draggingRef.current = false;
      headerRef.current?.releasePointerCapture(ev.pointerId);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
  }, [pos]);

  // ── Resize ──

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    resizingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY, elX: 0, elY: 0, w: size.w, h: size.h };
    gripRef.current?.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      setSize({
        w: Math.max(480, dragStartRef.current.w + ev.clientX - dragStartRef.current.x),
        h: Math.max(300, dragStartRef.current.h + ev.clientY - dragStartRef.current.y),
      });
    };
    const onEnd = (ev: PointerEvent) => {
      resizingRef.current = false;
      gripRef.current?.releasePointerCapture(ev.pointerId);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
  }, [size]);

  return (
    <div
      ref={elRef}
      id="dataflow-panel"
      style={{
        position: 'fixed',
        zIndex,
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        display: 'flex',
        flexDirection: 'column',
      }}
      onPointerDown={() => setZIndex((z) => z + 1)}
    >
      {/* Header */}
      <div
        ref={headerRef}
        className="df-panel-header"
        style={{ cursor: 'move', userSelect: 'none' }}
        onPointerDown={onDragStart}
      >
        <span className="df-panel-title">数据流</span>
        <button className="df-panel-close" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} dangerouslySetInnerHTML={{ __html: iconHtml('close', 15) }} />
      </div>

      {/* Body */}
      <div className="df-panel-body" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Left: trace list */}
        <div
          className="df-left"
          style={{
            width: 260,
            minWidth: 180,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid rgba(40,70,130,0.15)',
          }}
        >
          <div className="df-trace-list-hdr">
            <span>已存追踪 ({traces.length})</span>
            <button className="df-hist-clear" onClick={loadTraceList} dangerouslySetInnerHTML={{ __html: `${iconHtml('search', 11)} 刷新` }} />
          </div>
          <div className="df-hist-list" style={{ flex: 1, overflow: 'auto' }}>
            {traces.length === 0 ? (
              <div className="df-empty" style={{ padding: '16px 12px', lineHeight: 1.6 }}>
                暂无已存追踪。<br /><br />
                在对话中让 Agent 追踪数据流，<br />
                结果会出现在这里。
              </div>
            ) : (
              traces.map((t) => (
                <div
                  key={t.traceId}
                  className={`df-hist-item${t.traceId === selectedTraceId ? ' df-hist-item-sel' : ''}`}
                  onClick={() => selectTrace(t.traceId)}
                >
                  <div className="df-hist-query">
                    {t.query.length > 50 ? t.query.slice(0, 50) + '\u2026' : t.query}
                    {' '}
                    <span className={t.hasContent ? 'df-trace-agent-badge' : 'df-trace-engine-badge'}>
                      {t.hasContent ? 'Agent' : '引擎'}
                    </span>
                  </div>
                  <div className="df-hist-sub">{fmtTime(t.createdAt)}</div>
                  <button
                    className="df-hist-del"
                    title="删除此追踪"
                    dangerouslySetInnerHTML={{ __html: iconHtml('close', 10) }}
                    onClick={(e) => deleteTrace(e, t.traceId)}
                  />
                </div>
              ))
            )}
          </div>

          {/* Quick explore */}
          <div className="df-query-area">
            <div className="df-hist-sub" style={{ marginBottom: 4 }}>引擎直查（不保存）</div>
            <textarea
              className="df-query-input"
              placeholder="符号名或查询…"
              rows={2}
              value={exploreQuery}
              onChange={(e) => setExploreQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  doExplore(exploreQuery.trim());
                }
              }}
            />
            <button className="df-query-btn" onClick={() => doExplore(exploreQuery.trim())} dangerouslySetInnerHTML={{ __html: `${iconHtml('search', 13)} 探索` }} />
          </div>
        </div>

        {/* Right: trace content */}
        <div
          className="df-right"
          style={{ flex: 1, overflow: 'auto', padding: 14 }}
          dangerouslySetInnerHTML={{
            __html:
              rightHtml ||
              `<div class="df-empty df-empty-welcome">
                <div class="df-empty-icon">◈</div>
                <div>选择左侧已存追踪查看数据流。</div>
                <div class="df-empty-sub">或使用底部快速探索查询引擎。</div>
              </div>`,
          }}
        />
      </div>

      {/* Resize grip */}
      <div ref={gripRef} className="df-grip" onPointerDown={onResizeStart} />
    </div>
  );
}
