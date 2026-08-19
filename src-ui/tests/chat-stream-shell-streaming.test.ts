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
  CHAT_MODES: [{ id: 'general', label: '通用', description: '', temperature: 0.7, maxSteps: 50 }],
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

import { EventKind } from '../src/agent/agent-types';
import { msgStoreFor, msgStoreForActive } from '../src/ui/chat-store';
import type { StreamContext } from '../src/ui/chat-stream';
import { renderEvent } from '../src/ui/chat-stream';
import type { AssistantMessage, ChatMessage, MessageId, ToolCallPart } from '../src/ui/message-model';
import { getSessionStore } from '../src/ui/session-store';

const STORE_ID = 'test-panel';
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

function assistantOf(_ctx: StreamContext): AssistantMessage | undefined {
  const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
  return msgs.find((m) => m.role === 'assistant') as AssistantMessage | undefined;
}

function toolPartOf(a: AssistantMessage | undefined): ToolCallPart | undefined {
  return a?.parts.find((p) => p.type === 'tool') as ToolCallPart | undefined;
}

describe('shell 卡片流式输出累积（渲染链路回归）', () => {
  beforeEach(() => {
    _streamingId = null;
    _streamingTargetSid = null;
  });

  it('ToolProgress 块在流式助手消息的 tool part 上顺序累积，ToolResult 终结', () => {
    const ctx = makeCtx();
    ctx.setStreamingTargetSid(SESSION_A);
    renderEvent(ctx, { kind: EventKind.TurnStarted });
    renderEvent(ctx, { kind: EventKind.Text, text: '跑一下测试' });

    // 工具分发（executor addTool 路径，partial: false）
    renderEvent(ctx, {
      kind: EventKind.ToolDispatch,
      tool: {
        id: 'c1',
        name: 'shell',
        args: '{"action":"run","command":"cargo test"}',
        read_only: false,
        partial: false,
      },
    });

    // 流式输出块 — 模拟 shell:output 事件 → execStreamedShell → onProgress → ToolProgress
    for (let i = 1; i <= 5; i++) {
      renderEvent(ctx, {
        kind: EventKind.ToolProgress,
        tool: { id: 'c1', name: 'shell', args: '{}', output: `chunk-${i}\n`, read_only: false },
      });
    }

    let tp = toolPartOf(assistantOf(ctx));
    expect(tp).toBeDefined();
    expect(tp?.status).toBe('running');
    expect(tp?.output).toBe('chunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5\n');

    // 工具结果终结
    renderEvent(ctx, {
      kind: EventKind.ToolResult,
      tool: {
        id: 'c1',
        name: 'shell',
        args: '{}',
        output: '全部输出',
        err: undefined,
        read_only: false,
        truncated: false,
      },
    });
    tp = toolPartOf(assistantOf(ctx));
    expect(tp?.status).toBe('done');
    expect(tp?.output).toBe('全部输出');
  });

  it('跨轮次：下一轮 TurnStarted 终结上一轮卡片，但新工具卡片的流式块仍正常累积', () => {
    const ctx = makeCtx();
    ctx.setStreamingTargetSid(SESSION_A);
    renderEvent(ctx, { kind: EventKind.TurnStarted });
    renderEvent(ctx, {
      kind: EventKind.ToolDispatch,
      tool: { id: 'c1', name: 'shell', args: '{}', read_only: false, partial: false },
    });
    renderEvent(ctx, {
      kind: EventKind.ToolProgress,
      tool: { id: 'c1', name: 'shell', args: '{}', output: 'p1\n', read_only: false },
    });

    // 第二轮开始 — 终结第一轮
    renderEvent(ctx, { kind: EventKind.TurnStarted });
    const a = assistantOf(ctx);
    const firstTool = toolPartOf(a);
    // finalise 语义：仍 running 的工具卡片被标 error（取消/中断路径的终态标记）。
    // 正常流下 awaitRemaining 会阻塞到工具完成，跨轮次时工具早已 done，不会走到这里。
    expect(firstTool?.status).toBe('error');

    // 第二轮的工具事件
    renderEvent(ctx, {
      kind: EventKind.ToolDispatch,
      tool: { id: 'c2', name: 'shell', args: '{}', read_only: false, partial: false },
    });
    renderEvent(ctx, {
      kind: EventKind.ToolProgress,
      tool: { id: 'c2', name: 'shell', args: '{}', output: 'q1\n', read_only: false },
    });
    renderEvent(ctx, {
      kind: EventKind.ToolProgress,
      tool: { id: 'c2', name: 'shell', args: '{}', output: 'q2\n', read_only: false },
    });

    const msgs = msgStoreFor(STORE_ID, SESSION_A).getState().messages;
    const assistants = msgs.filter((m) => m.role === 'assistant') as AssistantMessage[];
    expect(assistants.length).toBe(2);
    const secondTool = assistants[1].parts.find((p) => p.type === 'tool') as ToolCallPart;
    expect(secondTool).toBeDefined();
    expect(secondTool.status).toBe('running');
    expect(secondTool.output).toBe('q1\nq2\n');
  });
});
