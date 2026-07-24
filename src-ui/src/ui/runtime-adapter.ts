// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// RuntimeAdapter — RuntimeNotifier 的 UI 实现
//
// 把 Runtime 事件桥接到 zustand store + event bus。
// 这是 bootstrap.ts 中 uiNotifier 逻辑的新家。
//
// UI 层拥有此模块 — 可以自由 import zustand/store/bus。
// agent/ 层永远不 import 此文件。

import type { AgentEvent, EventSink } from '../agent/agent-types';
import type { Message } from '../provider/types';
import { bus } from './events';
import { getChatStore, msgStoreFor } from './chat-store';
import { rebuildMessagesFromMessages } from './chat-session';
import type { SubAgentPart } from './message-model';
import { createSubAgentSink } from './subagent-sink';
import type { RuntimeNotifier, AgentStatus } from '../agent/runtime/types';
import { useAgentPanelStore } from './agent-panel-store';

/**
 * 创建 RuntimeNotifier — 桥接 Runtime 事件到 UI store。
 * @param storeId 面板实例 ID（用于 store 路由）
 */
export function createRuntimeAdapter(storeId: string): RuntimeNotifier {
  const bumpStore = (sid: number) => msgStoreFor(storeId, sid)?.getState().bump();

  return {
    onAgentEvent(_agentId: string, _event: AgentEvent): void {
      // Agent 事件通过 eventSink 直接路由到 ChatCore.renderEvent
      // 这里不需要重复处理 — eventSink 已经在 createAgent 时注入
    },

    onAgentStatus(agentId: string, status: AgentStatus): void {
      const store = useAgentPanelStore.getState();
      store.setAgents(store.agents.map((a) => (a.id === agentId ? { ...a, status } : a)));
      bus.emit('agent:status', { agentId, status });
    },

    onProgress(_agentId: string, _step: number, _toolName: string): void {
      // Progress is handled via eventSink → ChatCore.renderEvent
    },

    onToolDone(_agentId: string, toolName: string, args: Record<string, unknown>, output: string): void {
      bus.emit('agent:tool-done', { toolName, args, output });
    },

    onSessionReplaced(_agentId: string, messages: Message[]): void {
      const sessStore = getChatStore(storeId).sess.getState();
      const sid = sessStore.sessions[sessStore.activeIdx]?.id;
      if (sid != null) {
        rebuildMessagesFromMessages(messages, storeId, sid);
      }
    },

    onSubAgentSpawn(info): EventSink | undefined {
      const sid = info.sessionId;
      const store = msgStoreFor(storeId, sid);
      if (!store) return undefined;
      const subPart: SubAgentPart = {
        type: 'subagent',
        agentId: info.agentId,
        description: info.description,
        status: 'running',
        parts: [],
        version: 0,
      };
      const msgs = store.getState().messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant' && (m as any).status === 'streaming') {
          (m as any).parts.push(subPart);
          break;
        }
      }
      bumpStore(sid);
      return createSubAgentSink({
        subPart,
        bump: () => bumpStore(sid),
        onProgress: info.onProgress,
      });
    },

        onSubAgentFinished(agentId: string, _parentAgentId: string, sessionId: number, ok: boolean): void {
      useAgentPanelStore.getState().pushAlert({
        id: `finish-${agentId}-${Date.now()}`,
        level: ok ? 'info' : 'warn',
        text: ok ? `子 Agent ${agentId} 已完成` : `子 Agent ${agentId} 失败`,
      });
      // Find and update the SubAgentPart in the streaming assistant message
      const store = msgStoreFor(storeId, sessionId);
      if (!store) return;
      const msgs = store.getState().messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant') {
          const parts = (m as any).parts as any[];
          for (const p of parts) {
            if (p.type === 'subagent' && p.agentId === agentId) {
              p.status = ok ? 'done' : 'error';
              p.version++;
              bumpStore(sessionId);
              return;
            }
          }
        }
      }
    },

    onLifecycleAlert(agentId: string, level: 'info' | 'warn' | 'error', text: string): void {
      useAgentPanelStore.getState().pushAlert({
        id: `lifecycle-${agentId}-${Date.now()}`,
        level: level === 'error' ? 'warn' : level, // store 只支持 'warn' | 'info'
        text,
      });
    },
  };
}

/**
 * 创建 BuilderDeps — UI 依赖注入给 agent-builder。
 * 让 agent-builder 的 buildToolRegistry 不直接 import ui/ 模块。
 */
export function createBuilderDeps(storeId: string): import('../agent/runtime/agent-builder').BuilderDeps {
  return {
    onAskUser: (req) => {
      bus.emit('prompt:ask', req);
    },
    onDataflowSaved: () => {
      bus.emit('dataflow:saved');
    },
    // diagnosticsSource and shellStream are wired separately
    // (they need Tauri-specific imports that belong in ui layer)
  };
}