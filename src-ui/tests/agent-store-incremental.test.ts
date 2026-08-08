// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1-15 回归测试：Agent 会话增量写（NDJSON）。
// 修复前 saveState 每轮全量重写 session.json（O(全量) 写放大，对话越长每轮越贵）。
// 修复后：saveState 只 append 增量游标之后的新消息；会话缩短（撤回/替换）时 truncate 重建。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent/agent';
import { AgentStore } from '../src/agent/agent-store';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';

// ── Mock bridge ──
const fs = new Map<string, string>();
const appendCalls: Array<{ agentId: string; messages: any[]; rewrite: boolean }> = [];

const mockInvoke = vi.fn(async (_cmd: string, payload: any) => {
  const method = payload.method;
  const p = payload.params;
  switch (method) {
    case 'create_directory':
      return '{}';
    case 'write_file_content':
      fs.set(p.file_path, p.content);
      return '{}';
    case 'read_file_content': {
      const raw = fs.get(p.file_path);
      if (raw === undefined) throw new Error('not found');
      return raw;
    }
    case 'agent_session_append': {
      appendCalls.push({ agentId: p.agent_id, messages: p.messages, rewrite: !!p.rewrite });
      // 模拟后端行为：rewrite → truncate 重建；否则 append-only
      const nds = `${p.project_path}/.hologram/agents/${p.agent_id}/session.ndjson`;
      const block = p.messages.map((m: any) => JSON.stringify(m)).join('\n') + '\n';
      fs.set(nds, p.rewrite ? block : (fs.get(nds) ?? '') + block);
      return '{}';
    }
    default:
      throw new Error(`unexpected rpc: ${method}`);
  }
});

vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => {
    const normalized: Record<string, unknown> = {};
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
        normalized[snakeKey] = value;
      }
    }
    return mockInvoke('rpc', { method, params: normalized });
  },
  listen: vi.fn(),
  isMockMode: () => false,
}));

// ── Minimal mock provider — never actually streams in these tests ──
function mockProvider(): Provider {
  return {
    name: () => 'mock',
    stream: async function* (_signal: AbortSignal) {
      yield { type: 5 as any } as Chunk; // Done
    },
  };
}

function makeAgent(store: AgentStore): Agent {
  const a = new Agent(mockProvider(), new ToolRegistry(), 'sys', { agentId: 'main' });
  a.setAgentStore(store);
  return a;
}

function stateJson(): string {
  return JSON.stringify({
    id: 'main',
    parentId: null,
    description: '主Agent',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    subagentDepth: 0,
  });
}

beforeEach(() => {
  fs.clear();
  appendCalls.length = 0;
});

describe('P1-15 Agent 会话增量写', () => {
  it('多轮 saveState 增量写：每轮只 append 新增消息，不重写旧消息', async () => {
    const store = new AgentStore('/p');
    const a = makeAgent(store);

    // 第一轮：2 条新消息
    a.getSession().push(
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'hi' },
    );
    await a.saveState('running');
    // 第二轮：再 2 条新消息
    a.getSession().push(
      { role: 'user', content: '第二轮' },
      { role: 'assistant', content: 'ok' },
    );
    await a.saveState('done');

    // session = [sys] + 新消息 — 首轮 append [sys, 你好, hi]
    expect(appendCalls).toHaveLength(2);
    expect(appendCalls[0].messages.map((m) => m.content)).toEqual(['sys', '你好', 'hi']);
    expect(appendCalls[1].messages.map((m) => m.content)).toEqual(['第二轮', 'ok']);
    expect(appendCalls[0].rewrite).toBe(false);
    expect(appendCalls[1].rewrite).toBe(false);
  });

  it('会话缩短（撤回）→ saveState 触发 rewrite 全量重建', async () => {
    const store = new AgentStore('/p');
    const a = makeAgent(store);

    a.getSession().push(
      { role: 'user', content: 'm1' },
      { role: 'assistant', content: 'm2' },
      { role: 'user', content: 'm3' },
      { role: 'assistant', content: 'm4' },
    );
    await a.saveState();
    // session = [sys, m1, m2, m3, m4] — 首轮全量 append
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].messages).toHaveLength(5);

    // 撤回：splice(3) 移除 m3、m4 → session = [sys, m1, m2]（长度收缩）
    a.getSession().splice(3);
    await a.saveState();

    expect(appendCalls).toHaveLength(2);
    expect(appendCalls[1].rewrite).toBe(true);
    expect(appendCalls[1].messages).toHaveLength(3);
    expect(appendCalls[1].messages.map((m) => m.content)).toEqual(['sys', 'm1', 'm2']);
  });

  it('setSession 替换会话 → 游标重置，下次 saveState 全量重建', async () => {
    const store = new AgentStore('/p');
    const a = makeAgent(store);
    a.getSession().push({ role: 'user', content: '旧' });
    await a.saveState();
    expect(appendCalls).toHaveLength(1);

    // 外部恢复：替换会话
    a.setSession([{ role: 'system', content: 'sys' }, { role: 'user', content: '恢复的消息' }]);
    await a.saveState();

    expect(appendCalls).toHaveLength(2);
    expect(appendCalls[1].rewrite).toBe(false); // 新会话从空 ndjson 开始 append
    expect(appendCalls[1].messages.map((m) => m.content)).toEqual(['sys', '恢复的消息']);
  });
});

describe('P1-15 AgentStore.load NDJSON 读取', () => {
  it('读 session.ndjson 逐行解析', async () => {
    fs.set(
      '/p/.hologram/agents/main/state.json',
      stateJson(),
    );
    fs.set(
      '/p/.hologram/agents/main/session.ndjson',
      '{"role":"user","content":"a"}\n{"role":"assistant","content":"b"}\n',
    );
    const store = new AgentStore('/p');
    const r = await store.load('main');
    expect(r!.messages.map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('无 ndjson 时回退旧 session.json（JSON 数组）', async () => {
    fs.set('/p/.hologram/agents/main/state.json', stateJson());
    fs.set(
      '/p/.hologram/agents/main/session.json',
      JSON.stringify([{ role: 'user', content: '旧格式' }]),
    );
    const store = new AgentStore('/p');
    const r = await store.load('main');
    expect(r!.messages.map((m) => m.content)).toEqual(['旧格式']);
  });

  it('ndjson 优先于旧 session.json', async () => {
    fs.set('/p/.hologram/agents/main/state.json', stateJson());
    fs.set('/p/.hologram/agents/main/session.json', JSON.stringify([{ role: 'user', content: '旧' }]));
    fs.set('/p/.hologram/agents/main/session.ndjson', '{"role":"user","content":"新"}\n');
    const store = new AgentStore('/p');
    const r = await store.load('main');
    expect(r!.messages.map((m) => m.content)).toEqual(['新']);
  });
});
