// SPDX-License-Identifier: MIT
// Round 2 audit fix tests: R1 (message recovery), R4 (discard), R6 (session isolation),
// R8 (forceClearState flush), low-prio (discovery dedup, notice scoping, compaction replace)

import { describe, expect, it, vi } from 'vitest';
import { TaskBoard } from '../src/agent/task-board';
import { DiscoveryBoard } from '../src/agent/discovery-board';

// ── Mock RPC ──
const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
}));

// ── R6: TaskBoard.destroy() clears entries and prevents flush revival ──
describe('R6: TaskBoard destroy prevents flush revival', () => {
  it('destroy clears entries and sets _destroyed flag', async () => {
    const board = new TaskBoard('D:/test', 'session-1');
    board.register('agent-1', 'parent-1', 'task A', null);
    expect(board.getAllEntries().length).toBeGreaterThan(0);

    mockRpc.mockResolvedValue(undefined);
    await board.destroy();

    expect(board.getAllEntries().length).toBe(0);

    // Flush after destroy should be a no-op
    mockRpc.mockClear();
    await board.flush();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── R6: DiscoveryBoard.destroy() clears entries and prevents flush revival ──
describe('R6: DiscoveryBoard destroy prevents flush revival', () => {
  it('destroy clears entries and prevents subsequent flush', async () => {
    const board = new DiscoveryBoard('D:/test', 'session-1');
    board.post('agent-1', 'key1', 'value1', 'category1');
    expect(board.query({ agentId: 'agent-1' }).length).toBeGreaterThan(0);

    mockRpc.mockResolvedValue(undefined);
    await board.destroy();

    expect(board.query({ agentId: 'agent-1' }).length).toBe(0);

    mockRpc.mockClear();
    await board.flush();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ── Low-prio: DiscoveryBoard.restore() deduplicates by agentId+key ──
describe('DiscoveryBoard restore deduplicates entries', () => {
  it('restore keeps only last entry per agentId+key', async () => {
    const board = new DiscoveryBoard('D:/test', 'session-1');
    const now = Date.now();
    const entries = [
      { id: '1', agentId: 'a1', key: 'k1', value: 'old', category: 'cat', ts: now - 2000, status: 'active' as const },
      { id: '2', agentId: 'a1', key: 'k1', value: 'new', category: 'cat', ts: now - 1000, status: 'active' as const },
      { id: '3', agentId: 'a2', key: 'k2', value: 'v2', category: 'cat', ts: now, status: 'active' as const },
    ];
    mockRpc.mockResolvedValue(JSON.stringify(entries));

    await board.restore();

    // Debug: check all entries
    expect(board.getAll().length).toBe(2); // a1:k1 (deduped) + a2:k2

    const results = board.query({ agentId: 'a1' });
    expect(results.length).toBe(1);
    expect(results[0].value).toBe('new');
    expect(board.query({ agentId: 'a2' }).length).toBe(1);
  });
});

// ── Low-prio: CompactionTracker.deserializeState replaces instead of appending ──
describe('CompactionTracker deserializeState replaces not appends', () => {
  it('calling deserializeState twice does not duplicate events', async () => {
    const { CompactionTracker } = await import('../src/agent/compaction-model');
    const tracker = new CompactionTracker();
    const state1 = JSON.stringify({
      events: [{ type: 'turn', turn: 1 }],
      turnsAfter: [1],
      filesRead: ['a.ts'],
    });
    tracker.deserializeState(state1);
    const parsed1 = JSON.parse(tracker.serializeState());
    expect(parsed1.events.length).toBe(1);

    // Deserialize again with the same state
    tracker.deserializeState(state1);
    const parsed2 = JSON.parse(tracker.serializeState());
    // Should still be 1, not 2 (replace, not append)
    expect(parsed2.events.length).toBe(1);
  });
});
