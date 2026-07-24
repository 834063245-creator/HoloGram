// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 隔离操作串行化 — 并发 git merge/discard 会 race on index lock。
// 提取为独立模块，避免 agent.ts ↔ merge.ts 循环导入。

let _isoQueue: Promise<unknown> = Promise.resolve();

export function enqueueIsolationOp<T>(fn: () => Promise<T>): Promise<T> {
  const p = _isoQueue.then(fn, fn);
  _isoQueue = p.catch(() => {});
  return p;
}
