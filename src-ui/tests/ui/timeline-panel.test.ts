// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// TimelinePanel button-disappear regression test.
// Bug: TimelinePanel._open desynced from React's `open` state → isOpen()
// returned stale `true` → updateTabs hid left dock buttons permanently.
//
// Fix: isOpen() reads DOM classList directly. This test asserts that
// invariant and guards against accidental reintroduction of internal state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// ── Mock shell — capture notifyPanelChanged calls ──
const { shellNotifyMock } = vi.hoisted(() => ({ shellNotifyMock: vi.fn() }));
vi.mock('../../src/ui/app-shell', () => ({
  shell: {
    register: vi.fn(),
    notifyPanelChanged: shellNotifyMock,
    wire: vi.fn(),
    navigateToFile: vi.fn(),
  },
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

import { TimelinePanel } from '../../src/ui/react/TimelinePanel';

describe('TimelinePanel', () => {
  let container: HTMLElement;
  let panel: TimelinePanel;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    panel.destroy();
    document.body.removeChild(container);
  });

  // Helper: wrap React 18 createRoot construction in act so mount is flushed
  async function createPanel(): Promise<TimelinePanel> {
    let p!: TimelinePanel;
    await act(async () => {
      p = new TimelinePanel(container);
    });
    return p;
  }

  // Helper: toggle and wait for React to flush
  async function toggleAndFlush(p: TimelinePanel): Promise<void> {
    await act(async () => {
      p.toggle();
    });
  }

  it('isOpen returns false initially', async () => {
    panel = await createPanel();
    expect(panel.isOpen()).toBe(false);
  });

  it('isOpen returns true after toggle — reads DOM classList', async () => {
    panel = await createPanel();

    await toggleAndFlush(panel);

    const panelEl = document.getElementById('timeline-panel');
    expect(panelEl).not.toBeNull();
    expect(panelEl!.classList.contains('tl-open')).toBe(true);
    expect(panel.isOpen()).toBe(true);
  });

  it('isOpen returns false after close', async () => {
    panel = await createPanel();
    await toggleAndFlush(panel);
    expect(panel.isOpen()).toBe(true);

    await act(async () => {
      panel.close();
    });
    expect(panel.isOpen()).toBe(false);
  });

  it('isOpen stays correct after repeated toggle', async () => {
    panel = await createPanel();

    await toggleAndFlush(panel);
    expect(panel.isOpen()).toBe(true);

    await toggleAndFlush(panel);
    expect(panel.isOpen()).toBe(false);

    await toggleAndFlush(panel);
    expect(panel.isOpen()).toBe(true);
  });

  it('shell.notifyPanelChanged fires AFTER DOM is updated', async () => {
    panel = await createPanel();

    // Before toggle, DOM closed
    const before = document.getElementById('timeline-panel')?.classList.contains('tl-open');
    expect(before).toBe(false);

    await toggleAndFlush(panel);

    // After toggle + flush, DOM updated
    const after = document.getElementById('timeline-panel')?.classList.contains('tl-open');
    expect(after).toBe(true);

    // shell.notifyPanelChanged called (by useEffect after DOM update)
    expect(shellNotifyMock).toHaveBeenCalled();
  });

  it('× button close keeps isOpen() in sync (regression guard)', async () => {
    // Exact scenario: user clicks React panel's × button.
    // The button directly calls toggleRef.current → setOpen, skipping
    // TimelinePanel's own _open field.
    // After fix, isOpen() reads DOM classList, so it still works.
    panel = await createPanel();
    await toggleAndFlush(panel);
    expect(panel.isOpen()).toBe(true);

    // Simulate clicking × button inside React panel
    const closeBtn = document.querySelector('#timeline-panel .tl-close') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      closeBtn.click();
    });

    // DOM classList should be updated by React's useEffect
    const panelEl = document.getElementById('timeline-panel');
    expect(panelEl!.classList.contains('tl-open')).toBe(false);
    // And isOpen() — which reads classList — should reflect that
    expect(panel.isOpen()).toBe(false);
  });
});
