// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 多会话 TaskBoard/DiscoveryBoard 路由 — bindSession 静态绑定回归测试
//
// 缺陷背景：proxies 曾绑到创建时刻会话的 board（工厂不传 sessionId → 恒 'default'），
// setCurrentSession 只重定向「最新创建」会话 Agent 的 proxy → 切回旧会话后，
// 该会话 Agent 的 board 写入仍落到 'default' 板，Agents 面板条目混杂/丢失。
//
// 修复后（句柄即所有权，与 80864dd 对称）：
//   - AgentHandle.bindSession(sessionId) 把该 Agent 自己的 proxies 静态绑到其会话的 board
//   - setCurrentSession 仅做 board 懒加载恢复（面板查询语义），不再改写任何绑定
//   - 子 Agent 经 _agentSessions.get(parentId) 继承父会话

import { describe, expect, it, vi } from 'vitest';

// ── bridge mock（同 agent-lifecycle-dispose.test.ts 的模式）──

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import type { DiscoveryBoardProxy } from '../src/agent/discovery-board';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { AgentHandle } from '../src/agent/runtime/types';
import type { TaskBoardProxy } from '../src/agent/task-board';
import { ToolRegistry } from '../src/agent/tool';

function mockProvider(): any {
  return { name: () => 'mock-provider' };
}

/** 以最小配置创建一个会话主 Agent（无 pool/graph/memory — 跳过外部依赖） */
function createSessionAgent(runtime: AgentRuntime, agentId: string): Promise<AgentHandle> {
  return runtime.createAgent({
    agentId,
    parentId: null,
    projectPath: '/fake/project',
    provider: mockProvider(),
    tools: new ToolRegistry(),
    systemPrompt: 'test system prompt',
  });
}

/** 取出 Agent 实际写 board 时经过的 proxy（spawnSubAgent async 注册/完成路径） */
function taskProxyOf(handle: AgentHandle): TaskBoardProxy {
  return (handle as any)._getAgent()._taskBoard as TaskBoardProxy;
}
function discoveryProxyOf(handle: AgentHandle): DiscoveryBoardProxy {
  return (handle as any)._getAgent()._discoveryBoard as DiscoveryBoardProxy;
}

describe('多会话 board 路由 — bindSession 静态绑定', () => {
  it('切到会话 B 后，会话 A 派发的 async 子 Agent 条目仍落在 A 的板上', async () => {
    const runtime = new AgentRuntime();
    // 开会话 A、B — 工厂创建时不带 sessionId（模拟 chat store 时序：id 后分配）
    const hA = await createSessionAgent(runtime, 'main-a');
    const hB = await createSessionAgent(runtime, 'main-b');
    // 会话层登记句柄时静态绑定（chat-session.ts 的 4 个 setAgent 时点）
    hA.bindSession('1');
    hB.bindSession('2');

    // 切到会话 B（面板 2s 轮询也会反复调 setCurrentSession）
    runtime.setCurrentSession('2');

    // A 的 Agent 派发 async 子 Agent — spawnSubAgent 经父 Agent 的 proxy 写 board
    taskProxyOf(hA).register({
      agentId: 'sub-a-1',
      parentAgentId: 'main-a',
      description: 'A 的异步子任务',
      isolationId: null,
    });
    discoveryProxyOf(hA).post('main-a', 'route-key', 'route-value', 'explore');

    // 条目必须落在 A 会话的板（'1'）— 不是 default，也不是 B（'2'）
    expect(runtime.getTaskBoard('1').getEntry('sub-a-1')).toBeDefined();
    expect(runtime.getTaskBoard('2').getEntry('sub-a-1')).toBeUndefined();
    expect(runtime.getTaskBoard('default').getEntry('sub-a-1')).toBeUndefined();

    expect(runtime.getDiscoveryBoard('1').getAll()).toHaveLength(1);
    expect(runtime.getDiscoveryBoard('2').getAll()).toHaveLength(0);
    expect(runtime.getDiscoveryBoard('default').getAll()).toHaveLength(0);

    // 对称：B 的写入落在 B 的板上
    taskProxyOf(hB).register({
      agentId: 'sub-b-1',
      parentAgentId: 'main-b',
      description: 'B 的异步子任务',
      isolationId: null,
    });
    expect(runtime.getTaskBoard('2').getEntry('sub-b-1')).toBeDefined();
    expect(runtime.getTaskBoard('1').getEntry('sub-b-1')).toBeUndefined();

    runtime.disposeAll();
  });

  it('setCurrentSession 不再改写任何 Agent 的 board 绑定', async () => {
    const runtime = new AgentRuntime();
    const hA = await createSessionAgent(runtime, 'main-a');
    hA.bindSession('1');

    expect(taskProxyOf(hA).target).toBe(runtime.getTaskBoard('1'));
    expect(discoveryProxyOf(hA).target).toBe(runtime.getDiscoveryBoard('1'));

    // 反复切换活跃会话（面板轮询语义）— A 的 proxies 恒指向 '1'
    runtime.setCurrentSession('2');
    runtime.setCurrentSession('default');
    runtime.setCurrentSession('1');
    expect(taskProxyOf(hA).target).toBe(runtime.getTaskBoard('1'));
    expect(discoveryProxyOf(hA).target).toBe(runtime.getDiscoveryBoard('1'));

    runtime.disposeAll();
  });

  it('子 Agent 继承父会话 — createAgent 读 bindSession 之后的映射', async () => {
    const runtime = new AgentRuntime();
    const hA = await createSessionAgent(runtime, 'main-a');
    hA.bindSession('1');

    // 父绑定之后再创建子 Agent — 经 _agentSessions.get(parentId) 继承 '1'
    const sub = await runtime.createAgent({
      agentId: 'sub-1',
      parentId: 'main-a',
      projectPath: '/fake/project',
      provider: mockProvider(),
      tools: new ToolRegistry(),
      systemPrompt: 'sub',
    });
    expect(taskProxyOf(sub).target).toBe(runtime.getTaskBoard('1'));

    taskProxyOf(sub).register({
      agentId: 'sub-1-child',
      parentAgentId: 'sub-1',
      description: '子 Agent 的 board 写入',
      isolationId: null,
    });
    expect(runtime.getTaskBoard('1').getEntry('sub-1-child')).toBeDefined();
    expect(runtime.getTaskBoard('default').getEntry('sub-1-child')).toBeUndefined();

    runtime.disposeAll();
  });

  it('dispose 后 bindSession 为 no-op — 与 dispose 幂等风格一致', async () => {
    const runtime = new AgentRuntime();
    const hA = await createSessionAgent(runtime, 'main-a');
    hA.bindSession('1');
    hA.dispose();

    // 句柄已销毁 — proxies 已从注册表清除，重绑不抛异常、无副作用
    expect(() => hA.bindSession('2')).not.toThrow();
    expect(runtime.listAgents()).toHaveLength(0);
  });
});
