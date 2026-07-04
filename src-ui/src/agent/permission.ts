// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Permission UI — embedded in chat panel as inline cards (no modal overlay)
// Rule matching + decision logic lives in Rust: has_permission_to_use_tool()
// The Rust backend emits permission-ask events → main.ts bridges to ChatPanel.showPermissionCard.

import { bus } from '../ui/events';

/** Track inline permission cards so they can be dismissed on abort. */
const pendingCards: Array<{ resolve: (r: { allow: boolean; remember: boolean }) => void }> = [];

export function registerPendingCard(resolve: (r: { allow: boolean; remember: boolean }) => void): void {
  pendingCards.push({ resolve });
}

export function unregisterPendingCard(resolve: (r: { allow: boolean; remember: boolean }) => void): void {
  const idx = pendingCards.findIndex((p) => p.resolve === resolve);
  if (idx >= 0) pendingCards.splice(idx, 1);
}

/** Dismiss all pending permission cards with "deny" — called on abort/stop. */
export function cancelPendingApprovals(): void {
  while (pendingCards.length > 0) {
    const p = pendingCards.pop()!;
    p.resolve({ allow: false, remember: false });
  }
}
