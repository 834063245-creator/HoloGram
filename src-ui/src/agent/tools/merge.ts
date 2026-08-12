// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent_merge — 统一合并工具
//
// 父 Agent 调用此工具，将所有已完成的异步子 Agent 的 worktree 串行合并回主仓。
// 冲突时保全现场（diff 写回 TaskBoard + worktree 保留），让父 Agent 手动处理。
//
// git 是安全网：merge 出问题可以 git reset 回滚。
//
// 2026-08-13 事故修复（R3/R9/R10）：
// - 冲突后重抓的 diff 写回 board（此前返回值被丢弃，「diff 已保全」名存实亡），
//   且冲突 worktree 保留不删（diff 有 32KB 截断，worktree 是全量现场）。
// - fresh/降级条目（无 worktree）不计入「已合并 N 个」——0 内容落地不能报合并。
// - merge 返回文本据实转述（commit hash / 清理告警 / 无产出），无产出不报 ✅。
// - 同轮并发 agent_merge 串行化，消除「第二个 merge 撞假冲突」。

import { z } from 'zod';
import type { TaskBoard, BoardEntry } from '../task-board';
import type { Tool, ToolExecutor } from '../tool';
import { enqueueIsolationOp } from '../isolation-queue';
import { runGraphGate, runCompileTest } from './merge-gate';
import { defineTool } from './define-tool';

// ── Merge 门禁配置 ──
// v1：图检查默认开（merge-then-verify，轮询 hologram_run_check）；
// 编译测试默认关（worktree 冷构建可达分钟级，时间盒限制）。
// 测试旁路：(window as any).__HOLOGRAM_MERGE_GATE__ = { graph: false } 可临时关闭。
const MERGE_GATE = { graph: true, compileTest: false, maxCheckWaitMs: 60_000, compileTimeoutMs: 600_000 };
function effectiveGate(): typeof MERGE_GATE {
  const override = (globalThis as any).__HOLOGRAM_MERGE_GATE__;
  return override ? { ...MERGE_GATE, ...override } : MERGE_GATE;
}

/** merge 返回文本（Rust agent_isolation.rs 的契约子串）— 无产出判定 */
const NO_CHANGES_MARK = '没有变更需要合并';

export function createMergeTool(
  board: TaskBoard,
  getAgentId: () => string,
  exec: ToolExecutor,
  opts: { projectPath: string },
): Tool {
  // R10：同轮并发 agent_merge 串行化。两个 merge 同时读 completed 条目会
  // 一个成功、另一个撞「没有活跃的隔离环境」报假冲突；串行后第二个看到
  // 已更新的 board 状态，据实报「没有待合并」。
  let mergeChain: Promise<string> = Promise.resolve('');

  const doMerge = async (args: { agent_ids?: string[] }): Promise<string> => {
    const agentIds = args.agent_ids;
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
    // 无产出（worktree 无变更）与无 worktree（fresh/降级）— 单列，不计入已合并
    const noArtifactDetails: string[] = [];

    const gate = effectiveGate();
    const gateOpts = { projectPath: opts.projectPath, exec };

    // 批量 merge：成功合并的条目先收集，图检查在循环后统一跑一次 —
    // runGraphGate 是整图分析（不依赖单个 entry），逐条跑 N 次 = N 次全图扫描 + N 次轮询，
    // 批量场景（5 Agent）会被放大成分钟级。统一一次：5× 全图 → 1×。
    const mergedEntries: BoardEntry[] = [];
    const mergedTexts = new Map<string, string>(); // agentId → merge 返回文本（commit hash 等）

    for (const entry of children) {
      if (!entry.isolationId) {
        // 无 worktree（fresh 模式，或 fork 隔离创建失败的降级态）— 改动本就直写主仓，
        // 没有可合并的产物。不计入「已合并」，避免「0 内容落地却报已合并 N 个」。
        board.markMerged(entry.agentId);
        noArtifactDetails.push(
          `${entry.agentId} (${entry.description}) — 无 worktree（fresh/降级），改动本就直接在主仓，无合并动作`,
        );
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
        const mergeText = await enqueueIsolationOp(async () => {
          const text = await exec('agent_isolation_merge', { agent_id: entry.isolationId });
          await exec('agent_isolation_discard', { agent_id: entry.isolationId }).catch(() => {});
          return text;
        });
        // 无产出判定：merge 据实返回「没有变更需要合并」→ 不得报已合并（假成功
        // 会掩盖子 Agent 零产出，2026-08-13 事故 A1）
        if (mergeText.includes(NO_CHANGES_MARK)) {
          board.markMerged(entry.agentId); // worktree 已被 Rust 侧移除，条目收口
          noArtifactDetails.push(
            `${entry.agentId} (${entry.description}) — ⚠️ 无产出：worktree 没有任何变更，未合并任何内容；请核实该子 Agent 是否真正完成了任务`,
          );
        } else {
          mergedEntries.push(entry);
          mergedTexts.set(entry.agentId, mergeText);
        }
      } catch (mergeErr: any) {
        conflicts++;
        const errMsg = mergeErr?.message || String(mergeErr);

        // 检查降级合并（worktree 元数据损坏但 diff 已保全）
        if (errMsg.startsWith('DEGRADED:')) {
          conflictDetails.push(`${entry.agentId} (${entry.description}): worktree 元数据损坏，diff 已降级提取`);
        } else {
          conflictDetails.push(`${entry.agentId} (${entry.description}): ${errMsg}`);
        }

        // R3 冲突保全：重抓 diff 并**写回 board**（此前返回值直接丢弃，
        // 「diff 已保存在 TaskBoard」名存实亡）；worktree 保留不删 ——
        // diff 有 32KB 截断，worktree 才是全量现场。
        try {
          const freshDiff = await enqueueIsolationOp(async () => {
            return await exec('agent_isolation_diff', { agent_id: entry.isolationId });
          });
          if (freshDiff && freshDiff.length > (entry.diff?.length ?? 0)) {
            board.complete(entry.agentId, entry.summary ?? '', freshDiff);
          }
        } catch {
          /* 尽力而为 — board 上仍有 complete() 时抓的 diff */
        }
        conflictDetails.push(
          `  ↳ worktree 已保留（隔离 id: ${entry.isolationId}）。可用 agent_isolation_diff 查看全量 diff，` +
            '或解决冲突后 agent_isolation_merge 重试，确认放弃则 agent_isolation_discard',
        );
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
          mergedDetails.push(`${entry.agentId} (${entry.description}) — ✅ ${mergedTexts.get(entry.agentId) ?? '已合并'}`);
        }
      }
    } else {
      for (const entry of mergedEntries) {
        board.markMerged(entry.agentId);
        merged++;
        mergedDetails.push(`${entry.agentId} (${entry.description}) — ✅ ${mergedTexts.get(entry.agentId) ?? '已合并'}`);
      }
    }

    const parts: string[] = [`已合并 ${merged} 个子Agent，${conflicts} 个冲突。`];
    if (merged > 0 && conflicts > 0) {
      parts.push('⚠️ 部分合并已生效（不可逆）。已合并的变更已写入主仓，可用 git reset 回滚。');
    }
    if (mergedDetails.length > 0) {
      parts.push('\n已合并:\n' + mergedDetails.map((d) => `  ${d}`).join('\n'));
    }
    if (noArtifactDetails.length > 0) {
      parts.push('\n无合并产物（不计入已合并）:\n' + noArtifactDetails.map((d) => `  ${d}`).join('\n'));
    }
    if (conflicts > 0) {
      parts.push('\n冲突:\n' + conflictDetails.map((d) => `  ${d}`).join('\n'));
      parts.push(
        '\n冲突子Agent的 worktree 已保留（见各条目隔离 id），diff 在 TaskBoard。' +
          '用 agent_isolation_diff 查看全量后手动应用，或解决冲突后 agent_isolation_merge 重试。',
      );
    }
    return parts.join('\n');
  };

  return defineTool({
    name: 'agent_merge',
    description:
      'Merge completed sub-agent worktrees back into the main repository. ' +
      'Reviews all pending changes from the TaskBoard, merges them sequentially. ' +
      'On conflict, preserves the worktree and diff for manual application.',
    schema: z.object({
      agent_ids: z
        .array(z.string())
        .optional()
        .describe('Sub-agent IDs to merge. If omitted, merges all completed sub-agents.'),
    }),
    execute: (args) => {
      const p = mergeChain.then(() => doMerge(args), () => doMerge(args));
      mergeChain = p.catch(() => '');
      return p;
    },
  });
}
