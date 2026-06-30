// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Task Manager — in-memory task tracking for agent self-management.
// Five tools: task_create, task_update, task_list, task_get, task_stop.
// Pure TypeScript, no Tauri invoke needed. Tasks are session-scoped.

import type { Tool } from './tool';

export interface Task {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  detail: string;
  ts: number; // created timestamp
}

export class TaskManager {
  private tasks = new Map<number, Task>();
  private nextId = 1;

  create(title: string, detail: string): Task {
    const t: Task = { id: this.nextId++, title, status: 'pending', detail, ts: Date.now() };
    this.tasks.set(t.id, t);
    return t;
  }

  update(id: number, updates: { title?: string; status?: Task['status']; detail?: string }): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (updates.title !== undefined) t.title = updates.title;
    if (updates.status !== undefined) t.status = updates.status;
    if (updates.detail !== undefined) t.detail = updates.detail;
    return t;
  }

  list(filter?: Task['status']): Task[] {
    const all = Array.from(this.tasks.values()).sort((a, b) => b.ts - a.ts);
    if (filter) return all.filter(t => t.status === filter);
    return all;
  }

  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }

  /** Mark a task as stopped/cancelled. Unlike delete, keeps the record. */
  stop(id: number): Task | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.status = 'cancelled';
    return t;
  }
}

export function createTaskTools(mgr: TaskManager): Tool[] {
  return [
    {
      name: () => 'task_create',
      description: () =>
        'Create a new task to track a piece of work. Use for multi-step tasks where you need to track progress across turns. Returns the task ID.',
      parameters: () => ({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title (3-8 words)' },
          detail: { type: 'string', description: 'What needs to be done, in one sentence' },
        },
        required: ['title', 'detail'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const title = (args.title as string) || '未命名任务';
        const detail = (args.detail as string) || '';
        const t = mgr.create(title, detail);
        return JSON.stringify({ id: t.id, title: t.title, status: t.status, detail: t.detail });
      },
    },
    {
      name: () => 'task_update',
      description: () =>
        'Update a task\'s status or details. Status can be: pending, in_progress, completed, cancelled.',
      parameters: () => ({
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Task ID to update' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'New status for the task',
          },
          title: { type: 'string', description: 'New title (optional)' },
          detail: { type: 'string', description: 'Updated detail text (optional)' },
        },
        required: ['id'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const id = args.id as number;
        const t = mgr.update(id, {
          title: args.title as string | undefined,
          status: args.status as Task['status'] | undefined,
          detail: args.detail as string | undefined,
        });
        if (!t) return JSON.stringify({ error: `Task ${id} not found` });
        return JSON.stringify({ id: t.id, title: t.title, status: t.status, detail: t.detail });
      },
    },
    {
      name: () => 'task_list',
      description: () =>
        'List all tracked tasks, optionally filtered by status. Returns tasks sorted newest-first.',
      parameters: () => ({
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: 'Optional status filter. Omit to list all.',
          },
        },
      }),
      readOnly: () => true,
      execute: async (args) => {
        const filter = args.status as Task['status'] | undefined;
        const tasks = mgr.list(filter);
        return JSON.stringify({ tasks, count: tasks.length });
      },
    },
    {
      name: () => 'task_get',
      description: () =>
        'Get full details of a single task by ID.',
      parameters: () => ({
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Task ID to fetch' },
        },
        required: ['id'],
      }),
      readOnly: () => true,
      execute: async (args) => {
        const id = args.id as number;
        const t = mgr.get(id);
        if (!t) return JSON.stringify({ error: `Task ${id} not found` });
        return JSON.stringify(t);
      },
    },
    {
      name: () => 'task_stop',
      description: () =>
        'Cancel/stop a task. The task record is kept (status set to cancelled) for audit. Use when a task is no longer needed or was superseded.',
      parameters: () => ({
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Task ID to stop' },
        },
        required: ['id'],
      }),
      readOnly: () => false,
      execute: async (args) => {
        const id = args.id as number;
        const t = mgr.stop(id);
        if (!t) return JSON.stringify({ error: `Task ${id} not found` });
        return JSON.stringify({ id: t.id, status: t.status });
      },
    },
  ];
}
