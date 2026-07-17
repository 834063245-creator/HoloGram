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
import { AgentStore } from '../src/agent/agent-store';
import { GoalManager } from '../src/agent/goal-manager';
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

/** Live in-memory FS(同 rpc 面,状态真实流转) */
function mockLiveFs(initial: Record<string, string> = {}): Map<string, string> {
  const files = new Map<string, string>(Object.entries(initial));
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'create_directory') return null;
    if (method === 'write_file_content') {
      files.set(params.filePath as string, params.content as string);
      return '(mock: file saved)';
    }
    if (method === 'read_file_content') {
      const v = files.get(params.filePath as string);
      if (v === undefined) throw new Error(`ENOENT: ${params.filePath}`);
      return v;
    }
    if (method === 'delete_file_or_dir') {
      const p = params.path as string;
      for (const k of [...files.keys()]) {
        if (k === p || k.startsWith(p + '/')) files.delete(k);
      }
      return null;
    }
    if (method === 'list_directory') return '[]';
    throw new Error(`unexpected rpc: ${method}`);
  });
  return files;
}

function wireGoals(agent: Agent): GoalManager {
  const gm = new GoalManager('/proj');
  agent.setGoalManager(gm);
  return gm;
}

// ── Agent identity ──

describe('Agent identity', () => {
  beforeEach(() => mockLiveFs());

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

// ── Goal loop(GoalManager 驱动) ──

describe('Goal loop', () => {
  beforeEach(() => mockLiveFs());

  it('goal_report 上报完成 — 主通道,记录存为历史', async () => {
    const provider = steppedProvider([
      toolChunks('checking files', { id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/x.txt"}' }),
      toolChunks('', { id: 'c2', name: 'goal_report', arguments: '{"status":"completed","summary":"修好了"}' }),
      [DONE], // goal_report 后下一轮为空 → runLoop 返回
    ]);
    const agent = makeAgent(provider);
    const gm = wireGoals(agent);
    vi.spyOn(agent, 'saveState').mockResolvedValue(undefined);

    const result = await agent.runGoal(new AbortController().signal, 'fix auth bug');

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('修好了');
    const [rec] = await gm.list();
    expect(rec.status).toBe('completed');
    expect(rec.summary).toBe('修好了');
  });

  it('[GOAL_COMPLETE] 文本标记 — fallback 兼容旧会话', async () => {
    const provider = steppedProvider([
      toolChunks('working', { id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/x.txt"}' }),
      textChunks('[GOAL_COMPLETE] 修复完成,全部测试通过。'),
    ]);
    const agent = makeAgent(provider);
    const gm = wireGoals(agent);
    vi.spyOn(agent, 'saveState').mockResolvedValue(undefined);

    const result = await agent.runGoal(new AbortController().signal, 'fix auth bug');

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('[GOAL_COMPLETE]');
    const [rec] = await gm.list();
    expect(rec.status).toBe('completed');
  });

  it('[GOAL_FAILED] → failed,记录保留可查', async () => {
    const provider = steppedProvider([
      textChunks('[GOAL_FAILED] 缺少必要的 API 密钥,无法继续。'),
    ]);
    const agent = makeAgent(provider);
    const gm = wireGoals(agent);

    const result = await agent.runGoal(new AbortController().signal, 'impossible goal');
    expect(result.status).toBe('failed');
    const [rec] = await gm.list();
    expect(rec.status).toBe('failed');
    expect(rec.summary).toContain('API');
  });

  it('连续无工具调用 → 停滞判失败', async () => {
    const provider = steppedProvider([
      textChunks('分析中...需要更多信息。'),
      textChunks('继续分析...依赖关系复杂。'),
      textChunks('深入研究...缺少上下文。'),
      textChunks('不会到这里'),
    ]);
    const agent = makeAgent(provider);
    wireGoals(agent);

    const result = await agent.runGoal(new AbortController().signal, 'vague goal');
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('轮未执行任何工具调用');
  });

  it('每轮迭代都快照到 goal 专属槽', async () => {
    // 纯文本轮结束一次迭代(工具调用会让 runLoop 继续,同属一轮)
    const provider = steppedProvider([
      textChunks('推进中'),
      textChunks('继续推进'),
      textChunks('[GOAL_COMPLETE] done'),
    ]);
    const agent = makeAgent(provider);
    const gm = wireGoals(agent);
    const saveSpy = vi.spyOn(gm, 'saveSession');
    vi.spyOn(agent, 'saveState').mockResolvedValue(undefined);

    await agent.runGoal(new AbortController().signal, 'snapshot check');
    // 3 轮迭代,每轮至少一次快照
    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    const [rec] = await gm.list();
    const snap = await gm.loadSession(rec.id);
    expect(snap).not.toBeNull();
    expect(JSON.stringify(snap)).toContain('<goal>');
  });
});

// ── Goal resume ──

describe('Goal resume', () => {
  beforeEach(() => mockLiveFs());

  it('无 GoalManager → failed', async () => {
    const result = await makeAgent().resumeGoal(new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('目标管理器未初始化');
  });

  it('无活体目标 → failed', async () => {
    const agent = makeAgent();
    wireGoals(agent);
    const result = await agent.resumeGoal(new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('没有可恢复的目标');
  });

  it('崩溃遗留的 active 记录可直接恢复(Bug 3 回归)', async () => {
    const agent = makeAgent(steppedProvider([textChunks('[GOAL_COMPLETE] 接上完成。')]));
    const gm = wireGoals(agent);
    // 模拟崩溃遗留:status 还是 active,快照已在槽里
    const rec = await gm.create('crash goal');
    await gm.saveSession(rec.id, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'crash context 关键现场' },
    ] as any[]);

    const result = await agent.resumeGoal(new AbortController().signal);
    expect(result.status).toBe('completed');
    // 快照已载入,且重注了完整 <goal> 提示词(Bug 2 回归)
    const session = agent.getSession();
    expect(session.some((m) => m.content === 'crash context 关键现场')).toBe(true);
    expect(session.some((m) => typeof m.content === 'string' && m.content.includes('<goal>'))).toBe(true);
  });
});

// ── Pause session isolation(Bug 1 核心回归) ──

describe('Pause session isolation', () => {
  beforeEach(() => mockLiveFs());

  function pauseProvider(afterPause: () => Chunk[]): Provider {
    let callCount = 0;
    let abortReady: () => void;
    (pauseProvider as any)._ready = new Promise<void>((r) => { abortReady = r; });
    return {
      name: () => 'mock',
      stream: async function* (signal: AbortSignal) {
        callCount++;
        if (callCount === 1) {
          yield { type: ChunkType.Text, text: 'step 1' };
          yield { type: ChunkType.ToolCall, tool_call: { id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/a.txt"}' } };
          yield USG; yield DONE;
        } else if (callCount === 2) {
          yield DONE; // 空轮 → runLoop 返回,第 0 轮迭代完成
        } else if (callCount === 3) {
          yield { type: ChunkType.Text, text: 'step 2' };
          yield { type: ChunkType.ToolCall, tool_call: { id: 'c2', name: 'read_file_content', arguments: '{"filePath":"/b.txt"}' } };
          yield USG;
          abortReady();
          while (!signal.aborted) await new Promise((r) => setTimeout(r, 5));
          yield DONE;
        } else {
          for (const c of afterPause()) {
            if (signal.aborted) break;
            yield c;
          }
        }
      },
    };
  }

  it('暂停快照进 goal 槽;普通聊天覆盖不了 goal 现场(Bug 1 回归)', async () => {
    const provider = pauseProvider(() => textChunks('好的,收到'));
    const agent = makeAgent(provider);
    const gm = wireGoals(agent);
    agent.setAgentStore(new AgentStore('/proj'));

    const ctrl = new AbortController();
    const resultP = agent.runGoal(ctrl.signal, 'test goal');
    await (pauseProvider as any)._ready;
    ctrl.abort();

    const result = await resultP;
    expect(result.status).toBe('paused');
    // 内存 session 清成 [system](沿用隔离语义)
    expect(agent.getSession().length).toBe(1);
    expect(agent.getSession()[0].role).toBe('system');

    // goal 现场在 goal 槽里
    const [rec] = await gm.list();
    expect(rec.status).toBe('paused');
    const snapBefore = JSON.stringify(await gm.loadSession(rec.id));
    expect(snapBefore).toContain('<goal>');

    // 暂停后来一句普通聊天 — 旧架构这一句话就把 goal 现场毁了
    await agent.run(new AbortController().signal, '你好');
    // run() 里的 saveState 是 fire-and-forget,等它落盘
    await new Promise((r) => setTimeout(r, 20));

    // 普通聊天写它自己的槽(应有),goal 槽纹丝不动(关键断言)
    const mainSlot = await new AgentStore('/proj').load('test-agent');
    expect(JSON.stringify(mainSlot?.messages)).toContain('你好');
    const snapAfter = JSON.stringify(await gm.loadSession(rec.id));
    expect(snapAfter).toBe(snapBefore);
    expect(snapAfter).not.toContain('你好');
  });

  it('流中途中断(BodyStreamBuffer 式错误)也算暂停(暂停误判失败 回归)', async () => {
    let callCount = 0;
    let abortReady: () => void;
    const ready = new Promise<void>((r) => { abortReady = r; });
    const provider: Provider = {
      name: () => 'mock',
      stream: async function* (signal: AbortSignal) {
        callCount++;
        if (callCount === 1) {
          yield { type: ChunkType.Text, text: 'step 1' };
          yield { type: ChunkType.ToolCall, tool_call: { id: 'c1', name: 'read_file_content', arguments: '{"filePath":"/a.txt"}' } };
          yield USG; yield DONE;
        } else if (callCount === 2) {
          yield DONE; // 空轮 → 第 0 轮迭代完成
        } else {
          // 第 1 轮:流中途被掐断 — fetch 风格 abort 错误,不是 'aborted'
          yield { type: ChunkType.Text, text: 'partial' };
          abortReady();
          while (!signal.aborted) await new Promise((r) => setTimeout(r, 5));
          throw new Error('BodyStreamBuffer was aborted');
        }
      },
    };
    const agent = makeAgent(provider);
    const gm = wireGoals(agent);

    const ctrl = new AbortController();
    const resultP = agent.runGoal(ctrl.signal, 'stream abort goal');
    await ready;
    ctrl.abort();

    const result = await resultP;
    expect(result.status).toBe('paused');
    const [rec] = await gm.list();
    expect(rec.status).toBe('paused');
  });

  it('暂停 → 闲聊 → 恢复:现场还在,目标重注,跑到完成(Bug 1+2 回归)', async () => {
    const provider = pauseProvider(() => textChunks('[GOAL_COMPLETE] 恢复后搞定。'));
    const agent = makeAgent(provider);
    wireGoals(agent);

    const ctrl = new AbortController();
    const resultP = agent.runGoal(ctrl.signal, 'test goal');
    await (pauseProvider as any)._ready;
    ctrl.abort();
    expect((await resultP).status).toBe('paused');

    // 闲聊一句再恢复
    await agent.run(new AbortController().signal, '在吗');
    const resumed = await agent.resumeGoal(new AbortController().signal);

    expect(resumed.status).toBe('completed');
    expect(resumed.summary).toContain('[GOAL_COMPLETE]');
    const session = agent.getSession();
    expect(session.some((m) => typeof m.content === 'string' && m.content.includes('<goal>'))).toBe(true);
  });
});
