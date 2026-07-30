// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 面板式 store 的共享持久化基础设施（TaskBoard、DiscoveryBoard）。
// 处理目录创建、防抖文件 I/O 和生命周期管理（destroy/flush/restore）。

import { rpc } from '../bridge';

/** 去除行号前缀（如 "42\t"）— Tauri read_file_content 会添加行号。 */
export function stripNums(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '');
}

/** 规范化项目路径：正斜杠，无尾部斜杠。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '');
}

export interface BoardPersistenceOptions {
  projectPath: string;
  sessionId: string;
  /** .hologram/ 下的子目录名（如 "taskboard"、"discoveries"） */
  dirName: string;
}

/** 管理面板的防抖文件持久化。
 *  面板提供序列化/反序列化钩子；此类处理
 *  目录创建、文件 I/O、flush 防抖和清理。 */
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
      /* 已存在 */
    }
    this._dirReady = true;
  }

  /** 序列化 entries 并写入磁盘。尽力而为 — 永不抛异常。 */
  async flush(data: string): Promise<void> {
    if (!this._projectPath || this._destroyed) return;
    try {
      await this._ensureDir();
      await rpc('write_file_content', { filePath: this._boardPath, content: data });
    } catch {
      /* 尽力而为 */
    }
  }

  /** 读取并返回原始文件内容。文件不存在或出错时返回 null。 */
  async restore(): Promise<string | null> {
    if (!this._projectPath) return null;
    try {
      const raw = await rpc<string>('read_file_content', { filePath: this._boardPath });
      return stripNums(raw);
    } catch {
      return null;
    }
  }

  /** 调度防抖 flush（2 秒延迟）。回调提供序列化后的数据。 */
  scheduleFlush(getData: () => string): void {
    if (!this._projectPath || this._destroyed) return;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush(getData());
    }, 2000);
  }

  /** 清除 flush 定时器 — destroy 时调用。 */
  clearFlushTimer(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /** 删除持久化文件并标记为已销毁。 */
  async destroy(): Promise<void> {
    if (!this._projectPath) return;
    this._destroyed = true;
    this.clearFlushTimer();
    try {
      await rpc('delete_file_or_dir', { path: this._boardPath });
    } catch {
      /* 尽力而为 */
    }
  }
}
