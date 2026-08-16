// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// LSP 会话单一事实源 + startLsp 在途代际防护（landmine-map H2）。
//
// 回归背景：
//  - file-viewer 曾自建第二张 lspSessions 表，stopAllLsp 清不到它，切换工作区后
//    LSP 永久假死却仍显示"已连接"。
//  - startLsp 在途 resolve 无代际校验 — 把 A 项目文件内容发进 B 的 tsserver。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
}));

vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => true,
}));

import { getLspSession, startLsp, stopAllLsp } from '../src/ui/lsp-client';
import { bumpWorkspaceEpoch } from '../src/workspace-scope';

describe('LSP 会话单一事实源 + 在途代际防护（H2）', () => {
  beforeEach(async () => {
    // 先清会话表 + 推进代际（会触发 lsp_stop 清理调用），再清 mock 记录，
    // 避免 beforeEach 的清理调用混入断言。
    await stopAllLsp();
    bumpWorkspaceEpoch();
    mockRpc.mockReset();
  });

  it('startLsp 当前代际 → 写会话表并返回 sid', async () => {
    mockRpc.mockResolvedValueOnce('7');
    const sid = await startLsp('rust', 'file:///D:/projA');
    expect(sid).toBe(7);
    // 单一事实源：getLspSession 能查到
    expect(getLspSession('rust')).toBe(7);
  });

  it('startLsp 在途期间 epoch 过期 → 调 lsp_stop 且不写会话表', async () => {
    mockRpc.mockResolvedValueOnce('42'); // lsp_start 返回 sid 42
    const p = startLsp('rust', 'file:///D:/projA');
    // startLsp 已进入、await lsp_start 在途 — 此刻切换工作区推进代际
    bumpWorkspaceEpoch();
    const sid = await p;
    expect(sid).toBeNull();
    // 过期 sid 必须被 lsp_stop（防把旧项目文件发进新项目的 tsserver）
    const stopCall = mockRpc.mock.calls.find(([method]) => method === 'lsp_stop');
    expect(stopCall).toBeDefined();
    if (!stopCall) return;
    expect(stopCall[1]).toEqual({ session_id: 42 });
    // 不写会话表 — 调用方拿 null 就不会注册 provider
    expect(getLspSession('rust')).toBeUndefined();
  });

  it('stopAllLsp 清会话表 — getLspSession 返回 undefined，重进 startLsp 分支', async () => {
    mockRpc.mockResolvedValueOnce('9');
    await startLsp('go', 'file:///D:/projA');
    expect(getLspSession('go')).toBe(9);
    await stopAllLsp();
    expect(getLspSession('go')).toBeUndefined();
    // 清理后再次 startLsp 应重新走 lsp_start
    mockRpc.mockResolvedValueOnce('11');
    const sid = await startLsp('go', 'file:///D:/projA');
    expect(sid).toBe(11);
    expect(mockRpc.mock.calls.filter(([m]) => m === 'lsp_start')).toHaveLength(2);
  });
});
