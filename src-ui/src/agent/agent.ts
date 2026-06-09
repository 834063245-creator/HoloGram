// Agent 循环 — Run() → stream() → executeBatch() → 循环直到模型给出最终答案

import type {
  Chunk,
  Message,
  Provider,
  ToolCall,
  Usage,
} from '../provider/types';
import { ChunkType, sanitizeToolPairing } from '../provider/types';
import type { Tool, ToolRegistry } from './tool';

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
}

const DEFAULT_MAX_STEPS = 10;
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
    this.contextWindow = opts.contextWindow ?? 0;
    this.compactRatio = opts.compactRatio ?? 0.7;
    this.recentKeep = opts.recentKeep ?? 4;
    this.sink = sink;

    this.session = [];
    if (systemPrompt) {
      this.session.push({ role: 'system', content: systemPrompt });
    }
  }

  // ---- Public API ----

  getSession(): Message[] {
    return this.session;
  }

  setSession(msgs: Message[]): void {
    this.session = msgs;
  }

  getLastUsage(): Usage | undefined {
    return this.lastUsage;
  }

  getCacheTotals(): { hit: number; miss: number } {
    return { hit: this.cacheHitTotal, miss: this.cacheMissTotal };
  }

  /** Run one turn: append user input, drive the tool loop. */
  async run(signal: AbortSignal, input: string): Promise<void> {
    this.sink({ kind: EventKind.TurnStarted });
    this.session.push({ role: 'user', content: input });

    for (let step = 0; this.maxSteps <= 0 || step < this.maxSteps; step++) {
      // ---- Stream ----
      const { text, reasoning, signature, calls, usage, err } = await this.stream(signal, step + 1);
      if (err) throw err;

      if (usage && usage.total_tokens > 0) {
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
      // AbortSignal check before long execution
      if (signal.aborted) throw new Error('aborted');
      result = await t.execute(args);
    } catch (e: any) {
      result = `error: ${e.message || e}`;
      errMsg = firstLine(e.message || String(e));
    }

    const { body, truncMsg } = truncateToolOutput(result);
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

  private maybeCompact(usage: Usage | undefined): void {
    if (this.contextWindow <= 0) return;
    if (!usage || usage.total_tokens <= 0) return;

    const ratio = usage.total_tokens / this.contextWindow;
    if (ratio < this.compactRatio) {
      this.compactStuck = false;
      return;
    }
    if (this.compactStuck) return;

    // Simple compaction: summarize older messages, keep recent tail
    // For now, just flag — full summarization needs a separate model call
    if (ratio > 0.95) {
      this.compactStuck = true;
      this.sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `Context window ${(ratio * 100).toFixed(0)}% full — compaction needed but not yet implemented. Start a new conversation soon.`,
      });
    }
  }

  private toolReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly() ?? false;
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

function truncateToolOutput(s: string): { body: string; truncMsg?: string } {
  if (s.length <= MAX_TOOL_OUTPUT_BYTES) return { body: s };
  const keep = Math.floor(MAX_TOOL_OUTPUT_BYTES / 2);
  const head = snapToRune(s, 0, keep);
  const tail = snapToRune(s, s.length - keep, s.length);
  const omitted = s.length - head.length - tail.length;
  return {
    body: `${head}\n\n…[truncated ${omitted} of ${s.length} bytes — rerun with narrower args to see the middle]…\n\n${tail}`,
    truncMsg: `tool output truncated: ${omitted} of ${s.length} bytes elided`,
  };
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

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i >= 0 ? s.slice(0, i) : s;
}
