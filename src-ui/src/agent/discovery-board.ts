// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DiscoveryBoard — 会话级共享发现区，Agent 之间交换探索结果
//
// Blackboard 模式：Agent 可以 post 发现、query 发现。
// 类似 TaskBoard 但面向"知识"而非"状态"。
//
// 会话级隔离：每个 chat session 拥有独立的 board 实例。
// 子 Agent 继承父会话的 board（会话内共享是板的本职）。
// 不提供任何跨会话查询 API。
//
// 持久化：flush() / restore() 将 entries 序列化到 .hologram/discoveries/{sessionId}.json。
// 会话删除时删文件。启动时迁移旧全局 discoveries.json（一次性）。

import { rpc } from '../bridge';

// ── Helpers ──

function stripNums(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '');
}

export type DiscoveryStatus = 'active' | 'archived';

export interface DiscoveryEntry {
  id: string;
  agentId: string;
  key: string;
  value: string;
  category: string;
  ts: number;
  status: DiscoveryStatus;
}

export class DiscoveryBoard {
  private entries: DiscoveryEntry[] = [];
  private _projectPath: string;
  private _sessionId: string;
  private _dirReady = false;
  // debounced flush — 延迟批量写入
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Eviction: TTL + capacity cap ──
  private static readonly TTL_MS = 2 * 60 * 60 * 1000; // 2h — crash residual only
  private static readonly MAX_ENTRIES = 200;

  constructor(projectPath?: string, sessionId?: string) {
    this._projectPath = projectPath ?? '';
    this._sessionId = sessionId ?? 'default';
  }

  private get _boardPath(): string {
    return this._projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/discoveries/' + this._sessionId + '.json';
  }

  private async _ensureDir(): Promise<void> {
    if (this._dirReady) return;
    try {
      await rpc('create_directory', {
        path: this._projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/discoveries',
      });
    } catch {
      /* already exists */
    }
    this._dirReady = true;
  }

  /** 序列化 entries 写文件。best-effort — 永不抛异常。 */
  async flush(): Promise<void> {
    if (!this._projectPath) return;
    try {
      await this._ensureDir();
      await rpc('write_file_content', {
        filePath: this._boardPath,
        content: JSON.stringify(this.entries, null, 2),
      });
    } catch {
      /* best-effort */
    }
  }

  /** 读文件，反序列化 entries。文件不存在时静默返回。 */
  async restore(): Promise<void> {
    if (!this._projectPath) return;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: this._boardPath });
      const arr = JSON.parse(stripNums(raw)) as DiscoveryEntry[];
      if (Array.isArray(arr)) {
        this.entries = arr;
        this._evict();
      }
    } catch {
      /* 文件不存在 — 无可恢复数据 */
    }
  }

  /** 删除持久化文件 — 会话结束时调用 */
  async destroy(): Promise<void> {
    if (!this._projectPath) return;
    try {
      await rpc('delete_file_or_dir', { path: this._boardPath });
    } catch {
      /* best-effort */
    }
  }

  /** debounced flush — 2 秒后批量写入，避免频繁 I/O */
  private _scheduleFlush(): void {
    if (!this._projectPath) return;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush();
    }, 2000);
  }

  /** 清理 flush 定时器 — 销毁时调用 */
  clearFlushTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /** 发布一条发现。同 agentId + 同 key 覆盖，从源头消灭重复版本。 */
  post(agentId: string, key: string, value: string, category: string): string {
    const id = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Remove existing entry with same agentId + key (override, not accumulate)
    this.entries = this.entries.filter(
      (e) => !(e.agentId === agentId && e.key === key),
    );
    this.entries.push({ id, agentId, key, value, category, ts: Date.now(), status: 'active' });
    this._evict();
    this._scheduleFlush();
    return id;
  }

  /** 标记某 agent 的发现为 archived（coordinator finish 回调） */
  archive(agentId: string): void {
    let changed = false;
    for (const e of this.entries) {
      if (e.agentId === agentId && e.status === 'active') {
        e.status = 'archived';
        changed = true;
      }
    }
    if (changed) this._scheduleFlush();
  }

  /** Remove expired entries and enforce capacity cap. */
  private _evict(): void {
    const now = Date.now();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => now - e.ts < DiscoveryBoard.TTL_MS);
    if (this.entries.length > DiscoveryBoard.MAX_ENTRIES) {
      this.entries = this.entries.slice(-DiscoveryBoard.MAX_ENTRIES);
    }
    if (this.entries.length !== before) {
      this._scheduleFlush();
    }
  }

  /** 查询发现（可选过滤）。默认只返回 active 条目。
   *  @param includeArchived — 会话内查 archived 条目
   *  @param since — 只返回 ts >= since 的条目
   *  @param limit — 最多返回 N 条（默认 20） */
  query(filter?: {
    key?: string;
    category?: string;
    agentId?: string;
    includeArchived?: boolean;
    since?: number;
    limit?: number;
  }): DiscoveryEntry[] {
    const includeArchived = filter?.includeArchived ?? false;
    const since = filter?.since ?? 0;
    const limit = filter?.limit ?? 20;
    let result = this.entries.filter((e) => {
      if (!includeArchived && e.status === 'archived') return false;
      if (since > 0 && e.ts < since) return false;
      if (filter?.key && !e.key.includes(filter.key)) return false;
      if (filter?.category && e.category !== filter.category) return false;
      if (filter?.agentId && e.agentId !== filter.agentId) return false;
      return true;
    });
    if (limit > 0 && result.length > limit) {
      result = result.slice(-limit);
    }
    return result;
  }

  /** 获取全部条目（含 archived）— 仅供 UI 面板全量展示 */
  getAll(): DiscoveryEntry[] {
    return [...this.entries];
  }

  /** 清空所有条目 */
  clear(): void {
    this.entries = [];
  }
}

/** Proxy that delegates to a swappable target DiscoveryBoard.
 *  Used by the main agent (which persists across session switches)
 *  to dynamically route to the current session's board. */
export class DiscoveryBoardProxy {
  private _target: DiscoveryBoard;

  constructor(target: DiscoveryBoard) {
    this._target = target;
  }

  /** Swap the underlying board — called when the active session changes */
  setTarget(board: DiscoveryBoard): void {
    this._target = board;
  }

  get target(): DiscoveryBoard {
    return this._target;
  }

  post(agentId: string, key: string, value: string, category: string): string {
    return this._target.post(agentId, key, value, category);
  }

  archive(agentId: string): void {
    this._target.archive(agentId);
  }

  query(filter?: {
    key?: string;
    category?: string;
    agentId?: string;
    includeArchived?: boolean;
    since?: number;
    limit?: number;
  }): DiscoveryEntry[] {
    return this._target.query(filter);
  }

  getAll(): DiscoveryEntry[] {
    return this._target.getAll();
  }

  clear(): void {
    this._target.clear();
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
