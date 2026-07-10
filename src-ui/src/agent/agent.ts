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
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import { bus } from '../ui/events';
import { log } from './logger';
import { isRetryable, backoffDelay, sleepWithAbort, MAX_RETRIES } from './retry';
import { SessionStore } from './session-store';
import { CompactionTracker, type CompactionEvent, estimateTokens, type CompactionSessionStats, maybeTune, type CompactionConfig } from './compaction-model';
import { invoke } from '../bridge';
import { StreamingToolExecutor } from './streaming-executor';

// Shared types — also used internally by this file
import {
  EventKind,
  type AgentEvent,
  type ToolEvent,
  type Pricing,
  type EventSink,
  computeCost,
} from './agent-types';
export { EventKind, type ToolEvent, type AgentEvent, type Pricing, type EventSink, computeCost };

// ---- Agent Options ----

export interface AgentOptions {
  temperature?: number;
  pricing?: Pricing;
  /** Context window size in tokens. 0 = no compaction. */
  contextWindow?: number;
  /** Fraction of contextWindow that triggers compaction (default: 0.7) */
  compactRatio?: number;
  /** Minimum recent messages kept verbatim */
  recentKeep?: number;
  /** Max output tokens per turn (0 = provider default 32000) */
  maxTokens?: number;
  /** Session ID for persistence. Generated if not provided. */
  sessionId?: string;
  /** Called after each session save (fire-and-forget, never blocks the loop). */
  onSessionPersisted?: (sessionId: string, messages: Message[]) => void;
  /** Sub-agent nesting depth (0 = root, 1 = first fork). Auto-incremented. */
  subagentDepth?: number;
  // gate removed — permissions handled by Rust backend has_permission_to_use_tool()
}

const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const STORM_BREAK_THRESHOLD = 3;

// ── Fork subagent ──
const FORK_BOILERPLATE_TAG = 'fork-boilerplate';
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background';

function buildForkDirective(prompt: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent.
   You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: read, write, edit, search, shell, etc.
5. Stay strictly within your directive's scope. If you discover related systems outside
   your scope, mention them in one sentence at most — other workers cover those areas.
6. Keep your report concise and factual
7. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

Your directive: ${prompt}`;
}

// ---- Agent ----

export class Agent {
  private prov: Provider;
  private tools: ToolRegistry;
  private session: Message[];
  private temperature: number;
  private pricing: Pricing | undefined;
  private maxTokens: number;

  // Context management
  private contextWindow: number;
  private compactRatio: number;
  private recentKeep: number;
  private compactStuck = false;

  // Sub-agent depth tracking: 0 = root, 1 = first fork, 2 = grandchild, etc.
  private _subagentDepth = 0;
  private static readonly MAX_SUBAGENT_DEPTH = 3;

  // PreToolUse hooks — enrich tool results with graph context
  private hooks: HookRegistry | null = null;

  // Preflight hooks — warn before destructive writes (edit_file / write_file)
  private preflightHooks: PreflightHookRegistry | null = null;

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

  // Pending user message inserts (queued during tool execution, applied at safe boundary)
  private _pendingInserts: string[] = [];

  // Pending memory updates (queued from memory:saved event, applied at safe boundary)
  private _pendingMemoryUpdates: string[] = [];

  // Session persistence
  sessionId: string;
  private sessionStore: SessionStore | null = null;
  private _onSessionPersisted: ((sessionId: string, messages: Message[]) => void) | undefined;

  // Compaction cost model tracker
  private compactionTracker = new CompactionTracker();
  private _compactionConfigPath: string | null = null;

  constructor(
    prov: Provider,
    tools: ToolRegistry,
    systemPrompt: string,
    opts: AgentOptions = {},
    sink: EventSink = () => {},
    sessionStore?: SessionStore,
  ) {
    this.prov = prov;
    this.tools = tools;
    this.temperature = opts.temperature ?? 0.7;
    this.pricing = opts.pricing;
    this.maxTokens = opts.maxTokens ?? 0;
    this.contextWindow = opts.contextWindow ?? 1000000; // 1M tokens default — covers all current models, triggers compaction only when truly needed
    // ponytail: 0.55 puts threshold at 550K tokens (1M window).
    // 0.7 was too high — largest real sessions (450-630K) never triggered.
    // Tune based on compaction-model.ts data when enough samples accumulate.
    this.compactRatio = opts.compactRatio ?? 0.55;
    this.recentKeep = opts.recentKeep ?? 4;
    this.sink = sink;
    this._subagentDepth = opts.subagentDepth ?? 0;

    this.sessionId = opts.sessionId || `session-${Date.now()}`;
    this.sessionStore = sessionStore || null;
    this._onSessionPersisted = opts.onSessionPersisted;

    this.session = [];
    if (systemPrompt) {
      this.session.push({ role: 'system', content: systemPrompt });
    }

    // H1: listen for memory saves during session — inject as system-reminder
    // ponytail: event listener lives as long as this Agent instance; GC cleans it up.
    bus.on('memory:saved', ({ name, description, confidence }) => {
      if (!this._pendingMemoryUpdates) this._pendingMemoryUpdates = [];
      this._pendingMemoryUpdates.push(
        `记忆已更新: **${description || name}** (${confidence || 'reference'})`,
      );
    });
  }

  setHooks(hooks: HookRegistry): void { this.hooks = hooks; }

  setPreflightHooks(hooks: PreflightHookRegistry): void { this.preflightHooks = hooks; }

  // ---- Public API ----

  getSession(): Message[] {
    return this.session;
  }

  setSession(msgs: Message[]): void {
    this.session = msgs;
    ++this.sessionGen;
  }

  /** Fire-and-forget session save — never blocks the agent loop. */
  private _saveSession(): void {
    if (!this.sessionStore) return;
    this.sessionStore.save(this.sessionId, this.session).catch(() => {});
    if (this._onSessionPersisted) {
      try { this._onSessionPersisted(this.sessionId, this.session); } catch { /* best-effort */ }
    }
  }

  /** Resume from a persisted session. Returns null if session not found or empty. */
  static async resume(
    prov: Provider,
    tools: ToolRegistry,
    systemPrompt: string,
    sessionId: string,
    sessionStore: SessionStore,
    opts: AgentOptions = {},
    sink: EventSink = () => {},
  ): Promise<Agent | null> {
    const msgs = await sessionStore.load(sessionId);
    if (msgs.length === 0) return null;

    const agent = new Agent(prov, tools, '', { ...opts, sessionId }, sink, sessionStore);
    // Restore system prompt at position 0
    if (systemPrompt) {
      if (msgs.length > 0 && msgs[0].role === 'system') {
        msgs[0] = { role: 'system', content: systemPrompt };
      } else {
        msgs.unshift({ role: 'system', content: systemPrompt });
      }
    }
    agent.setSession(msgs);
    return agent;
  }

  getLastUsage(): Usage | undefined {
    return this.lastUsage;
  }

  getCacheTotals(): { hit: number; miss: number } {
    return { hit: this.cacheHitTotal, miss: this.cacheMissTotal };
  }

  /** Get compaction cost model stats for the current session. */
  getCompactionStats(): CompactionSessionStats {
    return this.compactionTracker.getStats(this.pricing);
  }

  /** Public accessors for the compaction stats tool. */
  getCompactionTracker(): CompactionTracker { return this.compactionTracker; }
  getPricing(): Pricing | undefined { return this.pricing; }
  getCompactRatio(): number { return this.compactRatio; }
  getRecentKeep(): number { return this.recentKeep; }
  getContextWindow(): number { return this.contextWindow; }

  /** Set the path for persisting auto-tuned compaction config. */
  setCompactionConfigPath(projectPath: string): void {
    this._compactionConfigPath = projectPath.replace(/\\/g, '/') + '/.hologram/compaction-config.json';
  }

  /** Try to load persisted compaction config. Returns null if none saved. */
  async loadCompactionConfig(): Promise<CompactionConfig | null> {
    if (!this._compactionConfigPath) return null;
    try {
      const raw = await invoke<string>('read_file_content', { filePath: this._compactionConfigPath });
      // Strip cat -n line numbers
      const stripped = raw.replace(/^\s*\d+\t/gm, '');
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }

  /** Apply auto-tuned compaction params. Returns the config if applied. */
  async applyAutoTuneConfig(): Promise<CompactionConfig | null> {
    const config = await this.loadCompactionConfig();
    if (!config) return null;
    this.contextWindow = 1_000_000;
    this.compactRatio = config.compactRatio;
    this.recentKeep = config.recentKeep;
    log.info('agent', 'auto-tune applied', {
      compactRatio: config.compactRatio,
      recentKeep: config.recentKeep,
      tunedAt: new Date(config.tunedAt).toISOString(),
      samples: config.sampleCount,
    });
    return config;
  }

  /** Check if we have enough data, and if so, compute & persist optimal params.
   *  Called after each compaction. Never throws — best-effort background tuning. */
  private async tryAutoTune(): Promise<void> {
    const result = maybeTune(this.compactionTracker, this.compactRatio, this.recentKeep, this.pricing);
    if (!result || !result.changed) return;

    const { config } = result;
    log.info('agent', 'auto-tune recommendation', {
      compactRatio: config.compactRatio,
      recentKeep: config.recentKeep,
      samples: config.sampleCount,
      reasoning: config.reasoning,
    });

    this.sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `[自动调优] ${config.reasoning}。参数已保存，下次会话生效。`,
    });

    // Persist for next session
    if (this._compactionConfigPath) {
      try {
        await invoke('write_file_content', {
          filePath: this._compactionConfigPath,
          content: JSON.stringify(config, null, 2),
        });
      } catch {
        // best-effort
      }
    }
  }

  /** Retract one turn: remove user message + following assistant + tool messages
   *  starting at sessionIndex. Notifies UI via SessionChanged event. */
  retractTurnAt(sessionIndex: number): void {
    let end = sessionIndex + 1;
    while (end < this.session.length && this.session[end].role !== 'user') {
      end++;
    }
    this.session.splice(sessionIndex, end - sessionIndex);
    ++this.sessionGen;
    this.sink({ kind: EventKind.SessionChanged });
  }

  /** Predicted session index of the next insert. Call before insertMessage to get index. */
  get nextInsertIndex(): number {
    return this.session.length + this._pendingInserts.length;
  }

  /** Insert a user message mid-run. Queued safely; agent sees it next loop iteration. */
  insertMessage(text: string): void {
    this._pendingInserts.push(text);
    this.sink({ kind: EventKind.Notice, level: 'info', text: '消息已插入，Agent 将在下一轮看到' });
  }

  // ── Sub-agent lifecycle ──

  /** Reference to the sub-agent pool. Set by workspace after construction. */
  private _subAgentPool: import('./coordinator').SubAgentPool | null = null;

  setSubAgentPool(pool: import('./coordinator').SubAgentPool): void {
    this._subAgentPool = pool;
  }

  /** Inject a sub-agent result as a pending task notification.
   *  Safe: queued and applied at the next safe boundary, never mid-stream.
   *  Truncates output at 4000 chars to prevent context pollution. */
  injectTaskNotification(text: string): void {
    const truncated = text.length > 4000
      ? text.slice(0, 4000) + `\n…[截断 ${text.length - 4000} 字符]`
      : text;
    this._pendingInserts.push(
      `<task-notification>\n子Agent 任务完成:\n${truncated}\n</task-notification>`,
    );
    // Emit bus event so UI (status bar, notification system) can react
    bus.emit('agent:task-notification', { text: truncated, length: text.length, truncated: text.length > 4000 });
  }

  /** Cascade abort: stop all sub-agents when the parent is interrupted. */
  cascadeAbort(): void {
    const pool = this._subAgentPool;
    if (pool) {
      const stopped = pool.stopAll();
      if (stopped.length > 0) {
        log.info('agent', `cascade abort: stopped ${stopped.length} sub-agents`);
      }
    }
  }

  /** Batch stop all running sub-agents. Returns the IDs of stopped agents. */
  stopAllSubAgents(): string[] {
    return this._subAgentPool?.stopAll() ?? [];
  }

  /** Apply queued inserts at a safe boundary (top of loop, after tool results committed). */
  private _applyPendingInserts(): void {
    if (this._pendingInserts.length === 0) return;
    for (const text of this._pendingInserts) {
      this.session.push({ role: 'user', content: text });
    }
    this._pendingInserts = [];
    // Signal chat.ts to finalize current turn before new response starts
    this.sink({ kind: EventKind.TurnStarted });
  }

  /** Apply queued memory updates at a safe boundary.
   *  Injected as system-reminder so Agent sees updated memories mid-session. */
  private _applyPendingMemoryUpdates(): void {
    if (!this._pendingMemoryUpdates?.length) return;
    const text = this._pendingMemoryUpdates.join('\n');
    this.session.push({
      role: 'user',
      content: `<system-reminder>${text}</system-reminder>`,
    });
    this._pendingMemoryUpdates = [];
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
    this.compactionTracker.reset();
    this.sink({ kind: EventKind.Notice, level: 'info', text: '已开启新会话' });
  }

  /** Check whether this agent is already a fork child (for recursion guard). */
  isInForkChild(): boolean {
    return this.session.some(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes(`<${FORK_BOILERPLATE_TAG}>`),
    );
  }

  /** Extract recent tool results from the parent session as context for a fork.
   *  Strips system prompt, assistant tool_calls, and truncates to the last N messages. */
  extractRecentContext(maxMessages: number): string {
    const recent = this.session
      .filter(m => m.role !== 'system') // don't leak parent system prompt
      .slice(-maxMessages);
    if (recent.length === 0) return '(无父Agent上下文)';
    return recent.map(m => {
      const roleLabel = m.role === 'assistant' ? '主Agent' :
        m.role === 'tool' ? `工具结果(${m.name || '?'})` : '用户';
      const content = typeof m.content === 'string' ? m.content.slice(0, 2000) :
        JSON.stringify(m.content).slice(0, 2000);
      return `[${roleLabel}] ${content}`;
    }).join('\n\n');
  }

  /** Run one turn: append user input, drive the tool loop. */
  async run(signal: AbortSignal, input: string): Promise<void> {
    this.session.push({ role: 'user', content: input });
    return this.runLoop(signal);
  }

  // ══════════════════════════════════════════════════════
  // Goal Loop — autonomous multi-turn execution
  // ══════════════════════════════════════════════════════

  /** Run a goal autonomously: plan → delegate to sub-agents → verify → repeat.
   *  Keeps going until the goal is achieved or confirmed impossible.
   *  The model drives the loop; sub-agents (via agent_spawn) do the concrete work
   *  with clean contexts, preventing long-context drift and hallucination.
   *
   *  ponytail: serial by design. Parallel is an optimization, not a correctness
   *  requirement — serial sub-agent spawns guarantee no file conflicts. */
  async runGoal(signal: AbortSignal, goal: string): Promise<{ status: 'completed' | 'failed' | 'aborted'; summary: string }> {
    const goalPrompt = `<goal>
## 总体目标
${goal}

## 执行模式
你是目标驱动的执行Agent，会持续工作直到目标达成。你不会在中间停下来等用户。

## 执行规则
1. **规划** — 把目标分解为连续的、可验证的具体步骤
2. **委派** — 每个具体步骤（改代码、跑命令、查文件、搜索）使用 \`agent_spawn\` fork 模式委派子Agent执行。子Agent有干净上下文，只做一件事，返回结果
3. **验证** — 每步完成后检查结果。正确→继续下一步，错误→分析原因→修正指令→重新委派
4. **循环** — 持续 规划→委派→验证→下一步，直到目标全部达成
5. **不要反问** — 不要在中间停下来问用户"要继续吗"。直接继续
6. **完成信号** — 目标达成时输出 \`[GOAL_COMPLETE]\` 并附摘要。无法达成时输出 \`[GOAL_FAILED]\` 并说明阻塞原因

## 禁止
- 输出纯文本分析后停止（分析完必须进入下一步行动）
- 反复分析同一问题而不行动
- 在子Agent完成后跳过验证直接声明完成

现在开始。
</goal>`;

    this.session.push({ role: 'user', content: goalPrompt });
    this.sink({ kind: EventKind.Notice, level: 'info', text: `[目标模式] ${goal.slice(0, 60)}…` });

    for (let iter = 0; !signal.aborted; iter++) {
      bus.emit('agent:progress', { step: iter + 1, toolName: 'goal-loop' });

      try {
        await this.runLoop(signal);
      } catch (e: any) {
        if (e?.message === 'aborted') return { status: 'aborted', summary: '被中断' };
        return { status: 'failed', summary: `执行异常: ${e?.message || e}` };
      }

      const last = this._lastAssistantContent();
      if (!last) {
        this.sink({ kind: EventKind.Notice, level: 'error', text: '目标执行异常: 模型未产出响应' });
        return { status: 'failed', summary: '模型未产出响应' };
      }

      if (/\[GOAL_COMPLETE\]/i.test(last)) {
        this.sink({ kind: EventKind.Notice, level: 'info', text: '✅ 目标达成' });
        return { status: 'completed', summary: last };
      }
      if (/\[GOAL_FAILED\]/i.test(last)) {
        this.sink({ kind: EventKind.Notice, level: 'warn', text: '❌ 目标失败' });
        return { status: 'failed', summary: last };
      }

      // Goal in progress — auto-continue
      this.session.push({
        role: 'user',
        content: `<system-reminder>
目标未完成。已完成 ${iter + 1} 轮。

如果目标尚未达成: 规划下一步（不重复已完成步骤）→ agent_spawn 委派 → 验证结果。
如果目标已全部达成: 输出 [GOAL_COMPLETE] 并附摘要。
如果遇到无法克服的障碍: 输出 [GOAL_FAILED] 并说明原因。

禁止反问用户。禁止只分析不行动。
</system-reminder>`,
      });
      this.sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 第 ${iter + 1} 轮完成，继续…` });
    }

    return { status: 'aborted', summary: '目标被中断' };
  }

  private _lastAssistantContent(): string {
    const session = this.getSession();
    for (let i = session.length - 1; i >= 0; i--) {
      if (session[i].role === 'assistant' && typeof session[i].content === 'string') {
        return session[i].content as string;
      }
    }
    return '';
  }

  /** Drive the tool loop without adding a user message. Used by fork children
   *  whose session already ends with the fork directive. */
  private async runLoop(signal: AbortSignal): Promise<void> {
    const turnStart = performance.now();
    const genAtStart = this.sessionGen;
    log.info('agent', 'turn started', { model: this.prov.name() });
    this.sink({ kind: EventKind.TurnStarted });

    for (let step = 0; ; step++) {
      // 每轮循环前检查中止信号与会话替换
      if (signal.aborted) throw new Error('aborted');
      if (this.sessionGen !== genAtStart) throw new Error('aborted');

      // Apply pending user inserts at the safe boundary (after tool results committed)
      this._applyPendingInserts();
      this._applyPendingMemoryUpdates();

      bus.emit('agent:progress', {
        step: step + 1,
        toolName: 'thinking',
      });

      // ---- Stream (with streaming tool executor + hooks) ----
      this.compactionTracker.recordTurn();
      const executor = new StreamingToolExecutor(this.tools, this.sink, this.hooks, this.preflightHooks);
      let { text, reasoning, signature, calls, usage, err } = await this.stream(signal, step + 1, executor);
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

      // Guard: DeepSeek rejects assistant messages with neither content nor tool_calls.
      if (!text && calls.length === 0) {
        if (this._pendingInserts.length > 0 || reasoning) {
          text = reasoning ? '(思考完成)' : '(等待中)';
        } else {
          log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
          this.sink({ kind: EventKind.Notice, level: 'warn', text: 'Provider 本次调用了但无内容返回，已跳过此轮。' });
          return;
        }
      }

      // Store assistant turn (reasoning kept for display, not re-uploaded)
      this.session.push({
        role: 'assistant',
        content: text,
        reasoning_content: reasoning,
        reasoning_signature: signature,
        tool_calls: calls,
      });

      if (calls.length === 0 && this._pendingInserts.length === 0) {
        this._saveSession();
        return;
      }

      // ---- Collect tool results (streaming executor ran them during stream) ----
      log.info('agent', 'collect streaming results', {
        tools: calls.map(c => c.name),
        count: calls.length,
      });
      const pendingResults = await executor.awaitRemaining();
      // Build results in call order
      const resultsByCallId = new Map(pendingResults.map(r => [r.call.id, r]));
      for (const call of calls) {
        const r = resultsByCallId.get(call.id);
        this.session.push({
          role: 'tool',
          content: r?.output || `error: tool "${call.name}" did not produce a result`,
          tool_call_id: call.id,
          name: call.name,
        });
      }

      // Save session after each complete turn (fire-and-forget)
      this._saveSession();

      // Compact if needed before next turn
      this.maybeCompact(usage);
    }
  }

  // ---- Private: stream (with retry) ----

  private async stream(
    signal: AbortSignal,
    turn: number,
    executor?: StreamingToolExecutor,
  ): Promise<{
    text: string;
    reasoning: string;
    signature: string;
    calls: ToolCall[];
    usage: Usage | undefined;
    err: Error | undefined;
  }> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        executor?.discard();
        return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: new Error('aborted') };
      }

      const result = await this.streamOnce(signal, turn, executor);

      // Success — no error, or error was already emitted as notice by streamOnce
      if (!result.err) return result;

      lastErr = result.err;

      // Reactive compact: if the error is "prompt too long", compact and retry
      // regardless of whether the error is normally retryable.
      if (this.isContextLengthError(lastErr) && !this.compactStuck && !this.compactRunning) {
        log.info('agent', 'reactive compact triggered by context-length error');
        this.sink({ kind: EventKind.Notice, level: 'warn', text: '上下文过长，自动压缩后重试…' });
        try {
          await this.compactNow(signal);
          // compactNow replaced this.session — skip backoff, retry immediately
          continue;
        } catch {
          // compactNow failed — fall through to normal retry/abort logic
          this.sink({ kind: EventKind.Notice, level: 'warn', text: '自动压缩失败，尝试直接重试…' });
        }
      }

      // Don't retry non-retryable errors
      if (!isRetryable(lastErr)) return result;

      // Last attempt — give up
      if (attempt >= MAX_RETRIES) break;

      // Discard any tool calls from the failed attempt
      executor?.discard();

      // Backoff before retry
      const delay = backoffDelay(attempt);
      log.info('agent', `stream retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`, { error: String(lastErr.message || lastErr) });
      this.sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `模型调用失败，${(delay / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${MAX_RETRIES})…`,
      });

      const aborted = await sleepWithAbort(delay, signal);
      if (aborted) {
        return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: new Error('aborted') };
      }
    }

    // Retries exhausted
    this.sink({
      kind: EventKind.Notice,
      level: 'error',
      text: `模型调用失败，已重试 ${MAX_RETRIES} 次：${lastErr?.message || '未知错误'}。请检查网络连接和 API 设置。`,
    });
    return { text: '', reasoning: '', signature: '', calls: [], usage: undefined, err: lastErr };
  }

  /** Single stream attempt — no retry logic.
   *  When executor is provided, tool calls are added to it immediately
   *  (execution starts during stream, not after). */
  private async streamOnce(
    signal: AbortSignal,
    _turn: number,
    executor?: StreamingToolExecutor,
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
      max_tokens: this.maxTokens,
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
            if (chunk.tool_call) {
              calls.push(chunk.tool_call);
              // Streaming execution: start tool immediately, don't wait for stream end
              executor?.addTool(chunk.tool_call);
            }
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

    if (err) {
      this.sink({ kind: EventKind.Notice, level: 'error', text: `模型调用失败: ${err.message || err}` });
      return { text: '', reasoning: '', signature: '', calls: [], usage, err };
    }

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
      // ponytail: truncation already shown inline in tool card output — skip the noisy notice
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
      // 中止信号优先检查
      if (signal.aborted) throw new Error('aborted');

      // ── Preflight hooks: warn before destructive writes ──
      let preflightWarning: string | null = null;
      if (this.preflightHooks) {
        try {
          preflightWarning = this.preflightHooks.check(call.name, args);
        } catch (e: any) {
          log.warn('agent', 'preflight hook failed', { tool: call.name, error: firstLine(e?.message || String(e)) });
        }
      }

      // ponytail: permission check moved to Rust has_permission_to_use_tool()
      // Agent calls invoke() → Tauri command → check_permission() → execute or deny
      bus.emit('agent:tool-started', { toolName: call.name, args });
      bus.emit('agent:progress', {
        step: 0, // tool execution phase — step=0 means "in tool"
        toolName: call.name,
      });
      // ponytail: inject _callId for sub-agent tool to emit agent:sub-* events
      if (call.name === 'agent_spawn') {
        args['_callId'] = call.id;
      }
      const toolStart = performance.now();
      result = await t.execute(args, (chunk) => {
        this.sink({
          kind: EventKind.ToolProgress,
          tool: { id: call.id, name: call.name, args: call.arguments, output: chunk, read_only: t?.readOnly() ?? false },
        });
      });
      log.debug('tool', 'executed', { name: call.name, elapsed_ms: Math.round(performance.now() - toolStart) });

      // ── Compaction model instrumentation ──
      this.compactionTracker.recordToolCall(call.name, call.arguments || '{}');
      if (call.name === 'read_file_content' || call.name === 'read_file') {
        const fp = String(args?.filePath || args?.file_path || '');
        if (fp) this.compactionTracker.recordFileRead(fp);
      }

      // Prepend preflight warning at the top of result — Agent sees it first
      if (preflightWarning) {
        result = preflightWarning + '\n\n' + '─'.repeat(40) + '\n\n' + result;
      }

      // ── PreToolUse hooks: enrich result with graph context ──
      if (this.hooks && !errMsg) {
        try {
          result = await this.hooks.apply(call.name, args, result);
        } catch (e: any) {
          log.warn('agent', 'hook apply failed', { tool: call.name, error: firstLine(e?.message || String(e)) });
          result = result + '\n\n[注意: 图上下文增强失败（hook error），以下结果为原始工具输出]';
        }
      }

      // Notify timeline + schedule a briefing check. Timeline gets
      // the raw write event; the debounced check produces violations.
      const WRITE_TOOLS = new Set([
        'edit_file', 'write_file', 'write_file_content',
        'delete_file_or_dir', 'rename_file_or_dir', 'move_file',
        'git_commit', 'git_discard',
      ]);
      if (!errMsg && WRITE_TOOLS.has(call.name)) {
        bus.emit('timeline:refresh');
        bus.emit('check:schedule');
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

  /** Estimate token count from message character count.
   *  ponytail: ~3.5 chars/token is conservative for CJK+code mix.
   *  Used when API hasn't returned usage yet, so compaction can trigger
   *  BEFORE sending the request — prevents 400 "prompt too long" errors. */
  private tokenCountWithEstimation(): number {
    let totalChars = 0;
    for (const m of this.session) {
      if (typeof m.content === 'string') totalChars += m.content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          totalChars += (tc.name?.length || 0) + (tc.arguments?.length || 0);
        }
      }
      if (m.reasoning_content) totalChars += m.reasoning_content.length;
    }
    return Math.ceil(totalChars / 2.5);
  }

  /** Check if an error looks like a context-length exceedance. */
  private isContextLengthError(err: Error): boolean {
    const msg = (err.message || String(err)).toLowerCase();
    return (
      msg.includes('prompt is too long') ||
      msg.includes('context length') ||
      msg.includes('too many tokens') ||
      msg.includes('maximum context') ||
      msg.includes('reduce the length') ||
      msg.includes('token limit') ||
      msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('prompt'))
    );
  }

  /** ponytail: record compaction + auto-tune if summary outcome.
   *  Centralizes the pattern repeated across compactNow and triggerAutoCompact. */
  private recordCompactionEvent(event: CompactionEvent): void {
    this.compactionTracker.recordCompaction(event);
    if (event.outcome === 'summary') this.tryAutoTune();
  }

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
        // ponytail: not enough messages to summarize but context is too long → force-truncate
        const truncated: Message[] = [
          ...msgs.slice(0, head),
          { role: 'user' as const, content: '<truncated-context>\n前面的消息因上下文过长已被截断。\n</truncated-context>' },
          ...msgs.slice(Math.max(head, msgs.length - tailCount)),
        ];
        this.session = truncated;
        ++this.sessionGen; this.stormSig = ''; this.stormCount = 0; this.compactStuck = false;
        this.recordCompactionEvent({
          ts: Date.now(), regionMsgCount: 0, regionTokensEst: 0,
          summaryInputTokens: 0, summaryOutputTokens: 0,
          tailMsgCount: Math.min(tailCount, msgs.length - head),
          preTokens: this.tokenCountWithEstimation(),
          postTokens: estimateTokens(truncated.reduce((s, m) => s + (m.content?.length || 0), 0)),
          outcome: 'stuck',
        });
        this.sink({ kind: EventKind.Notice, level: 'info', text: `上下文过长，已截断旧消息 (保留最近 ${Math.min(tailCount, msgs.length - head)} 条)` });
        return 'truncated';
      }
      const region = msgs.slice(head, start);
      let summary: string | null = null;
      try {
        summary = await this.summarizeRegion(signal, region);
      } catch (e: any) {
        log.warn('agent', `summarizeRegion failed (${e?.message || e}), falling back to truncation`);
      }
      if (!summary) {
        // ponytail: summarization failed, force-truncate as fallback
        const truncated: Message[] = [
          ...msgs.slice(0, head),
          { role: 'user' as const, content: '<truncated-context>\n前面的消息因压缩失败已被截断。\n</truncated-context>' },
          ...msgs.slice(Math.max(head, msgs.length - tailCount)),
        ];
        this.session = truncated;
        ++this.sessionGen; this.stormSig = ''; this.stormCount = 0; this.compactStuck = false;
        this.recordCompactionEvent({
          ts: Date.now(), regionMsgCount: region.length, regionTokensEst: estimateTokens(region.reduce((s, m) => s + (m.content?.length || 0), 0)),
          summaryInputTokens: 0, summaryOutputTokens: 0,
          tailMsgCount: msgs.length - Math.max(head, msgs.length - tailCount),
          preTokens: this.tokenCountWithEstimation(),
          postTokens: estimateTokens(truncated.reduce((s, m) => s + (m.content?.length || 0), 0)),
          outcome: 'truncated',
        });
        this.sink({ kind: EventKind.Notice, level: 'info', text: `压缩失败，已截断旧消息 (保留最近 ${Math.min(tailCount, msgs.length - head)} 条)` });
        return 'truncated';
      }

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

      // ── Compaction model instrumentation ──
      const regionChars = region.reduce((s, m) => s + (m.content?.length || 0), 0);
      const preChars = msgs.reduce((s, m) => s + (m.content?.length || 0), 0);
      const postChars = compacted.reduce((s, m) => s + (m.content?.length || 0), 0);
      this.recordCompactionEvent({
        ts: Date.now(),
        regionMsgCount: region.length,
        regionTokensEst: estimateTokens(regionChars),
        summaryInputTokens: estimateTokens(regionChars), // approximate
        summaryOutputTokens: estimateTokens(summary.length),
        tailMsgCount: msgs.length - start,
        preTokens: estimateTokens(preChars),
        postTokens: estimateTokens(postChars),
        outcome: 'summary',
      });
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

    // Use API-reported tokens when available, fall back to char-based estimation.
    // Estimation allows compaction to trigger BEFORE the first API call returns,
    // preventing 400 "prompt too long" on the very next request.
    const estimated = (usage && usage.total_tokens > 0)
      ? usage.total_tokens
      : this.tokenCountWithEstimation();
    const ratio = estimated / this.contextWindow;

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
      this.recordCompactionEvent({
        ts: Date.now(), regionMsgCount: 0, regionTokensEst: 0,
        summaryInputTokens: 0, summaryOutputTokens: 0,
        tailMsgCount: tailCount, preTokens: estimated, postTokens: estimated,
        outcome: 'stuck',
      });
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

      // Check if compaction helped enough — if still above 95%, we're stuck
      const postEstimate = this.tokenCountWithEstimation();
      if (postEstimate / this.contextWindow > 0.95) {
        this.compactStuck = true;
        this.compactRunning = false;
        this.sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: `压缩后上下文仍占用 ${(postEstimate / this.contextWindow * 100).toFixed(0)}%。建议用 /new 开启新会话。`,
        });
        return;
      }

      this.compactStuck = false;
      this.compactRunning = false;

      // ── Compaction model instrumentation ──
      const regionChars = region.reduce((s, m) => s + (m.content?.length || 0), 0);
      const postChars = compacted.reduce((s, m) => s + (m.content?.length || 0), 0);
      this.recordCompactionEvent({
        ts: Date.now(),
        regionMsgCount: region.length,
        regionTokensEst: estimateTokens(regionChars),
        summaryInputTokens: estimateTokens(regionChars),
        summaryOutputTokens: estimateTokens(summary.length),
        tailMsgCount: msgs.length - start,
        preTokens: estimated,
        postTokens: estimateTokens(postChars),
        outcome: 'summary',
      });
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

    // ponytail: timeout guard — summarization calls the LLM API; without a timeout,
    // a hung connection freezes the agent indefinitely during compaction. We use a
    // separate AbortController with a 30s deadline, linked to the caller's signal.
    const SUMMARIZE_TIMEOUT_MS = 30_000;
    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), SUMMARIZE_TIMEOUT_MS);
    const onExternalAbort = () => timeoutCtrl.abort();
    signal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const gen = this.prov.stream(timeoutCtrl.signal, {
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
    } catch (e: any) {
      if (timeoutCtrl.signal.aborted && !signal.aborted) {
        log.warn('agent', 'summarizeRegion timed out after 30s — falling back to truncation');
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onExternalAbort);
    }
  }

  private toolReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly() ?? false;
  }

  // ══════════════════════════════════════════════════════
  // Sub-agent spawn — for parallel / delegated work
  // ══════════════════════════════════════════════════════

  /** Spawn a sub-agent with full tool access to handle a focused task.
   *  `mode: 'fork'` inherits parent context + fork directive (default for agent_spawn).
   *  `mode: 'fresh'` creates a clean-slate agent (legacy). */
  async spawnSubAgent(
    signal: AbortSignal,
    description: string,
    prompt: string,
    onProgress?: (chunk: string) => void,
          mode: 'fork' | 'fresh' = 'fresh',
    ): Promise<{ text: string; err?: string }> {
      // Depth-based recursion guard
      if (mode === 'fork' && this._subagentDepth >= Agent.MAX_SUBAGENT_DEPTH) {
        return { text: '', err: `Exceeded max subagent depth (${Agent.MAX_SUBAGENT_DEPTH})` };
      }

    // Auto-isolation: create a git worktree for fork sub-agents so file mutations
    // are sandboxed and can be reviewed (diff) before merge. Falls back to direct
    // mode if isolation tool is unavailable or creation fails.
    let isolationId: string | null = null;
    if (mode === 'fork' && !!this.tools.get('agent_isolation_create')) {
      isolationId = `agent-${Date.now()}`;
      try {
        const createT = this.tools.get('agent_isolation_create');
        if (createT) await createT.execute({ agent_id: isolationId });
      } catch {
        isolationId = null;
      }
    }

    // Clone all tools from parent — sub-agent has full agency
    const subTools = new ToolRegistry();
    for (const t of this.tools.all()) {
      subTools.register(t);
    }

    let subSystem: string;

    if (mode === 'fork') {
      // Fork mode: build a clean sub-agent with its OWN system prompt.
      // We do NOT inherit the parent session — that causes the fork to inherit
      // the parent's system prompt (e.g. "delegate via agent_spawn") and the
      // fork then tries to spawn sub-agents of its own, hitting the recursion
      // guard. Instead: fresh session with fork-specific system prompt.
      //
      // We still inject the parent's recent tool outputs as context so the fork
      // knows what files were already read/modified — but we strip the parent's
      // tool_calls (the fork shouldn't see "calls it didn't make").
      const recentContext = this.extractRecentContext(12);
      subTools.unregister('agent_spawn'); // fork children cannot spawn further forks
      subTools.unregister('agent_message'); // no messaging between forks

      subSystem = `你是主Agent派出的工作进程（fork）。你不是主Agent，不要尝试委派子任务。

## 你的任务
${prompt}

## 硬性规则
1. **直接执行** — 你有全部工具权限，直接读、写、搜索、跑命令。不要 spawn 子Agent
2. **专注** — 只完成分配给你的任务，不要偏离
3. **先查后动** — 涉及代码库的，先查再动手
4. **直接给结论** — 不要反问、不要建议下一步、不要写论文
5. **验证** — 改完代码后跑编译/测试确认没炸

## 父Agent近期上下文
${recentContext}`;
    } else {
      // Fresh mode: also remove recursive spawn tools + job tools
      subTools.unregister('agent_spawn');
      subTools.unregister('agent_message');
      subTools.unregister('agent_stop_all');

      subSystem = `你是主 Agent 派出的子任务 Agent。执行一个聚焦的专项任务。

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
    }

    // Shared provider, fresh session, no compact
    const subAgent = new Agent(
      this.prov,
      subTools,
      subSystem,
      { temperature: 0.3, subagentDepth: this._subagentDepth + 1, contextWindow: this.contextWindow },
      (ev) => {
        // Forward text chunks for progress display
        if (ev.kind === EventKind.Text && ev.text && onProgress) {
          onProgress(ev.text);
        }
        // Forward tool dispatch/results so UI can show sub-agent activity
        if (ev.kind === EventKind.ToolDispatch) {
          onProgress?.(`🔧 ${(ev as any).name || '?'}\n`);
        }
      },
    );

    try {
      // Fork and fresh both use run() — fork has its own system prompt + stripped tools
      await subAgent.run(signal, mode === 'fork' ? prompt : '开始执行。');
      // Extract the last assistant message as the result
      const session = subAgent.getSession();
      const lastAssistant = [...session].reverse().find(m => m.role === 'assistant');
      return { text: lastAssistant?.content || '(子 Agent 没有生成回复)' };
    } catch (e: any) {
      return { text: '', err: e.message || '子 Agent 执行失败' };
    } finally {
      // Auto-diff + auto-merge: after fork agent finishes, check for changes
      if (isolationId) {
        try {
          const diffT = this.tools.get('agent_isolation_diff');
          const mergeT = this.tools.get('agent_isolation_merge');
          if (diffT) {
            const diffResult = await diffT.execute({ agent_id: isolationId });
            bus.emit('agent:sub-isolation-diff', {
              agentId: isolationId,
              diff: diffResult,
            });
            // Auto-merge: apply changes back to main worktree
            if (mergeT) {
              await mergeT.execute({ agent_id: isolationId });
            }
          }
        } catch { /* best effort */ }
      }
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
        case 'search_content':
      return '用 maxResults 参数减少返回条数，或用更精确的 pattern + fileTypes 过滤。';
    case 'run_shell':
      return '用更精确的命令（管道过滤如 | head -n 100），或 runInBackground + bash_output 分批读取。';
    case 'list_directory':
      return '缩小 path 到具体子目录。';
    case 'git_diff':
      return '用 file 参数指定单个文件，或 staged 只看暂存区变更。';
    case 'analyze_project':
      return 'analyze 输出大是正常的。用 graph_summary 看概览，再按需查具体节点。';
    case 'git_log':
      return '用 count 参数减少返回的提交数量。';
    case 'project_timeline':
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