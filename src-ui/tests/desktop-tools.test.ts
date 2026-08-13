import { describe, expect, it, vi } from 'vitest';

// desktop 领域工具全量走 Rust desktop_probe（只读进程/窗口/控制台快照）。
// mock agentInvoke 捕获路由；其余导出保留真实实现。
vi.mock('../src/agent/tool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/tool')>();
  return { ...actual, agentInvoke: vi.fn(async () => '{"process_count":0,"processes":[]}') };
});

import { ToolRegistry, agentInvoke } from '../src/agent/tool';
import { convergeRegistry } from '../src/agent/tools/domains';
import { createBrowserTools, createDesktopTools } from '../src/agent/tools/browser';

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools()) registry.register(t);
  for (const t of createDesktopTools()) registry.register(t);
  convergeRegistry(registry);
  return registry;
}

const invokeMock = agentInvoke as unknown as ReturnType<typeof vi.fn>;

describe('desktop 领域工具注册', () => {
  it('领域工具 desktop 可见，细粒度 desktop_probe 被隐藏但可解析', () => {
    const registry = buildRegistry();
    const visible = registry.schemas().map((s) => s.name);
    expect(visible).toContain('desktop');
    expect(visible).not.toContain('desktop_probe');
    expect(registry.get('desktop_probe')).toBeDefined();
  });

  it('desktop 领域 action 覆盖 probe', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    const actions = t.actions?.() ?? [];
    expect(actions).toContain('probe');
  });

  it('desktop 领域标记为只读', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    expect(t.readOnly()).toBe(true);
  });

  it('未知 action 返回错误提示', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    const result = await t.execute({ action: 'fly_to_desktop' });
    expect(result).toContain('unsupported action');
  });
});

describe('desktop 动作路由（走 Rust desktop_probe）', () => {
  it('probe 路由到 desktop_probe 并透传空参数', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    await t.execute({ action: 'probe' });
    expect(invokeMock).toHaveBeenCalledWith('desktop_probe', expect.objectContaining({}));
  });

  it('desktop_probe 细粒度工具标记只读', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop_probe')!;
    expect(t.readOnly()).toBe(true);
  });
});
