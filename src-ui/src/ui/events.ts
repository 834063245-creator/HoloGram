// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { dbg } from './debug';

// Event Bus — typed pub/sub for cross-component communication
//
// 所有事件必须在 BusEvents 中声明类型 — 不再有 any fallback。
// 新增事件：在 BusEvents 里加一行，编译器自动检查参数类型。

export interface BusEvents {
  // ── Agent ──
  'agent:diag': [d: { text: string; ready: boolean }];
  'agent:tool-done': [data: { toolName: string; args: Record<string, unknown>; output: string }];
  'prompt:ask': [
    data: {
      id: string;
      question: string;
      header: string;
      options: { label: string; description: string }[];
      multiSelect: boolean;
      callback: (answer: string[] | null) => void;
    },
  ];

  // ── Chat ──
  'chat:turn-done': [];
  'goal:state': [record: import('../agent/goal-manager').GoalRecord];

  // ── Check ──
  'check:result': [data: { passed: boolean; violations: number }];

  // ── Graph ──
  'graph:node-clicked': [
    data: { nodeName: string; nodeType: string; nodeId: string; degree: number; location: string },
  ];
  'graph:rendered': [];
  'lang:changed': [data: { lang: string }];

  // ── Navigation / Highlight ──
  'highlight:file': [filePath: string];
  'navigate:file': [filePath: string];

  // ── Workspace ──
  'workspace:switched': [];
  'timeline:refresh': [];
  'dataflow:saved': [];
}

type Handler = (...args: any[]) => void;

class EventBus {
  private handlers = new Map<string, Handler[]>();
  private _prefix: string;
  private _parent: EventBus | null;

  constructor(prefix = '', parent: EventBus | null = null) {
    this._prefix = prefix;
    this._parent = parent;
  }

  /** Create a child bus that prefixes all events. Delegates to parent's emit/on. */
  withPrefix(prefix: string): EventBus {
    return new EventBus(prefix + ':', this._parent ?? this);
  }

  private _resolve(): EventBus {
    return this._parent ?? this;
  }

  private _key(event: string): string {
    return this._prefix ? this._prefix + event : event;
  }

  on<E extends keyof BusEvents>(event: E, handler: (...args: BusEvents[E]) => void): void {
    const bus = this._resolve();
    const key = this._key(event);
    const list = bus.handlers.get(key);
    if (list) {
      list.push(handler as Handler);
    } else {
      bus.handlers.set(key, [handler as Handler]);
    }
  }

  off<E extends keyof BusEvents>(event: E, handler: (...args: BusEvents[E]) => void): void {
    const bus = this._resolve();
    const key = this._key(event);
    const list = bus.handlers.get(key);
    if (list) {
      const idx = list.indexOf(handler as Handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  emit<E extends keyof BusEvents>(event: E, ...args: BusEvents[E]): void {
    const bus = this._resolve();
    const key = this._key(event);
    dbg('EventBus.emit', key, ...args);
    const list = bus.handlers.get(key);
    if (list) {
      for (const h of list) {
        try {
          h(...args);
        } catch (e) {
          console.error(`[EventBus] ${key} handler error:`, e);
        }
      }
    }
  }

  clear(event?: string): void {
    const bus = this._resolve();
    if (event) {
      const key = this._key(event);
      bus.handlers.delete(key);
    } else if (this._prefix) {
      for (const k of bus.handlers.keys()) {
        if (k.startsWith(this._prefix)) bus.handlers.delete(k);
      }
    } else {
      bus.handlers.clear();
    }
  }
}

export const bus = new EventBus();
