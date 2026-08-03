// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 可观察 shell 队列 —— 资源租约层 v1。
//
// 镜像 isolation-queue.ts 的 promise 链串行模式，但暴露队列状态：
//   - 队列长度、等待位置、预计开始时间（供 Agent/UI 反馈）
//   - 头部超时保护（超过预期 1.5x 提示"可能卡住"，对齐 SHELL_TIMEOUT 600s）
//
// v1 决策：保留全串行（cargo 等共享 target/ 锁是资源级共享，串行是安全默认）。
// 分类（cmd-class.ts）只影响预计等待估算，不改变调度行为。
// v2 若按资源类型分队列，本文件的 entries 数组 + meta 结构可直接切分资源桶。

export type ShellCmdClass = 'read' | 'write' | 'heavy' | 'unknown';

/** 各类命令的预计耗时（用于估算排队等待） */
export const SHELL_CLASS_ESTIMATE_MS: Record<ShellCmdClass, number> = {
  read: 3_000,
  write: 10_000,
  heavy: 40_000,
  unknown: 10_000,
};

export interface ShellQueueEntry {
  id: number;
  cmd: string;
  cls: ShellCmdClass;
  expectedMs: number;
  queuedAt: number;
  startedAt: number | null;
}

export interface ShellQueueStatus {
  /** 队列总长（含运行中的头部） */
  length: number;
  /** 当前运行中的命令（无则 null） */
  running: {
    cmd: string;
    cls: ShellCmdClass;
    elapsedMs: number;
    remainingMs: number;
    /** 已超过预期 1.5x —— 可能卡住，提示对齐 SHELL_TIMEOUT 600s */
    overBudget: boolean;
  } | null;
  /** 等待中的命令 */
  waiters: Array<{
    cmd: string;
    cls: ShellCmdClass;
    position: number;
    estimatedStartMs: number;
  }>;
}

export interface ShellOpHandle<T> {
  promise: Promise<T>;
  /** 读取当前队列状态 */
  status(): ShellQueueStatus;
}

let _chain: Promise<unknown> = Promise.resolve();
const _entries: ShellQueueEntry[] = [];
let _nextId = 1;

function computeStatus(): ShellQueueStatus {
  const now = Date.now();
  const head = _entries[0] ?? null;

  const running = head?.startedAt != null
    ? (() => {
        const elapsedMs = now - head.startedAt;
        const overBudget = elapsedMs > head.expectedMs * 1.5;
        const remainingMs = overBudget ? 0 : Math.max(0, head.expectedMs - elapsedMs);
        return { cmd: head.cmd, cls: head.cls, elapsedMs, remainingMs, overBudget };
      })()
    : null;

  // 估算等待：头部剩余 + 前排（不含自己）的预期耗时
  const waiters: ShellQueueStatus['waiters'] = [];
  let aheadMs = running?.remainingMs ?? 0;
  for (let i = 1; i < _entries.length; i++) {
    const e = _entries[i];
    waiters.push({ cmd: e.cmd, cls: e.cls, position: i, estimatedStartMs: aheadMs });
    aheadMs += e.expectedMs;
  }

  return { length: _entries.length, running, waiters };
}

/**
 * 入队一个 shell 操作（严格 FIFO，与 isolation-queue 同一 promise 链模式）。
 * 返回 handle：promise 是串行执行后的结果；status() 可随时读取队列状态。
 */
export function enqueueShellOp<T>(
  fn: () => Promise<T>,
  meta: { cmd: string; cls: ShellCmdClass },
): ShellOpHandle<T> {
  const id = _nextId++;
  const entry: ShellQueueEntry = {
    id,
    cmd: meta.cmd,
    cls: meta.cls,
    expectedMs: SHELL_CLASS_ESTIMATE_MS[meta.cls],
    queuedAt: Date.now(),
    startedAt: null,
  };
  _entries.push(entry);

  const run = () => {
    entry.startedAt = Date.now();
    return fn();
  };

  const p = _chain.then(run, run);
  _chain = p.catch(() => {});
  const settled = p.finally(() => {
    const idx = _entries.findIndex((e) => e.id === id);
    if (idx >= 0) _entries.splice(idx, 1);
  });
  return { promise: settled, status: computeStatus };
}

/** 当前队列状态（无入队时也可查，供 UI 展示） */
export function getShellQueueStatus(): ShellQueueStatus {
  return computeStatus();
}
