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
import { type AgentEvent, EventKind, type ToolPipelineContext } from './agent-types';
import type { AgentEventBus } from './events';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import type { PlanGate } from './plan/plan-registry';
import type { Tool, ToolRegistry } from './tool';
import { resolveGuardToolName, retireRedirect } from './tools/domains';
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
  private pendingCalls = new Map<string, ToolCall>();
  private completed: PendingResult[] = [];
  private toolIndex = 0;
  /** 追踪已分发的工具 ID，防止流式重试时重复分发。 */
  private dispatchedIds = new Set<string>();

  private agentId: string | null;
  /** AbortSignal — 设置后，awaitRemaining 将每个 pending promise 与其竞速。 */
  private signal: AbortSignal | null;
  /** Plan 门禁 — plan 激活时在执行层拦截写操作；schema 跨模式恒定（缓存友好）。 */
  private planGate: PlanGate | null;
  /** 类型化事件管道（Phase 2）— 提供时执行阶段经 bus 驱动（guard/preflight/around/
   *  result/error），且 ctor 的 planGate/hooks/preflightHooks 字段被忽略——旧接口
   *  经 events.ts 的 attach* 适配器挂进 bus（见 tool-pipeline-events.test.ts 差分）。
   *  缺省时走旧直调路径，行为与本文件历史实现逐字节一致。 */
  private eventBus: AgentEventBus | null;

  constructor(
    tools: ToolRegistry,
    emitEvent: (ev: AgentEvent) => void,
    hooks?: HookRegistry | null,
    preflightHooks?: PreflightHookRegistry | null,
    agentId?: string | null,
    signal?: AbortSignal | null,
    planGate?: PlanGate | null,
    eventBus?: AgentEventBus | null,
  ) {
    this.tools = tools;
    this.emit = emitEvent;
    this.hooks = hooks ?? null;
    this.preflightHooks = preflightHooks ?? null;
    this.agentId = agentId ?? null;
    this.signal = signal ?? null;
    this.planGate = planGate ?? null;
    this.eventBus = eventBus ?? null;
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
      this.emitPipelineResult(call, null, result, call.name, true);
      return;
    }

    // 旧工具名已收敛：不执行，返回重定向（负反馈驱动模型迁移到领域工具）。
    // 仅拦截模型调用路径；内部委托 / plan 写入直接调旧工具，不走 executor，不受影响。
    if (this.tools.isHidden(call.name)) {
      const redirect = retireRedirect(call.name);
      const hint = redirect ? `已并入 ${redirect}，请直接调用 ${redirect}` : '已淘汰，请查看当前可用工具列表';
      const result: PendingResult = {
        call,
        output: `[已淘汰] ${call.name} ${hint}。不要再使用旧工具名。`,
        truncated: false,
      };
      this.completed.push(result);
      this.emitPipelineResult(call, null, result, call.name, false);
      return;
    }

    // Plan 门禁：plan 激活时在执行层拦截写操作（schema 不切换注册表，
    // DeepSeek 前缀缓存不被 plan 切换击穿；规则见 plan/plan-registry.ts）。
    // 内部 plan 文件写入不走 executor，不受影响。
    // 新路径：守卫经 eventBus 的 tool/guard 监听器（attachPlanGate 适配）；
    // eventBus 存在时 ctor 的 planGate 字段被忽略（差分测试钉住两路径等价）。
    if (this.eventBus || this.planGate) {
      // 门禁需要解析后的 args（action/filePath）；非法 JSON 放行至
      // executeTool 的 "invalid JSON arguments" 错误路径，保持报错语义。
      let gateArgs: Record<string, unknown> | null = null;
      try {
        gateArgs = JSON.parse(call.arguments || '{}');
      } catch {
        gateArgs = null;
      }
      let blocked: string | null = null;
      if (this.eventBus) {
        blocked = gateArgs ? this.eventBus.runGuard(this.pipelineCtx(call, tool, gateArgs, call.name)) : null;
      } else if (this.planGate) {
        blocked = gateArgs ? this.planGate(call.name, gateArgs, tool) : null;
      }
      if (blocked) {
        const result: PendingResult = {
          call,
          output: blocked,
          truncated: false,
        };
        this.completed.push(result);
        this.emitPipelineResult(call, null, result, call.name, false, gateArgs);
        return;
      }
    }

    // 立即开始执行 — 不等待流结束
    const promise = this.executeTool(call, tool, idx);
    this.pending.set(call.id, promise);
    this.pendingCalls.set(call.id, call);
  }

  /** 等待所有剩余工具执行完成。
   *  同时排出在 addTool 期间同步完成的结果（如未知工具名）。
   *  如设置了中止信号，将每个 pending promise 与其竞速，
   *  使永不解决的工具（如卡住的 Tauri invoke）不会无限阻塞循环。 */
  async awaitRemaining(): Promise<PendingResult[]> {
    // 如已中止：剩余 pending 工具以取消结果落地（发 ToolResult + 返回结果），
    // 而非静默丢弃——否则 UI 卡片永远停在"执行中"，runLoop 还会追加
    // 误导性的 "did not produce a result"（会话 223 事故根因之一）。
    if (this.signal?.aborted) {
      return this._settleCancelled();
    }

    const remaining: PendingResult[] = [];
    for (const [_id, promise] of this.pending) {
      try {
        const result = this.signal ? await this._raceWithAbort(promise) : await promise;
        remaining.push(result);
      } catch (e: any) {
        // 中止 — 剩余未完成工具同样以取消结果落地，再停止收集
        if (e?.name === 'AbortError' || this.signal?.aborted) {
          remaining.push(...(await this._settleCancelled()));
          break;
        }
        // 其他错误不应发生 — executeTool 捕获所有
      }
    }
    this.pending.clear();
    this.pendingCalls.clear();
    const syncCompleted = [...this.completed];
    this.completed = [];
    for (const r of syncCompleted) {
      this.pending.delete(r.call.id);
    }
    return [...syncCompleted, ...remaining];
  }

  /** 中止时把仍 pending 的工具全部落地为结果：短竞速窗口（100ms）内
   *  已完成的取真实结果，未完成的给"已取消"结果并补发 ToolResult，
   *  保证调用方（runLoop）拿到全部调用对应的结果、UI 卡片全部终结。
   *  仅中止路径调用；正常路径不受影响。 */
  private async _settleCancelled(): Promise<PendingResult[]> {
    const out: PendingResult[] = [];
    const entries = [...this.pending.entries()];
    for (const [id, promise] of entries) {
      const call = this.pendingCalls.get(id);
      let result: PendingResult | null = null;
      try {
        result = await Promise.race([promise, new Promise<null>((res) => setTimeout(() => res(null), 100))]);
      } catch {
        result = null;
      }
      if (!result) {
        if (!call) continue;
        result = {
          call,
          output: '[已取消] 工具执行被中止（agent 运行被中断）。',
          err: 'aborted',
          truncated: false,
        };
      }
      let guardName = call?.name ?? result.call.name;
      try {
        guardName = resolveGuardToolName(this.tools, result.call.name, JSON.parse(result.call.arguments || '{}'));
      } catch {
        // 参数非 JSON — 保持原名
      }
      this.emitPipelineResult(result.call, this.tools.get(result.call.name) ?? null, result, guardName, true);
      out.push(result);
    }
    return out;
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
        (r) => {
          sig.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (e) => {
          sig.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** 丢弃所有待处理执行（如中止时）。 */
  discard(): void {
    this.pending.clear();
    this.pendingCalls.clear();
    this.completed = [];
    this.dispatchedIds.clear();
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** 执行单个工具 — 应用预检 + 工具后钩子。
   *  eventBus 存在时：preflight/around/result/error 经类型化管道驱动（Phase 2），
   *  阶段顺序与旧直调路径逐点镜像（差分测试钉住）。 */
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
      this.emitPipelineResult(call, tool, result, call.name, true);
      return result;
    }

    // 领域工具（fs/shell/git/...）解析回旧工具名，保证门禁 / hooks / 关联按原语义工作
    const guardName = resolveGuardToolName(this.tools, call.name, args);
    const ctx = this.pipelineCtx(call, tool, args, guardName);

    // ── 预检钩子：破坏性写入前警告 ──
    let preflightWarning: string | null = null;
    if (this.eventBus) {
      preflightWarning = this.eventBus.runPreflight(ctx);
    } else if (this.preflightHooks) {
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
        this.emitPipelineResult(call, tool, blockedResult, guardName, false, args);
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

      output = await tool.execute(
        args,
        (chunk) => {
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
        },
        this.signal ?? undefined,
      );

      // ── 工具后钩子：用图上下文富化结果 ──
      if (this.eventBus) {
        output = await this.eventBus.runAround(ctx, output);
      } else if (this.hooks) {
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
      this.emitPipelineResult(call, tool, result, guardName, false, args);
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
      this.emitPipelineResult(call, tool, result, guardName, true, args);
      return result;
    }
  }

  /** 管道上下文 — eventBus 各阶段的载荷。 */
  private pipelineCtx(
    call: ToolCall,
    tool: Tool | null,
    args: Record<string, unknown> | null,
    guardName: string,
  ): ToolPipelineContext {
    return { call, tool, args, agentId: this.agentId, signal: this.signal, guardName };
  }

  /** 结果落点统一：eventBus 双发（tool/result 或 tool/error）+ legacy sink（UI/模型可见事件）。
   *  legacy sink 的事件序列与旧路径逐项一致（差分测试钉住），UI 零改动。 */
  private emitPipelineResult(
    call: ToolCall,
    tool: Tool | null,
    result: PendingResult,
    guardName: string,
    isError: boolean,
    args: Record<string, unknown> | null = null,
  ): void {
    if (this.eventBus) {
      const ctx = this.pipelineCtx(call, tool, args, guardName);
      if (isError) {
        this.eventBus.emitError(ctx, result.err ?? result.output);
      } else {
        this.eventBus.emitResult(ctx, { output: result.output, truncated: result.truncated, err: result.err ?? null });
      }
    }
    this.emitResult(call, tool, result);
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
