// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatCore 实例注册 — main.ts 在 init 期间构造并注入；
// React 树（App → ChatBeacon）订阅此 store，core 就绪后才渲染。

import { create } from 'zustand';
import type { ChatCore } from './chat-core';

export const useCoreStore = create<{ core: ChatCore | null; setChatCore: (c: ChatCore) => void }>((set) => ({
  core: null,
  setChatCore: (c) => set({ core: c }),
}));
