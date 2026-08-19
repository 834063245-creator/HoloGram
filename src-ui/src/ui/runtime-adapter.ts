// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// RuntimeAdapter — RuntimeNotifier 的 UI 实现
//
// 把 Runtime 事件桥接到 zustand store + event bus。
// 这是 bootstrap.ts 中 uiNotifier 逻辑的新家。
//
// UI 层拥有此模块 — 可以自由 import zustand/store/bus。
// agent/ 层永远不 import 此文件。

import { agentSessionState } from '../agent/agent-session-state';
import type { AgentEvent, EventSink } from '../agent/agent-types';
import type { AgentStatus, RuntimeNotifier } from '../agent/runtime/types';
import type { Message } from '../provider/types';
import { pushAsk } from '../state/ask-store';
import { bumpDataflowSaved } from '../state/dataflow-store';
import { useAgentPanelStore } from './agent-panel-store';
import { rebuildMessagesFromMessages } from './chat-session';
import { getChatStore, msgStoreFor } from './chat-store';
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
      store.bumpStatusTick(); // P1c：替代 bus 'agent:status'（岛侧消费者订阅 tick）
    },

    onProgress(_agentId: string, _step: number, _toolName: string): void {
      // 进度通过 eventSink → ChatCore.renderEvent 处理
    },

    onToolDone(_agentId: string, toolName: string, args: Record<string, unknown>, output: string): void {
      // P1 总线归零：bus 'agent:tool-done' + toolDoneTick 双轨合并为 lastToolDone 单轨
      // （workspace / agent-visualizer / 岛侧 tick 消费者统一订阅 agent-panel-store）
      useAgentPanelStore.getState().setLastToolDone({ toolName, args, output });
    },

    onSessionReplaced(_agentId: string, messages: Message[]): void {
      // 按所有权路由，而非按活动标签页：找到其注册 agent 实际持有
      // 此会话数组的会话（sessionReplaced 传递 `this.session` —
      // 与 getSession() 返回的引用相同）。
      // 触发来源只有主动动作：setSession（恢复/加载）、retractTurn。
      // 压缩（context compaction）不再触发此事件 — 压缩只影响
      // 发送载荷，session 始终是完整历史，UI 与存档永不因压缩改变。
      const { sessions } = getChatStore(storeId).sess.getState();
      for (const s of sessions) {
        const agent = agentSessionState.getAgent(storeId, s.id);
        if (agent && agent.getSession() === messages) {
          rebuildMessagesFromMessages(messages, storeId, s.id);
          return;
        }
      }
      // 无注册所有者：agent 正在恢复中 — setSession() 在
      // loadSessionFromDisk / autoRestoreLastSession 中先于 setAgent() 运行，
      // 这些流程通过 renderRestoredSession 显式重建。不要动 store。
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
      // 主要目标：最后一条流式助手消息。
      let attachIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant' && (m as AssistantMessage).status === 'streaming') {
          attachIdx = i;
          break;
        }
      }
      if (attachIdx < 0) {
        // 回退：spawn 事件与父回合最终化竞争 —
        // 挂载到最后一条助手消息而非丢弃卡片。
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
        // 通过 store 的单一写入路径提交 — 替换消息引用，
        // 使记忆化气泡即使在父回合已完成后也能渲染新卡片。
        store.getState().touchMessage(m._id);
      } else {
        // 完全没有助手消息 — 保持 sink 存活以免事件丢失，
        // 但让失败可见而非静默丢弃（多会话错位时用户需要知道）。
        console.warn(`[subagent] spawn ${info.agentId}: no assistant message to attach to`);
        useAgentPanelStore.getState().pushAlert({
          id: `spawn-attach-fail-${info.agentId}`,
          level: 'warn',
          text: `子 Agent ${info.agentId} 已启动，但消息流中无可挂载的助手消息，其过程可能不可见`,
        });
      }
      return createSubAgentSink({
        subPart,
        // sink 原地变更 subPart；按 part 身份提交，使更新
        // 在会话重建将 part 重新挂载到新消息对象后仍能生效。
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
      // 查找并更新拥有它的助手消息中的 SubAgentPart
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
              // 通过单一写入路径提交 — 父回合通常此时已完成；
              // 裸 bump 会使卡片停在"执行中"。
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

/** 简单字符串 hash 用于去重 ID — 相同文本 → 相同 ID → store 替换。 */
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
      // P1 总线归零：prompt:ask → state/ask-store（callback-in-store）
      pushAsk(req);
    },
    onDataflowSaved: () => {
      bumpDataflowSaved();
    },
    // diagnosticsSource 和 shellStream 单独接线
    // （它们需要属于 UI 层的 Tauri 特定 import）
  };
}
