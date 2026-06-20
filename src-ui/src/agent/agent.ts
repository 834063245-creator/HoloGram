// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 循环 — Run() → stream() → executeBatch() → 循环直到模型给出最终答案

import type {
  Chunk,
  Message,
  Provider,
  ToolCall,
  Usage,
} from '../provider/types';
import { ChunkType, sanitizeToolPairing } from '../provider/types';
import { ToolRegistry } from './tool';
import type { Tool } from './tool';
import type { PermissionGate } from './permission';
import type { HookRegistry } from './hooks';
import { bus } from '../ui/events';
import { log } from './logger';

// ---- Event types ----

export enum EventKind {
  TurnStarted = 'turn_started',
  Reasoning = 'reasoning',
  Text = 'text',
  Message = 'message',
  ToolDispatch = 'tool_dispatch',
  ToolResult = 'tool_result',
  ToolProgress = 'tool_progress',
  Usage = 'usage',
  Notice = 'notice',
}

export interface ToolEvent {
  id: string;
  name: string;
  args?: string;
  output?: string;
  err?: string;
  read_only: boolean;
  partial?: boolean;
  truncated?: boolean;
}

export interface AgentEvent {
  kind: EventKind;
  text?: string;
  reasoning?: string;
  tool?: ToolEvent;
  usage?: Usage;
  pricing?: Pricing;
  session_hit?: number;
  session_miss?: number;
  level?: 'info' | 'warn' | 'error';
}

export interface Pricing {
  cache_hit: number;  // per 1M tokens
  input: number;      // per 1M tokens
  output: number;     // per 1M tokens
  currency: string;
}

export function computeCost(p: Pricing | undefined, u: Usage | undefined): number {
  if (!p || !u) return 0;
  return (u.cache_hit_tokens * p.cache_hit +
    u.cache_miss_tokens * p.input +
    u.completion_tokens * p.output) / 1_000_000;
}

/** Sink receives the agent's typed event stream. */
export type EventSink = (event: AgentEvent) => void;

// ---- Agent Options ----

export interface AgentOptions {
  /** Max tool-calling rounds (0 = no cap). Default: 10 */
  maxSteps?: number;
  temperature?: number;
  pricing?: Pricing;
  /** Context window size in tokens. 0 = no compaction. */
  contextWindow?: number;
  /** Fraction of contextWindow that triggers compaction (default: 0.7) */
  compactRatio?: number;
  /** Minimum recent messages kept verbatim */
  recentKeep?: number;
  /** Permission gate for tool execution (nil = allow all) */
  gate?: PermissionGate;
}

const DEFAULT_MAX_STEPS = 50;
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const STORM_BREAK_THRESHOLD = 3;

// ---- Agent ----

export class Agent {
  private prov: Provider;
  private tools: ToolRegistry;
  private session: Message[];
  private maxSteps: number;
  private temperature: number;
  private pricing: Pricing | undefined;

  // Context management
  private contextWindow: number;
  private compactRatio: number;
  private recentKeep: number;
  private compactStuck = false;

  // Permission gate (optional — nil means allow all)
  private gate: PermissionGate | null = null;

  // PreToolUse hooks — enrich tool results with graph context
  private hooks: HookRegistry | null = null;

  // Storm breaker — detect repetitive failing tool calls
  private stormSig = '';
  private stormCount = 0;

  // Cache accumulation
  private cacheHitTotal = 0;
  private cacheMissTotal = 0;

  // Last usage for status display
  private lastUsage: Usage | undefined;

  // Event sink
  private sink: EventSink;

  constructor(
    prov: Provider,
    tools: ToolRegistry,
    systemPrompt: string,
    opts: AgentOptions = {},
    sink: EventSink = () => {},
  ) {
    this.prov = prov;
    this.tools = tools;
    this.temperature = opts.temperature ?? 0.7;
    this.pricing = opts.pricing;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.contextWindow = opts.contextWindow ?? 1000000; // 1M tokens default — covers all current models, triggers compaction only when truly needed
    this.compactRatio = opts.compactRatio ?? 0.7;
    this.recentKeep = opts.recentKeep ?? 4;
    this.gate = opts.gate || null;
    this.sink = sink;

    this.session = [];
    if (systemPrompt) {
      this.session.push({ role: 'system', content: systemPrompt });
    }
  }

  setHooks(hooks: HookRegistry): void { this.hooks = hooks; }

  // ---- Public API ----

  getSession(): Message[] {
    return this.session;
  }

  setSession(msgs: Message[]): void {
    this.session = msgs;
    ++this.sessionGen;
  }

  getLastUsage(): Usage | undefined {
    return this.lastUsage;
  }

  getCacheTotals(): { hit: number; miss: number } {
    return { hit: this.cacheHitTotal, miss: this.cacheMissTotal };
  }

  /** Start a fresh conversation — keep system prompt, clear everything else. */
  newSession(): void {
    const sys = this.session.length > 0 && this.session[0].role === 'system'
      ? this.session[0]
      : null;
    this.session = sys ? [sys] : [];
    ++this.sessionGen;
    this.cacheHitTotal = 0;
    this.cacheMissTotal = 0;
    this.lastUsage = undefined;
    this.stormSig = '';
    this.stormCount = 0;
    this.compactStuck = false;
    this.sink({ kind: EventKind.Notice, level: 'info', text: '已开启新会话' });
  }

  /** Run one turn: append user input, drive the tool loop. */
  async run(signal: AbortSignal, input: string): Promise<void> {
    const turnStart = performance.now();
    const genAtStart = this.sessionGen;
    log.info('agent', 'turn started', { model: this.prov.name() });
    this.sink({ kind: EventKind.TurnStarted });
    this.session.push({ role: 'user', content: input });

    for (let step = 0; this.maxSteps <= 0 || step < this.maxSteps; step++) {
      // 每轮循环前检查中止信号与会话替换
      if (signal.aborted) throw new Error('aborted');
      if (this.sessionGen !== genAtStart) throw new Error('aborted');

      // ---- Stream ----
      const { text, reasoning, signature, calls, usage, err } = await this.stream(signal, step + 1);
      if (err) {
        log.error('agent', 'stream error', { error: String(err.message || err) });
        throw err;
      }

      if (usage && usage.total_tokens > 0) {
        log.info('agent', 'llm response', {
          turn: step + 1,
          model: this.prov.name(),
          finish_reason: usage.finish_reason,
          total_tokens: usage.total_tokens,
          cache_hit_tokens: usage.cache_hit_tokens,
          elapsed_ms: Math.round(performance.now() - turnStart),
        });
        this.cacheHitTotal += usage.cache_hit_tokens;
        this.cacheMissTotal += usage.cache_miss_tokens;
        this.lastUsage = usage;
        this.sink({
          kind: EventKind.Usage,
          usage,
          pricing: this.pricing,
          session_hit: this.cacheHitTotal,
          session_miss: this.cacheMissTotal,
        });
      }

      // Abnormal finish reason warning
      const warnMsg = finishReasonMessage(usage);
      if (warnMsg) {
        this.sink({ kind: EventKind.Notice, level: 'warn', text: warnMsg });
      }

      // Guard: DeepSeek rejects assistant messages with neither content nor tool_calls
      if (!text && calls.length === 0) {
        log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
        return;
      }

      // Store assistant turn (reasoning kept for display, not re-uploaded)
      this.session.push({
        role: 'assistant',
        content: text,
        reasoning_content: reasoning,
        reasoning_signature: signature,
        tool_calls: calls,
      });

      if (calls.length === 0) return; // model gave final answer

      // ---- Execute ----
      log.info('agent', 'execute batch', {
        tools: calls.map(c => c.name),
        count: calls.length,
      });
      const results = await this.executeBatch(signal, calls);
      for (let i = 0; i < calls.length; i++) {
        this.session.push({
          role: 'tool',
          content: results[i],
          tool_call_id: calls[i].id,
          name: calls[i].name,
        });
      }

      // Compact if needed before next turn
      this.maybeCompact(usage);
    }

    throw new Error(
      `paused after ${this.maxSteps} tool-call rounds — the work so far is saved; send another message to continue`,
    );
  }

  // ---- Private: stream ----

  private async stream(
    signal: AbortSignal,
    _turn: number,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
  }> {
    const gen = this.prov.stream(signal, {
      messages: sanitizeToolPairing(this.session),
      tools: this.tools.schemas(),
      temperature: this.temperature,
      max_tokens: 0, // use provider default
    });

    let text = '';
    let reasoning = '';
    let signature = '';
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    let err: Error | undefined;

    try {
      for await (const chunk of gen) {
        switch (chunk.type) {
          case ChunkType.Reasoning:
            reasoning += chunk.text || '';
            if (chunk.signature) signature = chunk.signature;
            if (chunk.text) {
              this.sink({ kind: EventKind.Reasoning, text: chunk.text });
            }
            break;

          case ChunkType.Text:
            text += chunk.text || '';
            this.sink({ kind: EventKind.Text, text: chunk.text });
            break;

          case ChunkType.ToolCallStart:
            if (chunk.tool_call) {
              this.sink({
                kind: EventKind.ToolDispatch,
                tool: {
                  id: chunk.tool_call.id,
                  name: chunk.tool_call.name,
                  args: '',
                  read_only: this.toolReadOnly(chunk.tool_call.name),
                  partial: true,
                },
              });
            }
            break;

          case ChunkType.ToolCall:
            if (chunk.tool_call) calls.push(chunk.tool_call);
            break;

          case ChunkType.Usage:
            usage = chunk.usage;
            break;

          case ChunkType.Error:
            err = chunk.err;
            // fall through to Done to stop iteration
            break;

          case ChunkType.Done:
            break;
        }

        if (err) break;
      }
    } catch (e: any) {
      err = e instanceof Error ? e : new Error(String(e));
    }

    if (err) return { text: '', reasoning: '', signature: '', calls: [], usage, err };

    // Close the text stream
    if (text || reasoning) {
      this.sink({ kind: EventKind.Message, text, reasoning });
    }

    return { text, reasoning, signature, calls, usage, err: undefined };
  }

  // ---- Private: execute ----

  private async executeBatch(signal: AbortSignal, calls: ToolCall[]): Promise<string[]> {
    const results: string[] = new Array(calls.length);
    const outcomes: ToolOutcome[] = new Array(calls.length);

    // Emit dispatch events (with full args)
    for (const c of calls) {
      const t = this.tools.get(c.name);
      this.sink({
        kind: EventKind.ToolDispatch,
        tool: {
          id: c.id,
          name: c.name,
          args: c.arguments,
          read_only: t?.readOnly() ?? false,
        },
      });
    }

    // Execute — parallel read-only, serial writers
    const batches = partitionCalls(this.tools, calls);
    for (const batch of batches) {
      if (signal.aborted) throw new Error('aborted');
      if (batch.parallel && batch.end - batch.start > 1) {
        await Promise.all(
          calls.slice(batch.start, batch.end).map(async (call, i) => {
            const idx = batch.start + i;
            outcomes[idx] = await this.executeOne(signal, call);
            results[idx] = outcomes[idx].output;
          }),
        );
      } else {
        for (let i = batch.start; i < batch.end; i++) {
          outcomes[i] = await this.executeOne(signal, calls[i]);
          results[i] = outcomes[i].output;
        }
      }
    }

    // Emit result events
    for (let i = 0; i < calls.length; i++) {
      const o = outcomes[i];
      const t = this.tools.get(calls[i].name);
      this.sink({
        kind: EventKind.ToolResult,
        tool: {
          id: calls[i].id,
          name: calls[i].name,
          args: calls[i].arguments,
          output: o.output,
          err: o.errMsg || undefined,
          read_only: t?.readOnly() ?? false,
          truncated: o.truncated,
        },
      });
      // Emit tool-done for graph visualization (EventBus)
      if (!o.errMsg && !o.blocked) {
        let visArgs: Record<string, unknown> = {};
        try { visArgs = JSON.parse(calls[i].arguments || '{}'); } catch {}
        bus.emit('agent:tool-done', {
          toolName: calls[i].name,
          args: visArgs,
          output: o.output,
        });
      }
      if (o.truncated && o.truncMsg) {
        this.sink({ kind: EventKind.Notice, level: 'info', text: o.truncMsg });
      }
    }

    // Storm breaker
    this.applyStormBreaker(calls, outcomes, results);

    return results;
  }

  private async executeOne(signal: AbortSignal, call: ToolCall): Promise<ToolOutcome> {
    const t = this.tools.get(call.name);
    if (!t) {
      return {
        output: `error: unknown tool "${call.name}"`,
        errMsg: `unknown tool "${call.name}"`,
        blocked: false,
        truncated: false,
      };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return {
        output: `error: invalid JSON arguments: ${call.arguments}`,
        errMsg: 'invalid JSON arguments',
        blocked: false,
        truncated: false,
      };
    }

    let result: string;
    let errMsg = '';
    try {
      // 中止信号优先检查（必须在权限门前，防止弹窗死锁）
      if (signal.aborted) throw new Error('aborted');

      // ── Permission gate ──
      if (this.gate) {
        const check = await this.gate.check(call.name, t.description(), args, t.readOnly());
        if (!check.allow) {
          return {
            output: check.reason || 'permission denied',
            errMsg: check.reason,
            blocked: true,
            truncated: false,
          };
        }
      }
      bus.emit('agent:tool-started', { toolName: call.name, args });
      const toolStart = performance.now();
      result = await t.execute(args, (chunk) => {
        this.sink({
          kind: EventKind.ToolProgress,
          tool: { id: call.id, name: call.name, args: call.arguments, output: chunk, read_only: t?.readOnly() ?? false },
        });
      });
      log.debug('tool', 'executed', { name: call.name, elapsed_ms: Math.round(performance.now() - toolStart) });
      // ── PreToolUse hooks: enrich result with graph context ──
      if (this.hooks && !errMsg) {
        try {
          result = await this.hooks.apply(call.name, args, result);
        } catch (e: any) {
          log.warn('agent', 'hook apply failed', { tool: call.name, error: firstLine(e?.message || String(e)) });
          result = result + '\n\n[注意: 图上下文增强失败（hook error），以下结果为原始工具输出]';
        }
      }
      // Re-check after execution — the tool may have been slow
      if (signal.aborted) throw new Error('aborted');
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.message?.includes('aborted')) throw e;
      result = `error: ${e.message || e}`;
      errMsg = firstLine(e.message || String(e));
      log.warn('agent', 'tool failed', { tool: call.name, error: errMsg });
    }

    const { body, truncMsg } = truncateToolOutput(result, call.name);
    return {
      output: body,
      errMsg: errMsg || undefined,
      blocked: false,
      truncated: !!truncMsg,
      truncMsg: truncMsg || undefined,
    };
  }

  // ---- Storm breaker — break repetitive tool-call loops ----

  private applyStormBreaker(
    calls: ToolCall[],
    outcomes: ToolOutcome[],
    results: string[],
  ): void {
    const { sig, ok } = batchStormSignature(calls, outcomes);
    if (!ok) {
      this.stormSig = '';
      this.stormCount = 0;
      return;
    }
    if (sig !== this.stormSig) {
      this.stormSig = sig;
      this.stormCount = 1;
      return;
    }
    this.stormCount++;
    if (this.stormCount < STORM_BREAK_THRESHOLD) return;

    const subject =
      calls.length === 1
        ? `"${calls[0].name}"`
        : `this batch of ${calls.length} tool calls`;
    const short =
      calls.length === 1 ? calls[0].name : `a batch of ${calls.length} calls`;

    results[0] =
      outcomes[0].output +
      `\n\n[loop guard] ${subject} has now failed ${this.stormCount} times in a row with the same error. Re-sending it will not help. Change approach: if an argument is being truncated, write less in one call and split the work; otherwise fix the arguments, use a different tool, or explain the blocker in your final answer.`;

    this.sink({
      kind: EventKind.Notice,
      level: 'warn',
      text: `loop guard: ${short} failed ${this.stormCount}× the same way — nudging the model to change approach`,
    });
  }

  // ---- Context window management ----

  private compactRunning = false;
  private sessionGen = 0;

  /** Manual compaction trigger (from /compact command). Returns summary text or error. */
  async compactNow(signal: AbortSignal): Promise<string> {
    if (this.compactRunning) throw new Error('compaction already in progress');
    this.compactRunning = true;
    try {
      const msgs = this.session;
      const head = (msgs.length > 0 && msgs[0].role === 'system') ? 1 : 0;
      // Keep last N messages verbatim (tail), compact the middle
      const tailCount = Math.max(4, this.recentKeep);
      const start = Math.max(head + 4, msgs.length - tailCount); // at least 4 compactable messages
      if (start - head < 4) {
        this.sink({ kind: EventKind.Notice, level: 'info', text: '对话太短，无需压缩' });
        return '';
      }
      const region = msgs.slice(head, start);
      const summary = await this.summarizeRegion(signal, region);
      if (!summary) return '';

      const compacted: Message[] = [
        ...msgs.slice(0, head),
        { role: 'user' as const, content: '<compacted-context>\n以下是对前面讨论的总结（原始消息已压缩以节省上下文）:\n\n' + summary + '\n</compacted-context>' },
        ...msgs.slice(start),
      ];
      this.session = compacted;
      ++this.sessionGen;
      this.stormSig = '';
      this.stormCount = 0;
      this.compactStuck = false;
      this.sink({
        kind: EventKind.Notice,
        level: 'info',
        text: `上下文已压缩: ${region.length} 条消息 → 摘要 (保留了最近 ${msgs.length - start} 条)`,
      });
      return summary;
    } finally {
      this.compactRunning = false;
    }
  }

  private maybeCompact(usage: Usage | undefined): void {
    if (this.contextWindow <= 0) return;
    if (!usage || usage.total_tokens <= 0) return;

    const ratio = usage.total_tokens / this.contextWindow;
    if (ratio < this.compactRatio) {
      this.compactStuck = false;
      return;
    }
    if (this.compactStuck) return;
    if (this.compactRunning) {
      this.sink({ kind: EventKind.Notice, level: 'info', text: '压缩已在运行中，跳过重复触发' });
      return;
    }
    this.compactRunning = true;

    // Auto-compact: trigger summarization in background after this turn
    this.sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `上下文使用率 ${(ratio * 100).toFixed(0)}% — 自动压缩中…`,
    });

    // Run compaction asynchronously (non-blocking for the turn)
    const msgs = this.session;
    const genAtStart = ++this.sessionGen;
    const head = (msgs.length > 0 && msgs[0].role === 'system') ? 1 : 0;
    const tailCount = Math.max(4, this.recentKeep);
    const start = Math.max(head + 4, msgs.length - tailCount);
    if (start - head < 4) {
      this.compactStuck = true;
      this.compactRunning = false;
      this.sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `上下文窗口 ${(ratio * 100).toFixed(0)}% 已满但对话太短无法压缩。建议用 /new 开启新会话。`,
      });
      return;
    }

    const region = msgs.slice(head, start);
    const abortCtrl = new AbortController();
    this.summarizeRegion(abortCtrl.signal, region).then((summary) => {
      if (genAtStart !== this.sessionGen) { this.compactRunning = false; return; } // session replaced, discard
      if (!summary) { this.compactRunning = false; return; }
      const compacted: Message[] = [
        ...msgs.slice(0, head),
        { role: 'user' as const, content: '<compacted-context>\n以下是对前面讨论的总结（原始消息已压缩以节省上下文）:\n\n' + summary + '\n</compacted-context>' },
        ...msgs.slice(start),
      ];
      this.session = compacted;
      ++this.sessionGen;
      this.stormSig = '';
      this.stormCount = 0;
      this.compactStuck = false;
      this.compactRunning = false;
      this.sink({
        kind: EventKind.Notice,
        level: 'info',
        text: `自动压缩完成: ${region.length} 条消息 → 摘要`,
      });
    }).catch(() => {
      if (genAtStart !== this.sessionGen) { this.compactRunning = false; return; } // session replaced, discard
      this.compactStuck = true;
      this.compactRunning = false;
      this.sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: '自动压缩失败。建议用 /new 开启新会话或手动 /compact。',
      });
    });
  }

  /** Call the provider (no tools) to summarize a message region. */
  private async summarizeRegion(signal: AbortSignal, msgs: Message[]): Promise<string> {
    const summaryPrompt = `你是对话压缩器。把以下编码 Agent 的对话历史浓缩为一份简报。Agent 只会保留你的摘要（原始消息会被丢弃），因此必须能从摘要中恢复任务。

按这些标题写（没有内容的标题可以省略）：

## 目标
用户的需求和意图，尽量用用户的措辞。包含明确的约束和偏好。

## 决策与理由
已做出的关键选择及原因——避免被推翻或重复争论。

## 文件与代码
读取或修改过的文件，包含具体事实：签名、位置、数据形状、应用的具体编辑。

## 命令与结果
执行过的命令（构建、测试、git）及结果——哪些通过、哪些失败、错误信息。

## 错误与修复
遇到的问题及解决方式（或未解决），避免走重复的弯路。

## 待办与下一步
仍在进行中或未开始的工作，以及最具体的下一个行动。

规则：简洁——用要点和片段而非散文。准确保留标识符、路径和数字。不编造任何不存在于消息中的内容。`;

    const transcript = renderTranscript(msgs);
    const gen = this.prov.stream(signal, {
      messages: [
        { role: 'system', content: summaryPrompt },
        { role: 'user', content: transcript },
      ],
      tools: [], // no tools for summarization
      temperature: 0.3, // low temp for factual summary
      max_tokens: 0,
    });

    let text = '';
    for await (const chunk of gen) {
      if (chunk.type === ChunkType.Text && chunk.text) {
        text += chunk.text;
      }
      if (chunk.type === ChunkType.Error) throw chunk.err!;
    }
    return text.trim();
  }

  private toolReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly() ?? false;
  }

  // ══════════════════════════════════════════════════════
  // Sub-agent spawn — for parallel / delegated work
  // ══════════════════════════════════════════════════════

  /** Spawn a sub-agent with full tool access to handle a focused task.
   *  Runs one turn (may include tool calls) and returns the final text. */
  async spawnSubAgent(
    signal: AbortSignal,
    description: string,
    prompt: string,
    onProgress?: (chunk: string) => void,
  ): Promise<{ text: string; err?: string }> {
    // Clone all tools from parent — sub-agent has full agency
    const subTools = new ToolRegistry();
    for (const t of this.tools.all()) {
      subTools.register(t);
    }

    const subSystem = `你是主 Agent 派出的子任务 Agent。执行一个聚焦的专项任务。

## 任务
${prompt}

## 规则
1. **全权** — 你有写文件、跑命令、Git 操作的全部权限。放心干。
2. **专注** — 只完成分配给你的任务，不要偏离。
3. **先查后动** — 涉及代码库的，先调图查询工具（hologram_*）再动手。
4. **直接给结论** — 不要反问或延续对话。完成后直接输出结果。
5. **简短** — 输出精炼，不需要写论文。

## 可用工具
${subTools.all().map(t => `- **${t.name()}**: ${t.description().slice(0, 100)}`).join('\n')}`;

    // Shared provider, fresh session, no compact
    const subAgent = new Agent(
      this.prov,
      subTools,
      subSystem,
      { maxSteps: 8, temperature: 0.3 },
      (ev) => {
        if (ev.kind === EventKind.Text && ev.text && onProgress) {
          onProgress(ev.text);
        }
      },
    );

    try {
      // Run a single turn — sub-agent can call tools
      await subAgent.run(signal, '开始执行。');
      // Extract the last assistant message as the result
      const session = subAgent.getSession();
      const lastAssistant = [...session].reverse().find(m => m.role === 'assistant');
      return { text: lastAssistant?.content || '(子 Agent 没有生成回复)' };
    } catch (e: any) {
      return { text: '', err: e.message || '子 Agent 执行失败' };
    }
  }
}

// ---- Helpers ----

interface ToolOutcome {
  output: string;
  errMsg?: string;
  blocked: boolean;
  truncated: boolean;
  truncMsg?: string;
}

interface CallBatch {
  start: number;
  end: number;
  parallel: boolean;
}

function partitionCalls(registry: ToolRegistry, calls: ToolCall[]): CallBatch[] {
  const batches: CallBatch[] = [];
  let i = 0;
  while (i < calls.length) {
    if (isParallelizable(registry, calls[i].name)) {
      const start = i;
      i++;
      while (i < calls.length && isParallelizable(registry, calls[i].name)) i++;
      batches.push({ start, end: i, parallel: true });
    } else {
      batches.push({ start: i, end: i + 1, parallel: false });
      i++;
    }
  }
  return batches;
}

function isParallelizable(registry: ToolRegistry, name: string): boolean {
  const t = registry.get(name);
  return !!t && t.readOnly();
}

function batchStormSignature(
  calls: ToolCall[],
  outcomes: ToolOutcome[],
): { sig: string; ok: boolean } {
  if (calls.length === 0) return { sig: '', ok: false };
  const parts: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (!outcomes[i].errMsg || outcomes[i].blocked) return { sig: '', ok: false };
    parts.push(`${calls[i].name}\x00${outcomes[i].errMsg}`);
  }
  return { sig: parts.join('\x00'), ok: true };
}

function truncateToolOutput(s: string, toolName?: string): { body: string; truncMsg?: string } {
  if (s.length <= MAX_TOOL_OUTPUT_BYTES) return { body: s };
  const keep = Math.floor(MAX_TOOL_OUTPUT_BYTES / 2);
  const head = snapToRune(s, 0, keep);
  const tail = snapToRune(s, s.length - keep, s.length);
  const omitted = s.length - head.length - tail.length;
  const hint = truncationHint(toolName || '');
  return {
    body: `${head}\n\n…[截断 ${omitted} / ${s.length} 字节]…\n💡 ${hint}\n\n${tail}`,
    truncMsg: `tool output truncated: ${omitted} of ${s.length} bytes elided (${toolName || 'unknown'})`,
  };
}

function truncationHint(toolName: string): string {
  switch (toolName) {
    case 'read_file_content':
      return '此工具支持 offset/limit 分页。用 offset 翻到下一段，或缩小 limit 范围。';
    case 'search_code':
      return '用 maxResults 参数减少返回条数，或用更精确的 pattern + fileTypes 过滤。';
    case 'run_shell':
      return '用更精确的命令（管道过滤如 | head -n 100），或 runInBackground + bash_output 分批读取。';
    case 'list_directory':
      return '缩小 path 到具体子目录。';
    case 'git_diff':
      return '用 file 参数指定单个文件，或 staged 只看暂存区变更。';
    case 'hologram_analyze':
      return 'analyze 输出大是正常的。用 hologram_graph_summary 看概览，再按需查具体节点。';
    case 'git_log':
      return '用 count 参数减少返回的提交数量。';
    case 'hologram_timeline':
      return '用 limit 参数缩小结果数，或用 module 参数过滤特定模块。';
    default:
      return '用更窄的参数重新调用，或换用更精确的工具获取子集。';
  }
}

function snapToRune(s: string, lo: number, hi: number): string {
  while (lo > 0 && (s.charCodeAt(lo) & 0xc0) === 0x80) lo--;
  while (hi < s.length && (s.charCodeAt(hi) & 0xc0) === 0x80) hi++;
  return s.slice(lo, hi);
}

function finishReasonMessage(u?: Usage): string | undefined {
  if (!u) return undefined;
  switch (u.finish_reason) {
    case 'length':
      return 'response truncated: hit max output tokens';
    case 'content_filter':
      return 'response blocked by content filter';
    default:
      return undefined;
  }
}

function renderTranscript(msgs: Message[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    switch (m.role) {
      case 'user':
        lines.push(`[用户]\n${m.content || ''}\n`);
        break;
      case 'assistant': {
        if (m.content) lines.push(`[助手]\n${m.content}`);
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            lines.push(`[助手调用 ${tc.name}] ${tc.arguments}`);
          }
        }
        lines.push('');
        break;
      }
      case 'tool':
        lines.push(`[工具 ${m.name || ''} 结果]\n${m.content || ''}\n`);
        break;
      case 'system':
        lines.push(`[系统]\n${m.content || ''}\n`);
        break;
      default:
        lines.push(`[${m.role}]\n${m.content || ''}\n`);
        break;
    }
  }
  return lines.join('\n');
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i >= 0 ? s.slice(0, i) : s;
}
