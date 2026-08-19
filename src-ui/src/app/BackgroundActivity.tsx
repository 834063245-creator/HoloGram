// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// BackgroundActivity — 底部状态栏「后台活动」胶囊。
// 只回答一个问题：Agent 现在在后台跑着什么？
//   - Shell 后台任务（Rust BG_JOBS 快照）
//   - 浏览器会话（受控 launch / 外部 connect，跨 agent slot）
//   - 运行中的子 Agent（前端 runtime 列表 + subagent-activity 当前工具）
// 无任何后台活动时不渲染；有活动时出现一个小胶囊，点开看明细。
// 刻意不做操作按钮（kill/查看输出）——监控与审计面板各司其职，避免变成
// 第二个任务管理器。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSubAgentActivity, STUCK_THRESHOLD_S } from '../agent/subagent-activity';
import { typedRpc } from '../rpc-contract';
import { useAgentPanelStore } from '../ui/agent-panel-store';
import './BackgroundActivity.css';

interface ShellActivity {
  jobId: number;
  label: string;
  agent: string | null;
  elapsedSecs: number;
  stalled: boolean;
}

interface BrowserActivity {
  agent: string;
  slot: string;
  port: number;
  chromeRunning: boolean;
  external: boolean;
  attached: boolean;
  headless: boolean | null;
  proxy: string | null;
  elapsedSecs: number;
}

interface SubAgentActivityView {
  id: string;
  description: string;
  currentTool: string | null;
  toolElapsedSecs: number | null;
}

interface ActivitySnapshot {
  shells: ShellActivity[];
  browsers: BrowserActivity[];
  subagents: SubAgentActivityView[];
}

const EMPTY: ActivitySnapshot = { shells: [], browsers: [], subagents: [] };

const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${Math.floor(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function shortAgentId(id: string): string {
  const tail = id.split('-').slice(-2).join('-');
  return tail.length < id.length ? `…${tail}` : id;
}

export function BackgroundActivity() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const [raw, agents] = await Promise.all([
        typedRpc('background_activity', {}),
        Promise.resolve(useAgentPanelStore.getState().runtimeRef?.listAgents() ?? []),
      ]);
      const parsed = JSON.parse(raw) as { shells?: ShellActivity[]; browsers?: BrowserActivity[] };
      const subagents: SubAgentActivityView[] = agents
        .filter((a) => a.status === 'running' && (a.subagentDepth > 0 || a.parentId !== null))
        .map((a) => {
          const act = getSubAgentActivity(a.id);
          const toolElapsedSecs =
            act?.currentTool && act.toolStartedAt != null
              ? Math.max(0, Math.round((Date.now() - act.toolStartedAt) / 1000))
              : null;
          return {
            id: a.id,
            description: a.description || a.id,
            currentTool: act?.currentTool ?? null,
            toolElapsedSecs,
          };
        });
      setSnapshot({
        shells: parsed.shells ?? [],
        browsers: parsed.browsers ?? [],
        subagents,
      });
      setUpdatedAt(Date.now());
    } catch {
      // 后台快照失败不打扰用户；保留上一次数据
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
    }
  }, []);

  // 工具调用结束 / Agent 状态变化都可能意味着有新后台任务：立即刷新。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    };
    // P1c：订阅 agent-panel-store 信号 tick，替代 bus 'agent:tool-done'/'agent:status'
    const unsub = useAgentPanelStore.subscribe((s, prev) => {
      if (s.toolDoneTick !== prev.toolDoneTick || s.statusTick !== prev.statusTick) later();
    });
    void refresh();
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [refresh]);

  const count = snapshot.shells.length + snapshot.browsers.length + snapshot.subagents.length;
  const warning = useMemo(
    () =>
      snapshot.shells.some((s) => s.stalled) ||
      snapshot.subagents.some((a) => (a.toolElapsedSecs ?? 0) >= STUCK_THRESHOLD_S),
    [snapshot],
  );

  // 无后台活动时关闭弹层；有活动时按 3s 轮询，无活动时 15s 低频兜底。
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);
  useEffect(() => {
    const ms = count > 0 || open ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [count, open, refresh]);

  // 点击外部关闭。
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [open]);

  if (count === 0) return null;

  return (
    <span className="bg-act-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`bg-act-chip${warning ? ' warn' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Agent 后台活动"
        aria-expanded={open}
      >
        <span className="bg-act-dot" />
        <span className="bg-act-label">后台</span>
        <span className="bg-act-count">{count}</span>
      </button>
      {open && (
        <div className="bg-act-pop">
          <div className="bg-act-head">
            <span>后台活动</span>
            <span className="bg-act-refresh">{refreshing ? '刷新中' : updatedAt > 0 ? '刚刚更新' : ''}</span>
          </div>
          <div className="bg-act-body">
            {count === 0 && <div className="bg-act-empty">当前没有后台任务</div>}

            {snapshot.shells.length > 0 && (
              <div className="bg-act-section">
                <div className="bg-act-section-title">Shell 任务</div>
                {snapshot.shells.map((s) => (
                  <div className={`bg-act-row${s.stalled ? ' warn' : ''}`} key={`sh-${s.jobId}`}>
                    <span className="bg-act-row-dot" />
                    <span className="bg-act-row-main" title={s.label}>
                      {s.label || `job ${s.jobId}`}
                    </span>
                    <span className="bg-act-row-meta">
                      #{s.jobId} · {fmtDuration(s.elapsedSecs)}
                      {s.agent ? ` · ${shortAgentId(s.agent)}` : ''}
                    </span>
                    {s.stalled && <span className="bg-act-tag warn">停滞</span>}
                  </div>
                ))}
              </div>
            )}

            {snapshot.browsers.length > 0 && (
              <div className="bg-act-section">
                <div className="bg-act-section-title">浏览器会话</div>
                {snapshot.browsers.map((b) => (
                  <div className="bg-act-row" key={`br-${b.agent}-${b.slot}-${b.port}`}>
                    <span className="bg-act-row-dot" />
                    <span className="bg-act-row-main">
                      {b.slot || 'default'}
                      <span className="bg-act-row-sub"> :{b.port}</span>
                    </span>
                    <span className="bg-act-row-meta">
                      {b.headless ? 'headless' : b.external ? '外部实例' : '有头'}
                      {b.attached ? ' · 已 attach' : ''}
                      {b.agent !== 'default' ? ` · ${shortAgentId(b.agent)}` : ''} · {fmtDuration(b.elapsedSecs)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {snapshot.subagents.length > 0 && (
              <div className="bg-act-section">
                <div className="bg-act-section-title">子 Agent</div>
                {snapshot.subagents.map((a) => (
                  <div
                    className={`bg-act-row${(a.toolElapsedSecs ?? 0) >= STUCK_THRESHOLD_S ? ' warn' : ''}`}
                    key={`ag-${a.id}`}
                  >
                    <span className="bg-act-row-dot" />
                    <span className="bg-act-row-main" title={a.description}>
                      {a.description}
                    </span>
                    <span className="bg-act-row-meta">
                      {a.currentTool ?? '生成中'}
                      {a.toolElapsedSecs != null ? ` · ${fmtDuration(a.toolElapsedSecs)}` : ''}
                    </span>
                    {(a.toolElapsedSecs ?? 0) >= STUCK_THRESHOLD_S && <span className="bg-act-tag warn">疑似卡死</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
