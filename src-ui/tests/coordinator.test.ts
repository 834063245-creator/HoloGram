// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { SubAgentPool, SubAgentStatus } from '../src/agent/coordinator';

function fakeRun(result: string, delayMs = 10, shouldFail = false) {
  return () =>
    new Promise<{ text: string; err?: string }>((resolve, reject) => {
      setTimeout(() => {
        if (shouldFail) reject(new Error('simulated failure'));
        else resolve({ text: result });
      }, delayMs);
    });
}

describe('SubAgentPool', () => {
  it('spawn returns a task ID immediately', () => {
    const pool = new SubAgentPool();
    const id = pool.spawn('test task', fakeRun('done'));
    expect(id).toBeTruthy();
    expect(id.startsWith('subagent-')).toBe(true);
  });

  it('tracks running agents', () => {
    const pool = new SubAgentPool();
    pool.spawn('task A', fakeRun('a', 5000));
    pool.spawn('task B', fakeRun('b', 5000));
    expect(pool.runningCount).toBe(2);
    expect(pool.summary()).toContain('task A');
    expect(pool.summary()).toContain('task B');
  });

  it('pollCompleted returns finished agents', async () => {
    const pool = new SubAgentPool();
    pool.spawn('quick', fakeRun('result', 10));

    // Wait for completion
    await new Promise(r => setTimeout(r, 50));

    const completed = pool.pollCompleted();
    expect(completed.length).toBe(1);
    expect(completed[0].status).toBe(SubAgentStatus.Completed);
    expect(completed[0].result).toBe('result');
    expect(pool.runningCount).toBe(0);
  });

  it('marks failed agents', async () => {
    const pool = new SubAgentPool();
    pool.spawn('will fail', fakeRun('', 10, true));

    await new Promise(r => setTimeout(r, 50));

    const completed = pool.pollCompleted();
    expect(completed.length).toBe(1);
    expect(completed[0].status).toBe(SubAgentStatus.Failed);
  });

  it('stop terminates a running agent', () => {
    const pool = new SubAgentPool();
    const id = pool.spawn('long task', fakeRun('done', 5000));
    expect(pool.runningCount).toBe(1);

    const stopped = pool.stop(id);
    expect(stopped).toBe(true);
    expect(pool.runningCount).toBe(0);

    const completed = pool.pollCompleted();
    expect(completed.length).toBe(1);
    expect(completed[0].status).toBe(SubAgentStatus.Stopped);
  });

  it('stop returns false for unknown ID', () => {
    const pool = new SubAgentPool();
    expect(pool.stop('nonexistent')).toBe(false);
  });

  it('sendMessage succeeds for running agent with callback', () => {
    const pool = new SubAgentPool();
    const messages: string[] = [];

    const id = pool.spawn(
      'interactive',
      (onMsg) => {
        onMsg?.('initialized');
        return fakeRun('done')();
      },
      (msg) => { messages.push(msg); },
    );

    // sendMessage before the promise resolves
    const ok = pool.sendMessage(id, 'follow-up question');
    expect(ok).toBe(true);
  });

  it('sendMessage fails for completed agent', async () => {
    const pool = new SubAgentPool();
    const id = pool.spawn('quick', fakeRun('done', 10));

    await new Promise(r => setTimeout(r, 50));
    pool.pollCompleted(); // consume

    const ok = pool.sendMessage(id, 'too late');
    expect(ok).toBe(false);
  });

  it('multiple agents complete independently', async () => {
    const pool = new SubAgentPool();
    pool.spawn('fast', fakeRun('fast', 10));
    pool.spawn('slow', fakeRun('slow', 100));
    pool.spawn('medium', fakeRun('medium', 50));

    await new Promise(r => setTimeout(r, 60));

    // Fast and medium should be done
    const batch1 = pool.pollCompleted();
    expect(batch1.length).toBeGreaterThanOrEqual(1);

    await new Promise(r => setTimeout(r, 60));
    const batch2 = pool.pollCompleted();
    const all = [...batch1, ...batch2];
    expect(all.length).toBe(3);
  });

  it('pollCompleted clears after read', async () => {
    const pool = new SubAgentPool();
    pool.spawn('task', fakeRun('result', 10));
    await new Promise(r => setTimeout(r, 50));

    const first = pool.pollCompleted();
    expect(first.length).toBe(1);

    const second = pool.pollCompleted();
    expect(second.length).toBe(0);
  });
});
