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
import { agentSessionState } from '../agent/agent-session-state';
import type { AgentStatus, RuntimeNotifier } from '../agent/runtime/types';
import type { Message } from '../provider/types';
import { useAgentPanelStore } from './agent-panel-store';
import { rebuildMessagesFromMessages } from './chat-session';
import { getChatStore, msgStoreFor } from './chat-store';
import { bus } from './events';
import type { AssistantMessage, SubAgentPart } from './message-model';
import { createSubAgentSink } from './subagent-sink';

/**
 * 创建 RuntimeNotifier — 桥接 Runtime 事件到 UI store。
 * @param storeId 面板实例 ID（用于 store 路由）
 */
export function createRuntimeAdapter(storeId: string): RuntimeNotifier {
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
      // Route by ownership, NOT by active tab: find the session whose registered
      // agent actually holds this session array (sessionReplaced passes
      // `this.session` — the same reference getSession() returns).
      // Previously this rebuilt the ACTIVE session's store unconditionally, so a
      // background-session compaction (or a history-load setSession fired before
      // the new tab became active) overwrote the foreground tab's messages with
      // another session's content — every tab ended up showing the same chat.
      const { sessions } = getChatStore(storeId).sess.getState();
      for (const s of sessions) {
        const agent = agentSessionState.getAgent(storeId, s.id);
        if (agent && agent.getSession() === messages) {
          rebuildMessagesFromMessages(messages, storeId, s.id);
          return;
        }
      }
      // No registered owner: the agent is mid-restore — setSession() runs before
      // setAgent() in loadSessionFromDisk / autoRestoreLastSession, and those
      // flows rebuild explicitly via renderRestoredSession. Leave stores alone.
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
      // Primary target: the last streaming assistant message.
      let attachIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant' && (m as AssistantMessage).status === 'streaming') {
          attachIdx = i;
          break;
        }
      }
      if (attachIdx < 0) {
        // Fallback: the spawn event raced with the parent turn finalising —
        // attach to the last assistant message rather than dropping the card.
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            attachIdx = i;
            break;
          }
        }
      }
      if (attachIdx >= 0) {
        const m = msgs[attachIdx] as AssistantMessage;
        m.parts.push(subPart);
        // Commit through the store's single write path — swaps the message
        // reference so memoized bubbles render the new card even when the
        // parent turn already finished.
        store.getState().touchMessage(m._id);
      } else {
        // No assistant message at all — keep the sink alive so events aren't
        // lost, but make the failure visible instead of silently dropping.
        console.warn(`[subagent] spawn ${info.agentId}: no assistant message to attach to`);
      }
      return createSubAgentSink({
        subPart,
        // The sink mutates subPart in place; commit by part identity so the
        // update lands even after a session rebuild re-attached the part to
        // a new message object.
        bump: () => store.getState().touchMessageContaining(subPart),
        onProgress: info.onProgress,
      });
    },

    onSubAgentFinished(agentId: string, _parentAgentId: string, sessionId: number, ok: boolean): void {
      const text = ok ? `子 Agent ${agentId} 已完成` : `子 Agent ${agentId} 失败`;
      useAgentPanelStore.getState().pushAlert({
        id: `finish-${agentId}-${hashStr(text)}`,
        level: ok ? 'info' : 'warn',
        text,
      });
      // Find and update the SubAgentPart in the assistant message that owns it
      const store = msgStoreFor(storeId, sessionId);
      if (!store) return;
      const msgs = store.getState().messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant') {
          const parts = (m as AssistantMessage).parts;
          for (const p of parts) {
            if (p.type === 'subagent' && p.agentId === agentId) {
              p.status = ok ? 'done' : 'error';
              p.version++;
              // Commit via the single write path — the parent turn is often
              // already done here; a bare bump froze the card at "执行中".
              store.getState().touchMessage(m._id);
              return;
            }
          }
        }
      }
    },

    onLifecycleAlert(agentId: string, level: 'info' | 'warn' | 'error', text: string): void {
      useAgentPanelStore.getState().pushAlert({
        id: `lifecycle-${agentId}-${hashStr(text)}`,
        level: level === 'error' ? 'warn' : level, // store 只支持 'warn' | 'info'
        text,
      });
    },
  };
}

/** Simple string hash for dedup IDs — same text → same ID → store replaces. */
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
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
