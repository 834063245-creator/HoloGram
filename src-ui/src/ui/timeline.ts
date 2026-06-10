// Timeline Panel — 决策时间轴
// 消费 hologram_timeline 命令的输出，渲染事件时间线

import { invoke } from '../bridge';
import { bus } from './events';
import { iconHtml } from './icons';
import { askAgent } from './agent-visualizer';

export interface TimelineEvent {
  id: number;
  timestamp: string;
  event_type: string;
  file: string;
  changed_by: string;
  related_nodes: string[];
  summary: string;
  data_file_diff?: Record<string, unknown>;
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
};

const TYPE_LABELS: Record<string, string> = {
  file_changed: '文件变更',
  data_file_changed: '数据变更',
  commit: 'Commit',
  blindspot_detected: '边界检测',
  user_action: '用户操作',
};

export class TimelinePanel {
  private panel!: HTMLElement;
  private content!: HTMLElement;
  private tabStatus!: HTMLElement;
  private openState = false;
  private events: TimelineEvent[] = [];
  private loading = false;
  private path: string | null = null;
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

    // Tab (always visible at bottom left of status bar area)
    const tab = document.createElement('div');
    tab.className = 'tl-tab';
    tab.addEventListener('click', () => this.toggle());

    this.tabStatus = document.createElement('span');
    this.tabStatus.className = 'tl-tab-status';
    this.tabStatus.innerHTML = iconHtml('clock', 11);

    const label = document.createElement('span');
    label.className = 'tl-tab-label';
    label.textContent = '时间轴';

    const arrow = document.createElement('span');
    arrow.className = 'tl-tab-arrow';
    arrow.innerHTML = iconHtml('chevron-up', 9);

    tab.appendChild(this.tabStatus);
    tab.appendChild(label);
    tab.appendChild(arrow);

    // Close button inside tab bar (right-aligned)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tl-close';
    closeBtn.innerHTML = iconHtml('close', 11);
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    tab.appendChild(closeBtn);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'tl-content';

    this.panel.appendChild(tab);
    this.panel.appendChild(this.content);
    container.appendChild(this.panel);
  }

  // ── Public API ──

  setProjectPath(path: string | null): void {
    this.path = path;
    this.events = [];
    if (path) {
      this.refresh();
      // Auto-refresh every 30s
      if (this.refreshInterval) clearInterval(this.refreshInterval);
      this.refreshInterval = setInterval(() => this.refresh(), 30000);
    }
  }

  async refresh(): Promise<void> {
    if (!this.path || this.loading) return;
    this.loading = true;
    this.tabStatus.innerHTML = iconHtml('loading', 11);

    try {
      const json = await invoke<string>('hologram_timeline', {
        limit: 60,
        module: null as unknown as string,
        since: null as unknown as string,
      });
      const data = JSON.parse(json) as TimelineData;
      this.events = data.events || [];
      this.tabStatus.innerHTML = `${iconHtml('clock', 11)} ${this.events.length}`;
      if (this.openState) this.render();
    } catch (err) {
      console.error('Timeline refresh failed:', err);
      this.tabStatus.innerHTML = iconHtml('clock', 11);
    } finally {
      this.loading = false;
    }
  }

  toggle(): void {
    this.openState = !this.openState;
    if (this.openState) {
      this.panel.classList.add('tl-open');
      this.render();
    } else {
      this.panel.classList.remove('tl-open');
    }
    bus.emit('panel:toggle');
  }

  isOpen(): boolean { return this.openState; }

  close(): void {
    if (this.openState) this.toggle();
  }

  private render(): void {
    if (this.events.length === 0) {
      this.content.innerHTML = `<div class="tl-empty">暂无时间轴事件。开始编辑代码后，事件会自动记录。</div>`;
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

      html += `<div class="tl-event" data-event-id="${ev.id}" data-tl-file="${escapeHtml(ev.file || '')}" data-tl-summary="${escapeHtml(ev.summary || '')}" data-tl-type="${escapeHtml(label)}">`;
      html += `<div class="tl-event-dot"></div>`;
      html += `<div class="tl-event-body">`;
      html += `<div class="tl-event-header">`;
      html += `<span class="tl-event-icon">${icon}</span>`;
      html += `<span class="tl-event-type">${label}</span>`;
      if (file) html += `<span class="tl-event-file">${escapeHtml(file)}</span>`;
      html += `<button class="tl-ask-btn" title="问 Agent 关于这次变更">${iconHtml('agent', 10)}</button>`;
      html += `</div>`;
      if (ev.summary) html += `<div class="tl-event-summary">${escapeHtml(ev.summary)}</div>`;
      if (ev.changed_by) html += `<div class="tl-event-meta">${escapeHtml(ev.changed_by)}</div>`;
      if (ev.related_nodes && ev.related_nodes.length > 0) {
        const nodes = ev.related_nodes.slice(0, 3).map(n => {
          const short = n.split('.').pop() || n;
          return `<span class="tl-event-node-link" data-node="${escapeHtml(n)}">${escapeHtml(short)}</span>`;
        }).join(', ');
        const more = ev.related_nodes.length > 3 ? ` +${ev.related_nodes.length - 3}` : '';
        html += `<div class="tl-event-nodes">${nodes}${more}</div>`;
      }
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
          bus.emit('navigate:node', nodeName);
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
              const { FileViewer } = await import('./file-viewer');
              FileViewer.get().open(ev.file);
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

      // Check if this event has stored briefing data
      const violations = ev.properties['violations'] as Record<string, unknown> | undefined;
      if (!violations) return;

      // Mark as clickable
      el.classList.add('tl-event-clickable');
      el.addEventListener('click', (e) => {
        // Don't trigger on node/file link clicks
        const target = e.target as HTMLElement;
        if (target.closest('.tl-event-node-link') || target.closest('.tl-event-file')) return;
        e.stopPropagation();
        bus.emit('check:history', {
          checkData: violations,
          timestamp: ev.timestamp,
        });
      });
    });
  }

  destroy(): void {
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
