// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent_board — TaskBoard 查询工具。
//
// 填补"黑板对 Agent 不可见"缺口：主 Agent 之前只能靠 agent_inbox（result 消息）
// 和 agent_status（pool 运行状态）间接感知子 Agent 状态，TaskBoard 上的
// filesTouched / summary / diff 对主 Agent 是黑盒。
// agent_board 让主 Agent 随时查询所有子 Agent 条目（状态、改动文件、摘要、diff）。
//
// 注意：这不是 task_list（TaskManager 的任务系统）— 那是主 Agent 自己的待办，
// 与子 Agent 共享状态板无关。

import { z } from 'zod';
import type { TaskBoard } from '../task-board';
import type { Tool } from '../tool';
import { defineTool } from './define-tool';

const DIFF_LIMIT = 500;
const SUMMARY_LIMIT = 200;

export function createBoardStatusTool(board: TaskBoard, getParentId: () => string): Tool {
  return defineTool({
    name: 'agent_board',
    description:
      'Query the TaskBoard: all sub-agent entries (agentId, status, files touched, summary, diff). ' +
      'Use this to check which sub-agents have completed and what they changed — ' +
      'instead of guessing from agent_status or waiting for agent_inbox messages. ' +
      'This is NOT task_list (that is your own task tracker).',
    schema: z.object({}),
    readOnly: true,
    execute: async () => {
      const entries = board.getChildren(getParentId());
      if (entries.length === 0) {
        return 'TaskBoard 无子 Agent 条目。';
      }
      return entries
        .map((e) => {
          const parts = [
            `${e.agentId} [${e.status}]`,
            `描述: ${e.description}`,
            e.filesTouched && e.filesTouched.length > 0
              ? `改动文件: ${e.filesTouched.join(', ')}`
              : '',
            e.summary
              ? `摘要: ${e.summary.slice(0, SUMMARY_LIMIT)}${e.summary.length > SUMMARY_LIMIT ? '…(截断)' : ''}`
              : '',
            e.diff
              ? `diff: ${e.diff.slice(0, DIFF_LIMIT)}${e.diff.length > DIFF_LIMIT ? '…(截断)' : ''}`
              : '',
          ].filter(Boolean);
          return parts.join('\n');
        })
        .join('\n\n---\n\n');
    },
  });
}
