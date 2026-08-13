// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Task Manager — 主 Agent 的任务清单，按 Agent 实例隔离。
// Five tools: task_create, task_update, task_list, task_get, task_stop.
// Pure TypeScript, no Tauri invoke needed. 数据在内存，按 Agent 实例隔离。
//
// 隔离：每个会话的主 Agent 一个实例（runtime.createAgent 里 new 一个专属 TaskManager，
// 并把该 Agent 的 task_* 工具绑定到它），实例之间互不可见 → 每会话独立托盘。
//
// UI 落点：TasksPanel 经 runtime.getAgentTaskManager(agentId) 拿到该 Agent 的实例，
// 通过 subscribe() 订阅变更 + 用 create/update/stop 操作 —— 与 Agent 工具读写同一份。
// 本文件不 import 任何 ui/ 模块（agent 层依赖边界：agent → ui 单向，反之不许）。

import { z } from 'zod';
import type { Tool } from './tool';
import { defineTool } from './tools/define-tool';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  detail: string;
  ts: number; // created timestamp
}

export class TaskManager {
  private tasks = new Map<number, Task>();
  private nextId = 1;
  private listeners = new Set<() => void>();
  /** 供 useSyncExternalStore 的稳定快照 — 变更时才重建，引用恒定，否则触发无限循环。 */
  private snapshot: Task[] = [];

  /** 订阅变更（UI 面板响应式）。返回退订函数。 */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** 供 useSyncExternalStore 的 getSnapshot —— 返回稳定引用（变更时重建）。 */
  getSnapshot(): Task[] {
    return this.snapshot;
  }

  private emit() {
    this.snapshot = this.list();
    for (const cb of this.listeners) cb();
  }

  create(title: string, detail: string): Task {
    const t: Task = { id: this.nextId++, title, status: 'pending', detail, ts: Date.now() };
    this.tasks.set(t.id, t);
    this.emit();
    return t;
  }

  update(id: number, updates: { title?: string; status?: TaskStatus; detail?: string }): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (updates.title !== undefined) t.title = updates.title;
    if (updates.status !== undefined) t.status = updates.status;
    if (updates.detail !== undefined) t.detail = updates.detail;
    this.emit();
    return t;
  }

  list(filter?: TaskStatus): Task[] {
    const all = Array.from(this.tasks.values()).sort((a, b) => b.ts - a.ts);
    return filter ? all.filter((t) => t.status === filter) : all;
  }

  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }

  /** Mark a task as stopped/cancelled. Unlike delete, keeps the record. */
  stop(id: number): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.status = 'cancelled';
    this.emit();
    return t;
  }
}

export function createTaskTools(mgr: TaskManager): Tool[] {
  return [
    defineTool({
      name: 'task_create',
      description:
        'Create a new task to track a piece of work. Use for multi-step tasks where you need to track progress across turns. Returns the task ID.',
      schema: z.object({
        title: z.string().describe('Short task title (3-8 words)'),
        detail: z.string().describe('What needs to be done, in one sentence'),
      }),
      execute: async (args) => {
        const t = mgr.create(args.title, args.detail);
        return JSON.stringify({ id: t.id, title: t.title, status: t.status, detail: t.detail });
      },
    }),
    defineTool({
      name: 'task_update',
      description:
        "Update a task's status or details. Status can be: pending, in_progress, completed, cancelled.",
      schema: z.object({
        id: z.coerce.number().int().describe('Task ID to update'),
        status: z
          .enum(['pending', 'in_progress', 'completed', 'cancelled'])
          .optional()
          .describe('New status for the task'),
        title: z.string().optional().describe('New title (optional)'),
        detail: z.string().optional().describe('Updated detail text (optional)'),
      }),
      execute: async (args) => {
        const t = mgr.update(args.id, {
          title: args.title,
          status: args.status,
          detail: args.detail,
        });
        if (!t) return JSON.stringify({ error: 'Task ' + args.id + ' not found' });
        return JSON.stringify({ id: t.id, title: t.title, status: t.status, detail: t.detail });
      },
    }),
    defineTool({
      name: 'task_list',
      description: 'List all tracked tasks, optionally filtered by status. Returns tasks sorted newest-first.',
      schema: z.object({
        status: z
          .enum(['pending', 'in_progress', 'completed', 'cancelled'])
          .optional()
          .describe('Optional status filter. Omit to list all.'),
      }),
      readOnly: true,
      execute: async (args) => {
        const tasks = mgr.list(args.status);
        return JSON.stringify({ tasks, count: tasks.length });
      },
    }),
    defineTool({
      name: 'task_get',
      description: 'Get full details of a single task by ID.',
      schema: z.object({
        id: z.coerce.number().int().describe('Task ID to fetch'),
      }),
      readOnly: true,
      execute: async (args) => {
        const t = mgr.get(args.id);
        if (!t) return JSON.stringify({ error: 'Task ' + args.id + ' not found' });
        return JSON.stringify(t);
      },
    }),
    defineTool({
      name: 'task_stop',
      description:
        'Cancel/stop a task. The task record is kept (status set to cancelled) for audit. Use when a task is no longer needed or was superseded.',
      schema: z.object({
        id: z.coerce.number().int().describe('Task ID to stop'),
      }),
      execute: async (args) => {
        const t = mgr.stop(args.id);
        if (!t) return JSON.stringify({ error: 'Task ' + args.id + ' not found' });
        return JSON.stringify({ id: t.id, status: t.status });
      },
    }),
  ];
}
