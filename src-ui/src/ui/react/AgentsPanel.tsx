// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentsPanel — 多 Agent 可观测性面板。
// 布局：状态总览条 + 标签页（拓扑 / 任务 / 动态）。

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { DiscoveryEntry } from '../../agent/discovery-board';
import type { AgentStatus, AgentSummary } from '../../agent/runtime/types';
import type { BoardEntry, BoardStatus } from '../../agent/task-board';
import {
  type AgentPanelEntry,
  type LifecycleAlert,
  type MessageFlowEntry,
  useAgentPanelStore,
} from '../agent-panel-store';
import { useDockStore } from '../dock-store';
import { bus } from '../events';
import { iconHtml } from '../icons';
import { BrowserActivityPanel } from './BrowserActivityPanel';
import './AgentsPanel.css';

// ── Helpers ──

function buildAgentTree(agents: AgentSummary[]): AgentPanelEntry[] {
  const map = new Map<string, AgentPanelEntry>();
  for (const a of agents) {
    map.set(a.id, { ...a, children: [] });
  }
  const roots: AgentPanelEntry[] = [];
  for (const a of agents) {
    const entry = map.get(a.id)!;
    if (a.parentId && map.has(a.parentId)) {
      map.get(a.parentId)!.children.push(entry);
    } else {
      roots.push(entry);
    }
  }
  return roots;
}

function fmtRelTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m < 60) return `${m}m${s > 0 ? `${s}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function payloadSummary(payload: unknown): string {
  if (typeof payload === 'string') return payload.slice(0, 120);
  try {
    return JSON.stringify(payload).slice(0, 120);
  } catch {
    return String(payload).slice(0, 120);
  }
}

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: '运行中',
  idle: '空闲',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  merged: '已合并',
};

// ── 拓扑：Agent 节点 ──

const AgentNode: React.FC<{ node: AgentPanelEntry }> = ({ node }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div className="ap-agent">
      <div className="ap-agent-card" onClick={() => hasChildren && setExpanded((e) => !e)}>
        <div className="ap-agent-top">
          <span className={`ap-dot ${node.status}`} />
          <span className="ap-agent-id" title={node.id}>
            {node.id}
          </span>
          <span className={`ap-status ${node.status}`}>{AGENT_STATUS_LABEL[node.status] ?? node.status}</span>
          {hasChildren && <span className="ap-agent-chevron">{expanded ? '▾' : '▸'}</span>}
        </div>
        {node.description && (
          <div className="ap-agent-desc" title={node.description}>
            {node.description}
          </div>
        )}
      </div>
      {expanded && hasChildren && (
        <div className="ap-agent-children">
          {node.children.map((child) => (
            <AgentNode key={child.id} node={child} />
          ))}
        </div>
      )}
      <BrowserActivityPanel agentId={node.id} />
    </div>
  );
};

// ── 任务：TaskBoard 卡片 ──

const TaskCard: React.FC<{ entry: BoardEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);
  const dur = fmtDuration((entry.finishedAt ?? Date.now()) - entry.startedAt);
  return (
    <div className="ap-task-card" onClick={() => setExpanded((e) => !e)}>
      <div className="ap-task-top">
        <span className={`ap-badge ${entry.status}`}>{BOARD_STATUS_LABEL[entry.status] ?? entry.status}</span>
        <span className="ap-task-desc" title={entry.description}>
          {entry.description}
        </span>
      </div>
      <div className="ap-task-meta">
        <span className="ap-task-agent">{entry.agentId}</span>
        <span className="ap-task-meta-sep">·</span>
        <span>{entry.filesTouched.length} 文件</span>
        <span className="ap-task-meta-sep">·</span>
        <span>{dur}</span>
        <span className="ap-task-time">{fmtRelTime(entry.startedAt)}</span>
      </div>
      {expanded && (
        <div className="ap-task-detail">
          {entry.summary && (
            <>
              <div className="ap-detail-label">摘要</div>
              <div className="ap-detail-text">{entry.summary}</div>
            </>
          )}
          {entry.filesTouched.length > 0 && (
            <>
              <div className="ap-detail-label">改动文件 ({entry.filesTouched.length})</div>
              <div className="ap-detail-text ap-detail-files">{entry.filesTouched.join('\n')}</div>
            </>
          )}
          {entry.diff && <div className="ap-detail-diff">{entry.diff}</div>}
          {!entry.summary && entry.filesTouched.length === 0 && !entry.diff && (
            <div className="ap-detail-text ap-detail-none">暂无详情</div>
          )}
        </div>
      )}
    </div>
  );
};

// ── 动态：统一时间线 ──

type FeedItem =
  | { kind: 'msg'; ts: number; entry: MessageFlowEntry }
  | { kind: 'discovery'; ts: number; entry: DiscoveryEntry }
  | { kind: 'alert'; ts: number; entry: LifecycleAlert };

const FEED_ICON: Record<FeedItem['kind'], string> = {
  msg: 'send',
  discovery: 'info',
  alert: 'alert',
};

const FeedRow: React.FC<{ item: FeedItem }> = ({ item }) => {
  let head: React.ReactNode;
  let text: string;
  let level = '';
  if (item.kind === 'msg') {
    const m = item.entry.msg;
    head = (
      <>
        <span className="ap-feed-who">{m.from}</span>
        <span className="ap-feed-arrow">→</span>
        <span className="ap-feed-who">{m.to}</span>
        <span className="ap-feed-type">{m.type}</span>
      </>
    );
    text = payloadSummary(m.payload);
  } else if (item.kind === 'discovery') {
    const d = item.entry;
    head = (
      <>
        <span className="ap-feed-who">{d.agentId}</span>
        <span className="ap-feed-type">{d.category}</span>
      </>
    );
    text = `${d.key}: ${d.value}`;
  } else {
    const a = item.entry;
    head = <span className="ap-feed-who">生命周期</span>;
    text = a.text;
    level = a.level;
  }
  return (
    <div className={`ap-feed-item ${item.kind}${level ? ` ${level}` : ''}`}>
      <span className="ap-feed-icon" dangerouslySetInnerHTML={{ __html: iconHtml(FEED_ICON[item.kind], 11) }} />
      <div className="ap-feed-body">
        <div className="ap-feed-head">{head}</div>
        <div className="ap-feed-text" title={text}>
          {text}
        </div>
      </div>
      <span className="ap-feed-time">{fmtRelTime(item.ts)}</span>
    </div>
  );
};

// ── Main Component ──

type TabId = 'topology' | 'tasks' | 'feed';

export function AgentsPanel() {
  const open = useDockStore((s) => s.open.agents);
  const closePanel = useDockStore((s) => s.closePanel);
  const agents = useAgentPanelStore((s) => s.agents);
  const taskBoard = useAgentPanelStore((s) => s.taskBoard);
  const discoveries = useAgentPanelStore((s) => s.discoveries);
  const messageFlow = useAgentPanelStore((s) => s.messageFlow);
  const alerts = useAgentPanelStore((s) => s.alerts);

  const [tab, setTab] = useState<TabId>('topology');

  // Data refresh: mount + bus listener + 2s polling
  useEffect(() => {
    if (!open) return;

    const doRefresh = () => {
      const rt = useAgentPanelStore.getState().runtimeRef;
      if (rt) useAgentPanelStore.getState().refresh(rt);
    };

    doRefresh();

    const onStatus = () => doRefresh();
    bus.on('agent:status', onStatus);

    const timer = setInterval(doRefresh, 2000);

    return () => {
      bus.off('agent:status', onStatus);
      clearInterval(timer);
    };
  }, [open]);

  const tree = useMemo(() => buildAgentTree(agents), [agents]);

  // 状态统计：运行中 / 空闲 / 已完成 / 异常(失败+停止)
  const stats = useMemo(() => {
    let running = 0,
      idle = 0,
      completed = 0,
      bad = 0;
    for (const a of agents) {
      if (a.status === 'running') running++;
      else if (a.status === 'idle' || a.status === 'paused') idle++;
      else if (a.status === 'completed') completed++;
      else bad++;
    }
    return { running, idle, completed, bad };
  }, [agents]);

  // 任务排序：运行中优先，其余按开始时间倒序
  const sortedTasks = useMemo(() => {
    const rank = (s: BoardStatus) => (s === 'running' ? 0 : s === 'failed' ? 1 : 2);
    return [...taskBoard].sort((a, b) => rank(a.status) - rank(b.status) || b.startedAt - a.startedAt);
  }, [taskBoard]);

  // 动态流：消息 + 发现 + 告警，按时间倒序
  const feed = useMemo(() => {
    const items: FeedItem[] = [
      ...messageFlow.map((entry): FeedItem => ({ kind: 'msg', ts: entry.ts, entry })),
      ...discoveries.map((entry): FeedItem => ({ kind: 'discovery', ts: entry.ts, entry })),
      ...alerts.map((entry): FeedItem => ({ kind: 'alert', ts: entry.ts, entry })),
    ];
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, 40);
  }, [messageFlow, discoveries, alerts]);

  const hasWarnAlert = alerts.some((a) => a.level === 'warn');

  return (
    <div id="agents-panel" className={open ? 'ap-open' : ''}>
      {/* Header */}
      <div className="ap-tab">
        <span className="ap-tab-icon" dangerouslySetInnerHTML={{ __html: iconHtml('agent', 14) }} />
        <span className="ap-tab-label">
          <span className="zh">智能体</span>AGENTS
        </span>
        <button
          className="ap-close-btn"
          dangerouslySetInnerHTML={{ __html: iconHtml('close', 16) }}
          onClick={(e) => {
            e.stopPropagation();
            closePanel('agents');
          }}
        />
      </div>

      {/* 状态总览 */}
      <div className="ap-stats">
        <div className="ap-stat">
          <span className="ap-dot running" />
          <span className="ap-stat-num">{stats.running}</span>
          <span className="ap-stat-label">运行中</span>
        </div>
        <div className="ap-stat">
          <span className="ap-dot idle" />
          <span className="ap-stat-num">{stats.idle}</span>
          <span className="ap-stat-label">空闲</span>
        </div>
        <div className="ap-stat">
          <span className="ap-dot completed" />
          <span className="ap-stat-num">{stats.completed}</span>
          <span className="ap-stat-label">已完成</span>
        </div>
        <div className="ap-stat">
          <span className="ap-dot failed" />
          <span className="ap-stat-num">{stats.bad}</span>
          <span className="ap-stat-label">异常</span>
        </div>
      </div>

      {/* 标签页 */}
      <div className="ap-tabs">
        <button className={`ap-tab-btn${tab === 'topology' ? ' active' : ''}`} onClick={() => setTab('topology')}>
          拓扑<span className="ap-tab-count">{agents.length}</span>
        </button>
        <button className={`ap-tab-btn${tab === 'tasks' ? ' active' : ''}`} onClick={() => setTab('tasks')}>
          任务<span className="ap-tab-count">{taskBoard.length}</span>
        </button>
        <button className={`ap-tab-btn${tab === 'feed' ? ' active' : ''}`} onClick={() => setTab('feed')}>
          动态<span className="ap-tab-count">{feed.length}</span>
          {hasWarnAlert && <span className="ap-tab-dot" />}
        </button>
      </div>

      {/* 内容 */}
      <div className="ap-content">
        {tab === 'topology' &&
          (tree.length === 0 ? (
            <div className="ap-empty">无活跃 Agent</div>
          ) : (
            tree.map((node) => <AgentNode key={node.id} node={node} />)
          ))}

        {tab === 'tasks' &&
          (sortedTasks.length === 0 ? (
            <div className="ap-empty">无任务记录</div>
          ) : (
            sortedTasks.map((entry) => <TaskCard key={entry.agentId} entry={entry} />)
          ))}

        {tab === 'feed' &&
          (feed.length === 0 ? (
            <div className="ap-empty">暂无动态</div>
          ) : (
            feed.map((item, i) => <FeedRow key={`${item.kind}-${item.ts}-${i}`} item={item} />)
          ))}
      </div>
    </div>
  );
}
