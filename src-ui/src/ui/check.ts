// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Check Panel — 简报面板
// 消费 hologram check --json 的输出，渲染变更摘要面板
// 右侧边栏，保存时自动刷新

import { shell } from './app-shell';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';

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
}

const PANEL_ID = 'check-panel';

export class CheckPanel {
  private panel!: HTMLElement;
  private content!: HTMLElement;
  private headerStatus!: HTMLElement;
  private openState = false;
  private lastResult: CheckResult | null = null;
  private viewingHistory = false;
  private historyTimestamp = '';

  constructor(container: HTMLElement) {
    this.buildDOM(container);
  }

  // ── Public API ──

  update(result: CheckResult): void {
    this.lastResult = result;
    this.viewingHistory = false;
    this.historyTimestamp = '';
    this.renderResult(result);

    // Auto-open on failure
    if (!result.passed && !this.openState) {
      this.open();
    }
  }

  showHistory(data: CheckResult, timestamp: string): void {
    this.viewingHistory = true;
    this.historyTimestamp = timestamp;
    this.renderResult(data, true);
    if (!this.openState) this.open();
  }

  showCurrent(): void {
    this.viewingHistory = false;
    this.historyTimestamp = '';
    if (this.lastResult) {
      this.renderResult(this.lastResult);
    }
  }

  getLastResult(): CheckResult | null {
    return this.lastResult;
  }

  toggle(): void {
    this.openState ? this.close() : this.open();
  }

  open(): void {
    this.openState = true;
    this.panel.classList.add('check-open');
    shell.notifyPanelChanged();
  }

  close(): void {
    this.openState = false;
    this.panel.classList.remove('check-open');
    shell.notifyPanelChanged();
  }

  isOpen(): boolean {
    return this.openState;
  }

  // ── Build DOM ──

  private buildDOM(container: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Resize handle (left edge — horizontal resize)
    const resize = document.createElement('div');
    resize.className = 'check-resize';
    this.panel.appendChild(resize);
    this.setupResize(resize);

    // Header bar
    const tab = document.createElement('div');
    tab.className = 'check-tab';

    this.headerStatus = document.createElement('span');
    this.headerStatus.className = 'check-tab-status';
    this.headerStatus.className = 'check-tab-status check-loading';
    tab.appendChild(this.headerStatus);

    const tabLabel = document.createElement('span');
    tabLabel.className = 'check-tab-label';
    tabLabel.textContent = '简报';
    tab.appendChild(tabLabel);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'check-close-btn';
    closeBtn.innerHTML = iconHtml('close', 16);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    tab.appendChild(closeBtn);

    this.panel.appendChild(tab);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'check-content';
    this.panel.appendChild(this.content);

    container.appendChild(this.panel);
  }

  private setupResize(handle: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startW = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = this.panel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(280, Math.min(600, startW + (startX - e.clientX)));
      this.panel.style.width = w + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Render ──

  private renderResult(r: CheckResult, isHistory = false): void {
    this.headerStatus.className = r.passed ? 'check-tab-status check-pass' : 'check-tab-status check-fail';

    const l5 = r.l5_violations?.length || 0;
    const l4 = r.l4_violations?.length || 0;
    const l3 = r.l3_violations?.length || 0;
    const l2 = r.l2_violations?.length || 0;
    const totalV = l5 + l4 + l3 + l2;

    this.content.innerHTML = '';

    // ── History banner ──
    if (isHistory) {
      const banner = ce('div', 'check-history-banner');
      const label = ce('span', 'check-history-label');
      label.textContent = `历史简报 — ${fmtTime(this.historyTimestamp)}`;
      banner.appendChild(label);
      const backBtn = ce('button', 'check-history-back');
      backBtn.textContent = '返回当前';
      backBtn.addEventListener('click', () => this.showCurrent());
      banner.appendChild(backBtn);
      this.content.appendChild(banner);
    }

    // ── Status header (prominent) ──
    const statusBar = ce('div', r.passed ? 'check-status-bar check-status-pass' : 'check-status-bar check-status-fail');
    const statusIcon = ce('span', 'check-status-icon');
    statusIcon.innerHTML = r.passed ? iconHtml('check-circle', 18) : iconHtml('alert', 18);
    const statusLabel = ce('span', 'check-status-label');
    statusLabel.textContent = r.passed ? '检查通过' : '检查未通过';
    statusBar.append(statusIcon, statusLabel);
    this.content.appendChild(statusBar);

    // ── Summary row (one-liner) ──
    const summary = ce('div', 'check-summary');
    const parts: string[] = [];
    parts.push(`${r.total_changed_files} 文件`);
    if (totalV > 0) parts.push(`${totalV} 违规`);
    if (r.blast_radius > 0) parts.push(`波及 ${r.blast_radius}`);
    if (r.new_cycles > 0) parts.push(`环 ${r.new_cycles}`);
    if (r.new_thread_conflicts > 0) parts.push(`冲突 ${r.new_thread_conflicts}`);
    if (r.api_signature_changes > 0) parts.push(`API ${r.api_signature_changes}`);
    parts.push(fmtTime(r.timestamp));
    summary.textContent = parts.join(' · ');
    this.content.appendChild(summary);

    // ── Collapsible sections ──

    // Files
    this.addCollapsible(
      '变更文件', String(r.total_changed_files),
      r.total_changed_files <= 5, // auto-expand if few
      () => {
        const list = ce('div', 'check-file-list');
        for (const f of r.changed_files) {
          const item = ce('div', 'check-file-item');
          item.textContent = basename(f);
          item.title = f;
          item.addEventListener('click', () => shell.navigateToFile(f));
          list.appendChild(item);
        }
        return list;
      },
    );

    // Violations: all levels, collapsed unless it's the highest severity or >0
    const vLevels: Array<{ label: string; cls: string; count: number; violations: Violation[] }> = [
      { label: 'L5 不可逆', cls: 'l5', count: l5, violations: r.l5_violations || [] },
      { label: 'L4 静默', cls: 'l4', count: l4, violations: r.l4_violations || [] },
      { label: 'L3 延迟', cls: 'l3', count: l3, violations: r.l3_violations || [] },
      { label: 'L2 波及', cls: 'l2', count: l2, violations: r.l2_violations || [] },
    ];
    for (const vl of vLevels) {
      if (vl.count === 0) continue;
      const expand = vl.cls === 'l5' || vl.cls === 'l4'; // auto-expand L5/L4
      this.addCollapsible(vl.label, String(vl.count), expand, () => this.buildViolationGroup(vl.label, vl.cls, vl.violations));
    }

    // Stats
    this.addCollapsible('统计', '', false, () => {
      const grid = ce('div', 'check-stats-grid');
      grid.appendChild(this.statItem('波及半径', `${r.blast_radius} nodes`));
      grid.appendChild(this.statItem('跨社区边', `${r.cross_community_edges}`));
      grid.appendChild(this.statItem('新增环', `${r.new_cycles}`));
      grid.appendChild(this.statItem('线程冲突', `${r.new_thread_conflicts}`));
      grid.appendChild(this.statItem('API 变更', `${r.api_signature_changes}`));
      return grid;
    });

    // Auto-passed
    if (r.passed_checks.length > 0) {
      this.addCollapsible('自动放行', String(r.passed_checks.length), false, () => {
        const frag = document.createDocumentFragment();
        for (const c of r.passed_checks) {
          const item = ce('div', 'check-passed-item');
          item.textContent = c;
          frag.appendChild(item);
        }
        return frag;
      });
    }
  }

  /** Collapsible section: title + count badge → click toggles body. */
  private addCollapsible(
    title: string,
    count: string,
    startOpen: boolean,
    buildBody: () => HTMLElement | DocumentFragment,
  ): void {
    const sec = ce('div', 'check-fold-section');
    const head = ce('div', 'check-fold-head');
    const arrow = ce('span', 'check-fold-arrow');
    arrow.textContent = startOpen ? '▾' : '▸';
    const label = ce('span', 'check-fold-label');
    label.textContent = title;
    const badge = ce('span', 'check-fold-badge');
    if (count) badge.textContent = count;
    head.append(arrow, label, badge);

    const body = ce('div', 'check-fold-body');
    if (!startOpen) body.classList.add('collapsed');
    body.appendChild(buildBody());

    head.addEventListener('click', () => {
      const collapsed = body.classList.toggle('collapsed');
      arrow.textContent = collapsed ? '▸' : '▾';
    });

    sec.append(head, body);
    this.content.appendChild(sec);
  }

  private buildViolationGroup(label: string, level: string, violations: Violation[]): HTMLElement {
    const frag = document.createDocumentFragment();
    for (const v of violations) {
      const sig = v.signal || {};
      const desc = sig.description || v.message || '?';
      const fp = sig.file_path || '';
      const line = sig.line || 0;
      const loc = fp ? `${basename(fp)}${line ? ':' + line : ''}` : '';

      const item = ce('div', 'check-vitem');
      // Title row: location + description
      const titleRow = ce('div', 'check-vitem-title');
      if (loc) {
        const locEl = ce('span', 'check-vloc');
        locEl.textContent = loc;
        titleRow.appendChild(locEl);
      }
      const descEl = ce('span', 'check-vdesc');
      descEl.textContent = desc.length > 100 ? desc.slice(0, 100) + '…' : desc;
      descEl.title = desc;
      titleRow.appendChild(descEl);

      // Ask button
      const askBtn = document.createElement('button');
      askBtn.className = 'check-ask-btn';
      askBtn.innerHTML = iconHtml('agent', 12);
      askBtn.title = '问 Agent';
      const nodeList = (sig.affected_nodes || []).slice(0, 3).join(', ');
      askBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ctx = [
          `[${label}] ${desc}`,
          fp ? `文件: ${fp}${line ? ':' + line : ''}` : '',
          nodeList ? `影响: ${nodeList}` : '',
          sig.old_value ? `变更: ${sig.old_value} → ${sig.new_value}` : '',
        ].filter(Boolean).join(' | ');
        askAgent(`分析这条违规: ${ctx}`);
      });
      titleRow.appendChild(askBtn);
      item.appendChild(titleRow);

      // Affected nodes (inline)
      if (sig.affected_nodes && sig.affected_nodes.length > 0) {
        const aff = ce('div', 'check-vaffect');
        const nodeIds = sig.graph_node_ids || [];
        sig.affected_nodes.slice(0, 8).forEach((name, i) => {
          const nodeLink = ce('span', 'check-node-link');
          nodeLink.textContent = name;
          nodeLink.title = nodeIds[i] ? `节点: ${nodeIds[i]}` : '跳转到星图';
          nodeLink.addEventListener('click', (e2) => {
            e2.stopPropagation();
            shell.navigateToNode(name);
            this.close();
          });
          aff.appendChild(nodeLink);
          if (i < Math.min(sig.affected_nodes!.length, 8) - 1) {
            aff.appendChild(document.createTextNode(' · '));
          }
        });
        if (sig.affected_nodes.length > 8) {
          aff.appendChild(document.createTextNode(` … +${sig.affected_nodes.length - 8}`));
        }
        item.appendChild(aff);
      }

      // Old → new value change
      if (sig.old_value && sig.new_value) {
        const chg = ce('div', 'check-vchange');
        chg.textContent = `${sig.old_value} → ${sig.new_value}`;
        item.appendChild(chg);
      }

      frag.appendChild(item);
    }
    return frag as unknown as HTMLElement;
  }

  private statItem(label: string, value: string): HTMLElement {
    const el = ce('div', 'check-stat');
    const lbl = ce('span', 'check-stat-label');
    lbl.textContent = label;
    const val = ce('span', 'check-stat-value');
    val.textContent = value;
    el.append(lbl, val);
    return el;
  }

  // ── P8: Gate check rendering ──

  async loadAndRenderGate(path: string): Promise<void> {
    try {
      const { invoke } = await import('../bridge');
      const json = await invoke<string>('hologram_gate_check', { path, moduleFile: null });
      const data = JSON.parse(json) as GateData;
      this.renderGate(data);
    } catch (err) {
      console.error('Gate check failed:', err);
    }
  }

  private renderGate(data: GateData): void {
    if (!data || !data.modules || data.modules.length === 0) return;

    // Remove existing gate section if any
    const existing = this.content.querySelector('.check-fold-gate');
    if (existing) existing.remove();

    const gateLabel = `门禁评估 (${data.total_evaluated} 模块)`;
    const riskCount = String(data.high_risk + data.medium_risk);
    this.addCollapsible(gateLabel, riskCount, data.high_risk > 0, () => {
      const frag = document.createDocumentFragment();

      // Risk summary
      const summaryRow = ce('div', 'check-gate-summary');
      if (data.high_risk > 0) {
        const hi = ce('span', 'check-gate-badge check-gate-high');
        hi.textContent = `⚠ ${data.high_risk} 高风险`;
        summaryRow.appendChild(hi);
      }
      if (data.medium_risk > 0) {
        const mi = ce('span', 'check-gate-badge check-gate-mid');
        mi.textContent = `⚡ ${data.medium_risk} 中风险`;
        summaryRow.appendChild(mi);
      }
      const lo = ce('span', 'check-gate-badge check-gate-low');
      lo.textContent = `✓ ${data.low_risk} 低风险`;
      summaryRow.appendChild(lo);
      frag.appendChild(summaryRow);

      for (const m of data.modules) {
        if (m.risk === 'low') continue;
        const item = ce('div', `check-gate-item check-gate-${m.risk}`);
        const head = ce('div', 'check-gate-item-head');
        const riskBadge = ce('span', `check-gate-risk check-gate-risk-${m.risk}`);
        riskBadge.textContent = m.risk === 'high' ? '高' : '中';
        head.appendChild(riskBadge);
        const nameEl = ce('span', 'check-gate-name');
        nameEl.textContent = m.name;
        head.appendChild(nameEl);
        const stats = ce('span', 'check-gate-stats');
        stats.textContent = `扇入${m.fan_in} 扇出${m.fan_out} L4×${m.coupling_l4}`;
        head.appendChild(stats);
        item.appendChild(head);
        if (m.recommendations && m.recommendations.length > 0) {
          for (const rec of m.recommendations) {
            const recEl = ce('div', 'check-gate-rec');
            recEl.textContent = rec;
            item.appendChild(recEl);
          }
        }
        frag.appendChild(item);
      }
      return frag;
    });
  }
}

// ── Gate data types ──

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

// ── Helpers ──

function ce(tag: string, cls?: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
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
