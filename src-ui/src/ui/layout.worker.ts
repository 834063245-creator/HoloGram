// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Layout Worker — runs simulateForces off the main thread
// ⛔ CANONICAL LAYOUT — DO NOT MODIFY CORE PARAMETERS ⛔
// Safety layers (caps, adaptive constraints, NaN guards) are maintained
// in sync with graph-layout.ts. Core aesthetic params (rep, att, damp, shellRadius)
// are LOCKED.

import { simulateForces } from './graph-layout';

self.onmessage = async (e: MessageEvent) => {
  const { nodes, pairs } = e.data;
  const pos = await simulateForces(nodes, pairs, Math.cbrt(nodes) * 14);
  self.postMessage({ pos }, undefined as any);
};
