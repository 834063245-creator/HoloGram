// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板注册表 — 面板容器（DockPanel）的唯一清单。
// S4-1.5 消费闭环（设计件 §2.3）：清单源从「PANEL_DEFS 常量」扩为
// panelDefs() = 常量 + ctx.panels 贡献（合流点不是改写点；贡献变更经
// state/panel-defs-store 的 tick 信号即时生效）。
// S3（2026-08-22）：常量面清空——最后一行 settings 迁为第一方插件贡献
// （plugins/builtin/settings-domain/，面板 + 命令双通道；增补四产物通道化）。常量表保留：内置
// id 是部署事实（同名贡献内置胜的合流语义仍需要它作权威），未来第一方
// 面板域继续走贡献通道。

import type { ComponentType } from 'react';
import { activePanelContributions } from '../../composition/services';

export interface PanelDef {
  /** 面板 id——S1-5 起 string 开集（原 DockPanelId union 退役） */
  id: string;
  /** 轨道侧；null = 不上轨道（命令面板 / 快捷键唤起） */
  side: 'left' | 'right' | null;
  title: string;
  icon: string;
  /** 面板内提供「问 Agent」入口 */
  askAgent?: boolean;
  /** 关闭即卸载、重开重置状态（对齐旧 Controller 的 unmount 语义）；
   *  缺省常驻挂载 + class 切换（保 CSS 滑入滑出过渡） */
  unmountOnClose?: boolean;
  /** 关闭时播出场动画（退场对称，§15，2026-10-15 批 3b）。
   *
   *  背景：`unmountOnClose` 的面**关即卸载**，卸载即从 DOM 消失——出场动画没有
   *  落点，故这类面长期只有入场（`@starting-style` / 挂载即播的 keyframes）而没有
   *  出场。声明本字段后，DockPanel 在关闭时先留 `PANEL_LEAVE_MS` 的「正在退场」窗：
   *  根元素收到 `[data-panel-leaving]` 属性，窗满才真卸载——**「关即卸载、重开
   *  重置」的语义不变**（只是晚一个出场时长）。
   *
   *  消费面：本面板自己的 CSS 写 `[data-panel-leaving] <本面板根> { … }`
   *  （壳层供钩、产物消费；产物 CSS 若比 exe 旧、不认识该属性 ⇒ 规则不匹配 ⇒
   *  只是没有出场动画，无破面）。
   *
   *  **未声明 = 即时卸载**（刻画意的默认关）：留一个不播动画的空窗只会变成
   *  「冻住一帧再消失」，比瞬删更糟。 */
  animateExit?: boolean;
  component: ComponentType;
}

// V5 拆除（2026-08-22，纸壳唯一主界面）：旧观测台 dock 面板族（check/
// constraints/dataflow/agents/tasks）随 chrome 退役；纸面板是组合层贡献
// （plugins/builtin/paper-shell/）。S3（2026-08-22）：settings 亦迁贡献
// （plugins/builtin/settings-domain/）——常量面自此为空，全量面板走贡献通道
// （docs/adr/workspace-concept-ownership.md）。
export const PANEL_DEFS: PanelDef[] = [];

// ── 装载期运行时校验（S1-5：id 从编译期 union 约束迁到运行时清单校验）──
// union 退役后合法 id 的守门在这里：重复 id / 缺组件在模块加载时直接 throw
// （错误不静默——对齐 composition/contribution-channel ContributionChannel 的装载期
// 拒绝语义）。外部插件面板（S2/S4）将经 PanelsService 注册走同款校验。
{
  const seen = new Set<string>();
  for (const def of PANEL_DEFS) {
    if (seen.has(def.id)) {
      throw new Error('[panel-def] duplicate panel id "' + def.id + '" —— 装载期拒绝');
    }
    if (!def.component) {
      throw new Error('[panel-def] panel "' + def.id + '" 缺 component —— 装载期拒绝');
    }
    seen.add(def.id);
  }
}

// ── S4-1.5 消费闭环合流点（设计件 §2.3）──

/**
 * 有效面板清单：内置常量 + ctx.panels 贡献（即时生效——贡献 register/
 * dispose 时 panel-defs-store bump，消费组件重取本函数）。
 * 合流纪律：常量面零改写；贡献与内置同 id → 内置胜（console.warn 可见）；
 * 缺 id/component 的贡献跳过（运行时形状守卫——插件代码不受编译期类型约束）。
 */
export function panelDefs(): PanelDef[] {
  const out: PanelDef[] = [...PANEL_DEFS];
  const builtinIds = new Set(PANEL_DEFS.map((d) => d.id));
  for (const c of activePanelContributions()) {
    if (c == null || typeof c.id !== 'string' || c.id === '' || !c.component) {
      console.warn('[panel-def] 无效面板贡献被跳过（缺 id/component）');
      continue;
    }
    if (builtinIds.has(c.id)) {
      console.warn('[panel-def] 面板贡献 "' + c.id + '" 与内置面板同 id——内置胜（内置 id 是部署事实）');
      continue;
    }
    out.push(c);
  }
  return out;
}
