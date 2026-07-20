// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent Store — persist agent state + session to .hologram/agents/{id}/
// Enables agent identity tracking, session recovery, and sub-agent lineage
// Pattern follows MemoryManager: rpc file I/O, ensureDir, stripLineNumbers.

import { rpc } from '../bridge';
import type { Message } from '../provider/types';

// ── Helpers ──

function stripNums(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '');
}

// ── Types ──

export interface AgentRecord {
  id: string;
  parentId: string | null;
  description: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  createdAt: number;
  updatedAt: number;
  subagentDepth: number;
}

export interface AgentLoadResult {
  record: AgentRecord;
  messages: Message[];
}

const INDEX_FILE = 'index.json';

// ── AgentStore ──

export class AgentStore {
  private dirReady = false;

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

  // ponytail: ensureDir is lazy — most callers don't need it twice per operation.
  // We call it once at entry points, not before every file write.
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    try {
      await rpc('create_directory', { path: this.baseDir });
    } catch {
      /* already exists */
    }
    this.dirReady = true;
  }

  private async ensureAgentDir(id: string): Promise<void> {
    await this.ensureDir();
    try {
      await rpc('create_directory', { path: `${this.baseDir}/${id}` });
    } catch {
      /* already exists */
    }
  }

  // ── CRUD ──

  /** Save agent state record + optional session messages. */
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
    // State file — compact, always written
    await rpc('write_file_content', {
      filePath: this.statePath(id),
      content: JSON.stringify(record, null, 2),
    });
    // Session file — only written when messages are provided
    if (messages !== undefined) {
      await rpc('write_file_content', {
        filePath: this.sessionPath(id),
        content: JSON.stringify(messages, null, 2),
      });
    }
    // Index — always updated so list() stays consistent
    await this._upsertIndex(record);
  }

  /** Load agent state + session. Returns null when agent not found. */
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
        /* session file may not exist yet — empty session is fine */
      }
      return { record, messages };
    } catch {
      return null;
    }
  }

  /** Load the index of all persisted agents. */
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

  /** Delete an agent's persisted state. Best-effort — never throws. */
  async delete(id: string): Promise<void> {
    try {
      await rpc('delete_file_or_dir', { path: `${this.baseDir}/${id}` });
    } catch {
      /* best effort */
    }
    // Remove from index
    const all = await this.list();
    const filtered = all.filter((r) => r.id !== id);
    if (filtered.length < all.length) {
      try {
        await rpc('write_file_content', {
          filePath: this.indexPath(),
          content: JSON.stringify(filtered, null, 2),
        });
      } catch {
        /* index write is best-effort */
      }
    }
  }

  // ── Internals ──

  private async _upsertIndex(record: AgentRecord): Promise<void> {
    const all = await this.list();
    const idx = all.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.push(record);
    }
    try {
      await rpc('write_file_content', {
        filePath: this.indexPath(),
        content: JSON.stringify(all, null, 2),
      });
    } catch {
      /* best effort */
    }
  }
}
