// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流式工具执行器 — 工具调用到达即执行，无需等待整个流结束。
// 在 tool_use 块完成时立即开始执行。
//
// 钩子（GraphContextHook / PreflightHook）在此运行 — 执行前预检，
// 工具后富化 — 这样它们不会被流式执行绕过。
//
// CC 参考：StreamingToolExecutor, query.ts:1366-1408

import type { ToolCall } from '../provider/types';
import { type AgentEvent, EventKind } from './agent-types';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import type { Tool, ToolRegistry } from './tool';
import { truncateToolOutput } from './truncate';
import { resolveGuardToolName } from './tools/domains';

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
 * StreamingToolExecutor — 管理流期间的并发工具执行。
 *
 * 在 agent 循环中的用法：
 *   const executor = new StreamingToolExecutor(tools, emitEvent, hooks, preflightHooks);
 *   for await (const chunk of stream) {
 *     if chunk is ToolCall → executor.addTool(chunk.tool_call);
 *     // 每次迭代轮询已完成的结果
 *     for (const result of executor.pollCompleted()) {
 *       results.push(result);
 *     }
 *   }
 *   // 流结束 — 收集剩余
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
  /** 追踪已分发的工具 ID，防止流式重试时重复分发。 */
  private dispatchedIds = new Set<string>();

  private agentId: string | null;
  /** AbortSignal — 设置后，awaitRemaining 将每个 pending promise 与其竞速。 */
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

  /** 从流中添加工具调用。立即开始执行。
   *  跳过已分发的工具 ID（流式重试时可能出现）。 */
  addTool(call: ToolCall): void {
    if (this.dispatchedIds.has(call.id)) return;
    this.dispatchedIds.add(call.id);
    const tool = this.tools.get(call.name);
    const idx = this.toolIndex++;

    // 发出分发事件
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
      // 未知工具不会到达 executeTool，所以在此发出 ToolResult —
      // 否则子 agent 活动跟踪器会永远将该幻觉调用保持为
      // currentTool（120s 后误报 ⚠️ 疑似卡死），UI 工具
      // 部分无限旋转。
      this.emitResult(call, null, result);
      return;
    }

    // 立即开始执行 — 不等待流结束
    const promise = this.executeTool(call, tool, idx);
    this.pending.set(call.id, promise);
  }

  /** 等待所有剩余工具执行完成。
   *  同时排出在 addTool 期间同步完成的结果（如未知工具名）。
   *  如设置了中止信号，将每个 pending promise 与其竞速，
   *  使永不解决的工具（如卡住的 Tauri invoke）不会无限阻塞循环。 */
  async awaitRemaining(): Promise<PendingResult[]> {
    // 如已中止，立即丢弃所有
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
        // 中止 — 丢弃剩余并停止收集
        if (e?.name === 'AbortError' || this.signal?.aborted) {
          break;
        }
        // 其他错误不应发生 — executeTool 捕获所有
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

  /** 将工具 promise 与中止信号竞速。信号在 promise 完成前触发时
   *  以 AbortError 拒绝。 */
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

  /** 丢弃所有待处理执行（如中止时）。 */
  discard(): void {
    this.pending.clear();
    this.completed = [];
    this.dispatchedIds.clear();
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** 执行单个工具 — 应用预检 + 工具后钩子。 */
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

    // 领域工具（fs/shell/git/...）解析回旧工具名，保证门禁 / hooks / 关联按原语义工作
    const guardName = resolveGuardToolName(this.tools, call.name, args);

    // ── 预检钩子：破坏性写入前警告 ──
    let preflightWarning: string | null = null;
    if (this.preflightHooks) {
      try {
        preflightWarning = this.preflightHooks.check(guardName, args);
      } catch (_e: any) {
        // 静默降级 — 不阻止执行
      }
    }

    // ── 架构门禁：HIGH 风险 → 返回阻止结果，不执行 ──
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

    // ponytail: 注入 _callId 使子 agent 事件可关联
    if (guardName === 'agent_spawn') {
      args._callId = call.id;
    }

    // 注入 _agent_id 用于隔离 — 告诉 Rust 后端使用哪个工作树
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

      // ── 工具后钩子：用图上下文富化结果 ──
      if (this.hooks) {
        try {
          output = await this.hooks.apply(guardName, args, output);
        } catch (_e: any) {
          // 静默降级 — 不破坏结果
        }
      }

      // 在结果顶部前置预检警告
      if (preflightWarning) {
        output = preflightWarning + '\n\n' + '─'.repeat(40) + '\n\n' + output;
      }

      // ── 截断输出以限制 token 消耗（50KB / 2000 行）──
      const trunc = truncateToolOutput(guardName, output);

      const result: PendingResult = {
        call,
        output: trunc.content,
        truncated: trunc.truncated,
      };
      this.emitResult(call, tool, result);
      return result;
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.message?.includes('aborted')) {
        throw e; // 不捕获中止 — 交给调用方处理
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
