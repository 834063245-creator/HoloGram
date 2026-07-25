// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { SubAgentPool } from '../coordinator';
import type { Tool, ToolExecutor } from '../tool';
import { agentInvoke } from '../tool';

// ═══════════════════════════════════════════════════════════════
// Sub-Agent Tool — spawn a child Agent for parallel / delegated work
//
// 同步语义：agent_spawn 阻塞至子Agent完成，子Agent的最终报告就是工具结果。
// 并行方式：同一轮发多个 agent_spawn 调用（StreamingToolExecutor 并发执行）。
//
// 工具集：
//   - agent_spawn — 阻塞/异步派发子Agent
//   - agent_kill  — 停止运行中的子Agent（池级单体停止，幂等）
//
// 用户侧停止走 ChatPanel.abort → Agent.cascadeAbort → pool.stopAll。
// ═══════════════════════════════════════════════════════════════

export type SubAgentSpawner = (
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
  toolAllowlist?: string[] | null,
  signal?: AbortSignal, // pool 的中断信号 — 停/超时通过它杀死子Agent
  asyncMode?: boolean, // true = 非阻塞，立即返回 agentId，结果通过 bus 回来
  agentIdOverride?: string, // 显式指定子 Agent ID（异步模式必须，保证 LLM 拿到的 ID 与 board/bus 一致）
) => Promise<{ text: string; err?: string }>;

export function createSubAgentTool(spawner: SubAgentSpawner, pool: SubAgentPool): Tool {
  return {
    name: () => 'agent_spawn',
    description: () =>
      "Spawn a sub-agent to handle a focused, independent task. The call BLOCKS until the sub-agent finishes; its final report is returned as this tool's result. To run several tasks in parallel, emit multiple agent_spawn calls in a single turn. " +
      'Fork mode (default — omit subagent_type) injects your recent context so the sub-agent knows what you already did; set subagent_type="fresh" for a clean-slate agent. ' +
      'In fork mode, file edits run in an isolated git worktree and are auto-merged back on success; on merge conflict the diff is returned to you for manual application. In fresh mode, the sub-agent edits files directly in the working tree — ensure parallel fresh sub-agents have non-overlapping file scopes. ' +
      'Set async=true to spawn non-blocking — returns immediately with the sub-agent ID, and the result arrives via agent_message (type: "result"). Use agent_merge to merge all completed async sub-agents. ' +
      'Note: async sub-agents still occupy pool slots (max 5 concurrent). If the pool is full, spawn requests are queued (up to 20) and started as slots free up.',
    parameters: () => ({
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the sub-agent task (3-5 words, used in progress display)',
        },
        prompt: {
          type: 'string',
          description:
            'Complete, self-contained task directive for the sub-agent. Must include: what to do, which files to modify, and the expected outcome. Do NOT instruct the sub-agent to run builds or tests — it cannot do so (parallel build tools cause file-lock deadlocks). Verification is the parent agent\'s responsibility after all sub-agents finish. When spawning multiple sub-agents in parallel, give each a distinct, non-overlapping set of files to avoid write conflicts.',
        },
        subagent_type: {
          type: 'string',
          description:
            'Omit to fork (inherits your recent context — DEFAULT). Set to "fresh" for a clean-slate sub-agent.',
        },
        tool_allowlist: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of tool names the sub-agent is allowed to use. If omitted, all tools are available. Example: ["read_file", "search_content", "inspect_symbol"] for a read-only research agent.',
        },
        timeout_minutes: {
          type: 'number',
          description: 'Optional timeout override (default 30 minutes). The sub-agent is aborted when it exceeds this.',
        },
        async: {
          type: 'boolean',
          description:
            'If true, returns immediately with the sub-agent ID. The sub-agent runs in the background; its result arrives via agent_message (type: "result"). If false (default), blocks until the sub-agent finishes. Use agent_merge to merge completed async sub-agents.',
        },
      },
      required: ['description', 'prompt'],
    }),
    readOnly: () => false,
    execute: async (args, onProgress) => {
      const description = (args.description as string) || '子任务';
      const prompt = (args.prompt as string) || '';
      const subagentType = args.subagent_type as string | undefined;
      const toolAllowlist = args.tool_allowlist as string[] | undefined;
      const timeoutMinutes = args.timeout_minutes as number | undefined;
      const asyncMode = args.async === true;
      if (!prompt) return '(agent_spawn: prompt is required)';
      const mode = subagentType === 'fresh' ? 'fresh' : 'fork';
      const callId = (args._callId as string) || undefined;
      const timeoutMs = timeoutMinutes && timeoutMinutes > 0 ? Math.min(timeoutMinutes, 60) * 60 * 1000 : undefined;
      // Generate agent ID before pool.spawn so async mode can return it to the LLM.
      // This ID is used consistently across board, bus, and UI — the pool's internal
      // spawned.id is NOT exposed to the LLM.
      const agentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Pool registers the agent (concurrency cap + timeout + stop propagation),
      // then we BLOCK on its completion — the report becomes this tool's result.
      const spawned = pool.spawn(
        description,
        (signal) => spawner(description, prompt, onProgress, mode, toolAllowlist ?? null, signal, asyncMode, agentId),
        callId,
        timeoutMs,
      );
      if (!spawned) {
        return `无法启动子Agent：池已满且队列已满（最多 ${pool.runningCount} 个运行中 + 20 个排队）。请稍后重试。`;
      }

      // Register alias so agent_kill can find this agent by the model-visible id
      pool.registerAlias(agentId, spawned.id);

      // 异步模式：立即返回 agentId，子 Agent 在后台运行
      // 结果通过 bus 消息（type=result）通知父 Agent
      if (asyncMode) {
        if (pool.isQueued(spawned.id)) {
          return `子Agent已排队 (id: ${agentId})。将在有空闲槽位后启动。完成后通过消息通知你。`;
        }
        return `子Agent已启动 (id: ${agentId})。完成后将通过消息通知你。`;
      }

      // 阻塞模式（默认）：等待子 Agent 完成
      const handle = await spawned.done;
      if (handle.status === 'completed') {
        return handle.result || '(子Agent 没有生成回复)';
      }
      const reason = handle.error || handle.result || '(未知错误)';
      return `子Agent ${handle.status === 'stopped' ? '被停止' : '失败'}: ${reason}`;
    },
  };
}

/** agent_kill — stop a running sub-agent by ID.
 *  Idempotent: returns current status if already finished or not found.
 *  Only the parent agent can kill its own sub-agents (the pool is per-agent). */
export function createAgentKillTool(pool: SubAgentPool, isolationExec?: ToolExecutor): Tool {
  return {
    name: () => 'agent_kill',
    description: () =>
      'Stop a running sub-agent by its ID. The sub-agent is aborted and its pool slot is freed immediately. ' +
      'Use this to cancel long-running or stuck sub-agents. ' +
      'Idempotent: if the agent already finished or does not exist, returns its current status without error. ' +
      'Set worktree="discard" to also clean up the sub-agent\'s isolated worktree.',
    parameters: () => ({
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The sub-agent ID to kill (returned by agent_spawn with async=true)',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for killing the agent (for logging)',
        },
        worktree: {
          type: 'string',
          description: '"keep" (default) — leave the worktree intact for manual merge. "discard" — clean up the worktree.',
        },
      },
      required: ['agent_id'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      const agentId = args.agent_id as string;
      const reason = args.reason as string | undefined;
      const worktree = (args.worktree as string) ?? 'keep';

      // Try to stop the running agent
      const stopped = pool.stop(agentId);

      if (stopped) {
        let msg = `子Agent ${agentId} 已停止`;
        if (reason) msg += ` (原因: ${reason})`;
        if (worktree === 'discard' && isolationExec) {
          try {
            await isolationExec('agent_isolation_discard', { agent_id: agentId });
            msg += '，worktree 已清理';
          } catch {
            msg += '，worktree 清理失败（best-effort）';
          }
        }
        return msg;
      }

      // Not running — check completed history for idempotent response
      const handle = pool.getHandle(agentId);
      if (handle) {
        return `子Agent ${agentId} 当前状态: ${handle.status}（无需停止）`;
      }

      return `子Agent ${agentId} 不存在（可能已完成并清理）`;
    },
  };
}
