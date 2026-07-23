// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for AgentSessionState — the store that replaced the four
// module-level Maps in chat-session.ts.

import { describe, expect, it, beforeEach } from 'vitest';

import { createAgentSessionState, type AgentSessionStateApi } from '../src/agent/agent-session-state';

// ── Mock ChatAgentHandle — minimal shape for testing ──
function mockAgent(cascadeAbort: () => void = () => {}): any {
  return { cascadeAbort };
}

function mockExec(running = false): any {
  let _running = running;
  return {
    isRunning: _running,
    isBusy: _running,
    stop: () => { _running = false; },
  };
}

describe('AgentSessionState', () => {
  let state: AgentSessionStateApi;

  beforeEach(() => {
    state = createAgentSessionState();
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent handles
  // ═══════════════════════════════════════════════════════════════

  describe('agent handles', () => {
    it('setAgent / getAgent round-trip', () => {
      const agent = mockAgent();
      state.setAgent('panel-1', 1, agent);
      expect(state.getAgent('panel-1', 1)).toBe(agent);
    });

    it('getAgent returns null for unknown session', () => {
      expect(state.getAgent('panel-1', 999)).toBeNull();
    });

    it('removeAgent deletes the handle', () => {
      const agent = mockAgent();
      state.setAgent('panel-1', 1, agent);
      state.removeAgent('panel-1', 1);
      expect(state.getAgent('panel-1', 1)).toBeNull();
    });

    it('composite key isolates panels with same session ID', () => {
      const agentA = mockAgent();
      const agentB = mockAgent();
      state.setAgent('panel-A', 1, agentA);
      state.setAgent('panel-B', 1, agentB);
      expect(state.getAgent('panel-A', 1)).toBe(agentA);
      expect(state.getAgent('panel-B', 1)).toBe(agentB);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Exec state
  // ═══════════════════════════════════════════════════════════════

  describe('exec state', () => {
    it('getOrCreateExec creates on first access', () => {
      const es = state.getOrCreateExec('panel-1', 1);
      expect(es).toBeDefined();
      expect(es.isRunning).toBe(false);
    });

    it('getOrCreateExec returns same instance on second access', () => {
      const es1 = state.getOrCreateExec('panel-1', 1);
      const es2 = state.getOrCreateExec('panel-1', 1);
      expect(es1).toBe(es2);
    });

    it('getExec returns null for unknown session', () => {
      expect(state.getExec('panel-1', 999)).toBeNull();
    });

    it('removeExec cascade-aborts agent and stops exec', () => {
      let aborted = false;
      const agent = mockAgent(() => { aborted = true; });
      state.setAgent('panel-1', 1, agent);
      state.setExec('panel-1', 1, mockExec(true) as any);
      state.removeExec('panel-1', 1);
      expect(aborted).toBe(true);
      expect(state.getExec('panel-1', 1)).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent factory
  // ═══════════════════════════════════════════════════════════════

  describe('agent factory', () => {
    it('setAgentFactory / getAgentFactory round-trip', async () => {
      const factory = async () => mockAgent() as any;
      state.setAgentFactory('panel-1', factory);
      expect(state.getAgentFactory('panel-1')).toBe(factory);
    });

    it('getAgentFactory returns null when not set', () => {
      expect(state.getAgentFactory('unknown')).toBeNull();
    });

    it('setAgentFactory(null) removes the factory', () => {
      const factory = async () => mockAgent() as any;
      state.setAgentFactory('panel-1', factory);
      state.setAgentFactory('panel-1', null);
      expect(state.getAgentFactory('panel-1')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Turn pairs
  // ═══════════════════════════════════════════════════════════════

  describe('turn pairs', () => {
    it('getTurnPairs returns empty array on first access', () => {
      expect(state.getTurnPairs('panel-1')).toEqual([]);
    });

    it('getTurnPairs returns same array reference (mutatable)', () => {
      const tp = state.getTurnPairs('panel-1');
      tp.push({ userText: 'hello', userBubble: null, assistantBubble: null, sessionIndex: 0 });
      expect(state.getTurnPairs('panel-1')).toHaveLength(1);
    });

    it('setTurnPairs replaces the array', () => {
      const pairs = [
        { userText: 'test', userBubble: null, assistantBubble: null, sessionIndex: 5 },
      ];
      state.setTurnPairs('panel-1', pairs);
      expect(state.getTurnPairs('panel-1')).toBe(pairs);
    });

    it('panels are isolated', () => {
      state.getTurnPairs('panel-A').push({ userText: 'A', userBubble: null, assistantBubble: null, sessionIndex: 0 });
      state.getTurnPairs('panel-B').push({ userText: 'B', userBubble: null, assistantBubble: null, sessionIndex: 0 });
      expect(state.getTurnPairs('panel-A')).toHaveLength(1);
      expect(state.getTurnPairs('panel-A')[0].userText).toBe('A');
      expect(state.getTurnPairs('panel-B')[0].userText).toBe('B');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // clearPanelState
  // ═══════════════════════════════════════════════════════════════

  describe('clearPanelState', () => {
    it('removes all agent handles and exec states for a panel', () => {
      state.setAgent('panel-1', 1, mockAgent());
      state.setAgent('panel-1', 2, mockAgent());
      state.setAgent('panel-2', 1, mockAgent());
      state.getOrCreateExec('panel-1', 1);
      state.getOrCreateExec('panel-1', 2);
      state.getOrCreateExec('panel-2', 1);

      state.clearPanelState('panel-1');

      expect(state.getAgent('panel-1', 1)).toBeNull();
      expect(state.getAgent('panel-1', 2)).toBeNull();
      expect(state.getExec('panel-1', 1)).toBeNull();
      expect(state.getExec('panel-1', 2)).toBeNull();
      // panel-2 untouched
      expect(state.getAgent('panel-2', 1)).not.toBeNull();
      expect(state.getExec('panel-2', 1)).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Subscription / version
  // ═══════════════════════════════════════════════════════════════

  describe('subscription', () => {
    it('subscribe fires on state mutation', () => {
      let fired = 0;
      state.subscribe(() => { fired++; });
      state.setAgent('panel-1', 1, mockAgent());
      expect(fired).toBe(1);
    });

    it('version increments on mutation', () => {
      const v0 = state.version;
      state.setAgent('panel-1', 1, mockAgent());
      expect(state.version).toBeGreaterThan(v0);
    });

    it('unsubscribe stops notifications', () => {
      let fired = 0;
      const unsub = state.subscribe(() => { fired++; });
      state.setAgent('panel-1', 1, mockAgent());
      const firedAfterFirst = fired;
      unsub();
      state.setAgent('panel-1', 2, mockAgent());
      expect(fired).toBe(firedAfterFirst);
    });
  });
});
