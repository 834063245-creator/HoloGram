// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// browser 复合动作编排测试：
//   - browser_fill 逐字段路由 browser_type + replace 透传
//   - browser_navigate_snapshot = navigate → snapshot 一次往返

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/tool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/tool')>();
  return { ...actual, agentInvoke: vi.fn(async () => '{"done":true}') };
});

import { agentInvoke, ToolRegistry } from '../src/agent/tool';
import { createBrowserTools } from '../src/agent/tools/browser';

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools()) registry.register(t);
  return registry;
}

const invokeMock = agentInvoke as unknown as ReturnType<typeof vi.fn>;

function reg(name: string) {
  const t = buildRegistry().get(name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
}

describe('browser_fill', () => {
  it('逐字段路由 browser_type（selector/text/replace 透传）', async () => {
    invokeMock.mockClear();
    const out = await reg('browser_fill').execute({
      fields: [
        { selector: '12', text: 'alice' },
        { selector: '#pw', text: 'secret', replace: true },
      ],
    });
    expect(out).toContain('browser_fill 完成 2 个字段');
    expect(invokeMock).toHaveBeenCalledWith('browser_type', expect.objectContaining({ selector: '12', text: 'alice' }));
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_type',
      expect.objectContaining({ selector: '#pw', text: 'secret', replace: true }),
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('空字段数组被 schema 拒绝（min(1)）', async () => {
    await expect(reg('browser_fill').execute({ fields: [] })).rejects.toThrow('参数校验失败');
  });

  it('是写动作（非只读）', () => {
    expect(reg('browser_fill').readOnly()).toBe(false);
  });
});

describe('browser_navigate_snapshot', () => {
  it('一次往返组合 navigate + snapshot（maxResults 透传）', async () => {
    invokeMock.mockClear();
    const out = await reg('browser_navigate_snapshot').execute({ url: 'https://example.com/', maxResults: 40 });
    expect(out).toContain('== navigation ==');
    expect(out).toContain('== snapshot ==');
    expect(invokeMock).toHaveBeenCalledWith(
      'browser_navigate',
      expect.objectContaining({ url: 'https://example.com/' }),
    );
    expect(invokeMock).toHaveBeenCalledWith('browser_snapshot', expect.objectContaining({ maxResults: 40 }));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('是写动作（navigate 改变页面状态）', () => {
    expect(reg('browser_navigate_snapshot').readOnly()).toBe(false);
  });
});
