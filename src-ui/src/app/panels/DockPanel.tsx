// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板容器 — 按注册表挂载六个面板（全部活在单 React 树内）。
// unmountOnClose 的面板（dataflow/settings）关闭即卸载（对齐旧 Controller 的
// close=unmount 语义）；其余常驻挂载，组件内部用 class 切换保 CSS 过渡。
// S4-1.5：清单源改读 panelDefs()（常量 + 插件贡献），panelDefsTick 驱动
// 贡献变更后的即时重挂载（设计件 §2.3）。
// 保险丝 b（2026-09-03 生产事故立法）：面板组件（插件贡献面——含纸壳
// paper 面板本体）包 PluginBoundary——单面板渲染崩溃只死自己那格，
// 崩溃面可见可重试，React 整树卸载绝迹（此前产物/exe 偏斜即全 UI 死）。
// 2026-10-15 §15 批 3b：加**退场窗**（`animateExit`）——见 PanelSlot 相位机注。

import { useEffect, useState } from 'react';
import { useDockStore } from '../../state/dock-store';
import { usePanelDefsStore } from '../../state/panel-defs-store';
import { PluginBoundary } from '../PluginBoundary';
import { type PanelDef, panelDefs } from './panel-def';

/** 面板退场窗（ms）——**必须与 `tokens.css` 的 `--m-sheet`（0.26s）同值**：
 *  两把尺子一把，CSS 侧播出场、壳层侧等这么久才真卸载（不等 = 动画播到一半就
 *  被卸载掐断）。镜像由 `tests/motion-contract.test.ts` 钉死（改一处不改另一处即红）。 */
const PANEL_LEAVE_MS = 260;

function PanelSlot({ def }: { def: PanelDef }) {
  const open = useDockStore((s) => s.open[def.id]);
  const canLeave = def.unmountOnClose === true && def.animateExit === true;

  /* 相位机（退场对称，§15）：open → 'open'；open 由 true 转 false → 'leaving'
   * →（PANEL_LEAVE_MS）→ 'closed'（真卸载）。
   *
   *  转移写成**函数式 setState**（纯函数、幂等）而非「读 prev ref」：StrictMode
   *  双调用 / effect 重跑都不会误开窗；且初始 phase 直接取 `open`，故启动期
   *  （所有面板 open=false）不会凭空多出一个空窗。 */
  const [phase, setPhase] = useState<'open' | 'leaving' | 'closed'>(open ? 'open' : 'closed');
  useEffect(() => {
    setPhase((p) => {
      if (open) return 'open';
      if (p === 'open') return canLeave ? 'leaving' : 'closed';
      return p; // 'leaving' 由下面的定时器收尾；'closed' 保持
    });
  }, [open, canLeave]);
  useEffect(() => {
    if (phase !== 'leaving') return;
    const t = setTimeout(() => setPhase('closed'), PANEL_LEAVE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const mounted = open || phase === 'leaving';
  if (def.unmountOnClose && !mounted) return null;
  const C = def.component;
  return (
    /* 退场标记层：`display: contents` = **不生成盒子**，对既有布局零影响；
       面板自己的 CSS 以 `[data-panel-leaving] <本面板根>` 播出场（壳层供钩、
       产物消费——见 panel-def 的 animateExit 注）。 */
    <div data-panel-leaving={phase === 'leaving' ? '' : undefined} style={{ display: 'contents' }}>
      <PluginBoundary label={`面板 ${def.id}`}>
        <C />
      </PluginBoundary>
    </div>
  );
}

export function DockPanel() {
  const panelDefsTick = usePanelDefsStore((s) => s.panelDefsTick);
  const defs = panelDefs();
  void panelDefsTick; // 信号驱动重渲染；清单在渲染期重取（合流点幂等）
  return (
    <>
      {defs.map((def) => (
        <PanelSlot key={def.id} def={def} />
      ))}
    </>
  );
}
