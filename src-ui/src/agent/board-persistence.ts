// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shared persistence infrastructure for board-style stores (TaskBoard, DiscoveryBoard).
// Handles directory creation, debounced file I/O, and lifecycle (destroy/flush/restore).

import { rpc } from '../bridge';

/** Strip leading line numbers (e.g. "42\t") — Tauri read_file_content adds them. */
export function stripNums(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '');
}

/** Normalize a project path: forward slashes, no trailing slash. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

export interface BoardPersistenceOptions {
  projectPath: string;
  sessionId: string;
  /** Subdirectory under .hologram/ (e.g. "taskboard", "discoveries") */
  dirName: string;
}

/** Manages debounced file-based persistence for a board.
 *  The board provides serialize/deserialize hooks; this class handles
 *  directory creation, file I/O, flush debouncing, and cleanup. */
export class BoardPersistence {
  private _projectPath: string;
  private _sessionId: string;
  private _dirName: string;
  private _dirReady = false;
  private _destroyed = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BoardPersistenceOptions) {
    this._projectPath = opts.projectPath;
    this._sessionId = opts.sessionId;
    this._dirName = opts.dirName;
  }

  get projectPath(): string {
    return this._projectPath;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  private get _boardPath(): string {
    return normalizePath(this._projectPath) + '/.hologram/' + this._dirName + '/' + this._sessionId + '.json';
  }

  private async _ensureDir(): Promise<void> {
    if (this._dirReady) return;
    try {
      await rpc('create_directory', {
        path: normalizePath(this._projectPath) + '/.hologram/' + this._dirName,
      });
    } catch {
      /* already exists */
    }
    this._dirReady = true;
  }

  /** Serialize entries and write to disk. Best-effort — never throws. */
  async flush(data: string): Promise<void> {
    if (!this._projectPath || this._destroyed) return;
    try {
      await this._ensureDir();
      await rpc('write_file_content', { filePath: this._boardPath, content: data });
    } catch {
      /* best-effort */
    }
  }

  /** Read and return raw file content. Returns null if file missing or error. */
  async restore(): Promise<string | null> {
    if (!this._projectPath) return null;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: this._boardPath });
      return stripNums(raw);
    } catch {
      return null;
    }
  }

  /** Schedule a debounced flush (2s delay). The callback provides the serialized data. */
  scheduleFlush(getData: () => string): void {
    if (!this._projectPath || this._destroyed) return;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush(getData());
    }, 2000);
  }

  /** Clear the flush timer — call on destroy. */
  clearFlushTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /** Delete the persistence file and mark as destroyed. */
  async destroy(): Promise<void> {
    if (!this._projectPath) return;
    this._destroyed = true;
    this.clearFlushTimer();
    try {
      await rpc('delete_file_or_dir', { path: this._boardPath });
    } catch {
      /* best-effort */
    }
  }
}
