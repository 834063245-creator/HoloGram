// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// TaskBoard — 共享状态区，追踪异步子 Agent 的工作状态
//
// 与 MessageBus 的分工：
//   - MessageBus = 消息通道（"我完成了"的通知）
//   - TaskBoard = 共享状态（"谁改了什么"的账本）
//
// 子 Agent 完成时：
//   1. 保全 diff 到 TaskBoard（board.complete）
//   2. 通过 bus 发消息通知父 Agent（bus.send type=result）
//
// 父 Agent 收到 bus 消息后从 TaskBoard 读结构化状态。
//
// 持久化：flush() / restore() 将 entries 序列化到 .hologram/taskboard.json。
// 状态变更后通过 debounced flush 延迟批量写入，避免频繁 I/O。

import { BoardPersistence } from './board-persistence';

export type BoardStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'merged';

export interface BoardEntry {
  agentId: string;
  parentAgentId: string;
  description: string;
  status: BoardStatus;
  isolationId: string | null;
  filesTouched: string[];
  summary?: string;
  diff?: string;
  startedAt: number;
  finishedAt?: number;
}

export class TaskBoard {
  private entries = new Map<string, BoardEntry>();
  private _store: BoardPersistence;

  // ── Eviction: expired terminal entries are removed after TTL ──
  private static readonly TERMINAL_TTL_MS = 60 * 60 * 1000; // 1h
  private static readonly MAX_ENTRIES = 200;

  constructor(projectPath?: string, sessionId?: string) {
    this._store = new BoardPersistence({
      projectPath: projectPath ?? '',
      sessionId: sessionId ?? 'default',
      dirName: 'taskboard',
    });
  }

  /** 序列化 entries（Map → Array）写文件。best-effort — 永不抛异常。 */
  async flush(): Promise<void> {
    if (this._store.destroyed) return;
    const arr = Array.from(this.entries.entries());
    await this._store.flush(JSON.stringify(arr, null, 2));
  }

  /** 读文件，反序列化回 Map。文件不存在时静默返回。 */
  async restore(): Promise<void> {
    const raw = await this._store.restore();
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as [string, BoardEntry][];
      if (Array.isArray(arr)) {
        for (const [id, entry] of arr) {
          this.entries.set(id, entry);
        }
        this._evict();
      }
    } catch {
      /* corrupt file — no data to restore */
    }
  }

  /** debounced flush — 2 秒后批量写入，避免频繁 I/O */
  private _scheduleFlush(): void {
    this._store.scheduleFlush(() => {
      const arr = Array.from(this.entries.entries());
      return JSON.stringify(arr, null, 2);
    });
  }

  /** 清理 flush 定时器 — 销毁时调用 */
  clearFlushTimer(): void {
    this._store.clearFlushTimer();
  }

  /** 删除持久化文件 — 会话结束时调用。清除 entries 防止后续 flush 复活文件。 */
  async destroy(): Promise<void> {
    this.entries.clear();
    await this._store.destroy();
  }

  /** 获取所有条目 — 用于孤儿检测等全局遍历 */
  getAllEntries(): BoardEntry[] {
    return Array.from(this.entries.values());
  }

  /** Remove terminal entries (completed/failed/stopped/merged) older than TTL.
   *  Running entries are never evicted. */
  private _evict(): void {
    const now = Date.now();
    const terminal = new Set(['completed', 'failed', 'stopped', 'merged']);
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (
        terminal.has(entry.status) &&
        entry.finishedAt != null &&
        now - entry.finishedAt > TaskBoard.TERMINAL_TTL_MS
      ) {
        this.entries.delete(id);
        changed = true;
      }
    }
    // Hard cap: if still too many, evict oldest terminal entries
    if (this.entries.size > TaskBoard.MAX_ENTRIES) {
      const terminalEntries = [...this.entries.entries()]
        .filter(([, e]) => terminal.has(e.status))
        .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
      const toRemove = this.entries.size - TaskBoard.MAX_ENTRIES;
      for (let i = 0; i < Math.min(toRemove, terminalEntries.length); i++) {
        this.entries.delete(terminalEntries[i][0]);
        changed = true;
      }
    }
    if (changed) {
      this._scheduleFlush();
    }
  }

  /** 父 Agent spawn 时调用 */
  register(entry: Omit<BoardEntry, 'status' | 'filesTouched' | 'startedAt'>): void {
    this.entries.set(entry.agentId, {
      ...entry,
      status: 'running',
      filesTouched: [],
      startedAt: Date.now(),
    });
  }

  /** 工具执行副作用：子 Agent write/edit 时自动登记 */
  recordFileTouch(agentId: string, filepath: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    if (!entry.filesTouched.includes(filepath)) {
      entry.filesTouched.push(filepath);
      this._scheduleFlush();
    }
  }

  /** 子 Agent 完成时调用 */
  complete(agentId: string, summary: string, diff: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'completed';
    entry.summary = summary;
    entry.diff = diff;
    entry.finishedAt = Date.now();
    this._evict();
    this._scheduleFlush();
    void this.flush(); // 关键终态 — 立即落盘，缩短崩溃丢失窗口
  }

  /** 子 Agent 失败时调用 */
  fail(agentId: string, error: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'failed';
    entry.summary = error;
    entry.finishedAt = Date.now();
    this._evict();
    this._scheduleFlush();
    void this.flush(); // 关键终态 — 立即落盘
  }

  /** 子 Agent 被中止时调用 */
  stop(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'stopped';
    entry.finishedAt = Date.now();
    this._evict();
    this._scheduleFlush();
    void this.flush(); // 关键终态 — 立即落盘
  }

  /** merge 成功后标记 */
  markMerged(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'merged';
    entry.finishedAt = entry.finishedAt ?? Date.now();
    this._evict();
    this._scheduleFlush();
    void this.flush(); // 关键终态 — 立即落盘
  }

  /** 顺延 TTL：门禁处理期间刷新 finishedAt，防止 LifecycleManager 30min 巡检误 discard worktree */
  touch(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.finishedAt = Date.now();
    this._scheduleFlush();
  }

  /** 父 Agent 查询全部子 Agent 状态 */
  getChildren(parentAgentId: string): BoardEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.parentAgentId === parentAgentId);
  }

  getEntry(agentId: string): BoardEntry | undefined {
    return this.entries.get(agentId);
  }

  /** 注销 */
  unregister(agentId: string): void {
    this.entries.delete(agentId);
  }
}

/** Proxy that delegates to a swappable target TaskBoard.
 *  每个 Agent 一个 — 会话 id 在 createAgent 后才分配，
 *  由 bindSession 一次性换 target 完成静态绑定。 */
export class TaskBoardProxy {
  private _target: TaskBoard;

  constructor(target: TaskBoard) {
    this._target = target;
  }

  /** Swap the underlying board — called by bindSession to statically bind
   *  this agent's session board */
  setTarget(board: TaskBoard): void {
    this._target = board;
  }

  get target(): TaskBoard {
    return this._target;
  }

  getAllEntries(): BoardEntry[] {
    return this._target.getAllEntries();
  }
  getChildren(parentAgentId: string): BoardEntry[] {
    return this._target.getChildren(parentAgentId);
  }
  getEntry(agentId: string): BoardEntry | undefined {
    return this._target.getEntry(agentId);
  }
  register(entry: Omit<BoardEntry, 'status' | 'filesTouched' | 'startedAt'>): void {
    this._target.register(entry);
  }
  recordFileTouch(agentId: string, filepath: string): void {
    this._target.recordFileTouch(agentId, filepath);
  }
  complete(agentId: string, summary: string, diff: string): void {
    this._target.complete(agentId, summary, diff);
  }
  fail(agentId: string, error: string): void {
    this._target.fail(agentId, error);
  }
  stop(agentId: string): void {
    this._target.stop(agentId);
  }
  markMerged(agentId: string): void {
    this._target.markMerged(agentId);
  }
  touch(agentId: string): void {
    this._target.touch(agentId);
  }
  unregister(agentId: string): void {
    this._target.unregister(agentId);
  }
  async flush(): Promise<void> {
    return this._target.flush();
  }
  async restore(): Promise<void> {
    return this._target.restore();
  }
  async destroy(): Promise<void> {
    return this._target.destroy();
  }
  clearFlushTimer(): void {
    this._target.clearFlushTimer();
  }
}
