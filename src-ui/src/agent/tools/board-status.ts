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
import type { TaskBoard, BoardEntry } from '../task-board';
import type { Tool } from '../tool';
import { defineTool } from './define-tool';
import { parseIsolationDiff, spillToFile } from '../spill';

const DIFF_LIMIT = 500;
const SUMMARY_LIMIT = 200;

/** board 里的 diff 字段是 agent_isolation_diff 的 JSON 返回（含溢写标记）。
 *  大 diff 已落盘 → locator；小 diff 内联展示，超限再溢写。 */
async function formatDiffLine(entry: BoardEntry, projectPath: string): Promise<string> {
  if (!entry.diff) return '';
  const parsed = parseIsolationDiff(entry.diff);
  if (parsed?.spillPath) {
    return `diff: 完整内容已溢写 — ${parsed.spillPath}（用 read_file 读取全量）`;
  }
  const text = parsed?.hasChanges === false ? '(无变更)' : (parsed?.diff ?? entry.diff);
  if (text.length <= DIFF_LIMIT) return `diff: ${text}`;
  const out = await spillToFile({
    projectPath,
    name: `board-${entry.agentId}`,
    text,
    maxInline: DIFF_LIMIT,
    extension: 'diff',
  });
  return `diff: ${out.display}`;
}

export function createBoardStatusTool(board: TaskBoard, getParentId: () => string): Tool {
  return defineTool({
    name: 'agent_board',
    description:
      'Query the TaskBoard: all sub-agent entries (agentId, status, files touched, summary, diff). ' +
      'Use this to check which sub-agents have completed and what they changed — ' +
      'instead of guessing from agent_status or waiting for agent_inbox messages. ' +
      'Large diffs are spilled to .hologram/spill/ — read the referenced file to get the full diff. ' +
      'This is NOT task_list (that is your own task tracker).',
    schema: z.object({}),
    readOnly: true,
    execute: async () => {
      const entries = board.getChildren(getParentId());
      if (entries.length === 0) {
        return 'TaskBoard 无子 Agent 条目。';
      }
      const projectPath = board.projectPath;
      const lines = await Promise.all(
        entries.map(async (e) => {
          const diffLine = await formatDiffLine(e, projectPath);
          const parts = [
            `${e.agentId} [${e.status}]`,
            `描述: ${e.description}`,
            e.filesTouched && e.filesTouched.length > 0
              ? `改动文件: ${e.filesTouched.join(', ')}`
              : '',
            e.summary
              ? `摘要: ${e.summary.slice(0, SUMMARY_LIMIT)}${e.summary.length > SUMMARY_LIMIT ? '…(截断)' : ''}`
              : '',
            diffLine,
          ].filter(Boolean);
          return parts.join('\n');
        }),
      );
      return lines.join('\n\n---\n\n');
    },
  });
}
