// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具结果批量折叠 — 发送载荷层的轻量压缩（不碰 session/UI/存档）。
//
// 依据：Anthropic 官方 context engineering 文章将 tool result clearing 列为
// "the safest lightest touch form of compaction"——深历史中的工具输出对模型
// 几乎没有再利用价值（需要细节时模型会重新调用工具），却是 token 成本与
// context rot 的主要来源（本仓库实测长会话 tool_results 占载荷 50%+）。
//
// 缓存纪律：折叠边界（foldBoundary）由调用方稳定维护，只在跨过整批阈值时
// 批量前移。绝不能做成"每轮推进的滚动窗口"——被折叠消息的内容从完整变为
// 占位会让前缀在折叠边界处断裂，其后全部内容每轮重新计费（实测 miss/turn
// 从 659 恶化到 62K）。

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
