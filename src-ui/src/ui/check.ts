// Check Panel — 简报面板
// 消费 hologram check --json 的输出，渲染变更摘要面板
// 底部抽屉，保存时自动刷新

import { bus } from './events';

export interface Violation {
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

  constructor(container: HTMLElement) {
    this.buildDOM(container);
  }

  // ── Public API ──

  update(result: CheckResult): void {
    this.lastResult = result;
    this.renderResult(result);

    // Auto-open on failure
    if (!result.passed && !this.openState) {
      this.open();
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
  }

  close(): void {
    this.openState = false;
    this.panel.classList.remove('check-open');
  }

  isOpen(): boolean {
    return this.openState;
  }

  // ── Build DOM ──

  private buildDOM(container: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;

    // Tab handle (always visible when results exist)
    const tab = document.createElement('div');
    tab.className = 'check-tab';
    tab.addEventListener('click', () => this.toggle());

    this.headerStatus = document.createElement('span');
    this.headerStatus.className = 'check-tab-status';
    this.headerStatus.textContent = '⏳';
    tab.appendChild(this.headerStatus);

    const tabLabel = document.createElement('span');
    tabLabel.className = 'check-tab-label';
    tabLabel.textContent = '简报';
    tab.appendChild(tabLabel);

    const tabArrow = document.createElement('span');
    tabArrow.className = 'check-tab-arrow';
    tabArrow.textContent = '▲';
    tab.appendChild(tabArrow);

    this.panel.appendChild(tab);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'check-content';
    this.panel.appendChild(this.content);

    container.appendChild(this.panel);
  }

  // ── Render ──

  private renderResult(r: CheckResult): void {
    // Update tab status indicator
    this.headerStatus.textContent = r.passed ? '✅' : '⚠️';
    this.headerStatus.className = r.passed ? 'check-tab-status check-pass' : 'check-tab-status check-fail';

    const totalV = r.l5_violations.length + r.l4_violations.length +
                   r.l3_violations.length + r.l2_violations.length;

    this.content.innerHTML = '';

    // ── Header ──
    const header = ce('div', 'check-header');
    const statusBadge = ce('span', r.passed ? 'check-badge-pass' : 'check-badge-fail');
    statusBadge.textContent = r.passed ? '✅ 通过' : '⚠️ 未通过';
    header.appendChild(statusBadge);

    const ts = ce('span', 'check-ts');
    ts.textContent = fmtTime(r.timestamp);
    header.appendChild(ts);
    this.content.appendChild(header);

    // ── Files ──
    const filesSec = ce('div', 'check-section');
    const filesTitle = ce('div', 'check-section-title');
    filesTitle.textContent = `📄 变更文件 (${r.total_changed_files})`;
    filesSec.appendChild(filesTitle);
    const filesList = ce('div', 'check-file-list');
    for (const f of r.changed_files.slice(0, 10)) {
      const item = ce('div', 'check-file-item');
      item.textContent = basename(f);
      item.title = f;
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        bus.emit('navigate:file', f);
      });
      filesList.appendChild(item);
    }
    if (r.changed_files.length > 10) {
      const more = ce('div', 'check-file-item check-file-more');
      more.textContent = `… 还有 ${r.changed_files.length - 10} 个文件`;
      filesList.appendChild(more);
    }
    filesSec.appendChild(filesList);
    this.content.appendChild(filesSec);

    // ── Violations ──
    if (!r.passed && totalV > 0) {
      const vSec = ce('div', 'check-section');
      const vTitle = ce('div', 'check-section-title');
      vTitle.textContent = `🚨 违规 (${totalV})`;
      vSec.appendChild(vTitle);

      // L5 - Irreversible
      if (r.l5_violations.length > 0) {
        vSec.appendChild(this.renderViolationGroup('L5 不可逆', 'l5', r.l5_violations));
      }
      // L4 - Silent
      if (r.l4_violations.length > 0) {
        vSec.appendChild(this.renderViolationGroup('L4 静默', 'l4', r.l4_violations));
      }
      // L3 - Delayed
      if (r.l3_violations.length > 0) {
        vSec.appendChild(this.renderViolationGroup('L3 延迟', 'l3', r.l3_violations));
      }
      // L2 - Blast
      if (r.l2_violations.length > 0) {
        vSec.appendChild(this.renderViolationGroup('L2 波及', 'l2', r.l2_violations));
      }

      this.content.appendChild(vSec);
    }

    // ── Stats ──
    const statsSec = ce('div', 'check-section');
    const statsTitle = ce('div', 'check-section-title');
    statsTitle.textContent = '📊 统计';
    statsSec.appendChild(statsTitle);

    const statsGrid = ce('div', 'check-stats-grid');
    statsGrid.appendChild(this.statItem('波及半径', `${r.blast_radius} nodes`));
    statsGrid.appendChild(this.statItem('跨社区边', `${r.cross_community_edges}`));
    statsGrid.appendChild(this.statItem('新环', `${r.new_cycles}`));
    statsGrid.appendChild(this.statItem('线程冲突', `${r.new_thread_conflicts}`));
    statsGrid.appendChild(this.statItem('API 签名变更', `${r.api_signature_changes}`));
    statsSec.appendChild(statsGrid);
    this.content.appendChild(statsSec);

    // ── Auto-passed ──
    if (r.passed_checks.length > 0) {
      const apSec = ce('div', 'check-section');
      const apTitle = ce('div', 'check-section-title');
      apTitle.textContent = `✅ 自动放行 (${r.passed_checks.length})`;
      apSec.appendChild(apTitle);
      for (const c of r.passed_checks.slice(0, 8)) {
        const item = ce('div', 'check-passed-item');
        item.textContent = c;
        apSec.appendChild(item);
      }
      if (r.passed_checks.length > 8) {
        const more = ce('div', 'check-passed-item');
        more.textContent = `… 还有 ${r.passed_checks.length - 8} 项`;
        apSec.appendChild(more);
      }
      this.content.appendChild(apSec);
    }
  }

  private renderViolationGroup(
    label: string,
    level: string,
    violations: Violation[],
  ): HTMLElement {
    const group = ce('div', 'check-vgroup');
    const head = ce('div', `check-vhead check-vhead-${level}`);
    head.textContent = `${label} (${violations.length})`;
    group.appendChild(head);

    for (const v of violations.slice(0, 5)) {
      const sig = v.signal || {};
      const desc = sig.description || v.message || '?';
      const fp = sig.file_path || '';
      const line = sig.line || 0;
      const loc = fp ? `${basename(fp)}${line ? ':' + line : ''}` : '';

      const item = ce('div', 'check-vitem');
      const locEl = ce('span', 'check-vloc');
      locEl.textContent = loc;
      item.appendChild(locEl);
      const descEl = ce('span', 'check-vdesc');
      descEl.textContent = desc.length > 80 ? desc.slice(0, 80) + '…' : desc;
      descEl.title = desc;
      item.appendChild(descEl);

      if (sig.affected_nodes && sig.affected_nodes.length > 0) {
        const aff = ce('div', 'check-vaffect');
        const affLabel = document.createElement('span');
        affLabel.textContent = '影响: ';
        aff.appendChild(affLabel);

        const nodeIds = sig.graph_node_ids || [];
        const displayNodes = sig.affected_nodes.slice(0, 5);
        displayNodes.forEach((name, i) => {
          const nodeLink = ce('span', 'check-node-link');
          nodeLink.textContent = name;
          const gid = nodeIds[i] || '';
          nodeLink.title = gid ? `节点ID: ${gid}\n点击跳转到星图` : '点击跳转到星图';
          nodeLink.addEventListener('click', (e) => {
            e.stopPropagation();
            bus.emit('navigate:node', name);
            this.close();
          });
          aff.appendChild(nodeLink);
          if (i < displayNodes.length - 1) {
            aff.appendChild(document.createTextNode(', '));
          }
        });

        if (sig.affected_nodes.length > 5) {
          const more = document.createElement('span');
          more.className = 'check-vmore-inline';
          more.textContent = ` … +${sig.affected_nodes.length - 5}`;
          aff.appendChild(more);
        }

        item.appendChild(aff);
      }
      if (sig.old_value && sig.new_value) {
        const chg = ce('div', 'check-vchange');
        chg.textContent = `${sig.old_value} → ${sig.new_value}`;
        item.appendChild(chg);
      }

      group.appendChild(item);
    }

    if (violations.length > 5) {
      const more = ce('div', 'check-vmore');
      more.textContent = `… 还有 ${violations.length - 5} 条`;
      group.appendChild(more);
    }

    return group;
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
