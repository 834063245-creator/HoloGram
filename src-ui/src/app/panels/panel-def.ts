// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板注册表 — DockRail（轨道按钮）与 DockPanel（面板容器）的唯一清单。
// 增删面板只改这里；开合状态在 ui/dock-store，不在本表。

import type { ComponentType } from 'react';
import type { DockPanelId } from '../../ui/dock-store';
import { CheckPanel } from '../../ui/react/CheckPanel';
import { ConstraintsPanel } from '../../ui/react/ConstraintsPanel';
import { DataflowPanel } from '../../ui/react/DataflowPanel';
import { HotspotsPanel } from '../../ui/react/HotspotsPanel';
import { SettingsPanel } from '../../ui/react/SettingsPanel';
import { TimelinePanel } from '../../ui/react/TimelinePanel';

export interface PanelDef {
  id: DockPanelId;
  /** 轨道侧；null = 不上轨道（命令面板 / 快捷键唤起） */
  side: 'left' | 'right' | null;
  title: string;
  icon: string;
  /** 面板内提供「问 Agent」入口 */
  askAgent?: boolean;
  /** 关闭即卸载、重开重置状态（对齐旧 Controller 的 unmount 语义）；
   *  缺省常驻挂载 + class 切换（保 CSS 滑入滑出过渡） */
  unmountOnClose?: boolean;
  component: ComponentType;
}

export const PANEL_DEFS: PanelDef[] = [
  { id: 'timeline', side: 'left', title: '时间轴', icon: 'timeline', askAgent: true, component: TimelinePanel },
  { id: 'hotspots', side: 'left', title: '热点', icon: 'fire', askAgent: true, component: HotspotsPanel },
  { id: 'check', side: 'right', title: '简报', icon: 'check', askAgent: true, component: CheckPanel },
  { id: 'constraints', side: 'right', title: '约束', icon: 'constraints', askAgent: true, component: ConstraintsPanel },
  { id: 'dataflow', side: null, title: '数据流', icon: 'dataflow', unmountOnClose: true, component: DataflowPanel },
  { id: 'settings', side: null, title: '设置', icon: 'settings', unmountOnClose: true, component: SettingsPanel },
];
