// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// turn-stopping 停止边界钉住（agent-hooks-plan 二期）：
//   ① StepsRegistry 合并语义：默认停（空表 / 全 stop）/ 任一 continue ⇒ 继续
//      （全跑、注入累积、reason 取第一个非空）/ shouldAsk 跳过 / 崩溃与畸形
//      返回值降级（视作未投 = 默认停）/ async；
//   ② loop 行为（default-loop 真跑）：
//      - 零注册者 / 未接面（null）= 直通 stop（事件序逐字节零变化回归门）；
//      - continue = 同 run 再开下一步（事件序 step/end → 新 step/start）+ 注入
//        落地（messages 落会话、reminders 进下一轮请求）；
//      - 护栏：同 turn 连续 continue 超限（MAX_TURN_CONTINUES）⇒ 强制停 + warn + Notice。

import { describe, expect, it, vi } from 'vitest';
import { installCompactionForTest } from './helpers/compaction-impl';

// 驱动真 Agent 的循环会进入压缩预检（contextWindow 默认 1M）——复现
// 「装载器已跑过」的压缩实现常驻态（同 agent-loop-events.test.ts 先例）。
installCompactionForTest();

import { EventKind } from '../src/agent/agent-types';
import { log } from '../src/agent/logger';
import { StepsRegistry, type TurnStoppingPayload } from '../src/agent/steps';
import { ToolRegistry } from '../src/agent/tool';
import { MAX_TURN_CONTINUES } from '../src/plugins/builtin/agent-loop-service/default-loop';
import type { Chunk, Provider, Request } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

function payload(step = 0): TurnStoppingPayload {
  return { agentId: 'test-agent', step, signal: new AbortController().signal };
}

describe('StepsRegistry — turn-stopping 合并语义', () => {
  it('空注册表 = stop（默认停）', async () => {
    const reg = new StepsRegistry();
    expect(await reg.decideTurnStopping(payload())).toEqual({ action: 'stop' });
  });

  it('全 stop = stop；任一 continue ⇒ 继续（全跑不短路）', async () => {
    const reg = new StepsRegistry();
    const calls: string[] = [];
    reg.register('turn-stopping', {
      name: 's1',
      decide: () => {
        calls.push('s1');
        return { action: 'stop' };
      },
    });
    reg.register('turn-stopping', {
      name: 'c1',
      decide: () => {
        calls.push('c1');
        return {
          action: 'continue',
          reason: '任务未完成',
          messages: [{ content: 'M' }],
          reminders: [{ content: 'R' }],
        };
      },
    });
    reg.register('turn-stopping', {
      name: 'c2',
      decide: () => {
        calls.push('c2');
        return { action: 'continue', reason: '第二个理由' };
      },
    });
    expect(await reg.decideTurnStopping(payload())).toEqual({
      action: 'continue',
      reason: '任务未完成', // reason 取第一个非空
      messages: [{ content: 'M' }],
      reminders: [{ content: 'R' }],
    });
    expect(calls).toEqual(['s1', 'c1', 'c2']); // 全跑：stop 之后钩子照常收到调用
  });

  it('shouldAsk=false 跳过本钩子', async () => {
    const reg = new StepsRegistry();
    const decide = vi.fn(() => ({ action: 'continue' as const }));
    reg.register('turn-stopping', { name: 'cond', shouldAsk: (p) => p.step === 2, decide });
    expect(await reg.decideTurnStopping(payload(0))).toEqual({ action: 'stop' });
    expect(decide).not.toHaveBeenCalled();
    expect(await reg.decideTurnStopping(payload(2))).toEqual({ action: 'continue' });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('崩溃降级（不阻断、不否决 ⇒ 默认停）与畸形返回值视作未投', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = new StepsRegistry();
    reg.register('turn-stopping', {
      name: 'crash',
      decide: () => {
        throw new Error('boom');
      },
    });
    reg.register('turn-stopping', { name: 'bad', decide: () => ({ action: 'nope' }) as never });
    expect(await reg.decideTurnStopping(payload())).toEqual({ action: 'stop' });
    errSpy.mockRestore();
  });

  it('async decide 支持', async () => {
    const reg = new StepsRegistry();
    reg.register('turn-stopping', { name: 'async', decide: async () => ({ action: 'continue' }) });
    expect(await reg.decideTurnStopping(payload())).toEqual({ action: 'continue' });
  });

  it('同步时序守恒：全同步钩子 ⇒ 同步返回值；含异步钩子 ⇒ promise（与 pre-step 同款）', async () => {
    const syncReg = new StepsRegistry();
    syncReg.register('turn-stopping', { name: 's', decide: () => ({ action: 'stop' }) });
    expect(syncReg.decideTurnStopping(payload())).not.toBeInstanceOf(Promise);

    const asyncReg = new StepsRegistry();
    asyncReg.register('turn-stopping', { name: 'a', decide: async () => ({ action: 'stop' }) });
    expect(asyncReg.decideTurnStopping(payload())).toBeInstanceOf(Promise);
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

/** 记录每次请求的消息投影（`request.messages`）——观测注入的模型可见面。 */
function recordingProvider(): { prov: Provider; requests: Array<Array<{ role: string; content: string }>> } {
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const prov: Provider = {
    name: () => 'mock-provider',
    model: () => 'mock-model',
    stream: async function* (_signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      requests.push(
        req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      );
      yield { type: ChunkType.Text, text: 'ok' } as Chunk;
      yield { type: ChunkType.Done } as Chunk;
    },
  };
  return { prov, requests };
}

describe('default-loop — turn-stopping 消费', () => {
  it('零注册者 / 未接面：事件序逐字节零变化（回归门）', async () => {
    // 未接面（null）
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const order: string[] = [];
    agent.onLoopEvent('turn/start', () => order.push('turn/start'));
    agent.onLoopEvent('step/start', () => order.push('step/start'));
    agent.onLoopEvent('step/end', () => order.push('step/end'));
    agent.onLoopEvent('turn/end', () => order.push('turn/end'));
    await agent.run(new AbortController().signal, 'hi');
    expect(order).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end']);

    // 接面但 turn-stopping 零注册者（只注册 pre-step 的对照组）
    const agent2 = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const reg = new StepsRegistry();
    reg.register('pre-step', { name: 'pre-only', decide: () => ({ action: 'enter' }) });
    agent2.setSteps(reg);
    const order2: string[] = [];
    agent2.onLoopEvent('step/start', () => order2.push('step/start'));
    agent2.onLoopEvent('step/end', () => order2.push('step/end'));
    agent2.onLoopEvent('turn/end', () => order2.push('turn/end'));
    await agent2.run(new AbortController().signal, 'hi');
    expect(order2).toEqual(['step/start', 'step/end', 'turn/end']);
  });

  it('stop：正常收尾（与零注册等价的事件序）', async () => {
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const order: string[] = [];
    agent.onLoopEvent('step/start', () => order.push('step/start'));
    agent.onLoopEvent('step/end', () => order.push('step/end'));
    agent.onLoopEvent('turn/end', () => order.push('turn/end'));
    const reg = new StepsRegistry();
    reg.register('turn-stopping', { name: 'stop', decide: () => ({ action: 'stop' }) });
    agent.setSteps(reg);

    await agent.run(new AbortController().signal, 'hi');

    expect(order).toEqual(['step/start', 'step/end', 'turn/end']);
  });

  it('continue：同 run 再开下一步（事件序 step/end → 新 step/start）+ 注入落地', async () => {
    const { prov, requests } = recordingProvider();
    const agent = createTestAgent(prov, new ToolRegistry(), 'sys', {});
    const order: string[] = [];
    agent.onLoopEvent('step/start', () => order.push('step/start'));
    agent.onLoopEvent('step/end', () => order.push('step/end'));
    agent.onLoopEvent('turn/end', () => order.push('turn/end'));
    const reg = new StepsRegistry();
    let asked = 0;
    reg.register('turn-stopping', {
      name: 'once',
      decide: () => {
        asked += 1;
        return asked === 1
          ? {
              action: 'continue',
              reason: '还差一步',
              messages: [{ content: '[CONTINUE] 继续做' }],
              reminders: [{ content: '[CONTINUE-REM] 再检查一遍' }],
            }
          : { action: 'stop' };
      },
    });
    agent.setSteps(reg);

    await agent.run(new AbortController().signal, 'hi');

    // 同 run 两步；turn 不结束直到第二次 stop
    expect(order).toEqual(['step/start', 'step/end', 'step/start', 'step/end', 'turn/end']);
    expect(requests.length).toBe(2);
    // durable 注入：作为 user/message 落会话
    const session = agent.getSession();
    expect(session.some((m) => m.role === 'user' && m.content === '[CONTINUE] 继续做')).toBe(true);
    // transient 注入：进下一轮请求、不落会话
    expect(requests[1].some((m) => m.content.includes('[CONTINUE-REM] 再检查一遍'))).toBe(true);
    expect(session.some((m) => String(m.content).includes('[CONTINUE-REM]'))).toBe(false);
  });

  it(`护栏：同 turn continue 超限（${MAX_TURN_CONTINUES}）⇒ 强制停 + warn + Notice`, async () => {
    const events: Array<{ kind: EventKind; text?: string }> = [];
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { prov, requests } = recordingProvider();
    const agent = createTestAgent(prov, new ToolRegistry(), 'sys', {
      eventSink: (ev) => events.push({ kind: ev.kind, text: ev.text }),
    });
    const reg = new StepsRegistry();
    reg.register('turn-stopping', { name: 'always', decide: () => ({ action: 'continue', reason: '无条件继续' }) });
    agent.setSteps(reg);

    await agent.run(new AbortController().signal, 'hi');

    // 1 次初始 + 上限次数的 continue；超限的那次请求被拒 ⇒ 总数 = 1 + MAX
    expect(requests.length).toBe(1 + MAX_TURN_CONTINUES);
    expect(
      events.some(
        (e) =>
          e.kind === EventKind.Notice &&
          e.text?.includes(`turn-stopping 钩子请求继续已达上限（${MAX_TURN_CONTINUES} 次）`),
      ),
    ).toBe(true);
    expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('turn-stopping continue 超限'))).toBe(true);
    warnSpy.mockRestore();
  });
});
