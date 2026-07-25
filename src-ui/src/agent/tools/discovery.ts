// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DiscoveryBoard 工具 — agent_discover / agent_lookup
//
// 参照 communication.ts 的工具模式：
//   闭包捕获 board 和 getAgentId，不捕获 Agent 实例。

import type { DiscoveryBoard } from '../discovery-board';
import type { Tool } from '../tool';

export function createDiscoveryTools(
  board: DiscoveryBoard,
  getAgentId: () => string,
): Tool[] {
  // ── agent_discover — 发布发现 ──
  const agentDiscover: Tool = {
    name: () => 'agent_discover',
    description: () =>
      'Post a discovery to the shared discovery board. Other agents can query it with agent_lookup ' +
      'to avoid redundant exploration. Use this to share findings like file locations, architectural ' +
      'insights, bugs found, or patterns identified.',
    parameters: () => ({
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Short label for this discovery (e.g. "auth-location", "config-entry-point")',
        },
        value: {
          type: 'string',
          description: 'The discovery content — be specific (file paths, line numbers, findings)',
        },
        category: {
          type: 'string',
          description: 'Category: "architecture" / "bug" / "pattern" / "config" / "other"',
        },
      },
      required: ['key', 'value', 'category'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      const id = board.post(getAgentId(), args.key as string, args.value as string, args.category as string);
      return `发现已发布 (id: ${id})。其他 Agent 可通过 agent_lookup 查看。`;
    },
  };

  // ── agent_lookup — 查询发现 ──
  const agentLookup: Tool = {
    name: () => 'agent_lookup',
    description: () =>
      'Query the session discovery board for findings posted by agents in the same session. ' +
      'Use this before starting exploration to avoid duplicating work that other agents already did. ' +
      'By default only active (non-archived) discoveries are returned, limited to 20 most recent.',
    parameters: () => ({
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Filter by discovery key (optional, partial match)',
        },
        category: {
          type: 'string',
          description: 'Filter by category (optional): "architecture" / "bug" / "pattern" / "config" / "other"',
        },
        include_archived: {
          type: 'boolean',
          description: 'Include archived discoveries (default false)',
        },
        since: {
          type: 'number',
          description: 'Only return discoveries with ts >= since (Unix ms, optional)',
        },
        limit: {
          type: 'number',
          description: 'Max number of results (default 20)',
        },
      },
    }),
    readOnly: () => true,
    execute: async (args) => {
      const keyFilter = args.key as string | undefined;
      const catFilter = args.category as string | undefined;
      const includeArchived = args.include_archived as boolean | undefined;
      const since = args.since as number | undefined;
      const limit = args.limit as number | undefined;
      let entries = board.query({
        category: catFilter,
        includeArchived,
        since,
        limit,
      });
      if (keyFilter) {
        entries = entries.filter((e) => e.key.includes(keyFilter));
      }
      if (entries.length === 0) return '(没有匹配的发现)';
      return entries
        .map(
          (e) =>
            `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`,
        )
        .join('\n');
    },
  };

  return [agentDiscover, agentLookup];
}
