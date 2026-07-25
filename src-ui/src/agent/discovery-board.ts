// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DiscoveryBoard — 共享发现区，Agent 之间交换探索结果
//
// Blackboard 模式：Agent 可以 post 发现、query 发现。
// 类似 TaskBoard 但面向"知识"而非"状态"。
//
// 持久化：flush() / restore() 将 entries 序列化到 .hologram/discoveries.json。
// 状态变更后通过 debounced flush 延迟批量写入，避免频繁 I/O。

import { rpc } from '../bridge';

// ── Helpers ──

function stripNums(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '');
}

export interface DiscoveryEntry {
  id: string;
  agentId: string;
  key: string;
  value: string;
  category: string;
  ts: number;
}

export class DiscoveryBoard {
  private entries: DiscoveryEntry[] = [];
  private _projectPath: string;
  private _dirReady = false;
  // debounced flush — 延迟批量写入
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Eviction: TTL + capacity cap ──
  private static readonly TTL_MS = 24 * 60 * 60 * 1000; // 24h
  private static readonly MAX_ENTRIES = 200;

  constructor(projectPath?: string) {
    this._projectPath = projectPath ?? '';
  }

  private get _boardPath(): string {
    return this._projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/discoveries.json';
  }

  private async _ensureDir(): Promise<void> {
    if (this._dirReady) return;
    try {
      await rpc('create_directory', {
        path: this._projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram',
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

  /** 发布一条发现 */
  post(agentId: string, key: string, value: string, category: string): string {
    const id = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.entries.push({ id, agentId, key, value, category, ts: Date.now() });
    this._evict();
    this._scheduleFlush();
    return id;
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

  /** 查询发现（可选过滤） */
  query(filter?: { key?: string; category?: string; agentId?: string }): DiscoveryEntry[] {
    if (!filter) return [...this.entries];
    return this.entries.filter(
      (e) =>
        (!filter.key || e.key === filter.key) &&
        (!filter.category || e.category === filter.category) &&
        (!filter.agentId || e.agentId === filter.agentId),
    );
  }

  /** 获取全部条目 */
  getAll(): DiscoveryEntry[] {
    return [...this.entries];
  }

  /** 清空所有条目 */
  clear(): void {
    this.entries = [];
  }
}
