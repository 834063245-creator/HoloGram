// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal Manager — 目标模式的一等状态管理
// 把 goal 从 "agent.ts 里一段循环 + 正则标记" 提升为显式生命周期对象。
//
// 存储隔离: .hologram/goals/{id}/ — 与普通聊天的 .hologram/agents/main/ 槽
// 完全分离。普通对话每轮的 saveState 永远碰不到 goal 现场,这是断点续传
// 五个已确诊 Bug 的根治基础(见重构计划 M1)。
//
// Pattern follows AgentStore: rpc file I/O, lazy ensureDir, stripLineNumbers.

import type { Message } from '../provider/types';
import { typedRpc } from '../rpc-contract';
import { stripNums } from './board-persistence';

// ── Types ──

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface GoalRecord {
  id: string;
  /** 目标原文 — 恢复时重新注入,不依赖 session 快照里残留 */
  text: string;
  status: GoalStatus;
  iteration: number;
  stallRounds: number;
  /** 完成/失败时的摘要 */
  summary: string;
  createdAt: number;
  updatedAt: number;
}

/** 旧格式(agent-store.ts 的 GoalState)— 仅 migrateLegacy 使用 */
interface LegacyGoalState {
  goal: string;
  iteration: number;
  stallRounds: number;
  status: 'active' | 'paused';
  createdAt: number;
  updatedAt: number;
}

const INDEX_FILE = 'index.json';

// ── GoalManager ──

export class GoalManager {
  private dirReady = false;
  /** 进程(管理器)启动时间 — adoptOrphans 据此判定崩溃遗留的 active 记录 */
  private readonly startedAt = Date.now();

  /** @param projectPath 项目根目录
   *  @param onState 状态变更回调（由 workspace 注入，转发到 UI 总线） */
  constructor(
    private projectPath: string,
    private onState?: (record: GoalRecord) => void,
  ) {}

  private get baseDir(): string {
    return this.projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/goals';
  }

  private recordPath(id: string): string {
    return `${this.baseDir}/${id}/goal.json`;
  }

  private sessionPath(id: string): string {
    return `${this.baseDir}/${id}/session.json`;
  }

  private indexPath(): string {
    return `${this.baseDir}/${INDEX_FILE}`;
  }

  // ponytail: ensureDir is lazy — 与 AgentStore 同款,入口调一次。
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    try {
      await typedRpc('create_directory', { path: this.baseDir });
    } catch {
      /* already exists */
    }
    this.dirReady = true;
  }

  private async ensureGoalDir(id: string): Promise<void> {
    await this.ensureDir();
    try {
      await typedRpc('create_directory', { path: `${this.baseDir}/${id}` });
    } catch {
      /* already exists */
    }
  }

  // ── CRUD ──

  /** 创建新目标。单目标语义:已存在的 active/paused 目标先取消。 */
  async create(text: string): Promise<GoalRecord> {
    const existing = await this.getActive();
    if (existing) await this.cancel(existing.id);

    const now = Date.now();
    const record: GoalRecord = {
      id: `goal-${now}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      status: 'active',
      iteration: 0,
      stallRounds: 0,
      summary: '',
      createdAt: now,
      updatedAt: now,
    };
    await this._write(record);
    return record;
  }

  /** 按 id 读取目标记录。 */
  async get(id: string): Promise<GoalRecord | null> {
    await this.ensureDir();
    try {
      const raw = await typedRpc('read_file_content', { file_path: this.recordPath(id) });
      return JSON.parse(stripNums(raw)) as GoalRecord;
    } catch {
      return null;
    }
  }

  /** 当前占用单目标槽的记录(active/paused/blocked — 均为可恢复态)。
   *  多条并存时取最近更新的。 */
  async getActive(): Promise<GoalRecord | null> {
    const all = await this.list();
    const live = all.filter((r) => r.status === 'active' || r.status === 'paused' || r.status === 'blocked');
    if (live.length === 0) return null;
    live.sort((a, b) => b.updatedAt - a.updatedAt);
    return live[0];
  }

  /** 全部目标记录(含历史),按创建时间升序。 */
  async list(): Promise<GoalRecord[]> {
    await this.ensureDir();
    try {
      const raw = await typedRpc('read_file_content', { file_path: this.indexPath() });
      // ⚠️ JSON.parse(null) 返回 null 而不抛错 — 必须显式校验数组，
      // 否则损坏/空 index.json 会让调用方 `all.filter` 崩溃。
      const parsed = JSON.parse(stripNums(raw)) as unknown;
      return Array.isArray(parsed) ? (parsed as GoalRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** 更新记录字段(updatedAt 自动刷新),并广播 goal:state。 */
  async update(id: string, partial: Partial<Omit<GoalRecord, 'id' | 'createdAt'>>): Promise<GoalRecord | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next: GoalRecord = {
      ...current,
      ...partial,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    await this._write(next);
    return next;
  }

  /** 取消目标(保留记录与快照,可查历史)。 */
  async cancel(id: string): Promise<GoalRecord | null> {
    return this.update(id, { status: 'cancelled' });
  }

  /** 彻底删除目标记录与快照。 */
  async delete(id: string): Promise<void> {
    try {
      await typedRpc('delete_file_or_dir', { path: `${this.baseDir}/${id}` });
    } catch {
      /* best effort */
    }
    const all = await this.list();
    const filtered = all.filter((r) => r.id !== id);
    if (filtered.length < all.length) {
      try {
        await typedRpc('write_file_content', { file_path: this.indexPath(), content: JSON.stringify(filtered, null, 2) });
      } catch {
        /* index write is best-effort */
      }
    }
  }

  // ── Session 快照(独立于普通聊天的 session.json) ──

  /** 保存 goal 的对话现场到独立槽。 */
  async saveSession(id: string, messages: Message[]): Promise<void> {
    await this.ensureGoalDir(id);
    await typedRpc('write_file_content', {
      file_path: this.sessionPath(id),
      content: JSON.stringify(messages, null, 2),
    });
  }

  /** 加载 goal 的对话现场。无快照返回 null。 */
  async loadSession(id: string): Promise<Message[] | null> {
    await this.ensureDir();
    try {
      const raw = await typedRpc('read_file_content', { file_path: this.sessionPath(id) });
      return JSON.parse(stripNums(raw)) as Message[];
    } catch {
      return null;
    }
  }

  // ── 生命周期 ──

  /** 崩溃接管:updatedAt 早于本管理器启动时间的 active 记录,
   *  只可能是上一个进程留下的孤儿 → 转 paused,可正常 resume。 */
  async adoptOrphans(): Promise<GoalRecord[]> {
    const all = await this.list();
    const adopted: GoalRecord[] = [];
    for (const r of all) {
      if (r.status === 'active' && r.updatedAt < this.startedAt) {
        const next = await this.update(r.id, { status: 'paused' });
        if (next) adopted.push(next);
      }
    }
    return adopted;
  }

  /** 旧格式迁移:agents/main/goal.json → goals/{新id}/。
   *  旧记录里的 session.json 一并复制;迁移后删除旧 goal.json。
   *  旧 status 'active' 一律按 paused 处理(迁移发生在启动时,没有活体循环)。 */
  async migrateLegacy(): Promise<GoalRecord | null> {
    // 已有活体目标时不迁移(避免覆盖启动后立刻新建的目标;旧档留到下次启动)
    if (await this.getActive()) return null;

    const legacyGoalPath = this.projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/agents/main/goal.json';
    let legacy: LegacyGoalState;
    try {
      const raw = await typedRpc('read_file_content', { file_path: legacyGoalPath });
      legacy = JSON.parse(stripNums(raw)) as LegacyGoalState;
    } catch {
      return null; // 无旧档
    }

    const record = await this.create(legacy.goal);
    const migrated = await this.update(record.id, {
      status: 'paused',
      iteration: legacy.iteration ?? 0,
      stallRounds: legacy.stallRounds ?? 0,
    });

    // 旧 session 现场复制到新槽(best-effort — 丢了也能靠重注目标提示词继续)
    try {
      const legacySessionPath =
        this.projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/.hologram/agents/main/session.json';
      const rawSession = await typedRpc('read_file_content', { file_path: legacySessionPath });
      await this.saveSession(record.id, JSON.parse(stripNums(rawSession)) as Message[]);
    } catch {
      /* session 快照 best-effort */
    }

    try {
      await typedRpc('delete_file_or_dir', { path: legacyGoalPath });
    } catch {
      /* best effort */
    }
    return migrated;
  }

  // ── Internals ──

  private async _write(record: GoalRecord): Promise<void> {
    await this.ensureGoalDir(record.id);
    await typedRpc('write_file_content', {
      file_path: this.recordPath(record.id),
      content: JSON.stringify(record, null, 2),
    });
    await this._upsertIndex(record);
    this.onState?.(record);
  }

  private async _upsertIndex(record: GoalRecord): Promise<void> {
    const all = await this.list();
    const idx = all.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      all[idx] = record;
    } else {
      all.push(record);
    }
    try {
      await typedRpc('write_file_content', { file_path: this.indexPath(), content: JSON.stringify(all, null, 2) });
    } catch {
      /* best effort */
    }
  }
}
