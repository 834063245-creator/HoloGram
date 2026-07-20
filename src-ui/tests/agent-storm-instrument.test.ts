// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// RunLoop integration regressions — both call sites were lost in 6e75046
// (pre-StreamingToolExecutor cleanup) and are rewired in Agent.runLoop:
//   1. storm breaker: 3× identical tool failure → [loop guard] nudge in the result
//   2. compaction instrumentation: recordToolCall / recordFileRead feeding the tracker

import { describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { Agent } from '../src/agent/agent';
import type { CompactionEvent } from '../src/agent/compaction-model';
import { type Tool, ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider, Usage } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

const USAGE: Usage = {
  prompt_tokens: 100,
  completion_tokens: 10,
  total_tokens: 110,
  cache_hit_tokens: 0,
  cache_miss_tokens: 100,
  reasoning_tokens: 0,
  finish_reason: 'stop',
};

/** Provider that emits the same failing tool call for the first `failingTurns`
 *  streams, then a plain text answer (ending the loop). */
function makeProvider(failingTurns: number, toolName = 'read_file_content', args = '{"filePath":"/x.ts"}'): Provider {
  let streams = 0;
  return {
    name: () => 'mock',
    stream: (_signal: AbortSignal, _req: unknown) => {
      streams++;
      const n = streams;
      return (async function* (): AsyncGenerator<Chunk> {
        if (n <= failingTurns) {
          yield { type: ChunkType.ToolCall, tool_call: { id: `call-${n}`, name: toolName, arguments: args } };
          yield { type: ChunkType.Usage, usage: USAGE };
          yield { type: ChunkType.Done };
        } else {
          yield { type: ChunkType.Text, text: 'final answer' };
          yield { type: ChunkType.Usage, usage: USAGE };
          yield { type: ChunkType.Done };
        }
      })();
    },
  };
}

function failingTool(name: string): Tool {
  return {
    name: () => name,
    description: () => 'always fails',
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => {
      throw new Error('ENOENT: no such file');
    },
  };
}

function makeAgent(prov: Provider, tools: ToolRegistry): Agent {
  return new Agent(prov, tools, 'test system prompt', {
    eventSink: () => {},
    contextWindow: 0, // no compaction interference
  });
}

describe('runLoop — storm breaker (rewired)', () => {
  it('appends [loop guard] nudge after 3 identical failures', async () => {
    const registry = new ToolRegistry();
    registry.register(failingTool('read_file_content'));
    const agent = makeAgent(makeProvider(3), registry);

    await agent.run(new AbortController().signal, 'go');

    const toolResults = agent.getSession().filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(3);
    expect(toolResults[0].content).not.toContain('[loop guard]');
    expect(toolResults[1].content).not.toContain('[loop guard]');
    expect(toolResults[2].content).toContain('[loop guard]');
    expect(toolResults[2].content).toContain('failed 3 times');
  });

  it('does NOT nudge on the 2nd identical failure', async () => {
    const registry = new ToolRegistry();
    registry.register(failingTool('read_file_content'));
    const agent = makeAgent(makeProvider(2), registry);

    await agent.run(new AbortController().signal, 'go');

    const toolResults = agent.getSession().filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(2);
    expect(toolResults.some((m) => m.content.includes('[loop guard]'))).toBe(false);
  });

  it('a successful call resets the storm counter', async () => {
    let calls = 0;
    const flakyTool: Tool = {
      name: () => 'read_file_content',
      description: () => 'fails, then succeeds, then fails again',
      parameters: () => ({ type: 'object', properties: {} }),
      readOnly: () => true,
      execute: async () => {
        calls++;
        if (calls === 2) return 'file content here'; // success breaks the storm
        throw new Error('ENOENT: no such file');
      },
    };
    const registry = new ToolRegistry();
    registry.register(flakyTool);
    // 3 turns: fail, success, fail — never 3 identical failures in a row
    const agent = makeAgent(makeProvider(3), registry);

    await agent.run(new AbortController().signal, 'go');

    const toolResults = agent.getSession().filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(3);
    expect(toolResults.some((m) => m.content.includes('[loop guard]'))).toBe(false);
  });
});

describe('runLoop — compaction instrumentation (rewired)', () => {
  const stubEvent: CompactionEvent = {
    ts: Date.now(),
    regionMsgCount: 10,
    regionTokensEst: 5000,
    summaryInputTokens: 5000,
    summaryOutputTokens: 500,
    tailMsgCount: 4,
    preTokens: 6000,
    postTokens: 1500,
    outcome: 'summary',
  };

  it('recordToolCall + recordFileRead feed the tracker (duplicate detection)', async () => {
    const registry = new ToolRegistry();
    registry.register(failingTool('read_file_content'));
    const agent = makeAgent(makeProvider(2), registry);

    // Arm post-compaction counters — duplicates/re-reads only count after a compaction.
    agent.getCompactionTracker().recordCompaction(stubEvent);

    await agent.run(new AbortController().signal, 'go');

    const stats = agent.getCompactionStats();
    // Same tool + same args ran twice post-compaction → 1 duplicate;
    // same file read twice → 1 re-read.
    expect(stats.duplicateToolCalls).toBe(1);
    expect(stats.reReadCount).toBe(1);
  });
});
