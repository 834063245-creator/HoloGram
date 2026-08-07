// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 摘要模型自动选择回归测试（2026-08-07 修复）：
// 旧实现用裸 loadSettings() —— localStorage 不落 key，keyed 永远为空，
// 特性从未触发。修复后走 loadSettingsWithSecrets()（加密凭据回填）。
// 规则：已配置 key 的模型中，窗口 ≥ 64K 且输入价严格低于主模型者取最低。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { Agent } from '../src/agent/agent';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';

function mockProvider(name: string): Provider {
  return {
    name: () => name,
    stream: async function* (_signal: AbortSignal) {
      yield { type: 5 as any } as Chunk; // Done
    },
  };
}

const SETTINGS_WITH_TWO_PROVIDERS = {
  activeProvider: 'deepseek',
  providers: [
    { kind: 'openai', name: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
    { kind: 'anthropic', name: 'minimax', apiKey: '', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3' },
  ],
  projectPath: '.',
  agent: { temperature: 0.7, contextWindow: 0 },
  display: { language: 'zh', fontScale: 1 },
};

beforeEach(() => {
  mockRpc.mockReset();
  localStorage.clear();
  localStorage.setItem('hologram_settings', JSON.stringify(SETTINGS_WITH_TWO_PROVIDERS));
});

describe('selectSummaryProvider（B1 修复回归）', () => {
  it('凭据回填后能选到更便宜的 keyed 模型（旧 bug：keyed 永远为空）', async () => {
    mockRpc.mockImplementation(async (method: string) => (method === 'credential_get' ? '"sk-x"' : 'null'));
    const main = mockProvider('deepseek');
    const agent = new Agent(main, new ToolRegistry(), 'sys', {});
    const result = await (agent as any).selectSummaryProvider();
    // deepseek-v4-pro (in=0.435) → 目录内最便宜 keyed 候选 deepseek-v4-flash (0.14, 1M)
    expect(result.prov).not.toBe(main);
    expect(result.prov.name()).toBe('deepseek');
    expect(result.window).toBe(1000000);
  });

  it('无任何凭据时回退主模型（行为不变）', async () => {
    mockRpc.mockResolvedValue('null');
    const main = mockProvider('deepseek');
    const agent = new Agent(main, new ToolRegistry(), 'sys', {});
    const result = await (agent as any).selectSummaryProvider();
    expect(result.prov).toBe(main);
  });

  it('summaryProvider 缓存选择结果（第二次不再读凭据）', async () => {
    mockRpc.mockImplementation(async (method: string) => (method === 'credential_get' ? '"sk-x"' : 'null'));
    const agent = new Agent(mockProvider('deepseek'), new ToolRegistry(), 'sys', {});
    const first = await (agent as any).summaryProvider();
    const callsAfterFirst = mockRpc.mock.calls.length;
    const second = await (agent as any).summaryProvider();
    expect(second).toBe(first);
    expect(mockRpc.mock.calls.length).toBe(callsAfterFirst);
  });
});
