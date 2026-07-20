// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：全局快捷键 — 从 main.ts 的两个 window keydown 监听器平移而来。
// 只分发动作；具体实现由 main.ts 注入 actions 注册表。

import { useEffect } from 'react';
import { runAction } from './actions';
import { useShellStore } from './shell-store';

function isEditing(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useShellStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Ctrl+K 命令面板 — 编辑中也可用
      if (mod && !e.shiftKey && !e.altKey && key === 'k') {
        e.preventDefault();
        st.setPaletteOpen(!st.paletteOpen);
        return;
      }
      // 面板打开时其余按键交给面板自身处理（仅兜底 Esc）
      if (st.paletteOpen) {
        if (e.key === 'Escape') st.setPaletteOpen(false);
        return;
      }
      if (isEditing()) return;

      if (mod && !e.shiftKey && !e.altKey && key === 'l') {
        e.preventDefault();
        runAction('toggle-chat');
      } else if (mod && !e.shiftKey && !e.altKey && key === 'd') {
        e.preventDefault();
        runAction('toggle-diff');
      } else if (mod && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        runAction('toggle-settings');
      } else if (key === 'f') {
        runAction('toggle-fold');
      } else if (key === 'b') {
        runAction('blast-toggle');
      } else if (key === 'r') {
        runAction('reset-cam');
      } else if (e.key === '?') {
        st.setShortcutsOpen(!st.shortcutsOpen);
      } else if (e.key === 'Escape') {
        if (st.shortcutsOpen) st.setShortcutsOpen(false);
        else runAction('esc-layer');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
