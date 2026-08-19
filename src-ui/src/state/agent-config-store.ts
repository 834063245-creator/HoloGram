// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-config-store — Agent 配置变更信号（P1b：替代 bus 'agent:config-changed' 事件；
// 见 docs/plans/ui-react-island-retirement-plan.md）。
// 发射点：SettingsPanel / ModelSwitcher / ChatFooter（协作模式按钮）。
// 唯一消费者：main.ts 单一订阅 → Workspace.applyAgentConfig 热切换（不重建 Agent）。
// 雷区地图 #25 的根治设计原样保留：信号与 saveSettings 解耦，权限模式不发信号。

import { create } from 'zustand';

/** 触发 agent 配置热切换的原因。所有原因都由 Workspace.applyAgentConfig
 *  热切换处理，不重建 Agent。 */
export type AgentConfigChangeReason = 'settings-saved' | 'collaboration-mode' | 'model-switched' | 'thinking-changed';

export const useAgentConfigStore = create<{ seq: number; reason: AgentConfigChangeReason | null }>(() => ({
  seq: 0,
  reason: null,
}));

/** 发射配置变更信号（seq 递增保证同 reason 连发也能触发订阅者）。 */
export function notifyAgentConfigChanged(reason: AgentConfigChangeReason): void {
  useAgentConfigStore.setState((s) => ({ seq: s.seq + 1, reason }));
}
