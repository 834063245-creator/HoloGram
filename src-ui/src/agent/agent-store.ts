// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent Store — 持久化 agent 状态 + 会话到 .hologram/agents/{id}/
// 实现 agent 身份追踪、会话恢复和子 Agent 血缘关系
// 模式参照 MemoryManager：rpc 文件 I/O、ensureDir、stripLineNumbers。

import { rpc } from '../bridge';
import type { Message } from '../provider/types';
import { stripNums } from './board-persistence';

// ── 类型 ──

export interface AgentRecord {
  id: string;
  parentId: string | null;
  description: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  createdAt: number;
  updatedAt: number;
  subagentDepth: number;
  /** Plan 模式快照 — { active, id } 用于会话恢复。null/undefined = 非 plan 模式。 */
  planSnapshot?: { active: boolean; id: string | null } | null;
}

export interface AgentLoadResult {
  record: AgentRecord;
  messages: Message[];
}

const INDEX_FILE = 'index.json';

// ── AgentStore ──

export class AgentStore {
  private dirReady = false;
  /** 串行写链 — index.json 的读-改-写按调用序串行化（P1-13）。
   *  多 Agent 并发 saveState 时，后一个写者在链内读到的永远是前一个写完之后的值，
   *  避免「读旧快照 → 覆盖新记录」的丢失现场。参照 BoardPersistence._writeChain。 */
  private _indexChain: Promise<void> = Promise.resolve();

  constructor(private projectPath: string) {}

  private get baseDir(): string {
    return this.projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/agents';
  }

  private statePath(id: string): string {
    return `${this.baseDir}/${id}/state.json`;
  }

  private sessionPath(id: string): string {
    return `${this.baseDir}/${id}/session.json`;
  }

  private indexPath(): string {
    return `${this.baseDir}/${INDEX_FILE}`;
  }

  // ponytail: ensureDir 是惰性的 — 大多数调用者不需要每次操作调用两次。
  // 我们在入口点调用一次，而不是每次写文件前都调用。
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    try {
      await rpc('create_directory', { path: this.baseDir });
    } catch {
      /* 已存在 */
    }
    this.dirReady = true;
  }

  private async ensureAgentDir(id: string): Promise<void> {
    await this.ensureDir();
    try {
      await rpc('create_directory', { path: `${this.baseDir}/${id}` });
    } catch {
      /* 已存在 */
    }
  }

  // ── CRUD ──

  /** 保存 agent 状态记录 + 可选的会话消息。 */
  async save(id: string, partial: Partial<AgentRecord>, messages?: Message[]): Promise<void> {
    await this.ensureAgentDir(id);
    const now = Date.now();
    const record: AgentRecord = {
      id,
      parentId: partial.parentId ?? null,
      description: partial.description ?? '',
      status: partial.status ?? 'idle',
      createdAt: partial.createdAt ?? now,
      updatedAt: now,
      subagentDepth: partial.subagentDepth ?? 0,
    };
    // 状态文件 — 精简，总是写入
    await rpc('write_file_content', {
      filePath: this.statePath(id),
      content: JSON.stringify(record, null, 2),
    });
    // 会话文件 — 仅在提供了消息时写入
    if (messages !== undefined) {
      await rpc('write_file_content', {
        filePath: this.sessionPath(id),
        content: JSON.stringify(messages, null, 2),
      });
    }
    // 索引 — 总是更新，保持 list() 一致
    await this._upsertIndex(record);
  }

  /** 加载 agent 状态 + 会话。未找到 agent 时返回 null。 */
  async load(id: string): Promise<AgentLoadResult | null> {
    await this.ensureDir();
    try {
      const rawState = await rpc<string>('read_file_content', {
        filePath: this.statePath(id),
      });
      const record: AgentRecord = JSON.parse(stripNums(rawState));
      let messages: Message[] = [];
      try {
        const rawSession = await rpc<string>('read_file_content', {
          filePath: this.sessionPath(id),
        });
        messages = JSON.parse(stripNums(rawSession));
      } catch {
        /* 会话文件可能尚不存在 — 空会话没问题 */
      }
      return { record, messages };
    } catch {
      return null;
    }
  }

  /** 加载所有已持久化 agent 的索引。 */
  async list(): Promise<AgentRecord[]> {
    await this.ensureDir();
    try {
      const raw = await rpc<string>('read_file_content', {
        filePath: this.indexPath(),
      });
      return JSON.parse(stripNums(raw)) as AgentRecord[];
    } catch {
      return [];
    }
  }

  /** 删除 agent 的持久化状态。尽力而为 — 永不抛异常。 */
  async delete(id: string): Promise<void> {
    try {
      await rpc('delete_file_or_dir', { path: `${this.baseDir}/${id}` });
    } catch {
      /* 尽力而为 */
    }
    // 从索引中移除 — 走写链串行化，避免与并发 save 的 _upsertIndex 交错覆盖（P1-13）
    await this._mutateIndex((all) => all.filter((r) => r.id !== id));
  }

  // ── 内部方法 ──

  /** 串行执行 index.json 的读-改-写。fn 在链内执行，读到的永远是最新落盘值。 */
  private _mutateIndex(fn: (all: AgentRecord[]) => AgentRecord[]): Promise<void> {
    const run = async (): Promise<void> => {
      const all = await this.list();
      const next = fn(all);
      try {
        await rpc('write_file_content', {
          filePath: this.indexPath(),
          content: JSON.stringify(next, null, 2),
        });
      } catch {
        /* 尽力而为 */
      }
    };
    this._indexChain = this._indexChain.then(run, run);
    return this._indexChain;
  }

  private async _upsertIndex(record: AgentRecord): Promise<void> {
    await this._mutateIndex((all) => {
      const idx = all.findIndex((r) => r.id === record.id);
      if (idx >= 0) {
        const next = [...all];
        next[idx] = record;
        return next;
      }
      return [...all, record];
    });
  }
}