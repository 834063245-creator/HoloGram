import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pretext — requires Canvas 2D which jsdom doesn't have
vi.mock('../src/lib/pretext/layout.js', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: vi.fn(() => ({ height: 36, lineCount: 2 })),
  clearCache: vi.fn(),
}));

import { estimateMessageHeight, clearHeightCache, getMessageGap } from '../src/ui/message-height';
import type { AssistantMessage, ChatMessage, NoticeMessage, UserMessage } from '../src/ui/message-model';

function makeUserMessage(text: string): UserMessage {
  return { role: 'user', _id: 'u1', text, sessionIndex: 0 };
}

function makeAssistantMessage(parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: 'a1', parts, status: 'streaming', respondingTo: 'u1' };
}

function makeNoticeMessage(text: string): NoticeMessage {
  return { role: 'notice', _id: 'n1', text, level: 'info' };
}

describe('estimateMessageHeight', () => {
  beforeEach(() => {
    clearHeightCache();
  });

  it('returns a positive number for user messages', () => {
    const msg = makeUserMessage('hello world');
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBeGreaterThan(0);
  });

  it('returns a positive number for empty assistant messages', () => {
    const msg = makeAssistantMessage([]);
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBeGreaterThan(0);
  });

  it('estimates assistant message with text part', () => {
    const msg = makeAssistantMessage([
      { type: 'text', text: 'hello world this is a test', finalised: false },
    ]);
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBeGreaterThan(0);
  });

  it('estimates assistant message with tool part', () => {
    // Done tools render collapsed (output is display:none) → header only.
    const msg = makeAssistantMessage([
      {
        type: 'tool',
        toolId: 't1',
        name: 'read_file',
        args: '{}',
        label: 'Read file',
        readOnly: true,
        status: 'done',
        output: 'file contents here',
      },
    ]);
    const h = estimateMessageHeight(msg, 300);
    // 36 (header) + 20 (bubble padding) + 22 (actions row) = 78
    expect(h).toBe(78);
  });

  it('estimates assistant message with reasoning part', () => {
    const msg = makeAssistantMessage([
      { type: 'reasoning', text: 'thinking about this...' },
    ]);
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBeGreaterThan(0);
  });

  it('estimates notice messages at fixed height', () => {
    const msg = makeNoticeMessage('system notice');
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBe(28);
  });

  it('caches results — same message + width returns same value without re-computing', () => {
    const msg = makeUserMessage('cached message');
    const h1 = estimateMessageHeight(msg, 300);
    const h2 = estimateMessageHeight(msg, 300);
    expect(h1).toBe(h2);
  });

  it('different widths may produce different heights', () => {
    const msg = makeUserMessage('a '.repeat(100).trim());
    const hWide = estimateMessageHeight(msg, 500);
    const hNarrow = estimateMessageHeight(msg, 100);
    // Narrow width should generally produce taller messages (more lines)
    // Pretext is mocked to return 36 regardless, so just check both are positive
    expect(hWide).toBeGreaterThan(0);
    expect(hNarrow).toBeGreaterThan(0);
  });

  it('handles user message with file attachments', () => {
    const msg = makeUserMessage('see attached');
    msg.files = [
      { path: '/a.txt', name: 'a.txt', size: 100 },
      { path: '/b.txt', name: 'b.txt', size: 200 },
    ];
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBeGreaterThan(0);
  });

  it('finalised text parts inflate height for markdown margins', () => {
    const text = 'some text that wraps';
    const streamingMsg = makeAssistantMessage([
      { type: 'text', text, finalised: false },
    ]);
    const finalisedMsg = makeAssistantMessage([
      { type: 'text', text, finalised: true },
    ]);
    const hStreaming = estimateMessageHeight(streamingMsg, 300);
    const hFinalised = estimateMessageHeight(finalisedMsg, 300);
    // Finalised markdown has 1.15× inflation
    expect(hFinalised).toBeGreaterThanOrEqual(hStreaming);
  });

  it('subagent part estimates collapsed (header only) even while running', () => {
    // Sub-agent cards are default-collapsed regardless of status (36f7d6e);
    // children only render when the user expands the card.
    const msg = makeAssistantMessage([
      {
        type: 'subagent',
        agentId: 'sa1',
        description: 'sub task',
        status: 'running',
        version: 0,
        parts: [
          { type: 'text', text: 'sub text', finalised: false },
          { type: 'reasoning', text: 'sub thinking' },
        ],
      },
    ]);
    const h = estimateMessageHeight(msg, 300);
    // 36 (header) + 20 (bubble padding) + 22 (actions row) = 78
    expect(h).toBe(78);
  });

  it('subagent part with done status returns header only', () => {
    const msg = makeAssistantMessage([
      {
        type: 'subagent',
        agentId: 'sa1',
        description: 'sub task',
        status: 'done',
        version: 0,
        parts: [
          { type: 'text', text: 'sub text', finalised: true },
        ],
      },
    ]);
    const h = estimateMessageHeight(msg, 300);
    // 36 (header) + 20 (bubble padding) + 22 (actions row) = 78
    expect(h).toBe(78);
  });

  it('handles tool part with error', () => {
    // Error details render inside the collapsed card → still header only.
    const msg = makeAssistantMessage([
      {
        type: 'tool',
        toolId: 't1',
        name: 'bash',
        args: '{}',
        label: 'Shell',
        readOnly: false,
        status: 'error',
        err: 'command failed',
      },
    ]);
    const h = estimateMessageHeight(msg, 300);
    expect(h).toBe(78);
  });

  it('reasoning estimates collapsed once the message is done', () => {
    // While streaming the block is expanded (measured); after done it
    // auto-collapses to the 32px header.
    const done: AssistantMessage = {
      role: 'assistant',
      _id: 'a2',
      parts: [{ type: 'reasoning', text: 'long reasoning '.repeat(50) }],
      status: 'done',
      respondingTo: 'u1',
    };
    const h = estimateMessageHeight(done, 300);
    // 32 (collapsed header) + 20 (bubble padding) + 22 (actions row) = 74
    expect(h).toBe(74);
  });

  it('estimates plan parts from content + card chrome', () => {
    const msg = makeAssistantMessage([
      {
        type: 'plan',
        planId: 'pl1',
        planFilePath: '/tmp/plan.md',
        content: '# Plan\n\nDo the thing',
        status: 'pending',
      },
    ]);
    const h = estimateMessageHeight(msg, 300);
    // Chrome (64) + measured content + padding/actions — must not be 0-height
    expect(h).toBeGreaterThan(64 + 20 + 22);
  });
});

describe('getMessageGap', () => {
  it('returns 10 (matching chat.css)', () => {
    expect(getMessageGap()).toBe(10);
  });
});

describe('clearHeightCache', () => {
  it('clears the cache so next estimate is fresh', () => {
    const msg = makeUserMessage('test');
    const h1 = estimateMessageHeight(msg, 300);
    clearHeightCache();
    const h2 = estimateMessageHeight(msg, 300);
    // With mock, same value — but cache was definitely cleared
    expect(h2).toBe(h1);
  });
});
