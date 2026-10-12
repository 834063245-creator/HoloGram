// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// Pre-step 裁决面钉住（agent-hooks-plan 一期）：
//   ① PreStepRegistry 合并语义：enter 注入累积 / 任一 reject 折叠整体 /
//      shouldRun 跳过 / 崩溃与畸形返回值降级 / async decide / disposer；
//   ② loop 行为（default-loop 真跑）：
//      - 未接面（null）= 逐字节零行为变化（事件序回归门）；
//      - enter + 注入批 → 消息落会话（用户消息之后）；
//      - reject → 不开步（无 step/start、无 request）、Notice 可见、turn 收尾。

import { describe, expect, it, vi } from 'vitest';
import { installCompactionForTest } from './helpers/compaction-impl';

// 驱动真 Agent 的循环会进入压缩预检（contextWindow 默认 1M）——复现
// 「装载器已跑过」的压缩实现常驻态（同 agent-loop-events.test.ts 先例）。
installCompactionForTest();

import { EventKind } from '../src/agent/agent-types';
import { type PreStepPayload, PreStepRegistry } from '../src/agent/pre-step';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

function payload(step = 0): PreStepPayload {
  return { agentId: 'test-agent', step, signal: new AbortController().signal };
}

describe('PreStepRegistry — 合并语义', () => {
  it('空注册表 = enter（无 messages 字段）', async () => {
    const reg = new PreStepRegistry();
    expect(await reg.decide(payload())).toEqual({ action: 'enter' });
  });

  it('多 hook 注入按注册序累积', async () => {
    const reg = new PreStepRegistry();
    reg.register({ name: 'a', decide: () => ({ action: 'enter', messages: [{ content: 'A' }] }) });
    reg.register({ name: 'b', decide: () => ({ action: 'enter', messages: [{ content: 'B' }] }) });
    expect(await reg.decide(payload())).toEqual({
      action: 'enter',
      messages: [{ content: 'A' }, { content: 'B' }],
    });
  });

  it('任一 reject ⇒ 整体 reject（reason 取第一个非空、注入批丢弃、全跑不短路）', async () => {
    const reg = new PreStepRegistry();
    const calls: string[] = [];
    reg.register({
      name: 'inject',
      decide: () => {
        calls.push('inject');
        return { action: 'enter', messages: [{ content: 'X' }] };
      },
    });
    reg.register({
      name: 'r1',
      decide: () => {
        calls.push('r1');
        return { action: 'reject' };
      },
    });
    reg.register({
      name: 'r2',
      decide: () => {
        calls.push('r2');
        return { action: 'reject', reason: '理由' };
      },
    });
    reg.register({
      name: 'after',
      decide: () => {
        calls.push('after');
        return { action: 'enter' };
      },
    });
    expect(await reg.decide(payload())).toEqual({ action: 'reject', reason: '理由' });
    expect(calls).toEqual(['inject', 'r1', 'r2', 'after']); // 全跑：后续 hook 仍收到调用（审计友好）
  });

  it('shouldRun=false 跳过本钩子', async () => {
    const reg = new PreStepRegistry();
    const decide = vi.fn(() => ({ action: 'enter' as const }));
    reg.register({ name: 'cond', shouldRun: (p) => p.step === 2, decide });
    await reg.decide(payload(0));
    expect(decide).not.toHaveBeenCalled();
    await reg.decide(payload(2));
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('hook 崩溃降级（不阻断、不否决，后续钩子继续）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = new PreStepRegistry();
    reg.register({
      name: 'crash',
      decide: () => {
        throw new Error('boom');
      },
    });
    reg.register({ name: 'ok', decide: () => ({ action: 'enter', messages: [{ content: 'OK' }] }) });
    expect(await reg.decide(payload())).toEqual({ action: 'enter', messages: [{ content: 'OK' }] });
    errSpy.mockRestore();
  });

  it('畸形返回值视作未投（不静默变 reject）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = new PreStepRegistry();
    reg.register({ name: 'bad', decide: () => ({ action: 'nope' }) as never });
    reg.register({ name: 'ok', decide: () => ({ action: 'enter' }) });
    expect(await reg.decide(payload())).toEqual({ action: 'enter' });
    errSpy.mockRestore();
  });

  it('async decide 支持', async () => {
    const reg = new PreStepRegistry();
    reg.register({ name: 'async', decide: async () => ({ action: 'enter', messages: [{ content: 'ASYNC' }] }) });
    expect(await reg.decide(payload())).toEqual({ action: 'enter', messages: [{ content: 'ASYNC' }] });
  });

  it('register 返回的 disposer 幂等且摘除钩子', async () => {
    const reg = new PreStepRegistry();
    const dispose = reg.register({ name: 'a', decide: () => ({ action: 'enter', messages: [{ content: 'A' }] }) });
    dispose();
    dispose(); // 幂等：二次调用不误伤
    expect(await reg.decide(payload())).toEqual({ action: 'enter' });
  });
});

function fakeProvider(): Provider {
  return {
    name: () => 'mock-provider',
    model: () => 'mock-model',
    stream: async function* (): AsyncGenerator<Chunk> {
      yield { type: ChunkType.Text, text: 'ok' } as Chunk;
      yield { type: ChunkType.Done } as Chunk;
    },
  };
}

describe('default-loop — pre-step 消费', () => {
  it('未接面（null）：事件序逐字不变（回归门）', async () => {
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const order: string[] = [];
    agent.onLoopEvent('turn/start', () => order.push('turn/start'));
    agent.onLoopEvent('step/start', () => order.push('step/start'));
    agent.onLoopEvent('request/start', () => order.push('request/start'));
    agent.onLoopEvent('request/end', () => order.push('request/end'));
    agent.onLoopEvent('step/end', () => order.push('step/end'));
    agent.onLoopEvent('turn/end', () => order.push('turn/end'));

    await agent.run(new AbortController().signal, 'hi');

    expect(order).toEqual(['turn/start', 'step/start', 'request/start', 'request/end', 'step/end', 'turn/end']);
  });

  it('enter + 注入批：消息落会话（位于用户消息之后）', async () => {
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const reg = new PreStepRegistry();
    reg.register({ name: 'inj', decide: () => ({ action: 'enter', messages: [{ content: '[PRE-STEP] 注入' }] }) });
    agent.setPreStep(reg);

    await agent.run(new AbortController().signal, 'hi');

    const session = agent.getSession();
    const idxUser = session.findIndex((m) => m.role === 'user' && m.content === 'hi');
    const idxInject = session.findIndex((m) => m.role === 'user' && m.content === '[PRE-STEP] 注入');
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxInject).toBeGreaterThan(idxUser);
  });

  it('reject：不开步（无 step/start、无 request）、Notice 可见、turn 照常收尾', async () => {
    const events: Array<{ kind: EventKind; text?: string }> = [];
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {
      eventSink: (ev) => events.push({ kind: ev.kind, text: ev.text }),
    });
    const order: string[] = [];
    agent.onLoopEvent('step/start', () => order.push('step/start'));
    agent.onLoopEvent('request/start', () => order.push('request/start'));
    agent.onLoopEvent('turn/end', () => order.push('turn/end'));
    const reg = new PreStepRegistry();
    reg.register({ name: 'blocker', decide: () => ({ action: 'reject', reason: '实验拦截' }) });
    agent.setPreStep(reg);

    await agent.run(new AbortController().signal, 'hi');

    expect(order).toEqual(['turn/end']); // 未开步、未发请求，仅 turn 收尾
    expect(
      events.some((e) => e.kind === EventKind.Notice && e.text?.includes('本步被钩子拦下（未发送请求）：实验拦截')),
    ).toBe(true);
  });
});
