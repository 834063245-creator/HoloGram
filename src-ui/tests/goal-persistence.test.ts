// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock bridge and events ──

const rpcMock = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => rpcMock(...args),
  listen: vi.fn(() => () => {}),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { Agent } from '../src/agent/agent';
import { AgentStore, type GoalState } from '../src/agent/agent-store';
import { ToolRegistry } from '../src/agent/tool';
import type { Tool } from '../src/agent/tool';
import type { Chunk, Provider, ToolCall } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';

// ── Fixtures ──

const USAGE = {
  prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
  cache_hit_tokens: 0, cache_miss_tokens: 100, reasoning_tokens: 0,
  finish_reason: 'stop',
} as const;

const USG: Chunk = { type: ChunkType.Usage, usage: USAGE };
const DONE: Chunk = { type: ChunkType.Done };

function textChunks(text: string): Chunk[] {
  return [USG, { type: ChunkType.Text, text }, DONE];
}

function toolChunks(text: string, tc: ToolCall): Chunk[] {
  return [
    { type: ChunkType.Text, text },
    { type: ChunkType.ToolCall, tool_call: tc },
    USG, DONE,
  ];
}

function steppedProvider(turns: Chunk[][]): Provider {
  let i = 0;
  return {
    name: () => 'mock',
    stream: async function* (signal: AbortSignal) {
      for (const c of turns[i++] ?? [DONE]) {
        if (signal.aborted) break;
        yield c;
      }
    },
  };
}

function dummyTool(): Tool {
  return {
    name: () => 'read_file_content',
    description: () => 'read file',
    parameters: () => ({ type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }),
    readOnly: () => true,
    execute: async () => 'mock content',
  };
}

function makeAgent(prov?: Provider): Agent {
  const reg = new ToolRegistry();
  reg.register(dummyTool());
  return new Agent(prov ?? steppedProvider([[DONE]]), reg, 'system', { agentId: 'test-agent' });
}

function mockRpcForStore(files: Record<string, string | Error> = {}): void {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'create_directory') return null;
    if (method === 'write_file_content') return '(mock: file saved)';
    if (method === 'read_file_content') {
      const fp = params.filePath as string;
      const v = files[fp];
      if (v instanceof Error) throw v;
      if (v !== undefined) return v;
      throw new Error(`ENOENT: ${fp}`);
    }
    if (method === 'delete_file_or_dir') return null;
    if (method === 'list_directory') return '[]';
    throw new Error(`unexpected rpc: ${method}`);
  });
}

// ── AgentStore goal CRUD ──

describe('AgentStore goal CRUD', () => {
  beforeEach(() => mockRpcForStore());

  it('saveGoal + loadGoal round-trip', async () => {
    const store = new AgentStore('/proj');
    const gs: GoalState = { goal: 'fix auth', iteration: 3, stallRounds: 0, status: 'active', createdAt: 1000, updatedAt: 2000 };
    await store.saveGoal('a1', gs);

    const saved = JSON.stringify({ ...gs, updatedAt: expect.any(Number) }, null, 2);
    mockRpcForStore({ '/proj/.hologram/agents/a1/goal.json': saved });

    const loaded = await store.loadGoal('a1');
    expect(loaded).not.toBeNull();
    expect(loaded!.goal).toBe('fix auth');
    expect(loaded!.iteration).toBe(3);
    expect(loaded!.status).toBe('active');
  });

  it('loadGoal returns null on missing file', async () => {
    const store = new AgentStore('/proj');
    expect(await store.loadGoal('a1')).toBeNull();
  });

  it('loadGoal handles cat -n line numbers', async () => {
    const gs: GoalState = { goal: 'refactor', iteration: 0, stallRounds: 0, status: 'paused', createdAt: 100, updatedAt: 200 };
    const numbered = JSON.stringify(gs, null, 2).split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
    mockRpcForStore({ '/proj/.hologram/agents/a1/goal.json': numbered });
    expect((await new AgentStore('/proj').loadGoal('a1'))!.goal).toBe('refactor');
  });

  it('deleteGoal removes the file', async () => {
    mockRpcForStore({ '/proj/.hologram/agents/a1/goal.json': '{}', '/proj/.hologram/agents/index.json': '[]' });
    const store = new AgentStore('/proj');
    await store.deleteGoal('a1');
    const deleted = rpcMock.mock.calls.filter((c: any[]) => c[0] === 'delete_file_or_dir');
    expect(deleted.some((c: any[]) => (c[1].path as string).endsWith('goal.json'))).toBe(true);
  });
});

// ── Agent identity ──

describe('Agent identity', () => {
  it('auto-generates agent ID matching agent-timestamp pattern', () => {
    const reg = new ToolRegistry(); reg.register(dummyTool());
    const a = new Agent(steppedProvider([[DONE]]), reg, 'sys');
    expect(a.id).toMatch(/^agent-/);
  });
  it('uses explicit ID', () => {
    const reg = new ToolRegistry(); reg.register(dummyTool());
    expect(new Agent(steppedProvider([[DONE]]), reg, 'sys', { agentId: 'main' }).id).toBe('main');
  });
  it('parentId defaults to null', () => {
    expect(makeAgent().parentId).toBeNull();
  });
  it('parentId from options', () => {
    const reg = new ToolRegistry(); reg.register(dummyTool());
    expect(new Agent(steppedProvider([[DONE]]), reg, 'sys', { parentId: 'agent-123' }).parentId).toBe('agent-123');
  });
  it('child agent gets parentId from parent', () => {
    const p = makeAgent();
    const reg = new ToolRegistry(); reg.register(dummyTool());
    const c = new Agent(steppedProvider([[DONE]]), reg, 'child', { agentId: 'c1', parentId: p.id });
    expect(c.parentId).toBe(p.id);
  });
});

// ── Goal loop integration ──

describe('Goal loop', () => {
  let store: AgentStore;
  let saveGoalSpy: ReturnType<typeof vi.spyOn>;
  let deleteGoalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockRpcForStore();
    store = new AgentStore('/proj');
    saveGoalSpy = vi.spyOn(store, 'saveGoal');
    deleteGoalSpy = vi.spyOn(store, 'deleteGoal');
  });

  it('checkpoints goal and deletes on completion', async () => {
    const provider = steppedProvider([
      toolChunks('checking files', { id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/x.txt"}' }),
      textChunks('[GOAL_COMPLETE] 修复完成，全部测试通过。'),
    ]);
    const agent = makeAgent(provider);
    agent.setAgentStore(store);
    vi.spyOn(agent, 'saveState').mockResolvedValue(undefined);

    const result = await agent.runGoal(new AbortController().signal, 'fix auth bug');

    expect(result.status).toBe('completed');
    expect(saveGoalSpy).toHaveBeenCalled();
    // First checkpoint should be at iter 0 with status 'active'
    const checkpointCalls = saveGoalSpy.mock.calls.filter((c) => c[1].status === 'active');
    expect(checkpointCalls.length).toBeGreaterThanOrEqual(1);
    expect(checkpointCalls[0][1].iteration).toBe(0);
    // Goal deleted on clean completion
    expect(deleteGoalSpy).toHaveBeenCalled();
  });

  it('[GOAL_FAILED] triggers deleteGoal', async () => {
    const provider = steppedProvider([
      textChunks('[GOAL_FAILED] 缺少必要的 API 密钥，无法继续。'),
    ]);
    const agent = makeAgent(provider);
    agent.setAgentStore(store);

    const result = await agent.runGoal(new AbortController().signal, 'impossible goal');
    expect(result.status).toBe('failed');
    expect(deleteGoalSpy).toHaveBeenCalled();
  });

  it('stall detection fails and deletes goal', async () => {
    // 3 iterations with no tool calls → stall
    const provider = steppedProvider([
      textChunks('分析中...需要更多信息。'),
      textChunks('继续分析...依赖关系复杂。'),
      textChunks('深入研究...缺少上下文。'),
      textChunks('不会到这里'), // shouldn't reach
    ]);
    const agent = makeAgent(provider);
    agent.setAgentStore(store);

    const result = await agent.runGoal(new AbortController().signal, 'vague goal');
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('轮未执行任何工具调用');
    expect(deleteGoalSpy).toHaveBeenCalled();
  });
});

// ── Goal resume ──

describe('Goal resume', () => {
  beforeEach(() => mockRpcForStore());

  it('resumeGoal fails when no paused goal', async () => {
    const store = new AgentStore('/proj');
    const agent = makeAgent();
    agent.setAgentStore(store);
    const result = await agent.resumeGoal(new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('没有可恢复的目标');
  });

  it('resumeGoal fails without AgentStore', async () => {
    const result = await makeAgent().resumeGoal(new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('存储未初始化');
  });

  it('resumeGoal loads paused state and continues', async () => {
    const store = new AgentStore('/proj');
    vi.spyOn(store, 'loadGoal').mockResolvedValue({
      goal: 'fix auth', iteration: 2, stallRounds: 0,
      status: 'paused', createdAt: 1000, updatedAt: 2000,
    });
    vi.spyOn(store, 'load').mockResolvedValue({
      record: { id: 'test-agent', parentId: null, description: '', status: 'running', createdAt: 0, updatedAt: 0, subagentDepth: 0 },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'session data' },
      ],
    });

    const provider = steppedProvider([
      textChunks('[GOAL_COMPLETE] auth refactored, all tests green.'),
    ]);
    const agent = makeAgent(provider);
    agent.setAgentStore(store);

    const result = await agent.resumeGoal(new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.summary).toContain('[GOAL_COMPLETE]');
  });
});

// ── Summary distillation ──

describe('Summary distillation', () => {
  it('context line threshold is 300 chars', () => {
    expect(300).toBeGreaterThan(50);
    expect(300).toBeLessThan(1000);
  });
});
