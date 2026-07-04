import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock bridge ──
vi.mock('../src/bridge', () => ({ invoke: vi.fn(), listen: vi.fn(), isMockMode: () => false }));
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn(), notifyPanelChanged: vi.fn(), wire: vi.fn(), navigateToFile: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({ initLogger: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ providers: [], activeProvider: '', agent: {}, display: { language: 'zh', fontScale: 1 } })),
  saveSettings: vi.fn(), getActiveProvider: vi.fn(() => ({ name: '', apiKey: '', baseUrl: '', model: '', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })), CHAT_MODES: [],
  restoreSecrets: vi.fn((s: any) => s), persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => ({ default: { set: vi.fn(), to: vi.fn(() => ({ kill: vi.fn() })), from: vi.fn(() => ({ kill: vi.fn() })), fromTo: vi.fn(() => ({ kill: vi.fn() })), killTweensOf: vi.fn() } }));

import { ChatPanel } from '../src/ui/chat';

function makePanel(): ChatPanel {
  // Skip constructor's buildDOM — set up msgList manually
  const panel = Object.create(ChatPanel.prototype) as ChatPanel;
  (panel as any).msgList = document.createElement('div');
  (panel as any)._syncRafId = null;
  (panel as any)._syncPending = false;
  (panel as any).messages = [];
  (panel as any)._streamingAssistantId = null;
  (panel as any)._streamTextBuf = '';
  (panel as any)._expandedReasoning = new Set<number>();
  (panel as any).scrollBottom = vi.fn();
  return panel;
}

describe('_syncMessagesToDOM rAF batching', () => {
  let panel: ChatPanel;

  beforeEach(() => { panel = makePanel(); });

  it('batches to rAF when streaming', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any).messages = [{ _id: 'msg-1', role: 'assistant', parts: [], status: 'streaming', tokensUsed: 0 }];
    (panel as any)._syncMessagesToDOM();
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  it('skips if rAF pending', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any)._syncRafId = 42;
    (panel as any)._syncMessagesToDOM();
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('direct when not streaming', () => {
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    (panel as any)._streamingAssistantId = null;
    (panel as any)._syncMessagesToDOM();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('_finaliseStreamingAssistant rAF flush', () => {
  let panel: ChatPanel;

  beforeEach(() => { panel = makePanel(); });

  it('flushes rAF before clearing id', () => {
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any)._syncRafId = 42;
    (panel as any).messages = [{ _id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'hi', finalised: false }], status: 'streaming', tokensUsed: 0 }];
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame');
    (panel as any)._finaliseStreamingAssistant();
    expect(caf).toHaveBeenCalledWith(42);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((panel as any)._streamingAssistantId).toBeNull();
    spy.mockRestore(); caf.mockRestore();
  });

  it('marks assistant done', () => {
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any).messages = [{ _id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'x', finalised: false }], status: 'streaming', tokensUsed: 0 }];
    (panel as any)._finaliseStreamingAssistant();
    expect((panel as any).messages[0].status).toBe('done');
  });

  it('flushes DOM when streaming id is set', () => {
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any).messages = [{ _id: 'msg-1', role: 'assistant', parts: [], status: 'streaming', tokensUsed: 0 }];
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    (panel as any)._finaliseStreamingAssistant();
    // Always flushes when _streamingAssistantId is set — avoids dropped renders
    expect(spy).toHaveBeenCalledTimes(1);
    expect((panel as any)._streamingAssistantId).toBeNull();
    spy.mockRestore();
  });
});

describe('_doSyncMessagesToDOM streaming path', () => {
  let panel: ChatPanel;
  let msgList: HTMLElement;

  beforeEach(() => {
    panel = makePanel();
    msgList = (panel as any).msgList;
  });

  it('preserves permission cards across replaceWith', () => {
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any).messages = [{ _id: 'msg-1', role: 'assistant', parts: [{ type: 'text', text: 'hello', finalised: false }], status: 'streaming', tokensUsed: 0 }];
    (panel as any)._doSyncMessagesToDOM();

    const el = msgList.children[0] as HTMLElement;
    const card = document.createElement('div'); card.className = 'perm-inline-card';
    card.innerHTML = '<div class="msg-perm-btns"><button>允许</button></div>';
    el.appendChild(card);

    (panel as any).messages[0].parts = [{ type: 'text', text: 'hello world', finalised: false }];
    (panel as any)._doSyncMessagesToDOM();

    expect(msgList.querySelectorAll('.perm-inline-card').length).toBeGreaterThanOrEqual(1);
  });

  it('preserves open reasoning state across replaceWith', () => {
    (panel as any)._streamingAssistantId = 'msg-2';
    (panel as any).messages = [{
      _id: 'msg-2', role: 'assistant',
      parts: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'resp', finalised: false }],
      status: 'streaming', tokensUsed: 0,
    }];
    (panel as any)._doSyncMessagesToDOM();

    const el = msgList.children[0] as HTMLElement;
    el.querySelector('.msg-reasoning-content')?.classList.add('msg-reasoning-open');

    (panel as any).messages[0].parts = [{ type: 'reasoning', text: 'think more' }, { type: 'text', text: 'resp2', finalised: false }];
    (panel as any)._doSyncMessagesToDOM();

    const c = (msgList.children[0] as HTMLElement).querySelector('.msg-reasoning-content');
    expect(c?.classList.contains('msg-reasoning-open')).toBe(true);
  });

  it('renders streaming text', () => {
    (panel as any)._streamingAssistantId = 'msg-3';
    (panel as any).messages = [{ _id: 'msg-3', role: 'assistant', parts: [{ type: 'text', text: 'hello', finalised: false }], status: 'streaming', tokensUsed: 0 }];
    (panel as any)._doSyncMessagesToDOM();
    expect(msgList.children.length).toBe(1);
  });

  it('full rebuild on count mismatch', () => {
    (panel as any)._streamingAssistantId = 'msg-4';
    (panel as any).messages = [{ _id: 'msg-4', role: 'assistant', parts: [{ type: 'text', text: 'a', finalised: false }], status: 'streaming', tokensUsed: 0 }];
    msgList.appendChild(document.createElement('div'));
    (panel as any)._doSyncMessagesToDOM();
    expect(msgList.children.length).toBe(1);
  });
});

describe('event delegation: reasoning toggle', () => {
  it('click toggles class on content', () => {
    const list = document.createElement('div');
    list.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('.msg-reasoning-toggle');
      if (!t) return;
      const c = t.closest('.msg-reasoning')?.querySelector('.msg-reasoning-content');
      if (!c) return;
      c.classList.toggle('msg-reasoning-open');
    });
    const block = document.createElement('div'); block.className = 'msg-reasoning';
    const toggle = document.createElement('button'); toggle.className = 'msg-reasoning-toggle';
    const content = document.createElement('div'); content.className = 'msg-reasoning-content';
    block.append(toggle, content); list.appendChild(block);

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(content.classList.contains('msg-reasoning-open')).toBe(true);
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(content.classList.contains('msg-reasoning-open')).toBe(false);
  });
});

// ── Regression tests: single rAF gate + unconditional flush (ponytail fix) ──

describe('_scheduleSync single rAF gate (no double-buffering)', () => {
  let panel: ChatPanel;

  beforeEach(() => { panel = makePanel(); });

  it('sets both _syncRafId and _syncPending, calls _doSyncMessagesToDOM directly', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(99 as any);
    (panel as any)._scheduleSync();
    // Both gates set atomically
    expect((panel as any)._syncPending).toBe(true);
    expect((panel as any)._syncRafId).toBe(99);
    // Verify the rAF callback calls _doSyncMessagesToDOM directly (not via _syncMessagesToDOM)
    const cb = raf.mock.calls[0][0] as Function;
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    cb();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((panel as any)._syncRafId).toBeNull();
    expect((panel as any)._syncPending).toBe(false);
    spy.mockRestore();
    raf.mockRestore();
  });

  it('skips when _syncPending is true', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    (panel as any)._syncPending = true;
    (panel as any)._scheduleSync();
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('skips when _syncRafId is set (prevents double rAF from different paths)', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    (panel as any)._syncRafId = 42;
    (panel as any)._scheduleSync();
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});

describe('_finaliseStreamingAssistant unconditional flush', () => {
  let panel: ChatPanel;

  beforeEach(() => { panel = makePanel(); });

  it('flushes even when _syncRafId is null (fixes dropped render from _scheduleSync path)', () => {
    // Simulate: text chunk went through _scheduleSync, its rAF already fired
    // (_syncRafId = null, _syncPending = false), but _streamingAssistantId is still set.
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any)._syncRafId = null;
    (panel as any)._syncPending = false;
    (panel as any).messages = [{
      _id: 'msg-1', role: 'assistant',
      parts: [{ type: 'text', text: 'hello', finalised: false }],
      status: 'streaming', tokensUsed: 0,
    }];
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    (panel as any)._finaliseStreamingAssistant();
    // Core fix: must render even though _syncRafId was null
    expect(spy).toHaveBeenCalledTimes(1);
    expect((panel as any)._streamingAssistantId).toBeNull();
    expect((panel as any).messages[0].status).toBe('done');
    spy.mockRestore();
  });

  it('cancels pending _scheduleSync rAF and flushes directly', () => {
    // Simulate: _scheduleSync scheduled an rAF, turn ends before it fires
    (panel as any)._streamingAssistantId = 'msg-2';
    (panel as any)._syncRafId = 99;
    (panel as any)._syncPending = true;
    (panel as any).messages = [{
      _id: 'msg-2', role: 'assistant',
      parts: [{ type: 'text', text: 'world', finalised: false }],
      status: 'streaming', tokensUsed: 0,
    }];
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame');
    (panel as any)._finaliseStreamingAssistant();
    // Must cancel, clear both gates, and render
    expect(caf).toHaveBeenCalledWith(99);
    expect((panel as any)._syncPending).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((panel as any)._streamingAssistantId).toBeNull();
    spy.mockRestore(); caf.mockRestore();
  });

  it('no-op when no streaming assistant (avoids wasted render)', () => {
    (panel as any)._streamingAssistantId = null;
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    (panel as any)._finaliseStreamingAssistant();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('_scheduleSync + _finaliseStreamingAssistant integration (the fix)', () => {
  let panel: ChatPanel;

  beforeEach(() => {
    panel = makePanel();
    // Set up: assistant exists, streaming in progress
    (panel as any)._streamingAssistantId = 'msg-int';
    (panel as any).messages = [{
      _id: 'msg-int', role: 'assistant',
      parts: [{ type: 'text', text: 'partial', finalised: false }],
      status: 'streaming', tokensUsed: 0,
    }];
  });

  it('text → _scheduleSync → turn-end → _finaliseStreamingAssistant renders correctly', () => {
    // Step 1: streaming text chunk arrives, goes through _scheduleSync
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(77 as any);
    (panel as any)._scheduleSync();
    expect((panel as any)._syncPending).toBe(true);
    expect((panel as any)._syncRafId).toBe(77);

    // Step 2: turn ends before rAF fires — _finaliseStreamingAssistant must rescue
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    (panel as any)._finaliseStreamingAssistant();

    // rAF cancelled, both gates cleared, DOM rendered
    expect(caf).toHaveBeenCalledWith(77);
    expect((panel as any)._syncRafId).toBeNull();
    expect((panel as any)._syncPending).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((panel as any)._streamingAssistantId).toBeNull();
    expect((panel as any).messages[0].status).toBe('done');

    spy.mockRestore(); caf.mockRestore(); raf.mockRestore();
  });

  it('multiple _scheduleSync calls batched, then turn-end flushes once', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(88 as any);

    // First scheduleSync call
    (panel as any)._scheduleSync();
    expect(raf).toHaveBeenCalledTimes(1);

    // Second _scheduleSync call — gate closed, no new rAF
    (panel as any)._scheduleSync();
    expect(raf).toHaveBeenCalledTimes(1); // still 1

    // Turn ends
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const spy = vi.spyOn(ChatPanel.prototype, '_doSyncMessagesToDOM' as any).mockImplementation(() => {});
    (panel as any)._finaliseStreamingAssistant();

    expect(caf).toHaveBeenCalledWith(88);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore(); caf.mockRestore(); raf.mockRestore();
  });
});

describe('_syncMessagesToDOM respects _syncPending gate', () => {
  let panel: ChatPanel;

  beforeEach(() => { panel = makePanel(); });

  it('skips when _syncPending is true (_scheduleSync has pending rAF)', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    (panel as any)._streamingAssistantId = 'msg-1';
    (panel as any)._syncPending = true;
    (panel as any)._syncMessagesToDOM();
    // Should not schedule a second rAF — _scheduleSync already has one pending
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});
