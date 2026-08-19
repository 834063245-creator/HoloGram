// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// BrowserActivityPanel — Agent 卡片下的浏览器活动折叠区（UI 审计展示，v1 最小形态）。
// 数据来自 Rust 侧 browser_audit（内存环形缓冲，最多 500 条，进程重启即失）。
// 薄层设计：独立文件 + 无新状态管理，前端将来重构时整体替换本文件即可。

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { typedRpc } from '../../rpc-contract';
import { useAgentPanelStore } from '../../ui/agent-panel-store';

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
  navigate: '导航',
  back: '后退',
  forward: '前进',
  reload: '刷新',
  click: '点击',
  hover: '悬停',
  type: '输入',
  select: '选择',
  upload: '上传文件',
  dialog: '处理对话框',
  press: '按键',
  scroll: '滚动',
  viewport: '设置视口',
  screenshot: '截图',
  eval: '执行脚本',
  new_tab: '新开标签',
  close_tab: '关闭标签',
  switch_session: '切换账号',
  cookies_set: '写入 Cookie',
  cookies_delete: '删除 Cookie',
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

  const refresh = useCallback(async () => {
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
  }, [agentId]);

  const toggle = () => {
    setExpanded((v) => !v);
  };

  // 展开期间每 5s 刷新，并在每次工具完成后立即刷新——活动面板不是静态历史。
  useEffect(() => {
    if (!expanded) return;
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    // P1c：订阅 agent-panel-store 的 toolDoneTick，替代 bus 'agent:tool-done'
    const unsub = useAgentPanelStore.subscribe((s, prev) => {
      if (s.toolDoneTick !== prev.toolDoneTick) void refresh();
    });
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [expanded, refresh]);

  return (
    <div className="ap-browser-activity">
      <button type="button" className="ap-browser-activity-row" onClick={toggle}>
        <span className="ap-browser-activity-title">浏览器活动</span>
        {entries !== null && <span className="ap-browser-activity-count">{entries.length}</span>}
        <span className="ap-agent-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="ap-browser-activity-list">
          {entries === null && <div className="ap-detail-text ap-detail-none">加载中…</div>}
          {entries !== null && entries.length === 0 && (
            <div className="ap-detail-text ap-detail-none">本会话无浏览器操作记录</div>
          )}
          {entries?.map((e) => (
            <div className="ap-browser-activity-item" key={JSON.stringify(e)}>
              <span className="ap-browser-activity-time">{fmtRelTime(e.ts)}</span>
              <span className="ap-browser-activity-action">{ACTION_LABEL[e.action] ?? e.action}</span>
              {e.target && <span className="ap-browser-activity-target">{e.target}</span>}
              {e.summary && e.summary !== 'ok' && <span className="ap-browser-activity-summary">{e.summary}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
