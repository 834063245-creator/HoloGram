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

import { BoardPersistence } from './board-persistence';

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
  private _store: BoardPersistence;

  // ── 淘汰：TTL + 容量上限 ──
  private static readonly TTL_MS = 2 * 60 * 60 * 1000; // 2 小时 — 仅清理崩溃残留
  private static readonly MAX_ENTRIES = 200;

  constructor(projectPath?: string, sessionId?: string) {
    this._store = new BoardPersistence({
      projectPath: projectPath ?? '',
      sessionId: sessionId ?? 'default',
      dirName: 'discoveries',
    });
  }

  /** 序列化 entries 写文件。best-effort — 永不抛异常。 */
  async flush(): Promise<void> {
    if (this._store.destroyed) return;
    await this._store.flush(JSON.stringify(this.entries, null, 2));
  }

  /** 读文件，反序列化 entries。文件不存在时静默返回。 */
  async restore(): Promise<void> {
    const raw = await this._store.restore();
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as DiscoveryEntry[];
      if (Array.isArray(arr)) {
        // 淘汰前去重 — 以 agentId+key 为准，最后一条生效（与 post() 语义一致）
        const seen = new Map<string, number>();
        arr.forEach((e, i) => seen.set(`${e.agentId}:${e.key}`, i));
        this.entries = arr.filter((e, i) => seen.get(`${e.agentId}:${e.key}`) === i);
        this._evict();
      }
    } catch {
      /* 文件损坏 — 无数据可恢复 */
    }
  }

  /** 删除持久化文件 — 会话结束时调用。清除 entries 防止后续 flush 复活文件。 */
  async destroy(): Promise<void> {
    this.entries = [];
    await this._store.destroy();
  }

  /** debounced flush — 2 秒后批量写入，避免频繁 I/O */
  private _scheduleFlush(): void {
    this._store.scheduleFlush(() => JSON.stringify(this.entries, null, 2));
  }

  /** 清理 flush 定时器 — 销毁时调用 */
  clearFlushTimer(): void {
    this._store.clearFlushTimer();
  }

  /** 发布一条发现。同 agentId + 同 key 覆盖，从源头消灭重复版本。 */
  post(agentId: string, key: string, value: string, category: string): string {
    const id = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 移除同 agentId + key 的已有条目（覆盖而非累积）
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

  /** 移除过期条目并强制执行容量上限。 */
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

/** 代理类，委托到可替换的目标 DiscoveryBoard。
 *  每个 Agent 一个 — 会话 id 在 createAgent 后才分配，
 *  由 bindSession 一次性换 target 完成静态绑定。 */
export class DiscoveryBoardProxy {
  private _target: DiscoveryBoard;

  constructor(target: DiscoveryBoard) {
    this._target = target;
  }

  /** 切换底层 board — bindSession 静态绑定时调用 */
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
