// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Coordinator — sub-agent lifecycle registry.
//
// 模型：子Agent = 一个会跑很久的工具调用。agent_spawn 阻塞至子Agent完成，
// 子Agent的最终报告就是该工具调用的结果。同一轮发多个 agent_spawn 时
// StreamingToolExecutor 并发执行，天然并行。
//
// Pool 的职责因此收窄为四件事：
//   1. 并发上限（maxConcurrent）
//   2. 超时兜底（timeout → abort runFn）
//   3. 中断传播（stop/stopAll → AbortController，spawn 时同步把 signal 交给 runFn，
//      不存在"先跑起来再补 signal"的时序窗）
//   4. 状态查询（getHandle / summary，供 UI 与日志使用）

export enum SubAgentStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Stopped = 'stopped',
}

export interface SubAgentHandle {
  id: string;
  description: string;
  status: SubAgentStatus;
  startedAt: number;
  result?: string;
  error?: string;
}

/** The work a sub-agent runs. Receives the pool's AbortSignal synchronously —
 *  wire it into the child agent's LLM stream so stop/timeout actually kills it. */
export type SubAgentRunFn = (signal: AbortSignal) => Promise<{ text: string; err?: string }>;

/** Returned synchronously by spawn(). `done` resolves exactly once with the
 *  final handle (completed / failed / stopped / timeout-as-failed). */
export interface SpawnedAgent {
  id: string;
  signal: AbortSignal;
  done: Promise<SubAgentHandle>;
}

interface PendingAgent {
  handle: SubAgentHandle;
  done: Promise<SubAgentHandle>;
  resolve: (h: SubAgentHandle) => void;
  callId?: string;
  finished?: boolean; // guard against double-finish (timeout + promise race)
  abortController: AbortController;
}

interface QueuedSpawn {
  description: string;
  runFn: SubAgentRunFn;
  callId?: string;
  timeoutMs?: number;
  queuedId: string;
  resolve: (spawned: SpawnedAgent) => void;
}

const DEFAULT_MAX_CONCURRENT = 5;
const MAX_QUEUE_SIZE = 20;
// 10 minutes — coding sub-agents run builds/tests; 2 min timed out healthy agents
// and (worse) left them running detached while the parent was told they failed.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class SubAgentPool {
  private agents = new Map<string, PendingAgent>();
  private completed: SubAgentHandle[] = [];
  private static readonly MAX_COMPLETED = 20; // cap to prevent memory leak
  private maxConcurrent: number;
  private defaultTimeoutMs: number;
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Queue for rate-limit backoff ──
  private queue: QueuedSpawn[] = [];
  private _queuedIds = new Set<string>();

  /** Optional callback fired when any sub-agent finishes (for board archiving etc.) */
  onFinish?: (agentId: string, status: SubAgentStatus) => void;

  /** Map from model-visible id (sub-...) to pool internal id (subagent-...) */
  private _aliasToInternal = new Map<string, string>();

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT, defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
    this.maxConcurrent = maxConcurrent;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  private _addCompleted(handle: SubAgentHandle): void {
    this.completed.push(handle);
    if (this.completed.length > SubAgentPool.MAX_COMPLETED) {
      this.completed = this.completed.slice(-SubAgentPool.MAX_COMPLETED);
    }
  }

  /** Spawn a sub-agent. When at maxConcurrent, queues the request instead of failing.
   *  Returns null only when the queue is also full.
   *  Idempotent on callId: re-dispatch of the same tool call (stream retry)
   *  returns the already-running agent instead of starting a duplicate. */
  spawn(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent | null {
    if (callId) {
      for (const [id, pending] of this.agents) {
        if (pending.callId === callId) {
          return { id, signal: pending.abortController.signal, done: pending.done };
        }
      }
      // Also check queue for duplicates
      if (this.queue.some((q) => q.callId === callId)) {
        return null; // already queued with this callId
      }
    }
    if (this.agents.size >= this.maxConcurrent) {
      // Queue instead of failing — model gets back a "queued" SpawnedAgent
      return this._enqueue(description, runFn, callId, timeoutMs);
    }

    return this._doSpawn(description, runFn, callId, timeoutMs);
  }

  /** Core spawn logic — extracted so spawn() and _drainQueue() can share it. */
  private _doSpawn(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent {
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle: SubAgentHandle = {
      id,
      description,
      status: SubAgentStatus.Running,
      startedAt: Date.now(),
    };
    const abortController = new AbortController();

    let resolveDone!: (h: SubAgentHandle) => void;
    const done = new Promise<SubAgentHandle>((r) => {
      resolveDone = r;
    });
    const pending: PendingAgent = { handle, done, resolve: resolveDone, callId, abortController };
    this.agents.set(id, pending);

    const finish = (text: string, err?: string, stopped = false) => {
      if (pending.finished) return;
      pending.finished = true;
      const t = this.timeouts.get(id);
      if (t) {
        clearTimeout(t);
        this.timeouts.delete(id);
      }
      if (stopped) {
        handle.status = SubAgentStatus.Stopped;
        handle.error = err || 'stopped by user';
      } else if (err) {
        handle.status = SubAgentStatus.Failed;
        handle.error = err;
        handle.result = text || err;
      } else {
        handle.status = SubAgentStatus.Completed;
        handle.result = text;
      }
      this._addCompleted(handle);
      this.agents.delete(id);
      pending.resolve(handle);
      // Resolve alias for onFinish callback — callers (archive) need the model-visible id
      const aliasId = this._reverseAlias(id);
      this.onFinish?.(aliasId ?? id, handle.status);

      // Drain queue — a slot just freed up
      this._drainQueue();
    };

    const ms = timeoutMs ?? this.defaultTimeoutMs;
    this.timeouts.set(
      id,
      setTimeout(() => {
        abortController.abort(); // kill the actual runFn first…
        finish('', `timeout: exceeded ${Math.round(ms / 1000)}s`); // …then settle the books
      }, ms),
    );

    // Fire and forget — the signal is handed over synchronously, so stop/timeout
    // always reach the running child. Late completions hit the `finished` guard.
    runFn(abortController.signal).then(
      ({ text, err }) => finish(text, err),
      (err) => finish('', String(err?.message || err)),
    );

    return { id, signal: abortController.signal, done };
  }

  /** Enqueue a spawn request when the pool is full. Returns a "queued" SpawnedAgent.
   *  The actual spawn happens when _drainQueue() fires. */
  private _enqueue(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent | null {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return null; // queue full — model must retry
    }

    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._queuedIds.add(id);
    const abortController = new AbortController();

    let resolveDone!: (h: SubAgentHandle) => void;
    const done = new Promise<SubAgentHandle>((r) => {
      resolveDone = r;
    });

    // Store the resolve function so _drainQueue can wire up the real spawn
    this.queue.push({
      description,
      runFn,
      callId,
      timeoutMs,
      queuedId: id,
      resolve: (real: SpawnedAgent) => {
        // When the real spawn fires, connect its done to our deferred promise
        real.done.then((h) => {
          this._queuedIds.delete(id);
          resolveDone({ ...h, id }); // preserve the queued ID for the caller
        });
        // Forward abort from the real signal
        real.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      },
    });

    return { id, signal: abortController.signal, done };
  }

  /** Drain the queue — start as many queued spawns as slots allow. */
  private _drainQueue(): void {
    while (this.queue.length > 0 && this.agents.size < this.maxConcurrent) {
      const item = this.queue.shift()!;
      const spawned = this._doSpawn(item.description, item.runFn, item.callId, item.timeoutMs);
      // Re-map any alias that pointed to the queued id → real internal id
      for (const [alias, internal] of this._aliasToInternal) {
        if (internal === item.queuedId) {
          this._aliasToInternal.set(alias, spawned.id);
          break;
        }
      }
      // Delete the QUEUED id (not spawned.id which was never in the set)
      this._queuedIds.delete(item.queuedId);
      item.resolve(spawned);
    }
  }

  /** Check if an agent ID is currently queued (not yet spawned). */
  isQueued(id: string): boolean {
    return this._queuedIds.has(id);
  }

  /** Register an alias (model-visible id) for an internal pool id.
   *  This lets agent_kill use the id the model actually sees. */
  registerAlias(aliasId: string, internalId: string): void {
    this._aliasToInternal.set(aliasId, internalId);
  }

  /** Resolve a model-visible id to pool internal id (or return as-is if no alias). */
  private _resolveId(id: string): string {
    return this._aliasToInternal.get(id) ?? id;
  }

  /** Reverse lookup: pool internal id → model-visible id (if registered). */
  private _reverseAlias(internalId: string): string | undefined {
    for (const [alias, internal] of this._aliasToInternal) {
      if (internal === internalId) return alias;
    }
    return undefined;
  }

  /** Look up a sub-agent by ID — running first, then completed history.
   *  Accepts both model-visible (sub-...) and internal (subagent-...) ids. */
  getHandle(id: string): SubAgentHandle | undefined {
    const internalId = this._resolveId(id);
    return this.agents.get(internalId)?.handle ?? this.completed.find((h) => h.id === internalId);
  }

  /** Stop a running sub-agent: aborts its runFn, then marks it stopped.
   *  Also covers queued (not-yet-spawned) agents — dequeues them and settles
   *  their `done` as stopped so agent_kill works before a slot frees up.
   *  Accepts both model-visible (sub-...) and internal (subagent-...) ids. */
  stop(id: string): boolean {
    const internalId = this._resolveId(id);
    const qIdx = this.queue.findIndex((q) => q.queuedId === internalId);
    if (qIdx >= 0) {
      const [item] = this.queue.splice(qIdx, 1);
      this._stopQueued(item);
      return true;
    }
    const pending = this.agents.get(internalId);
    if (!pending) return false;
    pending.abortController.abort();
    this._finishStopped(pending);
    return true;
  }

  /** Stop all running sub-agents AND drain the queue (otherwise _finishStopped's
   *  _drainQueue would spawn queued agents right after stopping the running ones).
   *  Returns the stopped agent IDs. */
  stopAll(): string[] {
    const stopped: string[] = [];
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      this._stopQueued(item);
      stopped.push(item.queuedId);
    }
    for (const [id, pending] of this.agents) {
      pending.abortController.abort();
      this._finishStopped(pending);
      stopped.push(id);
    }
    return stopped;
  }

  /** Settle a queued (never-spawned) agent as stopped: records it in completed
   *  history and resolves the caller's `done` via the stored resolve, producing
   *  the same { ...handle, id } shape _enqueue would have produced on drain. */
  private _stopQueued(item: QueuedSpawn): void {
    this._queuedIds.delete(item.queuedId);
    const handle: SubAgentHandle = {
      id: item.queuedId,
      description: item.description,
      status: SubAgentStatus.Stopped,
      startedAt: Date.now(),
      error: 'stopped while queued',
    };
    this._addCompleted(handle);
    item.resolve({ id: item.queuedId, signal: new AbortController().signal, done: Promise.resolve(handle) });
    const aliasId = this._reverseAlias(item.queuedId);
    this.onFinish?.(aliasId ?? item.queuedId, SubAgentStatus.Stopped);
  }

  private _finishStopped(pending: PendingAgent): void {
    if (pending.finished) return;
    pending.finished = true;
    const id = pending.handle.id;
    const t = this.timeouts.get(id);
    if (t) {
      clearTimeout(t);
      this.timeouts.delete(id);
    }
    pending.handle.status = SubAgentStatus.Stopped;
    pending.handle.error = 'stopped by user';
    this._addCompleted(pending.handle);
    this.agents.delete(id);
    pending.resolve(pending.handle);
    const aliasId = this._reverseAlias(id);
    this.onFinish?.(aliasId ?? id, SubAgentStatus.Stopped);
    // Drain queue — stopping an agent frees a slot
    this._drainQueue();
  }

  /** Summary of running + recently completed agents (for status display). */
  summary(): string {
    const lines: string[] = [];
    for (const [, pending] of this.agents) {
      const elapsed = Math.round((Date.now() - pending.handle.startedAt) / 1000);
      lines.push(`- 🔄 ${pending.handle.description} (运行中, ${elapsed}s)`);
    }
    const recent = this.completed.slice(-5);
    for (const h of recent) {
      const icon = h.status === SubAgentStatus.Completed ? '✅' : h.status === SubAgentStatus.Failed ? '❌' : '⏹️';
      lines.push(`- ${icon} ${h.description} (${h.status})`);
    }
    return lines.length > 0 ? lines.join('\n') : '无运行中的子Agent';
  }

  get runningCount(): number {
    return this.agents.size;
  }
}
