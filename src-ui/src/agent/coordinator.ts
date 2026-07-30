// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Coordinator — 子 Agent 生命周期注册器。
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

/** 子 Agent 运行的工作。同步接收 pool 的 AbortSignal —
 *  将其接入子 agent 的 LLM stream，使 stop/timeout 能真正终止它。 */
export type SubAgentRunFn = (signal: AbortSignal) => Promise<{ text: string; err?: string }>;

/** 由 spawn() 同步返回。`done` 恰好 resolve 一次，返回
 *  最终句柄（completed / failed / stopped / timeout 计为 failed）。 */
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
  finished?: boolean; // 防止重复完成（超时 + promise 竞态）
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
// 10 分钟 — 编码子 Agent 需要跑构建/测试；2 分钟会让健康的 agent 超时，
// 且（更糟的）让它们脱离父 Agent 继续运行，而父 Agent 被告知已失败。
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class SubAgentPool {
  private agents = new Map<string, PendingAgent>();
  private completed: SubAgentHandle[] = [];
  private static readonly MAX_COMPLETED = 20; // 上限，防止内存泄漏
  private maxConcurrent: number;
  private defaultTimeoutMs: number;
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // ── 限流退避队列 ──
  private queue: QueuedSpawn[] = [];
  private _queuedIds = new Set<string>();

  /** 任意子 Agent 完成时触发的可选回调（用于 board 归档等） */
  onFinish?: (agentId: string, status: SubAgentStatus) => void;

  /** 模型可见 id（sub-...）到 pool 内部 id（subagent-...）的映射 */
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

  /** 生成子 Agent。达到 maxConcurrent 时，将请求排队而非失败。
   *  仅当队列也满时返回 null。
   *  对 callId 幂等：同一工具调用的重发（stream retry）
   *  返回已运行的 agent 而非启动重复的。 */
  spawn(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent | null {
    if (callId) {
      for (const [id, pending] of this.agents) {
        if (pending.callId === callId) {
          return { id, signal: pending.abortController.signal, done: pending.done };
        }
      }
      // 也检查队列中的重复
      if (this.queue.some((q) => q.callId === callId)) {
        return null; // 已用此 callId 排队
      }
    }
    if (this.agents.size >= this.maxConcurrent) {
      // 排队而非失败 — 模型收到一个"排队中"的 SpawnedAgent
      return this._enqueue(description, runFn, callId, timeoutMs);
    }

    return this._doSpawn(description, runFn, callId, timeoutMs);
  }

  /** 核心生成逻辑 — 提取出来供 spawn() 和 _drainQueue() 共用。 */
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
      // 为 onFinish 回调解析别名 — 调用方（归档）需要模型可见 id
      const aliasId = this._reverseAlias(id);
      this.onFinish?.(aliasId ?? id, handle.status);

      // 排空队列 — 刚空出一个槽位
      this._drainQueue();
    };

    const ms = timeoutMs ?? this.defaultTimeoutMs;
    this.timeouts.set(
      id,
      setTimeout(() => {
        abortController.abort(); // 先终止实际的 runFn…
        finish('', `timeout: exceeded ${Math.round(ms / 1000)}s`); // …再结算
      }, ms),
    );

    // 发后即忘 — signal 同步交接，stop/timeout
    // 总能到达运行中的子 Agent。延迟完成会被 `finished` 守卫拦截。
    runFn(abortController.signal).then(
      ({ text, err }) => finish(text, err),
      (err) => finish('', String(err?.message || err)),
    );

    return { id, signal: abortController.signal, done };
  }

  /** pool 满时将生成请求入队。返回一个"排队中"的 SpawnedAgent。
   *  实际生成在 _drainQueue() 触发时进行。 */
  private _enqueue(description: string, runFn: SubAgentRunFn, callId?: string, timeoutMs?: number): SpawnedAgent | null {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return null; // 队列已满 — 模型需重试
    }

    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._queuedIds.add(id);
    const abortController = new AbortController();

    let resolveDone!: (h: SubAgentHandle) => void;
    const done = new Promise<SubAgentHandle>((r) => {
      resolveDone = r;
    });

    // 存储 resolve 函数，以便 _drainQueue 能接上真正的生成
    this.queue.push({
      description,
      runFn,
      callId,
      timeoutMs,
      queuedId: id,
      resolve: (real: SpawnedAgent) => {
        // 真正的生成触发时，将其 done 连接到我们的延迟 promise
        real.done.then((h) => {
          this._queuedIds.delete(id);
          resolveDone({ ...h, id }); // 为调用方保留排队 ID
        });
        // 从真实 signal 转发中止
        real.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      },
    });

    return { id, signal: abortController.signal, done };
  }

  /** 排空队列 — 在可用槽位范围内启动尽可能多的排队生成。 */
  private _drainQueue(): void {
    while (this.queue.length > 0 && this.agents.size < this.maxConcurrent) {
      const item = this.queue.shift()!;
      const spawned = this._doSpawn(item.description, item.runFn, item.callId, item.timeoutMs);
      // 重新映射指向排队 id 的别名 → 真实内部 id
      for (const [alias, internal] of this._aliasToInternal) {
        if (internal === item.queuedId) {
          this._aliasToInternal.set(alias, spawned.id);
          break;
        }
      }
      // 删除排队的 id（不是 spawned.id，后者从未在集合中）
      this._queuedIds.delete(item.queuedId);
      item.resolve(spawned);
    }
  }

  /** 检查 agent ID 是否正在排队（尚未生成）。 */
  isQueued(id: string): boolean {
    return this._queuedIds.has(id);
  }

  /** 注册别名（模型可见 id）对应 pool 内部 id。
   *  使 agent_kill 能使用模型实际看到的 id。 */
  registerAlias(aliasId: string, internalId: string): void {
    this._aliasToInternal.set(aliasId, internalId);
  }

  /** 将模型可见 id 解析为 pool 内部 id（无别名则原样返回）。 */
  private _resolveId(id: string): string {
    return this._aliasToInternal.get(id) ?? id;
  }

  /** 反向查找：pool 内部 id → 模型可见 id（如已注册）。 */
  private _reverseAlias(internalId: string): string | undefined {
    for (const [alias, internal] of this._aliasToInternal) {
      if (internal === internalId) return alias;
    }
    return undefined;
  }

  /** 按 ID 查找子 Agent — 先查运行中，再查已完成历史。
   *  同时接受模型可见（sub-...）和内部（subagent-...）id。 */
  getHandle(id: string): SubAgentHandle | undefined {
    const internalId = this._resolveId(id);
    return this.agents.get(internalId)?.handle ?? this.completed.find((h) => h.id === internalId);
  }

  /** 所有运行中子 Agent 的句柄，已注册别名的会替换为模型可见（别名）id —
   *  agent_status 报告这些 id，使模型能与自己已知的 id 关联。排队中（尚未生成）
   *  的 Agent 被排除：它们没有可观察的事件流。 */
  listRunning(): SubAgentHandle[] {
    const out: SubAgentHandle[] = [];
    for (const [, pending] of this.agents) {
      const alias = this._reverseAlias(pending.handle.id);
      out.push(alias ? { ...pending.handle, id: alias } : pending.handle);
    }
    return out;
  }

  /** 停止运行中的子 Agent：中止其 runFn，然后标记为已停止。
   *  也覆盖排队中（尚未生成）的 Agent — 将其出队并以 stopped 结算
   *  `done`，使 agent_kill 在有空位之前也能工作。
   *  同时接受模型可见（sub-...）和内部（subagent-...）id。 */
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

  /** 停止所有运行中的子 Agent 并排空队列（否则 _finishStopped 的
   *  _drainQueue 会在停止运行中的之后立即生成排队的 Agent）。
   *  返回被停止的 Agent ID。 */
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

  /** 将排队中（从未生成）的 Agent 结算为已停止：记录到已完成
   *  历史并通过存储的 resolve 结算调用方的 `done`，产生与
   *  _enqueue 在排空时相同的 { ...handle, id } 结构。 */
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
    // 排空队列 — 停止一个 Agent 会释放一个槽位
    this._drainQueue();
  }

  /** 运行中 + 最近完成的 Agent 摘要（用于状态显示）。 */
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
