// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Task Manager — in-memory task tracking for agent self-management.
// Five tools: task_create, task_update, task_list, task_get, task_stop.
// Pure TypeScript, no Tauri invoke needed. Tasks are session-scoped.

import { z } from 'zod';
import type { Tool } from './tool';
import { defineTool } from './tools/define-tool';

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
    if (filter) return all.filter((t) => t.status === filter);
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
        if (!t) return JSON.stringify({ error: `Task ${args.id} not found` });
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
        if (!t) return JSON.stringify({ error: `Task ${args.id} not found` });
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
        if (!t) return JSON.stringify({ error: `Task ${args.id} not found` });
        return JSON.stringify({ id: t.id, status: t.status });
      },
    }),
  ];
}
