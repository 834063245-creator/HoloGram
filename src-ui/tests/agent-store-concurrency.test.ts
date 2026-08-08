// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1-13 回归测试：AgentStore index.json 读-改-写串行化。
// 修复前 _upsertIndex/delete 是「list() 读 → 改内存 → write 写回」，中间多个 await
// 让出事件循环，多 Agent 并发 saveState 时后写者用旧快照覆盖前者记录。
// 修复后读-改-写包进 _indexChain，按调用序串行落盘。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── 内存文件系统 mock ──
// write 带 ~8ms 延迟：拉宽「读后写前」窗口，让并发交错的丢失现场真实可复现。
const fs = new Map<string, string>();
const WRITE_DELAY_MS = 8;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const mockInvoke = vi.fn(async (_cmd: string, payload: any) => {
  const method = payload.method;
  const p = payload.params;
  switch (method) {
    case 'create_directory':
      return '{}';
    case 'write_file_content': {
      await delay(WRITE_DELAY_MS);
      fs.set(p.file_path, p.content);
      return '{}';
    }
    case 'read_file_content': {
      const raw = fs.get(p.file_path);
      if (raw === undefined) throw new Error('not found');
      return raw;
    }
    case 'delete_file_or_dir':
      for (const k of [...fs.keys()]) {
        if (k.startsWith(p.path)) fs.delete(k);
      }
      return '{}';
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

import { AgentStore } from '../src/agent/agent-store';

const INDEX_PATH = '/test/project/.hologram/agents/index.json';

beforeEach(() => {
  fs.clear();
});

describe('P1-13 AgentStore index.json 写链串行化', () => {
  it('并发 save 两个不同 agent → 两条记录都保留（修复前丢一条）', async () => {
    const store = new AgentStore('/test/project');
    await Promise.all([
      store.save('agent-a', { description: 'A', status: 'running' }),
      store.save('agent-b', { description: 'B', status: 'running' }),
    ]);
    const all = await store.list();
    const ids = all.map((r) => r.id).sort();
    expect(ids).toEqual(['agent-a', 'agent-b']);
  });

  it('并发 save 同一 agent → 后写者赢，记录不被旧快照覆盖', async () => {
    const store = new AgentStore('/test/project');
    await Promise.all([
      store.save('agent-x', { description: '第一版', status: 'idle' }),
      store.save('agent-x', { description: '第二版', status: 'done' }),
    ]);
    const all = await store.list();
    const rec = all.find((r) => r.id === 'agent-x');
    expect(rec).toBeDefined();
    expect(rec!.description).toBe('第二版');
    expect(rec!.status).toBe('done');
  });

  it('并发 save + delete 交错 → delete 生效且不复活（修复前可能把已删记录写回）', async () => {
    const store = new AgentStore('/test/project');
    await store.save('agent-c', { description: 'C', status: 'idle' });
    await Promise.all([
      store.delete('agent-c'),
      store.save('agent-d', { description: 'D', status: 'idle' }),
    ]);
    const all = await store.list();
    const ids = all.map((r) => r.id);
    expect(ids).toContain('agent-d');
    expect(ids).not.toContain('agent-c');
  });

  it('多轮 save 后 list 形状稳定（无重复、无残留）', async () => {
    const store = new AgentStore('/test/project');
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        store.save('agent-e', { description: `e-${i}`, status: 'running' }),
        store.save('agent-f', { description: `f-${i}`, status: 'running' }),
      ]);
    }
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === 'agent-e')!.description).toBe('e-4');
    expect(all.find((r) => r.id === 'agent-f')!.description).toBe('f-4');
    // index.json 必须仍是合法 JSON 数组
    const raw = fs.get(INDEX_PATH)!;
    expect(JSON.parse(raw)).toHaveLength(2);
  });
});
