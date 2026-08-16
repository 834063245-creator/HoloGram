// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LSP 诊断缓存 — 跨项目串味回归（landmine-map H1）。
//
// 回归背景：
//  - getDiagnosticsForFile 此前按 basename 尾匹配（endsWith('/'+basename)）兜底，
//    跨项目/跨目录下同名文件会串味（A 项目文件查回到 B 项目同名文件的诊断）。
//  - stopAllLsp 此前不清 diagnosticsCache/lspWarned，切换工作区后旧项目诊断
//    仍被 agent 状态钩子读到。
//  - listenForDiagnostics 此前丢弃 unlisten，编辑器随面板重建会叠加监听器。
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── bridge mock：捕获 listen 处理器 + 可解锁的 unlisten ──
// vi.mock 工厂会提升到文件顶部，因此 mock 变量必须经 vi.hoisted 创建。

const { listenHandlers, unlistenCalls, mockListen, mockRpc } = vi.hoisted(() => {
  const listenHandlers = new Map<string, (e: any) => void>();
  const unlistenCalls: string[] = [];
  const mockListen = vi.fn((event: string, handler: (e: any) => void) => {
    listenHandlers.set(event, handler);
    const unlisten = vi.fn(() => {
      unlistenCalls.push(event);
      if (listenHandlers.get(event) === handler) listenHandlers.delete(event);
    });
    return Promise.resolve(unlisten);
  });
  const mockRpc = vi.fn(async () => '0');
  return { listenHandlers, unlistenCalls, mockListen, mockRpc };
});

vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: mockListen,
  isMockMode: () => true,
}));

import { getDiagnosticsForFile, listenForDiagnostics, stopAllLsp } from '../src/ui/lsp-client';

/** 刷新 microtask/macrotask 让 listen().then(...) 里的 unlisten 登记生效。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 触发一次 lsp-message publishDiagnostics。 */
function publishDiagnostics(uri: string): void {
  const handler = listenHandlers.get('lsp-message');
  expect(handler, 'lsp-message 处理器已注册').toBeDefined();
  if (!handler) return;
  handler({
    payload: {
      message: {
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              severity: 1,
              message: 'E: ' + uri,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ],
        },
      },
    },
  });
}

/** 注入 lsp-client 使用的 monaco 桩（只关心诊断缓存，不真正打 markers）。 */
const fakeMonaco: any = {
  MarkerSeverity: { Error: 1, Warning: 2, Info: 3, Hint: 4 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  editor: { getModel: () => null, setModelMarkers: vi.fn() },
};

describe('lsp diagnostics cache — 跨项目串味（H1）', () => {
  beforeEach(async () => {
    listenHandlers.clear();
    unlistenCalls.length = 0;
    mockRpc.mockClear();
    await stopAllLsp();
    // 注册一个 lsp-message 监听器，测试才能通过它往缓存灌数据
    listenForDiagnostics(undefined as any, fakeMonaco);
    await flush();
  });

  it('全路径命中正常（file:/// 前缀归一后精确比较）', async () => {
    publishDiagnostics('file:///D:/projA/src/main.ts');
    expect(getDiagnosticsForFile('file:///D:/projA/src/main.ts')).toHaveLength(1);
    // 不带 file:/// 前缀的本地路径同源命中
    expect(getDiagnosticsForFile('D:/projA/src/main.ts')).toHaveLength(1);
  });

  it('同名不同目录文件不互串', async () => {
    publishDiagnostics('file:///D:/projA/src/main.ts');
    // B 项目同名文件（仅 basename 相同）不得查回 A 项目诊断
    expect(getDiagnosticsForFile('file:///D:/projB/src/main.ts')).toHaveLength(0);
    // 同目录但路径不同的另一个文件也不命中
    expect(getDiagnosticsForFile('file:///D:/projA/src/other.ts')).toHaveLength(0);
  });

  it('stopAllLsp 后缓存清空', async () => {
    publishDiagnostics('file:///D:/projA/src/main.ts');
    expect(getDiagnosticsForFile('file:///D:/projA/src/main.ts')).toHaveLength(1);
    await stopAllLsp();
    expect(getDiagnosticsForFile('file:///D:/projA/src/main.ts')).toHaveLength(0);
  });

  it('重复 listenForDiagnostics 不叠加监听器（先注销旧的）', async () => {
    // beforeEach 已注册一次；模块级 unlistenDiagnostics 可能残留上一测试的监听器，
    // 因此用增量断言而非绝对值。
    const baseline = unlistenCalls.filter((e) => e === 'lsp-message').length;

    // 再注册一次 → 应注销 beforeEach 刚注册的监听器（unlisten +1）
    listenForDiagnostics(undefined as any, fakeMonaco);
    await flush();
    expect(unlistenCalls.filter((e) => e === 'lsp-message').length).toBe(baseline + 1);

    // 第三次注册 → 又注销一次，且始终只保留一份可用监听器
    listenForDiagnostics(undefined as any, fakeMonaco);
    await flush();
    expect(unlistenCalls.filter((e) => e === 'lsp-message').length).toBe(baseline + 2);
    expect(listenHandlers.has('lsp-message')).toBe(true);
  });
});
