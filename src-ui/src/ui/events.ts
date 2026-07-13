// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { dbg } from './debug';

// Event Bus — lightweight pub/sub for cross-component communication
// Used by: CheckPanel → Main → StarGraph (navigate:node)
//          Future: detail card → Agent (agent:send)
//          Future: graph → check (graph:selection-changed)

// ponytail: event map — add new events here. The overloads on emit/on
// will enforce the argument types at compile time. String literals outside
// this map still work but produce any-typed args.

// ── Known event signatures ──

export interface BusEvents {
  'agent:event':        [ev: import('../agent/agent-types').AgentEvent];
  'agent:diag':         [d: { text: string; ready: boolean }];
  'agent:progress':     [data: { step: number; toolName: string }];
  'agent:tool-started': [data: { toolName: string; args: Record<string, unknown> }];
  'agent:tool-done':    [data: { toolName: string; args: Record<string, unknown>; output: string }];
  'agent:thinking':     [data: { text?: string }];
  'agent:focus-changed':[data: { nodeNames: string[]; toolName: string }];
  'agent:permission-request': [data: { id: string; toolName: string; description: string; args: Record<string, unknown> }];
  'agent:permission-response': [data: { id: string; allow: boolean; remember: boolean }];
  'agent:shell-output': [data: { sessionId?: number; output: string; done?: boolean }];

  'graph:node-clicked': [data: { nodeName: string; nodeType: string; nodeId: string; degree: number; location: string }];
  'graph:path-selected': [data: { from: { name: string; id: string; type: string }; to: { name: string; id: string; type: string }; pathLength: number; pathNames: string[] }];
  'graph:region-selected': [data: { nodeNames: string[]; nodeCount: number }];
  'graph:show-prompt':  [data: { title: string; question: string }];

  'chat:turn-done':     [];

  'prompt:ask':         [data: { id: string; question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean; callback: (answer: string[] | null) => void }];

  'check:result':       [data: { passed: boolean; violations: number }];
  'check:history':      [data: { checkData: any; timestamp: string }];

  'highlight:file':     [filePath: string];
  'highlight:folder':   [filePath: string];
  'highlight:clear':    [];
  'navigate:file':      [filePath: string];

  'timeline:refresh':   [];
  'lang:changed':       [data: { lang: string }];

  'git:committed':      [data: { message: string; output: string }];
  'git:pushed':         [];
  'git:pulled':         [];
}

type Handler = (...args: any[]) => void;

class EventBus {
  private handlers = new Map<string, Handler[]>();

  // ── Typed overloads for known events ──
  on<E extends keyof BusEvents>(event: E, handler: (...args: BusEvents[E]) => void): void;
  // ── Fallback for string literals not in the map ──
  on(event: string, handler: Handler): void;
  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list) { list.push(handler); }
    else { this.handlers.set(event, [handler]); }
  }

  off<E extends keyof BusEvents>(event: E, handler: (...args: BusEvents[E]) => void): void;
  off(event: string, handler: Handler): void;
  off(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  emit<E extends keyof BusEvents>(event: E, ...args: BusEvents[E]): void;
  emit(event: string, ...args: any[]): void;
  emit(event: string, ...args: any[]): void {
    dbg('EventBus.emit', event, ...args);
    const list = this.handlers.get(event);
    if (list) {
      for (const h of list) {
        try { h(...args); } catch (e) { console.error(`[EventBus] ${event} handler error:`, e); }
      }
    }
  }

  clear(event?: string): void {
    if (event) { this.handlers.delete(event); }
    else { this.handlers.clear(); }
  }
}

export const bus = new EventBus();

// ponytail: event registry moved to BusEvents interface above —
// single source of truth, enforced by emit/on overloads.
//
// AppShell commands (not bus):
//   shell.notifyPanelChanged() / navigateToNode() / navigateToFile()
//   shell.highlightFile() / highlightFolder() / clearHighlight()
//   shell.queryAgent()
