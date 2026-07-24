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
  }

  /** 子 Agent 失败时调用 */
  fail(agentId: string, error: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'failed';
    entry.summary = error;
    entry.finishedAt = Date.now();
  }

  /** 子 Agent 被中止时调用 */
  stop(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'stopped';
    entry.finishedAt = Date.now();
  }

  /** merge 成功后标记 */
  markMerged(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.status = 'merged';
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
