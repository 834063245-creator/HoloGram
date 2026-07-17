// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { SubAgentHandle, SubAgentDoneCallback } from '../coordinator';
import type { Tool } from "../tool";


// ═══════════════════════════════════════════════════════════════
// Sub-Agent Tool — spawn a child Agent for parallel / delegated work
// ═══════════════════════════════════════════════════════════════

export type SubAgentSpawner = (
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode?: 'fork' | 'fresh',
  toolAllowlist?: string[] | null,
  signal?: AbortSignal, // ⚡ R4 fix: coordinator abort signal
) => Promise<{ text: string; err?: string }>;

export function createSubAgentTool(
  spawner: SubAgentSpawner,
  pool: import('../coordinator').SubAgentPool,
  onSubDone?: SubAgentDoneCallback,
): Tool {
  return {
    name: () => 'agent_spawn',
    description: () =>
      'Spawn a sub-agent with full tool access to handle a focused task. Omit subagent_type to fork (inherit parent context — DEFAULT, recommended). Set subagent_type to "fresh" for a clean-slate agent with no parent context. ⚠️ RULES: (1) You MUST verify your work — run cargo check / cargo test / npm run build before stopping. Do not pause or stop on first failure; fix → compile → repeat until zero errors. (2) Every edit_file call must be followed by verification.',
    parameters: () => ({
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the sub-agent task (3-5 words, used in progress display)',
        },
        prompt: {
          type: 'string',
          description: 'The task for the sub-agent to perform. Be specific about what to find or analyze.',
        },
        subagent_type: {
          type: 'string',
          description:
            'Omit to fork (inherit full context — DEFAULT). Set to "fresh" for a clean-slate sub-agent with no parent context.',
        },
        tool_allowlist: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of tool names the sub-agent is allowed to use. If omitted, all tools are available. Example: ["read_file", "search_content", "inspect_symbol"] for a read-only research agent.',
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
      if (!prompt) return '(agent_spawn: prompt is required)';
      const mode = subagentType ? 'fresh' : 'fork';
      const callId = (args['_callId'] as string) || `sub_${Date.now()}`;

      // All sub-agent spawns go through the pool — fire-and-forget, non-blocking.
      // The pool handles timeout (2 min default) and concurrency (max 5).
      // Results arrive asynchronously via injectTaskNotification.
      let subSignal: AbortSignal | undefined;
      const spawnId = pool.spawn(
        description,
        async (onMsg) => {
          const result = await spawner(description, prompt, onMsg, mode, toolAllowlist ?? null, subSignal);
          return result;
        },
        (chunk: string) => {
          onProgress?.(chunk);
        },
        callId,
        undefined, // timeoutMs — use pool default
        onSubDone,
      );
      if (spawnId) {
        subSignal = pool.getSubSignal(spawnId);
      }
      if (!spawnId) {
        return `无法启动子Agent：已达到并发上限（${pool.runningCount} 个正在运行）。请等待已有子Agent完成后再试，或用 agent_stop_all 批量停止。`;
      }
      return `Fork started — processing in background\n[task-notification: 子Agent "${description}" 已启动 (pool_id: ${spawnId})。可通过 agent_status("${spawnId}") 查询状态，结果将通过独立通知返回。]`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// agent_message — send follow-up instructions to a running sub-agent
// ═══════════════════════════════════════════════════════════════

export function createAgentMessageTool(pool?: import('../coordinator').SubAgentPool): Tool {
  return {
    name: () => 'agent_message',
    description: () =>
      '向运行中的子Agent发送后续指令。子Agent保留之前加载的上下文。仅对通过 agent_spawn 启动的异步子Agent有效。',
    parameters: () => ({
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '子Agent ID，由 agent_spawn 返回的 task_id',
        },
        message: {
          type: 'string',
          description: '后续指令或问题',
        },
      },
      required: ['to', 'message'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      if (!pool) return 'agent_message 不可用：未启用异步子Agent池。';
      const to = args['to'] as string;
      const message = args['message'] as string;
      if (!to || !message) return '需要 to 和 message 参数。';
      const ok = pool.sendMessage(to, message);
      return ok ? '消息已发送' : '子Agent未找到或已结束';
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// agent_status — 查询单个子Agent状态
// ═══════════════════════════════════════════════════════════════

export function createAgentStatusTool(pool?: import('../coordinator').SubAgentPool): Tool {
  return {
    name: () => 'agent_status',
    description: () =>
      '查询指定子Agent的运行状态。返回 status(running/completed/failed/stopped)、result 或 error。通过 agent_spawn 返回的 pool_id 查询。',
    parameters: () => ({
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '子Agent ID（agent_spawn 返回的 pool_id）',
        },
      },
      required: ['task_id'],
    }),
    readOnly: () => true,
    execute: async (args) => {
      if (!pool) return '子Agent池未初始化';
      const id = args['task_id'] as string;
      if (!id) return '需要 task_id 参数';
      const agents = (pool as any).agents as Map<string, any> | undefined;
      if (agents?.has(id)) {
        const pending = agents.get(id);
        return `状态: running — ${pending.handle.description} (已运行 ${Math.round((Date.now() - pending.handle.startedAt) / 1000)}s)`;
      }
      const completed = (pool as any).completed as Array<any> | undefined;
      if (completed) {
        const found = completed.find((h: any) => h.id === id);
        if (found) {
          if (found.status === 'completed') return `状态: completed — ${found.result || '(无输出)'}`;
          if (found.status === 'failed') return `状态: failed — ${found.error || found.result || '(未知错误)'}`;
          return `状态: ${found.status}`;
        }
      }
      return `未找到子Agent "${id}"。可能已超时清理或 ID 不正确。`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// agent_stop — 停止单个子Agent
// ═══════════════════════════════════════════════════════════════

export function createAgentStopTool(pool?: import('../coordinator').SubAgentPool): Tool {
  return {
    name: () => 'agent_stop',
    description: () =>
      '停止指定子Agent。通过 agent_spawn 返回的 pool_id 指定目标。返回是否成功。',
    parameters: () => ({
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '子Agent ID（agent_spawn 返回的 pool_id）',
        },
      },
      required: ['task_id'],
    }),
    readOnly: () => false,
    execute: async (args) => {
      if (!pool) return '子Agent池未初始化';
      const id = args['task_id'] as string;
      if (!id) return '需要 task_id 参数';
      const ok = pool.stop(id);
      return ok ? `已停止子Agent "${id}"` : `未找到运行中的子Agent "${id}"。可能已结束或 ID 不正确。`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// agent_stop_all — 批量停止所有子Agent
// ═══════════════════════════════════════════════════════════════

export function createAgentStopAllTool(getPool: () => import('../coordinator').SubAgentPool | null): Tool {
  return {
    name: () => 'agent_stop_all',
    description: () => '停止所有正在运行的子Agent。返回被停止的子Agent ID列表。无参数。',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => false,
    execute: async () => {
      const pool = getPool();
      if (!pool) return '子Agent池未初始化';
      const stopped = pool.stopAll();
      if (stopped.length === 0) return '没有运行中的子Agent';
      return `已停止 ${stopped.length} 个子Agent: ${stopped.join(', ')}`;
    },
  };
}