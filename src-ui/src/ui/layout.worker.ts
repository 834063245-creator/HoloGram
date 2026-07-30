// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Layout Worker — 在主线程之外运行 simulateForces
// ⛔ 规范布局 — 请勿修改核心参数 ⛔
// 安全层（上限、自适应约束、NaN 防护）与 graph-layout.ts 保持同步。
// 核心美学参数（rep、att、damp、shellRadius）已锁定。

import { simulateForces } from './graph-layout';

self.onmessage = async (e: MessageEvent) => {
  const { nodes, pairs } = e.data;
  const pos = await simulateForces(nodes, pairs, Math.cbrt(nodes) * 14);
  self.postMessage({ pos }, undefined as any);
};
