// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具结果批量折叠 — 发送载荷层的轻量压缩（不碰 session/UI/存档）。
//
// ⚠️ 默认禁用（Agent.toolResultWindow 默认 0）：
// 在 DeepSeek 前缀缓存计价下（hit $0.0028/M vs miss $0.14/M，50 倍价差），
// 折叠省的是最便宜的 hit 段（1/50 价），而每次折叠事件会让折叠边界之后
// 的全部历史从 hit 变 miss 重算一次。实测盈亏大致相抵甚至略亏（见
// 2026-08-09 会话分析），且引入 context rot 与重复调用工具的风险。
// 保留实现与开关：若未来接入无前缀缓存的 provider，或证明折叠净收益为正，再启用。
//
// 依据：Anthropic 官方 context engineering 文章将 tool result clearing 列为
// "the safest lightest touch form of compaction"——但该建议预设了
// "上下文接近窗口上限"的场景；在缓存命中的长会话里，历史段几乎免费，
// 该结论不直接适用。

import type { Message } from '../provider/types';

/** 批量折叠条数：tool 消息总数超过 foldBoundary + batch 时一次前移 batch。 */
export const DEFAULT_TOOL_FOLD_BATCH = 40;

/** 折叠 payload 中序号 < foldBoundary 的 tool 结果 — 保留 tool_call_id 配对与
 *  消息顺序，内容替换为占位（工具名 + 调用 id 尾段 + 原文估算大小）。
 *  foldBoundary 必须稳定（见 nextFoldBoundary），不要逐轮推进。
 *  - foldBoundary <= 0: 不折叠（兼容旧行为）
 *  只应作用于发送载荷（payloadMessages）；session / UI / 存档保持完整。 */
export function foldToolResults(messages: readonly Message[], foldBoundary: number): Message[] {
  if (foldBoundary <= 0) return messages as Message[];

  let seen = 0;
  return messages.map((m) => {
    if (m.role !== 'tool') return m;
    const idx = seen++;
    if (idx < foldBoundary) {
      const id = m.tool_call_id ? m.tool_call_id.slice(-6) : '';
      const approxBytes = m.content.length * 2; // UTF-8 估算（中文 3B / ASCII 1B 的折中）
      return {
        ...m,
        content: `[工具结果已折叠: ${m.name ?? 'tool'}${id ? ` #${id}` : ''} — 原文约 ${formatSize(approxBytes)}。如需细节请重新调用该工具。]`,
      };
    }
    return m;
  });
}

/** 批量推进折叠边界：边界后积累满 2×batch 条 tool 消息时前移一批（一次最多一批）。
 *  推进后仍保留 ≥batch 条完整结果；未跨阈值则边界不变 — 折叠集合稳定，前缀不漂移。
 *  折叠事件每积累 batch 条新消息才发生一次。 */
export function nextFoldBoundary(totalTool: number, foldBoundary: number, batch: number): number {
  if (batch <= 0) return 0;
  if (totalTool - foldBoundary >= 2 * batch) return foldBoundary + batch;
  return foldBoundary;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
