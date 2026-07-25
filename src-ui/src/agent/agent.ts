// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 循环 — Run() → stream() → StreamingToolExecutor → 循环直到模型给出最终答案

import { rpc } from '../bridge';
import type { Message, Provider, ToolCall, Usage } from '../provider/types';
import { ChunkType, sanitizeToolPairing } from '../provider/types';
import type { AgentRecord, AgentStore } from './agent-store';
// Shared types — also used internally by this file
import {
  type AgentEvent,
  type AgentUINotifier,
  computeCost,
  EventKind,
  type EventSink,
  type Pricing,
  type ToolEvent,
} from './agent-types';
import {
  type CompactionConfig,
  type CompactionEvent,
  type CompactionSessionStats,
  CompactionTracker,
  estimateTokens,
  maybeTune,
} from './compaction-model';
import { type ExecStateInstance, createExecState, execState } from './execution-state';
import type { GoalManager, GoalRecord } from './goal-manager';
import { HookRegistry, type PreflightHookRegistry } from './hooks';
import { log } from './logger';
import { backoffDelay, isRetryable, MAX_RETRIES, sleepWithAbort } from './retry';
import { StreamingToolExecutor } from './streaming-executor';
import type { Tool } from './tool';
import { ToolRegistry } from './tool';
import type { MessageBus } from './message-bus';
import type { TaskBoard } from './task-board';
import type { DiscoveryBoard } from './discovery-board';
import { createBoardTrackingHook } from './hooks/board-tracking-hook';
import { enqueueIsolationOp } from './isolation-queue';
import { FileOwnership, WRITE_TOOLS, extractFilePath } from './file-ownership';

export { type AgentEvent, computeCost, EventKind, type EventSink, type Pricing, type ToolEvent };

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
  /** Unique agent identifier. Auto-generated if not provided. */
  agentId?: string;
  /** ID of the agent that spawned this one. null for main agent. */
  parentId?: string | null;
  /** Custom event sink. When set, Agent emits here instead of a no-op default.
   *  Used by sub-agents to capture output into SubAgentPart. */
  eventSink?: (ev: AgentEvent) => void;
  /** Execution state instance. Falls back to global execState if not provided. */
  execState?: ExecStateInstance;
  /** UI notification port — progress / tool-done / sub-agent lifecycle.
   *  Injected by the workspace; headless agents get none. */
  ui?: AgentUINotifier;
  /** 通信总线（可选 — 无则为 headless 无通信能力） */
  messageBus?: MessageBus;
  /** TaskBoard — 共享状态区，追踪异步子 Agent 的工作状态 */
  taskBoard?: TaskBoard;
  /** DiscoveryBoard — 共享发现区，Agent 间交换探索结果 */
  discoveryBoard?: DiscoveryBoard;
  // gate removed — permissions handled by Rust backend has_permission_to_use_tool()
}

const STORM_BREAK_THRESHOLD = 3;

// ---- Agent ----

export class Agent {
  private prov: Provider;
  private tools: ToolRegistry;
  private session: Message[];
  private temperature: number;
  private pricing: Pricing | undefined;
  private maxTokens: number;
  private _agentOpts: AgentOptions;

  // Context management
  private contextWindow: number;
  private compactRatio: number;
  private recentKeep: number;
  private compactStuck = false;

  // Sub-agent depth tracking: 0 = root, 1 = first fork, 2 = grandchild, etc.
  private _subagentDepth = 0;
  private static readonly MAX_SUBAGENT_DEPTH = 3;

  // Agent identity — persisted for lifecycle tracking, session recovery, lineage
  readonly id: string;
  readonly parentId: string | null;
  private agentStore: AgentStore | null = null;
  private goalManager: GoalManager | null = null;

  // Isolation ID for sub-agents — injected into tool args so Rust backend
  // can resolve worktree paths via forward_map_path.
  _isolationId?: string;

  // Goal loop safety: hard ceiling before forced termination (shouldn't trigger normally)
  private static readonly MAX_GOAL_ITERATIONS = 100;
  // Stall detection: consecutive rounds with no tool calls → agent stuck in analysis paralysis
  private static readonly MAX_STALL_ROUNDS = 3;

  // PreToolUse hooks — enrich tool results with graph context
  private hooks: HookRegistry | null = null;

  // Preflight hooks — warn before destructive writes (edit_file / write_file)
  private preflightHooks: PreflightHookRegistry | null = null;

  // Pre-run hook — called before each user message is pushed to session.
  // Returns optional context text to inject as <system-reminder> before the message.
  // Set by workspace for per-turn AuraSDK semantic recall.
  private _preRunHook: ((input: string) => Promise<string | null>) | null = null;

  // Storm breaker — detect repetitive failing tool calls
  private stormSig = '';
  private stormCount = 0;

  // Cache accumulation
  private cacheHitTotal = 0;
  private cacheMissTotal = 0;

  // Event sink — parent agents use the global bus; sub-agents get a custom one
  private _sink: (ev: AgentEvent) => void;
  // UI notification port (workspace-injected; no-op when headless)
  private _ui: AgentUINotifier;

  /** UI session ID — set by ChatCore before running so sub-agent notifications
   *  bump the correct session store (not just the active one). */
  private _uiSessionId: number = 0;

  // Last usage for status display
  private lastUsage: Usage | undefined;

  // Execution state — per-Agent instance (phase 1 of multi-window)
  private _execState: ExecStateInstance;

  // Pending user message inserts (queued during tool execution, applied at safe boundary)
  private _pendingInserts: string[] = [];

  // Pending memory updates (queued from memory:saved event, applied at safe boundary)
  private _pendingMemoryUpdates: string[] = [];

  // Track inbox messages already injected this runLoop cycle — prevents infinite
  // wakeup loop when LLM doesn't ack/reply (messages stay in inbox, finally
  // block would re-trigger _onMessageDelivered endlessly).
  private _injectedMsgIds = new Set<string>();

  // Signal of the currently active runLoop — sub-agents spawned from tool calls
  // merge it into their own abort signal so user-stop cascades to children.
  private _currentRunSignal: AbortSignal | null = null;

  // Whether runLoop is currently active — used by bus wakeup to avoid re-entry
  private _isRunning = false;

  /** Whether the runLoop is currently active */
  get isRunning(): boolean {
    return this._isRunning;
  }

  // TaskBoard — shared state for async sub-agent tracking
  private _taskBoard: TaskBoard | null = null;

  // DiscoveryBoard — shared discovery area for inter-agent knowledge sharing
  private _discoveryBoard: DiscoveryBoard | null = null;

  // Track discovery IDs already injected — prevents duplicate injection within the same runLoop
  private _injectedDiscoveryIds = new Set<string>();

  // Transient reminders — per-turn <system-reminder> injections that are sent
  // to the LLM but NOT persisted in this.session. Cleared at the top of each
  // runLoop step. Keeps session history clean for stable cache prefixes.
  private _transientReminders: string[] = [];

  // File ownership — runtime write-protection for parallel sub-agents.
  // Only fresh sub-agents (no worktree isolation) are subject to claims.
  private _fileOwnership: FileOwnership | null = null;

  // Session persistence
  sessionId: string;
  private _onSessionPersisted: ((sessionId: string, messages: Message[]) => void) | undefined;

  // Compaction cost model tracker
  private compactionTracker = new CompactionTracker();
  private _compactionConfigPath: string | null = null;

  constructor(prov: Provider, tools: ToolRegistry, systemPrompt: string, opts: AgentOptions = {}) {
    this.prov = prov;
    this.tools = tools;
    this._sink = opts.eventSink ?? (() => {});
    this._ui = opts.ui ?? {};
    this._agentOpts = opts;
    this.temperature = opts.temperature ?? 0.7;
    this.pricing = opts.pricing;
    this.maxTokens = opts.maxTokens ?? 0;
    this.contextWindow = opts.contextWindow || 1000000; // 1M tokens default; || catches zero (settings default) so compaction is never silently disabled
    // ponytail: 0.55 puts threshold at 550K tokens (1M window).
    // 0.7 was too high — largest real sessions (450-630K) never triggered.
    // Tune based on compaction-model.ts data when enough samples accumulate.
    this.compactRatio = opts.compactRatio ?? 0.55;
    this.recentKeep = opts.recentKeep ?? 4;
    this._subagentDepth = opts.subagentDepth ?? 0;
    this.id = opts.agentId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.parentId = opts.parentId ?? null;
    this._execState = opts.execState ?? execState;
    this._bus = opts.messageBus ?? null;
    this._taskBoard = opts.taskBoard ?? null;
    this._discoveryBoard = opts.discoveryBoard ?? null;

    this.sessionId = opts.sessionId || `session-${Date.now()}`;
    this._onSessionPersisted = opts.onSessionPersisted;

    this.session = [];
    if (systemPrompt) {
      this.session.push({ role: 'system', content: systemPrompt });
    }
  }

  /** Called by the workspace when a memory is saved mid-session — queued and
   *  injected as a system-reminder at the next safe boundary. */
  notifyMemorySaved(text: string): void {
    this._pendingMemoryUpdates.push(text);
  }

  setHooks(hooks: HookRegistry): void {
    this.hooks = hooks;
  }

  setPreflightHooks(hooks: PreflightHookRegistry): void {
    this.preflightHooks = hooks;
  }

  setUiSessionId(sid: number): void {
    this._uiSessionId = sid;
  }

  /** Set a hook that fires before each user message enters the session.
   *  Returns optional context injected as <system-reminder> before the message.
   *  Used for per-turn AuraSDK semantic memory recall. */
  setPreRunHook(hook: (input: string) => Promise<string | null>): void {
    this._preRunHook = hook;
  }

  // ---- Public API ----

  getSession(): Message[] {
    return this.session;
  }

  setSession(msgs: Message[]): void {
    this.session = msgs;
    this._execState.bumpVersion();
    this._ui.sessionReplaced?.(this.session);
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
  getCompactionTracker(): CompactionTracker {
    return this.compactionTracker;
  }
  getPricing(): Pricing | undefined {
    return this.pricing;
  }
  getCompactRatio(): number {
    return this.compactRatio;
  }
  getRecentKeep(): number {
    return this.recentKeep;
  }
  getContextWindow(): number {
    return this.contextWindow;
  }

  /** Set the path for persisting auto-tuned compaction config. */
  setCompactionConfigPath(projectPath: string): void {
    this._compactionConfigPath = projectPath.replace(/\\/g, '/') + '/.hologram/compaction-config.json';
  }

  /** Try to load persisted compaction config. Returns null if none saved. */
  async loadCompactionConfig(): Promise<CompactionConfig | null> {
    if (!this._compactionConfigPath) return null;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: this._compactionConfigPath });
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
    if (!result?.changed) return;

    const { config } = result;
    log.info('agent', 'auto-tune recommendation', {
      compactRatio: config.compactRatio,
      recentKeep: config.recentKeep,
      samples: config.sampleCount,
      reasoning: config.reasoning,
    });

    this._sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `[自动调优] ${config.reasoning}。参数已保存，下次会话生效。`,
    });

    // Persist for next session
    if (this._compactionConfigPath) {
      try {
        await rpc('write_file_content', {
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
    this._execState.bumpVersion();
    this._sink({ kind: EventKind.SessionChanged });
    this._ui.sessionReplaced?.(this.session);
  }

  /** Predicted session index of the next insert. Call before insertMessage to get index. */
  get nextInsertIndex(): number {
    return this.session.length + this._pendingInserts.length;
  }

  /** Insert a message into the session queue. Queued safely; agent sees it next loop iteration.
   *  Notice is opt-in — system callers (onSessionPersisted) should pass silent=true. */
  insertMessage(text: string, opts?: { silent?: boolean }): void {
    this._pendingInserts.push(text);
    if (!opts?.silent) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: '消息已插入，Agent 将在下一轮看到' });
    }
  }

  // ── Sub-agent lifecycle ──

  /** Reference to the sub-agent pool. Set by workspace after construction. */
  private _subAgentPool: import('./coordinator').SubAgentPool | null = null;

  /** Message bus for inter-agent communication. Set by runtime/spawnSubAgent. */
  private _bus: MessageBus | null = null;

  setSubAgentPool(pool: import('./coordinator').SubAgentPool): void {
    this._subAgentPool = pool;
  }

  /** Wire message bus for inter-agent communication.
   *  Registers the agent address + a wake callback that triggers runLoop
   *  when messages arrive while the agent is idle. */
  setBus(bus: MessageBus): void {
    this._bus = bus;
    bus.register(
      { agentId: this.id, parentId: this.parentId, depth: this._subagentDepth },
      () => { void this._onMessageDelivered(); },
    );
  }

  /** Wire discovery board for inter-agent knowledge sharing.
   *  Called by the runtime to inject the shared board into each agent. */
  setDiscoveryBoard(board: DiscoveryBoard): void {
    this._discoveryBoard = board;
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

  /** Wire file ownership registry for parallel sub-agent write protection.
   *  Only fresh sub-agents (no worktree) are subject to claims. */
  setFileOwnership(fo: FileOwnership): void {
    this._fileOwnership = fo;
  }

  /** Bus wake callback — called when a message is delivered to this agent's inbox.
   *  If the agent is idle (not running), starts a new runLoop to process the message.
   *  If already running, _injectInbox will pick up the message on the next iteration. */
  private async _onMessageDelivered(): Promise<void> {
    if (this._isRunning) return;
    if (this._bus?.unreadCount(this.id) === 0) return;
    const signal = this._execState.start();
    try {
      await this.run(signal, '');
    } catch {
      // 唤醒失败不致命——消息还在 inbox，下次 run() 会捡到
    } finally {
      this._execState.done();
    }
  }

  /** Batch stop all running sub-agents. Returns the IDs of stopped agents. */
  stopAllSubAgents(): string[] {
    return this._subAgentPool?.stopAll() ?? [];
  }

  /** Current count of running sub-agents. */
  runningSubAgentCount(): number {
    return this._subAgentPool?.runningCount ?? 0;
  }

  // ── Agent identity & persistence ──

  /** Wire persistence store. Main agent gets this from Workspace;
   *  sub-agents inherit the same store from their parent. */
  setAgentStore(store: AgentStore): void {
    this.agentStore = store;
  }

  setGoalManager(mgr: GoalManager): void {
    this.goalManager = mgr;
  }

  /** Persist current state + session to disk. Best-effort — never throws. */
  async saveState(status: AgentRecord['status'] = 'running'): Promise<void> {
    if (!this.agentStore) return;
    try {
      await this.agentStore.save(
        this.id,
        {
          parentId: this.parentId,
          description: this.id === 'main' ? '主Agent' : `子Agent (depth ${this._subagentDepth})`,
          status,
          subagentDepth: this._subagentDepth,
        },
        this.session,
      );
    } catch {
      /* persistence is best-effort — never block the agent loop */
    }
  }

  /** Apply queued inserts at a safe boundary (top of loop, after tool results committed). */
  private _applyPendingInserts(): void {
    if (this._pendingInserts.length === 0) return;
    for (const text of this._pendingInserts) {
      this.session.push({ role: 'user', content: text });
    }
    this._pendingInserts = [];
    // Signal chat.ts to finalize current turn before new response starts
    this._sink({ kind: EventKind.TurnStarted });
  }

  /** Apply queued memory updates at a safe boundary.
   *  Injected as transient system-reminder so Agent sees updated memories mid-session.
   *  Not persisted in session — Aura system stores memories independently. */
  private _applyPendingMemoryUpdates(): void {
    if (!this._pendingMemoryUpdates?.length) return;
    const text = this._pendingMemoryUpdates.join('\n');
    this._transientReminders.push(`<system-reminder>${text}</system-reminder>`);
    this._pendingMemoryUpdates = [];
  }

  /** Inject unread inbox messages as a system-reminder. Non-destructive —
   *  messages stay in inbox until explicitly acked or replied to.
   *  Tracks injected message IDs to prevent re-injection within the same
   *  result/reply are consumed (removed from inbox on inject) — they don't need a reply.
   *  request gets full content injected but stays in inbox (agent_reply needs it there).
   *  Free-type messages get a lightweight notification; content stays in inbox
   *  for agent_inbox lookup. Expired free messages are purged before injection. */
  private _injectInbox(): void {
    if (!this._bus) return;

    // 1. Purge expired free-type messages
    this._bus.purgeExpired(this.id);

    // 2. Consume result/reply: inject full content + remove from inbox
    const CONSUME_TYPES = ['result', 'reply'];
    const { consumed, remaining } = this._bus.consumeByType(this.id, CONSUME_TYPES);

    // 3. Non-consumed messages: inject full content for 'request', lightweight for others.
    //    'request' stays in inbox so agent_reply can find and ack it.
    const newRemaining = remaining.filter((m) => !this._injectedMsgIds.has(m.id));
    for (const m of newRemaining) this._injectedMsgIds.add(m.id);

    const newRequests = newRemaining.filter((m) => m.type === 'request');
    const newFreeMsgs = newRemaining.filter((m) => m.type !== 'request');

    // 4. Strong-type messages (result/reply/request) persist in session — they
    //    are consumed from inbox or require explicit ack, so they must survive
    //    as durable context for the agent to act on.
    const durableParts: string[] = [];
    if (consumed.length > 0) {
      const formatted = consumed
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 消息 (${consumed.length} 条):\n${formatted}`);
    }
    if (newRequests.length > 0) {
      const formatted = newRequests
        .map(
          (m) =>
            `[msg_id:${m.id}] from:${m.from} type:${m.type}\n${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}`,
        )
        .join('\n\n');
      durableParts.push(`📬 请求 (${newRequests.length} 条，用 agent_reply 回复):\n${formatted}`);
    }
    if (durableParts.length > 0) {
      this.session.push({
        role: 'user',
        content: `<system-reminder>\n${durableParts.join('\n\n')}\n</system-reminder>`,
      });
    }

    // 5. Free-type messages are transient (content stays in inbox for agent_inbox lookup)
    if (newFreeMsgs.length > 0) {
      const summary = newFreeMsgs
        .map((m) => `- from:${m.from} type:${m.type} (msg_id:${m.id})`)
        .join('\n');
      this._transientReminders.push(
        `<system-reminder>\n📬 未读消息 (${newFreeMsgs.length} 条，用 agent_inbox 查看详情):\n${summary}\n</system-reminder>`,
      );
    }

    // 6. Sync _injectedMsgIds with actual inbox — remove IDs for messages
    //    that were acked, expired, or consumed since last injection.
    const remainingIds = new Set(remaining.map((m) => m.id));
    for (const id of this._injectedMsgIds) {
      if (!remainingIds.has(id)) this._injectedMsgIds.delete(id);
    }
  }

  /** Inject new discoveries from other agents as a system-reminder.
   *  Only inject entries not yet seen this cycle + posted by other agents +
   *  within the last 5 minutes. Uses _injectedDiscoveryIds to prevent re-injection. */
  private _injectDiscoveries(): void {
    if (!this._discoveryBoard) return;
    const entries = this._discoveryBoard.query();
    if (entries.length === 0) return;
    // Only inject discoveries from other agents, not yet seen, within last 5 min
    const recent = entries.filter(
      (e) =>
        e.agentId !== this.id &&
        !this._injectedDiscoveryIds.has(e.id) &&
        Date.now() - e.ts < 5 * 60 * 1000,
    );
    if (recent.length === 0) return;
    for (const e of recent) this._injectedDiscoveryIds.add(e.id);
    const formatted = recent
      .map(
        (e) =>
          `[${e.category}] ${e.key}: ${e.value} (by ${e.agentId})`,
      )
      .join('\n');
    // Transient — discoveries can be re-queried via agent_lookup
    this._transientReminders.push(
      `<system-reminder>\n🔬 共享发现 (${recent.length} 条):\n${formatted}\n\n用 agent_discover 发布你的发现，agent_lookup 查询全部。\n</system-reminder>`,
    );
  }

  /** Start a fresh conversation — keep system prompt, clear everything else. */
  newSession(): void {
    const sys = this.session.length > 0 && this.session[0].role === 'system' ? this.session[0] : null;
    this.session = sys ? [sys] : [];
    this._execState.bumpVersion();
    this.cacheHitTotal = 0;
    this.cacheMissTotal = 0;
    this.lastUsage = undefined;
    this.stormSig = '';
    this.stormCount = 0;
    this.compactStuck = false;
    this.compactionTracker.reset();
    this._transientReminders = [];
    this._sink({ kind: EventKind.Notice, level: 'info', text: '已开启新会话' });
  }

  /** Extract recent tool results from the parent session as context for a fork.
   *  Strips system prompt, assistant tool_calls, and truncates to the last N
   *  messages. Each message truncated to 1000 chars to keep fork system prompt small. */
  extractRecentContext(maxMessages: number): string {
    const recent = this.session
      .filter((m) => m.role !== 'system') // don't leak parent system prompt
      .slice(-maxMessages);
    if (recent.length === 0) return '(无父Agent上下文)';
    return recent
      .map((m) => {
        const roleLabel =
          m.role === 'assistant' ? '主Agent' : m.role === 'tool' ? `工具结果(${m.name || '?'})` : '用户';
        const MAX = 1000;
        const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const content = raw.length > MAX ? raw.slice(0, MAX) + '…[截断]' : raw;
        return `[${roleLabel}] ${content}`;
      })
      .join('\n\n');
  }

  /** Run one turn: append user input, drive the tool loop.
   *  Empty input (bus wakeup) skips preRunHook and user message — runLoop
   *  starts from _injectInbox(), treating inbox messages as the sole input. */
  async run(signal: AbortSignal, input: string): Promise<void> {
    this._isRunning = true;
    this._ui.onStatusChange?.(true);
    if (this._preRunHook && input) {
      try {
        const recallCtx = await this._preRunHook(input);
        if (recallCtx) {
          this._transientReminders.push(`<system-reminder>\n${recallCtx}\n</system-reminder>`);
        }
      } catch {
        /* pre-run hook failure is non-fatal */
      }
    }
    if (input) {
      this.session.push({ role: 'user', content: input });
    }
    await this.runLoop(signal);
    // Fire onSessionPersisted callback (memory bundle ingest, git refresh, turn-start block)
    if (this._onSessionPersisted) {
      try {
        this._onSessionPersisted(this.sessionId, this.session);
      } catch {
        /* best-effort */
      }
    }
    // Persist agent state after each completed turn
    this.saveState('running').catch(() => {});
  }

  // ══════════════════════════════════════════════════════
  // Goal Loop — autonomous multi-turn execution
  // ══════════════════════════════════════════════════════

  /** Run a goal autonomously: plan → act → verify → repeat until goal_report.
   *  Always starts a NEW goal — single-slot semantics cancel any live one
   *  (resume is a separate path: resumeGoal). State lives in GoalManager
   *  (.hologram/goals/{id}/), fully isolated from the chat session slot —
   *  casual chat can no longer clobber the goal checkpoint. */
  async runGoal(
    signal: AbortSignal,
    goal: string,
  ): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string }> {
    if (!this.goalManager) {
      return { status: 'failed', summary: '目标管理器未初始化' };
    }
    const record = await this.goalManager.create(goal);
    this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标模式] ${record.text.slice(0, 60)}…` });
    const report = this._registerGoalReportTool();
    try {
      return await this._goalLoop(signal, record, false, report);
    } finally {
      this.tools.unregister('goal_report');
    }
  }

  /** Resume the live goal (paused, or a crash-orphaned active record). Same return shape as runGoal. */
  async resumeGoal(
    signal: AbortSignal,
    id?: string,
  ): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string }> {
    if (!this.goalManager) {
      return { status: 'failed', summary: '目标管理器未初始化' };
    }
    const record = id ? await this.goalManager.get(id) : await this.goalManager.getActive();
    if (!record || (record.status !== 'paused' && record.status !== 'active')) {
      return { status: 'failed', summary: '没有可恢复的目标。使用 /goal 创建新目标。' };
    }
    // ponytail: an 'active' record reaching here is a crash leftover (a live loop is
    // blocked by the UI's isRunning guard) — adopt it like a paused one.
    const snapshot = await this.goalManager.loadSession(record.id);
    if (snapshot && snapshot.length > 0) {
      this.session = snapshot;
      this._execState.bumpVersion();
    }
    this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 恢复: ${record.text.slice(0, 60)}…` });
    const report = this._registerGoalReportTool();
    try {
      return await this._goalLoop(signal, record, true, report);
    } finally {
      this.tools.unregister('goal_report');
    }
  }

  /** Register goal_report for the duration of one goal loop. Caller unregisters in finally.
   *  完成判定的主通道：模型显式上报，不再只靠正文正则。普通对话拿不到这个工具。 */
  private _registerGoalReportTool(): { called: boolean; status: 'completed' | 'failed'; summary: string } {
    const report = { called: false, status: 'completed' as 'completed' | 'failed', summary: '' };
    const goalReportTool: Tool = {
      name: () => 'goal_report',
      description: () =>
        '目标模式专用：确认目标已达成、或确认无法达成时调用，调用后目标循环结束。' +
        'status=completed 时 summary 写完成摘要；status=failed 时 summary 写阻塞原因。',
      parameters: () => ({
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['completed', 'failed'] },
          summary: { type: 'string' },
        },
        required: ['status', 'summary'],
      }),
      readOnly: () => true,
      execute: async (args: Record<string, unknown>) => {
        report.called = true;
        report.status = args.status === 'failed' ? 'failed' : 'completed';
        report.summary = typeof args.summary === 'string' ? args.summary : '';
        return `目标状态已记录: ${report.status}`;
      },
    };
    this.tools.register(goalReportTool);
    return report;
  }

  /** The shared goal loop — fresh runs and resumes converge here.
   *  ponytail: serial by design. Parallel is an optimization, not a correctness
   *  requirement — serial sub-agent spawns guarantee no file conflicts. */
  private async _goalLoop(
    signal: AbortSignal,
    record: GoalRecord,
    isResume: boolean,
    report: { called: boolean; status: 'completed' | 'failed'; summary: string },
  ): Promise<{ status: 'completed' | 'failed' | 'aborted' | 'paused'; summary: string }> {
    const mgr = this.goalManager;
    if (!mgr) return { status: 'aborted', summary: 'goal manager not initialized' };
    let stallRounds = record.stallRounds;

    // 重注完整目标提示词 — 新建与恢复都走这里。恢复时不能指望快照里
    // 还留着原文（可能已被压缩），重复出现的 <goal> 块是可接受的代价。
    this.session.push({ role: 'user', content: this._goalPrompt(record, isResume) });
    if (isResume) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 从第 ${record.iteration + 1} 轮恢复…` });
    }

    for (let iter = record.iteration; !signal.aborted && iter < Agent.MAX_GOAL_ITERATIONS; iter++) {
      this._ui.progress?.(iter + 1, 'goal-loop');

      // ── 检查点:记录 + 对话现场快照进 goal 专属槽 ──
      // ponytail: sessionBefore lets us strip partial turn messages on abort.
      const sessionBefore = this.session.length;
      await mgr.update(record.id, { iteration: iter, stallRounds, status: 'active' });
      await mgr.saveSession(record.id, this.session);

      try {
        await this.runLoop(signal);
      } catch (e: any) {
        // ponytail: 中断有多种冒泡形式 — runLoop 步骤边界抛 'aborted',
        // 流式 fetch 被掐断时抛 'BodyStreamBuffer was aborted' 之类的原始错误。
        // 用户意图是暂停,以 signal 为准,不认错误消息文本。
        if (signal.aborted || e?.message === 'aborted') {
          // ── 暂停:裁剪未完成轮次,快照进 goal 槽,记录转 paused ──
          this.session = this.session.slice(0, sessionBefore);
          await mgr.update(record.id, { status: 'paused', iteration: iter, stallRounds });
          await mgr.saveSession(record.id, this.session);
          // Clear goal context from in-memory session so normal chat doesn't auto-continue.
          // Full context lives in the goal slot; /goal resume restores it from there.
          this.session = this.session.length > 0 && this.session[0].role === 'system' ? [this.session[0]] : [];
          this._sink({
            kind: EventKind.Notice,
            level: 'info',
            text: `[目标] 已暂停于第 ${iter + 1} 轮。使用 /goal resume 继续。`,
          });
          return {
            status: 'paused',
            summary: `已暂停于第 ${iter + 1}/${Agent.MAX_GOAL_ITERATIONS} 轮。使用 /goal resume 继续。`,
          };
        }
        await mgr.update(record.id, { status: 'failed', summary: `执行异常: ${e?.message || e}` });
        return { status: 'failed', summary: `执行异常: ${e?.message || e}` };
      }

      // ── 完成判定:goal_report 优先,正文标记为旧会话 fallback ──
      if (report.called) {
        const summary = report.summary || this._lastAssistantContent();
        await mgr.update(record.id, { status: report.status, summary });
        this._sink({
          kind: EventKind.Notice,
          level: report.status === 'completed' ? 'info' : 'warn',
          text: report.status === 'completed' ? '✅ 目标达成' : '❌ 目标失败',
        });
        return { status: report.status, summary };
      }

      const last = this._lastAssistantContent();
      if (!last) {
        await mgr.update(record.id, { status: 'failed', summary: '模型未产出响应' });
        this._sink({ kind: EventKind.Notice, level: 'error', text: '目标执行异常: 模型未产出响应' });
        return { status: 'failed', summary: '模型未产出响应' };
      }

      if (/\[GOAL_COMPLETE\]/i.test(last)) {
        await mgr.update(record.id, { status: 'completed', summary: last });
        this._sink({ kind: EventKind.Notice, level: 'info', text: '✅ 目标达成' });
        return { status: 'completed', summary: last };
      }
      if (/\[GOAL_FAILED\]/i.test(last)) {
        await mgr.update(record.id, { status: 'failed', summary: last });
        this._sink({ kind: EventKind.Notice, level: 'warn', text: '❌ 目标失败' });
        return { status: 'failed', summary: last };
      }

      // ── Stall detection: consecutive rounds with no tool calls → stuck ──
      const hasToolCalls = this._lastAssistantHasToolCalls();
      if (!hasToolCalls) {
        stallRounds++;
        if (stallRounds >= Agent.MAX_STALL_ROUNDS) {
          const summary = `连续 ${stallRounds} 轮未执行任何工具调用或委派子Agent。目标可能过于模糊或超出能力范围。请拆分目标为更具体的步骤。`;
          await mgr.update(record.id, { status: 'failed', summary, stallRounds });
          this._sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: `[目标] 连续 ${stallRounds} 轮无实际行动，Agent 可能陷入分析瘫痪，终止`,
          });
          return { status: 'failed', summary };
        }
      } else {
        stallRounds = 0;
      }

      // Goal in progress — auto-continue
      const stallHint =
        stallRounds > 0
          ? `\n⚠️ 已连续 ${stallRounds}/${Agent.MAX_STALL_ROUNDS} 轮无实际行动。必须调用工具或委派子Agent，禁止只输出文字分析。`
          : '';
      this.session.push({
        role: 'user',
        content: `<system-reminder>
目标未完成。已完成 ${iter + 1} 轮。${stallHint}

如果目标尚未达成: 规划下一步（不重复已完成步骤）→ 执行或 agent_spawn 委派 → 验证结果。
如果目标已全部达成: 调用 goal_report(status="completed", summary=…) 上报。
如果遇到无法克服的障碍: 调用 goal_report(status="failed", summary=…) 说明原因。

禁止反问用户。禁止只分析不行动。
</system-reminder>`,
      });
      this._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 第 ${iter + 1} 轮完成，继续…` });
    }
    // Max iterations reached — forced termination (hard ceiling, shouldn't trigger in normal use)
    if (!signal.aborted) {
      const summary = `达到硬上限 ${Agent.MAX_GOAL_ITERATIONS} 轮。请拆分目标为更小单元。`;
      await mgr.update(record.id, { status: 'failed', summary });
      this._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `[目标] 达到硬上限 (${Agent.MAX_GOAL_ITERATIONS} 轮)，强制终止`,
      });
      return { status: 'failed', summary };
    }

    return { status: 'aborted', summary: '目标被中断' };
  }

  /** Full goal prompt — injected on BOTH fresh start and resume, so the model
   *  never depends on the original prompt surviving inside the snapshot. */
  private _goalPrompt(record: GoalRecord, isResume: boolean): string {
    const resumeNote = isResume
      ? `\n## 恢复执行\n这是恢复后的第 ${record.iteration + 1} 轮（此前已推进 ${record.iteration} 轮，对话现场已从快照恢复）。直接继续下一步，不要复盘已完成的工作。\n`
      : '';
    return `<goal>
## 总体目标
${record.text}
${resumeNote}
## 执行模式
你是目标驱动的执行Agent，会持续工作直到目标达成。你不会在中间停下来等用户。

## 执行规则
1. **规划** — 把目标分解为连续的、可验证的具体步骤
2. **执行** — 小步骤（几次工具调用内能完成）直接自己做；大步骤（多文件改动、独立子任务）用 \`agent_spawn\` fork 模式委派子Agent。子Agent有干净上下文，只做一件事，返回结果
3. **验证** — 每步完成后检查结果。正确→继续下一步，错误→分析原因→修正指令→重做
4. **循环** — 持续 规划→执行→验证→下一步，直到目标全部达成
5. **不要反问** — 不要在中间停下来问用户"要继续吗"。直接继续
6. **完成信号** — 判定目标已达成时调用 \`goal_report(status="completed", summary="完成摘要")\`；确认无法达成时调用 \`goal_report(status="failed", summary="阻塞原因")\`

## 禁止
- 输出纯文本分析后停止（分析完必须进入下一步行动）
- 反复分析同一问题而不行动
- 未验证结果就直接上报完成

现在开始。
</goal>`;
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

  /** Check whether the last assistant message had tool_calls (vs pure text). */
  private _lastAssistantHasToolCalls(): boolean {
    const session = this.getSession();
    for (let i = session.length - 1; i >= 0; i--) {
      if (session[i].role === 'assistant') {
        return (session[i].tool_calls?.length ?? 0) > 0;
      }
    }
    return false;
  }

  /** Drive the tool loop without adding a user message. Used by fork children
   *  whose session already ends with the fork directive. */
  private async runLoop(signal: AbortSignal): Promise<void> {
    const turnStart = performance.now();
    log.info('agent', 'turn started', { model: this.prov.name() });

    try {
    this._isRunning = true;
    this._currentRunSignal = signal; // sub-agent spawns merge this for cascade-abort
    this._sink({ kind: EventKind.TurnStarted });

    for (let step = 0; ; step++) {
      // Clear transient reminders from previous step — only current-step
      // reminders should be visible to the LLM this turn.
      // Step 0 skips the clear: run() may have already pushed the preRunHook
      // (aura recall) result into _transientReminders before calling runLoop.
      if (step > 0) this._transientReminders = [];

      // Abort check — signal covers user stop + session replacement (via this._execState.stop)
      if (signal.aborted) throw new Error('aborted');

      // Apply pending user inserts at the safe boundary (after tool results committed)
      this._applyPendingInserts();
      this._applyPendingMemoryUpdates();

      this._ui.progress?.(step + 1, 'thinking');

      // Drain background task notifications before each stream() call (transient —
      // progress updates have no value after the turn ends)
      try {
        const notes = await rpc<string>('drain_bg_notifications');
        if (notes) {
          this._transientReminders.push(`<system-reminder>\n${notes}\n</system-reminder>`);
        }
      } catch {
        // best-effort — don't block the loop if drain fails
      }

      // Inject unread inbox messages (peek — does not consume)
      this._injectInbox();

      // Inject new discoveries from other agents
      this._injectDiscoveries();

      // ---- Stream (with streaming tool executor + hooks) ----
      this.compactionTracker.recordTurn();
      const executor = new StreamingToolExecutor(
        this.tools,
        (ev: AgentEvent) => this._sink(ev),
        this.hooks,
        this.preflightHooks,
        this._isolationId ?? null,
      );
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
        this._diagTokenBreakdown(usage);
        this.cacheHitTotal += usage.cache_hit_tokens;
        this.cacheMissTotal += usage.cache_miss_tokens;
        this.lastUsage = usage;
        this._sink({
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
        this._sink({ kind: EventKind.Notice, level: 'warn', text: warnMsg });
      }

      // Guard: DeepSeek rejects assistant messages with neither content nor tool_calls.
      if (!text && calls.length === 0) {
        if (this._pendingInserts.length > 0 || reasoning) {
          text = reasoning ? '(思考完成)' : '(等待中)';
        } else {
          log.warn('agent', 'empty assistant turn — skipping push to avoid API 400');
          this._sink({ kind: EventKind.Notice, level: 'warn', text: 'Provider 本次调用了但无内容返回，已跳过此轮。' });
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
        return;
      }

      // ---- Collect tool results (streaming executor ran them during stream) ----
      log.info('agent', 'collect streaming results', {
        tools: calls.map((c) => c.name),
        count: calls.length,
      });
      const pendingResults = await executor.awaitRemaining();
      // Build results in call order
      const resultsByCallId = new Map(pendingResults.map((r) => [r.call.id, r]));

      // ── Storm breaker + compaction instrumentation ──
      // Both call sites were lost in 6e75046 (pre-StreamingToolExecutor cleanup);
      // rewired here. Storm breaker nudges the model out of identical-failure
      // loops; the tracker feeds compaction auto-tune with real loss data.
      const stormNudge = this._stormNudge(calls, resultsByCallId);
      for (const call of calls) {
        this.compactionTracker.recordToolCall(call.name, call.arguments || '{}');
        if (call.name === 'read_file_content' || call.name === 'read_file') {
          const fp = parseFilePathArg(call.arguments);
          if (fp) this.compactionTracker.recordFileRead(fp);
        }
      }

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const r = resultsByCallId.get(call.id);
        let content = r?.output || `error: tool "${call.name}" did not produce a result`;
        if (stormNudge && i === 0) content += stormNudge;
        this.session.push({
          role: 'tool',
          content,
          tool_call_id: call.id,
          name: call.name,
        });
        // Notify panels for auto-refresh (workspace-injected port)
        this._ui.toolDone?.(
          call.name,
          (() => {
            try {
              return JSON.parse(call.arguments || '{}');
            } catch {
              return {};
            }
          })(),
          r?.output || '',
        );
      }

      // Compact if needed before next turn
      this.maybeCompact(usage);
    }
    } finally {
      this._isRunning = false;
      this._ui.onStatusChange?.(false);
      // Re-check for NEW (not-yet-injected) messages — avoid infinite loop
      // from unacked messages that were already injected this cycle.
      if (!signal.aborted && this._bus) {
        const hasNew = this._bus.peekInbox(this.id).some((m) => !this._injectedMsgIds.has(m.id));
        if (hasNew) {
          queueMicrotask(() => { void this._onMessageDelivered(); });
        }
      }
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
        // Auto-adjust contextWindow: the model can't actually handle the current
        // window size, so lower it to the point where the error fired (with margin).
        const atTokens = this.tokenCountWithEstimation();
        if (atTokens > 0 && atTokens < this.contextWindow) {
          const adjusted = Math.max(atTokens - 10000, 50000); // 10K margin, floor 50K
          log.info('agent', 'auto-lowering contextWindow', { from: this.contextWindow, to: adjusted, erroredAt: atTokens });
          this.contextWindow = adjusted;
        }
        this._sink({ kind: EventKind.Notice, level: 'warn', text: '上下文过长，自动压缩后重试…' });
        try {
          await this.compactNow(signal);
          // compactNow replaced this.session — skip backoff, retry immediately
          continue;
        } catch {
          // compactNow failed — fall through to normal retry/abort logic
          this._sink({ kind: EventKind.Notice, level: 'warn', text: '自动压缩失败，尝试直接重试…' });
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
      log.info('agent', `stream retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`, {
        error: String(lastErr.message || lastErr),
      });
      this._sink({
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
    this._sink({
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
    // Append transient reminders as user messages at the end — they are
    // visible to the LLM this turn but not persisted in this.session.
    const transientMsgs: Message[] = this._transientReminders.map((content) => ({
      role: 'user' as const,
      content,
    }));
    const fullSession = transientMsgs.length > 0 ? [...this.session, ...transientMsgs] : this.session;

    const gen = this.prov.stream(signal, {
      messages: sanitizeToolPairing(fullSession),
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
              this._sink({ kind: EventKind.Reasoning, text: chunk.text });
            }
            break;

          case ChunkType.Text:
            text += chunk.text || '';
            this._sink({ kind: EventKind.Text, text: chunk.text });
            break;

          case ChunkType.ToolCallStart:
            if (chunk.tool_call) {
              this._sink({
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

          case ChunkType.ToolArgPreview:
            if (chunk.tool_arg_preview) {
              this._sink({
                kind: EventKind.ToolProgress,
                tool: {
                  id: chunk.tool_arg_preview.tool_id,
                  name: chunk.tool_arg_preview.tool_name,
                  output: chunk.tool_arg_preview.content,
                  read_only: true,
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
      this._sink({ kind: EventKind.Notice, level: 'error', text: `模型调用失败: ${err.message || err}` });
      return { text: '', reasoning: '', signature: '', calls: [], usage, err };
    }

    // Close the text stream
    if (text || reasoning) {
      this._sink({ kind: EventKind.Message, text, reasoning });
    }

    return { text, reasoning, signature, calls, usage, err: undefined };
  }

  // ---- Storm breaker — break repetitive tool-call loops ----

  /** Detect repetitive identical tool-call failures. Returns a nudge string to
   *  append to the first tool result, or null. The storm state (stormSig/stormCount)
   *  is reset by compaction/newSession; any successful call in a batch also resets. */
  private _stormNudge(
    calls: ToolCall[],
    resultsByCallId: Map<string, { output: string; err?: string }>,
  ): string | null {
    const outcomes: ToolOutcome[] = calls.map((c) => {
      const r = resultsByCallId.get(c.id);
      const output = r?.output ?? '';
      return {
        output,
        errMsg: r?.err,
        blocked: output.includes('架构门禁已阻止'),
        truncated: false,
      };
    });
    const { sig, ok } = batchStormSignature(calls, outcomes);
    if (!ok) {
      this.stormSig = '';
      this.stormCount = 0;
      return null;
    }
    if (sig !== this.stormSig) {
      this.stormSig = sig;
      this.stormCount = 1;
      return null;
    }
    this.stormCount++;
    if (this.stormCount < STORM_BREAK_THRESHOLD) return null;

    const subject = calls.length === 1 ? `"${calls[0].name}"` : `this batch of ${calls.length} tool calls`;
    const short = calls.length === 1 ? calls[0].name : `a batch of ${calls.length} calls`;

    this._sink({
      kind: EventKind.Notice,
      level: 'warn',
      text: `loop guard: ${short} failed ${this.stormCount}× the same way — nudging the model to change approach`,
    });

    return `\n\n[loop guard] ${subject} has now failed ${this.stormCount} times in a row with the same error. Re-sending it will not help. Change approach: if an argument is being truncated, write less in one call and split the work; otherwise fix the arguments, use a different tool, or explain the blocker in your final answer.`;
  }

  // ---- Context window management ----

  private compactRunning = false;
  // ⚡ sessionGen migrated to ExecutionState.sessionVersion

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
    // Transient reminders are also sent to the LLM this turn — count them
    for (const r of this._transientReminders) totalChars += r.length;
    return Math.ceil(totalChars / 2.5);
  }

  /** Diagnostic: breakdown token consumption by component.
   *  Logged to .hologram/logs/ui.log after each turn as structured NDJSON.
   *  Filter with: jq 'select(.module=="agent" and .message=="token breakdown") | .ctx' */
  private _diagTokenBreakdown(apiUsage: Usage | undefined): void {
    try {
      const est = (chars: number) => Math.ceil(chars / 2.5);
      const T = this.tools.schemas();
      const toolSchemaChars = T.reduce((s, t) => s + t.name.length + t.description.length + JSON.stringify(t.parameters).length, 0);

      let sysChars = 0, userChars = 0, reminderChars = 0, assistantChars = 0, toolChars = 0;
      let reminderCount = 0, inboxInjCount = 0;
      let transientChars = 0, transientCount = 0;

      for (const m of this.session) {
        const chars = (typeof m.content === 'string' ? m.content.length : 0) +
          (m.tool_calls?.reduce((s, tc) => s + (tc.name?.length || 0) + (tc.arguments?.length || 0), 0) || 0);

        if (m.role === 'system') { sysChars += chars; }
        else if (m.role === 'user') {
          if (typeof m.content === 'string' && m.content.includes('<system-reminder>')) {
            reminderChars += chars; reminderCount++;
            if (m.content.includes('📬')) inboxInjCount++;
          } else { userChars += chars; }
        }
        else if (m.role === 'assistant') { assistantChars += chars; }
        else if (m.role === 'tool') { toolChars += chars; }
      }

      // Transient reminders — sent to LLM but not in session
      for (const r of this._transientReminders) {
        transientChars += r.length;
        transientCount++;
      }

      const diag = {
        turn_session_msgs: this.session.length,
        // ── cost centres ──
        system_prompt: { tokens: est(sysChars), msgs: this.session.filter(m => m.role === 'system').length },
        user_real:    { tokens: est(userChars), msgs: this.session.filter(m => m.role === 'user' && typeof m.content === 'string' && !m.content.includes('<system-reminder>')).length },
        reminders:    { tokens: est(reminderChars), msgs: reminderCount, inbox: inboxInjCount },
        transient_reminders: { tokens: est(transientChars), msgs: transientCount },
        assistant:    { tokens: est(assistantChars), msgs: this.session.filter(m => m.role === 'assistant').length },
        tool_results: { tokens: est(toolChars), msgs: this.session.filter(m => m.role === 'tool').length },
        tool_schemas: { tokens: est(toolSchemaChars), count: T.length },
        // ── totals ──
        estimated_total: est(sysChars + userChars + reminderChars + transientChars + assistantChars + toolChars),
        api_reported: apiUsage ? { prompt: apiUsage.prompt_tokens, completion: apiUsage.completion_tokens, total: apiUsage.total_tokens } : null,
        cache: apiUsage ? { hit: apiUsage.cache_hit_tokens, miss: apiUsage.cache_miss_tokens } : null,
      };

      log.info('agent', 'token breakdown', diag);
    } catch { /* diagnostic must never throw */ }
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
      (msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('prompt')))
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
      const head = msgs.length > 0 && msgs[0].role === 'system' ? 1 : 0;
      // Keep last N messages verbatim (tail), compact the middle
      const tailCount = Math.max(4, this.recentKeep);
      const start = Math.max(head + 4, msgs.length - tailCount); // at least 4 compactable messages
      if (start - head < 4) {
        // ponytail: not enough messages to summarize but context is too long → force-truncate
        const truncated: Message[] = [
          ...msgs.slice(0, head),
          {
            role: 'user' as const,
            content: '<truncated-context>\n前面的消息因上下文过长已被截断。\n</truncated-context>',
          },
          ...msgs.slice(Math.max(head, msgs.length - tailCount)),
        ];
        this.session = truncated;
        this._execState.bumpVersion();
        this._ui.sessionReplaced?.(this.session);
        this.stormSig = '';
        this.stormCount = 0;
        this.compactStuck = false;
        this.recordCompactionEvent({
          ts: Date.now(),
          regionMsgCount: 0,
          regionTokensEst: 0,
          summaryInputTokens: 0,
          summaryOutputTokens: 0,
          tailMsgCount: Math.min(tailCount, msgs.length - head),
          preTokens: this.tokenCountWithEstimation(),
          postTokens: estimateTokens(truncated.reduce((s, m) => s + (m.content?.length || 0), 0)),
          outcome: 'stuck',
        });
        this._sink({
          kind: EventKind.Notice,
          level: 'info',
          text: `上下文过长，已截断旧消息 (保留最近 ${Math.min(tailCount, msgs.length - head)} 条)`,
        });
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
          {
            role: 'user' as const,
            content: '<truncated-context>\n前面的消息因压缩失败已被截断。\n</truncated-context>',
          },
          ...msgs.slice(Math.max(head, msgs.length - tailCount)),
        ];
        this.session = truncated;
        this._execState.bumpVersion();
        this._ui.sessionReplaced?.(this.session);
        this.stormSig = '';
        this.stormCount = 0;
        this.compactStuck = false;
        this.recordCompactionEvent({
          ts: Date.now(),
          regionMsgCount: region.length,
          regionTokensEst: estimateTokens(region.reduce((s, m) => s + (m.content?.length || 0), 0)),
          summaryInputTokens: 0,
          summaryOutputTokens: 0,
          tailMsgCount: msgs.length - Math.max(head, msgs.length - tailCount),
          preTokens: this.tokenCountWithEstimation(),
          postTokens: estimateTokens(truncated.reduce((s, m) => s + (m.content?.length || 0), 0)),
          outcome: 'truncated',
        });
        this._sink({
          kind: EventKind.Notice,
          level: 'info',
          text: `压缩失败，已截断旧消息 (保留最近 ${Math.min(tailCount, msgs.length - head)} 条)`,
        });
        return 'truncated';
      }

      const compacted: Message[] = [
        ...msgs.slice(0, head),
        {
          role: 'user' as const,
          content:
            '<compacted-context>\n以下是对前面讨论的总结（原始消息已压缩以节省上下文）:\n\n' +
            summary +
            '\n</compacted-context>',
        },
        ...msgs.slice(start),
      ];
      this.session = compacted;
      this._execState.bumpVersion();
      this._ui.sessionReplaced?.(this.session);
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
      this._sink({
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
    const estimated = usage && usage.total_tokens > 0 ? usage.total_tokens : this.tokenCountWithEstimation();
    const ratio = estimated / this.contextWindow;

    if (ratio < this.compactRatio) {
      this.compactStuck = false;
      return;
    }
    if (this.compactStuck) return;
    if (this.compactRunning) {
      this._sink({ kind: EventKind.Notice, level: 'info', text: '压缩已在运行中，跳过重复触发' });
      return;
    }
    this.compactRunning = true;

    // Auto-compact: trigger summarization in background after this turn
    this._sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `上下文使用率 ${(ratio * 100).toFixed(0)}% — 自动压缩中…`,
    });

    // Run compaction asynchronously (non-blocking for the turn)
    const msgs = this.session;
    const genAtStart = this._execState.bumpVersion();
    const head = msgs.length > 0 && msgs[0].role === 'system' ? 1 : 0;
    const tailCount = Math.max(4, this.recentKeep);
    const start = Math.max(head + 4, msgs.length - tailCount);
    if (start - head < 4) {
      this.compactStuck = true;
      this.compactRunning = false;
      this.recordCompactionEvent({
        ts: Date.now(),
        regionMsgCount: 0,
        regionTokensEst: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        tailMsgCount: tailCount,
        preTokens: estimated,
        postTokens: estimated,
        outcome: 'stuck',
      });
      this._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `上下文窗口 ${(ratio * 100).toFixed(0)}% 已满但对话太短无法压缩。建议用 /new 开启新会话。`,
      });
      return;
    }

    const region = msgs.slice(head, start);
    const abortCtrl = new AbortController();
    this.summarizeRegion(abortCtrl.signal, region)
      .then((summary) => {
        if (genAtStart !== this._execState.sessionVersion) {
          this.compactRunning = false;
          return;
        } // session replaced, discard
        if (!summary) {
          this.compactRunning = false;
          return;
        }
        const compacted: Message[] = [
          ...msgs.slice(0, head),
          {
            role: 'user' as const,
            content:
              '<compacted-context>\n以下是对前面讨论的总结（原始消息已压缩以节省上下文）:\n\n' +
              summary +
              '\n</compacted-context>',
          },
          ...msgs.slice(start),
        ];
        this.session = compacted;
        this._execState.bumpVersion();
        this._ui.sessionReplaced?.(this.session);
        this.stormSig = '';
        this.stormCount = 0;

        // Check if compaction helped enough — if still above 95%, we're stuck
        const postEstimate = this.tokenCountWithEstimation();
        if (postEstimate / this.contextWindow > 0.95) {
          this.compactStuck = true;
          this.compactRunning = false;
          this._sink({
            kind: EventKind.Notice,
            level: 'warn',
            text: `压缩后上下文仍占用 ${((postEstimate / this.contextWindow) * 100).toFixed(0)}%。建议用 /new 开启新会话。`,
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
        this._sink({
          kind: EventKind.Notice,
          level: 'info',
          text: `自动压缩完成: ${region.length} 条消息 → 摘要`,
        });
      })
      .catch(() => {
        if (genAtStart !== this._execState.sessionVersion) {
          this.compactRunning = false;
          return;
        } // session replaced, discard
        this.compactStuck = true;
        this.compactRunning = false;
        this._sink({
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
        if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('stream error');
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

  /** Spawn a sub-agent to handle a focused task. Blocks until the child finishes;
   *  the child's final report (plus merge note) becomes the tool result.
   *  `mode: 'fork'` (default) injects the parent's recent context and isolates
   *  file edits in a git worktree; `mode: 'fresh'` is a clean-slate agent.
   *  Abort sources are merged: user-stop (current run signal) + pool stop/timeout. */
  async spawnSubAgent(
    description: string,
    prompt: string,
    onProgress?: (chunk: string) => void,
    mode: 'fork' | 'fresh' = 'fork',
    toolAllowlist?: string[] | null,
    poolSignal?: AbortSignal,
    asyncMode?: boolean,
    agentIdOverride?: string,
  ): Promise<{ text: string; err?: string }> {
    // Depth-based recursion guard
    if (mode === 'fork' && this._subagentDepth >= Agent.MAX_SUBAGENT_DEPTH) {
      return { text: '', err: `Exceeded max subagent depth (${Agent.MAX_SUBAGENT_DEPTH})` };
    }

    // Merge abort sources — the child dies when the user's run is stopped OR
    // the pool stops/times-out this spawn. (The old wiring handed the pool
    // signal over too late, so "stopped" agents kept running detached.)
    // async 模式下子 agent 生命周期独立于父单轮 run；
    // sync 模式下父 agent 在等，父被 stop 子 agent 也该 stop
    const abortSources: AbortSignal[] = [];
    if (this._currentRunSignal && !asyncMode) abortSources.push(this._currentRunSignal);
    if (poolSignal) abortSources.push(poolSignal);
    const signal =
      abortSources.length > 1 ? AbortSignal.any(abortSources) : (abortSources[0] ?? new AbortController().signal);

    // Auto-isolation: create a git worktree for fork sub-agents so file mutations
    // are sandboxed and can be reviewed (diff) before merge. Falls back to direct
    // mode if isolation tool is unavailable or creation fails.
    let isolationId: string | null = null;
    if (mode === 'fork' && this.tools.get('agent_isolation_create')) {
      isolationId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const createT = this.tools.get('agent_isolation_create');
        if (createT) await createT.execute({ agent_id: isolationId });
      } catch {
        isolationId = null;
      }
    }

    // Clone tools from parent — apply allowlist filter if specified
    const subTools = new ToolRegistry();
    const allowed = toolAllowlist && toolAllowlist.length > 0 ? new Set(toolAllowlist) : null;
    for (const t of this.tools.all()) {
      if (!allowed || allowed.has(t.name())) {
        subTools.register(t);
      }
    }
    // Sub-agents never get recursive-spawn tools (fork children execute directly).
    subTools.unregister('agent_spawn');

    // ── Hard-block build/test commands in sub-agents ──
    // These commands contend on file locks (cargo target/, node_modules/,
    // .git/index.lock) when run in parallel, causing deadlocks or timeouts.
    // The sub-agent should finish file edits and report what it changed;
    // the parent agent runs verification after all sub-agents finish.
    const BUILD_TEST_RE = /\b(?:cargo|npm|npx|pnpm|yarn|make|docker|rustc|tsc|gradle|gradlew|mvn|mvnw|cmake|pytest|dotnet|xcodebuild|zig)\b|go\s+(?:build|test|vet|run)|python\s+-m\s+pytest/;
    const shellTool = subTools.get('run_shell');
    if (shellTool) {
      const origShellExec = shellTool.execute.bind(shellTool);
      shellTool.execute = async (args, onProgress) => {
        const cmd = (args.command as string) || '';
        if (BUILD_TEST_RE.test(cmd)) {
          return `[已拦截] 子 Agent 不允许执行构建/测试/包管理命令（"${cmd.slice(0, 100)}"）。\n` +
            `原因：并行子 Agent 同时跑这类命令会争抢文件锁（target/、node_modules/、.git/index.lock 等），导致死锁或超时。\n` +
            `请直接完成文件修改，在结论中说明：你改了哪些文件、建议主 Agent 跑什么命令来验证。`;
        }
        return origShellExec(args, onProgress);
      };
    }

    // ── File ownership for fresh sub-agents (fork has worktree isolation) ──
    // First writer claims a file; other sub-agents get rejected.
    // Prevents silent last-write-wins when multiple fresh agents edit
    // the same working tree concurrently.
    if (mode === 'fresh') {
      if (!this._fileOwnership) {
        this._fileOwnership = new FileOwnership();
      }
      const ownership = this._fileOwnership;
      const subAgentId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      for (const toolName of WRITE_TOOLS) {
        const tool = subTools.get(toolName);
        if (!tool) continue;
        const origExec = tool.execute.bind(tool);
        tool.execute = async (args, onProgress) => {
          const filePath = extractFilePath(toolName, args);
          if (filePath) {
            const result = ownership.claim(filePath, subAgentId);
            if (!result.ok) {
              return `[已拒绝] 文件 "${filePath}" 正在被另一个子 Agent (${result.owner}) 修改。\n` +
                `原因：并行子 Agent 同时写同一文件会导致后写覆盖先写（静默丢改动）。\n` +
                `请只修改分配给你的文件。如果确实需要改这个文件，在结论中说明，由主 Agent 统一处理。`;
            }
          }
          // move_file also claims the destination
          if (toolName === 'move_file' && args.to) {
            const result = ownership.claim(args.to as string, subAgentId);
            if (!result.ok) {
              return `[已拒绝] 目标路径 "${args.to}" 正在被另一个子 Agent (${result.owner}) 修改。`;
            }
          }
          return origExec(args, onProgress);
        };
      }
    }

    let subSystem: string;

    if (mode === 'fork') {
      // Fork mode: clean sub-agent with its OWN system prompt (never inherit the
      // parent's session/system prompt — that made forks try to spawn their own
      // sub-agents). The parent's recent tool outputs are injected as context so
      // the fork knows what was already read/modified.
      const recentContext = this.extractRecentContext(6);

      subSystem = `你是主Agent派出的工作进程（fork）。你不是主Agent。

## 你的任务
${prompt}

## 硬性规则
1. **直接执行** — 直接读、写、搜索、跑命令。你不能 spawn 子Agent（该工具已移除）
2. **专注** — 只完成分配给你的任务，不要偏离
3. **先查后动** — 涉及代码库的，先查再动手
4. **直接给结论** — 不要反问、不要建议下一步、不要写论文
5. **不跑构建/测试** — 不要跑 cargo / npm / pnpm / make / docker / go build 等任何构建、测试或包管理命令。这些命令在并行环境下会争抢文件锁（如 target/、node_modules/、.git/index.lock），导致死锁或超时。你只负责改文件，验证由主 Agent 在所有子任务完成后统一执行。如果认为改动有风险，在结论里说明即可。
6. **隔离** — 你的文件修改在独立 git worktree 中进行，正常保存即可；任务成功后变更会自动合并回主仓

## 父Agent近期上下文（⚠️ 快照 — 可能已过期。操作前自行验证文件当前状态）
${recentContext}`;
    } else {
      subSystem = `你是主 Agent 派出的子任务 Agent。执行一个聚焦的专项任务。

## 任务
${prompt}

## 规则
1. **全权** — 你有写文件、跑命令、Git 操作的全部权限。放心干。
2. **专注** — 只完成分配给你的任务，不要偏离。
3. **先查后动** — 涉及代码库的，先调图查询工具（hologram_*）再动手。
4. **直接给结论** — 不要反问或延续对话。完成后直接输出结果。
5. **简短** — 输出精炼，不需要写论文。
6. **不跑构建/测试** — 不要跑 cargo / npm / pnpm / make / docker / go build 等任何构建、测试或包管理命令。这些命令在并行环境下会争抢文件锁（如 target/、node_modules/、.git/index.lock），导致死锁或超时。你只负责改文件，验证由主 Agent 统一执行。如果认为改动有风险，在结论里说明即可。

## 可用工具
${subTools
  .all()
  .map((t) => `- **${t.name()}**: ${t.description().slice(0, 100)}`)
  .join('\n')}`;
    }

    // ── Hand the child's event stream to the UI (workspace-injected port builds
    // the SubAgentPart and returns the sink; headless → no-op sink) ──
    // Use agentIdOverride for both UI and Agent so the LLM-facing ID matches
    // board/bus entries (async mode returns this ID to the LLM).
    const subAgentId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subSink = this._ui.subAgentSpawn?.({ agentId: subAgentId, description, sessionId: this._uiSessionId }, onProgress) ?? (() => {});

    // Shared provider, fresh session, no compact
    const subAgent = new Agent(this.prov, subTools, subSystem, {
      temperature: 0.3,
      subagentDepth: this._subagentDepth + 1,
      contextWindow: this.contextWindow,
      eventSink: subSink,
      agentId: subAgentId,
      parentId: this.id,
      execState: createExecState(),
    });
    if (isolationId) {
      subAgent._isolationId = isolationId;
    }
    // Inherit persistence store from parent
    if (this.agentStore) {
      subAgent.setAgentStore(this.agentStore);
    }

    // Inherit message bus from parent — setBus handles register(addr, onWake)
    if (this._bus) {
      subAgent.setBus(this._bus);
    }

    // Register on TaskBoard + file tracking hook — async mode only.
    // Sync mode doesn't need board tracking (result returned directly, merged immediately).
    if (this._taskBoard && asyncMode) {
      this._taskBoard.register({
        agentId: subAgent.id,
        parentAgentId: this.id,
        description,
        isolationId,
      });
      const subHooks = new HookRegistry();
      subHooks.register(createBoardTrackingHook(subAgent.id, this._taskBoard));
      subAgent.setHooks(subHooks);
    }

    let subAgentSucceeded = false;
    let result: { text: string; err?: string };
    try {
      // Fork and fresh both use run() — fork has its own system prompt + stripped tools
      await subAgent.run(signal, mode === 'fork' ? prompt : '开始执行。');
      subAgentSucceeded = true;

      // ── Summary distillation — ensure sub-agent handoff is useful ──
      // Single continuation turn for sub-300-char summaries (the "好的，完成了" cases).
      const CONTEXT_LINE_LIMIT = 300;
      const session = subAgent.getSession();
      let lastAssistant = [...session].reverse().find((m) => m.role === 'assistant');
      let summary = lastAssistant?.content || '';

      if (summary.length < CONTEXT_LINE_LIMIT) {
        try {
          const expandPrompt =
            'Please expand your summary: describe exactly what you did, which files you read or modified, what you verified (build/tests), and the outcome. Use at least 200 characters.';
          await subAgent.run(signal, expandPrompt);
          const expandedSession = subAgent.getSession();
          const expanded = [...expandedSession].reverse().find((m) => m.role === 'assistant');
          if (expanded?.content && expanded.content.length > summary.length) {
            lastAssistant = expanded;
            summary = expanded.content;
          }
        } catch {
          /* distillation failed — return original summary */
        }
      }

      subAgent.saveState('done').catch(() => {});
      result = { text: summary || '(子 Agent 没有生成回复)' };
    } catch (e: any) {
      subAgent.saveState('failed').catch(() => {});
      let errReason: string;
      if (signal.aborted) {
        errReason = `子 Agent 被中止（超时或手动停止）: ${e.message || 'aborted'}`;
      } else if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
        errReason = `子 Agent 超时: ${e.message || 'aborted'}`;
      } else {
        errReason = e.message || '子 Agent 执行失败（未知原因）';
      }
      result = { text: '', err: errReason };
    } finally {
      this._ui.subAgentFinished?.(subAgentId, this._uiSessionId, subAgentSucceeded);
      // Release this sub-agent's file ownership claims
      this._fileOwnership?.release(subAgent.id);
    }

    if (asyncMode) {
      // ── Async mode: save diff to board + notify via bus (no auto-merge) ──
      let diffText = '';
      if (isolationId && subAgentSucceeded) {
        try {
          const diffT = this.tools.get('agent_isolation_diff');
          if (diffT) diffText = await diffT.execute({ agent_id: isolationId });
        } catch {
          /* diff unavailable */
        }
      }

      if (subAgentSucceeded) {
        this._taskBoard?.complete(subAgent.id, result.text || '(无摘要)', diffText);
        // Worktree 保留 — 等 agent_merge 时再处理
      } else if (signal.aborted) {
        this._taskBoard?.stop(subAgent.id);
        // 中止时清理 worktree
        if (isolationId) {
          const discardT = this.tools.get('agent_isolation_discard');
          await discardT?.execute({ agent_id: isolationId }).catch(() => {});
        }
      } else {
        this._taskBoard?.fail(subAgent.id, result.err || '子 Agent 执行失败');
        // 失败时清理 worktree
        if (isolationId) {
          const discardT = this.tools.get('agent_isolation_discard');
          await discardT?.execute({ agent_id: isolationId }).catch(() => {});
        }
      }

      // 通过 bus 通知父 Agent
      if (this._bus) {
        try {
          this._bus.send({
            from: subAgent.id,
            to: this.id,
            type: 'result',
            payload: {
              summary: subAgentSucceeded ? result.text : '',
              success: subAgentSucceeded,
              agentId: subAgent.id,
              error: subAgentSucceeded ? undefined : result.err,
            },
          });
        } catch {
          /* bus send failure is non-fatal */
        }
      }
    } else {
      // ── Sync mode: finalize isolation worktree (serialized) ──
      if (isolationId) {
        const mergeNote = await enqueueIsolationOp(() => this._finalizeIsolation(isolationId, subAgentSucceeded));
        if (mergeNote) {
          result = { text: (result.text ? result.text + '\n\n' : '') + mergeNote, err: result.err };
        }
      }
      // Sync mode: no board entry was created (async-only), nothing to clean up
    }

    // Unregister sub-agent from bus after all completion handling
    if (this._bus) {
      this._bus.unregister(subAgent.id);
    }
    return result;
  }

  /** Merge (on success) or discard (on failure) an isolation worktree.
   *  Returns a human/model-readable note to append to the sub-agent result. */
  private async _finalizeIsolation(agentId: string, success: boolean): Promise<string> {
    const diffT = this.tools.get('agent_isolation_diff');
    const mergeT = this.tools.get('agent_isolation_merge');
    const discardT = this.tools.get('agent_isolation_discard');
    try {
      if (success && mergeT) {
        try {
          await mergeT.execute({ agent_id: agentId });
          await discardT?.execute({ agent_id: agentId }).catch(() => {});
          return '[隔离合并] ✅ 变更已自动合并回主仓。可用 git_status / git_diff 审阅。';
        } catch (mergeErr: any) {
          const errMsg = mergeErr?.message || String(mergeErr);
          log.warn('agent', `merge conflict for ${agentId}: ${errMsg}`);
          // Capture the diff BEFORE discarding the worktree — otherwise the
          // sub-agent's work is silently lost.
          let diffText = '';
          try {
            if (diffT) diffText = await diffT.execute({ agent_id: agentId });
          } catch {
            /* diff unavailable */
          }
          await discardT?.execute({ agent_id: agentId }).catch(() => {});
          const clipped = diffText.length > 8000 ? diffText.slice(0, 8000) + '\n…[diff 过长已截断]' : diffText;
          return (
            `[隔离合并] ⚠️ 自动合并失败: ${errMsg}\n` +
            'worktree 已清理，但变更 diff 已保全在下方。请审阅后用 edit_file 把需要的部分手动应用到主仓:\n\n' +
            (clipped || '(diff 获取失败)')
          );
        }
      }
      // Sub-agent failed/aborted — discard the worktree, nothing to merge.
      await discardT?.execute({ agent_id: agentId }).catch(() => {});
      return '';
    } catch {
      return ''; // best effort — cleanup failures must not break the result flow
    }
  }
}

// Serialization of isolation merge/discard lives in isolation-queue.ts
// (shared with merge.ts — concurrent git operations race on the index lock).

// ---- Helpers ----

interface ToolOutcome {
  output: string;
  errMsg?: string;
  blocked: boolean;
  truncated: boolean;
  truncMsg?: string;
}

function batchStormSignature(calls: ToolCall[], outcomes: ToolOutcome[]): { sig: string; ok: boolean } {
  if (calls.length === 0) return { sig: '', ok: false };
  const parts: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (!outcomes[i].errMsg || outcomes[i].blocked) return { sig: '', ok: false };
    parts.push(`${calls[i].name}\x00${outcomes[i].errMsg}`);
  }
  return { sig: parts.join('\x00'), ok: true };
}

/** Extract a file path from tool-call arguments (read_file_content / read_file).
 *  Tolerates both filePath and file_path keys; returns null on any failure. */
function parseFilePathArg(argsJson: string | undefined): string | null {
  try {
    const a = JSON.parse(argsJson || '{}');
    const fp = a.filePath ?? a.file_path;
    return typeof fp === 'string' && fp.length > 0 ? fp : null;
  } catch {
    return null;
  }
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
