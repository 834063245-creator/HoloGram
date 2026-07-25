// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Compaction cost model tests — verifying the math, not the integration.
// Regression guard: if netBenefit / optimalRecentKeep / breakevenTurns breaks, CI catches it.

import { describe, expect, it } from 'vitest';
import {
  breakevenTurns,
  CompactionTracker,
  estimateLoss,
  estimateTokens,
  formatCompactionReport,
  netBenefit,
  optimalRecentKeep,
  tailCost,
} from '../src/agent/compaction-model';

// ── netBenefit ──

describe('netBenefit', () => {
  it('positive when enough turns remain', () => {
    // 500K region, 10K summary, 5 turns remaining, no loss
    const b = netBenefit({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 5,
      extraTurnsFromLoss: 0,
      avgTurnCost: 2.0,
    });
    // saved: 500K * (5-1) * 3 / 1M = 2_000_000 * 3 / 1M = $6.00
    // cost: (500K * 3 + 10K * 15) / 1M = (1.5M + 150K) / 1M = $1.65
    // net = 6.00 - 1.65 = 4.35
    expect(b).toBeCloseTo(4.35, 2);
  });

  it('negative when too few turns remain', () => {
    const b = netBenefit({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 1, // only 1 remaining = no savings
      extraTurnsFromLoss: 0,
      avgTurnCost: 2.0,
    });
    // saved: 500K * 0 = $0
    // cost: $1.65
    // net = -1.65
    expect(b).toBeCloseTo(-1.65, 2);
  });

  it('negative when info loss causes extra turns', () => {
    const b = netBenefit({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 5,
      extraTurnsFromLoss: 3, // 3 extra turns at $2 each = $6 loss
      avgTurnCost: 2.0,
    });
    // saved: $6.00
    // cost: $1.65 + $6.00 = $7.65
    // net = -1.65
    expect(b).toBeLessThan(0);
  });

  it('zero benefit at exact breakeven', () => {
    const b = netBenefit({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 2, // breakeven: 500K * (2-1) * 3 / 1M = $1.50, vs cost $1.65
      extraTurnsFromLoss: 0,
      avgTurnCost: 2.0,
    });
    // Actually 2 turns is not quite breakeven. Let me compute exact:
    // saved: 500K * 1 * 3 / 1M = $1.50
    // cost: $1.65
    expect(b).toBeCloseTo(-0.15, 2);
  });
});

// ── breakevenTurns ──

describe('breakevenTurns', () => {
  it('~2 turns for typical compression params', () => {
    const t = breakevenTurns({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 0, // not used in breakeven calc
      extraTurnsFromLoss: 0,
      avgTurnCost: 2.0,
    });
    // T = 1 + (10K * 15) / (500K * 3) = 1 + 150K/1500K = 1 + 0.1 = 1.1
    expect(t).toBeCloseTo(1.1, 1);
  });

  it('higher with expensive output model', () => {
    const t = breakevenTurns({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 0,
      extraTurnsFromLoss: 0,
      avgTurnCost: 2.0,
      cOut: 30, // twice as expensive output
    });
    // T = 1 + (10K * 30) / (500K * 3) = 1 + 300K/1500K = 1 + 0.2 = 1.2
    expect(t).toBeCloseTo(1.2, 1);
  });

  it('increases with info loss', () => {
    const t = breakevenTurns({
      regionTokens: 500_000,
      summaryTokens: 10_000,
      turnsRemaining: 0,
      extraTurnsFromLoss: 1.5, // 1.5 extra turns at $2 each = $3
      avgTurnCost: 2.0,
    });
    // T = 1 + (150K + 3*1M) / 1500K = 1 + 3150K/1500K = 1 + 2.1 = 3.1
    expect(t).toBeCloseTo(3.1, 1);
  });
});

// ── estimateLoss ──

describe('estimateLoss', () => {
  it('decreases as k increases (more tail = less loss)', () => {
    const loss4 = estimateLoss(4, 100);
    const loss8 = estimateLoss(8, 100);
    expect(loss8).toBeLessThan(loss4);
  });

  it('zero when k covers entire region', () => {
    const loss = estimateLoss(100, 100);
    expect(loss).toBe(0);
  });

  it('bounded below 1 for reasonable sessions', () => {
    const loss = estimateLoss(4, 200);
    expect(loss).toBeLessThan(1);
  });
});

// ── tailCost ──

describe('tailCost', () => {
  it('linear in k', () => {
    const c4 = tailCost(4, 500);
    const c8 = tailCost(8, 500);
    expect(c8).toBeCloseTo(c4 * 2, 5);
  });
});

// ── optimalRecentKeep ──

describe('optimalRecentKeep', () => {
  it('returns k >= 1', () => {
    const { k } = optimalRecentKeep(100, 500, 2.0);
    expect(k).toBeGreaterThanOrEqual(1);
  });

  it('larger k for more messages (more to lose)', () => {
    const r1 = optimalRecentKeep(50, 500, 2.0);
    const r2 = optimalRecentKeep(200, 500, 2.0);
    // More messages → potentially higher optimal k to reduce loss
    expect(r2.k).toBeGreaterThanOrEqual(r1.k);
  });

  it('smaller k when tokens are expensive', () => {
    const r1 = optimalRecentKeep(100, 500, 2.0, 0.3, 3);
    const r2 = optimalRecentKeep(100, 500, 2.0, 0.3, 15);
    // More expensive input → smaller optimal k
    expect(r2.k).toBeLessThanOrEqual(r1.k);
  });
});

// ── estimateTokens ──

describe('estimateTokens', () => {
  it('roughly chars/2.5', () => {
    expect(estimateTokens(1000)).toBe(400);
    expect(estimateTokens(0)).toBe(0);
  });
});

// ── CompactionTracker ──

describe('CompactionTracker', () => {
  it('tracks turns', () => {
    const t = new CompactionTracker();
    t.recordTurn();
    t.recordTurn();
    expect(t.getStats().totalTurns).toBe(2);
  });

  it('detects re-reads post-compaction', () => {
    const t = new CompactionTracker();
    t.recordFileRead('/src/foo.ts');
    // Simulate compaction
    t.recordCompaction({
      ts: Date.now(),
      regionMsgCount: 5,
      regionTokensEst: 10000,
      summaryInputTokens: 10000,
      summaryOutputTokens: 500,
      tailMsgCount: 4,
      preTokens: 15000,
      postTokens: 5000,
      outcome: 'summary',
    });
    // Re-read same file after compaction
    t.recordFileRead('/src/foo.ts');
    const stats = t.getStats();
    expect(stats.reReadCount).toBe(1);
  });

  it('detects duplicate tool calls post-compaction', () => {
    const t = new CompactionTracker();
    t.recordToolCall('read_file', '{"filePath":"/src/bar.ts"}');
    t.recordCompaction({
      ts: Date.now(),
      regionMsgCount: 5,
      regionTokensEst: 10000,
      summaryInputTokens: 10000,
      summaryOutputTokens: 500,
      tailMsgCount: 4,
      preTokens: 15000,
      postTokens: 5000,
      outcome: 'summary',
    });
    t.recordToolCall('read_file', '{"filePath":"/src/bar.ts"}');
    const stats = t.getStats();
    expect(stats.duplicateToolCalls).toBe(1);
  });

  it('does NOT flag pre-compaction duplicates', () => {
    const t = new CompactionTracker();
    t.recordToolCall('search', '{"pattern":"foo"}');
    t.recordToolCall('search', '{"pattern":"foo"}'); // same call before any compaction
    expect(t.getStats().duplicateToolCalls).toBe(0);
  });

  it('estimateLossFactor counts re-reads + dup tools', () => {
    const t = new CompactionTracker();
    t.recordCompaction({
      ts: Date.now(),
      regionMsgCount: 5,
      regionTokensEst: 10000,
      summaryInputTokens: 10000,
      summaryOutputTokens: 500,
      tailMsgCount: 4,
      preTokens: 15000,
      postTokens: 5000,
      outcome: 'summary',
    });
    t.recordFileRead('/src/a.ts');
    t.recordFileRead('/src/a.ts');
    t.recordFileRead('/src/b.ts');
    t.recordToolCall('glob', '{"pattern":"*.ts"}');
    t.recordToolCall('glob', '{"pattern":"*.ts"}');
    // 1 re-read (a.ts) + 1 dup tool (glob) = 2 * 0.25 = 0.5
    expect(t.estimateLossFactor()).toBeCloseTo(0.5, 5);
  });

  it('reset clears per-session counters but preserves events and filesRead (E5)', () => {
    const t = new CompactionTracker();
    t.recordTurn();
    t.recordFileRead('/src/foo.ts');
    t.recordCompaction({
      ts: Date.now(),
      regionMsgCount: 5,
      regionTokensEst: 10000,
      summaryInputTokens: 10000,
      summaryOutputTokens: 500,
      tailMsgCount: 4,
      preTokens: 15000,
      postTokens: 5000,
      outcome: 'summary',
    });
    t.reset();
    const stats = t.getStats();
    // Per-session counters are reset
    expect(stats.totalTurns).toBe(0);
    expect(stats.reReadCount).toBe(0);
    // E5: events and filesRead persist across sessions for compaction tuning
    expect(stats.events.length).toBe(1);
    expect(stats.filesReadPreCompact.size).toBe(1);
  });

  it('serializeState and deserializeState round-trip (E5)', () => {
    const t = new CompactionTracker();
    t.recordFileRead('/src/a.ts');
    t.recordFileRead('/src/b.ts');
    t.recordCompaction({
      ts: 12345,
      regionMsgCount: 5,
      regionTokensEst: 10000,
      summaryInputTokens: 10000,
      summaryOutputTokens: 500,
      tailMsgCount: 4,
      preTokens: 15000,
      postTokens: 5000,
      outcome: 'summary',
    });

    const json = t.serializeState();

    // Create a fresh tracker and restore
    const t2 = new CompactionTracker();
    t2.deserializeState(json);
    const stats = t2.getStats();
    expect(stats.events.length).toBe(1);
    expect(stats.events[0].ts).toBe(12345);
    expect(stats.filesReadPreCompact.size).toBe(2);
    expect(stats.filesReadPreCompact.has('/src/a.ts')).toBe(true);
    expect(stats.filesReadPreCompact.has('/src/b.ts')).toBe(true);
  });

  it('deserializeState handles corrupt JSON gracefully (E5)', () => {
    const t = new CompactionTracker();
    t.deserializeState('not valid json {{{');
    // Should not throw, should leave tracker in default state
    expect(t.getStats().events.length).toBe(0);
  });
});

// ── formatCompactionReport ──

describe('formatCompactionReport', () => {
  it('produces markdown', () => {
    const t = new CompactionTracker();
    t.recordCompaction({
      ts: Date.now(),
      regionMsgCount: 10,
      regionTokensEst: 50000,
      summaryInputTokens: 50000,
      summaryOutputTokens: 3000,
      tailMsgCount: 4,
      preTokens: 60000,
      postTokens: 10000,
      outcome: 'summary',
    });
    const report = formatCompactionReport(t.getStats());
    expect(report).toContain('压缩成本分析报告');
    expect(report).toContain('压缩次数');
    expect(report).toContain('summary');
  });
});
