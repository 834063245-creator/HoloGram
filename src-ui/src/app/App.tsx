// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：应用壳 — 单 React 根。组合全部新 chrome，挂全局快捷键与 bus 适配器。
// 旧面板（chat/check/timeline/…）本阶段仍由 main.ts 直接挂载 document.body，
// 与本壳并存；P3 收编进 DockPanel。

import { useEffect } from 'react';
import { initBridgeAdapters } from './bridge-adapters';
import { CommandBar } from './CommandBar';
import { CommandPalette } from './CommandPalette';
import { DockRail } from './DockRail';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { StatusBar } from './StatusBar';
import { useGlobalKeys } from './useGlobalKeys';

export function App() {
  useGlobalKeys();
  useEffect(() => {
    initBridgeAdapters();
  }, []);
  return (
    <>
      <CommandBar />
      <DockRail side="left" />
      <DockRail side="right" />
      <StatusBar />
      <CommandPalette />
      <ShortcutsOverlay />
    </>
  );
}
