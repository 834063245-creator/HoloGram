// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-store 回归测试（P1 事件归零：prompt:ask → state/ask-store；
// 见 docs/plans/eventbus-zero-and-ui-split-plan.md 风险表——callback 生命周期）。
// 覆盖：
//   1. pushAsk 递增 seq；consumeAsk 取走 pending 并清空（幂等，不会双消费）
//   2. pending 期 chat-core 重建：构造即回放在途请求（bus 时代 emit 早于订阅即丢失）
//   3. 已消费的请求不会被第二个 chat-core 实例重复回答

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock bridge / 重模块（与 audit-fixes.test.ts 同款 ChatCore 构造前置）──
const mockInvoke = vi.fn();
async function mockRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const normalized: Record<string, unknown> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const snakeKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      normalized[snakeKey] = value;
    }
  }
  return mockInvoke('rpc', { method, params: normalized });
}
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'test', apiKey: 'k', baseUrl: '', model: 'm', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  CHAT_MODES: [],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('gsap', () => {
  const tween = () => ({ kill: vi.fn(), play: vi.fn(), pause: vi.fn() });
  return {
    default: {
      set: vi.fn(),
      to: vi.fn(tween),
      from: vi.fn(tween),
      fromTo: vi.fn(tween),
      killTweensOf: vi.fn(),
      isTweening: vi.fn(() => false),
      utils: { toArray: vi.fn(() => []) },
    },
    gsap: { set: vi.fn() },
  };
});
vi.mock('highlight.js', () => ({ default: { highlightElement: vi.fn() } }));

import { type AskRequest, pushAsk, useAskStore } from '../src/state/ask-store';

function makeReq(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    id: 'ask-1',
    question: '继续吗？',
    header: '确认',
    options: [{ label: '继续', description: '' }],
    multiSelect: false,
    callback: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  useAskStore.setState({ pending: null, seq: 0 });
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue('ok');
});

describe('ask-store（prompt:ask 退役）', () => {
  it('pushAsk 递增 seq；consumeAsk 取走 pending 并清空（幂等）', () => {
    const req = makeReq();
    expect(useAskStore.getState().seq).toBe(0);

    pushAsk(req);
    expect(useAskStore.getState().seq).toBe(1);
    expect(useAskStore.getState().pending).toBe(req);

    expect(useAskStore.getState().consumeAsk()).toBe(req);
    expect(useAskStore.getState().pending).toBeNull();
    // 幂等：第二次消费返回 null，不会把同一请求交给两个消费者
    expect(useAskStore.getState().consumeAsk()).toBeNull();
  });

  it('pending 期 chat-core 重建：构造即回放，无 shelf 时 callback(null) 恰好一次', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const cb = vi.fn();
    // 无任何 chat-core 存活时请求到达（旧 bus 语义下此刻 emit 即静默丢失）
    pushAsk(makeReq({ id: 'ask-orphan', callback: cb }));

    // 重建 chat-core —— 构造函数应回放在途 pending
    new ChatCore();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null);

    // 第二个实例构造时请求已被消费——不得重复回答
    new ChatCore();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('订阅者在 pushAsk 后同步收到请求（等价旧 bus.emit 同步分发语义）', async () => {
    const { ChatCore } = await import('../src/app/chat/chat-core');
    const cb = vi.fn();
    new ChatCore(); // 先有实例（订阅就位）
    expect(cb).not.toHaveBeenCalled();

    pushAsk(makeReq({ id: 'ask-live', callback: cb }));
    // zustand subscribe 同步通知 —— 与 bus.emit 的同步时序等价
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null);
  });
});
