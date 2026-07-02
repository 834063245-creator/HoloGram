// 守护 camelCase IPC 契约: 前端发 isAgent ↔ Rust 参数 is_agent。
// 回归背景: 旧名 _agent 因 Tauri 默认 camelCase 重命名永远匹配不上 Rust is_agent，
// 导致 is_agent 恒为 false → agent 文件操作走 user-UI 路径被沙箱静默硬拒
// "outside project directory" 且不弹 Ask。谁把 isAgent 改回 _agent，这俩测试就挂。
import { describe, it, expect, vi } from 'vitest';

// agentInvoke (tool.ts) 跨模块 import bridge.invoke → mock 这里拦截真实 Tauri 调用
const mockInvoke = vi.fn();
vi.mock('../src/bridge', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
// tool.ts 模块加载时引用 bus 做事件接线
vi.mock('../src/ui/events', () => ({ bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));

import { agentInvoke } from '../src/agent/tool';

describe('agentInvoke camelCase contract', () => {
  it('injects isAgent:true (not _agent) to match Rust is_agent param', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue('ok');
    await agentInvoke('read_file_content', { filePath: 'C:/outside/x.txt' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [name, payload] = mockInvoke.mock.calls[0];
    expect(name).toBe('read_file_content');
    expect(payload).toEqual({ filePath: 'C:/outside/x.txt', isAgent: true });
    expect(payload).not.toHaveProperty('_agent');
  });

  it('passes arbitrary args through alongside isAgent', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(0);
    await agentInvoke<number>('git_log', { path: 'D:/proj', count: 5 });
    const [, payload] = mockInvoke.mock.calls[0];
    expect(payload).toEqual({ path: 'D:/proj', count: 5, isAgent: true });
  });
});
