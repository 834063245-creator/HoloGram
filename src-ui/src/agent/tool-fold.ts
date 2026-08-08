// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具结果滚动折叠 — 发送载荷层的轻量压缩（不碰 session/UI/存档）。
//
// 依据：Anthropic 官方 context engineering 文章将 tool result clearing 列为
// "the safest lightest touch form of compaction"——深历史中的工具输出对模型
// 几乎没有再利用价值（需要细节时模型会重新调用工具），却是 token 成本与
// context rot 的主要来源（本仓库实测长会话 tool_results 占载荷 50%+）。

import type { Message } from '../provider/types';

/** 发送载荷中完整保留的最近工具结果条数。 */
export const DEFAULT_TOOL_RESULT_WINDOW = 40;

/** 折叠 payload 中窗口外的 tool 结果 — 保留 tool_call_id 配对与消息顺序，
 *  内容替换为占位（工具名 + 调用 id 尾段 + 原文估算大小）。
 *  - window < 0: 禁用（全保留，兼容旧行为）
 *  - window = 0: 全折叠
 *  只应作用于发送载荷（payloadMessages）；session / UI / 存档保持完整。 */
export function foldToolResults(messages: readonly Message[], window: number): Message[] {
  if (window < 0) return messages as Message[];
  let total = 0;
  for (const m of messages) if (m.role === 'tool') total++;
  const foldCount = Math.max(0, total - window);
  if (foldCount === 0) return messages as Message[];

  let folded = 0;
  return messages.map((m) => {
    if (m.role !== 'tool' || folded >= foldCount) return m;
    folded++;
    const id = m.tool_call_id ? m.tool_call_id.slice(-6) : '';
    const approxBytes = m.content.length * 2; // UTF-8 估算（中文 3B / ASCII 1B 的折中）
    return {
      ...m,
      content: `[工具结果已折叠: ${m.name ?? 'tool'}${id ? ` #${id}` : ''} — 原文约 ${formatSize(approxBytes)}。如需细节请重新调用该工具。]`,
    };
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
