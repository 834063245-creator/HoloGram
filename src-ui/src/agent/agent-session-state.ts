// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentSessionState — 每会话非序列化状态注册器。
//
// 替代原 chat-session.ts 中的四个模块级 Map：
//   agentHandles, sessionExecStates, turnPairsByPanel, agentFactoryByPanel
//
// 架构（与 execution-state.ts 一致）：
//   - Zustand vanilla store 持有 `version` 计数器，用于基于订阅的
//     响应式（Map 变更时递增 version → 触发订阅者）。
//   - 内部 Map 存放在工厂闭包中（非序列化，不在
//     store 状态中）— 与 execution-state 中的 AbortController 模式一致。
//
// 复合键（storeId:sid）防止跨面板冲突，因为会话
// ID 是每面板的（都从 1 开始）。

import type { ChatAgentHandle } from './chat-agent-handle';
import { createExecState, type ExecStateInstance } from './execution-state';
import { createStore } from 'zustand/vanilla';

// ── 类型 ──

export interface TurnPair {
  userText: string;
  userBubble: null;
  assistantBubble: null;
  sessionIndex: number;
}

export type AgentFactory = () => Promise<OwnedAgentHandle | null>;

/** 会话持有的 Agent 句柄 — 必须可销毁。
 *  所有权契约：存入 setAgent 即转移所有权；removeAgent / clearPanelState /
 *  setAgent 覆盖时由本注册器负责 dispose，调用方无需（也不得）自行销毁。
 *  runtime 的 AgentHandle 天然满足此接口。
 *  bindSession 可选 — 会话层在登记句柄后调用，把 board 静态绑定到该会话。 */
export type OwnedAgentHandle = ChatAgentHandle & { dispose(): void; bindSession?(sessionId: string): void };

// ── Store 状态（可序列化）──

interface AgentSessionStoreState {
  /** 每次 agent/exec/factory 变更时递增，使订阅者重新读取。 */
  version: number;
}

// ── 公共 API ──

export interface AgentSessionStateApi {
  // ── Agent 句柄（每会话）──
  /** 存入句柄并接管其所有权 — 覆盖同键旧句柄时会先 dispose 旧句柄。 */
  setAgent(storeId: string, sessionId: number, agent: OwnedAgentHandle): void;
  getAgent(storeId: string, sessionId: number): ChatAgentHandle | null;
  /** 移除并 dispose 该会话的句柄。 */
  removeAgent(storeId: string, sessionId: number): void;

  // ── Exec 状态（每会话）──
  setExec(storeId: string, sessionId: number, exec: ExecStateInstance): void;
  getExec(storeId: string, sessionId: number): ExecStateInstance | null;
  getOrCreateExec(storeId: string, sessionId: number): ExecStateInstance;
  /** 级联中止 agent，停止 exec，移除条目。 */
  removeExec(storeId: string, sessionId: number): void;

  // ── Agent 工厂（每面板）──
  setAgentFactory(storeId: string, fn: AgentFactory | null): void;
  getAgentFactory(storeId: string): AgentFactory | null;

  // ── 轮次对（每面板）──
  getTurnPairs(storeId: string): TurnPair[];
  setTurnPairs(storeId: string, pairs: TurnPair[]): void;

    // ── 批量操作 ──
  /** 移除并 dispose 面板的所有 agent 句柄，清除 exec 状态。 */
  clearPanelState(storeId: string): void;

  /** 遍历所有活跃会话的 agent 句柄（运行时更新用，如思考策略切换）。 */
  forEachAgent(fn: (handle: OwnedAgentHandle) => void): void;

  // ── 订阅 ──
  /** 订阅状态变更。返回取消订阅函数。 */
  subscribe(fn: () => void): () => void;
  /** 当前版本计数器。 */
  readonly version: number;
}

// ── 键辅助函数 ──

function agentKey(storeId: string, sid: number): string {
  return `${storeId}:${sid}`;
}

// ── 工厂 ──

export function createAgentSessionState(): AgentSessionStateApi {
  const store = createStore<AgentSessionStoreState>(() => ({
    version: 0,
  }));

  // ── 非序列化可变状态（闭包）──
  const _agentBySession = new Map<string, OwnedAgentHandle>();
  const _execBySession = new Map<string, ExecStateInstance>();
  const _agentFactoryByPanel = new Map<string, AgentFactory>();
  const _turnPairsByPanel = new Map<string, TurnPair[]>();

  function _bump(): void {
    store.setState({ version: store.getState().version + 1 });
  }

  const self: AgentSessionStateApi = {
    // ── Agent 句柄 ──

    setAgent(storeId, sessionId, agent): void {
      const k = agentKey(storeId, sessionId);
      // 覆盖即接管：旧句柄若无人 dispose 会成为 runtime 注册表里的孤儿
      // （拓扑面板堆积的根因）。同一对象重复登记则跳过。
      const prev = _agentBySession.get(k);
      if (prev && prev !== agent) prev.dispose();
      _agentBySession.set(k, agent);
      _bump();
    },

    getAgent(storeId, sessionId): ChatAgentHandle | null {
      return _agentBySession.get(agentKey(storeId, sessionId)) ?? null;
    },

    removeAgent(storeId, sessionId): void {
      const k = agentKey(storeId, sessionId);
      const agent = _agentBySession.get(k);
      if (agent) {
        agent.dispose();
        _agentBySession.delete(k);
      }
      _bump();
    },

    // ── Exec 状态 ──

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

    // ── Agent 工厂 ──

    setAgentFactory(storeId, fn): void {
      if (fn) _agentFactoryByPanel.set(storeId, fn);
      else _agentFactoryByPanel.delete(storeId);
      _bump();
    },

    getAgentFactory(storeId): AgentFactory | null {
      return _agentFactoryByPanel.get(storeId) ?? null;
    },

    // ── 轮次对 ──

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

    // ── 批量操作 ──

    clearPanelState(storeId): void {
      const prefix = storeId + ':';
      for (const k of [..._agentBySession.keys()]) {
        if (k.startsWith(prefix)) {
          _agentBySession.get(k)?.dispose();
          _agentBySession.delete(k);
        }
      }
      for (const k of [..._execBySession.keys()]) {
        if (k.startsWith(prefix)) _execBySession.delete(k);
      }
      _bump();
    },

    forEachAgent(fn): void {
      for (const h of _agentBySession.values()) fn(h);
    },

    // ── 订阅 ──

    subscribe(fn): () => void {
      return store.subscribe(fn);
    },

    get version(): number {
      return store.getState().version;
    },
  };

  return self;
}

// ── 默认单例 — 跨所有面板共享 ──

export const agentSessionState = createAgentSessionState();