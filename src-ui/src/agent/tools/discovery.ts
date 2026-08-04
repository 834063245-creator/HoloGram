// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DiscoveryBoard 工具 — agent_discover / agent_lookup
//
// 参照 communication.ts 的工具模式：
//   闭包捕获 board 和 getAgentId，不捕获 Agent 实例。

import { z } from 'zod';
import type { DiscoveryBoard } from '../discovery-board';
import type { Tool } from '../tool';
import { defineTool } from './define-tool';

export function createDiscoveryTools(
  board: DiscoveryBoard,
  getAgentId: () => string,
): Tool[] {
  return [
    // ── agent_discover — 发布发现 ──
    defineTool({
      name: 'agent_discover',
      description:
        'Post a discovery to the shared discovery board. Other agents can query it with agent_lookup ' +
        'to avoid redundant exploration. Use this to share findings like file locations, architectural ' +
        'insights, bugs found, or patterns identified.',
      schema: z.object({
        key: z.string().describe('Short label for this discovery (e.g. "auth-location", "config-entry-point")'),
        value: z.string().describe('The discovery content — be specific (file paths, line numbers, findings)'),
        category: z.string().describe('Category: "architecture" / "bug" / "pattern" / "config" / "other"'),
      }),
      execute: async (args) => {
        const id = board.post(getAgentId(), args.key, args.value, args.category);
        return `发现已发布 (id: ${id})。其他 Agent 可通过 agent_lookup 查看。`;
      },
    }),

    // ── agent_lookup — 查询发现 ──
    defineTool({
      name: 'agent_lookup',
      description:
        'Query the session discovery board for findings posted by agents in the same session. ' +
        'Use this before starting exploration to avoid duplicating work that other agents already did. ' +
        'By default only active (non-archived) discoveries are returned, limited to 20 most recent.',
      schema: z.object({
        key: z.string().optional().describe('Filter by discovery key (optional, partial match)'),
        category: z
          .string()
          .optional()
          .describe('Filter by category (optional): "architecture" / "bug" / "pattern" / "config" / "other"'),
        include_archived: z.boolean().optional().describe('Include archived discoveries (default false)'),
        since: z.number().optional().describe('Only return discoveries with ts >= since (Unix ms, optional)'),
        limit: z.number().optional().describe('Max number of results (default 20)'),
      }),
      readOnly: true,
      execute: async (args) => {
        let entries = board.query({
          category: args.category,
          includeArchived: args.include_archived,
          since: args.since,
          limit: args.limit,
        });
                const key = args.key;
        if (key) {
          entries = entries.filter((e) => e.key.includes(key));
        }
        if (entries.length === 0) return '(没有匹配的发现)';
        return entries
          .map(
            (e) =>
              `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`,
          )
          .join('\n');
      },
    }),
  ];
}