// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// CheckPanel — check.ts 的 React 重写。
// 变更摘要面板，包含违规项、统计数据、门禁检查。
// 右侧栏，检查失败时自动打开。

import React, { useCallback, useEffect, useState } from 'react';
import { typedRpc } from '../../rpc-contract';
import { askAgent } from '../agent-visualizer';
import { shell } from '../app-shell';
import { useDockStore } from '../dock-store';
import { iconHtml } from '../icons';
import { basename } from './helpers';

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

// ── 折叠区段 ──

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

// ── 违规项 ──

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
    ]
      .filter(Boolean)
      .join(' | ');
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
              {i < Math.min(sig.affected_nodes?.length ?? 0, 8) - 1 && ' · '}
            </React.Fragment>
          ))}
          {sig.affected_nodes.length > 8 && ` … +${sig.affected_nodes.length - 8}`}
        </div>
      )}
      {sig.old_value && sig.new_value && (
        <div className="check-vchange">
          {sig.old_value} → {sig.new_value}
        </div>
      )}
    </div>
  );
};

// ── 主组件（P3：直接挂 DockPanel 树，Controller 包装已删）──
// 开合状态与结果数据都在 dock-store；旧 key 重挂载的视图复位语义用 effect 复现。

export function CheckPanel() {
  const open = useDockStore((s) => s.open.check);
  const result = useDockStore((s) => s.checkResult);
  const closePanel = useDockStore((s) => s.closePanel);

  const [view, setView] = useState<'current' | 'history' | 'detail'>('current');
  const [historyTimestamp, setHistoryTimestamp] = useState('');
  const [historyEvents, setHistoryEvents] = useState<HistoryEvent[]>([]);
  const [historyDetail, setHistoryDetail] = useState<CheckResult | null>(null);

  // 旧 Controller 每次 render 都以新 key 重挂载 → 视图复位为 current；
  // 这里在「重新打开」与「新结果推入」时复现同样的复位。
  useEffect(() => {
    if (open) setView('current');
  }, [open]);

  // ── 历史加载 ──

  const loadHistory = useCallback(async () => {
    try {
      const json = await typedRpc('hologram_call', { tool: 'project_timeline', args: { limit: 80 } });
      const data = JSON.parse(json) as {
        events: Array<{ timestamp: string; event_type: string; summary: string; properties?: any }>;
      };
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

  // ── 计算当前结果 ──

  const r = view === 'detail' && historyDetail ? historyDetail : result;
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
    <div id="check-panel" className={open ? 'check-open' : ''}>
      {/* Resize 视觉条（旧拖拽逻辑从未接入宽度 — 死代码已清） */}
      <div className="check-resize" />

      {/* 头部 */}
      <div className="check-tab">
        <span className={`check-tab-status ${passed ? 'check-pass' : 'check-fail'}`} />
        <span className="check-tab-label"><span className="zh">简报</span>BRIEFING</span>
        <button
          className="check-history-btn"
          title="查看历史"
          dangerouslySetInnerHTML={{ __html: iconHtml('timeline', 14) }}
          onClick={(e) => {
            e.stopPropagation();
            showHistoryList();
          }}
        />
        <button
          className="check-close-btn"
          dangerouslySetInnerHTML={{ __html: iconHtml('close', 16) }}
          onClick={(e) => {
            e.stopPropagation();
            closePanel('check');
          }}
        />
      </div>

      {/* 内容 */}
      <div className="check-content">
        {/* ── 历史视图 ── */}
        {view === 'history' && (
          <>
            <div className="check-history-banner">
              <span className="check-history-label">历史简报 ({historyEvents.length} 条)</span>
              <button className="check-history-back" onClick={showCurrent}>
                返回当前
              </button>
            </div>
            {historyEvents.length === 0 ? (
              <div className="check-history-empty">暂无历史简报</div>
            ) : (
              <div className="check-history-list">
                {historyEvents.map((ev) => {
                  const evPassed = ev.props?.passed !== false;
                  return (
                    <div key={ev.timestamp} className="check-history-item" onClick={() => showHistoryDetail(ev)}>
                      <span
                        className={`check-history-status ${evPassed ? 'check-history-pass' : 'check-history-fail'}`}
                      >
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

        {/* ── 结果视图（当前或历史详情） ── */}
        {(view === 'current' || view === 'detail') && r && (
          <>
            {/* 历史横幅 */}
            {view === 'detail' && (
              <div className="check-history-banner">
                <span className="check-history-label">历史简报 — {fmtTime(historyTimestamp)}</span>
                <button className="check-history-back" onClick={showCurrent}>
                  返回当前
                </button>
              </div>
            )}

            {/* 状态栏 */}
            <div className={`check-status-bar ${passed ? 'check-status-pass' : 'check-status-fail'}`}>
              <span
                className="check-status-icon"
                dangerouslySetInnerHTML={{
                  __html: passed ? iconHtml('check-circle', 18) : iconHtml('alert', 18),
                }}
              />
              <span className="check-status-label">{passed ? '检查通过' : '检查未通过'}</span>
            </div>

            {/* 摘要行 */}
            <div className="check-summary">
              {[
                `${r.total_changed_files} 文件`,
                totalV > 0 && `${totalV} 违规`,
                r.blast_radius > 0 && `波及 ${r.blast_radius}`,
                r.new_cycles > 0 && `环 ${r.new_cycles}`,
                r.new_thread_conflicts > 0 && `冲突 ${r.new_thread_conflicts}`,
                r.api_signature_changes > 0 && `API ${r.api_signature_changes}`,
                fmtTime(r.timestamp),
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>

            {/* 差异行 */}
            {(nv > 0 || rv > 0 || pv > 0) && (
              <div className="check-diff-row">
                {nv > 0 && <span className="check-diff-badge check-diff-new">+{nv} 新增</span>}
                {rv > 0 && <span className="check-diff-badge check-diff-resolved">-{rv} 已解决</span>}
                {pv > 0 && <span className="check-diff-badge check-diff-persistent">↻ {pv} 持续</span>}
              </div>
            )}

            {/* 文件 */}
            <Collapsible title="变更文件" count={String(r.total_changed_files)} startOpen={r.total_changed_files <= 5}>
              <div className="check-file-list">
                {(r.changed_files || []).map((f) => (
                  <div key={f} className="check-file-item" title={f} onClick={() => shell.navigateToFile(f)}>
                    {basename(f)}
                  </div>
                ))}
              </div>
            </Collapsible>

            {/* 违规 */}
            {[
              { label: 'L5 不可逆', cls: 'l5', count: l5, violations: r.l5_violations || [] },
              { label: 'L4 静默', cls: 'l4', count: l4, violations: r.l4_violations || [] },
              { label: 'L3 延迟', cls: 'l3', count: l3, violations: r.l3_violations || [] },
              { label: 'L2 波及', cls: 'l2', count: l2, violations: r.l2_violations || [] },
            ]
              .filter((vl) => vl.count > 0)
              .map((vl) => (
                <Collapsible
                  key={vl.cls}
                  title={vl.label}
                  count={String(vl.count)}
                  startOpen={vl.cls === 'l5' || vl.cls === 'l4'}
                >
                  {vl.violations.map((v, i) => (
                    <ViolationItem key={i} v={v} label={vl.label} />
                  ))}
                </Collapsible>
              ))}

            {/* 统计 */}
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

            {/* 自动放行 */}
            {(r.passed_checks?.length || 0) > 0 && (
              <Collapsible title="自动放行" count={String(r.passed_checks.length)} startOpen={false}>
                {(r.passed_checks || []).map((c, i) => (
                  <div key={i} className="check-passed-item">
                    {c}
                  </div>
                ))}
              </Collapsible>
            )}
          </>
        )}

        {/* 空状态 */}
        {(view === 'current' || view === 'detail') && !r && <div className="check-history-empty">暂无简报数据</div>}
      </div>
    </div>
  );
}
