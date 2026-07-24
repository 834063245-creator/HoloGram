// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentsPanel — 多 Agent 可观测性面板。
// 三个区域：Agent 树 / TaskBoard 视图 / 消息流 + 告警。
// 参照 CheckPanel.tsx 的结构。

import React, { useEffect, useState } from 'react';
import { useDockStore } from '../dock-store';
import { useAgentPanelStore, type AgentPanelEntry } from '../agent-panel-store';
import type { AgentSummary } from '../../agent/runtime/types';
import type { BoardEntry } from '../../agent/task-board';
import { bus } from '../events';
import { iconHtml } from '../icons';
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
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function payloadSummary(payload: unknown): string {
  if (typeof payload === 'string') return payload.slice(0, 80);
  try {
    return JSON.stringify(payload).slice(0, 80);
  } catch {
    return String(payload).slice(0, 80);
  }
}

// ── Agent tree node ──

const AgentTreeNode: React.FC<{ node: AgentPanelEntry; depth: number }> = ({ node, depth }) => {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        className="ap-agent-node"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className={`ap-agent-dot ${node.status}`} />
        <span className="ap-agent-id">{node.id}</span>
        {hasChildren && (
          <span style={{ color: 'var(--obs-text-2)', fontSize: '10px', cursor: 'pointer' }}>
            {expanded ? '▾' : '▸'}
          </span>
        )}
        <span className="ap-agent-desc">{node.description}</span>
      </div>
      {expanded && hasChildren && (
        <div className="ap-agent-children">
          {node.children.map((child) => (
            <AgentTreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

// ── TaskBoard row ──

const TaskBoardRow: React.FC<{ entry: BoardEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="ap-tb-row" onClick={() => setExpanded((e) => !e)}>
        <td>{entry.agentId}</td>
        <td style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.description}
        </td>
        <td>
          <span className={`ap-tb-badge ${entry.status}`}>{entry.status}</span>
        </td>
        <td style={{ textAlign: 'right' }}>{entry.filesTouched.length}</td>
        <td style={{ fontSize: '9px', color: 'var(--obs-text-2)' }}>{fmtRelTime(entry.startedAt)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5}>
            <div className="ap-tb-detail">
              {entry.summary && (
                <>
                  <div className="ap-tb-detail-label">Summary</div>
                  <div className="ap-tb-detail-text">{entry.summary}</div>
                </>
              )}
              {entry.filesTouched.length > 0 && (
                <>
                  <div className="ap-tb-detail-label" style={{ marginTop: '6px' }}>Files ({entry.filesTouched.length})</div>
                  <div className="ap-tb-detail-text">{entry.filesTouched.join('\n')}</div>
                </>
              )}
              {entry.diff && (
                <div className="ap-tb-diff">{entry.diff}</div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

// ── Collapsible section ──

const Section: React.FC<{
  title: string;
  count: string;
  startOpen: boolean;
  children: React.ReactNode;
}> = ({ title, count, startOpen, children }) => {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className="ap-section">
      <div className="ap-section-head" onClick={() => setOpen((o) => !o)}>
        <span className="ap-section-arrow">{open ? '▾' : '▸'}</span>
        <span className="ap-section-label">{title}</span>
        {count && <span className="ap-section-badge">{count}</span>}
      </div>
      <div className={`ap-section-body${open ? '' : ' collapsed'}`}>{children}</div>
    </div>
  );
};

// ── Main Component ──

export function AgentsPanel() {
  const open = useDockStore((s) => s.open.agents);
  const closePanel = useDockStore((s) => s.closePanel);
  const agents = useAgentPanelStore((s) => s.agents);
  const taskBoard = useAgentPanelStore((s) => s.taskBoard);
  const messageFlow = useAgentPanelStore((s) => s.messageFlow);
  const alerts = useAgentPanelStore((s) => s.alerts);

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

  const tree = buildAgentTree(agents);
  const recentMsgs = messageFlow.slice(-20);
  const recentAlerts = alerts.slice(-5);

  return (
    <div id="agents-panel" className={open ? 'ap-open' : ''}>
      {/* Header */}
      <div className="ap-tab">
        <span
          className="ap-tab-icon"
          dangerouslySetInnerHTML={{ __html: iconHtml('agent', 14) }}
        />
        <span className="ap-tab-label"><span className="zh">智能体</span>AGENTS</span>
        <button
          className="ap-close-btn"
          dangerouslySetInnerHTML={{ __html: iconHtml('close', 16) }}
          onClick={(e) => {
            e.stopPropagation();
            closePanel('agents');
          }}
        />
      </div>

      {/* Content */}
      <div className="ap-content">
        {/* ── Agent tree ── */}
        <Section title="Agent 拓扑" count={String(agents.length)} startOpen={true}>
          {tree.length === 0 ? (
            <div className="ap-empty">无活跃 Agent</div>
          ) : (
            tree.map((node) => <AgentTreeNode key={node.id} node={node} depth={0} />)
          )}
        </Section>

        {/* ── TaskBoard ── */}
        <Section title="TaskBoard" count={String(taskBoard.length)} startOpen={true}>
          {taskBoard.length === 0 ? (
            <div className="ap-empty">无任务记录</div>
          ) : (
            <table className="ap-tb-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>描述</th>
                  <th>状态</th>
                  <th style={{ textAlign: 'right' }}>文件</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {taskBoard.map((entry) => (
                  <TaskBoardRow key={entry.agentId} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {/* ── Message flow ── */}
        <Section title="消息流" count={String(recentMsgs.length)} startOpen={false}>
          {recentMsgs.length === 0 ? (
            <div className="ap-empty">无消息</div>
          ) : (
            recentMsgs.map((m, i) => (
              <div key={i} className="ap-msg-item">
                <span className="ap-msg-from">{m.msg.from}</span>
                <span className="ap-msg-arrow">→</span>
                <span className="ap-msg-to">{m.msg.to}</span>
                <span className="ap-msg-type">[{m.msg.type}]</span>
                <span className="ap-msg-payload">{payloadSummary(m.msg.payload)}</span>
              </div>
            ))
          )}
        </Section>

        {/* ── Alerts ── */}
        {recentAlerts.length > 0 && (
          <Section title="告警" count={String(recentAlerts.length)} startOpen={false}>
            {recentAlerts.map((alert) => (
              <div key={alert.id} className={`ap-alert ${alert.level}`}>
                <span className="ap-alert-text">{alert.text}</span>
                <span className="ap-alert-time">{fmtRelTime(alert.ts)}</span>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
