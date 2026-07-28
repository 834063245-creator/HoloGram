// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Linux 无边框窗口缩放热区 — decorations:false 下 Linux WM 不提供边缘缩放，
// 在窗口四边四角铺 6px 透明热区，pointerdown 调 Tauri start_resize_dragging。
// 仅 Linux 安装（Windows/macOS 的无边框窗口系统自带边缘缩放）。

interface TauriInternals {
  metadata?: { currentWindow?: { label?: string } };
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const DIRECTIONS = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ZoneDir = (typeof DIRECTIONS)[number];

const TAURI_DIRECTION: Record<ZoneDir, string> = {
  n: 'North',
  e: 'East',
  s: 'South',
  w: 'West',
  ne: 'NorthEast',
  nw: 'NorthWest',
  se: 'SouthEast',
  sw: 'SouthWest',
};

export function installResizeZones(): void {
  if (document.documentElement.getAttribute('data-platform') !== 'linux') return;
  const ta = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!ta?.invoke) return;
  const label = ta.metadata?.currentWindow?.label || 'main';
  for (const dir of DIRECTIONS) {
    const zone = document.createElement('div');
    zone.className = `rz-zone rz-${dir}`;
    zone.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      ta.invoke('plugin:window|start_resize_dragging', { label, direction: TAURI_DIRECTION[dir] }).catch((err) =>
        console.warn('start_resize_dragging failed', err),
      );
    });
    document.body.appendChild(zone);
  }
}
