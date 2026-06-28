// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Hotspots Panel — 复发热点检测（P6）
// 同一文件多次触发 L4 警报 → 星图着色升级

import { invoke } from '../bridge';
import { shell } from './app-shell';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';
import type { StarGraph } from './graph';

interface HotspotItem {
  file: string;
  count: number;
  last_details: {
    description: string;
    level: number;
    line: number;
    timestamp: string;
  };
  recent_timestamps: string[];
}

interface HotspotsData {
  hotspots: HotspotItem[];
  total_check_events: number;
  days: number;
  min_count: number;
}

const PANEL_ID = 'hotspots-panel';

const SEVERITY_CLASS: Record<number, string> = {
  2: 'hs-sev-low',
  3: 'hs-sev-mid',
  4: 'hs-sev-high',
  5: 'hs-sev-critical',
};

export class HotspotsPanel {
  private panel!: HTMLElement;
  private content!: HTMLElement;
  private tabStatus!: HTMLElement;
  private openState = false;
  private hotspots: HotspotItem[] = [];
  private loading = false;
  private path: string | null = null;
  private starGraph: StarGraph | null = null;

  constructor(container: HTMLElement) {
    this.buildDOM(container);
  }

  setGraph(sg: StarGraph): void { this.starGraph = sg; }

  private buildDOM(container: HTMLElement): void {
    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Tab
    const tab = document.createElement('div');
    tab.className = 'hs-tab';
    tab.addEventListener('click', () => this.toggle());

    this.tabStatus = document.createElement('span');
    this.tabStatus.className = 'hs-tab-status';
    this.tabStatus.innerHTML = iconHtml('fire', 11);

    const label = document.createElement('span');
    label.className = 'hs-tab-label';
    label.textContent = '热点';

    const arrow = document.createElement('span');
    arrow.className = 'hs-tab-arrow';
    arrow.innerHTML = iconHtml('chevron-up', 9);

    tab.appendChild(this.tabStatus);
    tab.appendChild(label);
    tab.appendChild(arrow);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'hs-content';

    this.panel.appendChild(tab);
    this.panel.appendChild(this.content);
    container.appendChild(this.panel);
  }

  // ── Public API ──

  setProjectPath(path: string | null): void {
    this.path = path;
    this.hotspots = [];
    if (path) this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.path || this.loading) return;
    this.loading = true;
    this.tabStatus.innerHTML = iconHtml('loading', 11);

    try {
      const json = await invoke<string>('hologram_hotspots', {
        days: 30,
        min_count: 2,
      });
      const data = JSON.parse(json) as HotspotsData;
      this.hotspots = data.hotspots || [];
      const count = this.hotspots.length;
      this.tabStatus.innerHTML = count > 0
        ? `${iconHtml('fire', 11)} ${count}`
        : iconHtml('fire', 11);
      if (this.openState) this.render();
      // Auto-open if hotspots found
      if (count > 0 && !this.openState) this.open();
    } catch (err) {
      console.error('Hotspots refresh failed:', err);
      this.tabStatus.innerHTML = iconHtml('fire', 11);
    } finally {
      this.loading = false;
    }
  }

  toggle(): void {
    this.openState = !this.openState;
    if (this.openState) {
      this.panel.classList.add('hs-open');
      this.render();
    } else {
      this.panel.classList.remove('hs-open');
      this.starGraph?.clearHotspots();
    }
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.openState; }

  open(): void {
    if (!this.openState) this.toggle();
  }

  close(): void {
    if (this.openState) this.toggle();
  }

  getHotspots(): HotspotItem[] { return this.hotspots; }

  private render(): void {
    if (this.hotspots.length === 0) {
      this.content.innerHTML = `<div class="hs-empty">暂无复发热点。项目运行一段时间后，同一文件多次触发 L4 警报时会出现在这里。</div>`;
      return;
    }

    let html = `<div class="hs-header">复发热点<span class="hs-subtitle">— 同一文件多次触发 L4（封装穿透）警报</span></div>`;

    for (const hs of this.hotspots) {
      const fn = basename(hs.file);
      const sevClass = SEVERITY_CLASS[hs.last_details.level] || 'hs-sev-mid';
      const desc = hs.last_details.description
        ? (hs.last_details.description.length > 60 ? hs.last_details.description.slice(0, 60) + '…' : hs.last_details.description)
        : '';
      const line = hs.last_details.line ? `:${hs.last_details.line}` : '';
      const lastTs = hs.recent_timestamps[0] ? fmtTime(hs.recent_timestamps[0]) : '';
      const countClass = hs.count >= 5 ? 'hs-count-critical' : hs.count >= 3 ? 'hs-count-warn' : '';

      html += `<div class="hs-item" data-file="${escapeHtml(hs.file)}">`;
      html += `<div class="hs-file-row">`;
      html += `<span class="hs-count ${countClass}">${hs.count}×</span>`;
      html += `<span class="hs-file">${escapeHtml(fn)}</span>`;
      html += `<span class="hs-line">${escapeHtml(line)}</span>`;
      html += `</div>`;
      if (desc) html += `<div class="hs-desc ${sevClass}">${escapeHtml(desc)}</div>`;
      if (lastTs) html += `<div class="hs-time">最近: ${lastTs}</div>`;
      html += `<button class="hs-ask-btn" title="问 Agent 关于这个热点">${iconHtml('agent', 10)}</button>`;
      html += `</div>`;
    }

    this.content.innerHTML = html;

    // Wire click → navigate to file on star graph
    this.content.querySelectorAll('.hs-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.hs-ask-btn')) return;
        const file = (el as HTMLElement).dataset['file'] || '';
        if (file) {
          shell.navigateToFile(file);
          // Also highlight on graph
          this.starGraph?.highlightHotspots(this.hotspots);
        }
      });
    });

    // Wire "Ask Agent" buttons
    this.content.querySelectorAll('.hs-ask-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = (el as HTMLElement).closest('.hs-item') as HTMLElement;
        if (!item) return;
        const file = item.dataset['file'] || '';
        const hs = this.hotspots.find(h => h.file === file);
        if (!hs) return;
        const context = [
          `复发热点: ${basename(file)}`,
          `复发次数: ${hs.count}× L4 封装穿透`,
          hs.last_details.description ? `最近描述: ${hs.last_details.description}` : '',
        ].filter(Boolean).join(' | ');
        askAgent(`分析这个复发热点: ${context}`);
      });
    });

    // Highlight on graph
    this.starGraph?.highlightHotspots(this.hotspots);
  }
}

// ── Helpers ──

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso.slice(0, 16);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
