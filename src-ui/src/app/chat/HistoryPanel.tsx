// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P2′：历史会话面板（React 版，替代 chat-dom 的 vanilla 浮层）。
// 经 ChatBeacon 的 portal 挂到 body；打开时载入：内存中当前会话 + 磁盘存档。

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import * as Session from '../../ui/chat-session';
import { getChatStore } from '../../ui/chat-store';
import type { ChatCore } from './chat-core';

interface DiskSession {
  id: number;
  label: string;
  msgCount: number;
  savedAt: string;
}

export function HistoryPanel({ core }: { core: ChatCore }) {
  const { panel, sess } = getChatStore(core.panelId);
  const sessions = useStore(sess, (s) => s.sessions);
  const activeIdx = useStore(sess, (s) => s.activeIdx);
  const projectPath = useStore(panel, (s) => s.projectPath);
  const [disk, setDisk] = useState<DiskSession[] | null>(null);

  // 打开时加载磁盘存档（15s 超时，与旧版一致）
  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
    Promise.race([core.listSavedSessions(projectPath), timeout])
      .then((list) => {
        if (alive) setDisk(list);
      })
      .catch(() => {
        if (alive) setDisk([]);
      });
    return () => {
      alive = false;
    };
  }, [core, projectPath]);

  const close = () => core.closeHistory();
  const full = Session.getSessions(core.panelId);

  return (
    <>
      <button type="button" className="chat-history-backdrop" aria-label="关闭历史面板" onClick={close} />
      <div className="chat-history-panel">
        <div className="chat-history-panel-header">
          <span className="chat-history-panel-title">历史会话</span>
          <button type="button" className="chat-history-panel-close" title="关闭" onClick={close}>
            ×
          </button>
        </div>
        <div className="chat-history-panel-list">
          {sessions.length > 0 ? (
            <>
              <div className="chat-history-section">当前打开 ({sessions.length})</div>
              {sessions.map((s, i) => {
                const msgCount = full[i]?.agent?.getSession?.().filter((m) => m.role !== 'system').length ?? 0;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`chat-history-entry${i === activeIdx ? ' active' : ''}`}
                    onClick={() => {
                      if (i !== activeIdx) core.switchSession(i);
                      close();
                    }}
                  >
                    <div className="chat-history-entry-title">{s.label}</div>
                    <div className="chat-history-entry-sub">消息: {msgCount}</div>
                  </button>
                );
              })}
            </>
          ) : null}
          {projectPath ? (
            <>
              <div className="chat-history-section">磁盘存档</div>
              {disk === null ? <div className="chat-history-entry">加载中…</div> : null}
              {disk !== null && disk.length === 0 ? <div className="chat-history-entry">暂无存档</div> : null}
              {disk?.map((s) => {
                const already = sessions.findIndex((t) => t.id === s.id);
                return (
                  <div
                    key={s.id}
                    className={`chat-history-entry-wrap${already >= 0 && already === activeIdx ? ' active' : ''}`}
                  >
                    <button
                      type="button"
                      className={`chat-history-entry${already >= 0 && already === activeIdx ? ' active' : ''}`}
                      onClick={() => {
                        close();
                        if (already >= 0) core.switchSession(already);
                        else core.loadSessionFromDisk(projectPath, s.id);
                      }}
                    >
                      <div className="chat-history-entry-title">{s.label}</div>
                      <div className="chat-history-entry-sub">
                        {s.msgCount} 条消息{s.savedAt ? ` · ${new Date(s.savedAt).toLocaleString('zh-CN')}` : ''}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="chat-history-del"
                      title="删除此会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`删除会话 "${s.label}"？`)) {
                          core.deleteSessionFile(projectPath, s.id);
                          setDisk((d) => d?.filter((x) => x.id !== s.id) ?? null);
                        }
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
