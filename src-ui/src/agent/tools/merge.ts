// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent_merge — 统一合并工具
//
// 父 Agent 调用此工具，将所有已完成的异步子 Agent 的 worktree 串行合并回主仓。
// 冲突时保全 diff（已在 TaskBoard 上），清理 worktree，让父 Agent 手动应用。
//
// git 是安全网：merge 出问题可以 git reset 回滚。

import type { TaskBoard } from '../task-board';
import type { Tool, ToolExecutor } from '../tool';
import { enqueueIsolationOp } from '../isolation-queue';

export function createMergeTool(
  board: TaskBoard,
  getAgentId: () => string,
  exec: ToolExecutor,
): Tool {
  return {
    name: () => 'agent_merge',
    description: () =>
      'Merge completed sub-agent worktrees back into the main repository. ' +
      'Reviews all pending changes from the TaskBoard, merges them sequentially. ' +
      'On conflict, preserves the diff for manual application.',
    parameters: () => ({
      type: 'object',
      properties: {
        agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Sub-agent IDs to merge. If omitted, merges all completed sub-agents.',
        },
      },
    }),
    readOnly: () => false,
    execute: async (args) => {
      const agentIds = args.agent_ids as string[] | undefined;
      const parentId = getAgentId();

      let children = board.getChildren(parentId);
      if (agentIds && agentIds.length > 0) {
        const idSet = new Set(agentIds);
        children = children.filter((e) => idSet.has(e.agentId));
      }
      children = children.filter((e) => e.status === 'completed');

      if (children.length === 0) {
        return '没有待合并的已完成子Agent。';
      }

      let merged = 0;
      let conflicts = 0;
      const mergedDetails: string[] = [];
      const conflictDetails: string[] = [];

      for (const entry of children) {
        if (!entry.isolationId) {
          // 无 worktree（fresh 模式）— 直接标记完成
          board.markMerged(entry.agentId);
          merged++;
          mergedDetails.push(`${entry.agentId} (${entry.description}) — 无 worktree，跳过`);
          continue;
        }
        try {
          await enqueueIsolationOp(async () => {
            await exec('agent_isolation_merge', { agent_id: entry.isolationId });
            await exec('agent_isolation_discard', { agent_id: entry.isolationId }).catch(() => {});
          });
          board.markMerged(entry.agentId);
          merged++;
          mergedDetails.push(`${entry.agentId} (${entry.description}) — ✅ 已合并`);
        } catch (mergeErr: any) {
          conflicts++;
          const errMsg = mergeErr?.message || String(mergeErr);

          // 检查降级合并（worktree 元数据损坏但 diff 已保全）
          if (errMsg.startsWith('DEGRADED:')) {
            conflictDetails.push(`${entry.agentId} (${entry.description}): worktree 元数据损坏，diff 已降级提取`);
          } else {
            conflictDetails.push(`${entry.agentId} (${entry.description}): ${errMsg}`);
          }

          // 尽力而为：合并失败后仍尝试提取 diff
          try {
            await enqueueIsolationOp(async () => {
              await exec('agent_isolation_diff', { agent_id: entry.isolationId });
            });
          } catch { /* 尽力而为 */ }

          // 清理 worktree — 先 discard，失败则 force_purge 兜底
          await enqueueIsolationOp(async () => {
            try {
              await exec('agent_isolation_discard', { agent_id: entry.isolationId });
            } catch {
              // discard 失败 — 强制清除以清理注册表
              try {
                await exec('agent_isolation_force_purge', { agent_id: entry.isolationId });
              } catch { /* 尽力而为 */ }
            }
          });
        }
      }

      const parts: string[] = [`已合并 ${merged} 个子Agent，${conflicts} 个冲突。`];
      if (merged > 0 && conflicts > 0) {
        parts.push('⚠️ 部分合并已生效（不可逆）。已合并的变更已写入主仓，可用 git reset 回滚。');
      }
      if (mergedDetails.length > 0) {
        parts.push('\n已合并:\n' + mergedDetails.map((d) => `  ${d}`).join('\n'));
      }
      if (conflicts > 0) {
        parts.push('\n冲突:\n' + conflictDetails.map((d) => `  ${d}`).join('\n'));
        parts.push('\n冲突子Agent的 diff 已保存在 TaskBoard 中。请审阅后用 edit_file 把需要的部分手动应用到主仓。');
      }
      return parts.join('\n');
    },
  };
}
