// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// TasksPanel — 主 Agent 待办清单面板（按会话/Agent 实例隔离）。
// 经 runtime.getAgentTaskManager(agentId) 拿到当前活跃会话主 Agent 专属的 TaskManager，
// 与 Agent 的 task_* 工具读写同一份 —— Agent 创建/变更待办，这里即时反映；
// 在这里手动新建/改态，Agent 在同一会话也能读到。
// 用 useSyncExternalStore 订阅 TaskManager 的变更（subscribe/getSnapshot）。

import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { agentSessionState } from '../../agent/agent-session-state';
import type { Task, TaskStatus } from '../../agent/task';
import { useCoreStore } from '../../app/chat/core-instance';
import { useAgentPanelStore } from '../agent-panel-store';
import { useDockStore } from '../dock-store';
import { iconHtml } from '../icons';
import { getSessionStore } from '../session-store';
import './TasksPanel.css';

const STATUS_META: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: '待办', cls: 'tp-pending' },
  in_progress: { label: '进行中', cls: 'tp-inprogress' },
  completed: { label: '完成', cls: 'tp-completed' },
  cancelled: { label: '已取消', cls: 'tp-cancelled' },
};

const CYCLE: TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

export function TasksPanel() {
  const open = useDockStore((s) => s.open.tasks);
  const closePanel = useDockStore((s) => s.closePanel);
  const core = useCoreStore((s) => s.core);
  const [agentId, setAgentId] = useState<string | null>(null);

  // 解析当前活跃会话的主 Agent 实例 id —— 会话切换 / Agent 重建时更新
  useEffect(() => {
    const resolve = () => {
      if (!core) {
        setAgentId(null);
        return;
      }
      const sess = getSessionStore(core.panelId).getState();
      const sid = sess.sessions[sess.activeIdx]?.id;
      const agent = sid != null ? agentSessionState.getAgent(core.panelId, sid) : null;
      setAgentId(agent?.id ?? null);
    };
    resolve();
    return core ? getSessionStore(core.panelId).subscribe(resolve) : undefined;
  }, [core]);

  // 经 runtime 拿到当前 Agent 专属 TaskManager；无 Agent / 无 runtime 时为 null
  const manager = useMemo(() => {
    if (!agentId) return null;
    const rt = useAgentPanelStore.getState().runtimeRef;
    return rt?.getAgentTaskManager?.(agentId) ?? null;
  }, [agentId]);

  // 订阅 TaskManager 变更 —— 无经理时用稳定的空快照
  const tasks = useSyncExternalStore(
    useCallback((cb: () => void) => (manager ? manager.subscribe(cb) : () => {}), [manager]),
    useCallback(() => (manager ? manager.getSnapshot() : ([] as Task[])), [manager]),
  );

  const [newTitle, setNewTitle] = useState('');
  const [newDetail, setNewDetail] = useState('');

  const addTask = useCallback(() => {
    const t = newTitle.trim();
    if (!t || !manager) return;
    manager.create(t, newDetail.trim() || '');
    setNewTitle('');
    setNewDetail('');
  }, [newTitle, newDetail, manager]);

  const cycleStatus = useCallback(
    (id: number, current: TaskStatus) => {
      manager?.update(id, { status: CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length] });
    },
    [manager],
  );

  const stopTask = useCallback(
    (id: number) => {
      manager?.stop(id);
    },
    [manager],
  );

  const count = tasks.length;
  const doneCount = tasks.filter((t) => t.status === 'completed').length;
  const createDisabled = !manager || !newTitle.trim();

  return (
    <div id="tasks-panel" className={open ? 'tp-open' : ''}>
      <div className="tp-tab">
        <span className="tp-tab-label"><span className="zh">待办</span>TASKS</span>
        {count > 0 && <span className="tp-count">{doneCount}/{count}</span>}
        <button className="tp-close-btn" dangerouslySetInnerHTML={{ __html: iconHtml('close', 16) }}
          onClick={(e) => { e.stopPropagation(); closePanel('tasks'); }} />
      </div>
      <div className="tp-content">
        <div className="tp-add">
          <input className="tp-add-title" placeholder="新待办…" value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }} />
          <input className="tp-add-detail" placeholder="详情（可选）" value={newDetail}
            onChange={(e) => setNewDetail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }} />
          <button className="tp-add-btn" disabled={createDisabled} onClick={addTask}>添加</button>
        </div>
        {!manager ? (
          <div className="tp-empty">当前会话暂无 Agent</div>
        ) : tasks.length === 0 ? (
          <div className="tp-empty">暂无待办</div>
        ) : (
          <ul className="tp-list">
            {tasks.map((t) => {
              const m = STATUS_META[t.status];
              return (
                <li key={t.id} className={'tp-item ' + m.cls}>
                  <button className="tp-status" title={'状态: ' + m.label + '（点按轮换）'}
                    onClick={() => cycleStatus(t.id, t.status)}>
                    <span className={'tp-dot ' + m.cls} />{m.label}
                  </button>
                  <div className="tp-body">
                    <div className="tp-title" title={t.detail}>{t.title}</div>
                    {t.detail && <div className="tp-detail">{t.detail}</div>}
                  </div>
                  {t.status === 'cancelled' ? null : (
                    <button className="tp-stop" title="取消"
                      dangerouslySetInnerHTML={{ __html: iconHtml('close', 12) }}
                      onClick={() => stopTask(t.id)} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
