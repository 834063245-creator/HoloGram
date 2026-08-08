// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell-queue v2 单元测试 — 分车道调度 + 取消语义
//
// 覆盖：
//   1. exclusive 车道 FIFO 串行
//   2. read 车道并发 ≤3
//   3. read 与 exclusive 互不阻塞
//   4. 排队中 abort → 出队 + reject AbortError + fn 未执行
//   5. 运行中 abort → onCancelRunning + resolve 取消文案 + 车道立即前进
//   6. 入队时已 aborted → 不入队
//   7. unknown 归 exclusive 车道
//   8. status() 两车道形状

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetShellQueueForTests,
  enqueueShellOp,
  getShellQueueStatus,
  READ_LANE_CONCURRENCY,
  SHELL_CANCELLED_MESSAGE,
} from '../src/agent/runtime/shell-queue';

// 队列是模块级全局状态 — 每个用例后重置，失败用例的僵尸 entry 不得污染后续用例
afterEach(() => {
  _resetShellQueueForTests();
});

// ── helpers ──

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让微任务/链式调度推进一轮 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** 记录启动顺序的可控 fn */
function tracked(id: string, started: string[], gate?: ReturnType<typeof deferred<string>>) {
  return () => {
    started.push(id);
    return gate ? gate.promise : Promise.resolve(`${id}-done`);
  };
}

// ═══════════════════════════════════════════════════════

describe('shell-queue v2', () => {
  it('exclusive 车道严格 FIFO 串行', async () => {
    const started: string[] = [];
    const g1 = deferred<string>();
    const g2 = deferred<string>();

    const h1 = enqueueShellOp(tracked('w1', started, g1), { cmd: 'touch a', cls: 'write' });
    const h2 = enqueueShellOp(tracked('w2', started, g2), { cmd: 'touch b', cls: 'write' });
    const h3 = enqueueShellOp(tracked('w3', started), { cmd: 'touch c', cls: 'write' });

    await tick();
    expect(started).toEqual(['w1']); // 头部独占

    g1.resolve('w1-done');
    await tick();
    expect(started).toEqual(['w1', 'w2']); // 串行推进

    g2.resolve('w2-done');
    await tick();
    expect(started).toEqual(['w1', 'w2', 'w3']);

    await expect(h1.promise).resolves.toBe('w1-done');
    await expect(h2.promise).resolves.toBe('w2-done');
    await expect(h3.promise).resolves.toBe('w3-done');
    expect(getShellQueueStatus().length).toBe(0);
  });

  it('read 车道并发上限 + 等待者 FIFO 唤醒', async () => {
    const started: string[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<string>());
    const handles = gates.map((g, i) => enqueueShellOp(tracked(`r${i}`, started, g), { cmd: `ls ${i}`, cls: 'read' }));

    await tick();
    // 恰好 READ_LANE_CONCURRENCY 个并发启动，其余等待
    expect(started).toHaveLength(READ_LANE_CONCURRENCY);
    expect(started).toEqual(['r0', 'r1', 'r2']);

    gates[0].resolve('r0-done');
    await tick();
    expect(started).toEqual(['r0', 'r1', 'r2', 'r3']); // 唤醒第 4 个

    gates[1].resolve('r1-done');
    await tick();
    expect(started).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']); // 唤醒第 5 个

    gates.slice(2).forEach((g) => {
      g.resolve('done');
    });
    await Promise.all(handles.map((h) => h.promise));
    expect(getShellQueueStatus().length).toBe(0);
  });

  it('read 与 exclusive 车道互不阻塞', async () => {
    const started: string[] = [];
    const gW = deferred<string>();

    const hW = enqueueShellOp(tracked('w', started, gW), { cmd: 'cargo build', cls: 'heavy' });
    const hR = enqueueShellOp(tracked('r', started), { cmd: 'ls', cls: 'read' });

    await tick();
    // heavy 挂着不完成 — read 照样立即执行（v1 里会被堵到 heavy 结束）。
    // read 同步启动、exclusive 经微任务启动 — 先后不定，两者都启动了即可
    expect(started).toHaveLength(2);
    expect(started).toContain('w');
    expect(started).toContain('r');
    await expect(hR.promise).resolves.toBe('r-done');

    // 反向：3 个 read 挂满 read 车道时，exclusive 车道空闲 → write 立即执行
    gW.resolve('w-done'); // 先释放 exclusive 头部（否则 w2 应在本车道内排队等 w —— FIFO 语义）
    await expect(hW.promise).resolves.toBe('w-done');
    const rg = Array.from({ length: READ_LANE_CONCURRENCY }, () => deferred<string>());
    const rHandles = rg.map((g, i) => enqueueShellOp(tracked(`rr${i}`, started, g), { cmd: `ls x${i}`, cls: 'read' }));
    const hW2 = enqueueShellOp(tracked('w2', started), { cmd: 'git status', cls: 'write' });
    await tick();
    expect(started).toContain('w2');

    rg.forEach((g) => {
      g.resolve('done');
    });
    await Promise.all([...rHandles.map((h) => h.promise), hW2.promise]);
  });

  it('排队中 abort → 出队 reject AbortError，fn 从未执行，后续正常推进', async () => {
    const started: string[] = [];
    const g1 = deferred<string>();
    const ctrl = new AbortController();

    const h1 = enqueueShellOp(tracked('w1', started, g1), { cmd: 'cargo build', cls: 'heavy' });
    const h2 = enqueueShellOp(tracked('w2', started), { cmd: 'cargo test', cls: 'heavy' }, { signal: ctrl.signal });
    const h3 = enqueueShellOp(tracked('w3', started), { cmd: 'ls', cls: 'write' });

    await tick();
    expect(started).toEqual(['w1']);
    expect(getShellQueueStatus().lanes.exclusive.waiters).toHaveLength(2);

    ctrl.abort();
    await expect(h2.promise).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    // w2 已出队且 fn 未执行；w1 仍在跑，w3 仍排队
    expect(started).toEqual(['w1']);
    expect(getShellQueueStatus().lanes.exclusive.waiters.map((w) => w.cmd)).toEqual(['ls']);

    g1.resolve('w1-done');
    await tick();
    expect(started).toEqual(['w1', 'w3']); // 队列正常前进

    await expect(h1.promise).resolves.toBe('w1-done');
    await expect(h3.promise).resolves.toBe('w3-done');
    expect(getShellQueueStatus().length).toBe(0);
  });

  it('运行中 abort → onCancelRunning 杀进程 + resolve 取消文案 + 互斥车道立即前进', async () => {
    const started: string[] = [];
    const g1 = deferred<string>();
    const ctrl = new AbortController();
    let cancelled = 0;

    const h1 = enqueueShellOp(
      tracked('w1', started, g1),
      { cmd: 'cargo test', cls: 'heavy' },
      {
        signal: ctrl.signal,
        onCancelRunning: () => {
          cancelled++;
        },
      },
    );
    const h2 = enqueueShellOp(tracked('w2', started), { cmd: 'ls', cls: 'write' });

    await tick();
    expect(started).toEqual(['w1']);

    ctrl.abort();
    // 对外立即 resolve 取消文案（不等被 kill 的 fn 落地）
    await expect(h1.promise).resolves.toBe(SHELL_CANCELLED_MESSAGE);
    expect(cancelled).toBe(1);

    // 互斥车道立即放行下一个 —— w1 的 fn（g1）还挂着也不挡
    await tick();
    expect(started).toEqual(['w1', 'w2']);
    await expect(h2.promise).resolves.toBe('w2-done');

    // 被杀 fn 迟到 settle — 不二次触发，队列状态干净
    g1.resolve('w1-late');
    await tick();
    expect(getShellQueueStatus().length).toBe(0);
  });

  it('read 车道运行中 abort → 立即释放并发槽', async () => {
    const started: string[] = [];
    const gates = Array.from({ length: READ_LANE_CONCURRENCY }, () => deferred<string>());
    const ctrls = Array.from({ length: READ_LANE_CONCURRENCY }, () => new AbortController());

    const handles = gates.map((g, i) =>
      enqueueShellOp(tracked(`r${i}`, started, g), { cmd: `ls ${i}`, cls: 'read' }, { signal: ctrls[i].signal }),
    );
    await tick();
    expect(started).toHaveLength(READ_LANE_CONCURRENCY);

    // 第 4 个在等待槽位
    const h4 = enqueueShellOp(tracked('r3', started), { cmd: 'ls 3', cls: 'read' });
    await tick();
    expect(started).toHaveLength(READ_LANE_CONCURRENCY);

    // abort 一个运行中的 read — 槽位立即释放，r3 启动
    ctrls[0].abort();
    await expect(handles[0].promise).resolves.toBe(SHELL_CANCELLED_MESSAGE);
    await tick();
    expect(started).toContain('r3');

    gates.slice(1).forEach((g) => {
      g.resolve('done');
    });
    await Promise.all([...handles.slice(1).map((h) => h.promise), h4.promise]);
  });

  it('入队时已 aborted → 不入队，不占队列', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const before = getShellQueueStatus().length;
    const h = enqueueShellOp(() => Promise.resolve('x'), { cmd: 'ls', cls: 'read' }, { signal: ctrl.signal });
    await expect(h.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(getShellQueueStatus().length).toBe(before);
  });

  it('unknown 类归 exclusive 车道（保守串行）', async () => {
    const started: string[] = [];
    const g1 = deferred<string>();

    const h1 = enqueueShellOp(tracked('w', started, g1), { cmd: 'some-tool --flag', cls: 'unknown' });
    const h2 = enqueueShellOp(tracked('u', started), { cmd: 'other-tool', cls: 'unknown' });

    await tick();
    expect(started).toEqual(['w']); // unknown 与 unknown 串行

    g1.resolve('w-done');
    await tick();
    expect(started).toEqual(['w', 'u']);
    await expect(h1.promise).resolves.toBe('w-done');
    await expect(h2.promise).resolves.toBe('u-done');
  });

  it('status() 正确反映两车道 running/waiters', async () => {
    const g1 = deferred<string>();
    const g2 = deferred<string>();

    enqueueShellOp(tracked('w', [], g1), { cmd: 'cargo build', cls: 'heavy' });
    enqueueShellOp(tracked('w2', [], g2), { cmd: 'npm test', cls: 'heavy' });
    enqueueShellOp(tracked('r', [], g2), { cmd: 'ls', cls: 'read' });

    await tick();
    const s = getShellQueueStatus();
    expect(s.length).toBe(3);
    expect(s.lanes.exclusive.running.map((r) => r.cmd)).toEqual(['cargo build']);
    expect(s.lanes.exclusive.waiters.map((w) => w.cmd)).toEqual(['npm test']);
    expect(s.lanes.read.running.map((r) => r.cmd)).toEqual(['ls']);
    expect(s.lanes.read.waiters).toHaveLength(0);

    g1.resolve('a');
    g2.resolve('b');
    await tick();
    expect(getShellQueueStatus().length).toBe(0);
  });
});
