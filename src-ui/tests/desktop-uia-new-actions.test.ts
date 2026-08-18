// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// computer-use 改造新增动作的行为测试：
//   - 定位条件必填校验（read/wait/select/expand 与 click/type 同语义）
//   - 新观察参数（tree 分页 all/offset/max_results、probe route）透传
//   - keys/activate/audit/status 的路由与 schema
//   - desktop_uia_fill 复合编排（逐字段路由 + 缺定位字段跳过）

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent/tool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/tool')>();
  return { ...actual, agentInvoke: vi.fn(async () => '{"done":true}') };
});

import { agentInvoke, ToolRegistry } from '../src/agent/tool';
import { createDesktopTools } from '../src/agent/tools/browser';

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createDesktopTools()) registry.register(t);
  return registry;
}

const invokeMock = agentInvoke as unknown as ReturnType<typeof vi.fn>;

function reg(name: string) {
  const t = buildRegistry().get(name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
}

describe('desktop 新动作：定位条件必填校验（不触 Rust 即拒绝）', () => {
  it.each([
    ['desktop_uia_read', {}],
    ['desktop_uia_wait', { until: 'exists' }],
    ['desktop_uia_select', {}],
    ['desktop_uia_expand', {}],
  ])('%s 无定位条件返回提示且不 invoke', async (name, base) => {
    invokeMock.mockClear();
    const out = await reg(name).execute(base);
    expect(out).toContain('至少要给一个定位条件');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('desktop_uia_wait 有 until + ref 时正常路由', async () => {
    invokeMock.mockClear();
    await reg('desktop_uia_wait').execute({ until: 'exists', ref: 3, timeout_ms: 500 });
    expect(invokeMock).toHaveBeenCalledWith(
      'desktop_uia_wait',
      expect.objectContaining({ until: 'exists', ref: 3, timeout_ms: 500, isAgent: true }),
    );
  });
});

describe('desktop 新观察参数透传', () => {
  it('uia_tree 的 all/offset/max_results 传到 Rust', async () => {
    invokeMock.mockClear();
    await reg('desktop_uia_tree').execute({ hwnd: 123, all: true, offset: 80, max_results: 40 });
    expect(invokeMock).toHaveBeenCalledWith(
      'desktop_uia_tree',
      expect.objectContaining({ hwnd: 123, all: true, offset: 80, max_results: 40 }),
    );
  });

  it('probe 的 route 开关传到 Rust', async () => {
    invokeMock.mockClear();
    await reg('desktop_probe').execute({ route: false });
    expect(invokeMock).toHaveBeenCalledWith('desktop_probe', expect.objectContaining({ route: false }));
  });

  it('audit/status 只读', () => {
    expect(reg('desktop_audit').readOnly()).toBe(true);
    expect(reg('desktop_status').readOnly()).toBe(true);
  });
});

describe('desktop_uia_fill 复合编排', () => {
  it('逐字段路由到 desktop_uia_type 并透传窗口定位', async () => {
    invokeMock.mockClear();
    const out = await reg('desktop_uia_fill').execute({
      hwnd: 4242,
      fields: [
        { ref: 1, text: 'alice' },
        { name: '密码', text: 'secret' },
      ],
    });
    expect(out).toContain('desktop_uia_fill 完成 2 个字段');
    expect(invokeMock).toHaveBeenCalledWith(
      'desktop_uia_type',
      expect.objectContaining({ hwnd: 4242, ref: 1, text: 'alice' }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      'desktop_uia_type',
      expect.objectContaining({ hwnd: 4242, name: '密码', text: 'secret' }),
    );
  });

  it('缺定位条件的字段被跳过（其余照常）', async () => {
    invokeMock.mockClear();
    const out = await reg('desktop_uia_fill').execute({
      fields: [{ text: '孤儿字段' }, { automation_id: 'e2eEdit', text: 'ok' }],
    });
    expect(out).toContain('[skip]');
    expect(out).toContain('2 个字段');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe('desktop_uia_keys / activate 路由', () => {
  it('keys 透传 modifiers + key', async () => {
    invokeMock.mockClear();
    await reg('desktop_uia_keys').execute({ key: 'a', modifiers: ['ctrl'], hwnd: 7 });
    expect(invokeMock).toHaveBeenCalledWith(
      'desktop_uia_keys',
      expect.objectContaining({ key: 'a', modifiers: ['ctrl'], hwnd: 7 }),
    );
  });

  it('activate 只需窗口定位', async () => {
    invokeMock.mockClear();
    await reg('desktop_uia_activate').execute({ hwnd: 7 });
    expect(invokeMock).toHaveBeenCalledWith('desktop_uia_activate', expect.objectContaining({ hwnd: 7 }));
  });
});
