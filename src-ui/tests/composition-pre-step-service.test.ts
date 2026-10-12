// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 步前裁决贡献通道（composition/pre-step-service.ts，agent-hooks-plan 一期）钉住面：
//   1. 注册语义：id 寻址、保序读取、重名装载期拒绝、disposer 幂等 + 陈旧性守卫；
//   2. 装载期形状校验（外部插件是纯 JS——畸形贡献拒绝）；
//   3. 消费闭环：activePreStepContributions()（无服务 = 空集）；
//   4. 装配折叠：runtime._assembleAgent 把贡献注册进 per-Agent PreStepRegistry，
//      未接面（子 Agent / 拆卸后）不存在折叠。

import { describe, expect, it } from 'vitest';
import type { PreStepRegistry } from '../src/agent/pre-step';
import {
  activePreStepContributions,
  type PreStepContribution,
  preStepServicePlugin,
} from '../src/composition/pre-step-service';
import { Context } from '../src/cordis';

/** enter 型贡献（带注入标记——decide 恒放行并附一条消息）。 */
function enterContribution(id: string, tag: string): PreStepContribution {
  return {
    id,
    hook: {
      name: `${id}-hook`,
      decide: () => ({ action: 'enter', messages: [{ content: `[${tag}]` }] }),
    },
  };
}

describe('composition/pre-step-service（步前裁决贡献通道）', () => {
  it('注册语义：经 ctx.preStep 注册，activePreStepContributions 保序读取', async () => {
    const root = new Context();
    const fiber = await root.plugin(preStepServicePlugin);
    expect(activePreStepContributions()).toEqual([]); // 起点是空集
    const a = root.preStep.register(enterContribution('acme/a', 'A'));
    const b = root.preStep.register(enterContribution('acme/b', 'B'));
    expect(activePreStepContributions().map((c) => c.id)).toEqual(['acme/a', 'acme/b']);
    a();
    b();
    expect(activePreStepContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('重名 id 装载期拒绝（throw，不静默覆盖）', async () => {
    const root = new Context();
    const fiber = await root.plugin(preStepServicePlugin);
    root.preStep.register(enterContribution('acme/dup', 'A'));
    expect(() => root.preStep.register(enterContribution('acme/dup', 'B'))).toThrow(/duplicate contribution id/);
    await fiber.dispose();
  });

  it('disposer 幂等 + 陈旧性守卫（同 id 重注册后旧 disposer 不误删新行）', async () => {
    const root = new Context();
    const fiber = await root.plugin(preStepServicePlugin);
    const stale = root.preStep.register(enterContribution('acme/slot', '旧'));
    stale(); // 先注销，同 id 重注册才合法（重名是装载期拒绝）
    expect(activePreStepContributions()).toEqual([]);
    const fresh = root.preStep.register(enterContribution('acme/slot', '新'));
    stale(); // 陈旧 disposer 二次调用不误删新行
    expect(activePreStepContributions().map((c) => c.id)).toEqual(['acme/slot']);
    fresh();
    expect(activePreStepContributions()).toEqual([]);
    await fiber.dispose();
  });

  it('装载期形状校验：畸形贡献拒绝（id / hook / name / decide）', async () => {
    const root = new Context();
    const fiber = await root.plugin(preStepServicePlugin);
    expect(() => root.preStep.register({ id: '' } as never)).toThrow(/贡献 id/);
    expect(() => root.preStep.register({ id: 'a', hook: null } as never)).toThrow(/hook 必须是对象/);
    expect(() => root.preStep.register({ id: 'a', hook: { name: '' } } as never)).toThrow(/hook.name/);
    expect(() => root.preStep.register({ id: 'a', hook: { name: 'n' } } as never)).toThrow(/decide/);
    await fiber.dispose();
  });

  it('无服务环境：activePreStepContributions = 空集（消费面零改写）', () => {
    // 上一个用例的 fiber dispose 后守卫式清空模块级活动指针
    expect(activePreStepContributions()).toEqual([]);
  });

  it('装配折叠：runtime.createAgent 把贡献注册进 per-Agent PreStepRegistry；拆卸后不折叠', async () => {
    // 超时预算 20s：用例内冷导入 runtime/tool/fixtures 模块图 + 两次完整
    // AgentRuntime 装配（比照 composition-hook-service 先例）。
    const root = new Context();
    const fiber = await root.plugin(preStepServicePlugin);
    root.preStep.register(enterContribution('acme/pre', 'FOLDED'));

    const { AgentRuntime } = await import('../src/agent/runtime/runtime');
    const { ToolRegistry } = await import('../src/agent/tool');
    const { scriptedProvider, readOnlyTool } = await import('./convergence/helpers/fixtures');
    const rt = new AgentRuntime(); // 无 projectPath → 纯内存
    await rt.ready();
    const tools = new ToolRegistry();
    tools.register(readOnlyTool());
    const handle = await rt.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools,
      eventSink: () => {},
    });
    // Agent 的 preStep 面是 private（setPreStep 接线语义）——经运行时行为面验证折叠：
    const agentInner = (handle as unknown as { _getAgent(): { preStep: PreStepRegistry | null } })._getAgent();
    const decision = await agentInner.preStep!.decide({
      agentId: 'x',
      step: 0,
      signal: new AbortController().signal,
    });
    expect(decision).toEqual({ action: 'enter', messages: [{ content: '[FOLDED]' }] });

    handle.dispose();
    await fiber.dispose();
    // 通道拆卸后新装配不再折叠（生效时机 = 装配时点快照）
    const rt2 = new AgentRuntime();
    await rt2.ready();
    const tools2 = new ToolRegistry();
    tools2.register(readOnlyTool());
    const handle2 = await rt2.createAgent({
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: tools2,
      eventSink: () => {},
    });
    const agent2Inner = (handle2 as unknown as { _getAgent(): { preStep: PreStepRegistry | null } })._getAgent();
    const decision2 = await agent2Inner.preStep!.decide({
      agentId: 'x',
      step: 0,
      signal: new AbortController().signal,
    });
    expect(decision2).toEqual({ action: 'enter' }); // 无贡献 = 直通 enter
    handle2.dispose();
  }, 20_000);
});
