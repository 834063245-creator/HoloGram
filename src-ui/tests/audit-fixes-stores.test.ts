// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tests for audit fixes #3 (message ID collision), #8 (store disposal),
// #11 (ToolResult clears output on error).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (minimal — these tests touch store-level logic) ──
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/events', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), withPrefix: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }) },
}));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({
    providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }],
    activeProvider: 'test',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  })),
  saveSettings: vi.fn(),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }));
vi.mock('marked', () => ({ marked: { parse: (s: string) => s } }));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

// ═══════════════════════════════════════════════════════════════════
// #3 — Message ID uniqueness: resetMsgIdCounter is a no-op, IDs monotonic
// ═══════════════════════════════════════════════════════════════════

describe('#3 message ID uniqueness across sessions', () => {
  it('resetMsgIdCounter does NOT reset the counter (no-op)', async () => {
    const { nextMsgId, resetMsgIdCounter } = await import('../src/ui/message-model');
    const { getChatStore } = await import('../src/ui/chat-store');

    const storeId = 'id-test-panel';
    // Generate a few IDs
    const id1 = nextMsgId(storeId);
    const id2 = nextMsgId(storeId);
    const id3 = nextMsgId(storeId);

    // Reset — should be a no-op
    resetMsgIdCounter(storeId);

    const id4 = nextMsgId(storeId);

    // id4 should continue the sequence, not restart from m1
    expect(id1).toBe('m1');
    expect(id2).toBe('m2');
    expect(id3).toBe('m3');
    expect(id4).toBe('m4');
  });

  it('two sessions in the same panel get unique IDs', async () => {
    const { nextMsgId, resetMsgIdCounter } = await import('../src/ui/message-model');
    const storeId = 'id-uniqueness-panel';

    // Simulate session 1 creating messages
    const s1_id1 = nextMsgId(storeId);
    const s1_id2 = nextMsgId(storeId);

    // "Reset" for new session — should be no-op
    resetMsgIdCounter(storeId);

    // Session 2 creates messages — must NOT collide with session 1
    const s2_id1 = nextMsgId(storeId);
    const s2_id2 = nextMsgId(storeId);

    const allIds = [s1_id1, s1_id2, s2_id1, s2_id2];
    const unique = new Set(allIds);
    expect(unique.size).toBe(4); // all unique
    expect(s2_id1).not.toBe('m1'); // must not restart
    expect(s2_id1).toBe('m3');
  });

  it('createUserMessage and createAssistantMessage produce unique IDs', async () => {
    const { createUserMessage, createAssistantMessage, resetMsgIdCounter } = await import('../src/ui/message-model');
    const storeId = 'id-factory-panel';

    resetMsgIdCounter(storeId); // no-op
    const u1 = createUserMessage('hello', undefined, 0);
    const a1 = createAssistantMessage(u1._id);
    const u2 = createUserMessage('world', undefined, 1);
    const a2 = createAssistantMessage(u2._id);

    const ids = [u1._id, a1._id, u2._id, a2._id];
    expect(new Set(ids).size).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #8 — Store disposal: disposePanelStores removes all stores for a panel
// ═══════════════════════════════════════════════════════════════════

describe('#8 store disposal', () => {
  it('disposePanelStores removes panel + per-session message stores', async () => {
    const { getMessagesStore } = await import('../src/ui/messages-store');
    const { getSessionStore } = await import('../src/ui/session-store');
    const { getPanelStore } = await import('../src/ui/panel-store');
    const { getInputStore } = await import('../src/ui/input-store');
    const { disposePanelStores } = await import('../src/ui/chat-store');

    const storeId = 'disposal-test-panel';

    // Create stores
    const msgStore = getMessagesStore(`${storeId}:1`);
    const sessStore = getSessionStore(storeId);
    const panelStore = getPanelStore(storeId);
    const inputStore = getInputStore(storeId);

    // They should exist
    expect(msgStore).toBeDefined();
    expect(sessStore).toBeDefined();
    expect(panelStore).toBeDefined();
    expect(inputStore).toBeDefined();

    // Populate some data
    msgStore.getState().setMessages([{ role: 'notice', _id: 'm1', text: 'test', level: 'info' } as any]);

    // Dispose
    disposePanelStores(storeId);

    // After disposal, getMessagesStore should create a NEW instance (not the old one)
    const newMsgStore = getMessagesStore(`${storeId}:1`);
    expect(newMsgStore).not.toBe(msgStore); // different instance
    expect(newMsgStore.getState().messages).toHaveLength(0); // empty — old data gone

    // Session store should also be new
    const newSessStore = getSessionStore(storeId);
    expect(newSessStore).not.toBe(sessStore);
    expect(newSessStore.getState().sessions).toHaveLength(0); // default empty
  });

  it('disposePanelStores does NOT affect other panels', async () => {
    const { getMessagesStore } = await import('../src/ui/messages-store');
    const { disposePanelStores } = await import('../src/ui/chat-store');

    const panelA = 'keep-panel';
    const panelB = 'dispose-panel';

    const storeA = getMessagesStore(`${panelA}:1`);
    storeA.getState().setMessages([{ role: 'notice', _id: 'x', text: 'A', level: 'info' } as any]);

    disposePanelStores(panelB);

    // Panel A should be untouched
    const storeA2 = getMessagesStore(`${panelA}:1`);
    expect(storeA2).toBe(storeA); // same instance — not disposed
    expect(storeA2.getState().messages).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// #11 — ToolResult clears output on error
// ═══════════════════════════════════════════════════════════════════

describe('#11 ToolResult clears output on error', () => {
  it('clears output when tool errors', async () => {
    const { applyEventToParts } = await import('../src/ui/part-mutator');
    const { EventKind } = await import('../src/agent/agent-types');
    type AssistantPart = import('../src/ui/message-model').AssistantPart;

    const parts: AssistantPart[] = [{
      type: 'tool',
      toolId: 't1',
      name: 'read_file',
      args: '{}',
      label: 'read_file',
      readOnly: true,
      status: 'running',
      output: 'partial output line 1\npartial output line 2',
    } as AssistantPart];

    // ToolProgress accumulated some output
    applyEventToParts(parts, {
      kind: EventKind.ToolProgress,
      tool: { id: 't1', name: 'read_file', output: 'more output', read_only: true },
    } as any);

    expect((parts[0] as any).output).toContain('partial');

    // ToolResult with error
    applyEventToParts(parts, {
      kind: EventKind.ToolResult,
      tool: { id: 't1', name: 'read_file', err: 'File not found', read_only: true },
    } as any);

    const tool = parts[0] as any;
    expect(tool.status).toBe('error');
    expect(tool.err).toBe('File not found');
    expect(tool.output).toBeUndefined(); // cleared on error
  });

  it('preserves output when tool succeeds', async () => {
    const { applyEventToParts } = await import('../src/ui/part-mutator');
    const { EventKind } = await import('../src/agent/agent-types');
    type AssistantPart = import('../src/ui/message-model').AssistantPart;

    const parts: AssistantPart[] = [{
      type: 'tool',
      toolId: 't2',
      name: 'search',
      args: '{}',
      label: 'search',
      readOnly: true,
      status: 'running',
      output: 'partial',
    } as AssistantPart];

    // ToolResult success
    applyEventToParts(parts, {
      kind: EventKind.ToolResult,
      tool: { id: 't2', name: 'search', output: 'final result', read_only: true },
    } as any);

    const tool = parts[0] as any;
    expect(tool.status).toBe('done');
    expect(tool.output).toBe('final result');
    expect(tool.err).toBeUndefined();
  });
});
