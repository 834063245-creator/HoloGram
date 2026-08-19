// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Shared right-click context menu — 公共 API 不变（P2：本地实现，无 React 依赖；
// 请求写入 overlay-store，由 app/ContextMenu.tsx 的 ContextMenuHost 在单 React 树内渲染）。

import { type ContextMenuItem, useOverlayStore } from '../state/overlay-store';

export type { ContextMenuItem };

export function showContextMenu(e: MouseEvent, items: ContextMenuItem[]): void {
  useOverlayStore.getState().showContextMenu({ x: e.clientX, y: e.clientY, items });
}
