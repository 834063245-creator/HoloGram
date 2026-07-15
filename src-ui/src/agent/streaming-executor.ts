// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Streaming tool executor — execute tool calls as they arrive from the stream.
// Instead of waiting for the entire stream to finish before executing tools,
// this starts execution immediately when a tool_use block is complete.
//
// Hooks (GraphContextHook / PreflightHook) are run here — preflight before
// execution, post-tool enrichment after — so they aren't bypassed by streaming.
//
// CC ref: StreamingToolExecutor, query.ts:1366-1408

import type { ToolCall } from '../provider/types';
import { type AgentEvent, EventKind } from './agent-types';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import type { Tool, ToolRegistry } from './tool';

export interface ExecutorToolCall {
  call: ToolCall;
  tool: Tool;
}

interface PendingResult {
  call: ToolCall;
  output: string;
  err?: string;
  truncated: boolean;
}

const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

function truncateToolOutput(s: string, toolName?: string): { body: string; truncMsg?: string } {
  if (s.length <= MAX_TOOL_OUTPUT_BYTES) return { body: s };
  const keep = Math.floor(MAX_TOOL_OUTPUT_BYTES / 2);
  const head = snapToRune(s, 0, keep);
  const tail = snapToRune(s, s.length - keep, s.length);
  const omitted = s.length - head.length - tail.length;
  return {
    body: `${head}\n\n…[截断 ${omitted} / ${s.length} 字节]…\n💡 用更精确的参数重新调用此工具\n\n${tail}`,
    truncMsg: `tool output truncated: ${omitted} of ${s.length} bytes elided (${toolName || 'unknown'})`,
  };
}

function snapToRune(s: string, lo: number, hi: number): string {
  while (lo > 0 && (s.charCodeAt(lo) & 0xc0) === 0x80) lo--;
  while (hi < s.length && (s.charCodeAt(hi) & 0xc0) === 0x80) hi++;
  return s.slice(lo, hi);
}

/**
 * StreamingToolExecutor — manages concurrent tool execution during stream.
 *
 * Usage in the agent loop:
 *   const executor = new StreamingToolExecutor(tools, emitEvent, hooks, preflightHooks);
 *   for await (const chunk of stream) {
 *     if chunk is ToolCall → executor.addTool(chunk.tool_call);
 *     // poll completed results each iteration
 *     for (const result of executor.pollCompleted()) {
 *       results.push(result);
 *     }
 *   }
 *   // stream ended — collect remaining
 *   for await (const result of executor.awaitRemaining()) {
 *     results.push(result);
 *   }
 */
export class StreamingToolExecutor {
  private tools: ToolRegistry;
  private emit: (ev: AgentEvent) => void;
  private hooks: HookRegistry | null;
  private preflightHooks: PreflightHookRegistry | null;
  private pending = new Map<string, Promise<PendingResult>>();
  private completed: PendingResult[] = [];
  private toolIndex = 0;
  /** Track dispatched tool IDs to prevent duplicate dispatch on stream retry. */
  private dispatchedIds = new Set<string>();

  private agentId: string | null;

  constructor(
    tools: ToolRegistry,
    emitEvent: (ev: AgentEvent) => void,
    hooks?: HookRegistry | null,
    preflightHooks?: PreflightHookRegistry | null,
    agentId?: string | null,
  ) {
    this.tools = tools;
    this.emit = emitEvent;
    this.hooks = hooks ?? null;
    this.preflightHooks = preflightHooks ?? null;
    this.agentId = agentId ?? null;
  }

  /** Add a tool call from the stream. Execution starts immediately.
   *  Skips tool IDs already dispatched (can happen on stream retry). */
  addTool(call: ToolCall): void {
    if (this.dispatchedIds.has(call.id)) return;
    this.dispatchedIds.add(call.id);
    const tool = this.tools.get(call.name);
    const idx = this.toolIndex++;

    // Emit dispatch event
    this.emit({
      kind: EventKind.ToolDispatch,
      tool: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        read_only: tool?.readOnly() ?? false,
        partial: false,
      },
    });

    if (!tool) {
      this.completed.push({
        call,
        output: `error: unknown tool "${call.name}"`,
        err: `unknown tool "${call.name}"`,
        truncated: false,
      });
      return;
    }

    // Start execution immediately — don't wait for stream to end
    const promise = this.executeTool(call, tool, idx);
    this.pending.set(call.id, promise);
  }

  /** Poll for completed results. Non-blocking — returns whatever is ready. */
  pollCompleted(): PendingResult[] {
    const ready: PendingResult[] = [];
    // Check each pending promise — if done, move to completed
    for (const [id, promise] of this.pending) {
      // ponytail: Promise.race with a resolved promise to check if done.
      // We can't truly poll a Promise, so we use a marker.
      // Instead, we rely on awaitRemaining() for the final collection.
      // pollCompleted() returns results that have already resolved in completed[].
    }
    // Return what's already completed (from sync errors or previously resolved)
    const results = [...this.completed];
    this.completed = [];
    // Mark which IDs are done
    for (const r of results) {
      this.pending.delete(r.call.id);
    }
    return results;
  }

  /** Wait for all remaining tool executions to complete. */
  async awaitRemaining(): Promise<PendingResult[]> {
    const remaining: PendingResult[] = [];
    for (const [id, promise] of this.pending) {
      try {
        const result = await promise;
        remaining.push(result);
      } catch {
        // Shouldn't happen — executeTool catches all errors
      }
    }
    this.pending.clear();
    return remaining;
  }

  /** Discard all pending executions (e.g., on abort). */
  discard(): void {
    this.pending.clear();
    this.completed = [];
    this.dispatchedIds.clear();
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Execute a single tool — with preflight + post-tool hooks applied. */
  private async executeTool(call: ToolCall, tool: Tool, idx: number): Promise<PendingResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      const result: PendingResult = {
        call,
        output: `error: invalid JSON arguments: ${call.arguments}`,
        err: 'invalid JSON arguments',
        truncated: false,
      };
      this.emitResult(call, tool, result);
      return result;
    }

    // ── Preflight hook: warn before destructive writes ──
    let preflightWarning: string | null = null;
    if (this.preflightHooks) {
      try {
        preflightWarning = this.preflightHooks.check(call.name, args);
      } catch (e: any) {
        // Silent degrade — don't block execution
      }
    }

    // ── Architecture gate: HIGH risk → return blocked result, don't execute ──
    if (preflightWarning && preflightWarning.includes('风险等级: HIGH')) {
      const forceGate = args['_forceGate'] === true || args['_forceGate'] === 'true';
      if (!forceGate) {
        const blockedResult: PendingResult = {
          call,
          output:
            preflightWarning +
            '\n\n' +
            '🚫 架构门禁已阻止此操作。\n' +
            '使用 trace_impact 查看完整波及范围。\n' +
            '确认安全后，带 _forceGate: true 重试同一工具调用。',
          truncated: false,
        };
        this.emitResult(call, tool, blockedResult);
        return blockedResult;
      }
    }

    // ponytail: inject _callId for agent_spawn so sub-agent events can correlate
    if (call.name === 'agent_spawn') {
      args['_callId'] = call.id;
    }

    // Inject _agent_id for isolation — tells Rust backend which worktree to use
    if (this.agentId) {
      args['_agent_id'] = this.agentId;
    }

    try {
      const toolStart = performance.now();
      let output = '';

      output = await tool.execute(args, (chunk) => {
        this.emit({
          kind: EventKind.ToolProgress,
          tool: {
            id: call.id,
            name: call.name,
            args: call.arguments,
            output: chunk,
            read_only: tool.readOnly(),
          },
        });
      });

      // ── Post-tool hook: enrich result with graph context ──
      if (this.hooks) {
        try {
          output = await this.hooks.apply(call.name, args, output);
        } catch (e: any) {
          // Silent degrade — don't break the result
        }
      }

      // Prepend preflight warning at top of result
      if (preflightWarning) {
        output = preflightWarning + '\n\n' + '─'.repeat(40) + '\n\n' + output;
      }

      // Truncate if too large
      const { body, truncMsg } = truncateToolOutput(output, call.name);
      const result: PendingResult = {
        call,
        output: body,
        truncated: !!truncMsg,
      };
      this.emitResult(call, tool, result);
      return result;
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
        throw e; // Don't catch abort — let caller handle
      }
      const errMsg = e.message ? e.message.split('\n')[0] : String(e);
      const result: PendingResult = {
        call,
        output: `error: ${errMsg}`,
        err: errMsg,
        truncated: false,
      };
      this.emitResult(call, tool, result);
      return result;
    }
  }

  private emitResult(call: ToolCall, tool: Tool, result: PendingResult): void {
    this.emit({
      kind: EventKind.ToolResult,
      tool: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        output: result.output,
        err: result.err,
        read_only: tool.readOnly(),
        truncated: result.truncated,
      },
    });
  }
}
