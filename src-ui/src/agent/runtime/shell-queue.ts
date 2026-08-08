// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 可观察 shell 队列 —— 资源租约层 v2（取消语义 + 分车道调度）。
//
// v2 变更：
//   1. 取消语义（修"幽灵命令"）：abort 信号可取消排队中/运行中的命令。
//      此前 abort 只停止等待（streaming-executor 竞速），entry 留在队列排头
//      跑满超时（300s/600s），下一轮第一条 shell 排在幽灵后面 → 莫名排队。
//   2. 分车道调度：read 类命令（ls/grep/cat/git status）走 read 车道
//      （并发 3），不再被 exclusive 车道的 cargo build 堵满其全程。
//      队列存在的理由是构建锁互斥（target/、node_modules/、.git/index.lock）
//      —— read 命令无此冲突。unknown 保守归 exclusive（可能是写操作）。
//
// exclusive 车道保留 v1 的 promise 链全串行模式（镜像 isolation-queue.ts）。

export type ShellCmdClass = 'read' | 'write' | 'heavy' | 'unknown';
export type ShellLane = 'read' | 'exclusive';

/** 各类命令的预计耗时（用于估算排队等待） */
export const SHELL_CLASS_ESTIMATE_MS: Record<ShellCmdClass, number> = {
  read: 3_000,
  write: 10_000,
  heavy: 40_000,
  unknown: 10_000,
};

/** read 车道并发上限 — 只读命令之间无资源冲突，小并发提速 */
export const READ_LANE_CONCURRENCY = 3;

export interface ShellQueueEntry {
  id: number;
  cmd: string;
  cls: ShellCmdClass;
  lane: ShellLane;
  expectedMs: number;
  queuedAt: number;
  startedAt: number | null;
}

export interface LaneRunningInfo {
  cmd: string;
  cls: ShellCmdClass;
  elapsedMs: number;
  remainingMs: number;
  /** 已超过预期 1.5x —— 可能卡住，提示对齐 SHELL_TIMEOUT 600s */
  overBudget: boolean;
}

export interface LaneWaiterInfo {
  cmd: string;
  cls: ShellCmdClass;
  position: number;
  estimatedStartMs: number;
}

export interface ShellQueueStatus {
  /** 两车道 entries 总数（含运行中） */
  length: number;
  lanes: {
    read: { running: LaneRunningInfo[]; waiters: LaneWaiterInfo[] };
    exclusive: { running: LaneRunningInfo[]; waiters: LaneWaiterInfo[] };
  };
}

export interface ShellOpHandle<T> {
  promise: Promise<T>;
  /** 读取当前队列状态 */
  status(): ShellQueueStatus;
}

export interface EnqueueShellOpts {
  /** 中止信号 — 排队中取消出队（reject AbortError）；运行中取消杀进程（resolve 取消文案） */
  signal?: AbortSignal;
  /** 运行中收到 abort 时调用 — 由调用方终止 OS 进程（如 bash_kill job_id） */
  onCancelRunning?: () => void;
}

/** 运行中被 abort 时对外 resolve 的文案 — 调用方（queued-shell）按 string 消费 */
export const SHELL_CANCELLED_MESSAGE = '[已取消] 命令已被用户停止';

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

let _nextId = 1;
/** 全局 entry 列表（两车道混合，按入队顺序）— 供 status 计算 */
const _entries: ShellQueueEntry[] = [];

// ── exclusive 车道：promise 链全串行（v1 模式） ──
let _exclusiveChain: Promise<unknown> = Promise.resolve();

// ── read 车道：并发槽 + FIFO 等待 ──
let _readActive = 0;
const _readWaiters: Array<() => void> = [];

function laneOf(cls: ShellCmdClass): ShellLane {
  return cls === 'read' ? 'read' : 'exclusive';
}

function computeStatus(): ShellQueueStatus {
  const now = Date.now();

  const runningInfo = (e: ShellQueueEntry): LaneRunningInfo => {
    const elapsedMs = e.startedAt != null ? now - e.startedAt : 0;
    const overBudget = elapsedMs > e.expectedMs * 1.5;
    const remainingMs = overBudget ? 0 : Math.max(0, e.expectedMs - elapsedMs);
    return { cmd: e.cmd, cls: e.cls, elapsedMs, remainingMs, overBudget };
  };

  const laneStatus = (lane: ShellLane) => {
    const list = _entries.filter((e) => e.lane === lane);
    const running = list.filter((e) => e.startedAt != null).map(runningInfo);
    // 估算基础：read 车道并发执行，取运行中最大剩余；exclusive 串行取头部剩余
    let aheadMs = running.length > 0 ? Math.max(...running.map((r) => r.remainingMs)) : 0;
    const waiters: LaneWaiterInfo[] = [];
    for (const e of list) {
      if (e.startedAt != null) continue;
      waiters.push({ cmd: e.cmd, cls: e.cls, position: waiters.length + 1, estimatedStartMs: aheadMs });
      aheadMs += e.expectedMs;
    }
    return { running, waiters };
  };

  return {
    length: _entries.length,
    lanes: { read: laneStatus('read'), exclusive: laneStatus('exclusive') },
  };
}

/**
 * 入队一个 shell 操作。read 类进 read 车道（并发 3），其余进 exclusive 车道（串行）。
 * 返回 handle：promise 是调度执行后的结果；status() 可随时读取队列状态。
 *
 * 取消语义（opts.signal）：
 *   - 入队时已 aborted → 不入队，立即 reject AbortError；
 *   - 排队等待中 abort → 出队，reject AbortError（不占用车道槽位）；
 *   - 运行中 abort → 调 opts.onCancelRunning()（终止 OS 进程），
 *     resolve SHELL_CANCELLED_MESSAGE，车道立即前进。
 */
export function enqueueShellOp<T>(
  fn: () => Promise<T>,
  meta: { cmd: string; cls: ShellCmdClass },
  opts?: EnqueueShellOpts,
): ShellOpHandle<T> {
  const signal = opts?.signal;
  const lane = laneOf(meta.cls);

  if (signal?.aborted) {
    return { promise: Promise.reject(abortError()), status: computeStatus };
  }

  const entry: ShellQueueEntry = {
    id: _nextId++,
    cmd: meta.cmd,
    cls: meta.cls,
    lane,
    expectedMs: SHELL_CLASS_ESTIMATE_MS[meta.cls],
    queuedAt: Date.now(),
    startedAt: null,
  };
  _entries.push(entry);

  let started = false;
  let settledOut = false;
  let resolveOut!: (v: T) => void;
  let rejectOut!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveOut = res;
    rejectOut = rej;
  });

  const removeEntry = () => {
    const idx = _entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) _entries.splice(idx, 1);
  };

  /** 释放车道调度资源（幂等）— abort 时立即释放，不等被 kill 的 fn 落地 */
  let releaseLane: () => void = () => {};

  /** 运行中 abort 才放行互斥车道的下一个命令。
   *  排队中 abort 不触发 —— 否则它会绕过仍在运行的头部，破坏 FIFO 串行语义。 */
  let signalRunningAbort: () => void = () => {};
  const runningAborted = new Promise<void>((res) => {
    signalRunningAbort = res;
  });

  const onAbort = () => {
    if (settledOut) return;
    settledOut = true;
    removeEntry();
    if (!started) {
      // 排队中 — 直接出队；车道上的 exec 守卫会跳过 fn
      rejectOut(abortError());
    } else {
      // 运行中 — 终止 OS 进程并立即交还控制权；
      // fn 的后续 settle（kill 落地后的 done 事件）被 settledOut 守卫忽略
      try {
        opts?.onCancelRunning?.();
      } catch {
        /* 终止失败不阻塞取消 */
      }
      resolveOut(SHELL_CANCELLED_MESSAGE as T);
      releaseLane();
      signalRunningAbort();
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  /** 车道上的真正执行入口 — settledOut 说明排队期已被取消，跳过 fn */
  const exec = (): Promise<T> => {
    if (settledOut) return Promise.reject(abortError());
    started = true;
    entry.startedAt = Date.now();
    return fn();
  };

  /** 挂接 fn 结果的 settle 回调；返回幂等的 release 供 abort 提前释放车道资源 */
  const settle = (p: Promise<T>, release: () => void): (() => void) => {
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    p.then(
      (v) => {
        if (!settledOut) {
          settledOut = true;
          resolveOut(v);
        }
      },
      (e) => {
        if (!settledOut) {
          settledOut = true;
          rejectOut(e);
        }
      },
    ).finally(() => {
      releaseOnce();
      if (started) removeEntry();
      signal?.removeEventListener('abort', onAbort);
    });
    return releaseOnce;
  };

  if (lane === 'exclusive') {
    const p = _exclusiveChain.then(exec, exec);
    releaseLane = settle(p, () => {});
    // 链跟踪"fn settle 或运行中 abort"的先到者 ——
    // 运行中被 kill 后下一个命令立即放行，不等被 kill 的 fn 落地（kill 有毫秒级延迟）；
    // 排队中 abort 不影响链（exec 守卫跳过 fn，但 FIFO 顺序不变）。
    _exclusiveChain = Promise.race([p.catch(() => {}), runningAborted]);
  } else {
    const tryStart = () => {
      // 排队期已取消的陈旧唤醒 — 不占槽，把唤醒传给下一个
      if (settledOut) {
        const next = _readWaiters.shift();
        next?.();
        return;
      }
      if (_readActive >= READ_LANE_CONCURRENCY) {
        _readWaiters.push(tryStart);
        return;
      }
      _readActive++;
      releaseLane = settle(exec(), () => {
        // Math.max 守卫：_resetShellQueueForTests 清零后，在途 fn 的迟到 settle 不得减成负数
        _readActive = Math.max(0, _readActive - 1);
        const next = _readWaiters.shift();
        next?.();
      });
    };
    tryStart();
  }

  return { promise, status: computeStatus };
}

/** 当前队列状态（无入队时也可查，供 UI/后台冲突检测展示） */
export function getShellQueueStatus(): ShellQueueStatus {
  return computeStatus();
}

/** 仅测试用：清空队列全局状态（entries / 链 / read 槽位）。
 *  生产代码不得调用 —— 在途命令的链引用被丢弃后其 fn 仍会跑完，但状态不可见。 */
export function _resetShellQueueForTests(): void {
  _entries.length = 0;
  _exclusiveChain = Promise.resolve();
  _readActive = 0;
  _readWaiters.length = 0;
}
