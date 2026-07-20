// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// TimelinePanel button-disappear regression test.
// Bug: TimelinePanel._open desynced from React's `open` state → isOpen()
// returned stale `true` → updateTabs hid left dock buttons permanently.
//
// P3: 开合状态单一事实源迁入 dock-store（DOM classList 反查与双状态一并消除）。
// 本测试守护「store 状态 ⇄ DOM class ⇄ × 按钮」三者同步。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ui/app-shell', () => ({
  shell: { navigateToFile: vi.fn() },
}));

vi.mock('../../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));

// bridge rpc mock — TimelinePanel calls rpc() in refresh()
vi.mock('../../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: vi.fn(() => Promise.resolve('{"events":[],"total":0}')),
  listen: vi.fn(),
  isMockMode: () => false,
}));

// events mock — TimelinePanel listens on bus
vi.mock('../../src/ui/events', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { useDockStore } from '../../src/ui/dock-store';
import { TimelinePanel } from '../../src/ui/react/TimelinePanel';

function resetDock(): void {
  useDockStore.setState({
    open: { timeline: false, hotspots: false, check: false, constraints: false, dataflow: false, settings: false },
    projectPath: null,
    checkResult: null,
  });
}

describe('TimelinePanel', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
    resetDock();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  async function renderPanel(): Promise<void> {
    await act(async () => {
      root.render(createElement(TimelinePanel));
    });
  }

  const isOpen = () => useDockStore.getState().open.timeline;
  const hasOpenClass = () => document.getElementById('timeline-panel')?.classList.contains('tl-open') ?? false;

  async function toggle(): Promise<void> {
    await act(async () => {
      useDockStore.getState().togglePanel('timeline');
    });
  }

  it('isOpen returns false initially', async () => {
    await renderPanel();
    expect(isOpen()).toBe(false);
    expect(hasOpenClass()).toBe(false);
  });

  it('store state reflects into DOM class after toggle', async () => {
    await renderPanel();
    await toggle();

    expect(isOpen()).toBe(true);
    expect(hasOpenClass()).toBe(true);
  });

  it('isOpen returns false after close', async () => {
    await renderPanel();
    await toggle();
    expect(isOpen()).toBe(true);

    await toggle();
    expect(isOpen()).toBe(false);
    expect(hasOpenClass()).toBe(false);
  });

  it('isOpen stays correct after repeated toggle', async () => {
    await renderPanel();

    await toggle();
    expect(isOpen()).toBe(true);

    await toggle();
    expect(isOpen()).toBe(false);

    await toggle();
    expect(isOpen()).toBe(true);
  });

  it('DOM class always mirrors store state', async () => {
    await renderPanel();
    expect(hasOpenClass()).toBe(false);

    await toggle();
    expect(hasOpenClass()).toBe(true);

    await act(async () => {
      useDockStore.getState().closePanel('timeline');
    });
    expect(hasOpenClass()).toBe(false);
  });

  it('× button close keeps store in sync (regression guard)', async () => {
    // Exact scenario: user clicks panel's × button — it must drive the same
    // store state (旧 bug：按钮走组件内 state，isOpen() 反查 DOM 得到陈旧值)。
    await renderPanel();
    await toggle();
    expect(isOpen()).toBe(true);

    const closeBtn = document.querySelector('#timeline-panel .tl-close') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      closeBtn.click();
    });

    expect(isOpen()).toBe(false);
    expect(hasOpenClass()).toBe(false);
  });
});
