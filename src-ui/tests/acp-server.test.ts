// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ACP server 测试 — 用内存行 I/O 驱动 fake Agent，验证
// initialize / session/new / session/prompt(流式) / session/cancel 全流程。

import { describe, expect, it } from 'vitest';
import type { AcpLineIO } from '../src/agent/acp/server';
import { createAcpServer } from '../src/agent/acp/server';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';

function memoryIO(input: string[]): { io: AcpLineIO; out: string[] } {
  const out: string[] = [];
  let idx = 0;
  const result: AcpLineIO = {
    async readLine() {
      return idx < input.length ? (input[idx++] ?? null) : null;
    },
    writeLine(line: string) {
      out.push(line);
    },
  };
  return { io: result, out };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AcpServer', () => {
  it('initialize returns protocol + capabilities', async () => {
    const { io, out } = memoryIO([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })]);
    const renderer = {
      create: (): any => {
        throw new Error('should not be called');
      },
    };
    const srv = createAcpServer({ io, renderer });
    await srv.run();
    const resp = JSON.parse(out[0]);
    expect(resp.result.protocolVersion).toBeTruthy();
    expect(resp.result.capabilities.sessions).toBeDefined();
    expect(resp.result.serverInfo.name).toBe('hologram-acp');
  });

  it('session/new + session/prompt streams chunks and ends turn', async () => {
    const inputs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'sess1', prompt: { text: 'hi' }, messageId: 'm1' },
      }),
    ];
    const { io, out } = memoryIO(inputs);
    const renderer = {
      create(opts: { onEvent: (ev: AgentEvent) => void }) {
        const agent = {
          id: 'sess1',
          isRunning: false,
          run: async (_signal: AbortSignal, input: string) => {
            agent.isRunning = true;
            opts.onEvent({ kind: EventKind.Text, text: 'hello ' });
            opts.onEvent({ kind: EventKind.Text, text: input });
            opts.onEvent({ kind: EventKind.Message, text: 'hello ' + input });
            agent.isRunning = false;
          },
        };
        return { agent, dispose: async () => {} };
      },
    };
    const srv = createAcpServer({ io, renderer });
    await srv.run();
    await sleep(10);

    const updates = out.filter((l) => l.includes('session/update')).map((l) => JSON.parse(l));
    const chunks = updates.filter((u) => u.params.update.type === 'agent_message_chunk');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].params.update.delta.text).toBe('hello ');
    const msg = updates.find((u) => u.params.update.type === 'agent_message');
    expect(msg).toBeDefined();
    expect(msg.params.update.message.content.text).toBe('hello hi');
    const finished = updates.find((u) => u.params.update.type === 'turn_finished');
    expect(finished).toBeDefined();
    expect(finished.params.update.stop_reason).toBe('end_turn');
  });

  it('session/cancel aborts an in-flight prompt', async () => {
    const inputs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 's1', prompt: { text: 'slow' }, messageId: 'm1' },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId: 's1' } }),
    ];
    const { io, out } = memoryIO(inputs);
    const renderer = {
      create(opts: { onEvent: (ev: AgentEvent) => void }) {
        const agent = {
          id: 's1',
          isRunning: false,
          run: async (signal: AbortSignal) => {
            agent.isRunning = true;
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) {
                reject(new Error('aborted'));
                return;
              }
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
            agent.isRunning = false;
          },
        };
        void opts.onEvent;
        return { agent, dispose: async () => {} };
      },
    };
    const srv = createAcpServer({ io, renderer });
    await srv.run();
    await sleep(20);
    const finished = out
      .filter((l) => l.includes('turn_finished'))
      .map((l) => JSON.parse(l))
      .find((u) => u.params.update.stop_reason === 'cancel');
    expect(finished).toBeDefined();
  });
});
