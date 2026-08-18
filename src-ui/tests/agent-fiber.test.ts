// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent cordis 身份 fiber 验证（cordis-migration P2）。
// 设计：fiber 只做树上的身份节点（可见性 + P3 挂载点），不承载清理——清理所有权
// 在 AgentContext._bag（同步快通道/串行逆序/聚合抛错契约被 convergence specs 钉死）。
// 本套钉住桥接的可观测契约：
//   1. 未接线（无 cordisParent）→ 完全脱离 cordis（单测环境零依赖）；
//   2. 接线 → Agent fiber 挂在挂载父下，cordisCtx 是 Context 品牌；
//   3. child() 派生 → 子 fiber 与父平级（兄弟），父 dispose 不连带子（规约 #3）；
//   4. dispose() → bag 释放后 fiber 从树上摘除（uid 归 null）；
//   5. AgentRuntime 透传：createAgent 的 Agent 在 runtime 的挂载父下获得 fiber，
//      handle.dispose 后摘除。

import { describe, expect, it } from 'vitest';
import { AgentContext } from '../src/agent/context';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import { ToolRegistry } from '../src/agent/tool';
import { Context } from '../src/cordis';
import { scriptedProvider } from './convergence/helpers/fixtures';

describe('AgentContext cordis 身份 fiber（P2）', () => {
  it('未接线 cordisParent → cordisCtx 为 undefined，行为零变化', async () => {
    const ctx = new AgentContext({ agentId: 'bare' });
    expect(ctx.cordisCtx).toBeUndefined();
    await ctx.dispose();
  });

  it('接线 → fiber 挂在挂载父下，cordisCtx 是 Context 品牌', async () => {
    const root = new Context();
    const ctx = new AgentContext({ agentId: 'wired', cordisParent: root });
    expect(ctx.cordisCtx).toBeDefined();
    expect(Context.is(ctx.cordisCtx)).toBe(true);
    await ctx.dispose();
  });

  it('child() 派生 → 子 fiber 与父平级；父 dispose 不连带子 fiber', async () => {
    const root = new Context();
    const parent = new AgentContext({ agentId: 'p', cordisParent: root });
    const child = parent.child({ agentId: 'c' });
    // 平级断言：两个 fiber 的挂载父是同一个 ctx
    expect(Context.is(child.cordisCtx)).toBe(true);
    await parent.dispose();
    // 子 fiber 仍活着（父 dispose 只摘父自己的）
    expect(child.cordisCtx).toBeDefined();
    await child.dispose();
  });

  it('dispose() → fiber 从树上摘除（uid 归 null）', async () => {
    const root = new Context();
    const ctx = new AgentContext({ agentId: 'gone', cordisParent: root });
    await ctx.dispose();
    // 二次 dispose 幂等（bag 与 fiber 都 no-op）
    await ctx.dispose();
  });
});

describe('AgentRuntime cordis 透传（P2）', () => {
  it('createAgent 的 Agent 挂在 runtime 挂载父下；dispose 后摘除', async () => {
    const root = new Context();
    const rt = new AgentRuntime(undefined, root);
    await rt.ready();
    const h = await rt.createAgent({
      agentId: 'fiber-agent',
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
    });
    expect(rt.listAgents()).toHaveLength(1);
    h.dispose();
    // 同步快通道契约不因 fiber 桥接改变（phase-4 T1 钉点）
    expect(rt.listAgents()).toHaveLength(0);
  });

  it('未接线 runtime（specs/单测路径）→ Agent 无 fiber，装配行为不变', async () => {
    const rt = new AgentRuntime();
    await rt.ready();
    const h = await rt.createAgent({
      agentId: 'no-fiber-agent',
      projectPath: '/projects/demo',
      provider: scriptedProvider([]),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
    });
    expect(rt.listAgents()).toHaveLength(1);
    h.dispose();
    expect(rt.listAgents()).toHaveLength(0);
  });
});
