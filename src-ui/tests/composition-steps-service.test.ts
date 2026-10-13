// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 步骤钩子贡献通道（composition/steps-service.ts，agent-hooks-plan 一期/二期）钉住面：
//   1. 注册语义：id 寻址、保序读取、重名装载期拒绝、disposer 幂等 + 陈旧性守卫；
//   2. 装载期形状校验（外部插件是纯 JS——畸形贡献拒绝：id / on / hook / name /
//      decide / create）；
//   3. 消费闭环：activeStepHookContributions()（无服务 = 空集）；
//   4. 装配折叠：runtime._assembleAgent 把贡献按 on 分派注册进 per-Agent
//      StepsRegistry（内建发现钩子先于通道贡献）；未接面（拆卸后）不存在折叠；
//   5. create 工厂：每个 Agent 调一次（per-Agent 实例，状态隔离）；抛错 =
//      装配期 fail-loud（不静默跳过）。

import { describe, expect, it } from 'vitest';
import type { StepsRegistry } from '../src/agent/steps';
import {
  activeStepHookContributions,
  type StepHookContribution,
  stepsServicePlugin,
} from '../src/composition/steps-service';
import { Context } from '../src/cordis';

/** enter 型 pre-step 贡献（带注入标记——decide 恒放行并附一条消息）。 */
function enterContribution(id: string, tag: string): StepHookContribution {
  return {
    id,
    on: 'pre-step',
    hook: {
      name: `${id}-hook`,
      decide: () => ({ action: 'enter', messages: [{ content: `[${tag}]` }] }),
    },
  };
}

/** 折叠断言读出的 per-Agent 面（Agent.steps 是 private——装配语义经行为面验证）。 */
type AgentStepsFace = { steps: StepsRegistry | null };

async function assembleAgent(runtime: {
  ready(): Promise<void>;
  createAgent(opts: Record<string, unknown>): Promise<unknown>;
}): Promise<{ inner: AgentStepsFace; dispose: () => void }> {
  const { ToolRegistry } = await import('../src/agent/tool');
  const { scriptedProvider, readOnlyTool } = await import('./convergence/helpers/fixtures');
  const tools = new ToolRegistry();
  tools.register(readOnlyTool());
  const handle = (await runtime.createAgent({
    projectPath: '/projects/demo',
    provider: scriptedProvider([]),
    tools,
    eventSink: () => {},
  })) as { _getAgent(): AgentStepsFace; dispose: () => void };
  return { inner: handle._getAgent(), dispose: () => handle.dispose() };
}

function stepPayload(step = 0) {
  return { agentId: 'x', step, signal: new AbortController().signal };
}

describe('composition/steps-service（步骤钩子贡献通道）', () => {
  it('注册语义：经 ctx.steps 注册，activeStepHookContributions 保序读取（on 两态并存）', async () => {
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    expect(activeStepHookContributions()).toEqual([]); // 起点是空集
    const a = root.steps.register(enterContribution('acme/a', 'A'));
    const b = root.steps.register({
      id: 'acme/b',
      on: 'turn-stopping',
      hook: { name: 'b-hook', decide: () => ({ action: 'stop' }) },
    });
    expect(activeStepHookContributions().map((c) => c.id)).toEqual(['acme/a', 'acme/b']);
    expect(activeStepHookContributions().map((c) => c.on)).toEqual(['pre-step', 'turn-stopping']);
    a();
    b();
    expect(activeStepHookContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('重名 id 装载期拒绝（throw，不静默覆盖）', async () => {
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    root.steps.register(enterContribution('acme/dup', 'A'));
    expect(() => root.steps.register(enterContribution('acme/dup', 'B'))).toThrow(/duplicate contribution id/);
    await fiber.dispose();
  });

  it('disposer 幂等 + 陈旧性守卫（同 id 重注册后旧 disposer 不误删新行）', async () => {
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    const stale = root.steps.register(enterContribution('acme/slot', '旧'));
    stale(); // 先注销，同 id 重注册才合法（重名是装载期拒绝）
    expect(activeStepHookContributions()).toEqual([]);
    const fresh = root.steps.register(enterContribution('acme/slot', '新'));
    stale(); // 陈旧 disposer 二次调用不误删新行
    expect(activeStepHookContributions().map((c) => c.id)).toEqual(['acme/slot']);
    fresh();
    expect(activeStepHookContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('装载期形状校验：畸形贡献拒绝（id / on / hook / name / decide / create）', async () => {
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    expect(() => root.steps.register({ id: '' } as never)).toThrow(/贡献 id/);
    expect(() => root.steps.register({ id: 'a', on: 'nope' } as never)).toThrow(/on 必须是/);
    expect(() => root.steps.register({ id: 'a', on: 'pre-step', hook: null } as never)).toThrow(/hook 必须是对象/);
    expect(() => root.steps.register({ id: 'a', on: 'pre-step', hook: { name: '' } } as never)).toThrow(/hook.name/);
    expect(() => root.steps.register({ id: 'a', on: 'pre-step', hook: { name: 'n' } } as never)).toThrow(/decide/);
    expect(() =>
      root.steps.register({
        id: 'a',
        on: 'pre-step',
        hook: { name: 'n', decide: () => ({ action: 'enter' }) },
        create: 'not-a-function',
      } as never),
    ).toThrow(/create 必须是函数/);
    await fiber.dispose();
  });

  it('无服务环境：activeStepHookContributions = 空集（消费面零改写）', () => {
    // 上一个用例的 fiber dispose 后守卫式清空模块级活动指针
    expect(activeStepHookContributions()).toEqual([]);
  });

  it('装配折叠：runtime.createAgent 把贡献按 on 分派注册进 per-Agent StepsRegistry；拆卸后不折叠', async () => {
    // 超时预算 20s：用例内冷导入 runtime/tool/fixtures 模块图 + 两次完整
    // AgentRuntime 装配（比照 composition-hook-service 先例）。
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    root.steps.register(enterContribution('acme/pre', 'FOLDED'));
    root.steps.register({
      id: 'acme/stop',
      on: 'turn-stopping',
      hook: { name: 'stop-hook', decide: () => ({ action: 'continue', reason: '折叠验证' }) },
    });

    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const rt = new AgentRuntime(); // 无 projectPath → 纯内存
    await rt.ready();
    const { inner } = await assembleAgent(rt as unknown as Parameters<typeof assembleAgent>[0]);
    // 内建发现钩子先于通道贡献注册；发现板为空 ⇒ 不注入，合并结果只见通道贡献
    expect(await inner.steps!.decidePreStep(stepPayload())).toEqual({
      action: 'enter',
      messages: [{ content: '[FOLDED]' }],
    });
    expect(await inner.steps!.decideTurnStopping(stepPayload())).toEqual({
      action: 'continue',
      reason: '折叠验证',
    });

    await fiber.dispose();
    // 通道拆卸后新装配不再折叠（生效时机 = 装配时点快照）
    const rt2 = new AgentRuntime();
    await rt2.ready();
    const { inner: inner2 } = await assembleAgent(rt2 as unknown as Parameters<typeof assembleAgent>[0]);
    // 内建发现钩子仍在（装配点内建），通道贡献缺席 ⇒ 直通（发现板空 = 无注入）
    expect(await inner2.steps!.decidePreStep(stepPayload())).toEqual({ action: 'enter' });
    expect(inner2.steps!.hasListeners('turn-stopping')).toBe(false);
  }, 20_000);

  it('create 工厂：每个 Agent 调一次、实例隔离（per-Agent 状态归属）', async () => {
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    let created = 0;
    root.steps.register({
      id: 'acme/factory',
      on: 'pre-step',
      hook: { name: 'shared', decide: () => ({ action: 'enter', messages: [{ content: '[SHARED]' }] }) },
      create: () => {
        created += 1;
        const n = created;
        return { name: `inst-${n}`, decide: () => ({ action: 'enter', messages: [{ content: `[INST ${n}]` }] }) };
      },
    });

    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const rt = new AgentRuntime();
    await rt.ready();
    const { inner: a1 } = await assembleAgent(rt as unknown as Parameters<typeof assembleAgent>[0]);
    const { inner: a2 } = await assembleAgent(rt as unknown as Parameters<typeof assembleAgent>[0]);

    expect(created).toBe(2); // 每个 Agent 调一次（共享实例不被使用——create 优先）
    expect(await a1.steps!.decidePreStep(stepPayload())).toEqual({
      action: 'enter',
      messages: [{ content: '[INST 1]' }],
    });
    expect(await a2.steps!.decidePreStep(stepPayload())).toEqual({
      action: 'enter',
      messages: [{ content: '[INST 2]' }],
    });
    await fiber.dispose();
  }, 20_000);

  it('create 工厂抛错 = 装配期 fail-loud（不静默跳过）', async () => {
    const root = new Context();
    const fiber = await root.plugin(stepsServicePlugin);
    root.steps.register({
      id: 'acme/broken',
      on: 'pre-step',
      hook: { name: 'shared', decide: () => ({ action: 'enter' }) },
      create: () => {
        throw new Error('factory boom');
      },
    });

    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const { ToolRegistry } = await import('../src/agent/tool');
    const { scriptedProvider, readOnlyTool } = await import('./convergence/helpers/fixtures');
    const rt = new AgentRuntime();
    await rt.ready();
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    await expect(
      rt.createAgent({
        projectPath: '/projects/demo',
        provider: scriptedProvider([]),
        tools,
        eventSink: () => {},
      }),
    ).rejects.toThrow('factory boom');
    await fiber.dispose();
  }, 20_000);
});
