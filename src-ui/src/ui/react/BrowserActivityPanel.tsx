// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// BrowserActivityPanel — Agent 卡片下的浏览器活动折叠区（UI 审计展示，v1 最小形态）。
// 数据来自 Rust 侧 browser_audit（内存环形缓冲，最多 500 条，进程重启即失）。
// 薄层设计：独立文件 + 无新状态管理，前端将来重构时整体替换本文件即可。

import React, { useState } from 'react';
import { typedRpc } from '../../rpc-contract';

interface AuditEntry {
  ts: number; // Unix 秒
  agent: string;
  action: string;
  target: string;
  summary: string;
}

const ACTION_LABEL: Record<string, string> = {
  launch: '启动浏览器',
  connect: '连接实例',
  attach: '接管页面',
  click: '点击',
  type: '输入',
  press: '按键',
  scroll: '滚动',
  screenshot: '截图',
  eval: '执行脚本',
  kill: '断开连接',
};

function fmtRelTime(tsSec: number): string {
  const diff = Date.now() - tsSec * 1000;
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h 前`;
  return `${Math.floor(diff / 86_400_000)}d 前`;
}

export const BrowserActivityPanel: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || entries !== null) return; // 只拉一次，展开期间不刷新
    try {
      const raw = await typedRpc('browser_audit', { agent: agentId, limit: 20 });
      const parsed = JSON.parse(raw);
      const list: AuditEntry[] = (parsed.entries ?? [])
        .map((e: string) => {
          try {
            return JSON.parse(e) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e: AuditEntry | null): e is AuditEntry => e !== null);
      setEntries(list);
    } catch {
      setEntries([]);
    }
  };

  return (
    <div className="ap-browser-activity">
      <div className="ap-browser-activity-row" onClick={() => void toggle()}>
        <span className="ap-browser-activity-title">浏览器活动</span>
        {entries !== null && <span className="ap-browser-activity-count">{entries.length}</span>}
        <span className="ap-agent-chevron">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="ap-browser-activity-list">
          {entries === null && <div className="ap-detail-text ap-detail-none">加载中…</div>}
          {entries !== null && entries.length === 0 && (
            <div className="ap-detail-text ap-detail-none">本会话无浏览器操作记录</div>
          )}
          {entries?.map((e, i) => (
            <div className="ap-browser-activity-item" key={`${e.ts}-${i}`}>
              <span className="ap-browser-activity-time">{fmtRelTime(e.ts)}</span>
              <span className="ap-browser-activity-action">{ACTION_LABEL[e.action] ?? e.action}</span>
              {e.target && <span className="ap-browser-activity-target">{e.target}</span>}
              {e.summary && e.summary !== 'ok' && (
                <span className="ap-browser-activity-summary">{e.summary}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
