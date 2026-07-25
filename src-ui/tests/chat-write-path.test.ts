import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));
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
import { rebuildMessagesFromMessages } from '../src/ui/chat-session';
import { msgStoreFor, msgStoreForActive } from '../src/ui/chat-store';
import type { StreamContext } from '../src/ui/chat-stream';
import { appendUserBubble, finishTurn, renderEvent } from '../src/ui/chat-stream';
import type { AssistantMessage, ChatMessage, MessageId, SubAgentPart } from '../src/ui/message-model';
import { getSessionStore } from '../src/ui/session-store';

const STORE_ID = 'test-write-path';
const SESSION_A = 1;

let _streamingId: MessageId | null = null;
let _streamingTargetSid: number | null = null;

function makeCtx(): StreamContext {
  getSessionStore(STORE_ID).setState({
    sessions: [{ id: SESSION_A, label: '会话 A' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 2,
    msgIdSeq: 0,
  });
  msgStoreFor(STORE_ID, SESSION_A).getState().setMessages([]);
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

function assistantMsg(): AssistantMessage {
  const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
  return msgs[msgs.length - 1] as AssistantMessage;
}

function toolDispatchEvent(): AgentEvent {
  return {
    kind: EventKind.ToolDispatch,
    tool: { id: 't1', name: 'read_file', args: '{}', read_only: true },
  } as AgentEvent;
}

function toolResultEvent(): AgentEvent {
  return {
    kind: EventKind.ToolResult,
    tool: { id: 't1', name: 'read_file', output: 'file contents' },
  } as AgentEvent;
}

describe('messages store — single write path (touchMessage)', () => {
  beforeEach(() => {
    _streamingId = null;
    _streamingTargetSid = null;
  });

  it('touchMessage swaps the message reference and bumps version', () => {
    const ctx = makeCtx();
    appendUserBubble(ctx, 'hi');
    const store = msgStoreFor(STORE_ID, SESSION_A);
    const before = store.getState().messages[0];
    const versionBefore = store.getState().version;

    store.getState().touchMessage(before._id);

    const after = store.getState().messages[0];
    expect(after).not.toBe(before);
    expect(after._id).toBe(before._id);
    expect(store.getState().version).toBeGreaterThan(versionBefore);
  });

  it('touchMessageContaining finds the message by part identity', () => {
    const ctx = makeCtx();
    appendUserBubble(ctx, 'hi');
    _streamingTargetSid = SESSION_A;
    renderEvent(ctx, { kind: EventKind.Text, text: 'hello' } as AgentEvent);

    const subPart: SubAgentPart = {
      type: 'subagent',
      agentId: 'a1',
      description: 'sub',
      status: 'running',
      parts: [],
      version: 0,
    };
    // In-place mutation, as subagent-sink does
    assistantMsg().parts.push(subPart);

    const store = msgStoreFor(STORE_ID, SESSION_A);
    const before = assistantMsg();
    store.getState().touchMessageContaining(subPart);

    const after = assistantMsg();
    expect(after).not.toBe(before);
    // The part object itself is NOT copied — sink keeps writing into it
    expect(after.parts[after.parts.length - 1]).toBe(subPart);
  });

  it('touchMessage on unknown id is a no-op', () => {
    makeCtx();
    const store = msgStoreFor(STORE_ID, SESSION_A);
    const msgsBefore = store.getState().messages;
    store.getState().touchMessage('does-not-exist');
    expect(store.getState().messages).toBe(msgsBefore);
  });
});

describe('streaming pipeline — reference swap on every committed mutation', () => {
  beforeEach(() => {
    _streamingId = null;
    _streamingTargetSid = null;
  });

  it('streaming bump swaps the streaming assistant reference (memo sees it)', () => {
    const ctx = makeCtx();
    ctx.setStreamingTargetSid(SESSION_A);
    appendUserBubble(ctx, 'hi');
    renderEvent(ctx, { kind: EventKind.Text, text: 'chunk' } as AgentEvent);
    const refA = assistantMsg();

    // ToolDispatch calls _streamingBump synchronously
    renderEvent(ctx, toolDispatchEvent());
    const refB = assistantMsg();
    expect(refB).not.toBe(refA);
    expect(refB._id).toBe(refA._id);

    renderEvent(ctx, toolResultEvent());
    const refC = assistantMsg();
    expect(refC).not.toBe(refB);
  });

  it('finalize swaps the reference for the streaming→done transition', () => {
    const ctx = makeCtx();
    ctx.setStreamingTargetSid(SESSION_A);
    appendUserBubble(ctx, 'hi');
    renderEvent(ctx, { kind: EventKind.Text, text: 'chunk' } as AgentEvent);
    const streaming = assistantMsg();

    finishTurn(ctx);

    const done = assistantMsg();
    expect(done.status).toBe('done');
    expect(done).not.toBe(streaming);
    expect(done._id).toBe(streaming._id);
  });
});

describe('session rebuild — sub-agent parts survive', () => {
  it('rebuildMessagesFromMessages re-attaches the same SubAgentPart object', () => {
    const ctx = makeCtx();
    ctx.setStreamingTargetSid(SESSION_A);
    appendUserBubble(ctx, 'hi');
    renderEvent(ctx, { kind: EventKind.Text, text: 'answer' } as AgentEvent);

    const subPart: SubAgentPart = {
      type: 'subagent',
      agentId: 'a1',
      description: 'still running',
      status: 'running',
      parts: [],
      version: 0,
    };
    assistantMsg().parts.push(subPart);

    rebuildMessagesFromMessages(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer' },
      ] as never,
      STORE_ID,
      SESSION_A,
    );

    const rebuilt = assistantMsg();
    const subs = rebuilt.parts.filter((p) => p.type === 'subagent');
    expect(subs.length).toBe(1);
    // Same object identity — the live sink is not orphaned
    expect(subs[0]).toBe(subPart);
    expect((subs[0] as SubAgentPart).status).toBe('running');
  });
});
