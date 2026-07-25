// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentSessionState — per-session non-serialisable state registry.
//
// Replaces the four module-level Maps that lived in chat-session.ts:
//   agentHandles, sessionExecStates, turnPairsByPanel, agentFactoryByPanel
//
// Architecture (mirrors execution-state.ts):
//   - Zustand vanilla store holds a `version` counter for subscription-based
//     reactivity (Map mutations bump version → subscribers fire).
//   - Internal Maps live in the factory closure (non-serialisable, not in
//     the store state) — same pattern as AbortController in execution-state.
//
// Composite keys (storeId:sid) prevent cross-panel collisions since session
// IDs are per-panel (both start at 1).

import type { ChatAgentHandle } from './chat-agent-handle';
import { createExecState, type ExecStateInstance } from './execution-state';
import { createStore } from 'zustand/vanilla';

// ── Types ──

export interface TurnPair {
  userText: string;
  userBubble: null;
  assistantBubble: null;
  sessionIndex: number;
}

export type AgentFactory = () => Promise<ChatAgentHandle | null>;

// ── Store state (serialisable) ──

interface AgentSessionStoreState {
  /** Bumped on every agent/exec/factory mutation so subscribers re-read. */
  version: number;
}

// ── Public API ──

export interface AgentSessionStateApi {
  // ── Agent handles (per session) ──
  setAgent(storeId: string, sessionId: number, agent: ChatAgentHandle): void;
  getAgent(storeId: string, sessionId: number): ChatAgentHandle | null;
  removeAgent(storeId: string, sessionId: number): void;

  // ── Exec state (per session) ──
  setExec(storeId: string, sessionId: number, exec: ExecStateInstance): void;
  getExec(storeId: string, sessionId: number): ExecStateInstance | null;
  getOrCreateExec(storeId: string, sessionId: number): ExecStateInstance;
  /** Cascade-abort agent, stop exec, remove entry. */
  removeExec(storeId: string, sessionId: number): void;

  // ── Agent factory (per panel) ──
  setAgentFactory(storeId: string, fn: AgentFactory | null): void;
  getAgentFactory(storeId: string): AgentFactory | null;

  // ── Turn pairs (per panel) ──
  getTurnPairs(storeId: string): TurnPair[];
  setTurnPairs(storeId: string, pairs: TurnPair[]): void;

  // ── Bulk operations ──
  /** Remove all agent handles and exec states for a panel. */
  clearPanelState(storeId: string): void;

  // ── Subscription ──
  /** Subscribe to state changes. Returns unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Current version counter. */
  readonly version: number;
}

// ── Key helper ──

function agentKey(storeId: string, sid: number): string {
  return `${storeId}:${sid}`;
}

// ── Factory ──

export function createAgentSessionState(): AgentSessionStateApi {
  const store = createStore<AgentSessionStoreState>(() => ({
    version: 0,
  }));

  // ── Non-serialisable mutable state (closure) ──
  const _agentBySession = new Map<string, ChatAgentHandle>();
  const _execBySession = new Map<string, ExecStateInstance>();
  const _agentFactoryByPanel = new Map<string, AgentFactory>();
  const _turnPairsByPanel = new Map<string, TurnPair[]>();

  function _bump(): void {
    store.setState({ version: store.getState().version + 1 });
  }

  const self: AgentSessionStateApi = {
    // ── Agent handles ──

    setAgent(storeId, sessionId, agent): void {
      _agentBySession.set(agentKey(storeId, sessionId), agent);
      _bump();
    },

    getAgent(storeId, sessionId): ChatAgentHandle | null {
      return _agentBySession.get(agentKey(storeId, sessionId)) ?? null;
    },

    removeAgent(storeId, sessionId): void {
      _agentBySession.delete(agentKey(storeId, sessionId));
      _bump();
    },

    // ── Exec state ──

    setExec(storeId, sessionId, exec): void {
      _execBySession.set(agentKey(storeId, sessionId), exec);
      _bump();
    },

    getExec(storeId, sessionId): ExecStateInstance | null {
      return _execBySession.get(agentKey(storeId, sessionId)) ?? null;
    },

    getOrCreateExec(storeId, sessionId): ExecStateInstance {
      const k = agentKey(storeId, sessionId);
      let es = _execBySession.get(k);
      if (!es) {
        es = createExecState();
        _execBySession.set(k, es);
        _bump();
      }
      return es;
    },

    removeExec(storeId, sessionId): void {
      const k = agentKey(storeId, sessionId);
      const es = _execBySession.get(k);
      if (es) {
        _agentBySession.get(k)?.cascadeAbort();
        es.stop();
        _execBySession.delete(k);
        _bump();
      }
    },

    // ── Agent factory ──

    setAgentFactory(storeId, fn): void {
      if (fn) _agentFactoryByPanel.set(storeId, fn);
      else _agentFactoryByPanel.delete(storeId);
      _bump();
    },

    getAgentFactory(storeId): AgentFactory | null {
      return _agentFactoryByPanel.get(storeId) ?? null;
    },

    // ── Turn pairs ──

    getTurnPairs(storeId): TurnPair[] {
      let tp = _turnPairsByPanel.get(storeId);
      if (!tp) {
        tp = [];
        _turnPairsByPanel.set(storeId, tp);
      }
      return tp;
    },

    setTurnPairs(storeId, pairs): void {
      _turnPairsByPanel.set(storeId, pairs);
      _bump();
    },

    // ── Bulk operations ──

    clearPanelState(storeId): void {
      const prefix = storeId + ':';
      for (const k of [..._agentBySession.keys()]) {
        if (k.startsWith(prefix)) _agentBySession.delete(k);
      }
      for (const k of [..._execBySession.keys()]) {
        if (k.startsWith(prefix)) _execBySession.delete(k);
      }
      _bump();
    },

    // ── Subscription ──

    subscribe(fn): () => void {
      return store.subscribe(fn);
    },

    get version(): number {
      return store.getState().version;
    },
  };

  return self;
}

// ── Default singleton — shared across all panels ──

export const agentSessionState = createAgentSessionState();
