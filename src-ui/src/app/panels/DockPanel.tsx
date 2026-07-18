// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板容器 — 按注册表挂载六个面板（全部活在单 React 树内）。
// unmountOnClose 的面板（dataflow/settings）关闭即卸载（对齐旧 Controller 的
// close=unmount 语义）；其余常驻挂载，组件内部用 class 切换保 CSS 过渡。

import { useDockStore } from '../../ui/dock-store';
import { PANEL_DEFS, type PanelDef } from './panel-def';

function PanelSlot({ def }: { def: PanelDef }) {
  const open = useDockStore((s) => s.open[def.id]);
  if (def.unmountOnClose && !open) return null;
  const C = def.component;
  return <C />;
}

export function DockPanel() {
  return (
    <>
      {PANEL_DEFS.map((def) => (
        <PanelSlot key={def.id} def={def} />
      ))}
    </>
  );
}
