import { describe, it, expect, vi } from 'vitest';

// Hoisted mocks — must be before workspace.ts import
vi.mock('../src/bridge', () => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/chat', () => ({ ChatPanel: class {} }));
vi.mock('../src/ui/check', () => ({ CheckPanel: class {} }));
vi.mock('../src/agent/agent', () => ({ Agent: class {} }));
vi.mock('../src/agent/tool', () => ({
  ToolRegistry: class { register() {} alias() {} all() { return []; } schemas() { return []; } get() { return null; } },
  createHologramTools: () => [],
  createCodingTools: () => [],
  createSubAgentTool: () => ({}),
}));
vi.mock('../src/agent/permission', () => ({ showApprovalDialog: vi.fn() }));
vi.mock('../src/agent/memory', () => ({
  MemoryManager: class {},
  createMemoryTools: () => [],
}));
vi.mock('../src/agent/logger', () => ({ initLogger: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/agent/hooks', () => ({
  HookRegistry: class {},
  PreflightHookRegistry: class {},
  createGraphContextHook: vi.fn(),
  createGraphContext: vi.fn(),
  buildFileNodeIndex: vi.fn(),
  createGraphPreflightHook: vi.fn(),
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ providers: [], activeProvider: 'deepseek' })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'deepseek', apiKey: 'test', baseUrl: '', model: '', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  CHAT_MODES: [],
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('../src/provider/anthropic', () => ({ createAnthropicProvider: vi.fn() }));
vi.mock('../src/provider/openai', () => ({ createOpenAIProvider: vi.fn() }));
vi.mock('../src/provider/types', () => ({}));
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('../src/ui/debug', () => ({ dbg: vi.fn() }));

import { buildSystemPrompt } from '../src/workspace';

describe('buildSystemPrompt', () => {
  const modelIdentityBlock = [
    '## 模型身份（必须遵守）',
    '你不是 Claude、不是 Anthropic 模型',
    '你的后端 API 是 DeepSeek',
    '禁止编造"Claude 家族标志性风格"',
  ];

  function assertModelIdentity(prompt: string) {
    for (const phrase of modelIdentityBlock) {
      expect(prompt).toContain(phrase);
    }
    // Must NOT claim to be Claude/Anthropic anywhere except in negation
    // Remove the negation block, then check remaining text
    const blockStart = prompt.indexOf('## 模型身份（必须遵守）');
    const afterBlock = prompt.slice(blockStart + 200); // skip past the block
    expect(afterBlock).not.toMatch(/\bClaude\b/);
    expect(afterBlock).not.toMatch(/\bAnthropic\b/);
  }

  it('empty graph prompt contains model identity disclaimer', () => {
    const ws = { graphData: null, path: '' } as any;
    const prompt = buildSystemPrompt(ws);
    assertModelIdentity(prompt);
    expect(prompt).toContain('当前没有加载项目');
  });

  it('loaded graph prompt contains model identity disclaimer', () => {
    const ws = {
      graphData: { nodes: [1, 2, 3], edges: [1, 2] },
      path: 'D:\\test-project',
    } as any;
    const prompt = buildSystemPrompt(ws);
    assertModelIdentity(prompt);
    expect(prompt).toContain('D:\\test-project');
    expect(prompt).toContain('3 节点');
    expect(prompt).toContain('2 条边');
  });

  it('memory section is appended when provided', () => {
    const ws = { graphData: null, path: '' } as any;
    const prompt = buildSystemPrompt(ws, '## 记忆库\n- 测试记忆');
    expect(prompt).toContain('## 记忆库');
    expect(prompt).toContain('- 测试记忆');
  });

  it('loaded graph prompt includes hologram tool references', () => {
    const ws = {
      graphData: { nodes: [1], edges: [1] },
      path: 'D:\\proj',
    } as any;
    const prompt = buildSystemPrompt(ws);
    expect(prompt).toContain('hologram_analyze');
    expect(prompt).toContain('hologram_fragile');
    expect(prompt).toContain('hologram_cycle');
  });
});
