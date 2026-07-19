// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { SubAgentPool, SubAgentStatus } from '../src/agent/coordinator';

function fakeRun(result: string, delayMs = 10, shouldFail = false) {
  return (_signal: AbortSignal) =>
    new Promise<{ text: string; err?: string }>((resolve, reject) => {
      setTimeout(() => {
        if (shouldFail) reject(new Error('simulated failure'));
        else resolve({ text: result });
      }, delayMs);
    });
}

describe('SubAgentPool', () => {
  it('spawn returns id + signal + done synchronously', async () => {
    const pool = new SubAgentPool();
    const spawned = pool.spawn('test task', fakeRun('done'));
    expect(spawned).toBeTruthy();
    expect(spawned?.id.startsWith('subagent-')).toBe(true);
    expect(spawned?.signal).toBeInstanceOf(AbortSignal);
    const handle = await spawned?.done;
    expect(handle.status).toBe(SubAgentStatus.Completed);
    expect(handle.result).toBe('done');
  });

  it('hands the abort signal to runFn SYNCHRONOUSLY (late-assignment race regression)', () => {
    // Regression: the old agent_spawn tool assigned subSignal AFTER pool.spawn
    // returned, but runFn is invoked synchronously inside spawn — the spawner
    // always received undefined and "stopped" agents kept running detached.
    const pool = new SubAgentPool();
    let received: AbortSignal | undefined;
    pool.spawn('check', (signal) => {
      received = signal;
      return Promise.resolve({ text: 'ok' });
    });
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });

  it('tracks running agents', () => {
    const pool = new SubAgentPool();
    pool.spawn('task A', fakeRun('a', 5000));
    pool.spawn('task B', fakeRun('b', 5000));
    expect(pool.runningCount).toBe(2);
    expect(pool.summary()).toContain('task A');
    expect(pool.summary()).toContain('task B');
    pool.stopAll();
  });

  it('done resolves with failed status when runFn rejects', async () => {
    const pool = new SubAgentPool();
    const spawned = pool.spawn('will fail', fakeRun('', 10, true));
    const handle = await spawned?.done;
    expect(handle.status).toBe(SubAgentStatus.Failed);
    expect(handle.error).toContain('simulated failure');
  });

  it('done resolves with failed status when runFn resolves with err', async () => {
    const pool = new SubAgentPool();
    const spawned = pool.spawn('soft fail', () => Promise.resolve({ text: '', err: 'boom' }));
    const handle = await spawned?.done;
    expect(handle.status).toBe(SubAgentStatus.Failed);
    expect(handle.error).toBe('boom');
  });

  it('stop aborts the runFn signal AND settles done as stopped (kill-chain regression)', async () => {
    const pool = new SubAgentPool();
    let received: AbortSignal | undefined;
    const spawned = pool.spawn('long task', (signal) => {
      received = signal;
      return new Promise<{ text: string }>(() => {}); // never settles on its own
    })!;
    expect(pool.runningCount).toBe(1);

    expect(pool.stop(spawned.id)).toBe(true);
    // The actual work must receive the abort — this is the whole point of the fix.
    expect(received?.aborted).toBe(true);
    expect(pool.runningCount).toBe(0);

    const handle = await spawned.done;
    expect(handle.status).toBe(SubAgentStatus.Stopped);
  });

  it('stop returns false for unknown ID', () => {
    const pool = new SubAgentPool();
    expect(pool.stop('nonexistent')).toBe(false);
  });

  it('stopAll aborts every running agent', async () => {
    const pool = new SubAgentPool();
    const signals: AbortSignal[] = [];
    const s1 = pool.spawn('a', (sig) => {
      signals.push(sig);
      return new Promise<{ text: string }>(() => {});
    })!;
    const s2 = pool.spawn('b', (sig) => {
      signals.push(sig);
      return new Promise<{ text: string }>(() => {});
    })!;

    const stopped = pool.stopAll();
    expect(stopped.sort()).toEqual([s1.id, s2.id].sort());
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(pool.runningCount).toBe(0);

    const [h1, h2] = await Promise.all([s1.done, s2.done]);
    expect(h1.status).toBe(SubAgentStatus.Stopped);
    expect(h2.status).toBe(SubAgentStatus.Stopped);
  });

  it('timeout aborts the runFn and resolves done with a timeout failure', async () => {
    const pool = new SubAgentPool(5, 30); // 30ms pool default
    let received: AbortSignal | undefined;
    const spawned = pool.spawn('slow', (signal) => {
      received = signal;
      return new Promise<{ text: string }>(() => {});
    })!;
    const handle = await spawned.done;
    expect(handle.status).toBe(SubAgentStatus.Failed);
    expect(handle.error).toContain('timeout');
    expect(received?.aborted).toBe(true);
  });

  it('per-spawn timeout override wins over pool default', async () => {
    const pool = new SubAgentPool(5, 60_000);
    const spawned = pool.spawn('slow', () => new Promise<{ text: string }>(() => {}), undefined, 30)!;
    const handle = await spawned.done;
    expect(handle.error).toContain('timeout');
  });

  it('returns null at maxConcurrent', () => {
    const pool = new SubAgentPool(1);
    pool.spawn('a', () => new Promise<{ text: string }>(() => {}));
    const second = pool.spawn('b', fakeRun('b'));
    expect(second).toBeNull();
    pool.stopAll();
  });

  it('spawn with same callId returns the already-running agent', () => {
    const pool = new SubAgentPool();
    const s1 = pool.spawn('task', () => new Promise<{ text: string }>(() => {}), 'call-001')!;
    const s2 = pool.spawn('duplicate', fakeRun('ignored'), 'call-001')!;
    expect(s2.id).toBe(s1.id);
    expect(pool.runningCount).toBe(1);
    pool.stopAll();
  });

  it('getHandle finds running and completed agents', async () => {
    const pool = new SubAgentPool();
    const running = pool.spawn('running', () => new Promise<{ text: string }>(() => {}))!;
    expect(pool.getHandle(running.id)?.status).toBe(SubAgentStatus.Running);

    const doneSpawn = pool.spawn('quick', fakeRun('result', 5))!;
    await doneSpawn.done;
    const h = pool.getHandle(doneSpawn.id);
    expect(h?.status).toBe(SubAgentStatus.Completed);
    expect(h?.result).toBe('result');

    expect(pool.getHandle('nope')).toBeUndefined();
    pool.stopAll();
  });

  it('late completion after stop hits the finished guard (no double-settle)', async () => {
    const pool = new SubAgentPool();
    let resolveRun: ((v: { text: string }) => void) | undefined;
    const spawned = pool.spawn('race', () => new Promise<{ text: string }>((r) => (resolveRun = r)))!;
    pool.stop(spawned.id);
    resolveRun?.({ text: 'late' });
    const handle = await spawned.done;
    expect(handle.status).toBe(SubAgentStatus.Stopped);
    expect(handle.result).toBeUndefined();
    expect(pool.runningCount).toBe(0);
  });

  it('summary lists running and recent completed agents', async () => {
    const pool = new SubAgentPool();
    const doneSpawn = pool.spawn('done task', fakeRun('r', 5))!;
    await doneSpawn.done;
    pool.spawn('running task', () => new Promise<{ text: string }>(() => {}));
    const s = pool.summary();
    expect(s).toContain('done task');
    expect(s).toContain('running task');
    pool.stopAll();
  });
});
