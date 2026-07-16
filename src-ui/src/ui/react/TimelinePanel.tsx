// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Timeline Panel — React 重写
// 替代 timeline.ts 中的纯 DOM 操作。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { rpc } from '../../bridge';
import { askAgent } from '../agent-visualizer';
import { shell } from '../app-shell';
import type { CheckResult } from '../check';
import { bus } from '../events';
import { iconHtml } from '../icons';

// ── Types ──

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

// ── Constants ──

const TYPE_ICONS: Record<string, string> = {
  agent_write: iconHtml('save', 10),
  agent_edit: iconHtml('edit', 10),
  agent_delete: iconHtml('trash', 10),
  agent_rename: iconHtml('edit', 10),
  agent_move: iconHtml('edit', 10),
  file_changed: iconHtml('edit', 10),
  data_file_changed: iconHtml('save', 10),
  commit: iconHtml('bookmark', 10),
  blindspot_detected: iconHtml('alert', 10),
  user_action: iconHtml('user', 10),
  commit_violation: iconHtml('alert', 10),
  commit_clean: iconHtml('check-circle', 10),
  check: iconHtml('chart', 10),
  analyze: iconHtml('refresh', 10),
  incremental_update: iconHtml('refresh', 10),
  incremental_fallback: iconHtml('alert', 10),
  watcher_full_reanalyze: iconHtml('refresh', 10),
};

const TYPE_LABELS: Record<string, string> = {
  agent_write: '写入',
  agent_edit: '编辑',
  agent_delete: '删除',
  agent_rename: '重命名',
  agent_move: '移动',
  file_changed: '文件变更',
  data_file_changed: '数据变更',
  commit: 'Commit',
  blindspot_detected: '边界检测',
  user_action: '用户操作',
  commit_violation: '变更风险',
  commit_clean: '变更通过',
  check: '简报',
  analyze: '重分析',
  incremental_update: '增量更新',
  incremental_fallback: '增量回退',
  watcher_full_reanalyze: '全量重分析',
};

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
function extractFilename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// ── React Component ──

function TimelineApp({
  projectPath,
  toggleRef,
}: {
  projectPath: string | null;
  toggleRef: { current: (() => void) | null };
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  toggleRef.current = () => {
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    panelRef.current?.classList.toggle('tl-open', open);
    shell.notifyPanelChanged();
  }, [open]);

  const refresh = useCallback(async () => {
    if (!projectPath || loading) return;
    setLoading(true);
    try {
      const json = await Promise.race([
        rpc<string>('hologram_call', { tool: 'project_timeline', args: { limit: 60 } }),
        new Promise<string>((_, r) => setTimeout(() => r(new Error('timeout')), 8000)),
      ]);
      setEvents((JSON.parse(json) as TimelineData).events || []);
    } catch {
      /* keep old events */
    } finally {
      setLoading(false);
    }
  }, [projectPath, loading]);

  const prevPath = useRef(projectPath);
  useEffect(() => {
    if (projectPath && projectPath !== prevPath.current) {
      prevPath.current = projectPath;
      setEvents([]);
      refresh();
    }
  }, [projectPath, refresh]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const h = () => {
      clearTimeout(t);
      t = setTimeout(refresh, 600);
    };
    bus.on('timeline:refresh', h);
    return () => {
      bus.off('timeline:refresh', h);
      clearTimeout(t);
    };
  }, [refresh]);

  // Auto-refresh when opened with empty events
  useEffect(() => {
    if (open && events.length === 0 && !loading) refresh();
  }, [open]);

  const handleFileClick = useCallback(
    async (f: string) => {
      if (!projectPath) return;
      for (const ev of events) {
        if (ev.file?.endsWith(f)) {
          try {
            const { FileViewer } = await import('../file-viewer');
            FileViewer.get().open(ev.file);
          } catch {}
          break;
        }
      }
    },
    [projectPath, events],
  );

  const handleChipClick = useCallback(
    (rp: string) => {
      if (!projectPath) return;
      shell.navigateToFile(projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + rp);
    },
    [projectPath],
  );

  // ── Render ──

  let body: React.ReactNode;
  if (loading && events.length === 0) {
    body = (
      <div className="tl-empty">
        <span className="tl-spinner"></span> 加载中…
      </div>
    );
  } else if (events.length === 0) {
    body = <div className="tl-empty">暂无时间轴事件。开始编辑代码后，事件会自动记录。</div>;
  } else {
    let lastMinute = '';
    body = (
      <div className="tl-timeline">
        {events.map((ev) => {
          const ts = ev.timestamp ? formatTimestamp(ev.timestamp) : '';
          const sameMinute = lastMinute === ts;
          lastMinute = ts;
          const isCheck =
            ev.event_type === 'commit_violation' || ev.event_type === 'commit_clean' || ev.event_type === 'check';
          const checkPassed = ev.properties?.['passed'] !== false;
          const hasVio = ev.properties && (ev.properties['l2_violations'] || ev.properties['passed'] !== undefined);
          const filesProp = ev.properties?.['files'];

          return (
            <React.Fragment key={ev.id}>
              {!sameMinute && (
                <div className="tl-time-divider">
                  <span>{ts}</span>
                </div>
              )}
              <div
                className={`tl-event${isCheck ? ' tl-event-check' : ''}${isCheck && !checkPassed ? ' tl-event-fail' : ''}${hasVio ? ' tl-event-clickable' : ''}`}
                onClick={
                  hasVio
                    ? () =>
                        bus.emit('check:history', {
                          checkData: ev.properties as unknown as CheckResult,
                          timestamp: ev.timestamp,
                        })
                    : undefined
                }
              >
                <div className={`tl-event-dot${isCheck ? (checkPassed ? ' tl-dot-pass' : ' tl-dot-fail') : ''}`}></div>
                <div className="tl-event-body">
                  <div className="tl-event-header">
                    <span
                      className="tl-event-icon"
                      dangerouslySetInnerHTML={{ __html: TYPE_ICONS[ev.event_type] || '📌' }}
                    />
                    <span className="tl-event-type">{TYPE_LABELS[ev.event_type] || ev.event_type}</span>
                    {ev.file && (
                      <span
                        className="tl-event-file"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFileClick(extractFilename(ev.file));
                        }}
                      >
                        {extractFilename(ev.file)}
                      </span>
                    )}
                    <button
                      className="tl-ask-btn"
                      title="问 Agent 关于这次变更"
                      onClick={(e) => {
                        e.stopPropagation();
                        const ctx = [
                          `[${TYPE_LABELS[ev.event_type] || '变更'}]`,
                          ev.file ? `文件: ${ev.file}` : '',
                          ev.summary ? `摘要: ${ev.summary}` : '',
                        ]
                          .filter(Boolean)
                          .join(' | ');
                        askAgent(`分析这次变更: ${ctx}`);
                      }}
                      dangerouslySetInnerHTML={{ __html: iconHtml('agent', 10) }}
                    />
                  </div>
                  {ev.summary && (
                    <div className="tl-event-summary">
                      {ev.summary}
                      {isCheck && (
                        <span
                          className={`tl-check-badge ${checkPassed ? 'tl-check-badge-pass' : 'tl-check-badge-fail'}`}
                        >
                          {checkPassed ? '✓ 通过' : '✗ 未通过'}
                        </span>
                      )}
                    </div>
                  )}
                  {Array.isArray(filesProp) && filesProp.length > 0 && (
                    <div className="tl-event-files">
                      {(filesProp as string[]).map((entry, i) => {
                        const m = entry.match(/^(.+?)\s+\(([^)]+)\)$/);
                        return (
                          <span
                            key={i}
                            className="tl-file-chip"
                            title={entry}
                            onClick={() => handleChipClick(m ? m[1] : entry)}
                          >
                            {m ? m[1] : entry}
                            <span className="tl-file-chip-action">{m ? m[2] : ''}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <div id="timeline-panel" ref={panelRef}>
      <div className="corner-brackets">
        <span className="cb-bottom left"></span>
        <span className="cb-bottom right"></span>
      </div>
      <div className="tl-header">
        <span className="tl-title">时间轴</span>
        <button className="tl-close" onClick={toggleRef.current}>
          &#x2715;
        </button>
      </div>
      <div className="tl-content">{body}</div>
    </div>
  );
}

// ── Thin class wrapper — same public API as old TimelinePanel ──

export class TimelinePanel {
  private _root: Root;
  private _mount: HTMLElement;
  private _path: string | null = null;
  private _toggleRef: { current: (() => void) | null } = { current: null };

  constructor(container: HTMLElement) {
    this._mount = document.createElement('div');
    container.appendChild(this._mount);
    this._root = createRoot(this._mount);
    this._render();
  }

  private _render(): void {
    this._root.render(React.createElement(TimelineApp, { projectPath: this._path, toggleRef: this._toggleRef }));
  }

  setProjectPath(path: string | null): void {
    this._path = path;
    this._render();
  }

  toggle(): void {
    this._toggleRef.current?.();
  }
  isOpen(): boolean {
    return this._mount.querySelector('#timeline-panel')?.classList.contains('tl-open') ?? false;
  }

  close(): void {
    if (this.isOpen()) {
      this._toggleRef.current?.();
    }
  }

  destroy(): void {
    this._root.unmount();
    this._mount.remove();
  }
}
