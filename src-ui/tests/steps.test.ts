// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 步骤钩子家族钉住（agent-hooks-plan：一期 pre-step 面 + 二期面扩展）：
//   ① StepsRegistry 合并语义（pre-step）：enter 注入累积（messages + reminders
//      分列）/ 任一 reject 折叠整体 / shouldRun 跳过 / 崩溃与畸形返回值降级 /
//      async decide / disposer；
//   ② 事件维度：hasListeners 按事件独立（per-事件判据）、on 分派（注册哪条通道
//      就只进哪条通道）、disposer 只摘对应事件；
//   ③ loop 行为（default-loop 真跑）：
//      - 未接面（null）= 逐字节零行为变化（事件序回归门）；
//      - enter + messages → durable 消息落会话（用户消息之后）；
//      - enter + reminders → transient 提醒进本次请求（不落会话、每步重建）；
//      - reject → 不开步（无 step/start、无 request）、Notice 可见、turn 收尾。

import { describe, expect, it, vi } from 'vitest';
import { installCompactionForTest } from './helpers/compaction-impl';

// 驱动真 Agent 的循环会进入压缩预检（contextWindow 默认 1M）——复现
// 「装载器已跑过」的压缩实现常驻态（同 agent-loop-events.test.ts 先例）。
installCompactionForTest();

import { EventKind } from '../src/agent/agent-types';
import { type PreStepPayload, StepsRegistry } from '../src/agent/steps';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider, Request } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

function payload(step = 0): PreStepPayload {
  return { agentId: 'test-agent', step, signal: new AbortController().signal };
}

describe('StepsRegistry — pre-step 合并语义', () => {
  it('空注册表 = enter（无 messages / reminders 字段）', async () => {
    const reg = new StepsRegistry();
    expect(await reg.decidePreStep(payload())).toEqual({ action: 'enter' });
  });

  it('多 hook 注入按注册序累积（messages 与 reminders 分列）', async () => {
    const reg = new StepsRegistry();
    reg.register('pre-step', { name: 'a', decide: () => ({ action: 'enter', messages: [{ content: 'M1' }] }) });
    reg.register('pre-step', {
      name: 'b',
      decide: () => ({ action: 'enter', reminders: [{ content: 'R1' }] }),
    });
    reg.register('pre-step', {
      name: 'c',
      decide: () => ({ action: 'enter', messages: [{ content: 'M2' }], reminders: [{ content: 'R2' }] }),
    });
    expect(await reg.decidePreStep(payload())).toEqual({
      action: 'enter',
      messages: [{ content: 'M1' }, { content: 'M2' }],
      reminders: [{ content: 'R1' }, { content: 'R2' }],
    });
  });

  it('任一 reject ⇒ 整体 reject（reason 取第一个非空、注入批丢弃、全跑不短路）', async () => {
    const reg = new StepsRegistry();
    const calls: string[] = [];
    reg.register('pre-step', {
      name: 'inject',
      decide: () => {
        calls.push('inject');
        return { action: 'enter', messages: [{ content: 'X' }], reminders: [{ content: 'Y' }] };
      },
    });
    reg.register('pre-step', {
      name: 'r1',
      decide: () => {
        calls.push('r1');
        return { action: 'reject' };
      },
    });
    reg.register('pre-step', {
      name: 'r2',
      decide: () => {
        calls.push('r2');
        return { action: 'reject', reason: '理由' };
      },
    });
    reg.register('pre-step', {
      name: 'after',
      decide: () => {
        calls.push('after');
        return { action: 'enter' };
      },
    });
    expect(await reg.decidePreStep(payload())).toEqual({ action: 'reject', reason: '理由' });
    expect(calls).toEqual(['inject', 'r1', 'r2', 'after']); // 全跑：后续 hook 仍收到调用（审计友好）
  });

  it('shouldRun=false 跳过本钩子', async () => {
    const reg = new StepsRegistry();
    const decide = vi.fn(() => ({ action: 'enter' as const }));
    reg.register('pre-step', { name: 'cond', shouldRun: (p) => p.step === 2, decide });
    await reg.decidePreStep(payload(0));
    expect(decide).not.toHaveBeenCalled();
    await reg.decidePreStep(payload(2));
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('hook 崩溃降级（不阻断、不否决，后续钩子继续）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = new StepsRegistry();
    reg.register('pre-step', {
      name: 'crash',
      decide: () => {
        throw new Error('boom');
      },
    });
    reg.register('pre-step', { name: 'ok', decide: () => ({ action: 'enter', messages: [{ content: 'OK' }] }) });
    expect(await reg.decidePreStep(payload())).toEqual({ action: 'enter', messages: [{ content: 'OK' }] });
    errSpy.mockRestore();
  });

  it('畸形返回值视作未投（不静默变 reject）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = new StepsRegistry();
    reg.register('pre-step', { name: 'bad', decide: () => ({ action: 'nope' }) as never });
    reg.register('pre-step', { name: 'ok', decide: () => ({ action: 'enter' }) });
    expect(await reg.decidePreStep(payload())).toEqual({ action: 'enter' });
    errSpy.mockRestore();
  });

  it('async decide 支持', async () => {
    const reg = new StepsRegistry();
    reg.register('pre-step', {
      name: 'async',
      decide: async () => ({ action: 'enter', messages: [{ content: 'ASYNC' }] }),
    });
    expect(await reg.decidePreStep(payload())).toEqual({ action: 'enter', messages: [{ content: 'ASYNC' }] });
  });

  it('register 返回的 disposer 幂等且摘除钩子', async () => {
    const reg = new StepsRegistry();
    const dispose = reg.register('pre-step', {
      name: 'a',
      decide: () => ({ action: 'enter', messages: [{ content: 'A' }] }),
    });
    dispose();
    dispose(); // 幂等：二次调用不误伤
    expect(await reg.decidePreStep(payload())).toEqual({ action: 'enter' });
  });

  it('同步时序守恒：全同步钩子 ⇒ 同步返回值（无微任务边界——loop 的「同步通到底」依赖）', () => {
    const reg = new StepsRegistry();
    reg.register('pre-step', { name: 'a', decide: () => ({ action: 'enter', messages: [{ content: 'A' }] }) });
    const r = reg.decidePreStep(payload());
    expect(r).not.toBeInstanceOf(Promise); // 非 promise = loop 端不 await = 步前前缀不被截断
    expect(r).toEqual({ action: 'enter', messages: [{ content: 'A' }] });
  });

  it('含异步钩子 ⇒ 返回 promise；后续钩子串行（异步 settle 后才被调用）', async () => {
    const reg = new StepsRegistry();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    reg.register('pre-step', {
      name: 'a',
      decide: async () => {
        order.push('a-start');
        await gate;
        order.push('a-end');
        return { action: 'enter' };
      },
    });
    reg.register('pre-step', {
      name: 'b',
      decide: () => {
        order.push('b');
        return { action: 'enter', messages: [{ content: 'B' }] };
      },
    });
    const r = reg.decidePreStep(payload());
    expect(r).toBeInstanceOf(Promise);
    expect(order).toEqual(['a-start']); // 串行：b 尚未被调用
    release();
    expect(await r).toEqual({ action: 'enter', messages: [{ content: 'B' }] });
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
});

describe('StepsRegistry — 事件维度（per-事件判据与 on 分派）', () => {
  it('hasListeners 按事件独立：注册 pre-step 不影响 turn-stopping（反之亦然）', () => {
    const reg = new StepsRegistry();
    expect(reg.hasListeners('pre-step')).toBe(false);
    expect(reg.hasListeners('turn-stopping')).toBe(false);
    const d = reg.register('pre-step', { name: 'a', decide: () => ({ action: 'enter' }) });
    expect(reg.hasListeners('pre-step')).toBe(true);
    expect(reg.hasListeners('turn-stopping')).toBe(false); // 各点独立零开销（per-事件短路判据）
    const d2 = reg.register('turn-stopping', { name: 'b', decide: () => ({ action: 'stop' }) });
    expect(reg.hasListeners('turn-stopping')).toBe(true);
    d();
    expect(reg.hasListeners('pre-step')).toBe(false);
    expect(reg.hasListeners('turn-stopping')).toBe(true);
    d2();
    expect(reg.hasListeners('turn-stopping')).toBe(false);
  });

  it('on 分派：pre-step 的注册不会被 turn-stopping 裁决调用（反之亦然）', async () => {
    const reg = new StepsRegistry();
    const preDecide = vi.fn(() => ({ action: 'enter' as const }));
    const stopDecide = vi.fn(() => ({ action: 'stop' as const }));
    reg.register('pre-step', { name: 'only-pre', decide: preDecide });
    reg.register('turn-stopping', { name: 'only-stop', decide: stopDecide });

    await reg.decidePreStep(payload());
    expect(preDecide).toHaveBeenCalledTimes(1);
    expect(stopDecide).not.toHaveBeenCalled();

    await reg.decideTurnStopping(payload());
    expect(stopDecide).toHaveBeenCalledTimes(1);
    expect(preDecide).toHaveBeenCalledTimes(1);
  });

  it('disposer 只摘对应事件的注册（跨事件不误伤）', () => {
    const reg = new StepsRegistry();
    const dPre = reg.register('pre-step', { name: 'a', decide: () => ({ action: 'enter' }) });
    reg.register('turn-stopping', { name: 'b', decide: () => ({ action: 'stop' }) });
    dPre();
    expect(reg.hasListeners('pre-step')).toBe(false);
    expect(reg.hasListeners('turn-stopping')).toBe(true);
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

/** 第一轮出工具调用（触发第二步）、之后纯文本收尾——多步场景（reminders 每步重建）。 */
function twoRoundProvider(): { prov: Provider; requests: Array<Array<{ role: string; content: string }>> } {
  const requests: Array<Array<{ role: string; content: string }>> = [];
  let call = 0;
  const prov: Provider = {
    name: () => 'mock-provider',
    model: () => 'mock-model',
    stream: async function* (_signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      requests.push(
        req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      );
      call += 1;
      if (call === 1) {
        yield { type: ChunkType.ToolCall, tool_call: { id: 'c1', name: 'noop', arguments: '{}' } } as unknown as Chunk;
      } else {
        yield { type: ChunkType.Text, text: 'done' } as Chunk;
      }
      yield { type: ChunkType.Done } as Chunk;
    },
  };
  return { prov, requests };
}

function noopTool(): import('../src/agent/tool').Tool {
  return {
    name: () => 'noop',
    description: () => 'noop',
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => true,
    execute: async () => 'ok',
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

  it('enter + messages：消息落会话（位于用户消息之后）', async () => {
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const reg = new StepsRegistry();
    reg.register('pre-step', {
      name: 'inj',
      decide: () => ({ action: 'enter', messages: [{ content: '[PRE-STEP] 注入' }] }),
    });
    agent.setSteps(reg);

    await agent.run(new AbortController().signal, 'hi');

    const session = agent.getSession();
    const idxUser = session.findIndex((m) => m.role === 'user' && m.content === 'hi');
    const idxInject = session.findIndex((m) => m.role === 'user' && m.content === '[PRE-STEP] 注入');
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxInject).toBeGreaterThan(idxUser);
  });

  it('enter + reminders：transient 提醒进本次请求、不落会话（每步重建）', async () => {
    const { prov, requests } = twoRoundProvider();
    const tools = new ToolRegistry();
    tools.register(noopTool());
    const agent = createTestAgent(prov, tools, 'sys', {});
    const reg = new StepsRegistry();
    reg.register('pre-step', {
      name: 'rem',
      decide: (p) =>
        p.step === 0 ? { action: 'enter', reminders: [{ content: '[REMINDER] 只给本步' }] } : { action: 'enter' },
    });
    agent.setSteps(reg);

    await agent.run(new AbortController().signal, 'hi');

    // 第一步请求模型可见（transient 拼进请求载荷）
    expect(requests.length).toBe(2);
    expect(requests[0].some((m) => m.content.includes('[REMINDER] 只给本步'))).toBe(true);
    // 第二步请求里已重建（只给本次请求语义）——第一步的提醒不再出现
    expect(requests[1].some((m) => m.content.includes('[REMINDER] 只给本步'))).toBe(false);
    // 不落会话（transient——每次请求重建）
    expect(agent.getSession().some((m) => String(m.content).includes('[REMINDER]'))).toBe(false);
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
    const reg = new StepsRegistry();
    reg.register('pre-step', { name: 'blocker', decide: () => ({ action: 'reject', reason: '实验拦截' }) });
    agent.setSteps(reg);

    await agent.run(new AbortController().signal, 'hi');

    expect(order).toEqual(['turn/end']); // 未开步、未发请求，仅 turn 收尾
    expect(
      events.some((e) => e.kind === EventKind.Notice && e.text?.includes('本步被钩子拦下（未发送请求）：实验拦截')),
    ).toBe(true);
  });
});
