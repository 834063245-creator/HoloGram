// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Permission UI — embedded in chat panel as inline cards (no modal overlay)
// Rule matching + decision logic lives in Rust: has_permission_to_use_tool()
// The Rust backend emits permission-ask events → main.ts bridges to ChatPanel.showPermissionCard.
//
// ⚡ 重构：pendingCards 状态已迁移到 ExecutionState。
// 这些函数现在是薄包装，保持向后兼容。

import { execState } from './execution-state';

/** Register a permission card for cleanup on abort.
 *  @deprecated 新代码应直接调 execState.registerPermCard() */
export function registerPendingCard(
  resolve: (r: { allow: boolean; remember: boolean }) => void,
  cleanup: () => void,
): void {
  execState.registerPermCard(resolve, cleanup);
}

/** Dismiss all pending permission cards — called on abort/stop.
 *  @deprecated 新代码应直接调 execState.stop() 或 execState.resetPermQueue() */
export function cancelPendingApprovals(): void {
  execState.resetPermQueue();
}
