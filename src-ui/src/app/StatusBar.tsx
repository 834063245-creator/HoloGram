// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：底部状态栏 — 替代旧 #status。
// 左：脉点 + 状态文本 + 日志徽标（点击展开日志浮层）；右：星图遥测 + 工作区路径。

import { useEffect, useRef, useState } from 'react';
import { BackgroundActivity } from './BackgroundActivity';
import { useShellStore } from './shell-store';

export function StatusBar() {
  const statusText = useShellStore((s) => s.statusText);
  const statusLog = useShellStore((s) => s.statusLog);
  const graphStats = useShellStore((s) => s.graphStats);
  const projectPath = useShellStore((s) => s.projectPath);
  const [logOpen, setLogOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 点击外部关闭日志浮层
  useEffect(() => {
    if (!logOpen) return;
    const dismiss = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setLogOpen(false);
    };
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, [logOpen]);

  return (
    <footer className="sb-bar">
      <span className="sb-left" ref={wrapRef}>
        <span className="sb-pulse" />
        <span className="sb-text">{statusText}</span>
        <BackgroundActivity />
        {statusLog.length > 0 ? (
          <button type="button" className="sb-log-badge" title="状态日志" onClick={() => setLogOpen((v) => !v)}>
            {statusLog.length}
          </button>
        ) : null}
        {logOpen ? (
          <span className="sb-pop">
            {statusLog.map((e, i) => (
              <span key={e.id} className={`sb-pop-row${i === statusLog.length - 1 ? ' latest' : ''}`}>
                {e.msg}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="sb-spacer" />
      <span className="sb-tele">
        {graphStats ? (
          <>
            <span>
              <b>{graphStats.nodes}</b> 节点
            </span>
            <span>
              <b>{graphStats.edges}</b> 边
            </span>
            <span>
              S<b>{graphStats.s}</b> D<b>{graphStats.d}</b> T<b>{graphStats.t}</b>
            </span>
            {graphStats.l4 > 0 ? <span className="sb-l4">L4×{graphStats.l4}</span> : null}
            {graphStats.l4 === 0 && graphStats.l3 > 0 ? <span className="sb-l3">L3×{graphStats.l3}</span> : null}
            {graphStats.galaxies > 0 ? <span>{graphStats.galaxies} 星座</span> : null}
          </>
        ) : null}
        {projectPath ? <span className="sb-path">{projectPath}</span> : null}
      </span>
    </footer>
  );
}
