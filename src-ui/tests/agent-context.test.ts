// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// AgentContext 行为规约（agent-core-convergence Phase 3 / 验证计划 §4 Phase 3 T1）：
//   1. 服务解析：get 可缺、resolve 必备显式报错；
//   2. effect 注册与逆序释放、单项释放、dispose 后拒绝新增；
//   3. child() 隔离：身份按父子关系派生、继承表之外的服务不泄露、effect 所有权独立；
//   4. ctx 构造入口的 Agent 冒烟（身份/服务从 ctx 读取）。
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent';
import { AgentContext, type AgentServices } from '../src/agent/context';
import { MessageBus } from '../src/agent/message-bus';
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

function baseServices(overrides: Partial<AgentServices> = {}): Partial<AgentServices> {
  return { provider: mockProvider(), tools: new ToolRegistry(), ...overrides };
}

describe('AgentContext — 服务解析', () => {
  it('get 返回已注册服务；未注册返回 undefined', () => {
    const tools = new ToolRegistry();
    const ctx = new AgentContext({ agentId: 'a1' }, { tools });
    expect(ctx.get('tools')).toBe(tools);
    expect(ctx.get('provider')).toBeUndefined();
  });

  it('resolve 返回必备服务；缺失抛错并报出服务名与 agentId', () => {
    const ctx = new AgentContext({ agentId: 'a2' }, baseServices());
    expect(ctx.resolve('provider').name()).toBe('mock');
    const bare = new AgentContext({ agentId: 'a3' });
    expect(() => bare.resolve('provider')).toThrow(/provider/);
    expect(() => bare.resolve('provider')).toThrow(/a3/);
  });

  it('set 写入后 get 可见；dispose 后拒绝写入', async () => {
    const ctx = new AgentContext({ agentId: 'a4' });
    const bus = new MessageBus();
    ctx.set('messageBus', bus);
    expect(ctx.get('messageBus')).toBe(bus);
    await ctx.dispose();
    expect(() => ctx.set('messageBus', bus)).toThrow(/dispose/);
  });
});

describe('AgentContext — effect 所有权', () => {
  it('逆序释放全部清理器', async () => {
    const ctx = new AgentContext({ agentId: 'a5' });
    const order: string[] = [];
    ctx.effect(() => () => order.push('first'), 'first');
    ctx.effect(() => () => order.push('second'), 'second');
    ctx.effect(() => () => order.push('third'), 'third');
    await ctx.dispose();
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('单项释放器只释放自己；bag 内其余不受影响', async () => {
    const ctx = new AgentContext({ agentId: 'a6' });
    const order: string[] = [];
    const releaseSecond = ctx.effect(() => () => order.push('second'), 'second');
    ctx.effect(() => () => order.push('first'), 'first');
    releaseSecond();
    expect(order).toEqual(['second']);
    await ctx.dispose();
    expect(order).toEqual(['second', 'first']);
  });

  it('dispose 幂等；dispose 后 effect 拒绝新增', async () => {
    const ctx = new AgentContext({ agentId: 'a7' });
    const order: string[] = [];
    ctx.effect(() => () => order.push('x'), 'x');
    await ctx.dispose();
    await ctx.dispose(); // 二次调用 no-op
    expect(order).toEqual(['x']);
    expect(() => ctx.effect(() => () => {}, 'late')).toThrow();
  });
});

describe('AgentContext — child() 派生隔离', () => {
  it('身份按父子关系派生，默认 id 为 sub-*', () => {
    const parent = new AgentContext({ agentId: 'p1', subagentDepth: 1, projectPath: '/proj' });
    const child = parent.child();
    expect(child.parentId).toBe('p1');
    expect(child.subagentDepth).toBe(2);
    expect(child.projectPath).toBe('/proj');
    expect(child.agentId.startsWith('sub-')).toBe(true);
  });

  it('覆盖项生效：agentId / isolationId / services', () => {
    const parent = new AgentContext({ agentId: 'p2' }, baseServices());
    const childTools = new ToolRegistry();
    const child = parent.child({
      agentId: 'sub-explicit',
      isolationId: 'wt-1',
      services: { tools: childTools },
    });
    expect(child.agentId).toBe('sub-explicit');
    expect(child.isolationId).toBe('wt-1');
    expect(child.get('tools')).toBe(childTools);
    expect(parent.get('tools')).not.toBe(childTools);
  });

  it('只继承白名单服务（provider/messageBus/agentStore），其余不泄露', () => {
    const bus = new MessageBus();
    const planState = { state: { active: false, id: null, planFilePath: null } } as never;
    const parent = new AgentContext(
      { agentId: 'p3' },
      baseServices({ messageBus: bus, planState, taskBoard: {} as never, subAgentPool: {} as never }),
    );
    const child = parent.child();
    expect(child.get('provider')).toBe(parent.get('provider'));
    expect(child.get('messageBus')).toBe(bus);
    expect(child.get('planState')).toBeUndefined();
    expect(child.get('taskBoard')).toBeUndefined();
    expect(child.get('subAgentPool')).toBeUndefined();
  });

  it('effect 所有权独立 — 父 dispose 不动子的清理器，反之亦然', async () => {
    const parent = new AgentContext({ agentId: 'p4' });
    const child = parent.child({ agentId: 'c4' });
    const order: string[] = [];
    parent.effect(() => () => order.push('parent'), 'parent');
    child.effect(() => () => order.push('child'), 'child');
    await parent.dispose();
    expect(order).toEqual(['parent']);
    expect(child.disposed).toBe(false);
    await child.dispose();
    expect(order).toEqual(['parent', 'child']);
  });
});

describe('AgentContext 构造入口（new Agent(ctx, prompt, opts)）', () => {
  it('身份与服务从 ctx 读取；opts 仍提供调优参数', () => {
    const ctx = new AgentContext(
      { agentId: 'ctx-agent', parentId: 'p5', subagentDepth: 1, isolationId: 'wt-9', projectPath: '/proj' },
      baseServices(),
    );
    const agent = new Agent(ctx, 'ctx system prompt', { temperature: 0.3 });
    expect(agent.id).toBe('ctx-agent');
    expect(agent.parentId).toBe('p5');
    expect(agent.subagentDepth).toBe(1);
    // ctx 路径的 system prompt 正常入会话
    expect(agent.getSession()[0]).toEqual({ role: 'system', content: 'ctx system prompt' });
  });

  it('必备服务缺失时构造即抛错（provider/tools）', () => {
    const ctx = new AgentContext({ agentId: 'ctx-bad' }, { tools: new ToolRegistry() });
    expect(() => new Agent(ctx, 'sys')).toThrow(/provider/);
  });
});
