// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// spill — 大输出溢写：小内容原样、大内容落盘 + locator、失败退回截断不静默。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => rpcMock(...args),
  listen: vi.fn(() => () => {}),
  isMockMode: () => false,
}));

import { parseIsolationDiff, spillToFile } from '../src/agent/spill';

function mockFsWrite(): Map<string, string> {
  const files = new Map<string, string>();
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'create_directory') return null;
    if (method === 'write_file_content') {
      files.set(params.file_path as string, params.content as string);
      return 'ok';
    }
    throw new Error(`unexpected rpc: ${method}`);
  });
  return files;
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe('spillToFile', () => {
  it('passes small text through without writing', async () => {
    mockFsWrite();
    const out = await spillToFile({ projectPath: '/proj', name: 'x', text: 'short', maxInline: 100 });
    expect(out.spilled).toBe(false);
    expect(out.display).toBe('short');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('writes large text to .hologram/spill and returns a locator + preview', async () => {
    const files = mockFsWrite();
    const big = 'x'.repeat(5000);
    const out = await spillToFile({ projectPath: '/proj', name: 'd', text: big, maxInline: 100, extension: 'diff' });
    expect(out.spilled).toBe(true);
    expect(out.path).toContain('/proj/.hologram/spill/');
    expect(out.path).toMatch(/\.diff$/);
    expect(out.display).toContain('已溢写 5000 字符');
    expect(out.display).toContain('read_file 读取全量');
    // 全量内容必须无损落盘
    const written = files.get(out.path!);
    expect(written).toBe(big);
  });

  it('falls back to truncation with a failure marker when the write fails', async () => {
    rpcMock.mockImplementation(async () => {
      throw new Error('disk full');
    });
    const out = await spillToFile({ projectPath: '/proj', name: 'd', text: 'x'.repeat(5000), maxInline: 100 });
    expect(out.spilled).toBe(false);
    expect(out.display).toContain('spill 溢写失败');
    expect(out.display).toContain('truncated');
  });
});

describe('parseIsolationDiff', () => {
  it('parses small-diff, no-change and spilled JSON payloads', () => {
    expect(parseIsolationDiff('{"has_changes":true,"diff":"+a"}')).toEqual({
      hasChanges: true,
      diff: '+a',
      spillPath: undefined,
    });
    expect(parseIsolationDiff('{"has_changes":false,"diff":""}')?.hasChanges).toBe(false);
    const spilled = parseIsolationDiff(
      '{"has_changes":true,"diff":"[diff 全量落盘] /p/x.diff","spill_path":"/p/x.diff"}',
    );
    expect(spilled?.spillPath).toBe('/p/x.diff');
  });

  it('returns null for non-JSON input', () => {
    expect(parseIsolationDiff('not json')).toBeNull();
  });
});
