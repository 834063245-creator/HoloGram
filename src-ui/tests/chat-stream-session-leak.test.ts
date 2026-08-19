import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));
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
  CHAT_MODES: [{ id: 'general', label: '閫氱敤', description: '', temperature: 0.7, maxSteps: 50 }],
}));
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return {
    default: {
      set: vi.fn(),
      to: vi.fn(tween),
      from: vi.fn(tween),
      fromTo: vi.fn(tween),
      killTweensOf: vi.fn(),
      isTweening: vi.fn(() => false),
      utils: { toArray: vi.fn(() => []) },
    },
    gsap: { set: vi.fn() },
  };
});

import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { getSessionStore } from '../src/state/session-store';
import { msgStoreFor, msgStoreForActive } from '../src/ui/chat-store';
import type { StreamContext } from '../src/ui/chat-stream';
import { addNotice, appendUserBubble, finishTurn, renderEvent } from '../src/ui/chat-stream';
import type { AssistantMessage, ChatMessage, MessageId } from '../src/ui/message-model';

const STORE_ID = 'test-panel';
const SESSION_A = 1;
const SESSION_B = 2;

function setupSessions(activeSession: number = SESSION_A) {
  getSessionStore(STORE_ID).setState({
    sessions: [
      { id: SESSION_A, label: '浼氳瘽 A' },
      { id: SESSION_B, label: '浼氳瘽 B' },
    ],
    activeIdx: activeSession === SESSION_A ? 0 : 1,
    sessionTokens: {},
    nextSessionId: 3,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
  msgStoreFor(STORE_ID, SESSION_B).getState().setMessages([]);
}

let _streamingId: MessageId | null = null;
let _streamingTargetSid: number | null = null;

function makeCtx(activeSession: number = SESSION_A): StreamContext {
  setupSessions(activeSession);
  return {
    storeId: STORE_ID,
    getSessionMessages: (sid: number) => msgStoreFor(STORE_ID, sid).getState().messages,
    getActiveMessages: () => msgStoreForActive(STORE_ID)?.getState().messages ?? [],
    setSessionMessages: (sid: number, msgs: ChatMessage[]) => {
      msgStoreFor(STORE_ID, sid).getState().setMessages(msgs);
    },
    bumpSessionMessages: (sid: number) => {
      msgStoreFor(STORE_ID, sid).getState().bump();
    },
    getStreamingAssistantId: (() => _streamingId) as () => MessageId | null,
    setStreamingAssistantId: ((id: MessageId | null) => {
      _streamingId = id;
    }) as (id: MessageId | null) => void,
    getStreamingTargetSid: () => _streamingTargetSid,
    setStreamingTargetSid: (sid: number | null) => {
      _streamingTargetSid = sid;
    },
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
    scheduleAutoSave: vi.fn(),
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

function textEvent(text: string): AgentEvent {
  return { kind: EventKind.Text, text } as AgentEvent;
}
function turnStartedEvent(): AgentEvent {
  return { kind: EventKind.TurnStarted } as AgentEvent;
}

describe('cross-session streaming leak regression', () => {
  beforeEach(() => {
    _streamingId = null;
    _streamingTargetSid = null;
    getSessionStore(STORE_ID).setState({
      sessions: [],
      activeIdx: -1,
      sessionTokens: {},
      nextSessionId: 1,
      msgIdSeq: 0,
    });
  });

  it('streaming routes to pending session after TurnStarted + tab switch', () => {
    const ctx = makeCtx(SESSION_A);
    ctx.setStreamingTargetSid(SESSION_A);
    appendUserBubble(ctx, 'hello from session A');
    renderEvent(ctx, turnStartedEvent());

    // User switches to session B
    getSessionStore(STORE_ID).setState({ activeIdx: 1 });

    // Text event arrives AFTER tab switch 鈥?must route to pending session A
    renderEvent(ctx, textEvent('Hello!'));

    const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const msgsB = msgStoreFor(STORE_ID, SESSION_B).getState().messages;

    expect(msgsA.length).toBe(2);
    expect(msgsA[0].role).toBe('user');
    expect(msgsA[1].role).toBe('assistant');
    expect(msgsB.length).toBe(0);
  });

  it('subsequent events route via assistant ID after first event establishes it', () => {
    const ctx = makeCtx(SESSION_A);
    ctx.setStreamingTargetSid(SESSION_A);
    appendUserBubble(ctx, 'hello');
    renderEvent(ctx, textEvent('First chunk'));

    // Switch to B, second event must find assistant in session A's store
    getSessionStore(STORE_ID).setState({ activeIdx: 1 });
    renderEvent(ctx, textEvent('Second chunk'));

    const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const msgsB = msgStoreFor(STORE_ID, SESSION_B).getState().messages;

    expect(msgsA.length).toBe(2);
    expect(msgsB.length).toBe(0);
  });

  it('falls back to active session when no pending and no assistant', () => {
    const ctx = makeCtx(SESSION_A);
    appendUserBubble(ctx, 'user msg');
    renderEvent(ctx, textEvent('assistant response'));

    const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    expect(msgsA.length).toBe(2);
  });

  it('routes notice to pending session after tab switch', () => {
    const ctx = makeCtx(SESSION_A);
    ctx.setStreamingTargetSid(SESSION_A);
    getSessionStore(STORE_ID).setState({ activeIdx: 1 });
    addNotice(ctx, 'notice during streaming');

    const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const msgsB = msgStoreFor(STORE_ID, SESSION_B).getState().messages;

    expect(msgsA.length).toBe(1);
    expect(msgsA[0].role).toBe('notice');
    expect(msgsB.length).toBe(0);
  });

  it('finishes turn in the correct session', () => {
    const ctx = makeCtx(SESSION_A);
    ctx.setStreamingTargetSid(SESSION_A);
    appendUserBubble(ctx, 'hello');
    renderEvent(ctx, textEvent('response'));
    finishTurn(ctx);

    const msgsA = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    expect(msgsA.length).toBe(2);
    expect((msgsA[1] as AssistantMessage).status).toBe('done');
  });
});
