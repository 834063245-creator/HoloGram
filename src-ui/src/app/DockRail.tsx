// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：左右 dock 轨道 — 替代旧 #left-tabs / #right-tabs。
// 行为对齐旧 updateTabs：本侧有面板打开时整条轨道隐藏；按钮激活态跟面板开合。

import { runAction } from './actions';
import { Icon } from './Icon';
import { useShellStore } from './shell-store';

const RAILS: Record<'left' | 'right', Array<{ id: string; icon: string; label: string }>> = {
  left: [
    { id: 'timeline', icon: 'timeline', label: '时间轴' },
    { id: 'hotspots', icon: 'fire', label: '热点' },
  ],
  right: [
    { id: 'check', icon: 'check', label: '简报' },
    { id: 'constraints', icon: 'constraints', label: '约束' },
  ],
};

export function DockRail({ side }: { side: 'left' | 'right' }) {
  const panels = useShellStore((s) => s.panels);
  const items = RAILS[side];
  const anyOpen = items.some((it) => panels[it.id]);
  if (anyOpen) return null; // 旧行为：面板打开时让位
  return (
    <nav className={`dr-rail dr-${side}`}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`dr-btn${panels[it.id] ? ' on' : ''}`}
          title={it.label}
          onClick={() => runAction(`panel.${it.id}`)}
        >
          <Icon name={it.icon} />
          <span className="dr-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
