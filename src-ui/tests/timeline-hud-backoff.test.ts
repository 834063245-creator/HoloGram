// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P0-8 回归：空时间轴不得形成无限 IPC 热循环。
// 修复前：events 恒空 → effect 依赖翻转 → refresh 无退避无上限循环，
// 速度 = IPC 往返速度，永久轰击引擎。
// 修复后：首次立即 + 退避重试（2s/4s/6s），最多 4 次后停止。

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));
vi.mock('../src/app/shell-store', () => ({
  useShellStore: (sel: (s: { projectPath: string }) => unknown) => sel({ projectPath: '/fake/project' }),
}));
vi.mock('../src/ui/agent-visualizer', () => ({ askAgent: vi.fn() }));
vi.mock('../src/ui/app-shell', () => ({ shell: { register: vi.fn() } }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));

import { TimelineHUD } from '../src/app/TimelineHUD';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('P0-8: TimelineHUD 空时间轴退避', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRpc.mockReset();
    // 空时间轴：永远返回空 events
    mockRpc.mockResolvedValue('{"events": []}');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('空结果时 refresh 次数有上限（不无限热循环）', async () => {
    await act(async () => {
      root.render(React.createElement(TimelineHUD));
    });
    // 首次立即执行 + 三次退避（2s/4s/6s）全部跑完
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const calls = mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'hologram_call');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(4);

    // 再推进 60s——不得再有任何新调用（循环已停止）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const callsAfter = mockRpc.mock.calls.filter((c: unknown[]) => c[0] === 'hologram_call');
    expect(callsAfter.length).toBe(calls.length);
  });
});
