// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { z } from 'zod';
import type { SubAgentPool } from '../coordinator';
import { getSubAgentActivity, STUCK_THRESHOLD_S } from '../subagent-activity';
import type { Tool, ToolExecutor } from '../tool';
import { agentInvoke } from '../tool';
import { defineTool } from './define-tool';
import {
  assertSupportedSchema,
  buildOutputSchemaInstruction,
  extractJsonObject,
  validateObjectJsonSchema,
  type JsonSchema,
} from '../schema-validate';

// ═══════════════════════════════════════════════════════════════
// Sub-Agent 工具 — 派发子 Agent 执行并行/委派任务
//
// 同步语义：agent_spawn 阻塞至子Agent完成，子Agent的最终报告就是工具结果。
// 并行方式：同一轮发多个 agent_spawn 调用（StreamingToolExecutor 并发执行）。
//
// 工具集：
//   - agent_spawn  — 阻塞/异步派发子Agent
//   - agent_kill   — 停止运行中的子Agent（池级单体停止，幂等）
//   - agent_status — 运行中子Agent 状态（当前工具/等待时长/最近事件，标记疑似卡死）
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
  outputSchema?: Record<string, unknown> | null, // 结构化返回 schema（仅同步模式）
) => Promise<{ text: string; err?: string }>;

export function createSubAgentTool(spawner: SubAgentSpawner, pool: SubAgentPool): Tool {
  return defineTool({
    name: 'agent_spawn',
    description:
      "Spawn a sub-agent to handle a focused, independent task. The call BLOCKS until the sub-agent finishes; its final report is returned as this tool's result. To run several tasks in parallel, emit multiple agent_spawn calls in a single turn. " +
      'Fork mode (default — omit subagent_type) injects your recent context so the sub-agent knows what you already did; set subagent_type="fresh" for a clean-slate agent. ' +
      'In fork mode, file edits run in an isolated git worktree and are auto-merged back on success; on merge conflict the diff is returned to you for manual application. In fresh mode, the sub-agent edits files directly in the working tree — ensure parallel fresh sub-agents have non-overlapping file scopes. ' +
      'Set async=true to spawn non-blocking — returns immediately with the sub-agent ID, and the result arrives via agent_message (type: "result"). Use agent_merge to merge all completed async sub-agents. ' +
      'Set output_schema to require a structured JSON result: the sub-agent is instructed to reply with a single JSON object matching the schema (supported keywords: type/properties/required/additionalProperties/items/enum/const/oneOf), and the validated JSON is returned as this tool\'s result. output_schema is supported in blocking mode only. ' +
      'Note: async sub-agents still occupy pool slots (max 5 concurrent). If the pool is full, spawn requests are queued (up to 20) and started as slots free up.',
    schema: z.object({
      description: z.string().describe('Short label for the sub-agent task (3-5 words, used in progress display)'),
      prompt: z
        .string()
        .describe(
          'Complete, self-contained task directive for the sub-agent. Must include: what to do, which files to modify, and the expected outcome. Do NOT instruct the sub-agent to run builds or tests — it cannot do so (parallel build tools cause file-lock deadlocks). Verification is the parent agent\'s responsibility after all sub-agents finish. When spawning multiple sub-agents in parallel, give each a distinct, non-overlapping set of files to avoid write conflicts.',
        ),
      subagent_type: z
        .enum(['fresh', 'fork'])
        .optional()
        .describe(
          'Omit to fork (inherits your recent context — DEFAULT). Set to "fresh" for a clean-slate sub-agent.',
        ),
      tool_allowlist: z
        .array(z.string())
        .optional()
        .describe(
          'Optional list of tool names the sub-agent is allowed to use. If omitted, all tools are available. Example: ["read_file", "search_content", "inspect_symbol"] for a read-only research agent.',
        ),
      timeout_minutes: z
        .coerce.number()
        .max(60)
        .optional()
        .describe('Optional timeout override (default 30 minutes). The sub-agent is aborted when it exceeds this.'),
      async: z
        .boolean()
        .optional()
        .describe(
          'If true, returns immediately with the sub-agent ID. The sub-agent runs in the background; its result arrives via agent_message (type: "result"). If false (default), blocks until the sub-agent finishes. Use agent_merge to merge completed async sub-agents.',
        ),
      output_schema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Optional JSON Schema (object-rooted) the sub-agent result must satisfy. Supported keywords: type/properties/required/additionalProperties/items/enum/const/oneOf. Only valid in blocking mode (async=false). The validated JSON object is returned as the tool result.',
        ),
    }),
    execute: async (args, onProgress) => {
      const description = args.description || '子任务';
      const prompt = args.prompt;
      // zod enum 已保证 subagent_type 只可能是 'fresh' | 'fork' — 省略时默认 fork
      const mode = args.subagent_type ?? 'fork';
      const toolAllowlist = args.tool_allowlist;
      const timeoutMinutes = args.timeout_minutes;
      const asyncMode = args.async === true;
      const outputSchema = args.output_schema;
      if (!prompt) return '(agent_spawn: prompt is required)';
      // output_schema 仅支持同步模式 — 异步结果经 bus 文本投递，结构化契约无从校验；
      // 不支持组合在派发前拒绝（fail loud，不静默降级）
      if (outputSchema && asyncMode) {
        return '(agent_spawn: output_schema 仅支持阻塞模式（async=false）— 异步结果经消息文本投递，无法保证结构化契约）';
      }
      if (outputSchema) {
        const schemaErr = assertSupportedSchema(outputSchema);
        if (schemaErr) return `(agent_spawn: output_schema 不受支持 — ${schemaErr})`;
      }
      // _callId 由 streaming-executor 注入（不进 schema，passthrough 透传）
      const callId = (args as { _callId?: string })._callId || undefined;
      const timeoutMs = timeoutMinutes && timeoutMinutes > 0 ? timeoutMinutes * 60 * 1000 : undefined;
      // 在 pool.spawn 之前生成 agent ID，以便异步模式能将其返回给 LLM。
      // 此 ID 在 board、bus 和 UI 中一致使用 — pool 内部的
      // spawned.id 不会暴露给 LLM。
      const agentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Pool 注册 agent（并发上限 + 超时 + 停止传播），
      // 然后阻塞等待其完成 — 报告即为此工具的结果。
      const spawned = pool.spawn(
        description,
        (signal) =>
          spawner(
            description,
            prompt,
            onProgress,
            mode,
            toolAllowlist ?? null,
            signal,
            asyncMode,
            agentId,
            outputSchema ?? null,
          ),
        callId,
        timeoutMs,
      );
      if (!spawned) {
        return `无法启动子Agent：池已满且队列已满（最多 ${pool.runningCount} 个运行中 + 20 个排队）。请稍后重试。`;
      }

      // 注册别名，使 agent_kill 能通过模型可见 id 找到此 agent
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
        const raw = handle.result || '(子Agent 没有生成回复)';
        if (!outputSchema) return raw;
        // 结构化返回：解析 + 校验。失败不静默 — 原文带回，附明确的校验错误
        const parsed = extractJsonObject(raw);
        if (parsed === undefined) {
          return `(agent_spawn: output_schema 校验失败 — 子 Agent 回复中找不到 JSON 对象。原文：\n${raw})`;
        }
        const valErr = validateObjectJsonSchema(parsed, outputSchema as JsonSchema);
        if (valErr) {
          return `(agent_spawn: output_schema 校验失败 — ${valErr}。原文：\n${raw})`;
        }
        return JSON.stringify(parsed, null, 2);
      }
      const reason = handle.error || handle.result || '(未知错误)';
      return `子Agent ${handle.status === 'stopped' ? '被停止' : '失败'}: ${reason}`;
    },
  });
}

/** agent_kill — 按 ID 停止运行中的子 Agent。
 *  幂等：若已结束或未找到，返回当前状态。
 *  只有父 Agent 能停止自己的子 Agent（pool 是 per-agent 的）。 */
export function createAgentKillTool(pool: SubAgentPool, isolationExec?: ToolExecutor): Tool {
  return defineTool({
    name: 'agent_kill',
    description:
      'Stop a running sub-agent by its ID. The sub-agent is aborted and its pool slot is freed immediately. ' +
      'Use this to cancel long-running or stuck sub-agents. ' +
      'Idempotent: if the agent already finished or does not exist, returns its current status without error. ' +
      'Set worktree="discard" to also clean up the sub-agent\'s isolated worktree.',
    schema: z.object({
      agent_id: z.string().describe('The sub-agent ID to kill (returned by agent_spawn with async=true)'),
      reason: z.string().optional().describe('Optional reason for killing the agent (for logging)'),
      worktree: z
        .enum(['keep', 'discard'])
        .optional()
        .default('keep')
        .describe('"keep" (default) — leave the worktree intact for manual merge. "discard" — clean up the worktree.'),
    }),
    execute: async (args) => {
      const agentId = args.agent_id;
      const reason = args.reason;
      const worktree = args.worktree;

      // 尝试停止运行中的 agent
      const stopped = pool.stop(agentId);

      if (stopped) {
        let msg = `子Agent ${agentId} 已停止`;
        if (reason) msg += ` (原因: ${reason})`;
        // worktree 清理由 agent.ts 中的中断路径处理，
        // 该路径会用正确的 isolationId (agent-...) 调用 agent_isolation_discard。
        // worktree 参数仅供 informational — 停止时自动 discard。
        if (worktree === 'discard') {
          msg += '，worktree 将由中断路径自动清理';
        }
        return msg;
      }

      // 未在运行 — 查询已完成历史以返回幂等响应
      const handle = pool.getHandle(agentId);
      if (handle) {
        return `子Agent ${agentId} 当前状态: ${handle.status}（无需停止）`;
      }

      return `子Agent ${agentId} 不存在（可能已完成并清理）`;
    },
  });
}

/** agent_status — 运行中子Agent 的可观测状态（只读）。
 *  对每个运行中的子Agent 报告：模型可见 id、描述、总耗时、当前正在执行的工具
 *  （或 null）、该工具已等待秒数（或 null）、距最近一次事件的秒数。
 *  两个卡死信号：工具等待超过 STUCK_THRESHOLD_S 秒，或超过 STUCK_THRESHOLD_S
 *  秒无任何事件（长生成会持续流 Text 事件，活跃生成不会误报）——标记
 *  ⚠️ 疑似卡死，配合 agent_kill 形成「看见 → 杀掉」闭环。
 *  活动数据来自 subagent-activity.ts 的事件旁路。 */
export function createAgentStatusTool(pool: SubAgentPool): Tool {
  return defineTool({
    name: 'agent_status',
    description:
      'Report the live status of each running sub-agent: id, description, total elapsed time, the tool call currently executing (if any), how long that call has been waiting, and seconds since its last event. ' +
      'Use this to tell a slow sub-agent apart from a stuck one before deciding to kill it — two signals are flagged as suspected-stuck (⚠️): a tool call waiting over 120s, and no events at all for over 120s (long generations stream text events, so an actively-generating sub-agent will not trip the second one). ' +
      'Read-only. Combine with agent_kill to stop stuck sub-agents.',
    schema: z.object({}),
    readOnly: true,
    execute: async () => {
      const running = pool.listRunning();
      if (running.length === 0) return '当前没有运行中的子Agent。';
      const now = Date.now();
      const lines: string[] = [`运行中的子Agent (${running.length} 个):`];
      for (const h of running) {
        const elapsedS = Math.max(0, Math.round((now - h.startedAt) / 1000));
        const act = getSubAgentActivity(h.id);
        const currentTool = act?.currentTool ?? null;
        const toolWaitS =
          currentTool && act?.toolStartedAt != null ? Math.max(0, Math.round((now - act.toolStartedAt) / 1000)) : null;
        const lastEventS = act ? Math.max(0, Math.round((now - act.lastEventAt) / 1000)) : null;
        const stuckTool = toolWaitS !== null && toolWaitS > STUCK_THRESHOLD_S;
        const stuckQuiet = lastEventS !== null && lastEventS > STUCK_THRESHOLD_S;
        lines.push(`- ${h.id} 「${h.description}」 已运行 ${elapsedS}s`);
        if (currentTool) {
          lines.push(`  当前工具: ${currentTool}（已等待 ${toolWaitS ?? 0}s）${stuckTool ? ' ⚠️ 疑似卡死' : ''}`);
        } else {
          lines.push('  当前工具: 无（未在执行工具调用）');
        }
        lines.push(
          `  最近事件: ${lastEventS !== null ? `${lastEventS}s 前` : '暂无记录'}${stuckQuiet ? ` ⚠️ 疑似卡死（${STUCK_THRESHOLD_S}s 无事件）` : ''}`,
        );
      }
      return lines.join('\n');
    },
  });
}
