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

  it('queues at maxConcurrent instead of returning null', () => {
    const pool = new SubAgentPool(1);
    pool.spawn('a', () => new Promise<{ text: string }>(() => {}));
    const second = pool.spawn('b', fakeRun('b'));
    // Now queues instead of returning null
    expect(second).not.toBeNull();
    expect(second?.id).toBeTruthy();
    expect(pool.isQueued(second!.id)).toBe(true);
    pool.stopAll();
  });

  it('returns null when queue is full (20 items)', () => {
    const pool = new SubAgentPool(1);
    pool.spawn('blocker', () => new Promise<{ text: string }>(() => {}));
    // Fill the queue
    for (let i = 0; i < 20; i++) {
      const s = pool.spawn(`q-${i}`, fakeRun('ok'));
      expect(s).not.toBeNull();
    }
    // 21st should return null
    const overflow = pool.spawn('overflow', fakeRun('nope'));
    expect(overflow).toBeNull();
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

  // ── R5: Queue path alias mapping ──

  it('R5: queued agent alias is re-mapped to internal id after drain', async () => {
    // Fill the pool to capacity, then spawn one more (queued)
    const pool = new SubAgentPool(1, 60000);
    // Occupy the single slot
    const occupying = pool.spawn('occupier', () => new Promise<{ text: string }>(() => {}))!;
    expect(pool.runningCount).toBe(1);

    // This one should be queued
    const queuedSpawn = pool.spawn('queued task', fakeRun('queued result', 5))!;
    const modelId = 'sub-test-123';
    pool.registerAlias(modelId, queuedSpawn.id);

    // The queued id should be in _queuedIds
    expect(pool.isQueued(queuedSpawn.id)).toBe(true);

    // Stop the occupier to free a slot → triggers _drainQueue
    pool.stop(occupying.id);

    // Wait for the queued agent to finish
    const handle = await queuedSpawn.done;
    expect(handle.status).toBe(SubAgentStatus.Completed);
    expect(handle.result).toBe('queued result');

    // After drain + completion, the alias should be cleaned up
    expect(pool.getHandle(modelId)).toBeDefined(); // Should find in completed
    pool.stopAll();
  });

  it('R5: stop by model-visible alias works for drained (previously queued) agent', async () => {
    const pool = new SubAgentPool(1, 60000);
    // Fill the slot
    const occupier = pool.spawn('occupier', () => new Promise<{ text: string }>(() => {}))!;

    // Queue a second agent
    const queuedSpawn = pool.spawn('queued', () => new Promise<{ text: string }>(() => {}))!;
    const modelId = 'sub-alias-test';
    pool.registerAlias(modelId, queuedSpawn.id);

    // Free the slot → drain happens
    pool.stop(occupier.id);

    // Now stop the drained agent using the model-visible alias
    const stopped = pool.stop(modelId);
    expect(stopped).toBe(true);

    const handle = await queuedSpawn.done;
    expect(handle.status).toBe(SubAgentStatus.Stopped);
  });

  // ── Queue-kill: stopping an agent that is STILL queued (never spawned) ──

  it('stop works on a queued (never-spawned) agent and settles done as stopped', async () => {
    const pool = new SubAgentPool(1, 60000);
    pool.spawn('occupier', () => new Promise<{ text: string }>(() => {}));
    const queued = pool.spawn('queued task', fakeRun('never runs', 5))!;
    expect(pool.isQueued(queued.id)).toBe(true);

    expect(pool.stop(queued.id)).toBe(true);
    expect(pool.isQueued(queued.id)).toBe(false);

    const handle = await queued.done;
    expect(handle.status).toBe(SubAgentStatus.Stopped);
    expect(handle.error).toContain('queued');
    // The stopped queued agent is recorded in history under its queued id
    expect(pool.getHandle(queued.id)?.status).toBe(SubAgentStatus.Stopped);
    pool.stopAll();
  });

  it('stop by alias works on a queued agent (before any drain)', async () => {
    const pool = new SubAgentPool(1, 60000);
    pool.spawn('occupier', () => new Promise<{ text: string }>(() => {}));
    const queued = pool.spawn('queued', () => new Promise<{ text: string }>(() => {}))!;
    pool.registerAlias('sub-still-queued', queued.id);

    expect(pool.stop('sub-still-queued')).toBe(true);
    const handle = await queued.done;
    expect(handle.status).toBe(SubAgentStatus.Stopped);
    pool.stopAll();
  });

  it('stopAll drains the queue instead of letting _drainQueue spawn queued agents', async () => {
    const pool = new SubAgentPool(1, 60000);
    let queuedRan = false;
    pool.spawn('occupier', () => new Promise<{ text: string }>(() => {}));
    const queued = pool.spawn('queued', (signal) => {
      queuedRan = true;
      return fakeRun('should never resolve', 5)(signal);
    })!;

    const stopped = pool.stopAll();
    expect(stopped).toContain(queued.id);
    expect(pool.isQueued(queued.id)).toBe(false);

    const handle = await queued.done;
    expect(handle.status).toBe(SubAgentStatus.Stopped);

    // Give any erroneous drain a chance to fire — the queued runFn must never start
    await new Promise((r) => setTimeout(r, 50));
    expect(queuedRan).toBe(false);
    expect(pool.runningCount).toBe(0);
  });

  it('ownedDisposer — 停全部子 Agent、清超时 timer，幂等（Phase 4 所有权原语）', async () => {
    const pool = new SubAgentPool();
    const a = pool.spawn('task A', fakeRun('a', 60000));
    const b = pool.spawn('task B', fakeRun('b', 60000));
    expect(pool.runningCount).toBe(2);

    const dispose = pool.ownedDisposer();
    dispose();
    dispose(); // 幂等 — 第二次 no-op

    expect(pool.runningCount).toBe(0);
    const ha = await a?.done;
    const hb = await b?.done;
    expect(ha?.status).toBe(SubAgentStatus.Stopped);
    expect(hb?.status).toBe(SubAgentStatus.Stopped);
  });
});
