// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Streaming tool executor — execute tool calls as they arrive from the stream.
// Instead of waiting for the entire stream to finish before executing tools,
// this starts execution immediately when a tool_use block is complete.
//
// CC ref: StreamingToolExecutor, query.ts:1366-1408

import type { ToolCall } from '../provider/types';
import { ToolRegistry } from './tool';
import type { Tool } from './tool';
import { EventKind, type AgentEvent } from './agent-types';

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
 *   const executor = new StreamingToolExecutor(tools, emitEvent);
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
  private pending = new Map<string, Promise<PendingResult>>();
  private completed: PendingResult[] = [];
  private toolIndex = 0;

  constructor(tools: ToolRegistry, emitEvent: (ev: AgentEvent) => void) {
    this.tools = tools;
    this.emit = emitEvent;
  }

  /** Add a tool call from the stream. Execution starts immediately. */
  addTool(call: ToolCall): void {
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
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Execute a single tool and emit progress/result events. */
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

      const result: PendingResult = {
        call,
        output,
        truncated: false,
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
