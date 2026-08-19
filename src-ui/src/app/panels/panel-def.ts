// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板注册表 — DockRail（轨道按钮）与 DockPanel（面板容器）的唯一清单。
// 增删面板只改这里；开合状态在 ui/dock-store，不在本表。

import type { ComponentType } from 'react';
import type { DockPanelId } from '../../ui/dock-store';
import { AgentsPanel } from './AgentsPanel';
import { CheckPanel } from './CheckPanel';
import { ConstraintsPanel } from './ConstraintsPanel';
import { DataflowPanel } from './DataflowPanel';
import { SettingsPanel } from './SettingsPanel';
import { TasksPanel } from './TasksPanel';

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
  { id: 'check', side: 'right', title: '简报', icon: 'check', askAgent: true, component: CheckPanel },
  { id: 'constraints', side: 'right', title: '约束', icon: 'constraints', askAgent: true, component: ConstraintsPanel },
  { id: 'dataflow', side: null, title: '数据流', icon: 'dataflow', unmountOnClose: true, component: DataflowPanel },
  { id: 'settings', side: null, title: '设置', icon: 'settings', unmountOnClose: true, component: SettingsPanel },
  { id: 'agents', side: 'right', title: '智能体', icon: 'agent', askAgent: false, component: AgentsPanel },
  { id: 'tasks', side: 'right', title: '待办', icon: 'task', askAgent: false, component: TasksPanel },
];
