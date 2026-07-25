// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Phase 4 协作能力测试
//
// 验证：
//   1. DiscoveryBoard post → query 内容正确
//   2. DiscoveryBoard 持久化 flush → restore 往返
//   3. agent_request reply — A request B → B reply → A 收到回复
//   4. agent_request timeout — 不回复 → 超时返回错误
//   5. SubAgentPool queue — 池满时排队，完成后 dequeue

import { describe, expect, it, vi } from 'vitest';

// ── bridge mock ──
// vi.hoisted: vitest v4 hoists vi.mock factories above module-level code,
// so mockRpc must be hoisted too or the factory references undefined.
const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
}));
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { DiscoveryBoard } from '../src/agent/discovery-board';
import { MessageBus } from '../src/agent/message-bus';
import { MeshTopology } from '../src/agent/topology';
import { SubAgentPool, SubAgentStatus } from '../src/agent/coordinator';
import type { AgentAddress } from '../src/agent/message-types';
import { createRequestTool } from '../src/agent/tools/request';
import { createDiscoveryTools } from '../src/agent/tools/discovery';

// ── Helpers ──

function addr(agentId: string, parentId: string | null = null, depth = 0): AgentAddress {
  return { agentId, parentId, depth };
}

function makeBus(): MessageBus {
  return new MessageBus();
}

function fakeRun(result: string, delayMs = 10) {
  return (_signal: AbortSignal) =>
    new Promise<{ text: string; err?: string }>((resolve) => {
      setTimeout(() => resolve({ text: result }), delayMs);
    });
}

function fakeRunNever() {
  return () => new Promise<{ text: string; err?: string }>(() => {});
}

// ═══════════════════════════════════════════════════════
// DiscoveryBoard
// ═══════════════════════════════════════════════════════

describe('DiscoveryBoard', () => {
  it('test_discovery_post_query — post → query 内容正确', () => {
    const board = new DiscoveryBoard();
    board.post('agent-a', 'auth-location', 'src/auth.ts:42 — JWT 验证在此', 'architecture');
    board.post('agent-a', 'config-entry', 'src/config.ts — 所有配置入口', 'config');
    board.post('agent-b', 'null-bug', 'src/parser.ts:128 — null deref', 'bug');

    // Query all
    const all = board.getAll();
    expect(all.length).toBe(3);

    // Query by category
    const arch = board.query({ category: 'architecture' });
    expect(arch.length).toBe(1);
    expect(arch[0].key).toBe('auth-location');
    expect(arch[0].value).toContain('JWT');

    // Query by agent
    const byB = board.query({ agentId: 'agent-b' });
    expect(byB.length).toBe(1);
    expect(byB[0].key).toBe('null-bug');

    // Query by key
    const byKey = board.query({ key: 'auth-location' });
    expect(byKey.length).toBe(1);
    expect(byKey[0].category).toBe('architecture');
  });

  it('test_discovery_persistence — flush → restore 往返', async () => {
    const projectPath = '/tmp/test-phase4';
    mockRpc.mockReset();
    // ponytail: capture what flush writes, echo it back on restore.
    // Hardcoded fallback runs afoul of vitest v4 vi.mock hoisting where
    // the factory's mockRpc closure points at a different fn instance.
    let savedContent = '';
    mockRpc.mockImplementation(async (method: string, args: any) => {
      if (method === 'create_directory') return;
      if (method === 'write_file_content') {
        savedContent = args?.content || '';
        return;
      }
      if (method === 'read_file_content') {
        return savedContent;
      }
      return '';
    });

    const board = new DiscoveryBoard(projectPath);
    board.post('agent-a', 'test-key', 'test-value', 'architecture');
    await board.flush();

    // Create a fresh board and restore
    const restored = new DiscoveryBoard(projectPath);
    await restored.restore();
    const all = restored.getAll();
    expect(all.length).toBe(1);
    expect(all[0].key).toBe('test-key');
    expect(all[0].value).toBe('test-value');
  });

  it('test_discovery_tools — agent_discover + agent_lookup', async () => {
    const board = new DiscoveryBoard();
    const tools = createDiscoveryTools(board, () => 'agent-a');

    // Post a discovery
    const discoverResult = await tools[0].execute({ key: 'auth', value: 'auth in src/auth.ts', category: 'architecture' });
    expect(discoverResult).toContain('发现已发布');

    // Lookup
    const lookupAll = await tools[1].execute({});
    expect(lookupAll).toContain('auth in src/auth.ts');

    // Lookup by category
    const lookupCat = await tools[1].execute({ category: 'architecture' });
    expect(lookupCat).toContain('src/auth.ts');

    // Lookup non-existent
    const lookupNone = await tools[1].execute({ category: 'bug' });
    expect(lookupNone).toContain('没有匹配的发现');
  });
});

// ═══════════════════════════════════════════════════════
// agent_request
// ═══════════════════════════════════════════════════════

describe('agent_request', () => {
  it('test_agent_request_reply — A request B → B reply → A 收到回复', async () => {
    const bus = makeBus();
    bus.register(addr('agent-a'));
    bus.register(addr('agent-b', 'agent-a', 1));
    bus.setTopology(new MeshTopology());

    const toolA = createRequestTool(bus, () => 'agent-a');

    // Start request in background — it will block waiting for reply
    const requestPromise = toolA.execute({
      target: 'agent-b',
      type: 'question',
      content: 'auth 逻辑在哪？',
      timeout_seconds: 5,
    });

    // Simulate B receiving and replying (after a short delay)
    await new Promise((r) => setTimeout(r, 20));

    // B checks inbox, finds the request
    const inbox = bus.peekInbox('agent-b');
    expect(inbox.length).toBe(1);
    expect(inbox[0].type).toBe('request');
    const msgId = inbox[0].id;

    // B replies
    const replyId = bus.reply('agent-b', msgId, '在 src/auth.ts:42');

    // A should receive the reply
    const result = await requestPromise;
    expect(result).toContain('回复来自 agent-b');
    expect(result).toContain('src/auth.ts:42');
  });

  it('test_agent_request_timeout — 不回复 → 超时返回错误', async () => {
    const bus = makeBus();
    bus.register(addr('agent-a'));
    bus.register(addr('agent-b', 'agent-a', 1));
    bus.setTopology(new MeshTopology());

    const toolA = createRequestTool(bus, () => 'agent-a');

    // Request with very short timeout
    const result = await toolA.execute({
      target: 'agent-b',
      type: 'question',
      content: 'auth 逻辑在哪？',
      timeout_seconds: 0.05, // 50ms timeout — B won't reply in time
    });

    expect(result).toContain('超时');
    expect(result).toContain('agent-b');
  });

  it('test_agent_request_topology_denied — 拓扑不允许', async () => {
    const bus = makeBus();
    bus.register(addr('agent-a'));
    bus.register(addr('agent-b')); // no parent-child relationship
    // Use default TreeTopology — siblings can't communicate

    const toolA = createRequestTool(bus, () => 'agent-a');

    const result = await toolA.execute({
      target: 'agent-b',
      type: 'question',
      content: 'hello?',
    });

    expect(result).toContain('topology denied');
  });

  it('test_agent_request_unknown_target', async () => {
    const bus = makeBus();
    bus.register(addr('agent-a'));
    bus.setTopology(new MeshTopology());

    const toolA = createRequestTool(bus, () => 'agent-a');

    const result = await toolA.execute({
      target: 'nonexistent',
      type: 'question',
      content: 'hello?',
    });

    expect(result).toContain('topology denied');
  });
});

// ═══════════════════════════════════════════════════════
// SubAgentPool — queue on full
// ═══════════════════════════════════════════════════════

describe('SubAgentPool — queue', () => {
  it('test_pool_queue_on_full — 池满时排队，完成后 dequeue', async () => {
    const pool = new SubAgentPool(2); // max 2 concurrent

    // Fill the pool with 2 never-resolving agents
    const s1 = pool.spawn('task-1', fakeRunNever())!;
    const s2 = pool.spawn('task-2', fakeRunNever())!;
    expect(pool.runningCount).toBe(2);

    // Third spawn should queue (not return null)
    const s3 = pool.spawn('task-3', fakeRun('done', 5));
    expect(s3).toBeTruthy();
    expect(s3!.id).toBeTruthy();
    expect(pool.runningCount).toBe(2); // still 2 running, 1 queued

    // Fourth spawn should also queue
    const s4 = pool.spawn('task-4', fakeRun('also-done', 5));
    expect(s4).toBeTruthy();
    expect(pool.runningCount).toBe(2);

    // Stop s1 — this should drain the queue and spawn s3
    pool.stop(s1.id);
    await new Promise((r) => setTimeout(r, 20)); // let drain run

    // Now s3 should be running (or already completed since it's fast)
    const h3 = await s3!.done;
    expect(h3.status === SubAgentStatus.Completed || h3.status === SubAgentStatus.Running).toBe(true);

    // Stop remaining agents
    pool.stopAll();
  });

  it('test_pool_queue_on_full_returns_null — 队列满时返回 null', () => {
    const pool = new SubAgentPool(1); // max 1 concurrent

    // Fill the pool
    pool.spawn('running', fakeRunNever());
    expect(pool.runningCount).toBe(1);

    // Fill the queue (20 slots) + 1 should return null
    for (let i = 0; i < 20; i++) {
      const s = pool.spawn(`queued-${i}`, fakeRun('ok', 5));
      expect(s).toBeTruthy();
    }

    // 第 21 个入队请求应返回 null
    const overflow = pool.spawn('overflow', fakeRun('nope', 5));
    expect(overflow).toBeNull();

    pool.stopAll();
  });

  it('test_pool_callid_dedup_in_queue — callId 去重跨 running + queue', () => {
    const pool = new SubAgentPool(1);

    // Fill pool
    pool.spawn('running', fakeRunNever());

    // Queue with callId
    const q1 = pool.spawn('queued', fakeRun('ok', 5), 'call-001');
    expect(q1).toBeTruthy();

    // Duplicate callId in queue should return null
    const q2 = pool.spawn('dup', fakeRun('ignored', 5), 'call-001');
    expect(q2).toBeNull();

    pool.stopAll();
  });

  it('test_pool_is_queued — isQueued 正确反映排队状态', () => {
    const pool = new SubAgentPool(1);

    // Fill pool
    pool.spawn('running', fakeRunNever());

    // Queue
    const q = pool.spawn('queued', fakeRun('ok', 5));
    expect(q).toBeTruthy();
    expect(pool.isQueued(q!.id)).toBe(true);

    // Running agent is not queued
    pool.stopAll();
  });
});
