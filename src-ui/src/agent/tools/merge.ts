// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent_merge — 统一合并工具
//
// 父 Agent 调用此工具，将所有已完成的异步子 Agent 的 worktree 串行合并回主仓。
// 冲突时保全 diff（已在 TaskBoard 上），清理 worktree，让父 Agent 手动应用。
//
// git 是安全网：merge 出问题可以 git reset 回滚。

import type { TaskBoard, BoardEntry } from '../task-board';
import type { Tool, ToolExecutor } from '../tool';
import { enqueueIsolationOp } from '../isolation-queue';
import { runGraphGate, runCompileTest } from './merge-gate';

// ── Merge 门禁配置 ──
// v1：图检查默认开（merge-then-verify，轮询 hologram_run_check）；
// 编译测试默认关（worktree 冷构建可达分钟级，时间盒限制）。
// 测试旁路：(window as any).__HOLOGRAM_MERGE_GATE__ = { graph: false } 可临时关闭。
const MERGE_GATE = { graph: true, compileTest: false, maxCheckWaitMs: 60_000, compileTimeoutMs: 600_000 };
function effectiveGate(): typeof MERGE_GATE {
  const override = (globalThis as any).__HOLOGRAM_MERGE_GATE__;
  return override ? { ...MERGE_GATE, ...override } : MERGE_GATE;
}

export function createMergeTool(
  board: TaskBoard,
  getAgentId: () => string,
  exec: ToolExecutor,
  opts: { projectPath: string },
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

      const gate = effectiveGate();
      const gateOpts = { projectPath: opts.projectPath, exec };

      // 批量 merge：成功合并的条目先收集，图检查在循环后统一跑一次 —
      // runGraphGate 是整图分析（不依赖单个 entry），逐条跑 N 次 = N 次全图扫描 + N 次轮询，
      // 批量场景（5 Agent）会被放大成分钟级。统一一次：5× 全图 → 1×。
      const mergedEntries: BoardEntry[] = [];

      for (const entry of children) {
        if (!entry.isolationId) {
          // 无 worktree（fresh 模式）— 直接标记完成
          board.markMerged(entry.agentId);
          merged++;
          mergedDetails.push(`${entry.agentId} (${entry.description}) — 无 worktree，跳过`);
          continue;
        }
        // 门禁处理开始 — 顺延全部未合并条目的 TTL，防止 LifecycleManager 30min 巡检
        // 在门禁（图检查秒级/编译分钟级）中途误 discard worktree
        for (const pending of children) {
          if (pending.status === 'completed' && pending.isolationId) board.touch(pending.agentId);
        }
        try {
          // ① 可选编译测试（worktree 内，merge 前 — 唯一有意义的 pre-merge 检查）
          if (gate.compileTest) {
            const ct = await runCompileTest(entry, gateOpts);
            if (!ct.passed) {
              // 编译测试失败：不 merge，discard worktree（diff 已保全在 board complete() 时）
              await enqueueIsolationOp(async () => {
                await exec('agent_isolation_discard', { agent_id: entry.isolationId }).catch(() => {});
              });
              board.fail(entry.agentId, '[门禁] ' + ct.report);
              conflicts++;
              conflictDetails.push(`${entry.agentId} (${entry.description}): ${ct.report}`);
              continue;
            }
          }

          // ② merge（cherry-pick 进主仓）— 收集条目，图检查在循环后统一跑一次
          await enqueueIsolationOp(async () => {
            await exec('agent_isolation_merge', { agent_id: entry.isolationId });
            await exec('agent_isolation_discard', { agent_id: entry.isolationId }).catch(() => {});
          });
          mergedEntries.push(entry);
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

      // ③ merge-then-verify：图检查 — 批量统一跑一次（而非逐条）
      // runGraphGate 是整图分析（只依赖 projectPath/exec），一次即可覆盖所有已 merge 的变更；
      // watcher 已增量分析主仓，轮询 run_check 直到非 quiet。
      // 门禁定位：信息报告，不是裁决 — L5 红线是启发式有噪音，
      // 失败只标记 + 报告，改动保留在主仓（commit 在历史），主 Agent 决定修复/revert/接受。
      if (gate.graph && mergedEntries.length > 0) {
        const gateResult = await runGraphGate(mergedEntries[0], gateOpts);
        if (!gateResult.passed) {
          for (const entry of mergedEntries) {
            board.fail(entry.agentId, '[门禁] ' + gateResult.report);
          }
          conflicts += mergedEntries.length;
          conflictDetails.push(
            `${mergedEntries.map((e) => e.agentId).join(', ')}: 门禁未通过，改动已保留在主仓，请审阅后决定修复 / git revert / 接受\n${gateResult.report}`,
          );
        } else {
          for (const entry of mergedEntries) {
            board.markMerged(entry.agentId);
            merged++;
            mergedDetails.push(`${entry.agentId} (${entry.description}) — ✅ 已合并`);
          }
        }
      } else {
        for (const entry of mergedEntries) {
          board.markMerged(entry.agentId);
          merged++;
          mergedDetails.push(`${entry.agentId} (${entry.description}) — ✅ 已合并`);
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
