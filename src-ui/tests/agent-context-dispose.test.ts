// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// AgentContext.dispose 行为规约（agent-core-convergence Phase 4 / 验证计划 §4 Phase 4 T1）：
//   1. dispose 幂等 — 重复调用 no-op；
//   2. 并发 dispose 只执行一次（两条 dispose promise 竞争，effects 恰好各跑一次）；
//   3. 清理中某 effect 抛错不阻断后续，错误聚合抛出且带 label（可观测）；
//   4. dispose 后拒绝新增（effect 抛错、set 服务抛错）；
//   5. 同步快通道 — 全 sync 链在 dispose() 返回前生效（_disposeAgent 的同步语义依赖）；
//   6. dispose 后 get/resolve 仍可读（已注册服务不清空——终态只读）。
import { describe, expect, it } from 'vitest';
import { AgentContext, type AgentServices } from '../src/agent/context';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';

function mockProvider(): Provider {
  return {
    name: () => 'mock',
    stream: async function* (_signal: AbortSignal) {
      yield { type: 5 as any } as Chunk; // Done
    },
  };
}

function services(): Partial<AgentServices> {
  return { provider: mockProvider(), tools: new ToolRegistry() };
}

describe('AgentContext.dispose — T1 规约', () => {
  it('dispose 幂等 — 重复调用为 no-op', async () => {
    const ctx = new AgentContext({ agentId: 'd1' }, services());
    const order: string[] = [];
    ctx.effect(() => () => order.push('e1'), 'e1');
    await ctx.dispose();
    await ctx.dispose();
    expect(order).toEqual(['e1']);
    expect(ctx.disposed).toBe(true);
  });

  it('并发 dispose 只执行一次', async () => {
    const ctx = new AgentContext({ agentId: 'd2' });
    let ran = 0;
    ctx.effect(
      () => () => {
        ran++;
      },
      'count',
    );
    const [p1, p2] = [ctx.dispose(), ctx.dispose()];
    await Promise.all([p1, p2]);
    expect(ran).toBe(1);
  });

  it('某 effect 抛错不阻断后续，错误聚合抛出且带 label', async () => {
    const ctx = new AgentContext({ agentId: 'd3' });
    const order: string[] = [];
    ctx.effect(() => () => order.push('after'), 'after'); // 注册最早 → 释放最后
    ctx.effect(
      () => () => {
        order.push('boom');
        throw new Error('cleanup-boom');
      },
      'boom-label',
    );
    await expect(ctx.dispose()).rejects.toThrow(/1 个清理器失败.*boom-label.*cleanup-boom/s);
    expect(order).toEqual(['boom', 'after']); // 失败者之后的照常执行
  });

  it('dispose 后拒绝新增（effect 与 set）', async () => {
    const ctx = new AgentContext({ agentId: 'd4' }, services());
    await ctx.dispose();
    expect(() => ctx.effect(() => () => {}, 'late')).toThrow(/已 dispose/);
    expect(() => ctx.set('tools', new ToolRegistry())).toThrow(/已 dispose/);
  });

  it('同步快通道 — 全 sync 链在 dispose() 返回前生效', () => {
    const ctx = new AgentContext({ agentId: 'd5' });
    const order: string[] = [];
    ctx.effect(() => () => order.push('first-reg'), 'first-reg');
    ctx.effect(() => () => order.push('last-reg'), 'last-reg');
    ctx.dispose(); // 不 await
    expect(order).toEqual(['last-reg', 'first-reg']); // 逆序 + 同步完成
    expect(ctx.disposed).toBe(true);
  });

  it('dispose 后已注册服务仍可读（终态只读）', async () => {
    const tools = new ToolRegistry();
    const ctx = new AgentContext({ agentId: 'd6' }, { tools });
    await ctx.dispose();
    expect(ctx.get('tools')).toBe(tools);
    expect(() => ctx.resolve('provider')).toThrow(/服务缺失/);
  });
});
