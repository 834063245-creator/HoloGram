// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { dbg } from './debug';

// Event Bus — lightweight pub/sub for cross-component communication
// Used by: CheckPanel → Main → StarGraph (navigate:node)
//          Future: detail card → Agent (agent:send)
//          Future: graph → check (graph:selection-changed)

type Handler = (...args: any[]) => void;

class EventBus {
  private handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(event, [handler]);
    }
  }

  off(event: string, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  emit(event: string, ...args: any[]): void {
    dbg('EventBus.emit', event, ...args);
    const list = this.handlers.get(event);
    if (list) {
      for (const h of list) {
        try { h(...args); } catch (e) { console.error(`[EventBus] ${event} handler error:`, e); }
      }
    }
  }

  /** Remove all handlers for a given event (or all events if no arg). */
  clear(event?: string): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}

export const bus = new EventBus();

// Known event names:
//   navigate:node (nodeName: string) — focus a node in the star graph
//   agent:tool-started ({ toolName: string, args: Record<string, unknown> }) — agent started a tool call
//   agent:tool-done ({ toolName: string, args: Record<string, unknown>, output: string }) — agent tool call completed
//   agent:thinking ({ text?: string }) — agent is reasoning / thinking
//   agent:focus-changed ({ nodeNames: string[], toolName: string }) — agent's focus nodes changed
//   agent:query (question: string) — send a question to Agent (opens chat + sends)
//   // Step 3: 图作为输入 — 点击节点驱动 Agent
//   graph:node-clicked ({ nodeName: string, nodeType: string, nodeId: string, degree: number, location: string }) — 点击节点
//   graph:path-selected ({ from: {name,id,type}, to: {name,id,type}, pathLength: number, pathNames: string[] }) — Shift+点击路径
//   graph:region-selected ({ nodeNames: string[], nodeCount: number }) — 拖拽框选区域
//   graph:show-prompt ({ title: string, question: string }) — 图交互完成，弹出确认条（不自动发查询）
//   agent:permission-request ({ id: string, toolName: string, description: string, args: Record<string, unknown> }) — Agent 工具需要用户批准
//   agent:permission-response ({ id: string, allow: boolean, remember: boolean }) — 用户对权限请求的回应
