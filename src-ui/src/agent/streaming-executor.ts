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
import { truncateToolOutput } from './truncate';

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
  /** Abort signal — when set, awaitRemaining races each pending promise against it. */
  private signal: AbortSignal | null;

  constructor(
    tools: ToolRegistry,
    emitEvent: (ev: AgentEvent) => void,
    hooks?: HookRegistry | null,
    preflightHooks?: PreflightHookRegistry | null,
    agentId?: string | null,
    signal?: AbortSignal | null,
  ) {
    this.tools = tools;
    this.emit = emitEvent;
    this.hooks = hooks ?? null;
    this.preflightHooks = preflightHooks ?? null;
    this.agentId = agentId ?? null;
    this.signal = signal ?? null;
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
      const result: PendingResult = {
        call,
        output: `error: unknown tool "${call.name}"`,
        err: `unknown tool "${call.name}"`,
        truncated: false,
      };
      this.completed.push(result);
      // Unknown tools never reach executeTool, so emit the ToolResult here —
      // without it the sub-agent activity tracker keeps the hallucinated call
      // as currentTool forever (false ⚠️ 疑似卡死 after 120s) and the UI tool
      // part spins indefinitely.
      this.emitResult(call, null, result);
      return;
    }

    // Start execution immediately — don't wait for stream to end
    const promise = this.executeTool(call, tool, idx);
    this.pending.set(call.id, promise);
  }

  /** Wait for all remaining tool executions to complete.
   *  Also drains sync-completed results (unknown tool etc.) that were pushed
   *  to this.completed during addTool (e.g. unknown tool name).
   *  If an abort signal is set, races each pending promise against it so
   *  that a never-resolving tool (e.g. stuck Tauri invoke) doesn't hang the
   *  loop indefinitely. */
  async awaitRemaining(): Promise<PendingResult[]> {
    // If already aborted, discard everything immediately
    if (this.signal?.aborted) {
      this.discard();
      return [];
    }

    const remaining: PendingResult[] = [];
    for (const [_id, promise] of this.pending) {
      try {
        const result = this.signal
          ? await this._raceWithAbort(promise)
          : await promise;
        remaining.push(result);
      } catch (e: any) {
        // Abort — discard remaining and stop collecting
        if (e?.name === 'AbortError' || this.signal?.aborted) {
          break;
        }
        // Other errors shouldn't happen — executeTool catches all
      }
    }
    this.pending.clear();
    const syncCompleted = [...this.completed];
    this.completed = [];
    for (const r of syncCompleted) {
      this.pending.delete(r.call.id);
    }
    return [...syncCompleted, ...remaining];
  }

  /** Race a tool promise against the abort signal. Rejects with AbortError
   *  if the signal fires before the promise settles. */
  private _raceWithAbort(promise: Promise<PendingResult>): Promise<PendingResult> {
    const sig = this.signal!;
    if (sig.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise<PendingResult>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException('Aborted', 'AbortError'));
        sig.removeEventListener('abort', onAbort);
      };
      sig.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (r) => { sig.removeEventListener('abort', onAbort); resolve(r); },
        (e) => { sig.removeEventListener('abort', onAbort); reject(e); },
      );
    });
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
  private async executeTool(call: ToolCall, tool: Tool, _idx: number): Promise<PendingResult> {
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
      } catch (_e: any) {
        // Silent degrade — don't block execution
      }
    }

    // ── Architecture gate: HIGH risk → return blocked result, don't execute ──
    if (preflightWarning?.includes('风险等级: HIGH')) {
      const forceGate = args._forceGate === true || args._forceGate === 'true';
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
      args._callId = call.id;
    }

    // Inject _agent_id for isolation — tells Rust backend which worktree to use
    if (this.agentId) {
      args._agent_id = this.agentId;
    }

    try {
      const _toolStart = performance.now();
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
        } catch (_e: any) {
          // Silent degrade — don't break the result
        }
      }

      // Prepend preflight warning at top of result
      if (preflightWarning) {
        output = preflightWarning + '\n\n' + '─'.repeat(40) + '\n\n' + output;
      }

      // ── Truncate output to cap token consumption (50KB / 2000 lines) ──
      const trunc = truncateToolOutput(call.name, output);

      const result: PendingResult = {
        call,
        output: trunc.content,
        truncated: trunc.truncated,
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

  private emitResult(call: ToolCall, tool: Tool | null, result: PendingResult): void {
    this.emit({
      kind: EventKind.ToolResult,
      tool: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        output: result.output,
        err: result.err,
        read_only: tool?.readOnly() ?? false,
        truncated: result.truncated,
      },
    });
  }
}
