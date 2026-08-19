// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：左右 dock 轨道 — 替代旧 #left-tabs / #right-tabs。
// P3：面板清单改读 panel-def 注册表；开合状态改读 dock-store（原 shell-store.panels 快照链已删）。
// 行为对齐旧 updateTabs：本侧有面板打开时整条轨道隐藏；按钮激活态跟面板开合。

import { useDockStore } from '../state/dock-store';
import { runAction } from './actions';
import { Icon } from './Icon';
import { PANEL_DEFS } from './panels/panel-def';

export function DockRail({ side }: { side: 'left' | 'right' }) {
  const open = useDockStore((s) => s.open);
  const items = PANEL_DEFS.filter((d) => d.side === side);
  const anyOpen = items.some((it) => open[it.id]);
  if (anyOpen) return null; // 旧行为：面板打开时让位
  return (
    <nav className={`dr-rail dr-${side}`}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`dr-btn${open[it.id] ? ' on' : ''}`}
          title={it.title}
          onClick={() => runAction(`panel.${it.id}`)}
        >
          <Icon name={it.icon} />
          <span className="dr-label">{it.title}</span>
        </button>
      ))}
    </nav>
  );
}
