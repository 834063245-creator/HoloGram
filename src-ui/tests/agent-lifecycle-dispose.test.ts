// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent 句柄所有权 — dispose 生命周期收口测试
//
// 验证「句柄即所有权」契约：
//   1. handle.dispose() 从 runtime 注册表 + MessageBus 完全移除 Agent
//   2. dispose 幂等 — 重复调用为 no-op
//   3. disposeAll() 清空所有 Agent（Workspace 停用路径）
//   4. listAgents() 描述 — 会话主 Agent（main-<ts>-<rand>，parentId === null）
//      显示为「主Agent」而非旧的 id === 'main' 硬编码判断

import { describe, expect, it, vi } from 'vitest';

// ── bridge mock（同 lifecycle-integration.test.ts 的模式）──

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { AgentHandle } from '../src/agent/runtime/types';
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

describe('Agent 句柄所有权 — dispose 生命周期', () => {
  it('handle.dispose() 从 listAgents 和 MessageBus 中完全移除 Agent', async () => {
    const runtime = new AgentRuntime();
    const h1 = await createSessionAgent(runtime, 'main-1');
    const h2 = await createSessionAgent(runtime, 'main-2');

    expect(runtime.listAgents()).toHaveLength(2);
    expect(runtime.getBus().getAgent('main-1')).toBeDefined();

    h1.dispose();

    expect(runtime.listAgents().map((a) => a.id)).toEqual(['main-2']);
    expect(runtime.getBus().getAgent('main-1')).toBeUndefined();
    expect(runtime.getBus().getAgent('main-2')).toBeDefined();

    h2.dispose();
    expect(runtime.listAgents()).toHaveLength(0);
  });

  it('dispose 幂等 — 重复调用不抛异常、不产生副作用', async () => {
    const runtime = new AgentRuntime();
    const h1 = await createSessionAgent(runtime, 'main-1');

    h1.dispose();
    expect(runtime.listAgents()).toHaveLength(0);
    expect(() => h1.dispose()).not.toThrow();
    expect(runtime.listAgents()).toHaveLength(0);
  });

  it('disposeAll() 销毁所有 Agent — Workspace 停用路径', async () => {
    const runtime = new AgentRuntime();
    await createSessionAgent(runtime, 'main-1');
    await createSessionAgent(runtime, 'main-2');
    await createSessionAgent(runtime, 'main-3');
    expect(runtime.listAgents()).toHaveLength(3);

    runtime.disposeAll();

    expect(runtime.listAgents()).toHaveLength(0);
    expect(runtime.getBus().listAgents()).toHaveLength(0);
    // 幂等
    expect(() => runtime.disposeAll()).not.toThrow();
  });

  it('listAgents() 描述 — parentId === null 的会话主 Agent 显示为「主Agent」', async () => {
    const runtime = new AgentRuntime();
    // 模拟 workspace 工厂生成的 id 格式
    await createSessionAgent(runtime, 'main-1738000000-ab12');
    const agents = runtime.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].description).toBe('主Agent');
    runtime.disposeAll();
  });
});
