import { describe, expect, it, vi } from 'vitest';

// buildSystemPrompt moved from workspace.ts to agent/bootstrap.ts
// Function signature changed: (ws: Workspace, ...) → (graphData, projectPath, ...)

vi.mock('../src/bridge', () => ({ invoke: vi.fn(), listen: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/agent/agent', () => ({ Agent: class {} }));
vi.mock('../src/agent/tool', () => ({
  ToolRegistry: class {
    register() {}
    alias() {}
    all() {
      return [];
    }
    schemas() {
      return [];
    }
    get() {
      return null;
    }
  },
  createCodingTools: () => [],
  createSubAgentTool: () => ({}),
}));
vi.mock('../src/agent/memory', () => ({
  MemoryManager: class {},
  createMemoryTools: () => [],
}));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/agent/hooks', () => ({
  HookRegistry: class {},
  PreflightHookRegistry: class {},
  createGraphContextHook: vi.fn(),
  createGraphContext: vi.fn(),
  buildFileNodeIndex: vi.fn(),
  createGraphPreflightHook: vi.fn(),
  buildGraphSnapshot: vi.fn(() => ''),
}));
vi.mock('../src/settings', () => ({
  loadSettings: vi.fn(() => ({ providers: [], activeProvider: 'deepseek' })),
  saveSettings: vi.fn(),
  getActiveProvider: vi.fn(() => ({ name: 'deepseek', apiKey: 'test', baseUrl: '', model: '', kind: 'openai' })),
  defaultPricing: vi.fn(() => ({ cache_hit: 0, input: 0, output: 0, currency: 'CNY' })),
  restoreSecrets: vi.fn((s: any) => s),
  persistSecrets: vi.fn(),
}));
vi.mock('../src/provider/anthropic', () => ({ createAnthropicProvider: vi.fn() }));
vi.mock('../src/provider/openai', () => ({ createOpenAIProvider: vi.fn() }));
vi.mock('../src/provider/types', () => ({}));
vi.mock('../src/ui/debug', () => ({ dbg: vi.fn() }));
vi.mock('../src/ui/chat-store', () => ({
  msgStoreForActive: () => null,
  msgStoreFor: () => ({ getState: () => ({ messages: [], setMessages: () => {}, bump: () => {} }) }),
  getChatStore: () => ({ sess: { getState: () => ({ sessions: [{ id: 1 }], activeIdx: 0 }) } }),
  bumpSession: vi.fn(),
}));
vi.mock('../src/ui/chat-session', () => ({ rebuildMessagesFromMessages: vi.fn() }));
vi.mock('../src/ui/lsp-client', () => ({ getDiagnosticsForFile: vi.fn() }));
vi.mock('../src/ui/panel-store', () => ({ getPanelStore: () => ({ getState: () => ({}) }) }));
vi.mock('../src/ui/subagent-sink', () => ({ createSubAgentSink: vi.fn() }));
vi.mock('../src/ui/message-model', () => ({}));

import { buildSystemPrompt } from '../src/agent/runtime/agent-builder';

describe('buildSystemPrompt', () => {
  it('empty graph prompt contains model identity disclaimer', () => {
    const prompt = buildSystemPrompt(null, '');
    expect(prompt).toContain('没有加载项目');
    expect(prompt).toContain('DeepSeek');
  });

  it('loaded graph prompt contains model identity disclaimer', () => {
    const prompt = buildSystemPrompt({ nodes: [1, 2, 3], edges: [1, 2] }, 'D:\\test-project');
    expect(prompt).toContain('D:\\test-project');
    expect(prompt).toContain('DeepSeek');
  });

  it('memory section is appended when provided', () => {
    const prompt = buildSystemPrompt(null, '', '## 记忆库\n- 测试记忆');
    expect(prompt).toContain('## 记忆库');
    expect(prompt).toContain('- 测试记忆');
  });

  it('loaded graph prompt has a mode-neutral collaboration block', () => {
    // 系统提示词不随协作模式变化（热切换不重建，前缀缓存不击穿）——
    // 规划模式的完整工作流由 PlanModeInjector 的运行时提醒携带。
    const prompt = buildSystemPrompt({ nodes: [1], edges: [1] }, 'D:\\proj');
    expect(prompt).toContain('## 协作模式');
    expect(prompt).toContain('规划模式');
    expect(prompt).toContain('执行模式');
    expect(prompt).not.toContain('当前激活');
  });
});
