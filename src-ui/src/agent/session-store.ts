// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Session persistence — JSONL file store for agent sessions.
// CC ref: utils/sessionStorage.ts

import type { Message } from '../provider/types';
import { rpc } from '../bridge';

export interface SessionMeta {
  id: string;
  preview: string;
  timestamp: number;
  messageCount: number;
}

/** Fire-and-forget session persistence to .hologram/sessions/<id>.jsonl.
 *  Every assistant push triggers an async save — never blocks the agent loop. */
export class SessionStore {
  private baseDir: string;

  constructor(projectPath: string) {
    this.baseDir = projectPath.replace(/\\/g, '/') + '/.hologram/sessions';
  }

  private filePath(sessionId: string): string {
    return this.baseDir + '/' + sessionId + '.jsonl';
  }

  /** Ensure the sessions directory exists. */
  async ensureDir(): Promise<void> {
    try {
      await rpc('create_directory', { path: this.baseDir });
    } catch {
      // Directory may already exist — safe to continue
    }
  }

  /** Save full session as JSONL (one message per line).
   *  Fire-and-forget — errors are silently dropped (best-effort persistence). */
  async save(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureDir();
    const lines: string[] = [];
    for (const m of messages) {
      lines.push(JSON.stringify({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
        name: m.name,
        reasoning_content: m.reasoning_content,
        timestamp: Date.now(),
      }));
    }
    const content = lines.join('\n') + '\n';
    try {
      await rpc('write_file_content', {
        filePath: this.filePath(sessionId),
        content,
      });
    } catch {
      // Best-effort — don't crash the agent on write failure
    }
  }

  /** Load session messages from JSONL file. */
  async load(sessionId: string): Promise<Message[]> {
    try {
      const raw = await rpc<string>('read_file_content', {
        filePath: this.filePath(sessionId),
      });
      const messages: Message[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          messages.push({
            role: obj.role,
            content: obj.content || '',
            tool_calls: obj.tool_calls,
            tool_call_id: obj.tool_call_id,
            name: obj.name,
            reasoning_content: obj.reasoning_content,
          });
        } catch {
          // Skip malformed lines
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  /** List all saved sessions (sorted by timestamp, newest first). */
  async listSessions(): Promise<SessionMeta[]> {
    await this.ensureDir();
    try {
      const files = await rpc<string[]>('list_directory_flat', { path: this.baseDir });
      const metas: SessionMeta[] = [];
      for (const file of (files || [])) {
        if (!file.endsWith('.jsonl')) continue;
        const id = file.replace(/\.jsonl$/, '');
        try {
          const msgs = await this.load(id);
          const firstUser = msgs.find(m => m.role === 'user');
          const preview = firstUser?.content
            ? (typeof firstUser.content === 'string' ? firstUser.content.slice(0, 80) : '...')
            : '(空会话)';
          metas.push({
            id,
            preview,
            timestamp: Date.now(), // ponytail: file mtime would be better, but JSONL has per-line timestamps
            messageCount: msgs.length,
          });
        } catch {
          // Skip unreadable sessions
        }
      }
      metas.sort((a, b) => b.timestamp - a.timestamp);
      return metas;
    } catch {
      return [];
    }
  }

  /** Delete a session file. */
  async delete(sessionId: string): Promise<void> {
    try {
      await rpc('delete_file_or_dir', { filePath: this.filePath(sessionId) });
    } catch {
      // Best-effort
    }
  }
}
