// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for the 15-issue audit fix batch.
// Grouped by concern area, matching existing test conventions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock bridge ──
const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/events', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), withPrefix: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }) },
}));
vi.mock('../src/ui/app-shell', () => ({
  shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() },
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return {
    default: { set: vi.fn(), to: vi.fn(tween), from: vi.fn(tween), fromTo: vi.fn(tween), killTweensOf: vi.fn(), isTweening: vi.fn(() => false), utils: { toArray: vi.fn(() => []) } },
    gsap: { set: vi.fn() },
  };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

// ═══════════════════════════════════════════════════════════════════
// #1 — exportSession uses `filePath` not `path` for write_file_content
// ═══════════════════════════════════════════════════════════════════

describe('#1 exportSession parameter name', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue('ok');
  });

  it('sends file_path (not path) to write_file_content rpc', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const panel = new ChatCore();
    const fakeAgent = {
      getSession: () => [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      dispose: vi.fn(),
    } as any;
    panel.setAgent(fakeAgent);

    // Mock the save dialog to return a file path
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => '/tmp/test.md') }));
    // Re-import to pick up the mock
    vi.resetModules();

    // Call exportSession — we need to invoke it via the panel
    // Since exportSession is internal, we test via the rpc call inspection
    const { exportSession } = await import('../src/ui/chat-session');
    const { getChatStore } = await import('../src/ui/chat-store');
    const storeId = panel.panelId;

    // Ensure agent is set up
    const { agentSessionState } = await import('../src/agent/agent-session-state');
    const { sessions } = getChatStore(storeId).sess.getState();
    if (sessions[0]) {
      agentSessionState.setAgent(storeId, sessions[0].id, fakeAgent);
    }

    // Mock the save dialog at the module level
    const dialogModule = await import('@tauri-apps/plugin-dialog');
    vi.spyOn(dialogModule, 'save').mockResolvedValue('/tmp/test-export.md');

    const ctx: any = {
      storeId,
      panel: document.createElement('div'),
      sessionTabs: document.createElement('div'),
      tabBar: document.createElement('div'),
      getProjectPath: () => '/test',
      flushReasoning: vi.fn(),
      flushText: vi.fn(),
      clearPendingToolCards: vi.fn(),
      getRunning: () => false,
      abort: vi.fn(),
      addNotice: vi.fn(),
      updateFooter: vi.fn(),
      getTotalTokensUsed: () => 100,
      setTotalTokensUsed: vi.fn(),
      clearToolUsage: vi.fn(),
      clearToolHistory: vi.fn(),
      getLastUsageText: () => '',
      setLastUsageText: vi.fn(),
      getLastAgentDiag: () => '',
      clearInputHistory: vi.fn(),
      getStarGraph: () => null,
    };

    await exportSession(ctx);

    // Find the write_file_content rpc call
    const calls = mockInvoke.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'write_file_content',
    );
    expect(calls.length).toBe(1);
    const params = calls[0][1].params;
    // Must have file_path, NOT path
    expect(params).toHaveProperty('file_path');
    expect(params).not.toHaveProperty('path');
    expect(params.file_path).toBe('/tmp/test-export.md');
  });
});

// ═══════════════════════════════════════════════════════════════════
// #10 — scheduleAutoSave uses per-panel timers (no cross-panel clearing)
// ═══════════════════════════════════════════════════════════════════

describe('#10 scheduleAutoSave per-panel isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue('ok');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('panel A timer is NOT cleared when panel B schedules', async () => {
    const { scheduleAutoSave, saveActiveSession } = await import('../src/ui/chat-session');
    const { getChatStore } = await import('../src/ui/chat-store');
    const { agentSessionState } = await import('../src/agent/agent-session-state');

    const storeA = 'panel-A';
    const storeB = 'panel-B';

    // Set up agents so saveActiveSession doesn't bail early
    for (const sid of [storeA, storeB]) {
      const id = 1;
      getChatStore(sid).sess.setState({
        sessions: [{ id, label: 'test' }],
        activeIdx: 0,
        sessionTokens: {},
        nextSessionId: 2,
        msgIdSeq: 0,
      });
      agentSessionState.setAgent(sid, id, {
        getSession: () => [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ],
        dispose: vi.fn(),
      } as any);
    }

    const ctxA: any = {
      storeId: storeA,
      getProjectPath: () => '/a',
      addNotice: vi.fn(),
      updateFooter: vi.fn(),
      getTotalTokensUsed: () => 0,
      setTotalTokensUsed: vi.fn(),
      panel: document.createElement('div'),
      sessionTabs: document.createElement('div'),
      tabBar: document.createElement('div'),
      flushReasoning: vi.fn(),
      flushText: vi.fn(),
      clearPendingToolCards: vi.fn(),
      getRunning: () => false,
      abort: vi.fn(),
      clearToolUsage: vi.fn(),
      clearToolHistory: vi.fn(),
      getLastUsageText: () => '',
      setLastUsageText: vi.fn(),
      getLastAgentDiag: () => '',
      clearInputHistory: vi.fn(),
      getStarGraph: () => null,
    };
    const ctxB: any = { ...ctxA, storeId: storeB };

    // Panel A schedules save
    scheduleAutoSave(ctxA, '/a');
    // Panel B schedules save — should NOT clear panel A's timer
    scheduleAutoSave(ctxB, '/b');

    // Advance time — both timers should fire independently
    await vi.advanceTimersByTimeAsync(600);

    // Both panels should have written to disk (at least the session file)
    const writeCalls = mockInvoke.mock.calls.filter(
      (c: any[]) => c[1]?.method === 'write_file_content',
    );
    // Each panel writes at least 2 files (session + tracker) = 4 total
    expect(writeCalls.length).toBeGreaterThanOrEqual(4);

    // Verify both panels' paths appear in the calls
    const allParams = writeCalls.map((c: any[]) => c[1].params?.file_path || '');
    const hasPanelA = allParams.some((p: string) => p.includes('/a/'));
    const hasPanelB = allParams.some((p: string) => p.includes('/b/'));
    expect(hasPanelA).toBe(true);
    expect(hasPanelB).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #15 — computeCostStr removed (dead code cleanup)
// ═══════════════════════════════════════════════════════════════════

describe('#15 computeCostStr removed', () => {
  it('is no longer exported from chat-utils', async () => {
    const chatUtils = await import('../src/ui/chat-utils');
    expect((chatUtils as any).computeCostStr).toBeUndefined();
  });
});
