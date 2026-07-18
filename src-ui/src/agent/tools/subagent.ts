// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { SubAgentPool } from '../coordinator';
import type { Tool } from '../tool';

// ═══════════════════════════════════════════════════════════════
// Sub-Agent Tool — spawn a child Agent for parallel / delegated work
//
// 同步语义：agent_spawn 阻塞至子Agent完成，子Agent的最终报告就是工具结果。
// 并行方式：同一轮发多个 agent_spawn 调用（StreamingToolExecutor 并发执行）。
// 不再有"后台运行 + 通知注入"模式——结果不再绕道远不如直接返回可靠。
//
// 注：同步语义下不存在"模型可查/可停的运行中子Agent"（每次 spawn 都阻塞到
// 结束），因此没有 agent_status / agent_stop 工具；用户侧停止走
// ChatPanel.abort → Agent.cascadeAbort → pool.stopAll。
// ═══════════════════════════════════════════════════════════════

export type SubAgentSpawner = (
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
  toolAllowlist?: string[] | null,
  signal?: AbortSignal, // pool 的中断信号 — 停/超时通过它杀死子Agent
) => Promise<{ text: string; err?: string }>;

export function createSubAgentTool(spawner: SubAgentSpawner, pool: SubAgentPool): Tool {
  return {
    name: () => 'agent_spawn',
    description: () =>
      "Spawn a sub-agent to handle a focused, independent task. The call BLOCKS until the sub-agent finishes; its final report is returned as this tool's result. To run several tasks in parallel, emit multiple agent_spawn calls in a single turn. " +
      'Fork mode (default — omit subagent_type) injects your recent context so the sub-agent knows what you already did; set subagent_type="fresh" for a clean-slate agent. ' +
      'File edits run in an isolated git worktree and are auto-merged back on success; on merge conflict the diff is returned to you for manual application. ' +
      'Give the sub-agent a complete, self-contained directive: what to do, which files, and how to verify (e.g. run cargo check / npm test before finishing).',
    parameters: () => ({
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the sub-agent task (3-5 words, used in progress display)',
        },
        prompt: {
          type: 'string',
          description: 'Complete, self-contained task directive for the sub-agent.',
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
          description: 'Optional timeout override (default 10 minutes). The sub-agent is aborted when it exceeds this.',
        },
      },
      required: ['description', 'prompt'],
    }),
    readOnly: () => false,
    execute: async (args, onProgress) => {
      const description = (args['description'] as string) || '子任务';
      const prompt = (args['prompt'] as string) || '';
      const subagentType = args['subagent_type'] as string | undefined;
      const toolAllowlist = args['tool_allowlist'] as string[] | undefined;
      const timeoutMinutes = args['timeout_minutes'] as number | undefined;
      if (!prompt) return '(agent_spawn: prompt is required)';
      const mode = subagentType === 'fresh' ? 'fresh' : 'fork';
      const callId = (args['_callId'] as string) || undefined;
      const timeoutMs = timeoutMinutes && timeoutMinutes > 0 ? Math.min(timeoutMinutes, 60) * 60 * 1000 : undefined;

      // Pool registers the agent (concurrency cap + timeout + stop propagation),
      // then we BLOCK on its completion — the report becomes this tool's result.
      const spawned = pool.spawn(
        description,
        (signal) => spawner(description, prompt, onProgress, mode, toolAllowlist ?? null, signal),
        callId,
        timeoutMs,
      );
      if (!spawned) {
        return `无法启动子Agent：已达到并发上限（${pool.runningCount} 个正在运行）。先等本轮其他 agent_spawn 完成，或下一轮再试。`;
      }
      const handle = await spawned.done;
      if (handle.status === 'completed') {
        return handle.result || '(子Agent 没有生成回复)';
      }
      const reason = handle.error || handle.result || '(未知错误)';
      return `子Agent ${handle.status === 'stopped' ? '被停止' : '失败'}: ${reason}`;
    },
  };
}
