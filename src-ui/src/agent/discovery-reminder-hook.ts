// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 发现提醒钩子 —— 「其他 Agent 的新发现」注入（收编自 Agent._injectDiscoveries，
// agent-hooks-plan 二期 §7.3：发现注入迁为步骤钩子面上一等公民）。
//
// 迁移动机：发现注入是标准的「步前注入」语义（每步前看板上有无新条目 → 注入
// transient reminder），此前以 Agent 私有方法 + loop 直调的形状存在（注入链中段
// 的硬编码位置）；迁为步骤钩子后与插件钩子同一管道、同一可观测面。
//
// 行为对齐（对拍 git 史旧实现，逐字不变）：
//   - 判据：非己（e.agentId !== agentId）+ 未见（去重集）+ 5 分钟窗（Date.now() - e.ts）；
//   - 注入内容：`<system-reminder>🔬 共享发现 (N 条):…` 逐字不变（content 原样形态）；
//   - 去重集闭包在钩子实例内（per-Agent）；无需 create 工厂——装配点天然 per-Agent
//     （本钩子由 runtime 装配折叠注册；子 Agent 不接本面——其 _discoveryBoard 本就
//     为 null，child() 不继承该服务，旧路径同样不注入）。
//
// 顺序位移（显式记录，agent-hooks-plan 二期）：注入落点由「注入链中段」（injectInbox
// 之后立即）移到「链尾」（步骤钩子注入的统一点、压缩预检之前）——同一时刻多个来源的
// transient 提醒先后顺序可能变化，内容与判据不变。

import type { DiscoveryBoard } from './discovery-board';
import type { PreStepHook } from './steps';

/** 发现提醒钩子（闭包持 board + 已注入集合——每 Agent 一实例）。 */
export function createDiscoveryReminderHook(opts: {
  agentId: string;
  /** 该 Agent 终生绑定的会话发现板（圈定查询面——钩子只读不写）。 */
  board: Pick<DiscoveryBoard, 'query'>;
}): PreStepHook {
  const injected = new Set<string>();
  return {
    name: 'builtin/discovery-reminder',
    decide: () => {
      const entries = opts.board.query();
      if (entries.length === 0) return { action: 'enter' };
      // 仅注入来自其他 Agent、尚未见过、5 分钟内的 discoveries
      const recent = entries.filter(
        (e) => e.agentId !== opts.agentId && !injected.has(e.id) && Date.now() - e.ts < 5 * 60 * 1000,
      );
      if (recent.length === 0) return { action: 'enter' };
      for (const e of recent) injected.add(e.id);
      const formatted = recent.map((e) => `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`).join('\n');
      // 临时 — discoveries 可通过 agent_lookup 重新查询
      return {
        action: 'enter',
        reminders: [
          {
            content: `<system-reminder>\n🔬 共享发现 (${recent.length} 条):\n${formatted}\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>`,
          },
        ],
      };
    },
  };
}
