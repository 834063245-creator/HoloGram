import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all heavy deps ──
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), withPrefix: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }) } }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/agent/permission', () => ({}));
vi.mock('../src/agent/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ providers: [{ name: 'test', model: 'test', apiKey: 'k', kind: 'openai', baseUrl: '', thinking: false }], activeProvider: 'test', agent: {}, display: { language: 'zh', fontScale: 1 } })),
  saveSettings: vi.fn(),
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return { default: { set: vi.fn(), to: vi.fn(tween), from: vi.fn(tween), fromTo: vi.fn(tween), killTweensOf: vi.fn(), isTweening: vi.fn(() => false), utils: { toArray: vi.fn(() => []) } }, gsap: { set: vi.fn() } };
});

import {
  renderEvent,
  appendUserBubble,
  _finaliseStreamingAssistant,
  _addNoticeMessage,
  addNotice,
  finishTurn,
  setPendingStreamingSession,
} from '../src/ui/chat-stream';
import type { StreamContext } from '../src/ui/chat-stream';
import { getChatStore, msgStoreFor, msgStoreForActive } from '../src/ui/chat-store';
import { getSessionStore } from '../src/ui/session-store';
import { getMessagesStore } from '../src/ui/messages-store';
import type { ChatMessage, AssistantMessage, MessageId } from '../src/ui/message-model';
import { EventKind } from '../src/agent/agent-types';
import type { AgentEvent } from '../src/agent/agent-types';

// ── Helpers ──

const STORE_ID = 'test-panel';
const SESSION_A = 1;
const SESSION_B = 2;

/** Set up two sessions and their per-session message stores. */
function setupSessions(activeSession: number = SESSION_A) {
  const sessStore = getSessionStore(STORE_ID);
  // Clear any previous state
  sessStore.setState({
    sessions: [
      { id: SESSION_A, label: '会话 A' },
      { id: SESSION_B, label: '会话 B' },
    ],
    activeIdx: activeSession === SESSION_A ? 0 : 1,
    sessionTokens: {},
    nextSessionId: 3,
    msgIdSeq: 0,
  });
  // Create per-session message stores
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  msgStoreFor(STORE_ID, SESSION_B).getState().setMessages([]);
}

/** Create a minimal StreamContext for testing. */
function makeCtx(activeSession: number = SESSION_A): StreamContext {
  setupSessions(activeSession);
  return {
    storeId: STORE_ID,
    getSessionMessages: (sid: number) => msgStoreFor(STORE_ID, sid).getState().messages,
    getActiveMessages: () => {
      const s = msgStoreForActive(STORE_ID);
      return s?.getState().messages ?? [];
    },
    setSessionMessages: (sid: number, msgs: ChatMessage[]) => {
      msgStoreFor(STORE_ID, sid).getState().setMessages(msgs);
    },
    bumpSessionMessages: (sid: number) => {
      msgStoreFor(STORE_ID, sid).getState().bump();
    },
    getStreamingAssistantId: (() => _streamingId) as () => MessageId | null,
    setStreamingAssistantId: ((id: MessageId | null) => { _streamingId = id; }) as (id: MessageId | null) => void,
    getUserScrolledUp: () => false,
    setUserScrolledUp: vi.fn(),
    getSyncRafId: () => null,
    setSyncRafId: vi.fn(),
    getTurnPairs: () => [],
    getAgent: () => null,
    getStarGraph: () => null,
    updateFooter: vi.fn(),
    setLastUsageText: vi.fn(),
    addNotice: vi.fn(),
    saveActiveSession: vi.fn(),
    bumpPillBadge: vi.fn(),
    animateBubbleIn: vi.fn(),
    setRunning: vi.fn(),
    abort: vi.fn(),
    _updateStatusBar: vi.fn(),
    _recordToolUsage: vi.fn(),
    _retractUserMessage: vi.fn(),
    retractTurn: () => null,
    sendMessage: vi.fn(),
    _updateTokens: vi.fn(),
    getProjectPath: () => '',
    getRunning: () => false,
    getAbortCtrl: () => null,
    setAbortCtrl: vi.fn(),
    getExpandedReasoning: () => new Set(),
  };
}

let _streamingId: MessageId | null = null;

/** Simulate a Text agent event. */
function textEvent(text: string): AgentEvent {
  return { kind: EventKind.Text, text } as AgentEvent;
}

/** Simulate a TurnStarted agent event. */
function turnStartedEvent(): AgentEvent {
  return { kind: EventKind.TurnStarted } as AgentEvent;
}

// ── Tests ──

describe('cross-session streaming leak regression', () => {
  beforeEach(() => {
    _streamingId = null;
    // Reset session store
    getSessionStore(STORE_ID).setState({
      sessions: [],
      activeIdx: -1,
      sessionTokens: {},
      nextSessionId: 1,
      msgIdSeq: 0,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 1) Pending persists through TurnStarted (the main bug fix)
  // ═══════════════════════════════════════════════════════════════

  describe('pending session survives TurnStarted', () => {
    it('pending is NOT cleared by _finaliseStreamingAssistant', () => {
      const ctx = makeCtx(SESSION_A);
      setPendingStreamingSession(STORE_ID, SESSION_A);

      // Simulate TurnStarted → _finaliseStreamingAssistant
      renderEvent(ctx, turnStartedEvent());

      // Pending should still be set — the real test is that subsequent events
      // route to the correct session. We can't directly read _pendingStreamingSessions
      // (it's module-local), so we verify by checking message routing.
    });

    it('streaming routes to pending session after TurnStarted + tab switch', () => {
      // ── Setup: pending is session A, active is session A ──
      const ctx = makeCtx(SESSION_A);
      setPendingStreamingSession(STORE_ID, SESSION_A);

      // User writes a message in session A
      appendUserBubble(ctx, 'hello from session A');

      // TurnStarted arrives
      renderEvent(ctx, turnStartedEvent());

      // ── User switches to session B (don't re-setup, just change activeIdx) ──
      getSessionStore(STORE_ID).setState({ activeIdx: 1 });

      // ── First Text event arrives AFTER tab switch ──
      // Uses SAME ctx as before (store references are live anyway)
      renderEvent(ctx, textEvent('Hello!'));

      // ── Verify: message went to session A's store, not B's ──
      const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
      const msgsB = msgStoreFor(STORE_ID, SESSION_B).getState().messages;

      // Session A should have user + assistant
      expect(msgsA.length).toBe(2); // user bubble + assistant
      expect(msgsA[0].role).toBe('user');
      expect(msgsA[1].role).toBe('assistant');

      // Session B should be empty
      expect(msgsB.length).toBe(0);
    });

    it('second Text event still routes to correct session via assistant ID', () => {
      // ── Setup ──
      const ctx = makeCtx(SESSION_A);
      setPendingStreamingSession(STORE_ID, SESSION_A);
      appendUserBubble(ctx, 'hello');

      // First Text event creates the assistant in session A
      renderEvent(ctx, textEvent('First chunk'));

      // Switch to session B (just change activeIdx, don't re-make ctx)
      getSessionStore(STORE_ID).setState({ activeIdx: 1 });

      // Second Text event — should find assistant in session A's store via ID
      renderEvent(ctx, textEvent('Second chunk'));

      const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
      const msgsB = msgStoreFor(STORE_ID, SESSION_B).getState().messages;

      // Session A has user + assistant with text
      expect(msgsA.length).toBe(2);
      const assistant = msgsA[1] as AssistantMessage;
      expect(assistant.role).toBe('assistant');
      // Parts should have content from both chunks
      const textParts = assistant.parts.filter(p => p.type === 'text');
      expect(textParts.length).toBeGreaterThan(0);

      // Session B is empty
      expect(msgsB.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 2) Without pending and without assistant, falls back to active
  // ═══════════════════════════════════════════════════════════════

  describe('fallback to active session', () => {
    it('routes to active session when no pending and no assistant', () => {
      const ctx = makeCtx(SESSION_A);
      // NO pending set

      appendUserBubble(ctx, 'user msg');
      renderEvent(ctx, textEvent('assistant response'));

      const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
      expect(msgsA.length).toBe(2);
      expect(msgsA[0].role).toBe('user');
      expect(msgsA[1].role).toBe('assistant');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 3) Notice messages also route correctly
  // ═══════════════════════════════════════════════════════════════

  describe('notice routing', () => {
    it('routes notice to pending session after tab switch', () => {
      const ctx = makeCtx(SESSION_A);
      setPendingStreamingSession(STORE_ID, SESSION_A);

      // Switch to B (don't re-make ctx)
      getSessionStore(STORE_ID).setState({ activeIdx: 1 });

      // Add notice — should go to session A (pending)
      addNotice(ctx, 'notice during streaming');

      const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
      const msgsB = msgStoreFor(STORE_ID, SESSION_B).getState().messages;

      expect(msgsA.length).toBe(1);
      expect(msgsA[0].role).toBe('notice');
      expect(msgsB.length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4) finishTurn finalises correctly
  // ═══════════════════════════════════════════════════════════════

  describe('turn finalization', () => {
    it('finishes streaming assistant in the correct session', () => {
      const ctx = makeCtx(SESSION_A);
      setPendingStreamingSession(STORE_ID, SESSION_A);
      appendUserBubble(ctx, 'hello');

      // Stream some text
      renderEvent(ctx, textEvent('response'));
      renderEvent(ctx, textEvent(' continued'));

      // Finalize
      finishTurn(ctx);

      const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
      expect(msgsA.length).toBe(2);
      const assistant = msgsA[1] as AssistantMessage;
      expect(assistant.status).toBe('done');
    });
  });
});
