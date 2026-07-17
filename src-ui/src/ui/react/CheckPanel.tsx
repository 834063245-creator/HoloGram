// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// CheckPanel — React rewrite of check.ts.
// Change summary panel with violations, statistics, gate check.
// Right sidebar, auto-opens on failure.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../../bridge';
import { cacheCheckResult } from '../../agent/state-inject';
import { askAgent } from '../agent-visualizer';
import { shell } from '../app-shell';
import { basename, escapeHtml } from './helpers';
import { iconHtml } from '../icons';

interface Violation {
  signal?: {
    description?: string;
    file_path?: string;
    line?: number;
    level?: number;
    affected_nodes?: string[];
    graph_node_ids?: string[];
    old_value?: string;
    new_value?: string;
    violation_id?: string;
  };
  message?: string;
  level?: number;
}

export interface CheckResult {
  passed: boolean;
  timestamp: string;
  commit_hash?: string;
  changed_files: string[];
  total_changed_files: number;
  l5_violations: Violation[];
  l4_violations: Violation[];
  l3_violations: Violation[];
  l2_violations: Violation[];
  passed_checks: string[];
  blast_radius: number;
  cross_community_edges: number;
  new_cycles: number;
  new_thread_conflicts: number;
  api_signature_changes: number;
  new_violations?: number;
  resolved_violations?: number;
  persistent_violations?: number;
}

interface HistoryEvent {
  timestamp: string;
  summary: string;
  props: any;
}

interface GateModule {
  file: string;
  name: string;
  node_count: number;
  fan_in: number;
  fan_out: number;
  coupling_l1: number;
  coupling_l2: number;
  coupling_l3: number;
  coupling_l4: number;
  risk: 'high' | 'medium' | 'low';
  recommendations: string[];
}

interface GateData {
  modules: GateModule[];
  total_evaluated: number;
  high_risk: number;
  medium_risk: number;
  low_risk: number;
  error?: string;
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso.slice(11, 19) || iso.slice(0, 19);
  }
}

// ── Collapsible section ──

const Collapsible: React.FC<{
  title: string;
  count: string;
  startOpen: boolean;
  children: React.ReactNode;
  className?: string;
}> = ({ title, count, startOpen, children, className }) => {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className={`check-fold-section${className ? ` ${className}` : ''}`}>
      <div className="check-fold-head" onClick={() => setOpen((o) => !o)}>
        <span className="check-fold-arrow">{open ? '▾' : '▸'}</span>
        <span className="check-fold-label">{title}</span>
        {count && <span className="check-fold-badge">{count}</span>}
      </div>
      <div className={`check-fold-body${open ? '' : ' collapsed'}`}>{children}</div>
    </div>
  );
};

// ── Violation item ──

const ViolationItem: React.FC<{ v: Violation; label: string }> = ({ v, label }) => {
  const sig = v.signal || {};
  const desc = sig.description || v.message || '?';
  const fp = sig.file_path || '';
  const line = sig.line || 0;
  const loc = fp ? `${basename(fp)}${line ? ':' + line : ''}` : '';
  const nodeList = (sig.affected_nodes || []).slice(0, 3).join(', ');

  const handleAsk = (e: React.MouseEvent) => {
    e.stopPropagation();
    const ctx = [
      `[${label}] ${desc}`,
      fp ? `文件: ${fp}${line ? ':' + line : ''}` : '',
      nodeList ? `影响: ${nodeList}` : '',
      sig.old_value ? `变更: ${sig.old_value} → ${sig.new_value}` : '',
    ].filter(Boolean).join(' | ');
    askAgent(`分析这条违规: ${ctx}`);
  };

  return (
    <div className="check-vitem">
      <div className="check-vitem-title">
        {loc && <span className="check-vloc">{loc}</span>}
        <span className="check-vdesc" title={desc}>
          {desc.length > 100 ? desc.slice(0, 100) + '\u2026' : desc}
        </span>
        <button
          className="check-ask-btn"
          title="问 Agent"
          dangerouslySetInnerHTML={{ __html: iconHtml('agent', 12) }}
          onClick={handleAsk}
        />
      </div>
      {sig.affected_nodes && sig.affected_nodes.length > 0 && (
        <div className="check-vaffect">
          {sig.affected_nodes.slice(0, 8).map((name, i) => (
            <React.Fragment key={i}>
              <span
                className="check-node-link"
                title={(sig.graph_node_ids || [])[i] ? `节点: ${(sig.graph_node_ids || [])[i]}` : '跳转到星图'}
                onClick={(e) => {
                  e.stopPropagation();
                  shell.navigateToNode(name);
                }}
              >
                {name}
              </span>
              {i < Math.min(sig.affected_nodes!.length, 8) - 1 && ' · '}
            </React.Fragment>
          ))}
          {sig.affected_nodes.length > 8 && ` … +${sig.affected_nodes.length - 8}`}
        </div>
      )}
      {sig.old_value && sig.new_value && (
        <div className="check-vchange">{sig.old_value} → {sig.new_value}</div>
      )}
    </div>
  );
};

// ── Main Component ──

const CheckPanelApp: React.FC<{
  onClose: () => void;
  onOpenAuto: (open: boolean) => void;
  getResult: () => CheckResult | null;
}> = ({ onClose, onOpenAuto, getResult }) => {
  const [view, setView] = useState<'current' | 'history' | 'detail'>('current');
  const [historyTimestamp, setHistoryTimestamp] = useState('');
  const [historyEvents, setHistoryEvents] = useState<HistoryEvent[]>([]);
  const [historyDetail, setHistoryDetail] = useState<CheckResult | null>(null);
  const [gateData, setGateData] = useState<GateData | null>(null);
  const [panelWidth, setPanelWidth] = useState(340);

  const resultRef = useRef(getResult());
  const panelRef = useRef<HTMLDivElement>(null);

  // ── Resize ──

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      setPanelWidth(Math.max(280, Math.min(600, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  // ── History loading ──

  const loadHistory = useCallback(async () => {
    try {
      const json = await rpc<string>('hologram_call', { tool: 'project_timeline', args: { limit: 80 } });
      const data = JSON.parse(json) as { events: Array<{ timestamp: string; event_type: string; summary: string; properties?: any }> };
      const events = (data.events || [])
        .filter((e) => e.event_type === 'commit_clean' || e.event_type === 'commit_violation')
        .map((e) => ({ timestamp: e.timestamp, summary: e.summary, props: e.properties }));
      setHistoryEvents(events);
    } catch {
      setHistoryEvents([]);
    }
  }, []);

  const showHistoryList = useCallback(() => {
    setView('history');
    loadHistory();
  }, [loadHistory]);

  const showHistoryDetail = useCallback((ev: HistoryEvent) => {
    setHistoryDetail(ev.props as CheckResult);
    setHistoryTimestamp(ev.timestamp);
    setView('detail');
  }, []);

  const showCurrent = useCallback(() => {
    setView('current');
  }, []);

  // ── Gate check ──

  const loadGate = useCallback(async (path: string) => {
    try {
      const json = await rpc<string>('hologram_gate_check', { path, moduleFile: null });
      setGateData(JSON.parse(json) as GateData);
    } catch (err) {
      console.error('Gate check failed:', err);
    }
  }, []);

  // ── Compute current result ──

  const r = view === 'detail' && historyDetail ? historyDetail : resultRef.current;
  const passed = r?.passed ?? true;
  const l5 = r?.l5_violations?.length || 0;
  const l4 = r?.l4_violations?.length || 0;
  const l3 = r?.l3_violations?.length || 0;
  const l2 = r?.l2_violations?.length || 0;
  const totalV = l5 + l4 + l3 + l2;
  const nv = r?.new_violations ?? 0;
  const rv = r?.resolved_violations ?? 0;
  const pv = r?.persistent_violations ?? 0;

  return (
    <>
      {/* Corner brackets */}
      <div className="corner-brackets">
        <span className="cb-bottom left" />
        <span className="cb-bottom right" />
      </div>

      {/* Resize handle */}
      <div className="check-resize" onMouseDown={onResizeStart} />

      {/* Header */}
      <div className="check-tab">
        <span className={`check-tab-status ${passed ? 'check-pass' : 'check-fail'}`} />
        <span className="check-tab-label">简报</span>
        <button
          className="check-history-btn"
          title="查看历史"
          dangerouslySetInnerHTML={{ __html: iconHtml('timeline', 14) }}
          onClick={(e) => { e.stopPropagation(); showHistoryList(); }}
        />
        <button
          className="check-close-btn"
          dangerouslySetInnerHTML={{ __html: iconHtml('close', 16) }}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        />
      </div>

      {/* Content */}
      <div className="check-content">
        {/* ── History view ── */}
        {view === 'history' && (
          <>
            <div className="check-history-banner">
              <span className="check-history-label">历史简报 ({historyEvents.length} 条)</span>
              <button className="check-history-back" onClick={showCurrent}>返回当前</button>
            </div>
            {historyEvents.length === 0 ? (
              <div className="check-history-empty">暂无历史简报</div>
            ) : (
              <div className="check-history-list">
                {historyEvents.map((ev) => {
                  const evPassed = ev.props?.passed !== false;
                  return (
                    <div key={ev.timestamp} className="check-history-item" onClick={() => showHistoryDetail(ev)}>
                      <span className={`check-history-status ${evPassed ? 'check-history-pass' : 'check-history-fail'}`}>
                        {evPassed ? '✓' : '✗'}
                      </span>
                      <div className="check-history-info">
                        <div className="check-history-summary">{ev.summary}</div>
                        <div className="check-history-time">{fmtTime(ev.timestamp)}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── Result view (current or history detail) ── */}
        {(view === 'current' || view === 'detail') && r && (
          <>
            {/* History banner */}
            {view === 'detail' && (
              <div className="check-history-banner">
                <span className="check-history-label">历史简报 — {fmtTime(historyTimestamp)}</span>
                <button className="check-history-back" onClick={showCurrent}>返回当前</button>
              </div>
            )}

            {/* Status bar */}
            <div className={`check-status-bar ${passed ? 'check-status-pass' : 'check-status-fail'}`}>
              <span className="check-status-icon" dangerouslySetInnerHTML={{
                __html: passed ? iconHtml('check-circle', 18) : iconHtml('alert', 18),
              }} />
              <span className="check-status-label">{passed ? '检查通过' : '检查未通过'}</span>
            </div>

            {/* Summary row */}
            <div className="check-summary">
              {[`${r.total_changed_files} 文件`, totalV > 0 && `${totalV} 违规`, r.blast_radius > 0 && `波及 ${r.blast_radius}`, r.new_cycles > 0 && `环 ${r.new_cycles}`, r.new_thread_conflicts > 0 && `冲突 ${r.new_thread_conflicts}`, r.api_signature_changes > 0 && `API ${r.api_signature_changes}`, fmtTime(r.timestamp)].filter(Boolean).join(' · ')}
            </div>

            {/* Diff row */}
            {(nv > 0 || rv > 0 || pv > 0) && (
              <div className="check-diff-row">
                {nv > 0 && <span className="check-diff-badge check-diff-new">+{nv} 新增</span>}
                {rv > 0 && <span className="check-diff-badge check-diff-resolved">-{rv} 已解决</span>}
                {pv > 0 && <span className="check-diff-badge check-diff-persistent">↻ {pv} 持续</span>}
              </div>
            )}

            {/* Files */}
            <Collapsible title="变更文件" count={String(r.total_changed_files)} startOpen={r.total_changed_files <= 5}>
              <div className="check-file-list">
                {r.changed_files.map((f) => (
                  <div key={f} className="check-file-item" title={f} onClick={() => shell.navigateToFile(f)}>
                    {basename(f)}
                  </div>
                ))}
              </div>
            </Collapsible>

            {/* Violations */}
            {[
              { label: 'L5 不可逆', cls: 'l5', count: l5, violations: r.l5_violations || [] },
              { label: 'L4 静默', cls: 'l4', count: l4, violations: r.l4_violations || [] },
              { label: 'L3 延迟', cls: 'l3', count: l3, violations: r.l3_violations || [] },
              { label: 'L2 波及', cls: 'l2', count: l2, violations: r.l2_violations || [] },
            ].filter((vl) => vl.count > 0).map((vl) => (
              <Collapsible key={vl.cls} title={vl.label} count={String(vl.count)} startOpen={vl.cls === 'l5' || vl.cls === 'l4'}>
                {vl.violations.map((v, i) => (
                  <ViolationItem key={i} v={v} label={vl.label} />
                ))}
              </Collapsible>
            ))}

            {/* Stats */}
            <Collapsible title="统计" count="" startOpen={false}>
              <div className="check-stats-grid">
                {[
                  ['波及半径', `${r.blast_radius} nodes`],
                  ['跨社区边', `${r.cross_community_edges}`],
                  ['新增环', `${r.new_cycles}`],
                  ['线程冲突', `${r.new_thread_conflicts}`],
                  ['API 变更', `${r.api_signature_changes}`],
                ].map(([label, value]) => (
                  <div key={label} className="check-stat">
                    <span className="check-stat-label">{label}</span>
                    <span className="check-stat-value">{value}</span>
                  </div>
                ))}
              </div>
            </Collapsible>

            {/* Passed checks */}
            {r.passed_checks.length > 0 && (
              <Collapsible title="自动放行" count={String(r.passed_checks.length)} startOpen={false}>
                {r.passed_checks.map((c, i) => (
                  <div key={i} className="check-passed-item">{c}</div>
                ))}
              </Collapsible>
            )}

            {/* Gate check */}
            {gateData && gateData.modules && gateData.modules.length > 0 && (
              <Collapsible
                title={`门禁评估 (${gateData.total_evaluated} 模块)`}
                count={String(gateData.high_risk + gateData.medium_risk)}
                startOpen={gateData.high_risk > 0}
                className="check-fold-gate"
              >
                <div className="check-gate-summary">
                  {gateData.high_risk > 0 && <span className="check-gate-badge check-gate-high">⚠ {gateData.high_risk} 高风险</span>}
                  {gateData.medium_risk > 0 && <span className="check-gate-badge check-gate-mid">⚡ {gateData.medium_risk} 中风险</span>}
                  <span className="check-gate-badge check-gate-low">✓ {gateData.low_risk} 低风险</span>
                </div>
                {gateData.modules.filter((m) => m.risk !== 'low').map((m) => (
                  <div key={m.name} className={`check-gate-item check-gate-${m.risk}`}>
                    <div className="check-gate-item-head">
                      <span className={`check-gate-risk check-gate-risk-${m.risk}`}>{m.risk === 'high' ? '高' : '中'}</span>
                      <span className="check-gate-name">{m.name}</span>
                      <span className="check-gate-stats">扇入{m.fan_in} 扇出{m.fan_out} L4×{m.coupling_l4}</span>
                    </div>
                    {m.recommendations?.map((rec, i) => (
                      <div key={i} className="check-gate-rec">{rec}</div>
                    ))}
                  </div>
                ))}
              </Collapsible>
            )}
          </>
        )}

        {/* Empty state */}
        {(view === 'current' || view === 'detail') && !r && (
          <div className="check-history-empty">暂无简报数据</div>
        )}
      </div>
    </>
  );
};

// ── Controller ──

export class CheckPanelController {
  private _open = false;
  private _lastResult: CheckResult | null = null;
  private _panel: HTMLDivElement;
  private _root: import('react-dom/client').Root | null = null;

  constructor(container: HTMLElement) {
    this._panel = document.createElement('div');
    this._panel.id = 'check-panel';
    container.appendChild(this._panel);
  }

  // ── Public API ──

  update(result: CheckResult, projectPath?: string): void {
    this._lastResult = result;

    // Feed check result to state injection cache so the agent sees it
    cacheCheckResult({
      passed: result.passed,
      violationCount:
        (result.l5_violations?.length || 0) +
        (result.l4_violations?.length || 0) +
        (result.l3_violations?.length || 0) +
        (result.l2_violations?.length || 0),
      newCount: result.new_violations || 0,
      resolvedCount: result.resolved_violations || 0,
      persistentCount: result.persistent_violations || 0,
    });

    if (this._open) this._render(projectPath);

    // Auto-open on failure
    if (!result.passed && !this._open) this.open(projectPath);
  }

  showHistory(data: CheckResult, timestamp: string): void {
    this._lastResult = data;
    if (!this._open) this.open();
    this._render(undefined, { historyDetail: data, historyTimestamp: timestamp, view: 'detail' });
  }

  getLastResult(): CheckResult | null {
    return this._lastResult;
  }

  toggle(projectPath?: string): void {
    this._open ? this.close() : this.open(projectPath);
  }

  open(projectPath?: string): void {
    this._open = true;
    this._panel.classList.add('check-open');
    this._render(projectPath);
    import('../app-shell').then(({ shell }) => shell.notifyPanelChanged());
  }

  close(): void {
    this._open = false;
    this._panel.classList.remove('check-open');
    import('../app-shell').then(({ shell }) => shell.notifyPanelChanged());
  }

  isOpen(): boolean {
    return this._open;
  }

  destroy(): void {
    if (this._root) this._root.unmount();
    this._panel.remove();
  }

  // ── Internal ──

  private _lastGatePath: string | null = null;

  private async _render(projectPath?: string, histOverride?: { historyDetail: CheckResult; historyTimestamp: string; view: string }): Promise<void> {
    const { createRoot } = await import('react-dom/client');
    if (!this._root) this._root = createRoot(this._panel);

    const result = this._lastResult;

    this._root.render(
      React.createElement(CheckPanelApp, {
        key: Date.now(),
        onClose: () => this.close(),
        onOpenAuto: () => {},
        getResult: () => result,
      }),
    );
  }
}
