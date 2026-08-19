// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 脉冲点阵 · 时间轴 HUD（P15）
// 左侧边缘一串发光点，和星图同语言。
// 大点 = 重要事件（始终有标签），小点 = 普通（hover 才展开）。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { typedRpc } from '../rpc-contract';
import { useTimelineStore } from '../state/timeline-store';
import { askAgent } from '../ui/agent-visualizer';
import { shell } from '../ui/app-shell';
import { iconHtml } from '../ui/icons';
import { useShellStore } from './shell-store';

interface TimelineEvent {
  id: number;
  timestamp: string;
  event_type: string;
  file: string;
  summary: string;
  properties?: Record<string, unknown>;
}

// kind: info / pass / fail / warn / brass
// size: major (commit/violation/check) / minor (everything else)
const TYPE_META: Record<string, { label: string; kind: string; size: 'major' | 'minor' }> = {
  agent_write: { label: '写入', kind: 'info', size: 'minor' },
  agent_edit: { label: '编辑', kind: 'info', size: 'minor' },
  agent_delete: { label: '删除', kind: 'info', size: 'minor' },
  agent_rename: { label: '重命名', kind: 'info', size: 'minor' },
  agent_move: { label: '移动', kind: 'info', size: 'minor' },
  file_changed: { label: '外部变更', kind: 'info', size: 'minor' },
  data_file_changed: { label: '数据变更', kind: 'info', size: 'minor' },
  commit: { label: 'Commit', kind: 'brass', size: 'major' },
  commit_violation: { label: '风险', kind: 'fail', size: 'major' },
  commit_clean: { label: '通过', kind: 'pass', size: 'major' },
  check: { label: '简报', kind: 'info', size: 'major' },
  analyze: { label: '重分析', kind: 'info', size: 'minor' },
  incremental_update: { label: '增量', kind: 'info', size: 'minor' },
  incremental_fallback: { label: '回退', kind: 'warn', size: 'minor' },
  watcher_full_reanalyze: { label: '全量', kind: 'info', size: 'minor' },
  blindspot_detected: { label: '边界', kind: 'warn', size: 'major' },
  user_action: { label: '操作', kind: 'info', size: 'minor' },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

export function TimelineHUD() {
  const projectPath = useShellStore((s) => s.projectPath);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const prevPath = useRef(projectPath);
  // P0-8：空时间轴重试计数——无事件的项目不得无限热循环轰击引擎
  const emptyRetries = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectPath || loading) return;
    setLoading(true);
    try {
      const json = await Promise.race([
        typedRpc('hologram_call', { tool: 'project_timeline', args: { limit: 40 } }),
        new Promise<string>((_, r) => setTimeout(() => r(new Error('timeout')), 8000)),
      ]);
      setEvents((JSON.parse(json) as { events: TimelineEvent[] }).events || []);
    } catch {
      /* keep old events */
    } finally {
      setLoading(false);
    }
  }, [projectPath, loading]);

  useEffect(() => {
    if (projectPath && projectPath !== prevPath.current) {
      prevPath.current = projectPath;
      emptyRetries.current = 0;
      setEvents([]);
      refresh();
    } else if (projectPath && events.length === 0 && !loading && emptyRetries.current < 4) {
      // 空结果退避重试（0s/2s/4s/6s，首次立即），最多 4 次——此前这里是无退避
      // 无上限的 IPC 热循环，速度=IPC 往返速度，永久轰击引擎（雷区地图 P0-8）
      const attempt = emptyRetries.current++;
      const t = setTimeout(refresh, 2000 * attempt);
      return () => clearTimeout(t);
    }
  }, [projectPath, refresh, loading, events.length]);

  // P1d：订阅 timeline-store 的 refreshTick（workspace 递增），替代 bus 'timeline:refresh'
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const unsub = useTimelineStore.subscribe((s, prev) => {
      if (s.refreshTick === prev.refreshTick) return;
      clearTimeout(t);
      t = setTimeout(refresh, 600);
    });
    return () => {
      unsub();
      clearTimeout(t);
    };
  }, [refresh]);

  let lastMinute = '';

  return (
    <div id="timeline-hud">
      <div className="th-rail" />
      {loading && events.length === 0 && (
        <div className="th-status">
          <span className="th-spinner" />
        </div>
      )}
      {!loading && events.length === 0 && <div className="th-status">·</div>}
      {events.map((ev) => {
        const ts = ev.timestamp ? formatTime(ev.timestamp) : '';
        const sameMinute = lastMinute === ts;
        lastMinute = ts;
        const meta = TYPE_META[ev.event_type] || { label: ev.event_type, kind: 'info', size: 'minor' as const };
        const isCheck =
          ev.event_type === 'commit_violation' || ev.event_type === 'commit_clean' || ev.event_type === 'check';
        const checkPassed = ev.properties?.passed !== false;
        const dotKind = checkPassed && isCheck ? 'pass' : meta.kind;
        const filesProp = ev.properties?.files as string[] | undefined;
        const isHovered = hoveredId === ev.id;
        const isMajor = meta.size === 'major';

        return (
          <React.Fragment key={ev.id}>
            {!sameMinute && <div className="th-time">{ts}</div>}
            <div
              className={`th-pt th-pt-${meta.size}${isHovered ? ' th-pt-active' : ''}`}
              onMouseEnter={() => setHoveredId(ev.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <span className={`th-glow th-glow-${dotKind}`} />
              <span className={`th-core th-core-${dotKind}`} />
              {isMajor && <span className={`th-tag th-tag-${meta.kind}`}>{meta.label}</span>}
              {isHovered && (
                <div className="th-bubble">
                  <div className="th-bubble-head">
                    <span className={`th-bubble-kind th-bubble-kind-${meta.kind}`}>{meta.label}</span>
                    <span className="th-bubble-time">{ts}</span>
                  </div>
                  {ev.summary && <div className="th-bubble-summary">{ev.summary}</div>}
                  <div className="th-bubble-actions">
                    {ev.file && (
                      <span className="th-bubble-file" onClick={() => shell.navigateToFile(ev.file)}>
                        {basename(ev.file)}
                      </span>
                    )}
                    {Array.isArray(filesProp) && filesProp.length > 0 && (
                      <span className="th-bubble-files">{filesProp.length} 文件</span>
                    )}
                    <button
                      className="th-bubble-ask"
                      onClick={() => {
                        const ctx = [
                          `[${meta.label}]`,
                          ev.file ? `文件: ${ev.file}` : '',
                          ev.summary ? `摘要: ${ev.summary}` : '',
                        ]
                          .filter(Boolean)
                          .join(' | ');
                        askAgent(`分析这次变更: ${ctx}`);
                      }}
                      dangerouslySetInnerHTML={{ __html: iconHtml('agent', 11) }}
                    />
                  </div>
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
