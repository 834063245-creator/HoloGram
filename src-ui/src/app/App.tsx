// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：应用壳 — 单 React 根。组合全部新 chrome，挂全局快捷键与 bus 适配器。
// P3：六个 dock 面板收编进 DockPanel；ContextMenu / FileTranslator 经 portal 宿主渲染。

import { useEffect } from 'react';
import { ContextMenuHost } from '../ui/react/ContextMenu';
import { initBridgeAdapters } from './bridge-adapters';
import { CommandBar } from './CommandBar';
import { CommandPalette } from './CommandPalette';
import { ChatBeacon } from './chat/ChatBeacon';
import { useCoreStore } from './chat/core-instance';
import { DockRail } from './DockRail';
import { DockPanel } from './panels/DockPanel';
import { FileTranslatorPortal } from './panels/FileTranslatorPortal';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { StatusBar } from './StatusBar';
import { useGlobalKeys } from './useGlobalKeys';
import { useShellStore } from './shell-store';

export function App() {
  useGlobalKeys();
  const core = useCoreStore((s) => s.core);
  const view = useShellStore((s) => s.view);

  useEffect(() => {
    initBridgeAdapters();
  }, []);

  useEffect(() => {
    const welcome = document.getElementById('welcome');
    const graph = document.getElementById('graph');
    if (welcome) welcome.classList.toggle('hidden', view === 'graph');
    if (graph) graph.classList.toggle('hidden', view === 'welcome');
  }, [view]);
  return (
    <>
      <CommandBar />
      <DockRail side="left" />
      <DockRail side="right" />
      <StatusBar />
      <CommandPalette />
      <ShortcutsOverlay />
      {core ? <ChatBeacon core={core} /> : null}
      <DockPanel />
      <ContextMenuHost />
      <FileTranslatorPortal />
    </>
  );
}
