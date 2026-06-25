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

// Known event names (bus — 纯通知，不改变状态):
//   agent:tool-started ({ toolName: string, args: Record<string, unknown> }) — agent started a tool call
//   agent:tool-done ({ toolName: string, args: Record<string, unknown>, output: string }) — agent tool call completed
//   agent:thinking ({ text?: string }) — agent is reasoning / thinking
//   agent:focus-changed ({ nodeNames: string[], toolName: string }) — agent's focus nodes changed
//   agent:diag ({ text: string, ready: boolean }) — agent diagnostic info
//   agent:shell-output ({ sessionId?: number; output: string; done?: boolean }) — terminal shell output
//   agent:permission-request ({ id: string, toolName: string, description: string, args: Record<string, unknown> }) — Agent 工具需要用户批准
//   agent:permission-response ({ id: string, allow: boolean, remember: boolean }) — 用户对权限请求的回应
//   graph:node-clicked ({ nodeName: string, nodeType: string, nodeId: string, degree: number, location: string }) — 点击节点
//   graph:path-selected ({ from: {name,id,type}, to: {name,id,type}, pathLength: number, pathNames: string[] }) — Shift+点击路径
//   graph:region-selected ({ nodeNames: string[], nodeCount: number }) — 拖拽框选区域
//   graph:show-prompt ({ title: string, question: string }) — 图交互完成，弹出确认条
//   chat:turn-done ({}) — Agent 对话轮次完成
//   check:history ({ checkData: CheckResult, timestamp: string }) — 简报历史回看请求
//   timeline:refresh () — 时间线需要刷新
//   git:committed ({ message: string, output: string }) / git:pushed / git:pulled — Git 操作结果
//   lang:changed ({ lang: string }) — 界面语言变更
//
// 已迁移到 AppShell（命令式，非 bus）:
//   shell.notifyPanelChanged()    ← 原 bus.emit('panel:toggle')
//   shell.navigateToNode(name)    ← 原 bus.emit('navigate:node', name)
//   shell.navigateToFile(path)    ← 原 bus.emit('navigate:file', path)
//   shell.highlightFile(path)     ← 原 bus.emit('highlight:file', path)
//   shell.highlightFolder(path)   ← 原 bus.emit('highlight:folder', path)
//   shell.clearHighlight()        ← 原 bus.emit('highlight:clear')
//   shell.queryAgent(question)    ← 原 bus.emit('agent:query', question)
