// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Permission UI — embedded in chat panel as inline cards (no modal overlay)
// Rule matching + decision logic lives in Rust: has_permission_to_use_tool()
// The Rust backend emits permission-ask events → main.ts bridges to ChatPanel.showPermissionCard.

import { bus } from '../ui/events';

/** Track inline permission cards so they can be dismissed on abort. */
const pendingCards: Array<{ resolve: (r: { allow: boolean; remember: boolean }) => void; cleanup: () => void }> = [];

export function registerPendingCard(
  resolve: (r: { allow: boolean; remember: boolean }) => void,
  cleanup: () => void,
): void {
  pendingCards.push({ resolve, cleanup });
}

/** Dismiss all pending permission cards — called on abort/stop. */
export function cancelPendingApprovals(): void {
  while (pendingCards.length > 0) {
    const p = pendingCards.pop()!;
    p.cleanup();
    p.resolve({ allow: false, remember: false });
  }
}
