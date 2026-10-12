// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 设置面板页签表（id / 图标名 / 题字）——单一真源。
//
// 为什么单列一个文件：图标名是**跨文件契约**（真源在 `ui/icons.ts`），写在 JSX 字面量里
// 既没法被测试点名，也没法一眼看出「谁跟谁共用了一个图标」——2026-09-28 之前正是因为
// 四个页签共用一个 `agent`（而叫 Agent 那页借了 `code`、显示借了画布的 `mode-standard`），
// 一列看过去四把一样的伞。表拉到模块面后，`tests/settings-tab-icons.test.ts` 钉两条：
// ① 七个图标互不相同；② 每个名字都真在图标集在册。
//
// 图标选型按「尺寸档纪律」的 11px 档（页签只画 11px，见 `ui/icons.ts` 头注）：
// 每形只留 1~3 个图元 + 至少一个重元素；各形刻意分属不同轮廓类
// （弧簇 / 主从点 / 方框明暗 / 点阵 / 星芒 / 环柄星 / 圆圈记 / 仪表盘），缩到 11px 也不互混。

/** 页签 id（= 面板内容区的 `data-tab` 值）。 */
export type SettingsTabId = 'provider' | 'agent' | 'display' | 'plugins' | 'skills' | 'mcp' | 'diagnostic' | 'about';

export interface SettingsTabDef {
  id: SettingsTabId;
  /** `ui/icons.ts` 在册图标名（守卫测试钉「真在册」）。 */
  icon: string;
  /** 页签题字。 */
  label: string;
}

/** 页签表（顺序 = 从左到右的呈现序）。 */
export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { id: 'provider', icon: 'provider', label: '提供方' },
  { id: 'agent', icon: 'agent', label: 'Agent' },
  { id: 'display', icon: 'display', label: '显示' },
  { id: 'plugins', icon: 'plugin', label: '插件' },
  { id: 'skills', icon: 'skill', label: '技能' },
  { id: 'mcp', icon: 'mcp', label: 'MCP' },
  // 诊断（日志可观测性批 4）：级别开关 + 诊断包导出——「出问题时才用」的动作
  // 收拢到一页（与「平时配置」的页签气质分开，用户找起来只有一条路）。
  { id: 'diagnostic', icon: 'threshold', label: '诊断' },
  { id: 'about', icon: 'info', label: '关于' },
];
