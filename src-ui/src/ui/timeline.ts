// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Timeline Panel — 决策时间轴
// 消费 hologram_timeline 命令的输出，渲染事件时间线

import { invoke } from '../bridge';
import { bus } from './events';
import { shell } from './app-shell';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';
import type { CheckResult } from './check';

interface TimelineEvent {
  id: number;
  timestamp: string;
  event_type: string;
  file: string;
  summary: string;
  properties?: Record<string, unknown>;
}

interface TimelineData {
  events: TimelineEvent[];
  total?: number;
}

const TYPE_ICONS: Record<string, string> = {
  file_changed: iconHtml('edit', 10),
  data_file_changed: iconHtml('save', 10),
  commit: iconHtml('bookmark', 10),
  blindspot_detected: iconHtml('alert', 10),
  user_action: iconHtml('user', 10),
  commit_violation: iconHtml('alert', 10),
  commit_clean: iconHtml('check-circle', 10),
  check: iconHtml('chart', 10),
};

const TYPE_LABELS: Record<string, string> = {
  file_changed: '文件变更',
  data_file_changed: '数据变更',
  commit: 'Commit',
  blindspot_detected: '边界检测',
  user_action: '用户操作',
  commit_violation: '变更风险',
  commit_clean: '变更通过',
  check: '简报',
};

export class TimelinePanel {
  private panel!: HTMLElement;
  private content!: HTMLElement;
  private openState = false;
  private events: TimelineEvent[] = [];
  private loading = false;
  private path: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.buildDOM(container);
  }

  private buildDOM(container: HTMLElement): void {
    // Panel
    this.panel = document.createElement('div');
    this.panel.id = 'timeline-panel';

    // Corner brackets
    const brackets = document.createElement('div');
    brackets.className = 'corner-brackets';
    brackets.innerHTML = '<span class="cb-bottom left"></span><span class="cb-bottom right"></span>';
    this.panel.appendChild(brackets);

    // Header
    const header = document.createElement('div');
    header.className = 'tl-header';
    const title = document.createElement('span');
    title.className = 'tl-title';
    title.textContent = '时间轴';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tl-close';
    closeBtn.innerHTML = '&#x2715;';
    closeBtn.title = '收起时间轴';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'tl-content';

    this.panel.appendChild(this.content);
    container.appendChild(this.panel);
  }

  // ── Public API ──

  setProjectPath(path: string | null): void {
    // Allow re-entry for same path (supports retry after failure)
    const pathChanged = this.path !== path;
    this.path = path;
    if (path) {
      if (pathChanged) this.events = [];
      this.refresh();
      // Event-driven refresh — timeline:refresh emitted on each graph update
      if (!this.refreshInterval) {
        bus.on('timeline:refresh', () => this.scheduleRefresh());
        this.refreshInterval = 1 as any; // marker: event listener registered
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 600);
  }

  async refresh(): Promise<void> {
    if (!this.path || this.loading) return;
    this.loading = true;

    try {
      // 8-second timeout — prevent perpetual loading if backend hangs
      const json = await Promise.race([
        invoke<string>('hologram_timeline', {
          path: this.path,
          limit: 60,
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Timeline query timed out after 8s')), 8000)
        ),
      ]);
      const data = JSON.parse(json) as TimelineData;
      this.events = data.events || [];
      if (this.openState) this.render();
    } catch (err) {
      console.error('Timeline refresh failed:', err);
      // Show error state in panel if open
      if (this.openState) {
        this.content.innerHTML = `<div class="tl-empty" style="color:var(--fail)">时间轴暂时不可用<br><small>${String(err).slice(0, 80)}</small></div>`;
      }
    } finally {
      this.loading = false;
    }
  }

  toggle(): void {
    this.openState = !this.openState;
    if (this.openState) {
      this.panel.classList.add('tl-open');
      // If a refresh is in flight, skip rendering — refresh() will call render() when done
      if (!this.loading) this.render();
    } else {
      this.panel.classList.remove('tl-open');
    }
    shell.notifyPanelChanged();
  }

  isOpen(): boolean { return this.openState; }

  close(): void {
    if (this.openState) this.toggle();
  }

  private render(): void {
    if (this.events.length === 0) {
      if (this.loading) {
        this.content.innerHTML = `<div class="tl-empty"><span class="tl-spinner"></span> 加载中…</div>`;
      } else {
        this.content.innerHTML = `<div class="tl-empty">暂无时间轴事件。开始编辑代码后，事件会自动记录。</div>`;
      }
      return;
    }

    let html = '<div class="tl-timeline">';

    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];
      const prev = i > 0 ? this.events[i - 1] : null;
      const sameMinute = prev && prev.timestamp?.slice(0, 16) === ev.timestamp?.slice(0, 16);
      const icon = TYPE_ICONS[ev.event_type] || '📌';
      const label = TYPE_LABELS[ev.event_type] || ev.event_type;
      const ts = ev.timestamp ? formatTimestamp(ev.timestamp) : '';
      const file = ev.file ? extractFilename(ev.file) : '';

      // Show time header if minute changed
      if (!sameMinute) {
        html += `<div class="tl-time-divider"><span>${ts}</span></div>`;
      }

      const isCheckEvent = ev.event_type === 'commit_violation' || ev.event_type === 'commit_clean' || ev.event_type === 'check';
      const hasViolations = ev.properties && ev.properties['violations'];
      const checkPassed = ev.properties && ev.properties['passed'] !== false;
      html += `<div class="tl-event${isCheckEvent ? ' tl-event-check' : ''}${isCheckEvent && !checkPassed ? ' tl-event-fail' : ''}" data-event-id="${ev.id}" data-tl-file="${escapeHtml(ev.file || '')}" data-tl-summary="${escapeHtml(ev.summary || '')}" data-tl-type="${escapeHtml(label)}">`;
      html += `<div class="tl-event-dot${isCheckEvent ? (checkPassed ? ' tl-dot-pass' : ' tl-dot-fail') : ''}"></div>`;
      html += `<div class="tl-event-body">`;
      html += `<div class="tl-event-header">`;
      html += `<span class="tl-event-icon">${icon}</span>`;
      html += `<span class="tl-event-type">${label}</span>`;
      if (file) html += `<span class="tl-event-file">${escapeHtml(file)}</span>`;
      html += `<button class="tl-ask-btn" title="问 Agent 关于这次变更">${iconHtml('agent', 10)}</button>`;
      html += `</div>`;
      if (ev.summary) html += `<div class="tl-event-summary">${escapeHtml(ev.summary)}${isCheckEvent ? ` <span class="tl-check-badge ${checkPassed ? 'tl-check-badge-pass' : 'tl-check-badge-fail'}">${checkPassed ? '✓ 通过' : '✗ 未通过'}</span>` : ''}</div>`;
      html += `</div></div>`;
    }

    html += '</div>';
    this.content.innerHTML = html;

    // Wire up "Ask Agent" buttons
    this.content.querySelectorAll('.tl-ask-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const eventEl = (el as HTMLElement).closest('.tl-event') as HTMLElement;
        if (!eventEl) return;
        const typeLabel = eventEl.dataset['tlType'] || '变更';
        const file = eventEl.dataset['tlFile'] || '';
        const summary = eventEl.dataset['tlSummary'] || '';
        const nodes = Array.from(eventEl.querySelectorAll('.tl-event-node-link'))
          .map(n => (n as HTMLElement).dataset['node'] || '')
          .filter(Boolean)
          .join(', ');
        const context = [
          `[${typeLabel}]`,
          file ? `文件: ${file}` : '',
          summary ? `摘要: ${summary}` : '',
          nodes ? `相关节点: ${nodes}` : '',
        ].filter(Boolean).join(' | ');
        askAgent(`分析这次变更: ${context}`);
      });
    });

    // Wire up node link clicks
    this.content.querySelectorAll('.tl-event-node-link').forEach(el => {
      el.addEventListener('click', () => {
        const nodeName = (el as HTMLElement).dataset['node'];
        if (nodeName) {
          shell.navigateToNode(nodeName);
        }
      });
    });

    // Wire up file clicks → open in file viewer
    this.content.querySelectorAll('.tl-event-file').forEach(el => {
      el.addEventListener('click', async () => {
        const fileName = (el as HTMLElement).textContent;
        if (fileName && this.path) {
          // Try to find full path
          for (const ev of this.events) {
            if (ev.file && ev.file.endsWith(fileName!)) {
              try {
                const { FileViewer } = await import('./file-viewer');
                FileViewer.get().open(ev.file);
              } catch { /* dynamic import failed */ }
              break;
            }
          }
        }
      });
    });

    // Wire up check events → open historical briefing
    this.content.querySelectorAll('.tl-event').forEach(el => {
      const eventId = parseInt((el as HTMLElement).dataset['eventId'] || '');
      const ev = this.events.find(e => e.id === eventId);
      if (!ev || !ev.properties) return;

      // Check if this event has stored briefing data (full CheckResult shape in properties)
      const hasCheckData = ev.properties
        && (ev.properties['l2_violations'] || ev.properties['passed'] !== undefined);
      if (!hasCheckData) return;

      // Mark as clickable
      el.classList.add('tl-event-clickable');
      el.addEventListener('click', (e) => {
        // Don't trigger on node/file link clicks
        const target = e.target as HTMLElement;
        if (target.closest('.tl-event-node-link') || target.closest('.tl-event-file')) return;
        e.stopPropagation();
        bus.emit('check:history', {
          checkData: ev.properties as unknown as CheckResult,
          timestamp: ev.timestamp,
        });
      });
    });
  }

  destroy(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.panel.remove();
  }
}

// ── Helpers ──

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function extractFilename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
