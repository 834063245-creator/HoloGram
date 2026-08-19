// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1-24 回归：翻译缓存读取路径必须 stripLineNumbers。
// 修复前：read_file_content 返回 cat -n 行号格式，直接 JSON.parse 必抛，
// 被 catch 当「缓存未命中」吞掉 → 缓存 100% 不命中，用户为重翻译白付 API 费。
// 修复后：JSON.parse(stripLineNumbers(raw))，缓存正常命中，不发 API 请求。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
const mockCreateProvider = vi.fn();

vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/settings', () => ({
  loadSettingsWithSecrets: vi.fn(async () => ({ display: { language: 'zh' } })),
  getActiveProvider: vi.fn(() => ({ apiKey: 'test-key', model: 'test-model' })),
}));
vi.mock('../src/provider', () => ({
  createProvider: (...args: unknown[]) => mockCreateProvider(...args),
}));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));

import { FileTranslatorApp } from '../src/app/panels/FileTranslatorPanel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 模拟后端 format_lines 的 cat -n 输出："{:>6}\t{content}" */
function withLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
    .join('\n');
}

describe('P1-24: 翻译缓存命中', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const code = 'const a = 1;\nconst b = 2;';
  const cacheData = {
    file: 'foo.ts',
    hash: 'whatever',
    translated_at: new Date().toISOString(),
    model: 'test-model',
    language: 'zh',
    line_count: 2,
    lines: [
      { code: 'const a = 1;', human: '声明常量 a', audit: '', audit_type: '' },
      { code: 'const b = 2;', human: '声明常量 b', audit: '', audit_type: '' },
    ],
  };

  beforeEach(() => {
    mockRpc.mockReset();
    mockCreateProvider.mockReset();
    // read_file_content 一律返回带行号的缓存 JSON（后端行为）
    mockRpc.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_file_content') return withLineNumbers(JSON.stringify(cacheData));
      throw new Error(`unexpected rpc: ${cmd}`);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('带行号的缓存 JSON 能命中，不触发 API 调用', async () => {
    await act(async () => {
      root.render(
        React.createElement(FileTranslatorApp, {
          filePath: '/fake/foo.ts',
          onClose: () => {},
          onLayoutChange: () => {},
          getEditorContent: () => code,
        }),
      );
      // 让 startTranslation 的异步链跑完
      await Promise.resolve();
      await Promise.resolve();
    });

    // 缓存命中 → 渲染翻译内容
    expect(container.textContent).toContain('声明常量 a');
    // 未创建 provider（未发起 API 调用）
    expect(mockCreateProvider).not.toHaveBeenCalled();
    // 未回写缓存
    expect(mockRpc.mock.calls.some((c: unknown[]) => c[0] === 'write_file_content')).toBe(false);
    // 无 IPC 热循环：缓存读取恰好一次（computeStats 换身份曾导致 effect 无限重触发）
    expect(mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'read_file_content').length).toBe(1);
  });
});
